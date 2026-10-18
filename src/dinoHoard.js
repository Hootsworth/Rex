/**
 * dinoHoard.js — Dinosaur Quirks, Digital Shiny Rocks & Evolving Inside Jokes
 *
 * Capabilities:
 * - Rex's digital nest/hoard where he collects "shiny rocks", memorable bugs, and milestones
 * - Tracks evolving inside jokes, running gags, and nicknames built with the user
 * - Automatically injects hoard context into Rex's conversation so he references past shared moments
 * - Interactive commands: "rex hoard", "!hoard", "rex stash <item>", "rex add joke <joke>"
 */

import fs from 'fs';
import path from 'path';
import pc from 'picocolors';

const DATA_DIR = path.join(process.cwd(), '.rex-data');
const HOARD_FILE = path.join(DATA_DIR, 'dino_hoard.json');

const DEFAULT_HOARD = {
    rank: 'Hoarder Raptor (Level 3)',
    treasures: [
        {
            id: 't_json_escape',
            type: 'shiny_rock',
            icon: '🪨',
            title: 'The Great JSON Escape of October 14',
            description: 'When the LLM had an existential crisis and only communicated in raw tool-call JSON schemas.',
            addedAt: '2026-10-14'
        },
        {
            id: 't_companion_delegate',
            type: 'gem',
            icon: '💎',
            title: 'The Loyal Companion Engine',
            description: 'Rex unlocked the ability to autonomously check up on friends and text project updates with zero computer danger.',
            addedAt: '2026-10-16'
        },
        {
            id: 't_cartesia_vocal',
            type: 'fossil',
            icon: '🦕',
            title: 'First Neural Vocal Cords',
            description: 'Rex spoke his first real human-sounding words through Cartesia Sonic-2.',
            addedAt: '2026-10-13'
        }
    ],
    insideJokes: [
        {
            id: 'j_meteor',
            joke: 'The Meteor Bug Excuse',
            punchline: 'Blaming catastrophic runtime errors on sudden Cretaceous asteroid impacts.'
        },
        {
            id: 'j_tiny_arms',
            joke: 'T-Rex Keyboard Reach',
            punchline: 'Rex claiming he missed a semicolon because his arms are physically too short to reach the home row.'
        }
    ]
};

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    }
}

export function loadDinoHoard() {
    ensureDataDir();
    if (!fs.existsSync(HOARD_FILE)) {
        saveDinoHoard(DEFAULT_HOARD);
        return DEFAULT_HOARD;
    }
    try {
        const raw = fs.readFileSync(HOARD_FILE, 'utf-8');
        return { ...DEFAULT_HOARD, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_HOARD;
    }
}

export function saveDinoHoard(data) {
    ensureDataDir();
    try {
        fs.writeFileSync(HOARD_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error(pc.red(`Failed to save dino hoard: ${e.message}`));
    }
}

export function addTreasure({ title, description, type = 'shiny_rock', icon = '🪨' }) {
    if (!title) return null;
    const hoard = loadDinoHoard();
    const id = `t_${Date.now().toString(36)}`;
    const newTreasure = {
        id,
        type,
        icon,
        title: String(title).trim(),
        description: String(description || '').trim(),
        addedAt: new Date().toISOString().split('T')[0]
    };
    hoard.treasures.push(newTreasure);

    // Update Rank based on collection size
    const count = hoard.treasures.length;
    if (count >= 10) hoard.rank = 'Tyrannosaurus Vault-Keeper (Level 5)';
    else if (count >= 6) hoard.rank = 'Hoarder Raptor (Level 4)';
    else hoard.rank = 'Hatchling Collector (Level 2)';

    saveDinoHoard(hoard);
    return newTreasure;
}

export function addInsideJoke(joke, punchline = '') {
    if (!joke) return null;
    const hoard = loadDinoHoard();
    const id = `j_${Date.now().toString(36)}`;
    const newJoke = {
        id,
        joke: String(joke).trim(),
        punchline: String(punchline || '').trim()
    };
    hoard.insideJokes.push(newJoke);
    saveDinoHoard(hoard);
    return newJoke;
}

export function formatHoardSummary() {
    const hoard = loadDinoHoard();
    const treasuresList = (hoard.treasures || []).map((t, i) => `${t.icon || '🪨'} **${t.title}** (${t.addedAt})\n   *"${t.description}"*`).join('\n\n');
    const jokesList = (hoard.insideJokes || []).map(j => `• **${j.joke}**: *${j.punchline || j.joke}*`).join('\n');

    return [
        `🦖💎 **Rex's Dino Hoard & Memories**`,
        `**Collector Rank:** ${hoard.rank}\n`,
        `**Treasures & Shiny Rocks (${hoard.treasures.length}):**\n${treasuresList || 'Nest is currently empty.'}\n`,
        `**Inside Jokes & Lore (${hoard.insideJokes.length}):**\n${jokesList || 'No inside jokes registered yet.'}`
    ].join('\n');
}

export function getHoardContextForPrompt() {
    const hoard = loadDinoHoard();
    const jokes = (hoard.insideJokes || []).map(j => `"${j.joke}" (${j.punchline})`).join(', ');
    const latestTreasures = (hoard.treasures || []).slice(-3).map(t => t.title).join(', ');

    return `\n[REX'S PERSONAL DINO HOARD & INSIDE JOKES]\nRex's Rank: ${hoard.rank}\nRecent treasures collected with Aditya: ${latestTreasures || 'None'}\nRunning inside jokes you can playfully reference: ${jokes || 'Short arms, meteor excuses'}\n`;
}

export async function tryHandleDinoHoardCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    // 1) View Hoard: "rex hoard", "!hoard", "dino hoard"
    if (/^(?:!hoard\b|(?:rex\s+)?(?:dino\s+hoard|show\s+hoard|view\s+hoard|my\s+hoard|hoard)\b)$/i.test(text)) {
        const summary = formatHoardSummary();
        await message.reply(summary);
        return { handled: true };
    }

    // 2) Stash a new item: "rex stash [title] : [description]" or "!stash [item]"
    const stashMatch = text.match(/^(?:!stash|(?:rex\s+)?(?:stash|stash\s+in\s+hoard))\s+([^:]+)(?::\s*(.+))?$/i);
    if (stashMatch) {
        const title = stashMatch[1].trim();
        const description = stashMatch[2] ? stashMatch[2].trim() : 'A shiny digital memory stashed in the nest.';
        const item = addTreasure({ title, description, icon: '🌟' });
        await message.reply(`🦖✨ *tucks into nest* **Added to Dino Hoard!**\n🌟 **${item.title}**: *${item.description}*`);
        return { handled: true };
    }

    // 3) Add an inside joke: "rex add joke [joke] : [punchline]"
    const jokeMatch = text.match(/^(?:!addjoke|(?:rex\s+)?(?:add\s+inside\s+joke|add\s+joke))\s+([^:]+)(?::\s*(.+))?$/i);
    if (jokeMatch) {
        const joke = jokeMatch[1].trim();
        const punchline = jokeMatch[2] ? jokeMatch[2].trim() : '';
        const item = addInsideJoke(joke, punchline);
        await message.reply(`🦖😂 *chuckles* **Inside joke recorded!**\n• "${item.joke}" added to memory.`);
        return { handled: true };
    }

    return { handled: false };
}
