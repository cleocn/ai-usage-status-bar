// ai-usage-statusbar/extension.js
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTH_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_SCOPE = "user:profile user:inference user:sessions:claude_code user:file_upload";
const ANTHROPIC_API_VERSION = "2023-06-01";
const CLAUDE_SECRET_KEY = "claude.tokens";
const CLAUDE_AUTH_STATE_KEY = "claude.authState";
const CLAUDE_LAST_RATE_LIMIT_KEY = "claude.lastRateLimitResult";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const CLAUDE_OAUTH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const CLAUDE_MAX_COOLDOWN_MS = 30 * 60 * 1000;
const CLAUDE_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const CODEX_DIR = path.join(os.homedir(), ".codex");
const CODEX_AUTH_PATH = path.join(CODEX_DIR, "auth.json");
const CURSOR_DB_PATH = path.join(
  os.homedir(),
  os.platform() === "win32"
    ? "AppData/Roaming/Cursor/User/globalStorage/state.vscdb"
    : os.platform() === "linux"
    ? ".config/Cursor/User/globalStorage/state.vscdb"
    : "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
);

let statusBarItem;
let chatgptStatusBarItem;
let cursorStatusBarItem;
let claudeStatusBarItem;
let refreshTimer;
let chatgptLastUpdatedAt;
let extensionContext;
let lastClaudeRateLimitResult = null;
let lastClaudeOauth429At = 0;
let lastClaudeOauth429RetryAfterMs = 5 * 60 * 1000;
let lastClaudeOauthSuccessAt = 0;
const CURSOR_ICON_FALLBACK = "◈";
const CLAUDE_ICON_FALLBACK = "◆";

function getCursorPrefix() {
  // NOTE:
  // Custom contributed icons are not reliably rendered inside StatusBarItem.text
  // across VS Code versions/themes. Keep a stable visible unicode fallback.
  return CURSOR_ICON_FALLBACK;
}

function getClaudePrefix() {
  return CLAUDE_ICON_FALLBACK;
}

function getConfig() {
  return vscode.workspace.getConfiguration('aiUsage');
}

function isClaudeExperimentalEnabled() {
  return getConfig().get('experimental.enableClaudeUsage', false);
}

function isClaudeProviderAvailable() {
  // Single switch for Claude experimental feature.
  return isClaudeExperimentalEnabled();
}

function shouldUseClaudeDesktopTokenCache() {
  return isClaudeExperimentalEnabled();
}

function getClaudeUnavailableHint() {
  return "Claude usage 实验功能已关闭。请在设置中开启 aiUsage.experimental.enableClaudeUsage。";
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function applyProviderVisibility() {
  const cfg = getConfig();
  cfg.get('providers.copilot', true) ? statusBarItem.show() : statusBarItem.hide();
  cfg.get('providers.chatgpt', true) ? chatgptStatusBarItem.show() : chatgptStatusBarItem.hide();
  cfg.get('providers.cursor', true) ? cursorStatusBarItem.show() : cursorStatusBarItem.hide();
  isClaudeProviderAvailable() ? claudeStatusBarItem.show() : claudeStatusBarItem.hide();
}

async function activate(context) {
  extensionContext = context;
  // Create status bar item (left side, low priority so it doesn't crowd)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBarItem.command = "copilotUsage.refresh";
  statusBarItem.tooltip = "GitHub Copilot 用量 · 点击刷新";
  context.subscriptions.push(statusBarItem);

  // ChatGPT/Codex status bar item (slightly lower priority, appears to the right)
  chatgptStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    49
  );
  chatgptStatusBarItem.command = "aiUsage.openChatGPTUsage";
  context.subscriptions.push(chatgptStatusBarItem);

  // Cursor status bar item
  cursorStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    48
  );
  cursorStatusBarItem.command = "aiUsage.refreshCursor";
  context.subscriptions.push(cursorStatusBarItem);

  // Claude status bar item
  claudeStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    47
  );
  claudeStatusBarItem.command = "aiUsage.refreshClaude";
  context.subscriptions.push(claudeStatusBarItem);

  // Apply initial visibility from settings
  applyProviderVisibility();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotUsage.refresh", () => {
      fetchAndRender(true);
    }),
    vscode.commands.registerCommand("copilotUsage.signIn", () => {
      fetchAndRender(true);
    }),
    vscode.commands.registerCommand("aiUsage.openChatGPTUsage", () => {
      vscode.env.openExternal(vscode.Uri.parse("https://chatgpt.com/codex/settings/usage"));
    }),
    vscode.commands.registerCommand("aiUsage.refreshCursor", () => {
      fetchAndRenderCursor();
    }),
    vscode.commands.registerCommand("aiUsage.openClaudeUsage", () => {
      if (!isClaudeProviderAvailable()) {
        vscode.window.showInformationMessage(getClaudeUnavailableHint());
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse("https://claude.ai/settings/usage"));
    }),
    vscode.commands.registerCommand("aiUsage.refreshClaude", () => {
      if (!isClaudeProviderAvailable()) {
        vscode.window.showInformationMessage(getClaudeUnavailableHint());
        return;
      }
      fetchAndRenderClaude();
    }),
    vscode.commands.registerCommand("aiUsage.authenticateClaude", () => {
      if (!isClaudeProviderAvailable()) {
        vscode.window.showInformationMessage(getClaudeUnavailableHint());
        return;
      }
      startClaudeOAuth();
    }),
    vscode.commands.registerCommand("aiUsage.signOutClaude", () => {
      if (!isClaudeProviderAvailable()) {
        vscode.window.showInformationMessage(getClaudeUnavailableHint());
        return;
      }
      signOutClaude();
    })
  );

  // Initial fetch
  await fetchAndRender(false);
  renderChatGPT();
  fetchAndRenderCursor();
  fetchAndRenderClaude();

  // Periodic refresh
  refreshTimer = setInterval(() => {
    fetchAndRender(false);
    renderChatGPT();
    fetchAndRenderCursor();
    fetchAndRenderClaude();
  }, REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aiUsage')) {
        applyProviderVisibility();
        fetchAndRender(false);
        renderChatGPT();
        fetchAndRenderCursor();
        fetchAndRenderClaude();
      }
    })
  );
}

async function getGitHubSession(interactive) {
  try {
    const session = await vscode.authentication.getSession(
      "github",
      ["read:user"],
      { createIfNone: interactive, silent: !interactive }
    );
    return session ?? null;
  } catch {
    return null;
  }
}

