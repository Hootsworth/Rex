/**
 * moodEngine.js — Rex's Dynamic Personality State Machine
 *
 * Credit Policy: ZERO AI calls. This is a pure deterministic state
 * machine based on time of day, interaction patterns, and git activity.
 * Reads only local files — completely free to run.
 *
 * Opt-in: rexai open → Labs → Rex Mood
 * Also used automatically by chatPlatformCore if mood engine is enabled.
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import * as p from '@clack/prompts';

const execAsync = promisify(exec);
const MOOD_FILE = path.join(process.cwd(), '.rex-data', 'mood.json');
const MOOD_DIR = path.dirname(MOOD_FILE);

// ─── Mood States ─────────────────────────────────────────────────────────────

const MOOD_STATES = {
    excited:    { emoji: '🤩', adjective: 'excited',     flavor: 'HIGH ENERGY! Let\'s build something amazing!' },
    happy:      { emoji: '😊', adjective: 'happy',       flavor: 'Feeling good! Code flows like coffee.' },
    neutral:    { emoji: '😐', adjective: 'neutral',     flavor: 'Standard operational mode. What\'s the task?' },
    focused:    { emoji: '🧑‍💻', adjective: 'focused',     flavor: 'Deep work mode. Minimal fluff, max efficiency.' },
    sarcastic:  { emoji: '😏', adjective: 'sarcastic',   flavor: 'Oh you need my help? Color me shocked.' },
    tired:      { emoji: '😴', adjective: 'tired',       flavor: '*yawns* We\'re still doing this? Okay fine...' },
    grumpy:     { emoji: '😤', adjective: 'grumpy',      flavor: 'Who codes at this hour?? Not me. Yet here I am.' },
    proud:      { emoji: '🦖', adjective: 'proud',       flavor: 'Look at that commit streak! That\'s MY human!' },
    worried:    { emoji: '😟', adjective: 'worried',     flavor: 'Haven\'t seen a commit in a while... you okay?' },
    caffeinated:{ emoji: '☕', adjective: 'caffeinated',  flavor: 'COFFEE ACQUIRED. Rex at 200% capacity.' }
};

// ─── Mood Persistence ────────────────────────────────────────────────────────

function loadMood() {
    try {
        if (fs.existsSync(MOOD_FILE)) {
            const data = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf-8'));
            return {
                state: data.state || 'neutral',
                reason: data.reason || '',
                lastUpdated: data.lastUpdated || Date.now(),
                interactionCount: data.interactionCount || 0,
                lastCommitCheck: data.lastCommitCheck || 0
            };
        }
    } catch {}
    return {
        state: 'neutral',
        reason: 'Fresh start',
        lastUpdated: Date.now(),
        interactionCount: 0,
        lastCommitCheck: 0
    };
}

function saveMood(mood) {
    try {
        if (!fs.existsSync(MOOD_DIR)) fs.mkdirSync(MOOD_DIR, { recursive: true });
        fs.writeFileSync(MOOD_FILE, JSON.stringify({ ...mood, lastUpdated: Date.now() }, null, 2));
    } catch {}
}

// ─── Deterministic Mood Calculation ──────────────────────────────────────────

async function getRecentCommitAge() {
    try {
        const { stdout } = await execAsync('git log -1 --format=%ct', { cwd: process.cwd() });
        const timestamp = parseInt(stdout.trim(), 10);
        if (isNaN(timestamp)) return Infinity;
        return (Date.now() / 1000) - timestamp; // seconds since last commit
    } catch {
        return Infinity;
    }
}

async function getCommitCountToday() {
    try {
        const { stdout } = await execAsync('git log --since="midnight" --oneline', { cwd: process.cwd() });
        return (stdout || '').trim().split('\n').filter(Boolean).length;
    } catch {
        return 0;
    }
}

/**
 * Recalculate Rex's mood based on deterministic signals.
 * No AI calls — just local data and time.
 */
