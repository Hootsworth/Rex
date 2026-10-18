/**
 * obsidianVault.js — Obsidian & Local Markdown Notes Vault Integration for Rex
 *
 * Capabilities:
 * - Direct two-way sync with your local Obsidian vault or markdown notes directory
 * - Read, write, and search markdown notes
 * - Instant Daily Notes journaling (`YYYY-MM-DD.md`) with timestamps
 * - Launch notes directly inside Obsidian.app via macOS URI scheme
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import { loadConfig, saveConfig } from './config.js';

const execAsync = promisify(exec);

/**
 * Determine the active Obsidian vault directory
 */
export function getVaultPath() {
    const config = loadConfig();
    if (config.obsidianVaultPath && fs.existsSync(config.obsidianVaultPath)) {
        return config.obsidianVaultPath;
    }

    // Common standard default paths on macOS
    const candidates = [
        path.join(os.homedir(), 'Documents', 'Obsidian Vault'),
        path.join(os.homedir(), 'Documents', 'Obsidian'),
        path.join(os.homedir(), 'Obsidian'),
        path.join(os.homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
        path.join(process.cwd(), 'notes'),
        path.join(process.cwd(), '.rex', 'vault')
    ];

    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }

    // Default fallback: create .rex/vault
    const fallback = path.join(process.cwd(), '.rex', 'vault');
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return fallback;
}

/**
 * List or search notes in the vault
 */
export function listVaultNotes(query = '', subfolder = '') {
    const vault = getVaultPath();
    const targetDir = subfolder ? path.join(vault, subfolder) : vault;
    if (!fs.existsSync(targetDir)) return [];

    const cleanQuery = String(query || '').toLowerCase().trim();

    function scan(dir, relative = '') {
        let results = [];
        const items = fs.readdirSync(dir);
        for (const item of items) {
            if (item.startsWith('.')) continue; // ignore .obsidian etc.
            const full = path.join(dir, item);
            const rel = path.join(relative, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                results = results.concat(scan(full, rel));
            } else if (item.endsWith('.md')) {
                if (!cleanQuery || rel.toLowerCase().includes(cleanQuery)) {
                    results.push({ name: item.replace(/\.md$/, ''), path: rel, modified: stat.mtimeMs });
                }
            }
        }
        return results;
    }

    return scan(targetDir).sort((a, b) => b.modified - a.modified);
}

/**
 * Read content of a specific note
 */
export function readVaultNote(noteName, subfolder = '') {
    const vault = getVaultPath();
    const cleanName = noteName.endsWith('.md') ? noteName : `${noteName}.md`;
    const fullPath = subfolder ? path.join(vault, subfolder, cleanName) : path.join(vault, cleanName);

    if (!fs.existsSync(fullPath)) {
        // Try searching recursively
        const matches = listVaultNotes(noteName);
        if (matches.length > 0) {
            return fs.readFileSync(path.join(vault, matches[0].path), 'utf-8');
        }
        throw new Error(`Note "${noteName}" not found in vault (${vault}).`);
    }

    return fs.readFileSync(fullPath, 'utf-8');
}

/**
 * Write or overwrite a note
 */
export function writeVaultNote(noteName, content, subfolder = '') {
    const vault = getVaultPath();
    const cleanName = noteName.endsWith('.md') ? noteName : `${noteName}.md`;
    const targetDir = subfolder ? path.join(vault, subfolder) : vault;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const fullPath = path.join(targetDir, cleanName);
    fs.writeFileSync(fullPath, content, 'utf-8');
    return fullPath;
}

/**
 * Append content to a note with optional timestamp
 */
export function appendVaultNote(noteName, textToAppend, subfolder = '') {
    const vault = getVaultPath();
    const cleanName = noteName.endsWith('.md') ? noteName : `${noteName}.md`;
    const targetDir = subfolder ? path.join(vault, subfolder) : vault;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const fullPath = path.join(targetDir, cleanName);
    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : `# ${noteName.replace(/\.md$/, '')}\n\n`;

    const timeHeader = `\n\n### ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n`;
    const updated = existing.trimEnd() + timeHeader + textToAppend.trim() + '\n';
    fs.writeFileSync(fullPath, updated, 'utf-8');
    return fullPath;
}

