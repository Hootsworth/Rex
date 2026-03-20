(() => {
  if (window.__rexPreflightNavigatorLoaded) return;
  window.__rexPreflightNavigatorLoaded = true;

  const PREFLIGHT_VERSION = '2.0.0';

  const ROOT_ATTR = 'data-rex-preflight-nav';
  const ITEM_ATTR = 'data-rex-nav-id';
  const REX_ID_ATTR = 'data-rex-id';
  const META_ATTR = 'data-rex-nav-meta';

  let counter = 0;
  const weakIds = new WeakMap();
  let state = {
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

  const prevMetaById = new Map();
  const stabilityById = new Map();
  const mutationStats = { added: 0, removed: 0, attributes: 0, text: 0, lastAt: Date.now() };
  let lastDelta = {
    at: new Date().toISOString(),
    reason: 'init',
    counts: { added: 0, removed: 0, changed: 0 },
    mutationTotals: { added: 0, removed: 0, attributes: 0, text: 0 },
    samples: []
  };
  let pendingInteraction = null;
  let lastTelemetryAt = 0;
  const OWN_ATTRS = new Set([ITEM_ATTR, REX_ID_ATTR, META_ATTR, ROOT_ATTR]);

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const sanitize = (v, max = 180) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return r.bottom >= 0 && r.right >= 0 && r.top <= window.innerHeight;
  };

  const textOf = (el) => sanitize(
    el.innerText ||
    el.textContent ||
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('placeholder') ||
    ''
  , 120);

  const roleOf = (el) => sanitize(el.getAttribute('role') || '', 40);

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
    if (el.hasAttribute(REX_ID_ATTR)) return el.getAttribute(REX_ID_ATTR);
    if (el.hasAttribute(ITEM_ATTR)) return el.getAttribute(ITEM_ATTR);
    if (weakIds.has(el)) return weakIds.get(el);
    counter += 1;
    const id = String(counter);
    weakIds.set(el, id);
    return id;
  };

  const getSectionAnchor = (el) => {
    const region = el.closest('section, article, main, nav, aside, form, dialog, [role="dialog"], [role="form"], [role="region"]');
    if (!region) return '';
    return sanitize(
      region.getAttribute('aria-label') ||
      region.getAttribute('title') ||
      region.id ||
      region.className ||
      textOf(region),
      100
    );
  };

  const getHeadingAnchor = (el) => {
    const nearestInRegion = el.closest('section, article, main, form, dialog')?.querySelector('h1,h2,h3,h4,h5,h6');
    if (nearestInRegion) return sanitize(nearestInRegion.textContent, 100);

    let node = el;
    while (node) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return sanitize(sib.textContent, 100);
        const nested = sib.querySelector?.('h1,h2,h3,h4,h5,h6');
        if (nested) return sanitize(nested.textContent, 100);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }

    const globalHeading = document.querySelector('h1,h2,h3');
    return globalHeading ? sanitize(globalHeading.textContent, 100) : '';
  };

  const getLabelText = (el) => {
    if (typeof el.labels !== 'undefined' && el.labels && el.labels.length) {
      return sanitize(Array.from(el.labels).map((x) => x.textContent || '').join(' '), 120);
    }
    const id = el.getAttribute('id');
    if (id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (byFor) return sanitize(byFor.textContent, 120);
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return sanitize(parentLabel.textContent, 120);
    return '';
  };

  const inferFormIntent = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag)) return { primary: '', tags: [] };

    const type = sanitize(el.getAttribute('type') || '', 30).toLowerCase();
    const name = sanitize(el.getAttribute('name') || '', 120).toLowerCase();
    const id = sanitize(el.getAttribute('id') || '', 120).toLowerCase();
    const placeholder = sanitize(el.getAttribute('placeholder') || '', 120).toLowerCase();
    const label = getLabelText(el).toLowerCase();
    const autocomplete = sanitize(el.getAttribute('autocomplete') || '', 80).toLowerCase();
    const inputMode = sanitize(el.getAttribute('inputmode') || '', 40).toLowerCase();

    const bag = [type, name, id, placeholder, label, autocomplete, inputMode].join(' ');
    const tags = [];

    if (type === 'email' || /\bemail\b/.test(bag)) tags.push('email');
    if (type === 'password' || /\b(pass|password|otp|pin|2fa|code)\b/.test(bag)) tags.push('password');
    if (/\b(search|find|lookup|query|q)\b/.test(bag)) tags.push('search');
    if (/\b(address|street|city|state|zip|postal|country|shipping|billing)\b/.test(bag)) tags.push('address');
    if (/\b(phone|mobile|tel|contact)\b/.test(bag)) tags.push('phone');
    if (/\bname|first|last|full name\b/.test(bag)) tags.push('name');

    const unique = Array.from(new Set(tags));
    return {
      primary: unique[0] || '',
      tags: unique
    };
  };

  const getObstruction = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const z = Number.parseInt(style.zIndex, 10);
    const selfZ = Number.isFinite(z) ? z : 0;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
      return { blocked: false, by: '', byTag: '', byId: '', byClass: '', selfZ, blockerZ: 0 };
    }

    const samplePoints = [
      [centerX, centerY],
      [rect.left + 2, rect.top + 2],
      [rect.right - 2, rect.bottom - 2]
    ];

    for (const [x, y] of samplePoints) {
      const top = document.elementFromPoint(x, y);
      if (!top) continue;
      if (top === el || el.contains(top) || top.contains(el)) continue;

      const blockerStyle = window.getComputedStyle(top);
      const blockerZ = Number.parseInt(blockerStyle.zIndex, 10);
      return {
        blocked: true,
        by: sanitize(top.getAttribute('aria-label') || top.id || top.className || textOf(top), 120),
        byTag: (top.tagName || '').toLowerCase(),
        byId: sanitize(top.id || '', 80),
        byClass: sanitize(top.className || '', 120),
        selfZ,
        blockerZ: Number.isFinite(blockerZ) ? blockerZ : 0
      };
    }

    return { blocked: false, by: '', byTag: '', byId: '', byClass: '', selfZ, blockerZ: 0 };
  };

  const actionTagsOf = (meta) => {
    const tags = [];
    const t = String(meta.tag || '').toLowerCase();
    const r = String(meta.role || '').toLowerCase();
    const href = String(meta.href || '');

    if (t === 'a' || r === 'link' || href) tags.push('navigate');
    if (t === 'button' || r === 'button' || t === 'a') tags.push('click');
    if (['input', 'textarea', 'select'].includes(t)) tags.push('type');
    if (t || r) tags.push('hover');
    return Array.from(new Set(tags));
  };

  const confidenceOf = (meta) => {
    let c = 20;
    c += clamp(Number(meta.score || 0), 0, 50);
    if (meta.text) c += 10;
    if (meta.anchorHeading || meta.anchorSection) c += 8;
    if (meta.label) c += 8;
    if (meta.formIntent?.primary) c += 8;
    if (meta.obstruction?.blocked) c -= 44;
    return clamp(Math.round(c), 0, 100);
  };

  const updateStability = (meta, seenAt, cycle) => {
    if (!state.enableTemporalStability) {
      return { sightings: 1, consecutiveSeen: 1, stabilityScore: 45, seenAt };
    }

    const id = String(meta.id || '');
    const prev = stabilityById.get(id) || {
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      sightings: 0,
      consecutiveSeen: 0,
      lastCycleSeen: cycle
    };

    const gap = cycle - Number(prev.lastCycleSeen || cycle);
    const consecutiveSeen = gap <= 1 ? Number(prev.consecutiveSeen || 0) + 1 : 1;
    const sightings = Number(prev.sightings || 0) + 1;
    const lifetimeMs = Math.max(1, seenAt - Number(prev.firstSeenAt || seenAt));
    const sightingRate = sightings / Math.max(1, lifetimeMs / 1000);

    const stabilityScore = clamp(
      Math.round(18 + Math.min(42, sightings * 6) + Math.min(30, consecutiveSeen * 5) + Math.min(10, sightingRate * 5)),
      0,
      100
    );

    const next = {
      firstSeenAt: Number(prev.firstSeenAt || seenAt),
      lastSeenAt: seenAt,
      sightings,
      consecutiveSeen,
      lastCycleSeen: cycle,
      stabilityScore
    };
    stabilityById.set(id, next);

    return {
      sightings,
      consecutiveSeen,
      stabilityScore,
      seenAt: new Date(seenAt).toISOString()
    };
  };

  const buildActionLanes = (ranked) => {
    const lanes = {
      click: [],
      type: [],
      navigate: [],
      hover: []
    };

    for (const item of ranked) {
      for (const tag of item.actionTags || []) {
        if (!lanes[tag]) continue;
        if (lanes[tag].length >= 10) continue;
        lanes[tag].push(item);
      }
    }

    return lanes;
  };

  const buildRiskProfile = (annotated, obstructionMap) => {
    const total = Math.max(1, annotated.length);
    const blockedRatio = Number((obstructionMap.length / total).toFixed(3));
    const volatility = Number((
      (Number(lastDelta.counts?.added || 0)
        + Number(lastDelta.counts?.removed || 0)
        + Number(lastDelta.counts?.changed || 0)) / total
    ).toFixed(3));

    let level = 'low';
    if (blockedRatio >= 0.28 || volatility >= 0.62) level = 'high';
    else if (blockedRatio >= 0.12 || volatility >= 0.34) level = 'medium';

    return {
      level,
      blockedRatio,
      volatility,
      totalInteractables: annotated.length,
      blockedInteractables: obstructionMap.length
    };
  };

  const makeMeta = (el) => {
    const intent = state.enableFormIntent ? inferFormIntent(el) : { primary: '', tags: [] };
    const obstruction = state.enableObstructionMap ? getObstruction(el) : { blocked: false };
    const headingAnchor = state.enableAnchors ? getHeadingAnchor(el) : '';
    const sectionAnchor = state.enableAnchors ? getSectionAnchor(el) : '';

    const meta = {
      id: idFor(el),
      tag: el.tagName.toLowerCase(),
      text: textOf(el),
      role: roleOf(el),
      href: sanitize(el.getAttribute('href') || '', 220),
      placeholder: sanitize(el.getAttribute('placeholder') || '', 120),
      score: score(el),
      anchorHeading: headingAnchor,
      anchorSection: sectionAnchor,
      label: getLabelText(el),
      formIntent: intent,
      obstruction
    };

    meta.actionTags = actionTagsOf(meta);
    meta.confidence = confidenceOf(meta);
    return meta;
  };

  const annotateOne = (el) => {
    const meta = makeMeta(el);
    const metaStr = JSON.stringify(meta);

    if (el.getAttribute(ITEM_ATTR) !== meta.id) {
      el.setAttribute(ITEM_ATTR, meta.id);
    }
    if (el.getAttribute(REX_ID_ATTR) !== meta.id) {
      el.setAttribute(REX_ID_ATTR, meta.id);
    }
    if (el.getAttribute(META_ATTR) !== metaStr) {
      el.setAttribute(META_ATTR, metaStr);
    }
    return meta;
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

  const computeDeltaFromSnapshot = (nextMetaById, reason) => {
    const added = [];
    const removed = [];
    const changed = [];

    for (const [id, nextMeta] of nextMetaById.entries()) {
      if (!prevMetaById.has(id)) {
        added.push({ id, tag: nextMeta.tag, text: nextMeta.text });
        continue;
      }
      const prevMeta = prevMetaById.get(id);
      const prevCompact = `${prevMeta.text}|${prevMeta.href}|${prevMeta.score}|${prevMeta.anchorHeading}|${prevMeta.anchorSection}|${prevMeta.obstruction?.blocked}`;
      const nextCompact = `${nextMeta.text}|${nextMeta.href}|${nextMeta.score}|${nextMeta.anchorHeading}|${nextMeta.anchorSection}|${nextMeta.obstruction?.blocked}`;
      if (prevCompact !== nextCompact) {
        changed.push({ id, tag: nextMeta.tag, text: nextMeta.text });
      }
    }

    for (const [id, prevMeta] of prevMetaById.entries()) {
      if (!nextMetaById.has(id)) {
        removed.push({ id, tag: prevMeta.tag, text: prevMeta.text });
      }
    }

    lastDelta = {
      at: new Date().toISOString(),
      reason,
      counts: {
        added: added.length,
        removed: removed.length,
        changed: changed.length
      },
      mutationTotals: {
        added: mutationStats.added,
        removed: mutationStats.removed,
        attributes: mutationStats.attributes,
        text: mutationStats.text
      },
      samples: [...added.slice(0, 4), ...changed.slice(0, 4), ...removed.slice(0, 4)].slice(0, 10)
    };

    window.__rexPreflightDelta = lastDelta;
  };

  const run = (reason = 'pulse') => {
    if (!state.enabled) return;

    run._cycle = Number(run._cycle || 0) + 1;
    const cycle = run._cycle;
    const now = Date.now();

    if (document.documentElement.getAttribute(ROOT_ATTR) !== '1') {
      document.documentElement.setAttribute(ROOT_ATTR, '1');
    }

    const nodes = Array.from(document.querySelectorAll(selectors));
    const annotated = [];
    const obstructionMap = [];
    const nextMetaById = new Map();

    for (const el of nodes) {
      if (!visible(el)) continue;
      const meta = annotateOne(el);
      meta.stability = updateStability(meta, now, cycle);
      annotated.push(meta);
      nextMetaById.set(meta.id, meta);

      if (meta.obstruction?.blocked) {
        obstructionMap.push({
          id: meta.id,
          tag: meta.tag,
          text: meta.text,
          obstruction: meta.obstruction
        });
      }
    }

    computeDeltaFromSnapshot(nextMetaById, reason);

    prevMetaById.clear();
    for (const [k, v] of nextMetaById.entries()) {
      prevMetaById.set(k, v);
    }

    window.__rexPreflightData = annotated;
    window.__rexPreflightObstructionMap = obstructionMap;
    window.__rexPreflightSnapshot = {
      version: PREFLIGHT_VERSION,
      at: new Date().toISOString(),
      total: annotated.length,
      blocked: obstructionMap.length,
      topBlocked: obstructionMap.slice(0, 30)
    };

    const ranked = annotated
      .map((m) => ({
        id: m.id,
        tag: m.tag,
        text: m.text,
        selector: m.id ? `[data-rex-id="${m.id}"], [data-rex-nav-id="${m.id}"]` : '',
        confidence: Number(m.confidence || 0),
        stability: Number(m.stability?.stabilityScore || 0),
        actionTags: Array.isArray(m.actionTags) ? m.actionTags : [],
        anchorHeading: m.anchorHeading || '',
        anchorSection: m.anchorSection || '',
        label: m.label || '',
        obstruction: m.obstruction || { blocked: false }
      }))
      .sort((a, b) => {
        const left = Number(a.confidence || 0) + Number(a.stability || 0) * 0.28;
        const right = Number(b.confidence || 0) + Number(b.stability || 0) * 0.28;
        return right - left;
      });

    const lanes = state.enableActionLanes ? buildActionLanes(ranked) : { click: [], type: [], navigate: [], hover: [] };
    const riskProfile = buildRiskProfile(annotated, obstructionMap);

    window.__rexPreflightVersion = PREFLIGHT_VERSION;
    window.__rexPreflightIntelV2 = {
      version: PREFLIGHT_VERSION,
      generatedAt: new Date().toISOString(),
      thresholds: {
        confidence: Number(state.confidenceThreshold || 62)
      },
      riskProfile,
      actionLanes: lanes,
      topCandidates: ranked.slice(0, 30),
      delta: lastDelta,
      mutationTotals: {
        added: mutationStats.added,
        removed: mutationStats.removed,
        attributes: mutationStats.attributes,
        text: mutationStats.text
      }
    };

    if (now - lastTelemetryAt > 4500) {
      lastTelemetryAt = now;
      chrome.runtime.sendMessage({
        type: 'preflight:recordTelemetry',
        value: {
          at: new Date(now).toISOString(),
          reason,
          version: PREFLIGHT_VERSION,
          riskLevel: riskProfile.level,
          blockedRatio: riskProfile.blockedRatio,
          volatility: riskProfile.volatility,
          total: annotated.length
        }
      }).catch(() => {});
    }

    const staleCutoffCycle = Math.max(1, cycle - 4);
    for (const [id, entry] of stabilityById.entries()) {
      if (Number(entry.lastCycleSeen || 0) < staleCutoffCycle) {
        stabilityById.delete(id);
      }
    }
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

  const finalizeInteractionDelta = () => {
    if (!pendingInteraction) return;
    const interaction = pendingInteraction;
    pendingInteraction = null;

    const current = {
      added: mutationStats.added,
      removed: mutationStats.removed,
      attributes: mutationStats.attributes,
      text: mutationStats.text
    };

    window.__rexPreflightInteractionDelta = {
      at: new Date().toISOString(),
      interaction,
      mutationDelta: {
        added: current.added - interaction.baseline.added,
        removed: current.removed - interaction.baseline.removed,
        attributes: current.attributes - interaction.baseline.attributes,
        text: current.text - interaction.baseline.text
      },
      snapshotDelta: lastDelta
    };
  };

  const markInteraction = (type, el) => {
    if (!state.enableMutationDelta) return;
    pendingInteraction = {
      type,
      id: el?.getAttribute?.(REX_ID_ATTR) || el?.getAttribute?.(ITEM_ATTR) || '',
      target: sanitize(textOf(el || document.body), 120),
      at: new Date().toISOString(),
      baseline: {
        added: mutationStats.added,
        removed: mutationStats.removed,
        attributes: mutationStats.attributes,
        text: mutationStats.text
      }
    };

    window.clearTimeout(markInteraction._t);
    markInteraction._t = window.setTimeout(finalizeInteractionDelta, 900);
  };

  const onClick = (ev) => {
    const target = ev.target?.closest?.(selectors);
    if (target) markInteraction('click', target);
  };

  const onInput = (ev) => {
    const target = ev.target;
    if (!target || !target.matches || !target.matches('input, textarea, select')) return;
    markInteraction('type', target);
  };

  const observer = new MutationObserver((records) => {
    let hasRelevantMutation = false;

    for (const rec of records) {
      if (rec.type === 'childList') {
        mutationStats.added += rec.addedNodes?.length || 0;
        mutationStats.removed += rec.removedNodes?.length || 0;
        hasRelevantMutation = hasRelevantMutation || (rec.addedNodes?.length || 0) > 0 || (rec.removedNodes?.length || 0) > 0;
      } else if (rec.type === 'attributes') {
        if (OWN_ATTRS.has(rec.attributeName || '')) continue;
        mutationStats.attributes += 1;
        hasRelevantMutation = true;
      } else if (rec.type === 'characterData') {
        mutationStats.text += 1;
        hasRelevantMutation = true;
      }
    }

    if (!hasRelevantMutation) return;
    mutationStats.lastAt = Date.now();

    window.clearTimeout(observer._t);
    observer._t = window.setTimeout(() => run('mutation'), 120);
  });

  const patchHistory = (method) => {
    const original = history[method];
    if (typeof original !== 'function') return;
    history[method] = function (...args) {
      const result = original.apply(this, args);
      window.setTimeout(() => run(`history:${method}`), 200);
      return result;
    };
  };
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('popstate', () => window.setTimeout(() => run('history:popstate'), 200));

  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);

  initState().then(() => {
    injectStyles();
    run('init');
    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const next = changes.preflightState?.newValue;
        if (!next || typeof next !== 'object') return;
        state = { ...state, ...next };
        run('config:update');
      });
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
    window.setInterval(() => run('pulse'), Math.max(600, Number(state.pulseMs || 1200)));
  });
})();
