import { spawn } from 'child_process';
import fs from 'fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';

// A list of dangerous commands or flags that Rex is NEVER allowed to run, even in Auto-Pilot
const DANGEROUS_COMMANDS = [
    /rm\s+-rf\s+\//i, // Root deletion
    /rm\s+-rf\s+\.\./i, // Upward deletion
    /mkfs/i, // Formatting disks
    /dd\s+if=/i, // Disk cloning
    />\s*\/dev\/(sda|hda|nvme)/i, // Writing directly to block devices
    /:\(\)\{ :\|:& \};:/i, // Fork bomb
    /chmod\s+-R\s+777\s+\//i, // Root permission wipe
    /chown\s+-R\s+.*:\s*\//i, // Root ownership wipe
    /remove-item\s+.*-recurse\s+.*-force\s+(c:|\\)/i, // PowerShell destructive delete at root
    /del\s+\/?[sqf]*\s+.*(c:\\|\\)/i, // CMD recursive delete at root-ish path
    /format\s+[a-z]:/i, // Windows volume format
    /net\s+user\s+.*\/add/i, // Creating users
    /net\s+localgroup\s+administrators\s+.*\/add/i, // Adding to admin group
    /sc\s+delete/i, // Deleting services
    /reg\s+delete/i, // Deleting registry keys
    /powershell.*-ExecutionPolicy\s+Bypass/i, // Bypassing execution policy
    /curl.*\|\s*sh/i, // Piping curl to sh (common malware vector)
    /wget.*\|\s*sh/i // Piping wget to sh
];

let safeMode = true; // Default to true for safety

export function setSafeMode(enabled) {
    safeMode = enabled;
}

const COMMAND_WHITELIST = [
    'ls', 'dir', 'cd', 'pwd', 'mkdir', 'touch', 'echo', 'git', 'npm', 'node', 'python', 'py', 'cat', 'type', 'grep', 'findstr', 'status', 'health', 'system'
];

function isCommandSafe(command) {
    for (const pattern of DANGEROUS_COMMANDS) {
        if (pattern.test(command)) return false;
    }

    if (safeMode) {
        const baseCommand = command.trim().split(' ')[0].toLowerCase();
        // Allow common safe commands and their variations (e.g., git status)
        if (!COMMAND_WHITELIST.includes(baseCommand)) {
            return { safe: false, reason: `SafeMode is ON. Command \`${baseCommand}\` is not in the whitelist.` };
        }
    }

    return { safe: true };
}

/**
 * Runs a shell command safely, capturing stdout and stderr via spawn.
 * Attempts to detect password prompts and alerts the user.
 */
export async function run_shell_command(command) {
    return new Promise((resolve) => {
        try {
            if (typeof command !== 'string' || !command.trim()) {
                return resolve('SECURITY EXCEPTION: Empty command blocked.');
            }

            const safety = isCommandSafe(command);
            if (!safety.safe) {
                return resolve(`SECURITY EXCEPTION: ${safety.reason || `Command matching blacklisted dangerous patterns blocked.`}`);
            }

            const shell = process.platform === 'win32'
                ? 'powershell.exe'
                : (process.platform === 'darwin' && fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
            const shellArgs = process.platform === 'win32' ? ['-Command', command] : ['-lc', command];
            
            const child = spawn(shell, shellArgs, { timeout: 120000 });
            
            let stdout = '';
            let stderr = '';
            let resolved = false;

            child.stdout.on('data', (data) => {
                stdout += data.toString();
                // Simple prompt detection
                if (data.toString().toLowerCase().includes('password') || data.toString().toLowerCase().includes('passphrase')) {
                    p.note(pc.yellow(`⚠️ Rex detected a password/passphrase prompt in the terminal.`), 'Rex Shell');
                    p.note(pc.dim(`Note: Rex cannot currently pipe passwords securely in non-TTY mode. Please try running this command manually or using a token-based auth.`), 'Suggestion');
                }
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    resolve(`Command error: ${err.message}`);
                }
            });

            child.on('close', (code) => {
                if (!resolved) {
                    resolved = true;
                    let result = '';
                    if (stdout) result += `STDOUT:\n${stdout}\n`;
                    if (stderr) result += `STDERR:\n${stderr}\n`;
                    
                    if (code !== 0) {
                        result = `Command failed with exit code ${code}.\n${result}`;
                    }
                    
                    if (!result) return resolve(`Command executed successfully with no output.`);
                    
                    if (result.length > 8000) {
                        result = `...[Logs truncated]...\n` + result.slice(-8000);
                    }
                    resolve(result.trim());
                }
            });

            // Set a fallback timeout just in case the spawn timeout fails
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    child.kill();
                    resolve(`Command timed out after 120s. This might be due to an interactive prompt Rex couldn't handle.`);
                }
            }, 125000);

        } catch (err) {
            resolve(`Shell Execution Exception: ${err.message}`);
        }
    });
}