/**
 * Append an entry to today's Daily Note (YYYY-MM-DD.md)
 */
export function appendDailyNote(entryText) {
    const today = new Date().toISOString().split('T')[0];
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formatted = `- **${timeStr}**: ${entryText.trim()}`;
    return appendVaultNote(today, formatted);
}

/**
 * Open the note in Obsidian desktop app using macOS URI
 */
export async function openInObsidianApp(noteName) {
    try {
        const cleanName = noteName.replace(/\.md$/, '');
        await execAsync(`open "obsidian://open?file=${encodeURIComponent(cleanName)}"`);
        return true;
    } catch {
        return false;
    }
}

/**
 * Discord command handler
 */
export async function tryHandleObsidianCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    // 1) Daily note: "rex daily note [content]" or "!daily [content]"
    const dailyMatch = text.match(/^(?:!daily|(?:rex\s+)?daily\s+note)\s+(.+)$/i);
    if (dailyMatch) {
        const entry = dailyMatch[1].trim();
        const fullPath = appendDailyNote(entry);
        await message.reply(`📓✨ **Added to Daily Note!**\n> "${entry}"\n*Saved to \`${path.basename(fullPath)}\`*`);
        return { handled: true };
    }

    // 2) Write note: "rex note [title] : [content]" or "!note [title] : [content]"
    const noteMatch = text.match(/^(?:!note|(?:rex\s+)?(?:create\s+note|save\s+note|new\s+note|note))\s+([^:]+?)\s*:\s*(.+)$/i);
    if (noteMatch) {
        const title = noteMatch[1].trim();
        const content = noteMatch[2].trim();
        writeVaultNote(title, content);
        await message.reply(`📓 **Note Saved in Vault**: \`${title}.md\`\n\`\`\`markdown\n${content.slice(0, 500)}\n\`\`\``);
        return { handled: true };
    }

    // 3) Read note: "rex read note [title]"
    const readMatch = text.match(/^(?:rex\s+)?read\s+note\s+(.+)$/i);
    if (readMatch) {
        const title = readMatch[1].trim();
        try {
            const content = readVaultNote(title);
            await message.reply(`📓 **${title}**:\n\`\`\`markdown\n${content.slice(0, 1800)}\n\`\`\``);
        } catch (e) {
            await message.reply(`❌ ${e.message}`);
        }
        return { handled: true };
    }

    // 4) List notes: "rex notes", "!notes", "rex search notes [query]"
    if (/^(?:!notes\b|(?:rex\s+)?(?:list\s+notes|search\s+notes|notes)\b)/i.test(text)) {
        const qMatch = text.match(/(?:search\s+notes|find\s+notes)\s+(.+)$/i);
        const query = qMatch ? qMatch[1].trim() : '';
        const notes = listVaultNotes(query);

        if (notes.length === 0) {
            await message.reply(`No notes found in vault matching "${query}". Vault path: \`${getVaultPath()}\``);
        } else {
            const listPreview = notes.slice(0, 15).map((n, i) => `${i + 1}. **${n.name}** (\`${n.path}\`)`).join('\n');
            await message.reply(`📓📁 **Obsidian Notes (${notes.length})**:\n${listPreview}\n\n*Vault: \`${getVaultPath()}\`*`);
        }
        return { handled: true };
    }

    // 5) Configure vault path: "rex set vault [path]"
    const setVaultMatch = text.match(/^(?:rex\s+)?set\s+vault\s+(.+)$/i);
    if (setVaultMatch) {
        const newPath = setVaultMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (!fs.existsSync(newPath)) {
            await message.reply(`Directory does not exist: \`${newPath}\`. Please provide a valid folder path.`);
            return { handled: true };
        }
        const cfg = loadConfig();
        cfg.obsidianVaultPath = path.resolve(newPath);
        saveConfig(cfg);
        await message.reply(`✅ Obsidian vault path updated to: \`${cfg.obsidianVaultPath}\``);
        return { handled: true };
    }

    return { handled: false };
}
