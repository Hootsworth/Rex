import { exec } from 'child_process';
import { spawn } from 'child_process';
import util from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const execPromise = util.promisify(exec);

async function runCommandWithInput(command, args, inputText) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', reject);

        child.on('close', (code) => {
            if (code === 0) return resolve();
            reject(new Error(stderr || `${command} failed with exit code ${code}`));
        });

        child.stdin.end(inputText ?? '');
    });
}

export async function getClipboard() {
    try {
        let cmd = '';
        if (process.platform === 'win32') {
            cmd = 'powershell -Command "Get-Clipboard"';
        } else if (process.platform === 'darwin') {
            cmd = 'pbpaste';
        } else {
            cmd = 'xclip -selection clipboard -o';
        }

        const { stdout } = await execPromise(cmd);
        return stdout.trim();
    } catch (err) {
        p.log.error(`Failed to read clipboard: ${err.message}`);
        return '';
    }
}

export async function setClipboard(text) {
    try {
        if (process.platform === 'win32') {
            // Need to escape single quotes for PowerShell
            const escaped = text.replace(/'/g, "''");
            const cmd = `powershell -Command "Set-Clipboard -Value '${escaped}'"`;
            await execPromise(cmd);
        } else if (process.platform === 'darwin') {
            await runCommandWithInput('pbcopy', [], text);
        } else {
            await runCommandWithInput('xclip', ['-selection', 'clipboard'], text);
        }

        p.log.success('Text copied to clipboard.');
    } catch (err) {
        p.log.error(`Failed to set clipboard: ${err.message}`);
    }
}

export async function clipboardMenu() {
    const choice = await p.select({
        message: 'Clipboard Manager:',
        options: [
            { value: 'read', label: '📋 Read Clipboard' },
            { value: 'write', label: '✍️ Write to Clipboard' },
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(choice) || choice === 'back') return;

    if (choice === 'read') {
        const text = await getClipboard();
        p.note(text || pc.dim('(Empty)'), 'Clipboard Content');
    }
    if (choice === 'write') {
        const text = await p.text({ message: 'Enter text to copy:', placeholder: 'Hello from Rex!' });
        if (!p.isCancel(text)) await setClipboard(text);
    }
}