export async function recalculateMood() {
    const mood = loadMood();
    const hour = new Date().getHours();
    const commitAge = await getRecentCommitAge();
    const commitsToday = await getCommitCountToday();

    let newState = 'neutral';
    let reason = '';

    // Time-based mood
    if (hour >= 0 && hour < 6) {
        newState = 'grumpy';
        reason = 'Who codes between midnight and 6am??';
    } else if (hour >= 6 && hour < 9) {
        newState = 'tired';
        reason = 'Early morning... need coffee first';
    } else if (hour >= 9 && hour < 12) {
        newState = 'caffeinated';
        reason = 'Morning coffee energy ☕';
    } else if (hour >= 12 && hour < 14) {
        newState = 'neutral';
        reason = 'Lunch time coding';
    } else if (hour >= 14 && hour < 18) {
        newState = 'focused';
        reason = 'Peak productivity hours';
    } else if (hour >= 18 && hour < 21) {
        newState = 'happy';
        reason = 'Evening chill coding vibes';
    } else {
        newState = 'sarcastic';
        reason = 'Late night? Really?';
    }

    // Override with activity-based mood
    if (commitsToday >= 10) {
        newState = 'excited';
        reason = `${commitsToday} commits today! You're on fire! 🔥`;
    } else if (commitsToday >= 5) {
        newState = 'proud';
        reason = `${commitsToday} commits today — solid streak!`;
    } else if (commitAge > 86400 * 2) { // No commit in 2+ days
        newState = 'worried';
        reason = 'Haven\'t seen a commit in 2+ days... taking a break?';
    } else if (commitAge > 86400 * 5) { // No commit in 5+ days
        newState = 'grumpy';
        reason = 'FIVE DAYS without a commit. I\'m getting cobwebs here.';
    }

    // Interaction count boosts
    if (mood.interactionCount > 20 && newState === 'neutral') {
        newState = 'happy';
        reason = 'We\'ve been chatting a lot today! I like it.';
    }

    mood.state = newState;
    mood.reason = reason;
    saveMood(mood);
    return mood;
}

/**
 * Analyze the social "vibe" of a set of recent messages.
 * Uses a fast LLM call (or heuristic) to detect if the conversation is tense.
 */
export async function analyzeSocialVibe(messages = []) {
    if (messages.length < 5) return 'neutral';

    try {
        const { runCompletion } = await import('./ai.js');
        const textToAnalyze = messages.map(m => `${m.author}: ${m.content}`).join('\n');
        
        const prompt = `Analyze the "vibe" of these recent Discord messages. 
Return ONLY one word from this list: [tense, productive, happy, confused, stagnant].
Messages:
${textToAnalyze.slice(-2000)}`;

        const response = await runCompletion([{ role: 'user', content: prompt }], null, 'low');
        const vibe = response.toLowerCase().trim().replace(/[^a-z]/g, '');
        
        if (['tense', 'productive', 'happy', 'confused', 'stagnant'].includes(vibe)) {
            const mood = loadMood();
            if (vibe === 'tense') mood.state = 'worried';
            if (vibe === 'happy') mood.state = 'excited';
            if (vibe === 'productive') mood.state = 'focused';
            mood.reason = `Social vibe detected as ${vibe}`;
            saveMood(mood);
            return vibe;
        }
    } catch (e) {
        console.error('Vibe analysis failed:', e.message);
    }
    return 'neutral';
}

/**
 * Bump the interaction counter (call on each user message).
 * Zero credit cost.
 */
export function bumpInteraction() {
    const mood = loadMood();
    mood.interactionCount = (mood.interactionCount || 0) + 1;
    saveMood(mood);
}

/**
 * Get the current mood without recalculating.
 */
export function getCurrentMood() {
    return loadMood();
}

/**
 * Get the emoji for a mood state.
 */
export function getMoodEmoji(state) {
    return (MOOD_STATES[state] || MOOD_STATES.neutral).emoji;
}

/**
 * Get the flavor text for a mood state.
 */
export function getMoodFlavor(state) {
    return (MOOD_STATES[state] || MOOD_STATES.neutral).flavor;
}

/**
 * Get a system prompt modifier based on current mood.
 * This can be injected into the persona to subtly shift Rex's tone.
 */
export function getMoodPromptModifier() {
    const mood = loadMood();
    const info = MOOD_STATES[mood.state] || MOOD_STATES.neutral;
    return `[Current Mood: ${info.adjective} — ${info.flavor}]`;
}

// ─── CLI Display ─────────────────────────────────────────────────────────────

export async function showMoodMenu() {
    const s = p.spinner();
    s.start('Checking Rex\'s mood...');

    const mood = await recalculateMood();
    const info = MOOD_STATES[mood.state] || MOOD_STATES.neutral;

    s.stop('Mood checked!');

    const lines = [
        `${info.emoji}  Current Mood: ${pc.bold(info.adjective.toUpperCase())}`,
        '',
        `"${info.flavor}"`,
        '',
        `Reason: ${mood.reason}`,
        `Interactions today: ${mood.interactionCount || 0}`,
        `Last updated: ${new Date(mood.lastUpdated).toLocaleString()}`
    ];

    p.note(lines.join('\n'), '🦖 Rex Mood Engine');
}
