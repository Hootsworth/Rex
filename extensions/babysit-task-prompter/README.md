# Babysit Task Prompter

This extension renders small in-page prompts that let the user complete, repeat, or defer AI-requested browser tasks.

## Trigger from page context

Dispatch this event from the page:

```js
window.dispatchEvent(new CustomEvent("rex-babysit-prompt", {
  detail: {
    taskId: "checkout-address",
    task: "Please fill your shipping address and click Save.",
    note: "If any field is unclear, click Repeat."
  }
}));
```

## Buttons

- `Done`: marks task completed
- `Repeat`: re-shows the same prompt immediately
- `Later`: dismisses prompt for now

Each action reports a result to the extension background script (`babysit:promptResult`).
