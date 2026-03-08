import { browser_interact, __test_parseFirstJsonObject } from '../src/webTools.js';

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function isHardRuntimeFailure(text) {
    return /^Browser Error:|^THREW:/i.test(String(text || ''));
}

async function safeCall(args) {
    try {
        return await browser_interact(args);
    } catch (err) {
        return `THREW: ${err.message}`;
    }
}

async function run() {
    const failures = [];
    console.log('Running browser regression tests...');

    // Test 1: malformed/mixed JSON parsing resilience
    try {
        const parsed = __test_parseFirstJsonObject('note before {"action":"search","query":"playwright"} trailing text');
        assert(parsed && parsed.action === 'search', 'JSON parser failed to extract valid object from mixed text.');

        const parsedNull = __test_parseFirstJsonObject('invalid {"action":"search"');
        assert(parsedNull === null, 'JSON parser should return null for incomplete payloads.');

        console.log('[PASS] JSON extraction robustness');
    } catch (err) {
        failures.push(`[FAIL] JSON extraction robustness: ${err.message}`);
    }

    // Test 2: placeholder domain refusal
    try {
        const res = await safeCall({ action: 'navigate', url: 'example.com' });
        assert(String(res).includes('placeholder domain'), 'Navigate should refuse placeholder domains.');
        console.log('[PASS] Placeholder domain blocked');
    } catch (err) {
        failures.push(`[FAIL] Placeholder domain blocked: ${err.message}`);
    }

    // Test 3: closed browser/tab recovery path for list_tabs
    try {
        await safeCall({ action: 'close_browser' });
        const tabs = await safeCall({ action: 'list_tabs' });
        assert(!isHardRuntimeFailure(tabs), `list_tabs produced runtime failure: ${tabs}`);
        assert(String(tabs).includes('0:'), `list_tabs did not return tab listing: ${tabs}`);
        console.log('[PASS] list_tabs recovers after close_browser');
    } catch (err) {
        failures.push(`[FAIL] list_tabs recovery: ${err.message}`);
    }

    // Test 4: about:blank / failed navigate recovery should not hard-crash
    try {
        await safeCall({ action: 'close_browser' });
        const navOut = await safeCall({ action: 'navigate', url: 'https://example.invalid' });
        assert(!isHardRuntimeFailure(navOut), `navigate hard-crashed on invalid host: ${navOut}`);

        const statusOut = await safeCall({ action: 'auth_state' });
        assert(!isHardRuntimeFailure(statusOut), `auth_state hard-crashed after failed navigation: ${statusOut}`);
        console.log('[PASS] Failed navigate path does not crash browser session');
    } catch (err) {
        failures.push(`[FAIL] Failed navigate crash safety: ${err.message}`);
    }

    // Test 5: actionable operations should auto-recover from about:blank
    try {
        await safeCall({ action: 'close_browser' });
        await safeCall({ action: 'new_tab' }); // Creates about:blank tab by default

        const evalOut = await safeCall({
            action: 'evaluate',
            code: 'window.location.href'
        });

        assert(!isHardRuntimeFailure(evalOut), `evaluate hard-crashed on about:blank recovery path: ${evalOut}`);
        assert(!String(evalOut).includes('about:blank"'), `evaluate remained on about:blank unexpectedly: ${evalOut}`);
        console.log('[PASS] about:blank auto-recovery for actionable commands');
    } catch (err) {
        failures.push(`[FAIL] about:blank auto-recovery: ${err.message}`);
    }

    // Test 6: Preflight Analyse should report health and heal blank page before risky action
    try {
        await safeCall({ action: 'close_browser' });
        await safeCall({ action: 'new_tab' }); // about:blank

        const preflightOut = await safeCall({
            action: 'preflight_analyse',
            targetAction: 'evaluate',
            autoHeal: true,
            query: 'playwright docs'
        });

        assert(!isHardRuntimeFailure(preflightOut), `Preflight Analyse hard-crashed: ${preflightOut}`);
        assert(String(preflightOut).includes('Preflight Analyse Report:'), `Preflight Analyse report missing: ${preflightOut}`);
        assert(!String(preflightOut).includes('"isBlank": true'), `Preflight Analyse did not heal blank context: ${preflightOut}`);
        console.log('[PASS] Preflight Analyse heals blank context and reports health');
    } catch (err) {
        failures.push(`[FAIL] Preflight Analyse behavior: ${err.message}`);
    }

    // Test 7: analyze_page scan should return structured interaction inventory
    try {
        const scanOut = await safeCall({ action: 'analyze_page' });
        assert(!isHardRuntimeFailure(scanOut), `analyze_page hard-crashed: ${scanOut}`);
        assert(String(scanOut).includes('Page Interaction Scan:'), `analyze_page output missing expected prefix: ${scanOut}`);
        console.log('[PASS] analyze_page returns structured scan output');
    } catch (err) {
        failures.push(`[FAIL] analyze_page output: ${err.message}`);
    }

    // Test 8: semantic click pathway should not hard-fail when selector is omitted
    try {
        const searchOut = await safeCall({ action: 'search', query: 'playwright github' });
        assert(!isHardRuntimeFailure(searchOut), `search hard-crashed before semantic click test: ${searchOut}`);

        const semanticClickOut = await safeCall({ action: 'click', text: 'GitHub', preferLinks: true });
        assert(!isHardRuntimeFailure(semanticClickOut), `semantic click hard-crashed: ${semanticClickOut}`);
        console.log('[PASS] semantic click path is runtime-safe');
    } catch (err) {
        failures.push(`[FAIL] semantic click path: ${err.message}`);
    }

    await safeCall({ action: 'close_browser' });

    if (failures.length > 0) {
        console.error('\nRegression test failures:');
        failures.forEach((f) => console.error(f));
        process.exit(1);
    }

    console.log('\nAll browser regression tests passed.');
}

run().catch((err) => {
    console.error('Regression suite crashed:', err);
    process.exit(1);
});
