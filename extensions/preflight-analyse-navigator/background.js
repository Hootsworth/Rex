const DEFAULT_STATE = {
  schemaVersion: 2,
  enabled: true,
  annotate: true,
  pulseMs: 1200,
  enableAnchors: true,
  enableMutationDelta: true,
  enableObstructionMap: true,
  enableFormIntent: true,
  enableActionLanes: true,
  enableTemporalStability: true,
  confidenceThreshold: 62
};

const TELEMETRY_KEY = 'preflightTelemetry';
const TELEMETRY_LIMIT = 120;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('preflightState');
  if (!current.preflightState) {
    await chrome.storage.local.set({ preflightState: DEFAULT_STATE });
  } else {
    await chrome.storage.local.set({ preflightState: { ...DEFAULT_STATE, ...current.preflightState } });
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

  if (message?.type === 'preflight:getVersion') {
    sendResponse({ ok: true, version: '2.0.0', schemaVersion: 2 });
    return false;
  }

  if (message?.type === 'preflight:recordTelemetry') {
    chrome.storage.local.get(TELEMETRY_KEY).then((res) => {
      const current = Array.isArray(res[TELEMETRY_KEY]) ? res[TELEMETRY_KEY] : [];
      const entry = {
        at: new Date().toISOString(),
        ...(message.value && typeof message.value === 'object' ? message.value : {})
      };
      const next = [entry, ...current].slice(0, TELEMETRY_LIMIT);
      return chrome.storage.local.set({ [TELEMETRY_KEY]: next }).then(() => next.length);
    }).then((count) => {
      sendResponse({ ok: true, count });
    }).catch((err) => {
      sendResponse({ ok: false, error: err?.message || 'telemetry write failed' });
    });
    return true;
  }

  if (message?.type === 'preflight:getTelemetry') {
    chrome.storage.local.get(TELEMETRY_KEY).then((res) => {
      sendResponse({ ok: true, events: Array.isArray(res[TELEMETRY_KEY]) ? res[TELEMETRY_KEY] : [] });
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
