import http from 'http';
import { keep_a_look } from '../src/webTools.js';

async function runTest() {
    console.log('🚀 Starting Keep-A-Look Verification Test...');
    let requestCount = 0;
    
    // 1. Create a local mock HTTP server that simulates ticket status changing
    const server = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        
        if (requestCount <= 2) {
            res.end(`
                <html>
                <body>
                    <h1>Movie Tickets</h1>
                    <div id="status">Supergirl Tickets: Status - COMING SOON</div>
                    <p>Tickets are not out yet. Check back later.</p>
                </body>
                </html>
            `);
        } else {
            res.end(`
                <html>
                <body>
                    <h1>Movie Tickets</h1>
                    <div id="status">Supergirl Tickets: Status - AVAILABLE NOW!</div>
                    <p>Tickets are finally out! <a href="/checkout">Book Tickets</a></p>
                </body>
                </html>
            `);
        }
    });

    server.listen(0, '127.0.0.1', async () => {
        const { port, address } = server.address();
        const testUrl = `http://${address}:${port}`;
        console.log(`Mock server listening at ${testUrl}`);

        try {
            // We set an abort controller to stop if it takes too long
            const controller = new AbortController();
            // We set an env variable to trigger mock agent mode in webTools
            process.env.KEEP_A_LOOK_TEST_MOCK = 'true';

            console.log('Running keep_a_look...');
            const result = await keep_a_look({
                url: testUrl,
                condition: 'tickets',
                action: 'mock-checkout-supergirl',
                intervalSeconds: 2, // fast checks for testing
                headless: true
            }, controller.signal);

            console.log('keep_a_look returned:', result);

            // Assertions
            if (requestCount >= 3) {
                console.log('✅ Keep-A-Look successfully detected difference and ran the checkout goal!');
            } else {
                throw new Error(`Test failed. requestCount=${requestCount}`);
            }
        } catch (err) {
            console.error('❌ Test failed with error:', err.message);
            process.exit(1);
        } finally {
            server.close();
            console.log('Mock server closed.');
            process.exit(0);
        }
    });
}

runTest();
