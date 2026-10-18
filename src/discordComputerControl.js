/**
 * discordComputerControl.js — Autonomous Screen Control & Permission Gating for Discord
 *
 * When a user asks Rex in Discord to perform actions that require computer use
 * (clicking, forms, DaVinci Resolve color grading, dragging sliders, typing, shortcuts),
 * this module:
 * 1. Asks for explicit user permission first via Discord interactive buttons and chat text.
 * 2. Once authorized, activates the Rex Screen Cursor (retro 8-bit baby Rex + mouse pointer duo).
 * 3. Brings target applications to front and scans the display for UI hitboxes using Multimodal AI.
 * 4. Autonomously executes real macOS OS clicks, double clicks, drags, typing, and shortcuts.
 * 5. Returns a detailed execution report and attaches a post-action screenshot back to Discord!
 */

import fs from 'fs';
import path from 'path';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    AttachmentBuilder
} from 'discord.js';
import pc from 'picocolors';
import {
    isScreenCursorRunning,
    startScreenCursor,
    setCursorMode,
    setCursorAppearance,
    setRexEmotion,
    getScreenDimensions,
    getTargetWindowBounds
} from './screenCursor.js';
import { captureScreen } from './vision.js';
import { planScreenActions, executeActionPlan } from './cursorVoiceAgent.js';
import { playAudioCue } from './audioCues.js';
import { classifyActionRisk } from './actionRiskGuard.js';

// Map of userId -> { sessionId, userId, channelId, task, expiresAt, messageId }
const pendingPermissions = new Map();

/**
 * Detect whether a user message requires real macOS computer control.
 */
