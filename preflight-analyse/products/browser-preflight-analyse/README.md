# Browser Preflight Analyse Product

Standalone browser health and recommendation engine extracted from main browser tooling.

## API
- `collectBrowserHealth(page, manager)`
- `collectPreflightExtensionIntel(page)`
- `preflightRecommendation(health, targetAction, readiness, extensionIntel)`
- `preflightRecommendationLegacy(health, targetAction, readiness)`

## Runtime
- Designed for Playwright page objects.
