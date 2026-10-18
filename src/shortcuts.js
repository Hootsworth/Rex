/**
 * shortcuts.js — Native macOS Shortcuts Engine Integration for Rex
 *
 * Capabilities:
 * - Lists all installed macOS Shortcuts via `/usr/bin/shortcuts list`
 * - Runs any Shortcut with optional text/file input parameters
 * - Triggers actions in third-party apps (WhatsApp, Things 3, Bear, Raycast, etc.)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';

const execAsync = promisify(exec);

/**
 * List all installed Shortcuts on the user's Mac
 * @returns {Promise<string[]>} Array of shortcut names
 */
export async function listShortcuts() {
    try {
        const { stdout } = await execAsync('/usr/bin/shortcuts list');
        return stdout
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
    } catch (e) {
        throw new Error(`Failed to list macOS shortcuts: ${e.message}`);
    }
}

/**
 * Run a specific macOS Shortcut by name
 * @param {string} shortcutName - Name of the shortcut
 * @param {string} [input] - Optional input string passed to the shortcut
 * @returns {Promise<string>}
 */
export async function runShortcut(shortcutName, input = '') {
    const cleanName = String(shortcutName || '').trim();
    if (!cleanName) throw new Error('Shortcut name is required.');

    const cleanInput = String(input || '').trim();
    let cmd = `/usr/bin/shortcuts run "${cleanName.replace(/"/g, '\\"')}"`;

    if (cleanInput) {
        cmd += ` -i "${cleanInput.replace(/"/g, '\\"')}"`;
    }

    try {
        const { stdout, stderr } = await execAsync(cmd, { timeout: 25000 });
        return stdout.trim() || stderr.trim() || `Shortcut "${cleanName}" executed successfully.`;
    } catch (e) {
        throw new Error(`Execution error for shortcut "${cleanName}": ${e.message}`);
    }
}

/**
 * Command handler for Discord
 */
export async function tryHandleShortcutsCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    // 1) List Shortcuts: "rex shortcuts", "!shortcuts", "list shortcuts"
    if (/^(?:!shortcuts\b|(?:rex\s+)?(?:shortcuts\s+list|list\s+shortcuts|show\s+shortcuts|shortcuts)\b)$/i.test(text)) {
        await message.channel.sendTyping().catch(() => {});
        try {
            const list = await listShortcuts();
            if (list.length === 0) {
                await message.reply("No Shortcuts found on your Mac. You can create them in the macOS Shortcuts app!");
            } else {
                const preview = list.slice(0, 20).map((s, i) => `${i + 1}. **${s}**`).join('\n');
                await message.reply(`⚡🍎 **Installed macOS Shortcuts (${list.length})**:\n${preview}\n\n*Run any with: \`rex run shortcut <name>\`*`);
            }
        } catch (e) {
            await message.reply(`❌ Failed to query shortcuts: ${e.message}`);
        }
        return { handled: true };
    }

    // 2) Run Shortcut: "rex run shortcut [name] : [input]" or "!shortcut [name]"
    const runMatch = text.match(/^(?:!shortcut|(?:rex\s+)?run\s+shortcut)\s+([^:]+?)(?:\s*:\s*(.+))?$/i);
    if (runMatch) {
        const name = runMatch[1].trim();
        const input = runMatch[2] ? runMatch[2].trim() : '';

        await message.channel.sendTyping().catch(() => {});
        try {
            const output = await runShortcut(name, input);
            await message.reply(`⚡ **Shortcut Executed**: \`${name}\`\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\``);
        } catch (e) {
            await message.reply(`❌ Shortcut failed: ${e.message}`);
        }
        return { handled: true };
    }

    return { handled: false };
}
