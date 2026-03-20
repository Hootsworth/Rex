import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { loadConfig } from './config.js';

function getAgentDir() {
    return path.join(process.cwd(), '.agent');
}

function getMemoryFile() {
    return path.join(getAgentDir(), 'memory.md');
}

/**
 * Ensures the .agent/ directory exists in the current project
 */
function ensureAgentDir() {
    const dir = getAgentDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Reads the persistent memory file for the current project
 * @returns {string} The memory contents or empty string
 */
export function readMemory() {
    try {
        const memFile = getMemoryFile();
        if (fs.existsSync(memFile)) {
            return fs.readFileSync(memFile, 'utf-8');
        }
        return '';
    } catch (e) {
        return '';
    }
}

/**
 * Appends a new fact/note to the persistent memory
 * @param {string} fact - The fact to remember
 * @returns {string} Confirmation message
 */
export function remember(fact) {
    try {
        ensureAgentDir();
        const memFile = getMemoryFile();
        const timestamp = new Date().toISOString().split('T')[0];
        const entry = `\n- [${timestamp}] ${fact}`;
        
        if (!fs.existsSync(memFile)) {
            fs.writeFileSync(memFile, `# 🧠 Rex Memory\n\nFacts Rex has learned about this project:\n${entry}\n`, 'utf-8');
        } else {
            fs.appendFileSync(memFile, entry + '\n', 'utf-8');
        }
        
        return `Remembered: "${fact}"`;
    } catch (e) {
        return `Failed to save memory: ${e.message}`;
    }
}

/**
 * Removes a fact from memory by keyword match
 * @param {string} keyword - Keyword to search for and remove
 * @returns {string} Confirmation message
 */
export function forget(keyword) {
    try {
        const memFile = getMemoryFile();
        if (!fs.existsSync(memFile)) {
            return 'No memories to forget.';
        }
        
        const content = fs.readFileSync(memFile, 'utf-8');
        const lines = content.split('\n');
        const filtered = lines.filter(line => !line.toLowerCase().includes(keyword.toLowerCase()));
        
        if (filtered.length === lines.length) {
            return `No memory matched "${keyword}".`;
        }
        
        fs.writeFileSync(memFile, filtered.join('\n'), 'utf-8');
        return `Forgot all memories matching "${keyword}".`;
    } catch (e) {
        return `Failed to forget: ${e.message}`;
    }
}

export function syncMemory(teamSecret = '') {
    try {
        const memFile = getMemoryFile();
        if (!fs.existsSync(memFile)) {
            return 'No local memory to sync.';
        }
        
        const rawContent = fs.readFileSync(memFile, 'utf-8');
        
        const secret = teamSecret || loadConfig().teamMemorySecret || 'default-rex-secret-key-32chars!!';
        const key = crypto.createHash('sha256').update(secret).digest();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        
        let encrypted = cipher.update(rawContent, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const payload = iv.toString('hex') + ':' + encrypted;
        
        const encFile = path.join(getAgentDir(), 'team_memory.enc');
        fs.writeFileSync(encFile, payload, 'utf-8');
        
        try {
            execSync(`git add "${encFile}"`, { stdio: 'ignore' });
            execSync(`git commit -m "chore(rex): sync team memory"`, { stdio: 'ignore' });
            execSync(`git push`, { stdio: 'ignore' });
        } catch (gitErr) {
            if (gitErr.message.includes('nothing to commit')) {
                return 'Memory is already up-to-date with remote (encrypted format generated).';
            } else if (gitErr.message.includes('not a git repository')) {
                return 'Encrypted memory saved locally, but this is not a git repository (could not push).';
            }
        }
        
        return 'Team memory encrypted and synced to remote repository successfully.';
    } catch (e) {
        return `Failed to sync memory: ${e.message}`;
    }
}

export function pullMemory(teamSecret = '') {
    try {
        const encFile = path.join(getAgentDir(), 'team_memory.enc');
        if (!fs.existsSync(encFile)) {
            return 'No synced team memory found.';
        }
        
        const payload = fs.readFileSync(encFile, 'utf-8');
        const [ivHex, encHex] = payload.split(':');
        if (!ivHex || !encHex) return 'Corrupted encrypted memory format.';
        
        const secret = teamSecret || loadConfig().teamMemorySecret || 'default-rex-secret-key-32chars!!';
        const key = crypto.createHash('sha256').update(secret).digest();
        const iv = Buffer.from(ivHex, 'hex');
        
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        fs.writeFileSync(getMemoryFile(), decrypted, 'utf-8');
        return 'Team memory pulled and decrypted successfully.';
    } catch (e) {
        return `Failed to pull memory (Bad secret or corrupted file): ${e.message}`;
    }
}
