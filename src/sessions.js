import fs from 'fs';
import path from 'path';
import pc from 'picocolors';

const AGENT_DIR = path.join(process.cwd(), '.agent');
const SESSIONS_DIR = path.join(AGENT_DIR, 'sessions');

function ensureSessionsDir() {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
}

/**
 * Saves a chat session to disk
 * @param {string} name - Session name (e.g. "refactor-auth")
 * @param {Array} history - The historyContext array
 * @param {object} meta - Extra metadata (topLevelRequest, model, etc.)
 */
export function saveSession(name, history, meta = {}) {
    ensureSessionsDir();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const session = {
        name,
        slug,
        savedAt: new Date().toISOString(),
        messageCount: history.length,
        topLevelRequest: meta.topLevelRequest || '',
        model: meta.model || '',
        history
    };
    const filePath = path.join(SESSIONS_DIR, `${slug}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    return filePath;
}

/**
 * Loads a session by slug or name
 * @param {string} nameOrSlug
 * @returns {object|null}
 */
export function loadSession(nameOrSlug) {
    ensureSessionsDir();
    const slug = nameOrSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // Direct file match
    const direct = path.join(SESSIONS_DIR, `${slug}.json`);
    if (fs.existsSync(direct)) {
        return JSON.parse(fs.readFileSync(direct, 'utf-8'));
    }

    // Fuzzy search by filename
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const match = files.find(f => f.includes(slug));
    if (match) {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, match), 'utf-8'));
    }

    return null;
}

/**
 * Lists all saved sessions
 * @returns {Array<{name, slug, savedAt, messageCount, topLevelRequest}>}
 */
export function listSessions() {
    ensureSessionsDir();
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
            return {
                name: data.name,
                slug: data.slug,
                savedAt: data.savedAt,
                messageCount: data.messageCount,
                topLevelRequest: data.topLevelRequest
            };
        } catch (e) {
            return null;
        }
    }).filter(Boolean).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

/**
 * Searches session history for a keyword
 * @param {string} query
 * @returns {Array<{name, slug, matches}>}
 */
export function searchSessions(query) {
    ensureSessionsDir();
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const results = [];
    const lowerQuery = query.toLowerCase();

    for (const f of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
            const matches = data.history.filter(m =>
                m.content.toLowerCase().includes(lowerQuery)
            );
            if (matches.length > 0 || data.name.toLowerCase().includes(lowerQuery)) {
                results.push({
                    name: data.name,
                    slug: data.slug,
                    matchCount: matches.length,
                    preview: matches.length > 0 ? matches[0].content.slice(0, 120) : data.topLevelRequest
                });
            }
        } catch (e) { /* skip corrupt files */ }
    }

    return results;
}
