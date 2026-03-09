const DANGEROUS_COMMAND_PATTERNS = [
    /rm\s+-rf\s+\//i,
    /rm\s+-rf\s+\.\./i,
    /mkfs/i,
    /dd\s+if=/i,
    />\s*\/dev\/(sda|hda|nvme)/i,
    /:\(\)\{ :\|:& \};:/i,
    /chmod\s+-R\s+777\s+\//i,
    /chown\s+-R\s+.*:\s*\//i,
    /remove-item\s+.*-recurse\s+.*-force\s+(c:|\\)/i,
    /del\s+\/?[sqf]*\s+.*(c:\\|\\)/i,
    /format\s+[a-z]:/i,
    /net\s+user\s+.*\/add/i,
    /net\s+localgroup\s+administrators\s+.*\/add/i,
    /sc\s+delete/i,
    /reg\s+delete/i,
    /powershell.*-ExecutionPolicy\s+Bypass/i,
    /curl.*\|\s*sh/i,
    /wget.*\|\s*sh/i
];

const SAFE_BASE_WHITELIST = [
    'ls', 'dir', 'cd', 'pwd', 'mkdir', 'touch', 'echo', 'git', 'npm', 'node', 'python', 'py', 'cat', 'type', 'grep', 'findstr', 'status', 'health', 'system'
];

let safeModeEnabled = true;

export function setCommandSafeMode(enabled) {
    safeModeEnabled = Boolean(enabled);
}

export function getCommandSafeMode() {
    return safeModeEnabled;
}

export function validateCommandPolicy(command, options = {}) {
    const {
        enforceSafeMode = true,
        additionalAllowlist = []
    } = options;

    if (typeof command !== 'string' || !command.trim()) {
        return { safe: false, reason: 'Empty command blocked.' };
    }

    if (command.includes('\0')) {
        return { safe: false, reason: 'Command contains invalid null-byte characters.' };
    }

    if (command.length > 4000) {
        return { safe: false, reason: 'Command is too long and was blocked for safety.' };
    }

    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(command)) {
            return { safe: false, reason: 'Command matches a blocked dangerous pattern.' };
        }
    }

    if (enforceSafeMode && safeModeEnabled) {
        const base = command.trim().split(/\s+/)[0].toLowerCase();
        const allow = new Set([...SAFE_BASE_WHITELIST, ...additionalAllowlist.map((x) => String(x || '').toLowerCase())]);
        if (!allow.has(base)) {
            return { safe: false, reason: `SafeMode is ON. Command \`${base}\` is not in the whitelist.` };
        }
    }

    return { safe: true };
}
