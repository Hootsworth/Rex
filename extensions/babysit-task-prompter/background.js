const DEFAULT_STATE = {
  enabled: true,
  tone: "neutral"
};

const tabPromptState = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("babysitPromptState");
  if (!current.babysitPromptState) {
    await chrome.storage.local.set({ babysitPromptState: DEFAULT_STATE });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "babysit:getState") {
    chrome.storage.local.get("babysitPromptState").then((res) => {
      sendResponse(res.babysitPromptState || DEFAULT_STATE);
    });
    return true;
  }

  if (message?.type === "babysit:setState") {
    const next = { ...DEFAULT_STATE, ...(message.value || {}) };
    chrome.storage.local.set({ babysitPromptState: next }).then(() => {
      sendResponse({ ok: true, state: next });
    });
    return true;
  }

  if (message?.type === "babysit:promptResult") {
    const tabId = Number(sender?.tab?.id || message.tabId || -1);
    if (tabId >= 0) {
      tabPromptState.set(tabId, {
        at: new Date().toISOString(),
        result: message.result || "dismissed",
        taskId: String(message.taskId || ""),
        note: String(message.note || "")
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "babysit:getLastPromptResult") {
    const tabId = Number(message.tabId || sender?.tab?.id || -1);
    const out = tabPromptState.get(tabId) || null;
    sendResponse({ ok: true, result: out });
    return true;
  }

  if (message?.type === "babysit:showPrompt") {
    const tabId = Number(message.tabId || sender?.tab?.id || -1);
    if (tabId < 0) {
      sendResponse({ ok: false, error: "Missing tabId" });
      return true;
    }

    chrome.tabs.sendMessage(tabId, {
      type: "babysit:showPrompt",
      payload: message.payload || {}
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabPromptState.delete(tabId);
});