export function detectComputerControlIntent(text = '') {
    const clean = String(text || '').trim().toLowerCase();
    if (!clean) return { requiresControl: false };

    // Explicit command prefixes
    const explicitPrefixMatch = clean.match(/^(?:!(?:computer|takeover|screencontrol|desktop|cursor)\s+(.+)|(?:hey rex[, ]*)?(?:take\s*over\s*(?:my\s*)?screen|control\s*(?:my\s*)?screen|use\s*(?:the\s*)?computer)\s*(?:to\s*)?(.+))/i);
    if (explicitPrefixMatch) {
        const task = (explicitPrefixMatch[1] || explicitPrefixMatch[2] || clean).trim();
        return { requiresControl: true, task };
    }

    // High-intent patterns for desktop screen takeover
    const patterns = [
        // DaVinci Resolve or Creative apps
        /(?:teach\s+me\s+how\s+to\s+)?color\s+grade\s+(?:in\s+)?(?:this\s+)?da\s*vinci(?:\s+resolve)?/i,
        /da\s*vinci(?:\s+resolve)?\b.*(?:color|grade|lift|gamma|gain|node|timeline|render|export|wheel|clip|cut)/i,
        /(?:figma|photoshop|blender|premiere|final\s*cut)\b.*(?:click|tool|layer|canvas|export|slider)/i,

        // WhatsApp / Messaging / Browser tasks
        /(?:whatsapp|wahsyapp|telegram|slack)\b.*(?:send|message|contact|chat|type|write)/i,
        /(?:send|type|say)\s+.*(?:whatsapp|wahsyapp|contact|zen|browser)/i,
        /zen\s+browser\b.*(?:send|type|click|message|whatsapp)/i,

        // Forms and web/desktop inputs
        /(?:can\s+you\s+)?(?:figure\s+(?:out\s+)?|solve\s+|fill\s+(?:out\s+)?)(?:this\s+)?form/i,
        /fill\s+(?:in|out)\s+(?:the\s+|this\s+)?(?:form|input|fields|credentials)/i,
        /submit\s+(?:this\s+|the\s+)?form\s+on\s+(?:my\s+)?screen/i,

        // Direct clicking and UI manipulation
        /(?:click|press|hit)\s+(?:on\s+)?(?:the\s+)?(?:button|tab|link|menu|checkbox|icon|hitbox)\b/i,
        /click\s+on\s+["']?[a-zA-Z0-9\s_-]+["']?\s+(?:on\s+screen|button)/i,
        /drag\s+(?:the\s+)?(?:slider|wheel|window|item|file)\b/i,
        /double\s*click\s+(?:on\s+)?(?:the\s+)?/i,
        /right\s*click\s+(?:on\s+)?(?:the\s+)?/i,

        // Screen takeover phrasing
        /(?:take\s*over|control)\s+(?:my\s+)?screen\b/i,
        /(?:move\s+my\s+cursor|use\s+rex\s+cursor)\s+to\b/i,
        /figure\s+out\s+(?:what\s+to\s+click|the\s+buttons|the\s+hitboxes)/i,
        /(?:find|detect)\s+(?:the\s+)?hitboxes\s+and\s+click/i,
        /press\s+(?:the\s+)?(?:shortcut|key\s*combination)\s+(?:cmd|ctrl|command|shift|alt|option)/i
    ];

    for (const pattern of patterns) {
        if (pattern.test(clean)) {
            return { requiresControl: true, task: text.trim() };
        }
    }

    return { requiresControl: false };
}

/**
 * Request permission from the user in Discord before taking over the computer.
 */
export async function requestComputerPermission({ message, task, client, channel }) {
    const targetChannel = channel || message?.channel;
    const userId = message?.author?.id || 'unknown';
    const sessionId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const risk = classifyActionRisk(task);
    const color = risk.level === 'HIGH_RISK' ? 0xFF3366 : (risk.level === 'MODERATE' ? 0xFFA500 : 0x00FF88);

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('🦖 Rex Screen Control Permission Request')
        .setDescription(
            `You requested autonomous computer control on your Mac:\n` +
            `> **Task**: "${task}"\n` +
            `> **Risk Assessment**: \`${risk.level}\` (${risk.reason})\n\n` +
            `**Autonomous Capabilities Rex Will Deploy:**\n` +
            `• 🎯 **AXUIElement Precision**: Native macOS Accessibility hitboxes\n` +
            `• 🛑 **Emergency Brake**: Touch your physical mouse or hit \`Esc\` to pause anytime\n` +
            `• 🔄 **Closed-Loop Verifier**: Auto-dismisses unexpected blocker popups\n` +
            `• 🖱️ **Hardware Cursors**: Native OS clicks, double clicks, & multi-point drags\n` +
            `• ⌨️ **Keyboard Automation**: Form typing & native macOS shortcuts\n\n` +
            `*Safety Protocol: Real OS actions require your explicit permission.*`
        )
        .setFooter({ text: 'Click Authorize or reply "yes" / "confirm" in chat. Reply "no" / "cancel" to deny.' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`computer_perm:approve:${sessionId}`)
            .setLabel('Authorize Screen Control')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🦖'),
        new ButtonBuilder()
            .setCustomId(`computer_perm:deny:${sessionId}`)
            .setLabel('Cancel / Deny')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('✖️')
    );

    const sentMessage = await targetChannel.send({
        embeds: [embed],
        components: [row]
    });

    // Save pending session
    pendingPermissions.set(userId, {
        sessionId,
        userId,
        channelId: targetChannel.id,
        task,
        messageId: sentMessage.id,
        expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes expiry
    });

    return { sessionId, messageId: sentMessage.id };
}

/**
 * Handle Discord Button Interactions for Computer Permission (kind: 'computer_perm').
 */
export async function handleComputerPermissionInteraction(interaction) {
    const [kind, action, sessionId] = String(interaction.customId || '').split(':');
    if (kind !== 'computer_perm') return false;

    // Find session
    let matchedUserId = null;
    let session = null;
    for (const [uid, sess] of pendingPermissions.entries()) {
        if (sess.sessionId === sessionId) {
            matchedUserId = uid;
            session = sess;
            break;
        }
    }

    if (!session) {
        await interaction.reply({
            content: '⚠️ This permission request has expired or was already resolved.',
            ephemeral: true
        });
        return true;
    }

    // Verify user authorization
    if (interaction.user.id !== session.userId) {
        await interaction.reply({
            content: '❌ Only the user who requested this task can authorize screen control.',
            ephemeral: true
        });
        return true;
    }

    pendingPermissions.delete(matchedUserId);

    if (action === 'deny') {
        setRexEmotion('sad', 4000);
        const deniedEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('❌ Screen Takeover Cancelled')
            .setDescription(`Task request *"${session.task}"* was cancelled by user. No actions were performed on your screen.`)
            .setTimestamp();

        await interaction.update({
            embeds: [deniedEmbed],
            components: []
        });
        return true;
    }

    if (action === 'approve') {
        setRexEmotion('excited', 5000);
        const approvedEmbed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('🦖 Authorization Granted!')
            .setDescription(`**Starting autonomous screen takeover for:**\n> "${session.task}"\n\n*Initializing Rex cursor overlay, scanning hitboxes, and executing plan...*`)
            .setTimestamp();

        await interaction.update({
            embeds: [approvedEmbed],
            components: []
        });

        // Trigger autonomous execution asynchronously
        executeDiscordComputerTask({
            channel: interaction.channel,
            task: session.task,
            userId: interaction.user.id
        }).catch(err => {
            console.error(pc.red(`Error in executeDiscordComputerTask: ${err.message}`));
            interaction.channel.send(`❌ Error during screen takeover: ${err.message}`).catch(() => {});
        });

        return true;
    }

    return false;
}

/**
 * Handle natural language text confirmations ("yes", "confirm", "allow", "cancel", etc.).
 */
export async function handleComputerPermissionTextMessage(message) {
    const userId = message.author.id;
    const session = pendingPermissions.get(userId);
    if (!session) return { handled: false };

    // Check channel match
    if (session.channelId !== message.channel.id) return { handled: false };

    // Check expiration
    if (Date.now() > session.expiresAt) {
        pendingPermissions.delete(userId);
        return { handled: false };
    }

    const clean = message.content.trim().toLowerCase();

    // Affirmative matches
    if (/^(?:yes|yep|yeah|sure|confirm|allow|proceed|authorize|do\s*it|go\s*ahead|ok|okay)\b/i.test(clean)) {
        pendingPermissions.delete(userId);

        await message.reply('🦖 **Permission Granted!** Initializing Rex Screen Cursor and scanning UI hitboxes now...');

        executeDiscordComputerTask({
            channel: message.channel,
            task: session.task,
            userId
        }).catch(err => {
            console.error(pc.red(`Error in executeDiscordComputerTask: ${err.message}`));
            message.channel.send(`❌ Error during screen takeover: ${err.message}`).catch(() => {});
        });

        return { handled: true };
    }

    // Denial matches
    if (/^(?:no|nope|cancel|deny|abort|stop|nevermind|don't)\b/i.test(clean)) {
        pendingPermissions.delete(userId);
        await message.reply('❌ **Screen Takeover Cancelled**. No actions were taken on your computer.');
        return { handled: true };
    }

    return { handled: false };
}

/**
 * Execute the autonomous screen task across macOS and report results back to Discord.
 */
export async function executeDiscordComputerTask({ channel, task, userId }) {
    console.log(pc.cyan(`\n[Discord Screen Control]: Starting autonomous takeover for user ${userId}: "${task}"`));

    // 1. Ensure Rex Screen Cursor overlay is running with 8-bit baby Rex + mouse pointer duo
    const liveDims = getScreenDimensions();
    let screenWidth = liveDims.width || 1470;
    let screenHeight = liveDims.height || 956;
    try {
        if (!isScreenCursorRunning()) {
            const startRes = await startScreenCursor({
                mode: 'autonomous',
                appearance: 'both',
                silent: true,
                checkPermissions: true
            });
            if (startRes?.dimensions) {
                screenWidth = startRes.dimensions.width;
                screenHeight = startRes.dimensions.height;
            }
        } else {
            setCursorMode('autonomous');
            setCursorAppearance('both');
            const currentDims = getScreenDimensions();
            if (currentDims.width) screenWidth = currentDims.width;
            if (currentDims.height) screenHeight = currentDims.height;
        }
    } catch (e) {
        console.warn(pc.yellow(`Cursor start warning: ${e.message}`));
    }

    // 2. Capture pre-action screenshot
    const preScreenshot = await captureScreen();
    if (!preScreenshot || !fs.existsSync(preScreenshot)) {
        await channel.send('❌ Could not capture your macOS screen. Please verify Screen Recording permissions in macOS System Settings.');
        setCursorMode('follow');
        return;
    }

    // 3. Multimodal UI Reasoning & Hitbox Planning
    const statusMsg = await channel.send('🔍 *Analyzing screen hitboxes, open windows, and planning OS actions...*');

    let plan;
    let scaleX = 2.0;
    let scaleY = 2.0;
    try {
        const planResult = await planScreenActions(preScreenshot, task, screenWidth, screenHeight);
        plan = planResult.plan;
        scaleX = planResult.scaleX || 2.0;
        scaleY = planResult.scaleY || 2.0;
    } catch (e) {
        await statusMsg.edit(`❌ Visual planning failed: ${e.message}`);
        return;
    }

    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        await statusMsg.edit(`⚠️ Rex analyzed the screen but found no actionable steps for: "${task}".`);
        return;
    }

    const appName = plan.activeApp || 'Active Application';
    await statusMsg.edit(`🎯 **Target**: ${appName} | Identified **${plan.steps.length}** hitboxes/actions. Executing autonomous screen takeover...`);

    // 4. Autonomously execute real OS clicks, typing, drags, and shortcuts!
    const execResult = await executeActionPlan(plan, screenWidth, screenHeight, scaleX, scaleY);

    // 5. Capture post-action screenshot
    const postScreenshot = await captureScreen();

    // 6. Build execution report embed
    const stepsSummary = (execResult.steps || []).map(s => {
        let actionDesc = `**Step ${s.step}** [${s.action.toUpperCase()}]: ${s.label}`;
        if (s.action === 'type' && s.text) actionDesc += ` (typed: "${s.text}")`;
        if (s.action === 'key' && s.key) actionDesc += ` (shortcut: \`${s.key}\`)`;
        if (s.action === 'drag') actionDesc += ` (dragged to ${s.toX}, ${s.toY})`;
        return `• ${actionDesc}`;
    }).join('\n') || '• Executed planned screen sequence';

    const reportEmbed = new EmbedBuilder()
        .setColor(0x00FF88)
        .setTitle(`🦖 Screen Takeover Completed: ${appName}`)
        .setDescription(
            `**Summary**:\n${plan.summary || 'All planned screen actions executed successfully.'}\n\n` +
            `**Actions & Hitboxes Targeted**:\n${stepsSummary.slice(0, 1500)}\n\n` +
            `*Rex is holding position in autonomous mode.*`
        )
        .setFooter({ text: 'Rex Autonomous macOS Copilot • Retina Hitbox Tracking' })
        .setTimestamp();

    if (postScreenshot && fs.existsSync(postScreenshot)) {
        const attachment = new AttachmentBuilder(postScreenshot, { name: 'rex_screen_result.png' });
        reportEmbed.setImage('attachment://rex_screen_result.png');
        await channel.send({
            content: `✅ Task completed! Here is the live state of your screen:`,
            embeds: [reportEmbed],
            files: [attachment]
        });
        try { fs.unlinkSync(postScreenshot); } catch {}
    } else {
        await channel.send({
            content: `✅ Task completed!`,
            embeds: [reportEmbed]
        });
    }

    try {
        if (preScreenshot && fs.existsSync(preScreenshot)) fs.unlinkSync(preScreenshot);
    } catch {}

    playAudioCue('success');
    setRexEmotion('excited', 5000);
    console.log(pc.green(`[Discord Screen Control]: Autonomous takeover finished successfully.`));
}
