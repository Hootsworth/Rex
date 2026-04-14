/**
 * reminders.js — Persistent Reminder & Cron System
 *
 * Credit Policy: ZERO AI calls. This module uses simple string
 * pattern matching to parse natural language time expressions.
 * All reminders are stored in a local JSON file and survive restarts.
 *
 * Opt-in: rexai open → Labs → Reminders
 */

import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const REMINDERS_DIR = path.join(process.cwd(), '.rex-data');
const REMINDERS_FILE = path.join(REMINDERS_DIR, 'reminders.json');

// ─── Persistence ─────────────────────────────────────────────────────────────

function ensureFile() {
    if (!fs.existsSync(REMINDERS_DIR)) fs.mkdirSync(REMINDERS_DIR, { recursive: true });
    if (!fs.existsSync(REMINDERS_FILE)) {
        fs.writeFileSync(REMINDERS_FILE, JSON.stringify({ reminders: [] }, null, 2));
    }
}

function readReminders() {
    ensureFile();
    try {
        const data = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf-8'));
        return Array.isArray(data.reminders) ? data.reminders : [];
    } catch {
        return [];
    }
}

function writeReminders(reminders) {
    ensureFile();
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify({ reminders }, null, 2));
}

// ─── Natural Language Time Parser (zero AI calls) ────────────────────────────

/**
 * Parse a natural-language time expression into a millisecond delay.
 * Examples:
 *   "in 5 minutes"  → 300000
 *   "in 2 hours"    → 7200000
 *   "in 30s"        → 30000
 *   "tomorrow"      → ms until tomorrow 9am
 *   "tonight"       → ms until 9pm today (or tomorrow if past)
 *   "in 1 day"      → 86400000
 */
export function parseTimeExpression(text) {
    const lower = String(text || '').toLowerCase().trim();

    // Pattern: "in X unit(s)"
    const relativeMatch = lower.match(/(?:in\s+)?(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)/);
    if (relativeMatch) {
        const val = parseInt(relativeMatch[1], 10);
        const unit = relativeMatch[2].charAt(0);
        const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
        return val * (multipliers[unit] || 60000);
    }

    // Pattern: "tomorrow" → next day at 9am
    if (lower.includes('tomorrow')) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        return Math.max(tomorrow.getTime() - Date.now(), 60000);
    }

    // Pattern: "tonight" → today at 9pm (or tomorrow 9pm if past)
    if (lower.includes('tonight')) {
        const tonight = new Date();
        tonight.setHours(21, 0, 0, 0);
        if (tonight.getTime() <= Date.now()) {
            tonight.setDate(tonight.getDate() + 1);
        }
        return Math.max(tonight.getTime() - Date.now(), 60000);
    }

    // Pattern: "at HH:MM" — specific time today/tomorrow
    const atTimeMatch = lower.match(/at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (atTimeMatch) {
        let hours = parseInt(atTimeMatch[1], 10);
        const minutes = parseInt(atTimeMatch[2], 10);
        const ampm = atTimeMatch[3];

        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;

        const target = new Date();
        target.setHours(hours, minutes, 0, 0);
        if (target.getTime() <= Date.now()) {
            target.setDate(target.getDate() + 1);
        }
        return Math.max(target.getTime() - Date.now(), 60000);
    }

    return null; // Could not parse
}

/**
 * Format milliseconds into a human-readable duration.
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    if (hours < 24) return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHrs = hours % 24;
    return remainingHrs > 0 ? `${days}d ${remainingHrs}h` : `${days}d`;
}

// ─── Reminder CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new reminder. Returns the reminder object.
 */
export function createReminder(text, delayMs, recurring = false) {
    const reminders = readReminders();
    const reminder = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text: String(text),
        createdAt: Date.now(),
        fireAt: Date.now() + delayMs,
        delayMs,
        recurring,
        fired: false,
        dismissed: false
    };
    reminders.push(reminder);
    writeReminders(reminders);
    return reminder;
}

/**
 * Get all pending (unfired, undismissed) reminders.
 */
export function getPendingReminders() {
    const reminders = readReminders();
    const now = Date.now();
    return reminders.filter(r => !r.dismissed && !r.fired);
}

/**
 * Get reminders that are ready to fire.
 */
export function getReadyReminders() {
    const reminders = readReminders();
    const now = Date.now();
    return reminders.filter(r => !r.dismissed && !r.fired && r.fireAt <= now);
}

/**
 * Mark a reminder as fired. If recurring, reschedule it.
 */
