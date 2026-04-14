/**
 * dailyDigest.js — Rex's Morning Briefing / Project Status Report
 *
 * Credit Policy: ZERO AI calls. This module exclusively reads local
 * filesystem state (git, TODOs, cost ledger, hindsight) and formats
 * a human-readable digest. Completely free to run.
 *
 * Opt-in: rexai open → Labs → Daily Digest
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadConfig } from './config.js';

const execAsync = promisify(exec);

// ─── Git Status (local only) ─────────────────────────────────────────────────

async function getGitStatus() {
    try {
        const [statusResult, logResult, branchResult] = await Promise.all([
            execAsync('git status --porcelain', { cwd: process.cwd() }).catch(() => ({ stdout: '' })),
            execAsync('git log --oneline -5 --no-decorate', { cwd: process.cwd() }).catch(() => ({ stdout: '' })),
            execAsync('git branch --show-current', { cwd: process.cwd() }).catch(() => ({ stdout: '' }))
        ]);

        const uncommitted = (statusResult.stdout || '').trim().split('\n').filter(Boolean);
        const recentCommits = (logResult.stdout || '').trim().split('\n').filter(Boolean);
        const branch = (branchResult.stdout || '').trim() || 'unknown';

        return {
            branch,
            uncommittedCount: uncommitted.length,
            uncommittedFiles: uncommitted.slice(0, 8).map(l => l.trim()),
            recentCommits: recentCommits.slice(0, 5)
        };
    } catch {
        return { branch: 'N/A', uncommittedCount: 0, uncommittedFiles: [], recentCommits: [] };
    }
}

// ─── TODO / FIXME Scanner (local file scan) ──────────────────────────────────

function scanTodos() {
    const todos = [];
    const SCAN_EXTENSIONS = /\.(js|ts|jsx|tsx|py|md|css|html|json)$/i;
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.rex-data', '__pycache__']);

    function scan(dir, depth = 0) {
        if (depth > 4) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(full, depth + 1);
                } else if (SCAN_EXTENSIONS.test(entry.name) && entry.name !== 'dailyDigest.js') {
                    try {
                        const stat = fs.statSync(full);
                        if (stat.size > 100000) continue; // Skip large files
                        const content = fs.readFileSync(full, 'utf-8');
                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            const match = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b[:\s]*(.*)/i);
                            if (match) {
                                todos.push({
                                    type: match[1].toUpperCase(),
                                    text: match[2].trim() || '(no description)',
                                    file: path.relative(process.cwd(), full),
                                    line: i + 1
                                });
                            }
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    scan(process.cwd());
    return todos;
}

// ─── Cost Ledger Summary (reads local file) ──────────────────────────────────

function getCostSummary() {
    try {
        const ledgerPath = path.join(process.cwd(), '.agent', 'cost-ledger.json');
        if (!fs.existsSync(ledgerPath)) return null;

        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
        return {
            totalCost: Number(ledger.totalCost || 0),
            totalCalls: Number(ledger.totalCalls || 0),
            totalTokens: Number(ledger.totalTokens || 0),
            updatedAt: ledger.updatedAt || ''
        };
    } catch {
        return null;
    }
}

// ─── Hindsight Highlights (reads local files) ────────────────────────────────

function getRecentHindsights() {
    try {
        const dir = path.join(process.cwd(), '.agent', 'hindsight');
        if (!fs.existsSync(dir)) return [];

        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.md'))
            .map(f => ({
                name: f,
                mtime: fs.statSync(path.join(dir, f)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 3);

        return files.map(f => {
            const content = fs.readFileSync(path.join(dir, f.name), 'utf-8');
            const firstLine = content.split('\n').find(l => l.startsWith('#')) || f.name;
            return firstLine.replace(/^#+\s*/, '');
        });
    } catch {
        return [];
    }
}

// ─── Project Health Quick Scan (local only) ──────────────────────────────────

function getProjectHealth() {
    const checks = {};

    // Package.json sanity
    const pkgPath = path.join(process.cwd(), 'package.json');
    checks.hasPackageJson = fs.existsSync(pkgPath);

    // Lock file
    checks.hasLockFile = fs.existsSync(path.join(process.cwd(), 'package-lock.json'))
        || fs.existsSync(path.join(process.cwd(), 'yarn.lock'))
        || fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'));

    // .gitignore
    checks.hasGitignore = fs.existsSync(path.join(process.cwd(), '.gitignore'));

    // .env exposure check
    checks.envExposed = fs.existsSync(path.join(process.cwd(), '.env'))
        && checks.hasGitignore
        && !fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf-8').includes('.env');

    // README
    checks.hasReadme = fs.existsSync(path.join(process.cwd(), 'README.md'));

    let score = 0;
    if (checks.hasPackageJson) score += 20;
    if (checks.hasLockFile) score += 20;
    if (checks.hasGitignore) score += 20;
    if (!checks.envExposed) score += 20;
    if (checks.hasReadme) score += 20;

    return { score, checks };
}

// ─── Reminders (local file) ──────────────────────────────────────────────────

