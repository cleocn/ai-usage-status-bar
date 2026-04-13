# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [1.0.5] - 2026-04-13

### Fixed
- Removed temporary Claude debug popups left from 7d utilization troubleshooting.
- Kept Claude 7d remaining percentage calculation compatible with utilization values returned as either 0-1 or 0-100.

## [1.0.3] - 2026-04-11

### Added
- Copilot, ChatGPT/Codex, and Cursor tooltips now show the detected signed-in account when available.
- ChatGPT/Codex tooltips now include a "last updated" timestamp.
- Added bundled Cursor icon font assets for future UI integration.

### Changed
- Copilot status bar prefix now uses `$(github)` for more reliable rendering.
- Codex usage now reads from the latest available `~/.codex/logs_*.sqlite` database instead of assuming `logs_1.sqlite`.
- Remaining-time labels now switch to finer-grained `m`/`h` units near reset time.
- Cursor status bar keeps the stable `◈` fallback prefix across VS Code themes/versions for compatibility.
- Refreshed English and Chinese documentation for the current status bar behavior and release package name.

## [1.0.2] - 2026-04-07

### Changed
- Status bar now shows a reset countdown prefix (`Xd`) right after each provider icon.
- ChatGPT/Codex countdown prefix now uses subscription renewal date instead of window reset date.
- ChatGPT/Codex status bar window labels now show remaining-to-reset time (for example `3h`, `6d`) rather than fixed `5h`/`7d` text.
- Removed `OD`, `AUTO`, and `API` labels from compact status bar text to save space.
- Copilot no longer shows `OD 0` in status bar/tooltip when there is no overage.
- Cursor status bar keeps OD numeric value when available, but without the `OD` text label.
- Updated English and Chinese documentation to match current status bar behavior.

## [1.0.0] - 2026-04-05

### Added
- Initial release of AI Usage Status Bar extension.
- Status bar usage display for GitHub Copilot.
- Status bar usage display for ChatGPT/Codex (5h and 7d windows).
- Status bar usage display for Cursor (AUTO and API remaining percentages).
- Per-provider visibility toggles.
- Minimal and verbose display styles.
- Hover tooltips with detailed quota information.
- Auto-refresh every 30 minutes.

### Changed
- Unified status bar display to prioritize remaining percentage across all providers.
- Updated documentation in English and Chinese.