export function markFired(reminderId) {
    const reminders = readReminders();
    const idx = reminders.findIndex(r => r.id === reminderId);
    if (idx === -1) return;

    if (reminders[idx].recurring) {
        // Reschedule
        reminders[idx].fireAt = Date.now() + reminders[idx].delayMs;
        reminders[idx].fired = false;
    } else {
        reminders[idx].fired = true;
    }

    writeReminders(reminders);
}

/**
 * Dismiss/delete a reminder.
 */
export function dismissReminder(reminderId) {
    const reminders = readReminders();
    const idx = reminders.findIndex(r => r.id === reminderId);
    if (idx === -1) return false;
    reminders[idx].dismissed = true;
    writeReminders(reminders);
    return true;
}

/**
 * Clear all fired/dismissed reminders from the file.
 */
export function cleanupReminders() {
    const reminders = readReminders();
    const active = reminders.filter(r => !r.dismissed && (!r.fired || r.recurring));
    writeReminders(active);
    return reminders.length - active.length;
}

// ─── Checker (call on startup or periodically) ──────────────────────────────

/**
 * Check for ready reminders and return them. Does NOT fire automatically.
 * The caller decides how to display/notify.
 *
 * @returns {Array} Array of ready-to-fire reminder objects
 */
export function checkReminders() {
    const ready = getReadyReminders();
    return ready;
}

/**
 * Fire all ready reminders and return their text.
 * Call this from CLI startup or bot polling.
 */
export function fireReadyReminders() {
    const ready = getReadyReminders();
    const fired = [];

    for (const r of ready) {
        fired.push({ ...r });
        markFired(r.id);
    }

    return fired;
}

// ─── CLI Menu ────────────────────────────────────────────────────────────────

export async function remindersMenu() {
    const action = await p.select({
        message: pc.dim('reminders'),
        options: [
            { value: 'create', label: '⏰ Create Reminder' },
            { value: 'list', label: '📋 List Pending Reminders' },
            { value: 'check', label: '🔔 Check & Fire Ready Reminders' },
            { value: 'cleanup', label: '🧹 Cleanup Old Reminders' },
            { value: 'back', label: pc.dim('  back') }
        ]
    });

    if (p.isCancel(action) || action === 'back') return;

    if (action === 'create') {
        const text = await p.text({
            message: 'What should Rex remind you about?',
            placeholder: 'Push the staging branch'
        });
        if (p.isCancel(text) || !text) return;

        const when = await p.text({
            message: 'When? (e.g. "in 30 minutes", "in 2 hours", "tomorrow", "at 3:00 pm")',
            placeholder: 'in 30 minutes'
        });
        if (p.isCancel(when) || !when) return;

        const delayMs = parseTimeExpression(when);
        if (!delayMs) {
            p.log.error('Could not parse that time expression. Try: "in 30m", "in 2h", "tomorrow", "at 3:00 pm"');
            return;
        }

        const recurring = await p.confirm({
            message: 'Should this repeat?',
            initialValue: false
        });

        const reminder = createReminder(text, delayMs, !p.isCancel(recurring) && recurring);
        const fireTime = new Date(reminder.fireAt).toLocaleString();

        p.note([
            `✅ Reminder created!`,
            `📝 "${text}"`,
            `⏰ Fires: ${fireTime} (${formatDuration(delayMs)} from now)`,
            `🔄 Recurring: ${reminder.recurring ? 'Yes' : 'No'}`,
            `🆔 ID: ${reminder.id}`
        ].join('\n'), '⏰ Reminder Set');
    }

    if (action === 'list') {
        const pending = getPendingReminders();
        if (pending.length === 0) {
            p.log.info('No pending reminders. You\'re all caught up! 🎉');
            return;
        }

        const now = Date.now();
        const lines = pending.map(r => {
            const remaining = r.fireAt - now;
            const status = remaining > 0
                ? `in ${formatDuration(remaining)}`
                : '🔴 OVERDUE';
            return `• [${r.id}] "${r.text}" — ${status}${r.recurring ? ' 🔄' : ''}`;
        });

        p.note(lines.join('\n'), `📋 Pending Reminders (${pending.length})`);
    }

    if (action === 'check') {
        const fired = fireReadyReminders();
        if (fired.length === 0) {
            p.log.info('No reminders ready to fire right now.');
            return;
        }

        for (const r of fired) {
            p.note(`🔔 REMINDER: "${r.text}"${r.recurring ? '\n🔄 Recurring — rescheduled automatically.' : ''}`, '⏰ Rex Reminder');
        }
    }

    if (action === 'cleanup') {
        const removed = cleanupReminders();
        p.log.success(`🧹 Cleaned up ${removed} old reminder(s).`);
    }
}