function getPendingReminders() {
    try {
        const remindersPath = path.join(process.cwd(), '.rex-data', 'reminders.json');
        if (!fs.existsSync(remindersPath)) return [];

        const data = JSON.parse(fs.readFileSync(remindersPath, 'utf-8'));
        const now = Date.now();
        return (data.reminders || [])
            .filter(r => r.fireAt > now)
            .slice(0, 5)
            .map(r => ({
                text: r.text,
                when: new Date(r.fireAt).toLocaleString()
            }));
    } catch {
        return [];
    }
}

// ─── Mood (local file) ───────────────────────────────────────────────────────

function getMoodSummary() {
    try {
        const moodPath = path.join(process.cwd(), '.rex-data', 'mood.json');
        if (!fs.existsSync(moodPath)) return null;
        const mood = JSON.parse(fs.readFileSync(moodPath, 'utf-8'));
        return { state: mood.state || 'neutral', reason: mood.reason || '' };
    } catch {
        return null;
    }
}

// ─── Format the full digest ──────────────────────────────────────────────────

export async function generateDigest() {
    const [git, health] = await Promise.all([
        getGitStatus(),
        Promise.resolve(getProjectHealth())
    ]);

    const todos = scanTodos();
    const cost = getCostSummary();
    const hindsights = getRecentHindsights();
    const reminders = getPendingReminders();
    const mood = getMoodSummary();

    const now = new Date();
    const greeting = now.getHours() < 12 ? '☀️ Good morning' : now.getHours() < 17 ? '🌤️ Good afternoon' : '🌙 Good evening';

    const lines = [];
    lines.push(`${greeting}, boss! Here's your Rex Daily Digest 🦖`);
    lines.push('═'.repeat(50));
    lines.push('');

    // Mood
    if (mood) {
        lines.push(`🎭 Rex's Mood: ${mood.state} ${mood.reason ? `— ${mood.reason}` : ''}`);
        lines.push('');
    }

    // Git
    lines.push('📊 GIT STATUS');
    lines.push(`   Branch: ${git.branch}`);
    lines.push(`   Uncommitted changes: ${git.uncommittedCount}`);
    if (git.uncommittedFiles.length > 0) {
        git.uncommittedFiles.forEach(f => lines.push(`   • ${f}`));
    }
    if (git.recentCommits.length > 0) {
        lines.push('   Recent commits:');
        git.recentCommits.forEach(c => lines.push(`   • ${c}`));
    }
    lines.push('');

    // TODOs
    lines.push(`📝 TODO TRACKER (${todos.length} found)`);
    if (todos.length === 0) {
        lines.push('   Clean slate! No TODOs found. 🎉');
    } else {
        const grouped = {};
        for (const t of todos.slice(0, 15)) {
            const key = t.type;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(t);
        }
        for (const [type, items] of Object.entries(grouped)) {
            lines.push(`   ${type} (${items.length}):`);
            items.slice(0, 5).forEach(t => {
                lines.push(`   • ${t.file}:${t.line} — ${t.text}`);
            });
        }
        if (todos.length > 15) {
            lines.push(`   ... and ${todos.length - 15} more`);
        }
    }
    lines.push('');

    // Health
    const healthEmoji = health.score >= 80 ? '💚' : health.score >= 60 ? '💛' : '❤️';
    lines.push(`${healthEmoji} PROJECT HEALTH: ${health.score}/100`);
    if (!health.checks.hasPackageJson) lines.push('   ⚠️ Missing package.json');
    if (!health.checks.hasLockFile) lines.push('   ⚠️ Missing lock file');
    if (!health.checks.hasGitignore) lines.push('   ⚠️ Missing .gitignore');
    if (health.checks.envExposed) lines.push('   🔴 .env may not be gitignored!');
    if (!health.checks.hasReadme) lines.push('   ⚠️ Missing README.md');
    lines.push('');

    // Cost
    if (cost) {
        const costLabel = cost.totalCost > 0 ? `$${cost.totalCost.toFixed(4)}` : 'FREE';
        lines.push(`💰 CREDIT USAGE: ${costLabel}`);
        lines.push(`   Total calls: ${cost.totalCalls} | Tokens: ~${cost.totalTokens}`);
        lines.push('');
    }

    // Hindsights
    if (hindsights.length > 0) {
        lines.push('🔮 RECENT LESSONS (Hindsight)');
        hindsights.forEach(h => lines.push(`   • ${h}`));
        lines.push('');
    }

    // Reminders
    if (reminders.length > 0) {
        lines.push('⏰ UPCOMING REMINDERS');
        reminders.forEach(r => lines.push(`   • ${r.when}: ${r.text}`));
        lines.push('');
    }

    lines.push('═'.repeat(50));
    lines.push('🦕 That\'s your digest! Use /chat to start working.');

    return lines.join('\n');
}

// ─── CLI Display ─────────────────────────────────────────────────────────────

export async function showDailyDigest() {
    const s = p.spinner();
    s.start('Scanning project for your daily digest...');

    const digest = await generateDigest();

    s.stop('Digest ready!');
    p.note(digest, '🦖 Rex Daily Digest');
}

// ─── Platform export (for Discord/Telegram to send digest) ───────────────────

export { generateDigest as getDailyDigest };
