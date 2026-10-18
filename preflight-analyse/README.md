# Preflight Analyse

Preflight Analyse is a standalone JavaScript workspace for validating planned actions before execution.
It packages reusable preflight modules for agent logic, browser automation, and Windows OS automation.

## Why this project exists

Preflight checks reduce avoidable failures by surfacing risk early, before executing a tool action.
This workspace isolates preflight logic from the larger application so it can be:

- Maintained and tested independently
- Reused across multiple products
- Evolved without coupling to non-preflight runtime code

## Package layout

```text
products/
	agent-preflight-core/
		src/preflight.js
	browser-preflight-analyse/
		src/browserPreflight.js
	os-preflight-analyse/
		src/osPreflight.js
```

## Included modules

### 1) Agent Preflight Core

Location: products/agent-preflight-core

Primary API:

- runPreflightAnalysis({ toolName, toolArgs, sessionMeta, historyContext })

What it does:

- Classifies goal and situation context
- Computes confidence and risk flags
- Produces a recommended subplan and fallback order
- Returns execution hints and a concise context snippet

### 2) Browser Preflight Analyse

Location: products/browser-preflight-analyse

Primary APIs:

- collectBrowserHealth(page, manager)
- collectPreflightExtensionIntel(page)
- preflightRecommendation(health, targetAction, readiness, extensionIntel)
- preflightRecommendationLegacy(health, targetAction, readiness)

What it does:

- Captures browser runtime health (URL, tab state, interactables)
- Reads extension-provided preflight signals when available
- Generates risk-scored action recommendations

Runtime notes:

- Designed for Playwright page objects
- Useful immediately before risky actions such as click, type, hover, and evaluate

### 3) OS Preflight Analyse

Location: products/os-preflight-analyse

Primary API:

- runOsPreflight(action)

What it does:

- Normalizes OS action inputs (open, type, click, hotkey)
- Validates prerequisites and high-risk conditions
- Returns warnings/errors and normalized execution payload

Platform notes:

- Windows only (uses PowerShell and foreground window inspection)

## Quick start

### Prerequisites

- Node.js 18+

### Install

```bash
npm install
```

### Example usage

```js
import { runPreflightAnalysis } from './products/agent-preflight-core/src/preflight.js';

const packet = runPreflightAnalysis({
	toolName: 'browser_interact',
	toolArgs: { action: 'click', targetAction: 'click' },
	sessionMeta: { topLevelRequest: 'Open settings and enable sync' },
	historyContext: []
});

console.log(packet);
```

```js
import {
	collectBrowserHealth,
	preflightRecommendation
} from './products/browser-preflight-analyse/src/browserPreflight.js';

// page: Playwright Page, manager: your tab manager
const health = await collectBrowserHealth(page, manager);
const readiness = { ok: true };
const recommendation = preflightRecommendation(health, 'click', readiness);

console.log(recommendation);
```

```js
import { runOsPreflight } from './products/os-preflight-analyse/src/osPreflight.js';

const report = await runOsPreflight({
	type: 'hotkey',
	combo: 'CTRL+S',
	visualCursor: true
});

console.log(report);
```

## Response shape highlights

Common outputs across modules include:

- ok/readiness indicators
- Risk level or score
- Suggested next action
- Warnings and errors for operator review

## Source lineage

This workspace was extracted from larger runtime modules to create productized, standalone preflight capabilities:

- Agent preflight logic
- Browser readiness and recommendation logic
- OS automation preflight validation logic

## Scope and non-goals

Scope:

- Provide pre-execution analysis and recommendation
- Improve reliability and operator confidence

Non-goals:

- Executing business workflows directly
- Replacing the underlying automation engines

## License

No license file is currently defined in this workspace.
