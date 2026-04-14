# Preflight Analyse

This folder is a standalone project space focused only on Preflight Analyse work.

## Purpose
- Isolate Preflight Analyse logic and experiments from the main project.
- Keep preflight-related code, docs, and tests together.

## Productized Tools
- `products/agent-preflight-core` - Mission packet and risk-context planner.
- `products/browser-preflight-analyse` - Browser health collection and recommendation engine.
- `products/os-preflight-analyse` - Windows OS action preflight validation.

## Source Mapping (Main Project)
- Extracted from `src/agent/preflight.js`: preflight core mission analyzer.
- Extracted from `src/webTools.js`: browser health and recommendation logic used by `preflight_analyse`.
- Extracted from `src/osAgent.js`: OS preflight validator used before OS automation actions.

## Notes
- This folder is intentionally standalone and does not modify the main project files.
