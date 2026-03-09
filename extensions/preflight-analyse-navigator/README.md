# Preflight Analyse Navigator Extension

This optional Chrome/Chromium extension improves agent navigation quality by:
- adding stable `data-rex-nav-id` attributes to visible interactive elements
- exposing metadata (`data-rex-nav-meta`) for better semantic targeting
- refreshing annotations as pages change (SPAs, modal overlays, dynamic lists)
- feeding `Preflgiht Analyse Plot` learning signals (what selectors succeeded/failed per intent)
- attaching context anchors (nearest heading + section landmarks) to each target
- tracking interaction mutation deltas after click/type actions
- generating obstruction maps for overlay/z-index blocked targets
- tagging form intents (email/password/search/address/etc.) from labels and aria

## Install (Chrome)
1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder: `extensions/preflight-analyse-navigator`

## Enable in RexAI Browser Runtime
Set environment variable before launching RexAI:

PowerShell:
```powershell
$env:REX_NAV_EXTENSION_PATH = "C:\Users\adity\OneDrive\Desktop\mysql\power-cli\extensions\preflight-analyse-navigator"
rexai chat --plan
```

When enabled, `browser_interact` Preflight Analyse reports include:
- `navigatorAssist.usingExtension: true`
- `navigatorAssist.extensionPath: ...`
- `preflgihtAnalysePlot`: persistent selector-memory summary for the current host

Runtime objects exposed on pages for debugging/automation:
- `window.__rexPreflightData`: annotated interactables with anchors/intents/obstruction metadata
- `window.__rexPreflightDelta`: snapshot-level added/removed/changed delta summary
- `window.__rexPreflightInteractionDelta`: post-click/type mutation delta payload
- `window.__rexPreflightObstructionMap`: list of currently blocked targets

## New Browser Actions for Better Navigation
- `preflight_analyse`: health and readiness report (+ optional auto-heal)
- `analyze_page`: rich interactive element scan for planning clicks/typing

Example:
```json
{ "action": "preflight_analyse", "targetAction": "click", "autoHeal": true }
```

```json
{ "action": "analyze_page" }
```
