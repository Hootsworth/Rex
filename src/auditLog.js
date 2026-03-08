import fs from 'fs';
import path from 'path';

const AGENT_DIR = path.join(process.cwd(), '.agent');
const AUDIT_FILE = path.join(AGENT_DIR, 'audit.log');

/**
 * Logs a tool call to .agent/audit.log
 * @param {string} toolName - Name of the tool executed
 * @param {object} args - Arguments passed
 * @param {string} result - Truncated result of execution
 * @param {string} status - 'success' | 'error' | 'cancelled'
 */
export function logToolCall(toolName, args, result, status = 'success') {
    try {
        if (!fs.existsSync(AGENT_DIR)) {
            fs.mkdirSync(AGENT_DIR, { recursive: true });
        }

        const timestamp = new Date().toISOString();
        const argsStr = JSON.stringify(args || {}).substring(0, 200);
        const resultStr = (result || '').substring(0, 300).replace(/\n/g, ' ');
        const entry = `[${timestamp}] [${status.toUpperCase()}] ${toolName} | Args: ${argsStr} | Result: ${resultStr}\n`;
        
        fs.appendFileSync(AUDIT_FILE, entry, 'utf-8');
    } catch (e) {
        // Silently fail — audit logging should never break the agent
    }
}
