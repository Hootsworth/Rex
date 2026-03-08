import { browser_interact } from '../src/webTools.js';

async function testBrowser() {
    console.log('Starting Browser Sequence Verification Test...');

    try {
        // 1. Test Action Chaining (Sequence)
        console.log('\n--- Step 1: Action Chaining (Navigate + New Tab) ---');
        const res = await browser_interact({
            actions: [
                { action: 'search', query: 'latest JavaScript release notes' },
                { action: 'new_tab', url: 'https://www.wikipedia.org' }
            ]
        });
        console.log(res);

        // 2. Verify Tab List
        const res2 = await browser_interact({ action: 'list_tabs' });
        console.log('\nTab List:\n' + res2);

        // 3. Popup and auth helpers
        const popupRes = await browser_interact({ action: 'handle_popups', preferReject: true, maxClicks: 2 });
        console.log('\nPopup Handler:\n' + popupRes);

        const authRes = await browser_interact({ action: 'auth_state' });
        console.log('\nAuth State:\n' + authRes);

        // 4. Cleanup
        await browser_interact({ action: 'close_browser' });
        console.log('\nCleanup: Browser closed.');

        console.log('\n✅ BROWSER SEQUENCE TEST PASSED');
    } catch (err) {
        console.error('\n❌ BROWSER TEST ERRORED:', err.message);
    }
}

testBrowser();
