# Rex Human Cursor Mockup

This is an isolated prototype for a future Rex browser cursor layer.

## What it demonstrates
- A custom aesthetic cursor (core + ring + click burst)
- Smooth human-ish movement with spring/damping and micro-jitter
- Intent-driven interactions with clickable links/buttons
- Idle behavior: random wandering when no click target is chosen for a while
- Interaction feed showing movement/click decisions

## Run it
Open `mockups/rex-human-cursor-demo/index.html` in a browser.

Optional local server from repo root:

```powershell
npx live-server mockups/rex-human-cursor-demo
```

## Notes for Rex integration later
- `queueIntent()` is where action intent is selected.
- `resolve target` currently uses DOM elements with `.js-clickable`.
- `tick()` loop can later consume real browser action plans from Rex.
