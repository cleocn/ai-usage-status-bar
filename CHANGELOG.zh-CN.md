# 更新日志

本文件记录本项目的所有重要变更。

格式参考 Keep a Changelog，版本号遵循 Semantic Versioning。

## [1.0.6] - 2026-04-16

### 新增
- 新增致谢说明，致敬 [duddudcns/ai-usage-statusbar](https://github.com/duddudcns/ai-usage-statusbar.git) 对本项目实现思路的启发。

### 修复
- Claude 拉取流程改为本地优先：本地 JSONL token 统计 -> 本地 session `rate_limits` -> OAuth usage API。
- Claude 现在会缓存最近一次成功的限额结果，并在 OAuth 瞬时失败时回退使用缓存。
- Claude 对 OAuth `429` 增加冷却与回退策略，避免持续重复请求失败。
- Claude 在“本地有会话但暂时无 utilization 数据”场景下不再直接掉到 `-` 的硬失败显示。
- Claude token 兜底来源支持 `CLAUDE_CODE_OAUTH_TOKEN`，且 OAuth `403` 会保留“已授权但受限”的状态。

## [1.0.5] - 2026-04-13

### 修复
- 移除 Claude 7d 排查阶段遗留的临时 DEBUG 弹窗。
- 保持 Claude 7d 剩余百分比计算对 utilization 两种返回格式（0-1 或 0-100）的兼容。

## [1.0.3] - 2026-04-11

### 新增
- Copilot、ChatGPT/Codex 和 Cursor 的 tooltip 现在会在可识别时显示当前登录账号。
- ChatGPT/Codex 的 tooltip 现在会显示“上次更新时间”。
- 新增打包后的 Cursor 图标字体资源，为后续 UI 集成做准备。

### 变更
- Copilot 状态栏前缀改为使用 `$(github)`，提升显示稳定性。
- Codex 用量现在会自动读取最新的 `~/.codex/logs_*.sqlite`，不再固定假设为 `logs_1.sqlite`。
- 临近重置时，剩余时间标签会自动细化为 `m`/`h` 单位。
- 为兼容不同 VS Code 主题和版本，Cursor 状态栏继续固定使用稳定的 `◈` 前缀。
- 更新中英文文档，使其与当前状态栏行为和发布包名称保持一致。

## [1.0.2] - 2026-04-07

### 变更
- 状态栏现在会在每个提供商图标后先显示重置倒计时前缀（`Xd`）。
- ChatGPT/Codex 的倒计时前缀改为使用订阅续费日期，而不是窗口重置日期。
- ChatGPT/Codex 状态栏中的窗口标签改为显示距离重置的剩余时间（例如 `3h`、`6d`），不再固定显示 `5h`/`7d`。
- 移除了紧凑状态栏文本中的 `OD`、`AUTO` 和 `API` 标签，以节省空间。
- Copilot 在没有超额时，不再在状态栏和 tooltip 中显示 `OD 0`。
- Cursor 在有 OD 数据时仍会保留数值，但不再显示 `OD` 文本标签。
- 更新中英文文档以匹配当前状态栏行为。

## [1.0.0] - 2026-04-05

### 新增
- 发布 AI Usage Status Bar 扩展初始版本。
- 新增 GitHub Copilot 状态栏用量显示。
- 新增 ChatGPT/Codex（5h 和 7d 双窗口）状态栏用量显示。
- 新增 Cursor（AUTO 和 API 剩余百分比）状态栏用量显示。
- 新增按提供商独立控制显示与隐藏的设置项。
- 新增 `minimal` 和 `verbose` 两种显示风格。
- 新增悬浮 tooltip 详细用量说明。
- 新增每 30 分钟自动刷新。

### 变更
- 统一状态栏外显规范，优先展示剩余百分比而不是已用量。
- 更新中英文文档。
