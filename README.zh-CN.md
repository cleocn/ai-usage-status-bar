# AI Usage Status Bar

在 VS Code 状态栏直接显示 **GitHub Copilot、ChatGPT、Cursor、Claude** 的用量信息，无需打开浏览器。

![状态栏预览](./assets/statusbar-preview.png)

[English](./README.md) | 中文

[Changelog](./CHANGELOG.md) | [中文更新日志](./CHANGELOG.zh-CN.md)

## 功能特性

- **四家提供商** — GitHub Copilot 配额、ChatGPT/Codex 双窗口用量、Cursor 用量、Claude 用量统一展示（Claude 在插件市场版本暂时关闭）
- **重置倒计时前缀** — 每个状态栏项都会在图标后先显示 `Xd`（距离下个重置点的天数）
- **Codex 动态窗口标签** — 状态栏显示距离重置还剩的时间标签（例如 `3h`、`6d`）和剩余百分比
- **Cursor 精简外显** — 状态栏显示 Auto/API 剩余百分比，若有 OD 则追加金额数值
- **Claude 双窗口用量** — 当 OAuth 用量数据可用时，显示 5h/7d 剩余百分比（自动兼容 utilization 字段为 0-1 或 0-100）
- **清晰前缀图标** — Copilot 使用 `$(github)`，ChatGPT/Codex 使用内置 `$(openai)`，Cursor 使用 `◈`，Claude 使用 `◆`
- **统一外显规范** — 所有提供商都优先显示余量信息，状态栏格式保持一致
- **颜色预警** — Copilot 剩余 ≤ 25% 时状态栏变橙色，≤ 10% 时附加警告图标
- **悬浮详情** — 鼠标悬停显示每家提供商的详细信息（含已识别的登录账号）
- **ChatGPT 更新提示** — ChatGPT/Codex 悬浮详情显示“上次更新时间”
- **自动刷新** — 每 30 分钟在后台自动更新
- **风格切换** — 通过设置在 `minimal`（`32/50`）和 `verbose`（`Copilot 32/50`）之间切换
- **按需开关** — 可独立控制每家提供商的状态栏条目显示与隐藏

## 数据说明

