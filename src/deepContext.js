import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * DeepContext Engine — builds a structural awareness snapshot
 * that gets injected into Rex's system prompt so the AI always knows
 * WHERE it is and WHAT it was doing.
 */

export function buildDeepContext(opts = {}) {
    const sections = [];
    const cwd = process.cwd();

    // 1. Directory Tree (3 levels deep, compact)
    try {
        const tree = buildDirTree(cwd, 3);
        sections.push(`[DIR_TREE (3 levels)]\n${tree}`);
    } catch {}

    // 2. Active browser state (if manager is provided)
    if (opts.browserPage) {
        try {
            const url = opts.browserPage.url?.() || 'unknown';
            const title = opts.browserPageTitle || 'unknown';
            sections.push(`[BROWSER_STATE] URL: ${url} | Title: ${title}`);
        } catch {}
    }

    // 3. Recent tool results summary (last 3)
    if (opts.recentToolResults && opts.recentToolResults.length > 0) {
        const recent = opts.recentToolResults.slice(-3).map((r, i) =>
            `  ${i + 1}. ${r.tool}(${summarizeArgs(r.args)}) → ${truncate(r.result, 120)}`
        ).join('\n');
        sections.push(`[RECENT_TOOL_RESULTS]\n${recent}`);
    }

    // 4. Foreground window (Windows only)
    if (process.platform === 'win32') {
        try {
            const fg = execSync(
                'powershell -Command "(Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -First 1 -ExpandProperty MainWindowTitle)"',
                { timeout: 2000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            if (fg) sections.push(`[FOREGROUND_APP] ${fg}`);
        } catch {}
    }

    // 5. Working context summary
    try {
        const pkgPath = path.join(cwd, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            sections.push(`[PROJECT] ${pkg.name || 'unnamed'}@${pkg.version || '?'} | type: ${pkg.type || 'commonjs'}`);
        }
    } catch {}

    if (sections.length === 0) return '';
    return `\n[DEEP_CONTEXT — Situational Awareness Snapshot]\n${sections.join('\n')}\n[/DEEP_CONTEXT]`;
}

function buildDirTree(dir, maxDepth, currentDepth = 0, prefix = '') {
    if (currentDepth >= maxDepth) return '';

    const IGNORE = new Set(['node_modules', '.git', '.agent', '.vscode', '__pycache__', 'dist', 'build', '.next', 'coverage']);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.') || e.name === '.env')
            .filter(e => !IGNORE.has(e.name))
            .slice(0, 20); // cap per level
    } catch {
        return '';
    }

    let result = '';
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└─ ' : '├─ ';
        const childPrefix = isLast ? '   ' : '│  ';

        if (entry.isDirectory()) {
            result += `${prefix}${connector}${entry.name}/\n`;
            result += buildDirTree(path.join(dir, entry.name), maxDepth, currentDepth + 1, prefix + childPrefix);
        } else {
            const size = safeFileSize(path.join(dir, entry.name));
            result += `${prefix}${connector}${entry.name}${size ? ` (${size})` : ''}\n`;
        }
    }
    return result;
}

function safeFileSize(filePath) {
    try {
        const bytes = fs.statSync(filePath).size;
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    } catch {
        return '';
    }
}

function summarizeArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = Object.keys(args);
    if (keys.length === 0) return '';
    return keys.slice(0, 3).map(k => {
        const v = String(args[k] || '');
        return `${k}=${v.length > 30 ? v.slice(0, 30) + '…' : v}`;
    }).join(', ');
}

function truncate(str, max = 120) {
    const s = String(str || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}
