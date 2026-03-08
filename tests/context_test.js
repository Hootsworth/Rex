import { runCompletion } from '../src/ai.js';
import { loadConfig } from '../src/config.js';

async function testContext() {
    console.log('Starting Context Verification Test...');
    
    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'My secret code word is "PINEAPPLE". Remember this.' },
        { role: 'assistant', content: 'Got it! I will remember that your secret code word is "PINEAPPLE".' }
    ];

    // Simulate 10 turns of filler conversation
    for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `Filler message ${i}` });
        messages.push({ role: 'assistant', content: `Acknowledged filler ${i}` });
    }

    messages.push({ role: 'user', content: 'What was my secret code word?' });

    console.log(`Running completion with ${messages.length} messages...`);
    
    try {
        const response = await runCompletion(messages);
        console.log('\nAI Response:', response);
        
        if (response.toUpperCase().includes('PINEAPPLE')) {
            console.log('\n✅ TEST PASSED: AI remembered the secret word despite filler conversation.');
        } else {
            console.log('\n❌ TEST FAILED: AI forgot the secret word.');
        }
    } catch (err) {
        console.error('\n❌ TEST ERRORED:', err.message);
    }
}

testContext();