| 提供商 | 数据内容 | 数据来源 |
|--------|---------|---------|
| GitHub Copilot | 高级请求剩余 / 总量 + 剩余百分比 | `api.github.com/copilot_internal/user` |
| ChatGPT / Codex | 套餐类型 + 续费日期 + **5h/7d 用量窗口** | `~/.codex/auth.json` JWT + `~/.codex/logs_1.sqlite` 响应头 |
| Cursor | 当前计费周期 **Auto + Composer 剩余 %** 与 **API 剩余 %** | `api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Claude | **5h/7d 剩余 %** 与重置时间 | `api.anthropic.com/api/oauth/usage`（OAuth token 来自设置或环境变量，utilization 字段自动兼容 0-1 或 0-100） |

> Codex 窗口用量来自本地 Codex 日志中的最近一次 API 响应头，因此至少先使用一次 Codex 才会出现数据。

## 安装

### 从源码安装（开发者方式）

1. 克隆本仓库
2. 打开 VS Code
3. 按 `Cmd+Shift+P`，输入 **Extensions: Install from Location**
4. 选择克隆后的文件夹

### 从 VSIX 安装（发布后）

```bash
code --install-extension ai-usage-status-bar-1.0.3.vsix
```

## 环境要求

- VS Code 1.74+
- 已在 VS Code 中登录 GitHub 账号并开启 Copilot
- 安装并登录 [OpenAI Codex CLI](https://github.com/openai/codex)（ChatGPT 信息需要）
- 安装并登录 [Cursor](https://cursor.sh)（Cursor 信息需要）
- Claude：实验功能，由单一开关控制。

## 平台支持

| 提供商 | macOS | Windows | Linux |
|--------|-------|---------|-------|
| GitHub Copilot | ✅ | ✅ | ✅ |
| ChatGPT / Codex | ✅ | ✅ | ✅ |
| Cursor | ✅ | ✅ | ✅ |
| Claude（实验功能） | ✅ | ✅ | ✅ |

Cursor 的 `state.vscdb` 路径按平台自动解析：
- **macOS**：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Windows**：`%APPDATA%/Cursor/User/globalStorage/state.vscdb`
- **Linux**：`~/.config/Cursor/User/globalStorage/state.vscdb`

Codex 路径（`~/.codex/`）和 Copilot API 调用默认即跨平台兼容；Claude 的 OAuth 用量接口同样跨平台。

## 设置项

在 VS Code 设置中搜索 **"AI Usage"**，或直接编辑 `settings.json`：

```jsonc
{
  // "minimal"（默认）：只显示图标和数字
  // "verbose"：同时显示提供商名称
  "aiUsage.style": "minimal",

  // 控制每家提供商的状态栏条目
  "aiUsage.providers.copilot": true,
  "aiUsage.providers.chatgpt": true,
  "aiUsage.providers.cursor": true,

  // 可选：Claude OAuth token（遗留，优先使用命令授权）
  "aiUsage.claude.oauthToken": "",

  // 单一开关：启用 Claude usage 实验功能
  "aiUsage.experimental.enableClaudeUsage": false
}
```

**风格对比：**

| 风格 | Copilot | ChatGPT | Cursor | Claude |
|------|---------|---------|--------|--------|
| `minimal` | `$(github) 10d 32/50 64%` | `$(openai) 10d 3h 90% 6d 54%` | `◈ 10d 21% 0% $1.20/$20.00` | `◆ 4h 85% 6d 41%` |
| `verbose` | `$(github) 10d Copilot 32/50 64%` | `$(openai) 10d Codex 3h 90% 6d 54%` | `◈ 10d Cursor 21% 0% $1.20/$20.00` | `◆ Claude 4h 85% 6d 41%` |

设置修改后立即生效，无需重新加载。

## 命令

| 命令 | 说明 |
|------|------|
| `Copilot Usage: Refresh` | 手动刷新 Copilot 用量 |
| `Copilot Usage: Sign in to GitHub` | 触发 GitHub 登录流程 |
| `AI Usage: Open ChatGPT Usage Page` | 打开 chatgpt.com 用量设置页 |
| `AI Usage: Refresh Cursor Usage` | 手动刷新 Cursor 用量 |
| `AI Usage: Open Claude Usage Page` | 打开 claude.ai 用量设置页 |
| `AI Usage: Refresh Claude Usage` | 手动刷新 Claude 用量 |
| `AI Usage: Authorize Claude (OAuth Login)` | 在浏览器中完成 Claude OAuth 授权 |
| `AI Usage: Sign Out Claude` | 退出 Claude 授权 |

## 工作原理

- **Copilot**：调用 `vscode.authentication.getSession('github', ['read:user'])` 获取 Token → 请求 `api.github.com/copilot_internal/user`（未文档化内部接口，可能随时变更）
- **ChatGPT/Codex**：读取 `~/.codex/auth.json` 获取套餐/续费信息，再从 `~/.codex/logs_1.sqlite` 的 `x-codex-*` 响应头提取窗口用量
- **Cursor**：读取 `state.vscdb`（SQLite）获取 Bearer Token → 请求 `api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` 获取 Auto/API 百分比（必要时回退 `auth/usage`）；状态栏前缀固定使用兼容性更稳定的 `◈`
- **Claude**：由单一实验开关 `aiUsage.experimental.enableClaudeUsage` 控制（默认 `false`）。开启后，数据源优先级为：1) 本地 Claude session JSONL 的 token 统计（5h 窗口）；2) 本地 session 中的 `rate_limits`；3) 最后才回退 OAuth usage API。也就是说 OAuth 现在是兜底数据源，并带有容错策略（429 冷却、最近成功结果缓存回退、无利用率时软回退）。OAuth token 解析顺序为：先 VS Code `SecretStorage`，再 macOS Claude Desktop 本地 cache，最后设置项/环境变量。仅当本地 session 数据不可用时，才调用 `api.anthropic.com/api/oauth/usage`。

## 致谢

- 致敬 [duddudcns/ai-usage-statusbar](https://github.com/duddudcns/ai-usage-statusbar.git) 的优秀实现思路，尤其是在多数据源回退策略与本地信号稳健性方面对本项目有直接启发。

## License

MIT