async function fetchCopilotUsage(token) {
  const res = await fetch(COPILOT_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "vscode-copilot-usage-statusbar/1.0",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmtResetDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

async function fetchAndRender(interactive) {
  statusBarItem.text = "$(sync~spin) Copilot";
  statusBarItem.backgroundColor = undefined;

  const session = await getGitHubSession(interactive);
  const token = session?.accessToken ?? null;
  const accountLabel = session?.account?.label ?? null;
  if (!token) {
    statusBarItem.text = "$(github) Copilot: 未登录";
    statusBarItem.tooltip =
      "点击登录 GitHub 以显示 Copilot 用量\n(运行命令: Copilot Usage: Sign in to GitHub)";
    statusBarItem.command = "copilotUsage.signIn";
    return;
  }

  try {
    const data = await fetchCopilotUsage(token);
    renderUsage(data, accountLabel);
    statusBarItem.command = "copilotUsage.refresh";
  } catch (e) {
    statusBarItem.text = "$(warning) Copilot: 获取失败";
    statusBarItem.tooltip = `错误: ${e.message}\n点击重试`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    statusBarItem.command = "copilotUsage.refresh";
  }
}

function renderUsage(data, accountLabel) {
  const verbose = getConfig().get('style', 'minimal') === 'verbose';
  const plan = data.copilot_plan ?? "unknown";
  const resetDate = fmtResetDate(data.quota_reset_date);
  const resetDaysLabel = formatRemainingDaysLabel(new Date(data.quota_reset_date).getTime());
  const resetDaysPrefix = resetDaysLabel ? `${resetDaysLabel} ` : "";
  const snap = data.quota_snapshots?.premium_interactions;

  if (!snap) {
    const planLabel =
      plan === "individual_pro" || plan === "individual" ? "Pro"
      : plan === "business" ? "Biz"
      : plan === "enterprise" ? "Ent"
      : plan;
    statusBarItem.text = verbose ? `$(github) ${resetDaysPrefix}Copilot ${planLabel}` : `$(github) ${resetDaysPrefix}${planLabel}`;
    statusBarItem.tooltip = [
      `GitHub Copilot ${planLabel}`,
      accountLabel ? `账号: ${accountLabel}` : "",
      `不限高级请求`,
      "",
      `点击刷新`,
    ].filter(Boolean).join("\n");
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const { entitlement, percent_remaining, unlimited, overage_count } = snap;
  if (unlimited) {
    statusBarItem.text = verbose ? `$(github) ${resetDaysPrefix}Copilot ∞` : `$(github) ${resetDaysPrefix}∞`;
    statusBarItem.tooltip = [
      `GitHub Copilot`,
      accountLabel ? `账号: ${accountLabel}` : "",
      `高级请求: 无上限`,
      "",
      `点击刷新`,
    ].filter(Boolean).join("\n");
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const used = Math.round(entitlement * (1 - percent_remaining / 100));
  const remaining = entitlement - used;
  const pct = Math.round(percent_remaining);
  const overageStr = overage_count > 0 ? `+${overage_count}` : "0";

  let bgColor = undefined;
  if (pct <= 10) {
    bgColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (pct <= 25) {
    bgColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  statusBarItem.text = verbose
    ? `$(github) ${resetDaysPrefix}Copilot ${remaining}/${entitlement} ${pct}%`
    : `$(github) ${resetDaysPrefix}${remaining}/${entitlement} ${pct}%`;
  statusBarItem.tooltip = [
    `GitHub Copilot 高级请求`,
    accountLabel ? `账号: ${accountLabel}` : "",
    `已用: ${used} / ${entitlement}`,
    `剩余: ${remaining} (${pct}%)`,
    overage_count > 0 ? `On-Demand(超额): ${overageStr}` : "",
    resetDate ? `重置日期: ${resetDate}` : "",
    ``,
    `点击刷新`,
  ].filter(Boolean).join("\n");
  statusBarItem.backgroundColor = bgColor;
}

// ---------- ChatGPT / Codex ----------

function readCodexAuth() {
  try {
    if (!fs.existsSync(CODEX_AUTH_PATH)) return null;
    const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    // pad base64url
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function readCodexRateLimits() {
  try {
    const logsDbPath = getLatestCodexLogsDbPath();
    if (!logsDbPath) return null;
    // Query most recent log entry that contains codex rate limit headers
    const { execSync } = require("child_process");
    const sql = "SELECT feedback_log_body FROM logs WHERE feedback_log_body LIKE '%x-codex-primary-used-percent%' ORDER BY ts DESC LIMIT 1;";
    const result = execSync(
      `sqlite3 "${logsDbPath}" "${sql.replace(/"/g, '\\"')}"`,
      { encoding: "utf8", timeout: 4000 }
    ).trim();
    if (!result) return null;

    // Extract individual header values via regex (the JSON may be truncated in the log)
    const extract = (key) => {
      const m = result.match(new RegExp(`"${key}":\\s*"([^"]*)"`));
      return m ? m[1] : null;
    };
    return {
      planType:           extract("x-codex-plan-type"),
      primaryUsedPct:     extract("x-codex-primary-used-percent"),
      secondaryUsedPct:   extract("x-codex-secondary-used-percent"),
      primaryWindowMin:   extract("x-codex-primary-window-minutes"),
      secondaryWindowMin: extract("x-codex-secondary-window-minutes"),
      primaryResetAt:     extract("x-codex-primary-reset-at"),
      secondaryResetAt:   extract("x-codex-secondary-reset-at"),
      creditsBalance:     extract("x-codex-credits-balance"),
      creditsHasCredits:  extract("x-codex-credits-has-credits"),
      creditsUnlimited:   extract("x-codex-credits-unlimited"),
    };
  } catch {
    return null;
  }
}

function getLatestCodexLogsDbPath() {
  try {
    if (!fs.existsSync(CODEX_DIR)) return null;
    const candidates = fs.readdirSync(CODEX_DIR)
      .filter((name) => /^logs_\d+\.sqlite$/.test(name))
      .map((name) => {
        const fullPath = path.join(CODEX_DIR, name);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          return null;
        }
        const match = name.match(/^logs_(\d+)\.sqlite$/);
        return {
          fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          index: match ? parseInt(match[1], 10) : -1,
        };
      })
      .filter(Boolean)
      .filter((entry) => entry.size > 0)
      .sort((a, b) => {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return b.index - a.index;
      });
    return candidates[0]?.fullPath ?? null;
  } catch {
    return null;
  }
}

function parseBoolLike(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
}

function formatOnDemandBalance(value) {
  if (typeof value !== "string") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function formatRemainingWindowLabel(resetAtSec, unit) {
  const ts = parseInt(resetAtSec, 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const remainingMs = Math.max(0, ts * 1000 - Date.now());
  if (unit === "hours") {
    if (remainingMs < 60 * 60 * 1000) {
      const m = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
      return `${m}m`;
    }
    const h = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
    return `${h}h`;
  }
  if (unit === "days") {
    if (remainingMs < 24 * 60 * 60 * 1000) {
      const h = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
      return `${h}h`;
    }
    const d = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
    return `${d}d`;
  }
  return null;
}

function formatRemainingDaysLabel(targetMs) {
  if (!Number.isFinite(targetMs) || targetMs <= 0) return null;
  const remainingMs = Math.max(0, targetMs - Date.now());
  if (remainingMs < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
    return `${hours}h`;
  }
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return `${days}d`;
}

function formatLastUpdatedLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function getNextResetFromStartOfMonth(startOfMonth) {
  if (!startOfMonth) return null;
  const start = new Date(startOfMonth);
  if (Number.isNaN(start.getTime())) return null;
  const next = new Date(start);
  next.setMonth(next.getMonth() + 1);
  return next;
}

function renderChatGPT() {
  chatgptLastUpdatedAt = new Date();
  const lastUpdatedLabel = formatLastUpdatedLabel(chatgptLastUpdatedAt);
  const auth = readCodexAuth();
  if (!auth || !auth.tokens) {
    chatgptStatusBarItem.text = "$(openai) ChatGPT: 未安装";
    chatgptStatusBarItem.tooltip = [
      "未找到 ~/.codex/auth.json",
      "请先登录 Codex 插件",
      lastUpdatedLabel ? `上次更新: ${lastUpdatedLabel}` : "",
    ].filter(Boolean).join("\n");
    return;
  }

  // Get plan from access_token
  const accessPayload = decodeJwtPayload(auth.tokens.access_token ?? "");
  const openaiAuth = accessPayload?.["https://api.openai.com/auth"] ?? {};
  const plan = openaiAuth.chatgpt_plan_type ?? "unknown";

  // Get subscription until from id_token (more fields there)
  const idPayload = decodeJwtPayload(auth.tokens.id_token ?? "");
  const idAuth = idPayload?.["https://api.openai.com/auth"] ?? {};
  const activeUntil = idAuth.chatgpt_subscription_active_until ?? null;
  const accountLabel = pickFirstNonEmpty(
    idAuth.email,
    openaiAuth.email,
    idPayload?.email,
    accessPayload?.email,
    idAuth.preferred_username,
    openaiAuth.preferred_username,
    idPayload?.preferred_username,
    accessPayload?.preferred_username,
    idAuth.name,
    openaiAuth.name,
    idPayload?.name,
    accessPayload?.name,
    idAuth.sub,
    openaiAuth.sub
  );

  const planLabel =
    plan === "plus" ? "Plus" :
    plan === "pro" ? "Pro" :
    plan === "free" ? "Free" :
    plan.charAt(0).toUpperCase() + plan.slice(1);

  let renewalStr = "";
  let renewalFull = "";
  if (activeUntil) {
    const d = new Date(activeUntil);
    renewalStr = " · 续" + d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    renewalFull = "订阅到期: " + d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  }

  const verbose = getConfig().get('style', 'minimal') === 'verbose';
  const renewalDaysLabel = formatRemainingDaysLabel(new Date(activeUntil).getTime());
  const renewalDaysPrefix = renewalDaysLabel ? `${renewalDaysLabel} ` : "";

  // Try to read rate limit data from Codex logs SQLite
  const rl = readCodexRateLimits();
  const hasCompleteUsage = rl && rl.primaryUsedPct !== null && rl.secondaryUsedPct !== null;
  let usageStr = "";
  let usageTooltip = "";
  if (hasCompleteUsage) {
    const primUsed = parseInt(rl.primaryUsedPct, 10);
    const secUsed  = parseInt(rl.secondaryUsedPct, 10);
    const primRem  = 100 - primUsed;
    const secRem   = 100 - secUsed;
    const primWinFallback = rl.primaryWindowMin ? `${Math.round(parseInt(rl.primaryWindowMin, 10) / 60)}h` : "5h";
    const secWinFallback  = rl.secondaryWindowMin ? `${Math.round(parseInt(rl.secondaryWindowMin, 10) / (60 * 24))}d` : "7d";
    const primWin = formatRemainingWindowLabel(rl.primaryResetAt, "hours") ?? primWinFallback;
    const secWin  = formatRemainingWindowLabel(rl.secondaryResetAt, "days") ?? secWinFallback;

    let resetStr = "";
    if (rl.secondaryResetAt) {
      const resetDate = new Date(parseInt(rl.secondaryResetAt, 10) * 1000);
      resetStr = resetDate.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    }
    const hasCredits = parseBoolLike(rl.creditsHasCredits);
    const unlimitedCredits = parseBoolLike(rl.creditsUnlimited);
    const onDemandStr = unlimitedCredits === true
      ? "∞"
      : hasCredits === false
      ? "0"
      : formatOnDemandBalance(rl.creditsBalance);
    // Show both windows in status bar text using remaining time labels.
    usageStr = `${primWin} ${primRem}% ${secWin} ${secRem}%`;
    if (Math.min(primRem, secRem) <= 20 || hasCredits === false) {
      chatgptStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      chatgptStatusBarItem.backgroundColor = undefined;
    }

    usageTooltip = [
      `ChatGPT/Codex 用量 (${planLabel})`,
      accountLabel ? `账号: ${accountLabel}` : "",
      lastUpdatedLabel ? `上次更新: ${lastUpdatedLabel}` : "",
      `${primWin} 窗口: 已用 ${primUsed}% / 剩余 ${primRem}%`,
      `${secWin} 窗口: 已用 ${secUsed}% / 剩余 ${secRem}%`,
      onDemandStr ? `On-Demand: ${onDemandStr}${unlimitedCredits === true ? " (不限额)" : ""}` : "",
      resetStr ? `7d 窗口重置: ${resetStr}` : "",
      renewalFull,
      "",
      "数据来自 Codex 最近一次 API 调用的响应头",
      "点击打开 chatgpt.com/codex/settings/usage",
    ].filter(Boolean).join("\n");
  } else {
    chatgptStatusBarItem.backgroundColor = undefined;
    usageTooltip = [
      `ChatGPT ${planLabel} 订阅`,
      accountLabel ? `账号: ${accountLabel}` : "",
      lastUpdatedLabel ? `上次更新: ${lastUpdatedLabel}` : "",
      renewalFull,
      "",
      "暂无 Codex 用量数据（需先使用 Codex 插件发起请求）",
      "点击打开 chatgpt.com/codex/settings/usage",
    ].filter(Boolean).join("\n");
  }

  const displayLabel = hasCompleteUsage
    ? (verbose ? `$(openai) ${renewalDaysPrefix}Codex ${usageStr}` : `$(openai) ${renewalDaysPrefix}${usageStr}`)
    : (verbose ? `$(openai) ${renewalDaysPrefix}ChatGPT ${planLabel}` : `$(openai) ${renewalDaysPrefix}${planLabel}`);

  chatgptStatusBarItem.text = displayLabel;
  chatgptStatusBarItem.tooltip = usageTooltip;
}

function deactivate() {
  clearInterval(refreshTimer);
}

// ---------- Claude ----------

function base64urlEncode(buf) {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePKCE() {
  const codeVerifier = base64urlEncode(crypto.randomBytes(32));
  const codeChallenge = base64urlEncode(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

async function startClaudeOAuth() {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = base64urlEncode(crypto.randomBytes(32));

  // Find a free local port for the OAuth callback (RFC 8252 loopback redirect)
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const srv = require("net").createServer();
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
      srv.on("error", reject);
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Claude 授权失败：无法绑定本地端口 (${e.message})`);
    return;
  }

  const redirectUri = `http://localhost:${port}/callback`;
  const authParams = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CLAUDE_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  const authQuery = authParams.toString();

  let serverResolve, serverReject;
  const callbackPromise = new Promise((res, rej) => { serverResolve = res; serverReject = rej; });

  const server = require("http").createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    if (reqUrl.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">` +
      `<h2>Claude 授权成功</h2><p>请关闭此标签页并返回 VS Code。</p>` +
      `<script>window.close();</script></body></html>`
    );
    server.close();
    const code = reqUrl.searchParams.get("code");
    const returnedState = reqUrl.searchParams.get("state");
    if (returnedState !== state) { serverReject(new Error("state 不匹配，验证失败")); return; }
    serverResolve({ code, redirectUri });
  });
  server.listen(port, "127.0.0.1");

  const timer = setTimeout(() => {
    server.close();
    serverReject(new Error("授权超时（5 分钟），请重试"));
  }, 5 * 60 * 1000);

  await vscode.env.openExternal(vscode.Uri.parse(`${CLAUDE_AUTH_URL}?${authQuery}`));

  try {
    const { code, redirectUri: usedRedirectUri } = await callbackPromise;
    clearTimeout(timer);
    const tokenRes = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLAUDE_CLIENT_ID,
        code,
        redirect_uri: usedRedirectUri,
        code_verifier: codeVerifier,
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      if (tokenRes.status === 403 && /Request not allowed/i.test(text)) {
        await extensionContext.globalState.update(CLAUDE_AUTH_STATE_KEY, {
          kind: "oauth_forbidden",
          message: "Anthropic rejected the code exchange with 403 Request not allowed.",
        });
      }
      throw new Error(`token 交换失败: ${tokenRes.status} ${text.substring(0, 200)}`);
    }
    const tokens = await tokenRes.json();
    const tokenData = {
      accessToken: tokens.access_token ?? tokens.token ?? null,
      refreshToken: tokens.refresh_token ?? tokens.refreshToken ?? null,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : (tokens.expiresAt ?? null),
    };
    if (!tokenData.accessToken) {
      throw new Error("token 响应缺少 access_token");
    }
    await extensionContext.secrets.store(CLAUDE_SECRET_KEY, JSON.stringify(tokenData));
    await extensionContext.globalState.update(CLAUDE_AUTH_STATE_KEY, undefined);
    vscode.window.showInformationMessage("Claude 授权成功！");
    await fetchAndRenderClaude();
  } catch (e) {
    clearTimeout(timer);
    server.close();
    vscode.window.showErrorMessage(`Claude 授权失败: ${e.message}`);
  }
}

async function refreshClaudeToken(tokenData) {
  try {
    const tokenRes = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLAUDE_CLIENT_ID,
        refresh_token: tokenData.refreshToken,
      }),
    });
    if (!tokenRes.ok) return null;
    const tokens = await tokenRes.json();
    const newData = {
      accessToken: tokens.access_token ?? tokens.token ?? null,
      refreshToken: tokens.refresh_token ?? tokens.refreshToken ?? tokenData.refreshToken,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : (tokens.expiresAt ?? tokenData.expiresAt ?? null),
    };
    if (!newData.accessToken) return null;
    await extensionContext.secrets.store(CLAUDE_SECRET_KEY, JSON.stringify(newData));
    return newData;
  } catch {
    return null;
  }
}

async function signOutClaude() {
  await extensionContext.secrets.delete(CLAUDE_SECRET_KEY).catch(() => {});
  await extensionContext.globalState.update(CLAUDE_AUTH_STATE_KEY, undefined);
  claudeStatusBarItem.text = `${getClaudePrefix()} Claude: 未授权`;
  claudeStatusBarItem.tooltip = "已退出 Claude，点击重新授权";
  claudeStatusBarItem.command = "aiUsage.authenticateClaude";
  claudeStatusBarItem.backgroundColor = undefined;
  vscode.window.showInformationMessage("已退出 Claude");
}

async function resolveClaudeToken() {
  // 1. SecretStorage (from OAuth flow) - PREFERRED for reliability
  try {
    const raw = await extensionContext.secrets.get(CLAUDE_SECRET_KEY);
    if (raw) {
      const tokenData = JSON.parse(raw);
      if (tokenData.expiresAt && Date.now() > tokenData.expiresAt - 5 * 60 * 1000) {
        if (tokenData.refreshToken) {
          const refreshed = await refreshClaudeToken(tokenData);
          if (refreshed) return refreshed.accessToken;
        }
      }
      if (tokenData.accessToken) return tokenData.accessToken;
    }
  } catch {}

  // 2. Claude Code/Desktop local token cache (macOS only) - FALLBACK
  if (shouldUseClaudeDesktopTokenCache() && os.platform() === "darwin") {
    try {
      const desktopToken = await readClaudeDesktopToken();
      if (desktopToken) return desktopToken;
    } catch {}
  }

  // 3. Legacy fallback: settings or environment variable
  const cfgToken = getConfig().get('claude.oauthToken', '');
  return pickFirstNonEmpty(
    cfgToken,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.ANTHROPIC_OAUTH_TOKEN,
    process.env.CLAUDE_OAUTH_TOKEN
  ) ?? null;
}

async function readClaudeDesktopToken() {
  const configPath = path.join(os.homedir(), "Library", "Application Support", "Claude", "config.json");
  if (!fs.existsSync(configPath)) return null;

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  const encryptedB64 = parsed["oauth:tokenCache"];
  if (typeof encryptedB64 !== "string") return null;

  const encryptedBuf = Buffer.from(encryptedB64, "base64");
  if (encryptedBuf.slice(0, 3).toString() !== "v10") return null;
  const ciphertext = encryptedBuf.slice(3);

  const { execSync } = require("child_process");
  let password;
  try {
    password = execSync('security find-generic-password -s "Claude Safe Storage" -a "Claude Key" -w', {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
  if (!password) return null;

  const key = await new Promise((resolve, reject) => {
    crypto.pbkdf2(password, "saltysalt", 1003, 16, "sha1", (err, derivedKey) => {
      if (err) reject(err); else resolve(derivedKey);
    });
  });

  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

  const tokenCache = JSON.parse(decrypted);
  const candidates = Object.entries(tokenCache)
    .map(([cacheKey, value]) => {
      const token = value?.token ?? value?.access_token ?? value?.accessToken ?? null;
      const expiresAt = Number(value?.expiresAt ?? 0) || 0;
      const hasClaudeCodeScope = typeof cacheKey === "string" && cacheKey.includes("user:sessions:claude_code");
      return { token, expiresAt, hasClaudeCodeScope };
    })
    .filter((item) => typeof item.token === "string" && item.token.length > 0)
    .sort((a, b) => {
      if (a.hasClaudeCodeScope !== b.hasClaudeCodeScope) {
        return a.hasClaudeCodeScope ? -1 : 1;
      }
      return b.expiresAt - a.expiresAt;
    });

  return candidates[0]?.token ?? null;
}

async function fetchClaudeUsage(token) {
  const res = await fetch(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "vscode-ai-usage-statusbar/1.0",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function normalizeEpochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value / 1000);
    if (value > 1e9) return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) {
      if (asNum > 1e12) return Math.floor(asNum / 1000);
      if (asNum > 1e9) return Math.floor(asNum);
    }
    const ts = new Date(value).getTime();
    if (Number.isFinite(ts)) return Math.floor(ts / 1000);
  }
  return null;
}

function normalizeUtilizationToUsedPercent(utilization) {
  if (typeof utilization !== "number" || Number.isNaN(utilization)) return null;
  if (utilization > 1) return Math.max(0, Math.min(100, Math.round(utilization)));
  return Math.max(0, Math.min(100, Math.round(utilization * 100)));
}

function shouldAssumeClaudeFullFromNoData(oauthError, projectsRoot) {
  const msg = String(oauthError || "").toLowerCase();
  if (msg.includes("no utilization data")) return true;
  if (projectsRoot && fs.existsSync(projectsRoot)) return true;
  return false;
}

function isClaudeRateLimitError(err) {
  const msg = String(err || "").toLowerCase();
  return msg.includes("http 429") || msg.includes("rate_limit_error") || msg.includes("rate limit cooldown");
}

function isClaudeTransientError(err) {
  const msg = String(err || "").toLowerCase();
  return (
    msg.includes("request timed out") ||
    msg.includes("http 500") ||
    msg.includes("internal server error") ||
    msg.includes("econnreset") ||
    msg.includes("network")
  );
}

function buildClaudeAssumedFullResult(reason) {
  const rateLimits = {
    primary: { used_percent: 0, resets_at: null },
    secondary: { used_percent: 0, resets_at: null },
  };
  return {
    ok: true,
    sourceLabel: `${reason} (assumed full)`,
    rateLimits,
  };
}

function parseClaudeApiRateLimits(data) {
  const primary = {
    used_percent: normalizeUtilizationToUsedPercent(data?.five_hour?.utilization),
    resets_at: normalizeEpochSeconds(data?.five_hour?.resets_at),
  };
  const secondary = {
    used_percent: normalizeUtilizationToUsedPercent(data?.seven_day?.utilization),
    resets_at: normalizeEpochSeconds(data?.seven_day?.resets_at),
  };
  if (primary.used_percent === null && secondary.used_percent === null) {
    return buildClaudeAssumedFullResult("Claude OAuth API");
  }
  return {
    ok: true,
    sourceLabel: "Claude OAuth API",
    rateLimits: { primary, secondary },
  };
}

function formatClaudeUsageCompact(rateLimits) {
  const primaryUsed = rateLimits?.primary?.used_percent;
  const secondaryUsed = rateLimits?.secondary?.used_percent;
  const primaryRem = typeof primaryUsed === "number" ? Math.max(0, 100 - primaryUsed) : null;
  const secondaryRem = typeof secondaryUsed === "number" ? Math.max(0, 100 - secondaryUsed) : null;
  const primaryWindow = rateLimits?.primary?.resets_at
    ? formatRemainingDaysLabel(rateLimits.primary.resets_at * 1000)
    : "5h";
  const secondaryWindow = rateLimits?.secondary?.resets_at
    ? formatRemainingDaysLabel(rateLimits.secondary.resets_at * 1000)
    : "7d";
  const usageParts = [];
  if (primaryRem !== null) usageParts.push(`${primaryWindow} ${primaryRem}%`);
  if (secondaryRem !== null) usageParts.push(`${secondaryWindow} ${secondaryRem}%`);
  return usageParts.length > 0 ? usageParts.join(" ") : "- -";
}

function renderClaudeRateLimits(rateLimitResult) {
  const claudePrefix = getClaudePrefix();
  const verbose = getConfig().get('style', 'minimal') === 'verbose';
  const rateLimits = rateLimitResult?.rateLimits ?? {};
  const usageCompact = formatClaudeUsageCompact(rateLimits);
  const primaryUsed = rateLimits?.primary?.used_percent;
  const secondaryUsed = rateLimits?.secondary?.used_percent;
  const primaryRem = typeof primaryUsed === "number" ? Math.max(0, 100 - primaryUsed) : null;
  const secondaryRem = typeof secondaryUsed === "number" ? Math.max(0, 100 - secondaryUsed) : null;

  claudeStatusBarItem.text = verbose
    ? `${claudePrefix} Claude ${usageCompact}`
    : `${claudePrefix} ${usageCompact}`;

  claudeStatusBarItem.tooltip = [
    "Claude 用量",
    primaryUsed !== null && primaryUsed !== undefined
      ? `5h 窗口: 已用 ${primaryUsed}% / 剩余 ${primaryRem}%`
      : "5h 窗口: 暂无数据",
    secondaryUsed !== null && secondaryUsed !== undefined
      ? `7d 窗口: 已用 ${secondaryUsed}% / 剩余 ${secondaryRem}%`
      : "7d 窗口: 暂无数据",
    rateLimits?.primary?.resets_at
      ? `5h 重置时间: ${new Date(rateLimits.primary.resets_at * 1000).toLocaleString("zh-CN")}`
      : "",
    rateLimits?.secondary?.resets_at
      ? `7d 重置时间: ${new Date(rateLimits.secondary.resets_at * 1000).toLocaleString("zh-CN")}`
      : "",
    "",
    `数据来源: ${rateLimitResult?.sourceLabel || "未知"}`,
    "点击打开 claude.ai 用量页面",
  ].filter(Boolean).join("\n");

  const lowestRemaining = [primaryRem, secondaryRem]
    .filter((v) => typeof v === "number")
    .reduce((min, v) => Math.min(min, v), 100);
  claudeStatusBarItem.backgroundColor = lowestRemaining <= 20
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  claudeStatusBarItem.command = "aiUsage.refreshClaude";
}

function readLatestClaudeRateLimitsFromSession(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const candidates = [
        obj?.rate_limits,
        obj?.message?.rate_limits,
        obj?.data?.rate_limits,
        obj?.data?.message?.rate_limits,
        obj?.payload?.rate_limits,
      ];
      for (const rl of candidates) {
        if (rl && (rl.five_hour || rl.seven_day)) {
          return {
            primary: {
              used_percent: normalizeUtilizationToUsedPercent(rl.five_hour?.utilization),
              resets_at: normalizeEpochSeconds(rl.five_hour?.resets_at),
            },
            secondary: {
              used_percent: normalizeUtilizationToUsedPercent(rl.seven_day?.utilization),
              resets_at: normalizeEpochSeconds(rl.seven_day?.resets_at),
            },
          };
        }
      }
    } catch {
      // ignore malformed lines
    }
  }
  return null;
}

function findNewestClaudeSessionWithRateLimits(rootDir, maxCandidates = 20) {
  if (!fs.existsSync(rootDir)) return null;

  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !full.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(full);
        files.push({ filePath: full, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (let i = 0; i < Math.min(files.length, Math.max(1, maxCandidates)); i += 1) {
    const item = files[i];
    try {
      const rateLimits = readLatestClaudeRateLimitsFromSession(item.filePath);
      if (rateLimits) return { filePath: item.filePath, rateLimits };
    } catch {
      // continue
    }
  }
  return null;
}

function buildClaudeRateLimitsFromLocalTokenCount(projectsRoot, credPath) {
  try {
    let planLimit = 44000;
    try {
      if (fs.existsSync(credPath)) {
        const cred = JSON.parse(fs.readFileSync(credPath, "utf8"));
        const subType = String(cred?.claudeAiOauth?.subscriptionType || "").toLowerCase();
        if (subType.includes("max_20") || subType.includes("max20")) planLimit = 220000;
        else if (subType.includes("max_5") || subType.includes("max5")) planLimit = 88000;
      }
    } catch {
      // ignore
    }

    if (!fs.existsSync(projectsRoot)) return null;

    const files = [];
    const stack = [projectsRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile() && full.endsWith(".jsonl")) files.push(full);
      }
    }

    const now = Date.now();
    const windowStart = now - CLAUDE_SESSION_WINDOW_MS;
    const seenIds = new Set();
    const messages = [];

    for (const filePath of files) {
      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type !== "assistant") continue;
          const msgId = obj?.uuid || obj?.message?.id || null;
          if (msgId && seenIds.has(msgId)) continue;
          if (msgId) seenIds.add(msgId);
          const ts = obj?.timestamp ? new Date(obj.timestamp).getTime() : 0;
          if (!ts || ts < windowStart) continue;
          const usage = obj?.message?.usage;
          if (!usage) continue;
          const tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
          if (tokens > 0) messages.push({ ts, tokens });
        } catch {
          // ignore
        }
      }
    }

    if (messages.length === 0) return null;

    messages.sort((a, b) => a.ts - b.ts);
    const sessionStart = messages[0].ts;
    const sessionEnd = sessionStart + CLAUDE_SESSION_WINDOW_MS;
    const usedTokens = messages.reduce((sum, msg) => sum + msg.tokens, 0);
    const usedPercent = Math.min((usedTokens / planLimit) * 100, 100);

    return {
      ok: true,
      sourceLabel: `local JSONL token count (${usedTokens}/${planLimit} tokens)`,
      rateLimits: {
        primary: {
          used_percent: Math.round(usedPercent),
          resets_at: Math.floor(sessionEnd / 1000),
        },
        secondary: null,
      },
    };
  } catch {
    return null;
  }
}

function toPctFromUtilization(utilization) {
  if (typeof utilization !== "number" || Number.isNaN(utilization)) return null;
  // Claude API 可能返回 0-1（比例）或 0-100（百分比），都要兼容
  if (utilization > 1) {
    // 已是百分比
    return Math.max(0, Math.min(100, Math.round(utilization)));
  } else {
    // 比例
    return Math.max(0, Math.min(100, Math.round(utilization * 100)));
  }
}

async function fetchAndRenderClaude() {
  if (!isClaudeProviderAvailable()) {
    claudeStatusBarItem.hide();
    return;
  }

  const claudePrefix = getClaudePrefix();
  claudeStatusBarItem.text = "$(sync~spin) Claude";
  claudeStatusBarItem.tooltip = "Claude 用量加载中…";

  if (!lastClaudeRateLimitResult && extensionContext) {
    const persisted = extensionContext.globalState.get(CLAUDE_LAST_RATE_LIMIT_KEY);
    if (persisted?.ok && persisted?.rateLimits) {
      lastClaudeRateLimitResult = persisted;
    }
  }

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");

  const localTokenCountResult = buildClaudeRateLimitsFromLocalTokenCount(projectsRoot, credPath);
  if (localTokenCountResult?.ok) {
    lastClaudeRateLimitResult = localTokenCountResult;
    await extensionContext.globalState.update(CLAUDE_LAST_RATE_LIMIT_KEY, localTokenCountResult);
    renderClaudeRateLimits(localTokenCountResult);
    return;
  }

  const sessionHit = findNewestClaudeSessionWithRateLimits(projectsRoot, 20);
  if (sessionHit?.rateLimits) {
    const sessionResult = {
      ok: true,
      sourceLabel: "local session rate limits",
      rateLimits: sessionHit.rateLimits,
    };
    lastClaudeRateLimitResult = sessionResult;
    await extensionContext.globalState.update(CLAUDE_LAST_RATE_LIMIT_KEY, sessionResult);
    renderClaudeRateLimits(sessionResult);
    return;
  }

  if (lastClaudeOauthSuccessAt && Date.now() - lastClaudeOauthSuccessAt < CLAUDE_OAUTH_MIN_INTERVAL_MS && lastClaudeRateLimitResult?.ok) {
    renderClaudeRateLimits({ ...lastClaudeRateLimitResult, sourceLabel: `${lastClaudeRateLimitResult.sourceLabel} (cached)` });
    return;
  }

  if (lastClaudeOauth429At && Date.now() - lastClaudeOauth429At < lastClaudeOauth429RetryAfterMs) {
    if (lastClaudeRateLimitResult?.ok) {
      renderClaudeRateLimits({ ...lastClaudeRateLimitResult, sourceLabel: `${lastClaudeRateLimitResult.sourceLabel} (cached)` });
      return;
    }
  }

  const token = await resolveClaudeToken();
  if (!token) {
    const authState = extensionContext.globalState.get(CLAUDE_AUTH_STATE_KEY);
    if (authState?.kind === "oauth_forbidden") {
      claudeStatusBarItem.text = `${claudePrefix} Claude: OAuth受限`;
      claudeStatusBarItem.tooltip = [
        "Claude 浏览器授权已完成回调，但 token 交换被 Anthropic 拒绝",
        "错误: 403 Request not allowed",
        "官方文档说明：未获批准的第三方产品不能提供 claude.ai 登录或其 rate limits",
        "可改用现成 OAuth token 环境变量/设置，或关闭 Claude 状态栏项",
      ].join("\n");
      claudeStatusBarItem.command = "aiUsage.authenticateClaude";
      claudeStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }

    claudeStatusBarItem.text = `${claudePrefix} Claude: 未授权`;
    claudeStatusBarItem.tooltip = [
      "尚未授权 Claude",
      "• 点击运行命令「AI Usage: Authorize Claude (OAuth Login)」完成显式 OAuth 授权",
      "• 或在设置 aiUsage.claude.oauthToken / 环境变量中提供 OAuth token（遗留方式）",
    ].filter(Boolean).join("\n");
    claudeStatusBarItem.command = "aiUsage.authenticateClaude";
    claudeStatusBarItem.backgroundColor = undefined;
    return;
  }

  try {
    const data = await fetchClaudeUsage(token);
    const oauthResult = parseClaudeApiRateLimits(data);
    lastClaudeRateLimitResult = oauthResult;
    lastClaudeOauth429At = 0;
    lastClaudeOauth429RetryAfterMs = 5 * 60 * 1000;
    lastClaudeOauthSuccessAt = Date.now();
    await extensionContext.globalState.update(CLAUDE_LAST_RATE_LIMIT_KEY, oauthResult);
    await extensionContext.globalState.update(CLAUDE_AUTH_STATE_KEY, undefined);
    renderClaudeRateLimits(oauthResult);
  } catch (e) {
    const is401 = /HTTP 401/.test(e.message);
    const is403 = /HTTP 403/.test(e.message);
    const is429 = /HTTP 429/.test(e.message);
    const isTransient = isClaudeTransientError(e.message);

    if (is429) {
      lastClaudeOauth429At = Date.now();
      lastClaudeOauth429RetryAfterMs = Math.min(lastClaudeOauth429RetryAfterMs * 2, CLAUDE_MAX_COOLDOWN_MS);
    }

    if ((is429 || isTransient) && lastClaudeRateLimitResult?.ok) {
      renderClaudeRateLimits({ ...lastClaudeRateLimitResult, sourceLabel: `${lastClaudeRateLimitResult.sourceLabel} (cached)` });
      return;
    }

    if (shouldAssumeClaudeFullFromNoData(e.message, projectsRoot)) {
      const assumed = buildClaudeAssumedFullResult("no data available");
      lastClaudeRateLimitResult = assumed;
      await extensionContext.globalState.update(CLAUDE_LAST_RATE_LIMIT_KEY, assumed);
      renderClaudeRateLimits(assumed);
      return;
    }

    if (is401) {
      await extensionContext.secrets.delete(CLAUDE_SECRET_KEY).catch(() => {});
      await extensionContext.globalState.update(CLAUDE_AUTH_STATE_KEY, undefined);
      claudeStatusBarItem.text = `${claudePrefix} Claude: 需重新授权`;
      claudeStatusBarItem.tooltip = "Claude token 已失效（401），请点击重新授权";
      claudeStatusBarItem.command = "aiUsage.authenticateClaude";
    } else if (is403) {
      // 403 usually means the current OAuth token lacks usage-endpoint permission;
      // keep the token to avoid bouncing back to an unauthenticated state.
      await extensionContext.globalState.update(CLAUDE_AUTH_STATE_KEY, {
        kind: "usage_forbidden",
        message: "The current OAuth token cannot access the usage endpoint.",
      });
      claudeStatusBarItem.text = `${claudePrefix} Claude: 已授权(403)`;
      claudeStatusBarItem.tooltip = [
        "Claude 已完成授权，但 usage 接口返回 403 (Request not allowed)",
        "这通常是账号/权限策略导致，不代表本地授权丢失",
        "可点击重试，或重新运行授权命令获取新 token",
      ].join("\n");
      claudeStatusBarItem.command = "aiUsage.refreshClaude";
    } else {
      claudeStatusBarItem.text = `${claudePrefix} -`;
      claudeStatusBarItem.tooltip = `Claude 获取失败: ${e.message}\n点击重试`;
      claudeStatusBarItem.command = "aiUsage.refreshClaude";
    }
    claudeStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

// ---------- Cursor ----------

const { execSync } = require("child_process");

function readCursorDb(key) {
  try {
    if (!fs.existsSync(CURSOR_DB_PATH)) return null;
    const result = execSync(
      `sqlite3 "${CURSOR_DB_PATH}" "SELECT value FROM ItemTable WHERE key='${key}';"`,
      { encoding: "utf8", timeout: 4000 }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

async function fetchCursorCurrentPeriodUsage(token) {
  const res = await fetch(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAndRenderCursor() {
  const cursorPrefix = getCursorPrefix();
  cursorStatusBarItem.text = "$(sync~spin) Cursor";
  cursorStatusBarItem.tooltip = "Cursor 用量加载中…";

  const token = readCursorDb("cursorAuth/accessToken");
  const plan = readCursorDb("cursorAuth/stripeMembershipType") ?? "unknown";
  const status = readCursorDb("cursorAuth/stripeSubscriptionStatus") ?? "";
  const cachedEmail = readCursorDb("cursorAuth/cachedEmail");

  if (!token) {
    cursorStatusBarItem.text = `${cursorPrefix} Cursor: 未登录`;
    cursorStatusBarItem.tooltip = "未找到 Cursor 登录信息\n请先在 Cursor 中登录账号";
    return;
  }

  // Decode JWT for userId (used for fallback API call)
  const payload = decodeJwtPayload(token);
  const sub = payload?.sub ?? "";
  const userId = sub.includes("|") ? sub.split("|").pop() : sub;
  const accountLabel = pickFirstNonEmpty(
    cachedEmail,
    payload?.email,
    payload?.preferred_username,
    payload?.name,
    payload?.nickname
  );

  const planLabel =
    plan === "pro" ? "Pro" :
    plan === "free" ? "Free" :
    plan === "business" ? "Business" :
    plan.charAt(0).toUpperCase() + plan.slice(1);

  try {
    // Preferred API: exposes Auto+Composer and API percentages separately.
    const periodData = await fetchCursorCurrentPeriodUsage(token);
    const planUsage = periodData?.planUsage;
    const spendLimitUsage = periodData?.spendLimitUsage;

    const formatUsd = (cents) => {
      if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
      return `$${(cents / 100).toFixed(2)}`;
    };

    const odUsed = formatUsd(spendLimitUsage?.individualUsed);
    const odLimit = formatUsd(spendLimitUsage?.individualLimit);
    const odRem = formatUsd(spendLimitUsage?.individualRemaining);
    const odStr = odUsed && odLimit ? `${odUsed}/${odLimit}` : "-";

    if (
      planUsage &&
      typeof planUsage.autoPercentUsed === "number" &&
      typeof planUsage.apiPercentUsed === "number"
    ) {
      const autoUsed = Math.round(planUsage.autoPercentUsed);
      const apiUsed = Math.round(planUsage.apiPercentUsed);
      const totalUsed = typeof planUsage.totalPercentUsed === "number"
        ? Math.round(planUsage.totalPercentUsed)
        : Math.max(autoUsed, apiUsed);

      const autoRem = Math.max(0, 100 - autoUsed);
      const apiRem = Math.max(0, 100 - apiUsed);
      const verbose = getConfig().get('style', 'minimal') === 'verbose';
      const usageStr = odUsed && odLimit
        ? `${autoRem}% ${apiRem}% ${odStr}`
        : `${autoRem}% ${apiRem}%`;

      const billingStart = periodData?.billingCycleStart
        ? new Date(parseInt(periodData.billingCycleStart, 10))
        : null;
      const billingEnd = periodData?.billingCycleEnd
        ? new Date(parseInt(periodData.billingCycleEnd, 10))
        : null;
      const resetDaysLabel = billingEnd ? formatRemainingDaysLabel(billingEnd.getTime()) : null;
      const resetDaysPrefix = resetDaysLabel ? `${resetDaysLabel} ` : "";
      const cycleStr = billingStart && billingEnd
        ? `${billingStart.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} - ${billingEnd.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}`
        : "";

      cursorStatusBarItem.text = verbose ? `${cursorPrefix} ${resetDaysPrefix}Cursor ${usageStr}` : `${cursorPrefix} ${resetDaysPrefix}${usageStr}`;
      cursorStatusBarItem.tooltip = [
        `Cursor ${planLabel}${status === "active" ? " (订阅中)" : ""}`,
        accountLabel ? `账号: ${accountLabel}` : "",
        `Auto + Composer: 已用 ${autoUsed}% / 剩余 ${autoRem}%`,
        `API: 已用 ${apiUsed}% / 剩余 ${apiRem}%`,
        odUsed && odLimit
          ? `On-Demand: 已用 ${odUsed} / 限额 ${odLimit}${odRem ? ` / 剩余 ${odRem}` : ""}`
          : `On-Demand: 当前接口未提供`,
        `总计: 已用 ${totalUsed}%`,
        cycleStr ? `计费周期: ${cycleStr}` : "",
        periodData?.displayMessage ? `提示: ${periodData.displayMessage}` : "",
        "",
        "点击刷新",
      ].filter(Boolean).join("\n");

      if (Math.max(autoUsed, apiUsed) >= 90) {
        cursorStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      } else {
        cursorStatusBarItem.backgroundColor = undefined;
      }
      return;
    }

    // Fallback API: older endpoint with aggregated request count.
    const res = await fetch(
      `https://api2.cursor.sh/auth/usage?user=${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Aggregate numRequests across all models
    let totalRequests = 0;
    let maxRequests = null;
    let startOfMonth = null;
    for (const [key, val] of Object.entries(data)) {
      if (key === "startOfMonth") { startOfMonth = val; continue; }
      if (typeof val === "object" && val !== null) {
        totalRequests += val.numRequests ?? 0;
        if (val.maxRequestUsage) maxRequests = val.maxRequestUsage;
      }
    }

    const resetStr = startOfMonth
      ? new Date(startOfMonth).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
      : "";
    const nextReset = getNextResetFromStartOfMonth(startOfMonth);
    const resetDaysLabel = nextReset ? formatRemainingDaysLabel(nextReset.getTime()) : null;
    const resetDaysPrefix = resetDaysLabel ? `${resetDaysLabel} ` : "";

    const verbose = getConfig().get('style', 'minimal') === 'verbose';
    cursorStatusBarItem.text = verbose ? `${cursorPrefix} ${resetDaysPrefix}Cursor - -` : `${cursorPrefix} ${resetDaysPrefix}- -`;
    cursorStatusBarItem.tooltip = [
      `Cursor ${planLabel}${status === "active" ? " (订阅中)" : ""}`,
      accountLabel ? `账号: ${accountLabel}` : "",
      `当前接口未返回 Auto/API 余量百分比，已回退到旧接口。`,
      `On-Demand: 当前接口未提供`,
      `本月请求数: ${totalRequests}${maxRequests ? " / " + maxRequests : ""}`,
      resetStr ? `计费周期开始: ${resetStr}` : "",
      "",
      "点击刷新",
    ].filter(Boolean).join("\n");
    cursorStatusBarItem.backgroundColor = undefined;
  } catch (e) {
    cursorStatusBarItem.text = `${cursorPrefix} -`;
    cursorStatusBarItem.tooltip = `Cursor 获取失败: ${e.message}\n点击重试`;
    cursorStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

module.exports = { activate, deactivate };
