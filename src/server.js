import http from 'http';
import pc from 'picocolors';
import { runCompletion } from './ai.js';
import { util } from 'util';
import { semanticSearch } from './memory.js';

export async function startProductionVisionServer(port = 31337) {
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/webhook') {
            let body = '';
            
            req.on('data', chunk => {
                body += chunk.toString();
            });

            req.on('end', async () => {
                try {
                    const payload = JSON.parse(body);
                    const errorMessage = payload.error || payload.message || payload.title || 'Unknown Error';
                    const stackTrace = payload.stack || payload.trace || payload.culprit || '';

                    console.log(`\n\${pc.bgRed(pc.white(' ALERT '))} \${pc.red('Production Vision caught an error webhook!')}`);
                    console.log(`\${pc.bold('Error:')} \${errorMessage}`);
                    if (stackTrace) {
                        console.log(`\${pc.dim(stackTrace.substring(0, 300))}...`);
                    }

                    // Attempt auto-healing reasoning
                    if (!global.productionVisionBusy) {
                        global.productionVisionBusy = true;
                        console.log(pc.yellow('Rex is analyzing the local codebase to find a fix...'));

                        // Semantic search against local files to find out where this error came from
                        const searchResult = await semanticSearch(`\${errorMessage} \n\n \${stackTrace}`);
                        
                        const systemPrompt = `You are Rex Production Vision. A live production error webhook just arrived. Here is the error:\n\nTitle: \${errorMessage}\nStack/Trace: \${stackTrace}\n\nHere are some potentially related files from local deep memory:\n\${searchResult}\n\nPropose a fix or a set of debugging steps to resolve this. Keep it concise.`;

                        const analysis = await runCompletion([{ role: 'system', content: systemPrompt }]);
                        console.log(`\n\${pc.green('Rex Diagnoses:')}\n\${analysis}\n`);

                        global.productionVisionBusy = false;
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'received', action: 'rex_analyzing' }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
                }
            });
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    return new Promise((resolve, reject) => {
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(pc.yellow(`Production Vision server is already running on port \${port}.`));
                resolve(null);
            } else {
                reject(err);
            }
        });

        server.listen(port, () => {
            console.log(pc.green(`🛡️ Production Vision server listening for webhooks on http://localhost:\${port}/webhook`));
            resolve(server);
        });
    });
}
