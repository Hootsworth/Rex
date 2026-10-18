import fs from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';
import Fuse from 'fuse.js';
import { isPathAllowed } from './security.js';

const SEARCH_GLOB = [
    '**/*',
    '!**/node_modules/**',
    '!**/.git/**',
    '!**/__pycache__/**',
    '!**/.next/**',
    '!**/dist/**',
    '!**/build/**'
];

function toEntry(filePath, stat) {
    return {
        path: filePath,
        name: path.basename(filePath),
        ext: path.extname(filePath).toLowerCase(),
        modifiedMs: Number(stat.mtimeMs || 0)
    };
}

function matchesTimeHint(entry, timeHint = '') {
    const hint = String(timeHint || '').toLowerCase();
    if (!hint) return true;

    const now = new Date();
    if (hint.includes('yesterday')) {
        const y = new Date(now);
        y.setDate(now.getDate() - 1);
        return new Date(entry.modifiedMs).toDateString() === y.toDateString();
    }
    if (hint.includes('today')) {
        return new Date(entry.modifiedMs).toDateString() === now.toDateString();
    }
    if (hint.includes('last week')) {
        return entry.modifiedMs >= (Date.now() - 7 * 24 * 60 * 60 * 1000);
    }

    return true;
}

export async function scanAllowedFiles(allowedDirs = []) {
    const entries = [];
    for (const dir of allowedDirs) {
        const matches = await fg(SEARCH_GLOB, {
            cwd: dir,
            absolute: true,
            dot: false,
            onlyFiles: true,
            suppressErrors: true,
            unique: true
        });

        for (const absPath of matches) {
            try {
                const stat = await fs.stat(absPath);
                entries.push(toEntry(absPath, stat));
            } catch {
                // Skip files that disappear during scan.
            }
        }
    }
    return entries;
}

export async function findBestFileMatch({ query = '', time = '' }, allowedDirs = []) {
    const allEntries = await scanAllowedFiles(allowedDirs);
    const timeFiltered = allEntries.filter((entry) => matchesTimeHint(entry, time));
    const workingSet = timeFiltered.length > 0 ? timeFiltered : allEntries;

    if (!query) {
        const sorted = [...workingSet].sort((a, b) => b.modifiedMs - a.modifiedMs);
        return sorted[0] || null;
    }

    const fuse = new Fuse(workingSet, {
        includeScore: true,
        threshold: 0.38,
        keys: [
            { name: 'name', weight: 0.7 },
            { name: 'path', weight: 0.3 }
        ]
    });

    const results = fuse.search(query);
    if (results.length > 0) return results[0].item;

    const fallback = workingSet.find((entry) => entry.name.toLowerCase().includes(String(query).toLowerCase()));
    return fallback || null;
}

export async function readTextFile(filePath, allowedDirs = []) {
    const absolutePath = path.resolve(String(filePath || ''));
    if (!isPathAllowed(absolutePath, allowedDirs)) {
        throw new Error('File is outside allowed directories.');
    }
    return await fs.readFile(absolutePath, 'utf-8');
}
