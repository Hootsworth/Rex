/**
 * socialRadar.js — Social EQ & Relationship Memory Engine for Rex
 *
 * Capabilities:
 * - Passively catches social breadcrumbs from conversation (e.g. "Sarah has her driving test on Thursday")
 * - Stores friend/family events, milestones, and dates in .rex-data/social_radar.json
 * - Sends proactive day-of reminders to check in or send good-luck texts
 * - Explicit management via "rex social", "social radar", "!social add ..."
 */

import fs from 'fs';
import path from 'path';
import pc from 'picocolors';

const DATA_DIR = path.join(process.cwd(), '.rex-data');
const RADAR_FILE = path.join(DATA_DIR, 'social_radar.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    }
}

export function loadSocialRadar() {
    ensureDataDir();
    if (!fs.existsSync(RADAR_FILE)) return [];
    try {
        const raw = fs.readFileSync(RADAR_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveSocialRadar(events = []) {
    ensureDataDir();
    try {
        fs.writeFileSync(RADAR_FILE, JSON.stringify(events, null, 2), 'utf-8');
    } catch (e) {
        console.error(pc.red(`Failed to save social radar: ${e.message}`));
    }
}

/**
 * Helper to resolve relative day phrases (e.g. "tomorrow", "on Thursday", "next Friday")
 * into a YYYY-MM-DD string.
 */
export function resolveDateString(datePhrase = '', referenceDate = new Date()) {
    const raw = String(datePhrase || '').trim().toLowerCase();
    if (!raw) return null;

    // Direct YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

    const target = new Date(referenceDate);

    if (raw === 'today') {
        return target.toISOString().split('T')[0];
    }
    if (raw === 'tomorrow') {
        target.setDate(target.getDate() + 1);
        return target.toISOString().split('T')[0];
    }

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayMatch = raw.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (dayMatch) {
        const targetDayIdx = dayNames.indexOf(dayMatch[1].toLowerCase());
        const currentDayIdx = target.getDay();
        let diff = targetDayIdx - currentDayIdx;
        if (diff <= 0) diff += 7; // next upcoming day
        if (raw.includes('next week')) diff += 7;
        target.setDate(target.getDate() + diff);
        return target.toISOString().split('T')[0];
    }

    if (raw.includes('next week')) {
        target.setDate(target.getDate() + 7);
        return target.toISOString().split('T')[0];
    }

    // Month & Day: e.g. "October 24" or "24th October"
    const monthMatch = raw.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i) ||
                       raw.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
    if (monthMatch) {
        const mStr = (monthMatch[1].length > 2 && isNaN(monthMatch[1])) ? monthMatch[1] : monthMatch[2];
        const dStr = !isNaN(monthMatch[1]) ? monthMatch[1] : monthMatch[2];
        const mIdx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(mStr.slice(0, 3).toLowerCase());
        const dNum = parseInt(dStr, 10);
        if (mIdx !== -1 && dNum >= 1 && dNum <= 31) {
            target.setMonth(mIdx);
            target.setDate(dNum);
            if (target < referenceDate) target.setFullYear(target.getFullYear() + 1);
            return target.toISOString().split('T')[0];
        }
    }

    return null;
}

/**
 * Add a new social event to the radar
 */
export function addSocialEvent({ person, event, dateStr, originalText = '' }) {
    if (!person || !event) return null;
    const events = loadSocialRadar();

    const resolvedDate = resolveDateString(dateStr) || dateStr || 'upcoming';
    const id = `radar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const newEntry = {
        id,
        person: String(person).trim(),
        event: String(event).trim(),
        date: resolvedDate,
        originalText: String(originalText).trim(),
        reminded: false,
        createdAt: new Date().toISOString()
    };

    events.push(newEntry);
    saveSocialRadar(events);
    return newEntry;
}

/**
 * Passively extract social breadcrumbs from user text turns
 */
export function extractSocialBreadcrumbs(text = '') {
    const raw = String(text || '').trim();
    if (raw.length < 10) return [];

    const extracted = [];

    // Pattern 1: "[Person] has [event] on/this [date]"
    // e.g. "Sarah has her driving test on Thursday"
    // e.g. "Mom has a doctor appointment tomorrow"
    const p1 = /\b([A-Z][a-z]+)\s+has\s+(?:her|his|their|a|an)?\s*([a-zA-Z\s]+?)\s+(?:on|this|next|tomorrow)\s+([a-zA-Z0-9\s]+?)(?:[.!,;]|$)/i;
    const m1 = raw.match(p1);
    if (m1 && !['he', 'she', 'it', 'who', 'someone'].includes(m1[1].toLowerCase())) {
        const resolved = resolveDateString(m1[3]);
        if (resolved) {
            extracted.push({
                person: m1[1].trim(),
                event: m1[2].trim(),
                dateStr: resolved,
                originalText: raw
            });
        }
    }

    // Pattern 2: "[Person] is [interviewing/traveling/going to] [place/event] on/this [date]"
    // e.g. "Alex is interviewing at Stripe next week"
    const p2 = /\b([A-Z][a-z]+)\s+is\s+(interviewing|traveling|moving|visiting|presenting|flying)\s+([a-zA-Z\s]+?)\s+(?:on|this|next|tomorrow)\s+([a-zA-Z0-9\s]+?)(?:[.!,;]|$)/i;
    const m2 = raw.match(p2);
    if (m2 && !['he', 'she', 'it', 'who', 'someone'].includes(m2[1].toLowerCase())) {
        const resolved = resolveDateString(m2[4]);
        if (resolved) {
            extracted.push({
                person: m2[1].trim(),
                event: `${m2[2]} ${m2[3]}`.trim(),
                dateStr: resolved,
                originalText: raw
            });
        }
    }

    // Commit non-duplicates
    const existing = loadSocialRadar();
    const added = [];
    for (const item of extracted) {
        const exists = existing.some(e =>
            e.person.toLowerCase() === item.person.toLowerCase() &&
            e.event.toLowerCase() === item.event.toLowerCase() &&
            e.date === item.dateStr
        );
        if (!exists) {
            const entry = addSocialEvent(item);
            if (entry) added.push(entry);
        }
    }

    return added;
}

/**
 * Check for events due today that haven't been reminded
 */
export function getDueEventsToday(referenceDate = new Date()) {
    const todayStr = referenceDate.toISOString().split('T')[0];
    const events = loadSocialRadar();
    return events.filter(e => e.date === todayStr && !e.reminded);
}

/**
 * Format active social radar items for prompt context or user display
 */
export function formatSocialRadarSummary() {
    const events = loadSocialRadar();
    if (events.length === 0) return 'No active events on the social radar.';

    const lines = events.map(e => `• **${e.person}**: ${e.event} (${e.date})${e.reminded ? ' [Reminded]' : ''}`);
    return lines.join('\n');
}

/**
 * Command handler for explicit user queries
 */
export async function tryHandleSocialRadarCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    // 1) Show radar
    if (/^(?:rex\s+)?(?:social\s+radar|show\s+social|list\s+social|social\s+events)$/i.test(text)) {
        const summary = formatSocialRadarSummary();
        await message.reply(`🦖📡 **Rex Social Radar** (Important events for people in your life):\n\n${summary}`);
        return { handled: true };
    }

    // 2) Add manual event: "!social add Sarah driving test on Thursday" or "rex add social Sarah driving test tomorrow"
    const addMatch = text.match(/^(?:!social\s+add|(?:rex\s+)?add\s+social)\s+([A-Z][a-z]+)\s+(.+?)\s+(?:on|date:?)\s+(.+)$/i);
    if (addMatch) {
        const person = addMatch[1];
        const event = addMatch[2];
        const datePhrase = addMatch[3];
        const resolved = resolveDateString(datePhrase);
        const entry = addSocialEvent({ person, event, dateStr: resolved || datePhrase, originalText: text });
        await message.reply(`✅ Added to Social Radar: **${person}** has *${event}* (${entry.date}). I'll remind you on the day! 🦖 radar active.`);
        return { handled: true };
    }

    return { handled: false };
}
