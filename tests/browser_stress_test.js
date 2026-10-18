import { browser_interact } from '../src/webTools.js';

function logStep(label, value) {
    console.log(`\n[${label}]`);
    console.log(value);
}

async function safeCall(args) {
    try {
        return await browser_interact(args);
    } catch (err) {
        return `THREW: ${err.message}`;
    }
}

async function runStressPass() {
    console.log('Starting Browser Stress Pass...');

    const failures = [];

    const searchQueries = [
        'OpenAI API pricing',
        'Node.js fs promises docs',
        'playwright waitForLoadState'
    ];

    const navTargets = [
        'https://www.google.com',
        'https://news.ycombinator.com',
        'https://developer.mozilla.org',
        'https://github.com'
    ];

    // Phase 1: repeated searches
    for (const query of searchQueries) {
        const out = await safeCall({ action: 'search', query });
        logStep(`search:${query}`, out);
        if (/^Error:|^Browser Error:|THREW:/i.test(String(out))) {
            failures.push({ phase: 'search', query, out });
        }
    }

    // Phase 2: open tabs + direct navigation attempts (including Google)
    for (const url of navTargets) {
        const out = await safeCall({ action: 'new_tab', url });
        logStep(`new_tab:${url}`, out);
        if (/^Error:|^Browser Error:|THREW:/i.test(String(out))) {
            failures.push({ phase: 'new_tab', url, out });
        }

        const state = await safeCall({ action: 'auth_state' });
        logStep(`auth_state:${url}`, state);
    }

    // Phase 3: switch across tabs repeatedly
    const tabsRaw = await safeCall({ action: 'list_tabs' });
    logStep('list_tabs:initial', tabsRaw);

    const tabCount = String(tabsRaw)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .length;

    for (let cycle = 0; cycle < 2; cycle++) {
        for (let i = 0; i < tabCount; i++) {
            const out = await safeCall({ action: 'switch_tab', tabIndex: i });
            logStep(`switch_tab:${cycle}:${i}`, out);
            if (/^Error:|^Browser Error:|THREW:/i.test(String(out))) {
                failures.push({ phase: 'switch_tab', tabIndex: i, out });
                continue;
            }

            const evalOut = await safeCall({
                action: 'evaluate',
                code: `({ url: window.location.href, title: document.title, bodyChars: (document.body?.innerText || '').length })`
            });
            logStep(`evaluate:${cycle}:${i}`, evalOut);

            const evalText = String(evalOut);
            const recoveredFromBlank = /Recovered from about:blank using/i.test(evalText);
            if (/about:blank/i.test(evalText) && !recoveredFromBlank) {
                failures.push({ phase: 'blank_page', tabIndex: i, out: evalOut });
            }
        }
    }

    // Phase 4: refresh + popup handling on active tab
    const refreshOut = await safeCall({ action: 'refresh' });
    logStep('refresh', refreshOut);
    if (/^Error:|^Browser Error:|THREW:/i.test(String(refreshOut))) {
        failures.push({ phase: 'refresh', out: refreshOut });
    }

    const popupOut = await safeCall({ action: 'handle_popups', preferReject: true, maxClicks: 3 });
    logStep('handle_popups', popupOut);
    if (/^Error:|^Browser Error:|THREW:/i.test(String(popupOut))) {
        failures.push({ phase: 'handle_popups', out: popupOut });
    }

    const finalTabs = await safeCall({ action: 'list_tabs' });
    logStep('list_tabs:final', finalTabs);

    await safeCall({ action: 'close_browser' });

    if (failures.length === 0) {
        console.log('\nSTRESS PASS RESULT: PASS (no failures detected)');
    } else {
        console.log(`\nSTRESS PASS RESULT: FAIL (${failures.length} issue(s))`);
        for (const f of failures) {
            console.log(JSON.stringify(f));
        }
        process.exitCode = 1;
    }
}

runStressPass().catch((err) => {
    console.error('STRESS PASS CRASHED:', err);
    process.exit(1);
});
