import path from 'path';
import fs from 'fs';

/**
 * AutoPilot Routines — deterministic site-specific playbooks
 * that skip LLM calls for repetitive browser navigation steps.
 * 
 * Each routine is a simple array of Playwright steps.
 * After execution, Rex receives a structured summary of what happened.
 */

const BUILT_IN_ROUTINES = {
    'amazon': {
        match: /amazon\.(com|in|co\.uk|de|fr|es|it|ca|com\.au)/i,
        name: 'Amazon Search',
        steps: async (page, query) => {
            await page.goto('https://www.amazon.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);
            const searchBox = await page.$('#twotabsearchtextbox') || await page.$('input[name="field-keywords"]');
            if (searchBox) {
                await searchBox.fill(query);
                await page.keyboard.press('Enter');
                await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
                await page.waitForTimeout(1500);
                return `Navigated to Amazon and searched for "${query}". Results page is now loaded.`;
            }
            return `Navigated to Amazon but could not find search box. Rex should take over.`;
        }
    },

    'google': {
        match: /google\.(com|co\.\w+)/i,
        name: 'Google Search',
        steps: async (page, query) => {
            await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(800);
            const searchBox = await page.$('textarea[name="q"]') || await page.$('input[name="q"]');
            if (searchBox) {
                await searchBox.fill(query);
                await page.keyboard.press('Enter');
                await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
                await page.waitForTimeout(1500);
                return `Navigated to Google and searched for "${query}". Search results are now visible.`;
            }
            return `Navigated to Google but could not locate search input. Rex should take over.`;
        }
    },

    'github': {
        match: /github\.com/i,
        name: 'GitHub Navigate',
        steps: async (page, query) => {
            await page.goto(`https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);
            return `Navigated to GitHub search results for "${query}".`;
        }
    },

    'youtube': {
        match: /youtube\.com/i,
        name: 'YouTube Search',
        steps: async (page, query) => {
            await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);
            const searchBox = await page.$('input#search') || await page.$('input[name="search_query"]');
            if (searchBox) {
                await searchBox.fill(query);
                await page.keyboard.press('Enter');
                await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
                await page.waitForTimeout(1500);
                return `Navigated to YouTube and searched for "${query}". Video results are now visible.`;
            }
            return `Navigated to YouTube but could not find search box. Rex should take over.`;
        }
    },

    'duckduckgo': {
        match: /duckduckgo\.com/i,
        name: 'DuckDuckGo Search',
        steps: async (page, query) => {
            await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);
            return `Navigated to DuckDuckGo search results for "${query}".`;
        }
    }
};

/**
 * Loads user-defined custom routines from .agent/routines/<site>.json
 */
function loadCustomRoutines() {
    const routinesDir = path.join(process.cwd(), '.agent', 'routines');
    if (!fs.existsSync(routinesDir)) return {};

    const custom = {};
    try {
        const files = fs.readdirSync(routinesDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(routinesDir, file), 'utf-8'));
                const key = path.basename(file, '.json');
                custom[key] = {
                    match: new RegExp(data.urlPattern || key, 'i'),
                    name: data.name || key,
                    playwrightSteps: data.steps || [] // Array of {action, selector?, value?, timeout?}
                };
            } catch {}
        }
    } catch {}
    return custom;
}

/**
 * Tries to match and run a built-in or custom routine.
 * Returns { matched: true, result: "..." } or { matched: false }.
 */
export async function tryAutoPilotRoutine(page, goal) {
    if (!goal || !page) return { matched: false };

    // Extract search intent from goal
    const searchMatch = goal.match(/(?:search|find|look for|shop for|buy|get)\s+(?:for\s+)?['"]?(.+?)['"]?\s*(?:on|at|from)\s+(\w+)/i);
    const siteMatch = goal.match(/(?:open|go to|navigate to|visit)\s+(\S+)/i);

    let targetSite = '';
    let query = '';

    if (searchMatch) {
        query = searchMatch[1];
        targetSite = searchMatch[2];
    } else if (siteMatch) {
        targetSite = siteMatch[1];
        query = goal; // use whole goal as query fallback
    }

    if (!targetSite) return { matched: false };

    // Check built-in routines
    for (const [key, routine] of Object.entries(BUILT_IN_ROUTINES)) {
        if (routine.match.test(targetSite) || routine.match.test(goal)) {
            try {
                const result = await routine.steps(page, query || goal);
                return {
                    matched: true,
                    routineName: routine.name,
                    result
                };
            } catch (e) {
                return {
                    matched: true,
                    routineName: routine.name,
                    result: `AutoPilot routine "${routine.name}" failed: ${e.message}. Rex should take manual control.`
                };
            }
        }
    }

    // Check custom routines
    const custom = loadCustomRoutines();
    for (const [key, routine] of Object.entries(custom)) {
        if (routine.match.test(targetSite) || routine.match.test(goal)) {
            try {
                // Execute custom playwright step sequence
                for (const step of (routine.playwrightSteps || [])) {
                    const timeout = step.timeout || 5000;
                    if (step.action === 'goto') {
                        await page.goto(step.value, { waitUntil: 'domcontentloaded', timeout });
                    } else if (step.action === 'fill') {
                        await page.fill(step.selector, step.value || query, { timeout });
                    } else if (step.action === 'click') {
                        await page.click(step.selector, { timeout });
                    } else if (step.action === 'press') {
                        await page.keyboard.press(step.value || 'Enter');
                    } else if (step.action === 'wait') {
                        await page.waitForTimeout(step.value || 1000);
                    }
                }
                return {
                    matched: true,
                    routineName: routine.name,
                    result: `Custom AutoPilot routine "${routine.name}" completed. Page is ready for Rex.`
                };
            } catch (e) {
                return {
                    matched: true,
                    routineName: routine.name,
                    result: `Custom routine "${routine.name}" failed: ${e.message}. Rex should take manual control.`
                };
            }
        }
    }

    return { matched: false };
}
