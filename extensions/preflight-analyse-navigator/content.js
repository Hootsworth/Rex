(() => {
  const ROOT_ATTR = 'data-rex-preflight-nav';
  const ITEM_ATTR = 'data-rex-nav-id';
  const REX_ID_ATTR = 'data-rex-id';
  const META_ATTR = 'data-rex-nav-meta';

  let counter = 0;
  const weakIds = new WeakMap();
  let state = { enabled: true, annotate: true, pulseMs: 1200 };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return r.bottom >= 0 && r.right >= 0 && r.top <= window.innerHeight;
  };

  const textOf = (el) => (
    el.innerText ||
    el.textContent ||
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('placeholder') ||
    ''
  ).replace(/\s+/g, ' ').trim().slice(0, 120);

  const roleOf = (el) => (el.getAttribute('role') || '').trim();

  const score = (el) => {
    const r = el.getBoundingClientRect();
    let s = 0;
    if (visible(el)) s += 20;
    if (r.top >= 0 && r.top < window.innerHeight * 0.5) s += 8;
    if (el.tagName === 'BUTTON') s += 15;
    if (roleOf(el) === 'button') s += 10;
    if ((el.getAttribute('href') || '').startsWith('http')) s += 12;
    if (textOf(el).length >= 3) s += 10;
    return s;
  };

  const idFor = (el) => {
    // Reuse existing data-rex-id if already set (e.g. by the marker script)
    if (el.hasAttribute(REX_ID_ATTR)) return el.getAttribute(REX_ID_ATTR);
    if (el.hasAttribute(ITEM_ATTR)) return el.getAttribute(ITEM_ATTR);
    if (weakIds.has(el)) return weakIds.get(el);
    counter += 1;
    const id = String(counter);
    weakIds.set(el, id);
    return id;
  };

  const annotateOne = (el) => {
    const id = idFor(el);
    // Set BOTH attributes so both the extension selectors and the main
    // automation code ([data-rex-id]) can find the element.
    el.setAttribute(ITEM_ATTR, id);
    el.setAttribute(REX_ID_ATTR, id);

    const meta = {
      id,
      tag: el.tagName.toLowerCase(),
      text: textOf(el),
      role: roleOf(el),
      href: el.getAttribute('href') || '',
      placeholder: el.getAttribute('placeholder') || '',
      score: score(el)
    };
    el.setAttribute(META_ATTR, JSON.stringify(meta));
  };

  const selectors = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[onclick]'
  ].join(',');

  const run = () => {
    if (!state.enabled) return;

    document.documentElement.setAttribute(ROOT_ATTR, '1');

    const nodes = Array.from(document.querySelectorAll(selectors));
    const annotated = [];
    for (const el of nodes) {
      if (!visible(el)) continue;
      annotateOne(el);
      const id = el.getAttribute(REX_ID_ATTR);
      if (id) {
        annotated.push({
          id,
          tag: el.tagName.toLowerCase(),
          text: textOf(el),
          role: roleOf(el),
          href: el.getAttribute('href') || '',
          placeholder: el.getAttribute('placeholder') || '',
          score: score(el)
        });
      }
    }

    // Expose annotation data for Playwright page.evaluate() to read
    window.__rexPreflightData = annotated;
  };

  const injectStyles = () => {
    if (!state.annotate) return;
    if (document.getElementById('rex-preflight-style')) return;

    const style = document.createElement('style');
    style.id = 'rex-preflight-style';
    style.textContent = `
      [${ITEM_ATTR}] {
        --rex-outline: rgba(255, 96, 0, 0.45);
      }
      [${ITEM_ATTR}]:hover {
        outline: 2px solid var(--rex-outline) !important;
        outline-offset: 1px !important;
      }
    `;
    document.documentElement.appendChild(style);
  };

  const initState = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'preflight:getState' });
      if (res) state = { ...state, ...res };
    } catch {
      // Non-fatal if runtime channel is unavailable.
    }
  };

  const observer = new MutationObserver(() => {
    window.clearTimeout(observer._t);
    observer._t = window.setTimeout(run, 120);
  });

  // Re-run on full-page navigations (SPA pushState / replaceState)
  const patchHistory = (method) => {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      window.setTimeout(run, 200);
      return result;
    };
  };
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('popstate', () => window.setTimeout(run, 200));

  initState().then(() => {
    injectStyles();
    run();
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    window.setInterval(run, Math.max(600, Number(state.pulseMs || 1200)));
  });
})();
