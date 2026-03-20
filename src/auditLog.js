import fs from 'fs';
import path from 'path';

const AGENT_DIR = path.join(process.cwd(), '.agent');
const AUDIT_FILE = path.join(AGENT_DIR, 'audit.log');
const AUTOPILOT_HISTORY_FILE = path.join(AGENT_DIR, 'autopilot-history.log');
const AUTOPILOT_MAX_ENTRIES = 50;

function ensureAgentDir() {
    if (!fs.existsSync(AGENT_DIR)) {
        fs.mkdirSync(AGENT_DIR, { recursive: true });
    }
}

function parseLastVersion(lines) {
    if (!lines.length) return 0;
    const last = String(lines[lines.length - 1] || '');
    const match = last.match(/^v(\d+)\s*\|/);
    return match ? Number(match[1]) : 0;
}

/**
 * Logs a tool call to .agent/audit.log
 * @param {string} toolName - Name of the tool executed
 * @param {object} args - Arguments passed
 * @param {string} result - Truncated result of execution
 * @param {string} status - 'success' | 'error' | 'cancelled'
 */
export function logToolCall(toolName, args, result, status = 'success') {
    try {
        ensureAgentDir();

        const timestamp = new Date().toISOString();
        const argsStr = JSON.stringify(args || {}).substring(0, 200);
        const resultStr = (result || '').substring(0, 300).replace(/\n/g, ' ');
        const entry = `[${timestamp}] [${status.toUpperCase()}] ${toolName} | Args: ${argsStr} | Result: ${resultStr}\n`;
        
        fs.appendFileSync(AUDIT_FILE, entry, 'utf-8');
    } catch (e) {
        // Silently fail — audit logging should never break the agent
    }
}

/**
 * Stores Auto-Pilot status history as versioned entries with fixed retention.
 * Keeps only the latest AUTOPILOT_MAX_ENTRIES entries.
 */
export function logAutoPilotEvent(message, meta = {}) {
    try {
        ensureAgentDir();

        let existing = [];
        if (fs.existsSync(AUTOPILOT_HISTORY_FILE)) {
            const raw = fs.readFileSync(AUTOPILOT_HISTORY_FILE, 'utf-8');
            existing = raw
                .split(/\r?\n/)
                .map((line) => line.trimEnd())
                .filter(Boolean);
        }

        const nextVersion = parseLastVersion(existing) + 1;
        const timestamp = new Date().toISOString();
        const metaStr = Object.keys(meta || {}).length ? ` | meta=${JSON.stringify(meta)}` : '';
        const entry = `v${String(nextVersion).padStart(6, '0')} | ${timestamp} | ${String(message || '')}${metaStr}`;

        existing.push(entry);
        if (existing.length > AUTOPILOT_MAX_ENTRIES) {
            existing = existing.slice(existing.length - AUTOPILOT_MAX_ENTRIES);
        }

        fs.writeFileSync(AUTOPILOT_HISTORY_FILE, `${existing.join('\n')}\n`, 'utf-8');
    } catch (e) {
        // Silently fail — history logging should never break agent execution
    }
}
