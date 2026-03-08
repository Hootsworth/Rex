import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { spawn } from 'child_process';

const theme = gradient(['#00008b', '#00ffff']);

export async function sharePort(port) {
    const numericPort = Number.parseInt(String(port), 10);
    if (!Number.isFinite(numericPort) || numericPort <= 0) {
        p.log.error('Invalid port number.');
        return;
    }

    const s = p.spinner();
    s.start(`Creating tunnel for port ${pc.cyan(String(numericPort))}...`);

    try {
        const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${numericPort}`, '--no-autoupdate'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let started = false;
        const urlRegex = /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/;

        const onData = (chunk) => {
            const text = chunk.toString();
            const match = text.match(urlRegex);
            if (match && !started) {
                started = true;
                s.stop('Tunnel created successfully! 🚀');
                console.log('\n' + theme('--------------------------------------------------'));
                console.log(`  🌐 Public URL: ${pc.green(pc.bold(match[0]))}`);
                console.log(`  🏠 Local Port: ${pc.cyan(String(numericPort))}`);
                console.log(theme('--------------------------------------------------'));
                console.log(pc.dim('  Keep this window open to maintain the connection.'));
                console.log(pc.dim('  Press Ctrl+C to stop sharing.'));
                console.log('\n');
            }
        };

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);

        child.on('error', (err) => {
            if (!started) {
                s.stop(pc.red('Failed to create tunnel.'));
                if (err.code === 'ENOENT') {
                    p.log.error('cloudflared is not installed. Install it and retry "rexai share <port>".');
                } else {
                    p.log.error(err.message);
                }
            }
        });

        child.on('close', (code) => {
            if (!started) {
                s.stop(pc.red('Failed to create tunnel.'));
                p.log.error(`cloudflared exited before tunnel was created (code ${code}).`);
                return;
            }
            p.log.warn('Tunnel closed.');
        });

    } catch (err) {
        s.stop(pc.red('Failed to create tunnel.'));
        p.log.error(err.message);
    }
}
