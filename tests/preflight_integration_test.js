import { ensurePreflightVenv, runPreflightScan, getPreflightSpecJsonForUrl } from '../src/preflightDesigner.js';
import { browser_interact } from '../src/webTools.js';
import assert from 'assert';

async function runTest() {
    console.log('🧪 Starting Preflight Integration Test...');

    // 1. Ensure venv is set up
    const venv = await ensurePreflightVenv();
    assert.ok(venv.ok, 'Venv setup should succeed');
    console.log('✅ Venv Setup: PASS');

    // 2. Perform a preflight scan on https://httpbin.org
    console.log('⏳ Running preflight scan on httpbin.org...');
    const scanResult = await runPreflightScan('https://httpbin.org', { name: 'httpbin' });
    assert.ok(scanResult.ok, `Scan should succeed. Error: ${scanResult.error}`);
    console.log('✅ Preflight Scan: PASS');

    // 3. Verify spec mapping lookup
    const specInfo = await getPreflightSpecJsonForUrl('https://httpbin.org');
    assert.ok(specInfo, 'Spec info for httpbin.org should be found');
    console.log(`✅ Spec Lookup: PASS (Project ID: ${specInfo.projectId})`);

    console.log('🎉 Preflight Integration Test PASSED!');
}

runTest().catch((e) => {
    console.error('❌ Preflight Integration Test FAILED:', e);
    process.exit(1);
});
