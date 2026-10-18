/**
 * burnoutSentinel.js — Late-Night Work Rhythm & Burnout Protection for Rex
 *
 * Capabilities:
 * - Monitors late-night coding/activity between midnight and 5:00 AM
 * - Gently prompts you to hydrate, stretch, and rest
 * - Automatically softens Mac volume or sets atmospheric chill music via AppleScript
 * - Non-intrusive: enforces a strict 1-alert-per-night cooldown so it never spams
 * - Configurable via "rex burnout on/off/status"
 */

import fs from 'fs';
import path from 'path';
import pc from 'picocolors';

const DATA_DIR = path.join(process.cwd(), '.rex-data');
const STATE_FILE = path.join(DATA_DIR, 'burnout_state.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    }
}

export function loadBurnoutState() {
    ensureDataDir();
    if (!fs.existsSync(STATE_FILE)) {
        return {
            enabled: true,
            lastActivityAt: Date.now(),
            lastAlertDate: null
        };
    }
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return { enabled: true, lastActivityAt: Date.now(), lastAlertDate: null };
    }
}

export function saveBurnoutState(state) {
    ensureDataDir();
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
        console.error(pc.red(`Failed to save burnout state: ${e.message}`));
    }
}

export function recordUserActivity() {
    const state = loadBurnoutState();
    state.lastActivityAt = Date.now();
    saveBurnoutState(state);
}

let sentinelTimer = null;

export function startBurnoutSentinel(client) {
    if (sentinelTimer) clearInterval(sentinelTimer);

    // Check every 15 minutes
    sentinelTimer = setInterval(async () => {
        try {
            await checkBurnoutRisk(client);
        } catch (e) {
            console.error(pc.red(`Burnout sentinel tick failed: ${e.message}`));
        }
    }, 15 * 60 * 1000);
}

export async function checkBurnoutRisk(client) {
    const state = loadBurnoutState();
    if (state.enabled === false) return;

    const now = new Date();
    const currentHour = now.getHours(); // 0 to 23

    // Late-night window: Midnight (0) through 5:00 AM (4)
    const isLateNight = currentHour >= 0 && currentHour < 5;
    if (!isLateNight) return;

    // Check if user was active within the last 45 minutes
    const msSinceActivity = Date.now() - (state.lastActivityAt || 0);
    const wasActiveRecently = msSinceActivity < 45 * 60 * 1000;
    if (!wasActiveRecently) return;

    // Check if alert was already sent tonight
    const todayStr = now.toISOString().split('T')[0];
    if (state.lastAlertDate === todayStr) return;

    // Trigger Late-Night Sentinel Alert!
    state.lastAlertDate = todayStr;
    saveBurnoutState(state);

    // Gently lower Mac volume to a relaxing 35%
    try {
        const { macSystem } = await import('./appleScript.js');
        await macSystem.setVolume(35);
    } catch {}

    const friendlyMessages = [
        `🦖🌙 **Burnout Sentinel**: Hey! It's past ${currentHour === 0 ? 'midnight' : `${currentHour}:00 AM`} and you're still hard at work. Drink some water, take a deep stretch, and consider pushing that commit and hitting the hay. The bugs will wait for you tomorrow! 💤`,
        `🦖☕ *pokes in gently* Hey Aditya, it's late night (${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}). You've put in a solid session. Don't push yourself past empty—sleep on it and you'll solve it in 5 minutes tomorrow! 🌙`,
        `🦖💤 **Late Night Sentinel**: Soft reminder that great engineers prioritize rest too. I've lowered your speakers to a chill level. Wrap up your thought, push your branch, and get some good rest! 🦖💚`
    ];

    const alertText = friendlyMessages[Math.floor(Math.random() * friendlyMessages.length)];

    // Send to bot owner via DM or active channel
    try {
        const { loadConfig } = await import('./config.js');
        const config = loadConfig();
        const allowedIds = Array.isArray(config.discordAllowedUserIds) ? config.discordAllowedUserIds : [];
        const ownerId = allowedIds.find(id => id && id !== '*');

        if (ownerId) {
            const owner = await client.users.fetch(ownerId);
            if (owner) {
                await owner.send(alertText);
                console.log(pc.cyan(`🦖 Burnout Sentinel sent late-night rest reminder to owner.`));
            }
        }
    } catch (e) {
        console.error(pc.yellow(`Failed to dispatch burnout reminder: ${e.message}`));
    }
}

export async function tryHandleBurnoutCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim().toLowerCase();
    if (!text.startsWith('rex burnout') && !text.startsWith('!burnout')) return { handled: false };

    const parts = text.split(/\s+/);
    const sub = parts[2] || parts[1] || 'status';

    const state = loadBurnoutState();

    if (sub === 'on' || sub === 'enable') {
        state.enabled = true;
        saveBurnoutState(state);
        await message.reply("🦖🌙 **Burnout Sentinel is ON**. I'll watch your back during late-night coding sessions past midnight and make sure you don't burn out!");
        return { handled: true };
    }

    if (sub === 'off' || sub === 'disable') {
        state.enabled = false;
        saveBurnoutState(state);
        await message.reply("🦖 **Burnout Sentinel is OFF**. Late-night alerts paused.");
        return { handled: true };
    }

    await message.reply(`🦖🌙 **Burnout Sentinel Status**: ${state.enabled ? '🟢 Active' : '🔴 Disabled'}\n• Active Window: 12:00 AM – 5:00 AM\n• Behavior: Lowers volume, reminds you to hydrate & sleep\n• Use: \`rex burnout on\` or \`rex burnout off\``);
    return { handled: true };
}
