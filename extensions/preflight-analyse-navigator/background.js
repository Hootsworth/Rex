const DEFAULT_STATE = {
  enabled: true,
  annotate: true,
  pulseMs: 1200,
  enableAnchors: true,
  enableMutationDelta: true,
  enableObstructionMap: true,
  enableFormIntent: true
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('preflightState');
  if (!current.preflightState) {
    await chrome.storage.local.set({ preflightState: DEFAULT_STATE });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'preflight:getState') {
    chrome.storage.local.get('preflightState').then((res) => {
      sendResponse(res.preflightState || DEFAULT_STATE);
    });
    return true;
  }

  if (message?.type === 'preflight:setState') {
    const next = { ...DEFAULT_STATE, ...(message.value || {}) };
    chrome.storage.local.set({ preflightState: next }).then(() => {
      sendResponse({ ok: true, state: next });
    });
    return true;
  }

  return false;
});

// Re-inject content script on full-page navigations so annotations survive
// page transitions within the same tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    }).catch(() => {
      // Ignore errors on chrome:// or other restricted pages
    });
  }
});
