# AI Usage Status Bar

A minimal VS Code extension that shows **GitHub Copilot, ChatGPT, Cursor, and Claude** usage directly in the status bar — no browser needed.

![Status bar preview](./assets/statusbar-preview.png)

English | [中文](./README.zh-CN.md)

[Changelog](./CHANGELOG.md) | [中文更新日志](./CHANGELOG.zh-CN.md)

## Features

- **4 providers** — GitHub Copilot quota, ChatGPT/Codex quota windows, Cursor usage, and Claude usage in one place (Claude is temporarily disabled in marketplace builds)
- **Reset countdown prefix** — each item starts with an `Xd` countdown to the next reset point
- **Codex dynamic windows** — status bar uses remaining-to-reset labels (for example `3h` and `6d`) with remaining %
- **Cursor compact usage** — status bar shows Auto/API remaining % and appends OD amount when available
- **Claude dual-window usage** — shows 5h/7d remaining percentages when OAuth usage data is available (auto-adapts to utilization in 0-1 or 0-100 format)
- **Clear provider prefixes** — uses `$(github)` for Copilot, `$(openai)` for ChatGPT/Codex, a stable `◈` fallback for Cursor, and `◆` for Claude
- **Unified external format** — all providers display remaining quota first in a compact format
- **Color warnings** — warns on low remaining quota (Copilot / Codex / Cursor)
- **Hover tooltip** — detailed breakdown on hover for each provider, including detected signed-in account
- **ChatGPT update hint** — ChatGPT/Codex tooltip includes a "last updated" timestamp
- **Auto-refresh** — updates every 30 minutes in the background
- **Style switching** — toggle between `minimal` (`32/50`) and `verbose` (`Copilot 32/50`) via settings
- **Per-provider toggle** — enable or disable each provider's status bar item independently

## What is tracked

| Provider | Metric | Source |
|----------|--------|--------|
| GitHub Copilot | Premium interactions remaining / total + remaining % | `api.github.com/copilot_internal/user` |
| ChatGPT / Codex | Plan type + renewal date + **5h/7d usage windows** | `~/.codex/auth.json` JWT + `~/.codex/logs_1.sqlite` response headers |
| Cursor | **Auto + Composer remaining %** and **API remaining %** (current billing cycle) | `api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Claude | **5h/7d remaining %** and reset times | `api.anthropic.com/api/oauth/usage` (OAuth token from setting or env var, utilization field auto-adapts 0-1 or 0-100) |

> Codex window usage is extracted from local Codex logs (latest API response headers), so it appears after you use Codex at least once.

## Installation

### From source (development)

1. Clone this repo
2. Open VS Code
3. Press `Cmd+Shift+P` → **Extensions: Install from Location**
4. Select the cloned folder

### From VSIX (once published)

```bash
code --install-extension ai-usage-status-bar-1.0.3.vsix
```

## Requirements

- VS Code 1.74+
- GitHub account signed in to VS Code with Copilot enabled
- [OpenAI Codex CLI](https://github.com/openai/codex) installed and signed in (for ChatGPT info)
- [Cursor](https://cursor.sh) installed and signed in (for Cursor info)
- Claude: experimental feature, controlled by one switch.

## Platform Support

| Provider | macOS | Windows | Linux |
|----------|-------|---------|-------|
| GitHub Copilot | ✅ | ✅ | ✅ |
| ChatGPT / Codex | ✅ | ✅ | ✅ |
| Cursor | ✅ | ✅ | ✅ |
| Claude (experimental) | ✅ | ✅ | ✅ |

Cursor's `state.vscdb` is resolved per platform automatically:
- **macOS**: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Windows**: `%APPDATA%/Cursor/User/globalStorage/state.vscdb`
- **Linux**: `~/.config/Cursor/User/globalStorage/state.vscdb`

Codex paths (`~/.codex/`) and Copilot API calls are cross-platform by default.
Claude uses browser OAuth which is cross-platform.

## Settings

Search **"AI Usage"** in VS Code Settings, or edit `settings.json` directly:

```jsonc
{
  // "minimal" (default): icon + numbers only
  // "verbose": include provider name
  "aiUsage.style": "minimal",

  // Toggle each provider's status bar item
  "aiUsage.providers.copilot": true,
  "aiUsage.providers.chatgpt": true,
  "aiUsage.providers.cursor": true,

  // Optional: Claude OAuth token (legacy, prefer command-based auth)
  "aiUsage.claude.oauthToken": "",

  // Single switch: enable Claude usage experimental feature
  "aiUsage.experimental.enableClaudeUsage": false
}
```

**Style examples:**

| Style | Copilot | ChatGPT | Cursor | Claude |
|-------|---------|---------|--------|--------|
| `minimal` | `$(github) 10d 32/50 64%` | `$(openai) 10d 3h 90% 6d 54%` | `◈ 10d 21% 0% $1.20/$20.00` | `◆ 4h 85% 6d 41%` |
| `verbose` | `$(github) 10d Copilot 32/50 64%` | `$(openai) 10d Codex 3h 90% 6d 54%` | `◈ 10d Cursor 21% 0% $1.20/$20.00` | `◆ Claude 4h 85% 6d 41%` |

Settings take effect immediately without reloading.

## Commands

| Command | Description |
|---------|-------------|
| `Copilot Usage: Refresh` | Manually refresh Copilot usage |
| `Copilot Usage: Sign in to GitHub` | Trigger GitHub sign-in |
| `AI Usage: Open ChatGPT Usage Page` | Open chatgpt.com usage settings |
| `AI Usage: Refresh Cursor Usage` | Manually refresh Cursor usage |
| `AI Usage: Open Claude Usage Page` | Open claude.ai usage settings |
| `AI Usage: Refresh Claude Usage` | Manually refresh Claude usage |
| `AI Usage: Authorize Claude (OAuth Login)` | Open browser to authorize Claude via OAuth |
| `AI Usage: Sign Out Claude` | Remove stored Claude OAuth token |

## How it works

- **Copilot**: calls `vscode.authentication.getSession('github', ['read:user'])` → queries `api.github.com/copilot_internal/user` (undocumented internal endpoint, may change)
- **ChatGPT/Codex**: reads `~/.codex/auth.json` for plan/subscription and `~/.codex/logs_1.sqlite` for `x-codex-*` usage headers
- **Cursor**: reads `state.vscdb` (SQLite) for the Bearer token → queries `api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` for Auto/API percentages (falls back to `auth/usage` when needed); the status bar keeps a stable `◈` prefix for compatibility across VS Code themes/versions
- **Claude**: controlled by one experimental switch: `aiUsage.experimental.enableClaudeUsage` (default `false`). When enabled, data source order is: (1) local Claude session JSONL token-count (5h window), (2) local session `rate_limits`, then (3) OAuth usage API. OAuth is now a fallback source and includes transient-failure handling (429 cooldown, cached last-success result, and no-data soft fallback). OAuth token resolution is: VS Code `SecretStorage` first, then Claude Desktop local cache on macOS, then manual setting/env token fallback. OAuth uses PKCE in browser (`https://claude.com/cai/oauth/authorize`, local callback `http://localhost:<port>/callback`) and queries `api.anthropic.com/api/oauth/usage` when local session data is unavailable.

## Acknowledgements

- Inspired by the excellent implementation ideas in [duddudcns/ai-usage-statusbar](https://github.com/duddudcns/ai-usage-statusbar.git), especially around provider fallback strategy and robustness for local usage signals.

## License

MIT
