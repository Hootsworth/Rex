import fs from 'fs';
import path from 'path';

const AGENT_DIR = path.join(process.cwd(), '.agent');
const TOOLS_FILE_JSON = path.join(AGENT_DIR, 'tools.json');

/**
 * Loads tool permissions from `.agent/tools.json`
 * 
 * Format:
 * {
 *   "allowlist": ["read_file", "read_dir", "fetch_web"],   // if set, ONLY these tools are allowed
 *   "denylist": ["run_shell", "write_file"]                 // if set, these tools are blocked
 * }
 * 
 * If neither is set, all tools are allowed.
 * If both are set, allowlist takes precedence.
 */
export function loadToolPermissions() {
    try {
        if (fs.existsSync(TOOLS_FILE_JSON)) {
            const raw = fs.readFileSync(TOOLS_FILE_JSON, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        // Silently fail — no permissions = all allowed
    }
    return null;
}

/**
 * Checks if a tool is permitted by the project manifest
 * @param {string} toolName 
 * @param {object|null} permissions - Output of loadToolPermissions()
 * @returns {{ allowed: boolean, reason: string }}
 */
export function isToolAllowed(toolName, permissions) {
    if (!permissions) return { allowed: true, reason: '' };

    // Allowlist takes precedence
    if (permissions.allowlist && Array.isArray(permissions.allowlist)) {
        if (!permissions.allowlist.includes(toolName)) {
            return { allowed: false, reason: `Not in project allowlist (.agent/tools.json)` };
        }
        return { allowed: true, reason: '' };
    }

    // Denylist
    if (permissions.denylist && Array.isArray(permissions.denylist)) {
        if (permissions.denylist.includes(toolName)) {
            return { allowed: false, reason: `Blocked by project denylist (.agent/tools.json)` };
        }
    }

    return { allowed: true, reason: '' };
}
