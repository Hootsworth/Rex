import path from 'path';
import os from 'os';

function norm(value = '') {
    return String(value || '').replace(/\\+/g, '/').toLowerCase();
}

function toAbsoluteDir(dirPath) {
    if (!dirPath) return '';
    if (path.isAbsolute(dirPath)) return path.resolve(dirPath);
    return path.resolve(process.cwd(), dirPath);
}

export function getAllowedDirs(config = {}) {
    const defaults = [
        path.join(os.homedir(), 'Desktop'),
        path.join(os.homedir(), 'Downloads')
    ];

    const configured = Array.isArray(config.allowedDirs) && config.allowedDirs.length > 0
        ? config.allowedDirs
        : defaults;

    return configured.map((dir) => toAbsoluteDir(dir));
}

export function isPathAllowed(filePath, allowedDirs = []) {
    const target = norm(path.resolve(String(filePath || '')));
    return allowedDirs.some((dir) => {
        const root = norm(path.resolve(dir));
        return target === root || target.startsWith(`${root}/`);
    });
}

export function isDiscordUserAllowed(config = {}, userId = '') {
    const whitelist = Array.isArray(config.discordAllowedUserIds) ? config.discordAllowedUserIds : [];
    if (whitelist.length === 0) return true;
    if (whitelist.includes('*')) return true;
    return whitelist.includes(String(userId));
}

export function requiresConfirmation(intent = {}) {
    const action = String(intent.action || '').toLowerCase();
    return action === 'send_file';
}

export function hasConfirmation(intent = {}) {
    if (intent.confirmed === true) return true;
    const note = String(intent.note || '').toLowerCase();
    const raw = String(intent.raw || '').toLowerCase();
    return note.includes('confirm') || raw.includes('confirm');
}
