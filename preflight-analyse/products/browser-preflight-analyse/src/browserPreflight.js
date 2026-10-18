function isBlankUrl(url = '') {
  const value = String(url || '').trim().toLowerCase();
  return !value || value === 'about:blank';
}

export async function collectBrowserHealth(page, manager) {
  const safePages = (manager?.pages || []).filter((p) => p && !p.isClosed());
  const currentUrl = page.url() || '';
  const title = await page.title().catch(() => 'Unknown');
  const activeTab = Math.max(0, Number(manager?.currentPageIndex || 0));
  const tabCount = safePages.length;

  const interactiveCount = await page
    .evaluate(() => {
      const selectors = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [aria-haspopup], [onclick]';
      const nodes = Array.from(document.querySelectorAll(selectors));
      return nodes.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).length;
    })
    .catch(() => 0);

  return {
    url: currentUrl,
    title,
    isBlank: isBlankUrl(currentUrl),
    tabCount,
    activeTab,
    lastHealthyUrl: manager?.lastHealthyUrl || '',
    interactiveCount
  };
}

export async function collectPreflightExtensionIntel(page) {
  return await page
    .evaluate(() => {
      const intel = window.__rexPreflightIntelV2 && typeof window.__rexPreflightIntelV2 === 'object' ? window.__rexPreflightIntelV2 : null;
      const snapshot = window.__rexPreflightSnapshot && typeof window.__rexPreflightSnapshot === 'object' ? window.__rexPreflightSnapshot : null;

      if (!intel && !snapshot) {
        return {
          available: false,
          version: '',
          riskLevel: 'unknown',
          blockedRatio: 0,
          volatility: 0,
          topCandidates: []
        };
      }

      const fallbackTotal = Number(snapshot?.total || 0);
      const fallbackBlocked = Number(snapshot?.blocked || 0);
      const fallbackRatio = fallbackTotal > 0 ? fallbackBlocked / fallbackTotal : 0;

      return {
        available: true,
        version: String(intel?.version || snapshot?.version || window.__rexPreflightVersion || ''),
        generatedAt: String(intel?.generatedAt || snapshot?.at || ''),
        riskLevel: String(intel?.riskProfile?.level || 'unknown'),
        blockedRatio: Number(intel?.riskProfile?.blockedRatio ?? fallbackRatio ?? 0),
        volatility: Number(intel?.riskProfile?.volatility ?? 0),
        blockedInteractables: Number(intel?.riskProfile?.blockedInteractables ?? fallbackBlocked ?? 0),
        totalInteractables: Number(intel?.riskProfile?.totalInteractables ?? fallbackTotal ?? 0),
        topCandidates: Array.isArray(intel?.topCandidates) ? intel.topCandidates.slice(0, 10) : [],
        lanes: intel?.actionLanes && typeof intel.actionLanes === 'object' ? intel.actionLanes : null,
        delta: intel?.delta && typeof intel.delta === 'object' ? intel.delta : null
      };
    })
    .catch(() => ({
      available: false,
      version: '',
      riskLevel: 'unknown',
      blockedRatio: 0,
      volatility: 0,
      topCandidates: []
    }));
}

export function preflightRecommendation(health, targetAction, readiness, extensionIntel = null) {
  const actions = [];
  let riskScore = 14;

  if (!readiness.ok) {
    riskScore += 42;
    actions.push('run auto-heal and reconfirm actionable state');
  }

  if (health.isBlank) {
    riskScore += 50;
    actions.push('recover from about:blank using last healthy URL or resilient search');
  }

  const risky = new Set(['click', 'type', 'hover', 'evaluate']);
  if (risky.has(targetAction) && health.interactiveCount === 0) {
    riskScore += 28;
    actions.push('run analyze_page before risky interaction');
  }

  if (extensionIntel?.available) {
    if (Number(extensionIntel.blockedRatio || 0) >= 0.25) {
      riskScore += 26;
      actions.push('handle overlays/popups before continuing');
    }
    if (Number(extensionIntel.volatility || 0) >= 0.55) {
      riskScore += 18;
      actions.push('wait briefly for DOM to stabilize before interacting');
    }
    if (Array.isArray(extensionIntel.topCandidates) && extensionIntel.topCandidates.length === 0 && risky.has(targetAction)) {
      riskScore += 10;
      actions.push('re-scan action lanes to avoid stale selectors');
    }
  }

  if (!actions.length) actions.push('continue with selected action');

  let level = 'low';
  let next = targetAction || 'continue';
  let reason = 'Browser context appears healthy.';

  if (riskScore >= 75) {
    level = 'high';
    next = 'search';
    reason = readiness.error || 'High-risk browser state detected.';
  } else if (riskScore >= 42) {
    level = 'medium';
    next = targetAction || 'refresh';
    reason = readiness.error || 'Moderate risk detected; pre-action hardening recommended.';
  }

  return {
    version: '2.0.0',
    score: Math.max(0, Math.min(100, Math.round(riskScore))),
    level,
    next,
    reason,
    actions
  };
}

export function preflightRecommendationLegacy(health, targetAction, readiness) {
  if (!readiness.ok) {
    return { level: 'high', next: 'search', reason: readiness.error || 'Page not actionable.' };
  }
  if (health.isBlank) {
    return { level: 'high', next: 'search', reason: 'Current tab is about:blank.' };
  }

  const risky = new Set(['click', 'type', 'hover', 'evaluate']);
  if (risky.has(targetAction) && health.interactiveCount === 0) {
    return { level: 'medium', next: 'refresh', reason: 'No visible interactive elements on page.' };
  }

  return { level: 'low', next: targetAction || 'continue', reason: 'Browser context appears healthy.' };
}
