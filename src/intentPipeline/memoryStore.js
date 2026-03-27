import { getRecentEvents, rememberEvent } from './indexStore.js';

export function rememberLastAccessedFile(filePath, action) {
    rememberEvent('file_access', {
        filePath,
        action,
        ts: new Date().toISOString()
    });
}

export function rememberCommand(intent) {
    rememberEvent('intent_command', {
        action: intent?.action || 'unknown',
        query: intent?.query || '',
        ts: new Date().toISOString()
    });
}

export function getRecentMemory() {
    return getRecentEvents(20);
}
