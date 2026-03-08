import fs from 'fs';
import path from 'path';

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
