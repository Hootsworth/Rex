/**
 * companionDelegates.js — Autonomous Companion & Check-in Delegate Engine for Discord
 *
 * Capabilities:
 * - Allows the bot owner to assign proactive missions to check in on friends or teammates.
 *   e.g. "check up on @username every 15 minutes as they are depressed rn"
 *   e.g. "can you text @username updates on the github tree instead of me"
 * - Periodically DMs the target user and holds ongoing empathetic conversations with them.
 * - ZERO Computer/OS Access for target users: Target users interact strictly in a
 *   sandboxed conversational mode. They cannot execute shell, AppleScript, files, or tools.
 * - Handles user opt-outs ("stop", "leave me alone") and Discord DM privacy blockers (error 50007).
 * - Full persistence across bot restarts in .rex-data/companion-delegates.json.
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import { runCompletion } from './ai.js';
import { loadConfig } from './config.js';

const execAsync = promisify(exec);
const DATA_DIR = path.join(process.cwd(), '.rex-data');
const MISSIONS_FILE = path.join(DATA_DIR, 'companion-delegates.json');

// ─── Persistence ─────────────────────────────────────────────────────────────

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    }
}

export function loadMissions() {
    ensureDataDir();
    if (!fs.existsSync(MISSIONS_FILE)) return [];
    try {
        const raw = fs.readFileSync(MISSIONS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveMissions(missions = []) {
    ensureDataDir();
    try {
        fs.writeFileSync(MISSIONS_FILE, JSON.stringify(missions, null, 2), 'utf-8');
    } catch (e) {
        console.error(pc.red(`Failed to save companion missions: ${e.message}`));
    }
}

// ─── User Resolution Helper ──────────────────────────────────────────────────

export async function resolveDiscordUser(client, targetIdentifier = '') {
    const raw = String(targetIdentifier || '').trim();
    if (!raw) return null;

    // 1) Direct Discord Mention: <@123456789> or <@!123456789>
    const mentionMatch = raw.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        try {
            return await client.users.fetch(mentionMatch[1]);
        } catch {
            return null;
        }
    }

    // 2) Pure numeric User ID
    if (/^\d{17,20}$/.test(raw)) {
        try {
            return await client.users.fetch(raw);
        } catch {
            return null;
        }
    }

    // 3) Username search across cache and all guilds
    const cleanName = raw.replace(/^@/, '').toLowerCase();

    // Check cached users
    const cached = client.users.cache.find(u =>
        u.username.toLowerCase() === cleanName ||
        (u.globalName && u.globalName.toLowerCase() === cleanName)
    );
    if (cached) return cached;

    // Search through guilds
    for (const guild of client.guilds.cache.values()) {
        try {
            const members = await guild.members.fetch({ query: cleanName, limit: 5 });
            const match = members.find(m =>
                m.user.username.toLowerCase() === cleanName ||
                (m.user.globalName && m.user.globalName.toLowerCase() === cleanName) ||
                m.displayName.toLowerCase() === cleanName
            );
            if (match) return match.user;
        } catch {}
    }

    return null;
}

// ─── Intent Parser for Companion Commands ────────────────────────────────────

export async function parseCompanionIntent(text = '') {
    const clean = String(text || '').trim();

    // 1. Check for Management Commands: List
    if (/^(?:rex\s+)?(?:companion\s+missions?|show\s+missions?|list\s+missions?|active\s+missions?)$/i.test(clean)) {
        return { action: 'list' };
    }

    // 2. Check for Management Commands: Cancel/Stop
    const cancelMatch = clean.match(/^(?:rex\s+)?(?:stop|cancel|end)\s+(?:companion\s*mission|checkup|check\s*up|mission)\s+(?:for\s+|on\s+)?(<@!?\d+>|@?[\w.-]+|all)$/i);
    if (cancelMatch) {
        return {
            action: 'cancel',
            target: cancelMatch[1]
        };
    }

    // 3. Check for Check-up / Delegation Creation
    // Matches forms like:
    // "check up on @username every 15 minutes as they are depressed rn"
    // "can you text @username updates on the github tree instead of me temporarily"
    // "text @username every 30 minutes asking how they are doing"
    const isCompanionRequest = /\b(?:check\s*up\s*on|check\s*on|text|message|ping|dm)\s+(?:<@!?\d+>|@?[\w.+/-]+)/i.test(clean) &&
        /\b(?:every|updates?|depressed|sad|doing|feeling|instead of me|temporarily|checkin|check-in|remind)\b/i.test(clean);

    if (!isCompanionRequest) {
        return null;
    }

    // Extract target identifier
    const targetMatch = clean.match(/(?:check\s*up\s*on|check\s*on|text|message|ping|dm)\s+(<@!?\d+>|@?[\w.+/-]+)/i);
    const targetRaw = targetMatch ? targetMatch[1] : '';

    // Check if iMessage is requested (explicit phrase or direct phone number)
    const isPhone = /^\+?\d{7,15}$/.test(targetRaw);
    const isIMessageExplicit = /\b(?:via|on)\s+(?:imessage|sms|text|phone)\b/i.test(clean) ||
                               /\b(?:imessage|sms)\b/i.test(clean) || isPhone;
    const channel = isIMessageExplicit ? 'imessage' : 'discord';

    // Extract interval (default: 15 minutes)
    let intervalMinutes = 15;
    const intervalMatch = clean.match(/every\s+(\d+)\s*(m|min|minutes?|h|hrs?|hours?)/i);
    if (intervalMatch) {
        const num = parseInt(intervalMatch[1], 10);
        const unit = intervalMatch[2].toLowerCase();
        intervalMinutes = unit.startsWith('h') ? num * 60 : num;
        if (intervalMinutes < 1) intervalMinutes = 1;
    }

    // Extract duration / expiry (e.g. "for 2 hours", "today")
    let durationHours = null;
    const durationMatch = clean.match(/for\s+(\d+)\s*(h|hrs?|hours?|days?)/i);
    if (durationMatch) {
        const num = parseInt(durationMatch[1], 10);
        const unit = durationMatch[2].toLowerCase();
        durationHours = unit.startsWith('d') ? num * 24 : num;
    }

    // Identify objective/topic
    let objective = clean;
    // Strip leading bot address
    objective = objective.replace(/^(?:hey\s+rex[, ]*|rex[, ]*|can\s+you\s+|please\s+)/i, '');

    return {
        action: 'create',
        targetRaw,
        channel,
        intervalMinutes,
        durationHours,
        objective
    };
}

// ─── Mission Lifecycle Management ────────────────────────────────────────────

export function getActiveMissionForTarget(targetUserId) {
    const missions = loadMissions();
    return missions.find(m => m.targetUserId === String(targetUserId) && m.status === 'active') || null;
}

export function registerMission({ creatorId, creatorTag, targetUser, intervalMinutes, durationHours, objective, channel = 'discord', targetPhone = null }) {
    const missions = loadMissions();

    // If an active mission already exists for this target, mark it replaced
    for (const m of missions) {
        if (m.targetUserId === targetUser.id && m.status === 'active') {
            m.status = 'replaced';
        }
    }

    const now = Date.now();
    const expiresAt = durationHours ? now + (durationHours * 60 * 60 * 1000) : null;

    const mission = {
        id: `mission_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        creatorId: String(creatorId),
        creatorTag: String(creatorTag || 'Bot Owner'),
        targetUserId: String(targetUser.id),
        targetTag: targetUser.username,
        targetPhone: targetPhone || targetUser.phone || null,
        channel: channel || 'discord',
        objective: String(objective).trim(),
        intervalMinutes: intervalMinutes || 15,
        createdAt: now,
        nextRunAt: now + 5000, // First check-in starts shortly (in 5s)
        expiresAt,
        lastRunAt: null,
        status: 'active',
        history: []
    };

    missions.push(mission);
    saveMissions(missions);
    return mission;
}

export function cancelMissionForTarget(targetIdentifier) {
    const missions = loadMissions();
    let cancelledCount = 0;

    const clean = String(targetIdentifier || '').trim().toLowerCase().replace(/^@/, '');

    for (const m of missions) {
        if (m.status === 'active') {
            const matchesPhone = m.targetPhone && (
                m.targetPhone.toLowerCase() === clean ||
                m.targetPhone.replace(/\D/g, '') === clean.replace(/\D/g, '')
            );
            if (clean === 'all' || m.targetUserId === clean || m.targetTag.toLowerCase() === clean || matchesPhone) {
                m.status = 'cancelled';
                cancelledCount++;
            }
        }
    }

    if (cancelledCount > 0) saveMissions(missions);
    return cancelledCount;
}

// ─── Proactive Execution Engine ──────────────────────────────────────────────

let engineTimer = null;

export function startCompanionEngine(client) {
    if (engineTimer) clearInterval(engineTimer);

    // Heartbeat every 30 seconds
    engineTimer = setInterval(async () => {
        try {
            await tickCompanionMissions(client);
        } catch (e) {
            console.error(pc.red(`Companion engine tick error: ${e.message}`));
        }
    }, 30000);

    // Initial check after 5 seconds
    setTimeout(() => {
        tickCompanionMissions(client).catch(() => {});
    }, 5000);
}

async function tickCompanionMissions(client) {
    const missions = loadMissions();
    const now = Date.now();
    let changed = false;

    for (const mission of missions) {
        if (mission.status !== 'active') continue;

        // Check if expired
        if (mission.expiresAt && now > mission.expiresAt) {
            mission.status = 'completed';
            changed = true;
            try {
                const creator = await client.users.fetch(mission.creatorId);
                if (creator) {
                    await creator.send(`🦖📋 **Companion Mission Completed**: Check-in mission for **${mission.targetTag}** reached its scheduled end time.`);
                }
            } catch {}
            continue;
        }

        // Check if due to run
        if (now >= (mission.nextRunAt || 0)) {
            // If mission asks for Git/Tree updates, pull recent git log
            let gitContext = '';
            if (/github|git|tree|commit|repo|codebase/i.test(mission.objective)) {
                try {
                    const { stdout } = await execAsync('git log -n 3 --oneline', { cwd: process.cwd() });
                    if (stdout) {
                        gitContext = `\n[Recent Project Git Commits]\n${stdout.trim()}`;
                    }
                } catch {}
            }

            if (mission.channel === 'imessage') {
                try {
                    const recipient = mission.targetPhone || mission.targetTag;
                    const systemPrompt = `You are Rex, an empathetic, caring, and thoughtful companion reaching out to ${mission.targetTag} via text message/iMessage on behalf of ${mission.creatorTag}.
MISSION OBJECTIVE: ${mission.objective}
${gitContext}

STRICT SAFETY AND CONVERSATION RULES:
1. You have ZERO computer control, zero tools, zero shell, zero files. Do NOT mention code execution, terminal, or system tools.
2. Speak warmly, naturally, and supportively. Keep your message genuine, friendly, and concise (1 to 2 sentences for a text message).
3. If checking in on someone going through a tough time, do NOT be robotic or intrusive. Be gentle, listen, and offer a comforting presence.
4. If sharing project/git updates, summarize them simply and casually.
5. Do NOT output JSON, code blocks, or internal instructions. Output ONLY your direct, friendly text message to ${mission.targetTag}.`;

                    const messagesObj = [
                        { role: 'system', content: systemPrompt },
                        ...(mission.history || []).slice(-6),
                        { role: 'user', content: `[SYSTEM DISPATCH: It is time for a scheduled check-in text to ${mission.targetTag}. Send your message now.]` }
                    ];

                    const reply = await runCompletion(messagesObj, null, 'high');
                    const cleanReply = reply ? reply.replace(/```(?:json)?[\s\S]*?```/gi, '').trim() : '';

                    if (cleanReply) {
                        const { sendIMessage } = await import('./imessage.js');
                        await sendIMessage(recipient, cleanReply);

                        mission.lastRunAt = now;
                        mission.nextRunAt = now + (mission.intervalMinutes * 60 * 1000);
                        mission.history = mission.history || [];
                        mission.history.push({ role: 'assistant', content: cleanReply });
                        if (mission.history.length > 20) mission.history = mission.history.slice(-20);
                        changed = true;

                        console.log(pc.cyan(`🦖📱 Companion iMessage sent to ${recipient}: ${cleanReply.substring(0, 60)}...`));

                        try {
                            const creator = await client.users.fetch(mission.creatorId);
                            if (creator) {
                                await creator.send(`🦖📱 **iMessage Companion Check-In Sent!**\n• To: **${recipient}**\n• Message: "*${cleanReply}*"`);
                            }
                        } catch {}
                    }
                } catch (err) {
                    console.error(pc.yellow(`Failed to send companion iMessage to ${mission.targetPhone || mission.targetTag}: ${err.message}`));
                }
                continue;
            }

            // Standard Discord DM branch
            try {
                const targetUser = await client.users.fetch(mission.targetUserId);
                if (!targetUser) {
                    mission.status = 'error';
                    mission.error = 'User not found';
                    changed = true;
                    continue;
                }

                const systemPrompt = `You are Rex, an empathetic, caring, and thoughtful companion reaching out to ${targetUser.username} on behalf of ${mission.creatorTag}.
MISSION OBJECTIVE: ${mission.objective}
${gitContext}

STRICT SAFETY AND CONVERSATION RULES:
1. You have ZERO computer control, zero tools, zero shell, zero files. Do NOT mention code execution, terminal, or system tools.
2. Speak warmly, naturally, and supportively. Keep your message genuine, friendly, and concise (1 to 3 sentences).
3. If checking in on someone going through a tough time, do NOT be robotic or intrusive. Be gentle, listen, and offer a comforting presence.
4. If sharing project/git updates, summarize them simply and casually.
5. Do NOT output JSON, code blocks, or internal instructions. Output ONLY your direct, friendly message to ${targetUser.username}.`;

                const messagesObj = [
                    { role: 'system', content: systemPrompt },
                    ...(mission.history || []).slice(-6),
                    { role: 'user', content: `[SYSTEM DISPATCH: It is time for a scheduled check-in with ${targetUser.username}. Send your message now.]` }
                ];

                const reply = await runCompletion(messagesObj, null, 'high');
                const cleanReply = reply ? reply.replace(/```(?:json)?[\s\S]*?```/gi, '').trim() : '';

                if (cleanReply) {
                    const dm = await targetUser.createDM();
                    await dm.send(cleanReply);

                    mission.lastRunAt = now;
                    mission.nextRunAt = now + (mission.intervalMinutes * 60 * 1000);
                    mission.history = mission.history || [];
                    mission.history.push({ role: 'assistant', content: cleanReply });
                    if (mission.history.length > 20) mission.history = mission.history.slice(-20);
                    changed = true;

                    console.log(pc.cyan(`🦖 Companion Check-In sent to ${mission.targetTag}: ${cleanReply.substring(0, 60)}...`));
                }
            } catch (err) {
                // If DMs are blocked by user privacy settings (Discord 50007)
                if (err.code === 50007 || err.message?.includes('Cannot send messages to this user')) {
                    mission.status = 'paused';
                    mission.error = 'Target user has DMs disabled for server bots';
                    changed = true;

                    try {
                        const creator = await client.users.fetch(mission.creatorId);
                        if (creator) {
                            await creator.send(`🦖⚠️ **Companion Mission Paused**: I couldn't DM **${mission.targetTag}** because their Discord privacy settings block DMs from server bots.`);
                        }
                    } catch {}
                } else {
                    console.error(pc.yellow(`Failed to send companion check-in to ${mission.targetTag}: ${err.message}`));
                }
            }
        }
    }

    if (changed) saveMissions(missions);
}

// ─── Target User Message Handler (Strict Zero-Tool Sandbox) ──────────────────

export async function handleTargetUserMessage(message, cleanContent, client) {
    // Only applies in DMs
    if (!message.channel.isDMBased()) return { handled: false };

    const mission = getActiveMissionForTarget(message.author.id);
    if (!mission) return { handled: false };

    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: true };

    // 1) Opt-out check: If the target user wants the bot to stop messaging them
    if (/^(?:stop|cancel|opt\s*out|leave\s*me\s*alone|unsubscribe|don't\s*(?:message|text)\s*me|go\s*away)\b/i.test(text)) {
        mission.status = 'cancelled';
        saveMissions(loadMissions().map(m => m.id === mission.id ? { ...m, status: 'cancelled' } : m));

        await message.reply("Understood! I'll stop checking in. Wishing you the absolute best! 🦖💚");

        try {
            const creator = await client.users.fetch(mission.creatorId);
            if (creator) {
                await creator.send(`🦖ℹ️ **${mission.targetTag}** opted out of the check-in mission by saying "*${text}*". I have stopped the mission.`);
            }
        } catch {}

        return { handled: true };
    }

    // 2) Conversational Response: Strict Sandboxed LLM Turn
    try {
        await message.channel.sendTyping().catch(() => {});

        const systemPrompt = `You are Rex, an empathetic, caring, and thoughtful companion talking with ${message.author.username} in Discord DMs.
ORIGINAL CONTEXT/REASON FOR REACHING OUT: ${mission.objective}
CREATOR WHO SENT YOU: ${mission.creatorTag}

STRICT CONVERSATIONAL BOUNDARIES:
1. You have ZERO computer control, zero tools, zero shell, zero files. Do NOT execute or talk about computer tools.
2. Listen to them, acknowledge what they say with empathy, warmth, and sincerity.
3. Keep the conversation natural, friendly, and supportive (1-3 paragraphs maximum).
4. Do NOT output JSON, code blocks, or internal commands under any circumstances.`;

        mission.history = mission.history || [];
        mission.history.push({ role: 'user', content: text });

        const messagesObj = [
            { role: 'system', content: systemPrompt },
            ...mission.history.slice(-10)
        ];

        const reply = await runCompletion(messagesObj, null, 'high');
        const cleanReply = reply ? reply.replace(/```(?:json)?[\s\S]*?```/gi, '').trim() : '';

        if (cleanReply) {
            await message.reply(cleanReply);
            mission.history.push({ role: 'assistant', content: cleanReply });
            if (mission.history.length > 25) mission.history = mission.history.slice(-25);
            saveMissions(loadMissions().map(m => m.id === mission.id ? mission : m));
        }
    } catch (e) {
        console.error(pc.red(`Target conversation error: ${e.message}`));
        await message.reply("I hear you. I'm right here if you want to chat. 🦖").catch(() => {});
    }

    return { handled: true };
}

// ─── Bot Owner / Creator Command Handler ─────────────────────────────────────

export async function tryHandleCompanionCommand({ message, cleanContent, client, config }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    const parsed = await parseCompanionIntent(text);
    if (!parsed) return { handled: false };

    // 1) List Active Missions
    if (parsed.action === 'list') {
        const missions = loadMissions().filter(m => m.status === 'active');
        if (missions.length === 0) {
            await message.reply("🦖 There are no active companion missions right now.");
        } else {
            const lines = missions.map((m, idx) => {
                const nextMin = Math.max(1, Math.round((m.nextRunAt - Date.now()) / 60000));
                const channelBadge = m.channel === 'imessage' ? '📱 iMessage' : '💬 Discord DM';
                const targetDisplay = m.channel === 'imessage' ? (m.targetPhone || m.targetTag) : `@${m.targetTag}`;
                return `**${idx + 1}. ${targetDisplay}** (${channelBadge})\n• Objective: *${m.objective}*\n• Interval: Every ${m.intervalMinutes}m (Next check-in in ~${nextMin}m)\n• Status: Active`;
            });
            await message.reply(`🦖📋 **Active Companion Missions (${missions.length})**:\n\n${lines.join('\n\n')}`);
        }
        return { handled: true };
    }

    // 2) Cancel Mission
    if (parsed.action === 'cancel') {
        const count = cancelMissionForTarget(parsed.target);
        if (count > 0) {
            await message.reply(`✅ Cancelled ${count} companion mission(s) for **${parsed.target}**.`);
        } else {
            await message.reply(`No active companion mission found for **${parsed.target}**.`);
        }
        return { handled: true };
    }

    // 3) Create New Mission
    if (parsed.action === 'create') {
        let channel = parsed.channel || 'discord';
        let targetUser = null;
        let targetPhone = null;

        if (channel === 'imessage') {
            const phoneMatch = text.match(/(?:at|to|phone|number)\s+(\+?\d{7,15})/i);
            targetPhone = phoneMatch ? phoneMatch[1] : (/^\+?\d{7,15}$/.test(parsed.targetRaw) ? parsed.targetRaw : null);
            targetUser = {
                id: `imessage_${(targetPhone || parsed.targetRaw).replace(/[^\w]/g, '_')}`,
                username: parsed.targetRaw,
                phone: targetPhone || parsed.targetRaw
            };
        } else {
            targetUser = await resolveDiscordUser(client, parsed.targetRaw);
            // If not found in Discord, check if target looks like a phone number
            if (!targetUser) {
                if (/^\+?\d{7,15}$/.test(parsed.targetRaw)) {
                    channel = 'imessage';
                    targetPhone = parsed.targetRaw;
                    targetUser = {
                        id: `imessage_${targetPhone.replace(/[^\w]/g, '_')}`,
                        username: parsed.targetRaw,
                        phone: targetPhone
                    };
                } else {
                    await message.reply(`❌ I couldn't find a user matching "${parsed.targetRaw}". Please make sure they share a server with me, or @mention them directly. (If this is an iMessage contact or phone number, specify "via iMessage" or provide their phone number).`);
                    return { handled: true };
                }
            }
        }

        if (targetUser.id === message.author.id) {
            await message.reply("You can't assign a companion check-in mission to yourself! Mention someone else. 🦖");
            return { handled: true };
        }

        const mission = registerMission({
            creatorId: message.author.id,
            creatorTag: message.author.username,
            targetUser,
            intervalMinutes: parsed.intervalMinutes,
            durationHours: parsed.durationHours,
            objective: parsed.objective,
            channel,
            targetPhone: targetPhone || targetUser.phone
        });

        const durationDesc = parsed.durationHours ? ` for the next ${parsed.durationHours} hours` : '';
        const channelDesc = channel === 'imessage'
            ? `• Delivery: **iMessage / SMS** via macOS Messages to \`${targetUser.phone || targetUser.username}\`\n• Creator Updates: You'll receive live notifications here in Discord whenever a text is sent.`
            : `• Delivery: **Discord Direct Message**\n• Privacy Sandbox: **Zero computer control enabled.** All interactions with them will be strictly conversational.`;

        await message.reply([
            `🦖🤝 **Companion Mission Started!**`,
            `• Target: **${channel === 'discord' ? '@' : ''}${targetUser.username}**`,
            `• Schedule: Checking in every **${parsed.intervalMinutes} minutes**${durationDesc}`,
            `• Mission: *"${parsed.objective}"*`,
            channelDesc,
            `• Note: First check-in will dispatch in a few moments!`
        ].join('\n'));

        return { handled: true };
    }

    return { handled: false };
}
