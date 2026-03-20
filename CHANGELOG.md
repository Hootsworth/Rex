# Changelog

All notable changes to this project will be documented in this file.

## 8.0.0 - 2026-03-13

### Major: Preflight Analyse v2
- Upgraded Preflight Analyse into a versioned v2 intelligence system across Rex runtime and browser extension.
- Added confidence-scored action lanes (`click`, `type`, `navigate`, `hover`) and temporal stability scoring for interactables.
- Added risk profiling (`low`/`medium`/`high`) based on blocked-target ratio and DOM volatility.
- Added extension telemetry recording support for diagnostics via background worker storage APIs.
- Added richer preflight report payloads in `browser_interact` with v2 recommendation scores, hardening actions, and extension intel snapshots.
- Preserved legacy recommendation output for backward compatibility while introducing v2 scoring output.

### Core Agent Intelligence
- Upgraded mission packet preflight logic to v2 (`preflightVersion: 2.0.0`) in both main runtime and xrisk compat layer.
- Added richer situation classification, browser-risk flags, tool-context metadata, and execution hints for safer action planning.

### Developer Experience
- Bumped `preflight-analyse-navigator` extension to `2.0.0` and updated extension docs.
- Added focused regression test coverage for v2 mission packets and preflight scoring behavior in `tests/preflight_v2_test.js`.
- Added `npm run test:preflight-v2` script for quick validation of the new preflight logic.
