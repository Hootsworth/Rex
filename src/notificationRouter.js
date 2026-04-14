/**
 * notificationRouter.js — Smart Notification Routing
 *
 * Routes notifications to the right channel based on urgency and
 * platform availability. No AI calls — pure routing logic.
 *
 * Credit Policy: ZERO AI calls. This module only dispatches messages
 * to already-configured channels (Discord webhook, Telegram, toast, email).
 *
 * Opt-in: rexai open → Labs → Notification Router
 */

import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig, saveConfig } from './config.js';

// ─── Urgency Levels ──────────────────────────────────────────────────────────

export const URGENCY = {
    CRITICAL: 'critical',   // Build failed, server down — all channels + sound
    IMPORTANT: 'important', // PR ready, task complete — primary channel
    INFO: 'info'            // Digest, tips — passive/deferred
};

// ─── Channel Senders ─────────────────────────────────────────────────────────

async function sendToDiscordWebhook(config, message) {
    const webhookUrl = config.discordWebhookUrl;
    if (!webhookUrl) return { ok: false, reason: 'Discord webhook not configured' };

    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `🦖 ${message}` })
        });
        return { ok: res.ok, reason: res.ok ? '' : `HTTP ${res.status}` };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function sendToTelegramChat(config, message) {
    const token = config.telegramBotToken;
    const chatId = config.telegramNotifyChatId;
    if (!token || !chatId) return { ok: false, reason: 'Telegram bot token or chat ID not configured' };

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: `🦖 ${message}`, parse_mode: 'Markdown' })
        });
        return { ok: res.ok, reason: res.ok ? '' : `HTTP ${res.status}` };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function sendWindowsToast(message) {
    if (process.platform !== 'win32') return { ok: false, reason: 'Not Windows' };

    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const title = 'RexAI';
    const escapedMessage = message.replace(/'/g, "''").slice(0, 200);
    const psScript = `
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $textElements = $template.GetElementsByTagName("text")
        $textElements[0].AppendChild($template.CreateTextNode('${title}')) > $null
        $textElements[1].AppendChild($template.CreateTextNode('${escapedMessage}')) > $null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("RexAI").Show($toast)
    `;

    try {
        await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, {
            timeout: 10000,
            windowsHide: true
        });
        return { ok: true, reason: '' };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function sendEmail(config, subject, message) {
    if (!config.smtpHost || !config.smtpUser) return { ok: false, reason: 'SMTP not configured' };

    try {
        const { sendEmailNotification } = await import('./email.js');
        await sendEmailNotification(subject, message);
        return { ok: true, reason: '' };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// ─── Router Logic ────────────────────────────────────────────────────────────

const CHANNEL_HANDLERS = {
    discord: sendToDiscordWebhook,
    telegram: sendToTelegramChat,
    toast: async (config, msg) => sendWindowsToast(msg),
    email: async (config, msg) => sendEmail(config, 'RexAI Notification', msg)
};

/**
 * Route a notification to the appropriate channels based on urgency.
 * Zero AI calls. Pure routing logic.
 *
 * @param {string} message   - The notification text
 * @param {string} urgency   - One of URGENCY.CRITICAL, IMPORTANT, INFO
 * @param {Object} [config]  - Optional config override
 * @returns {Promise<Object>} Results per channel
 */
export async function routeNotification(message, urgency = URGENCY.INFO, config = null) {
    config = config || loadConfig();
    const results = {};

    // Determine which channels to use based on urgency
    const priority = config.notificationPriority || ['discord', 'telegram', 'toast'];

    let channels = [];
    switch (urgency) {
        case URGENCY.CRITICAL:
            // Hit ALL configured channels
            channels = ['discord', 'telegram', 'toast', 'email'];
            break;
        case URGENCY.IMPORTANT:
            // Hit primary channels only
            channels = priority.slice(0, 2);
            break;
        case URGENCY.INFO:
        default:
            // Just the first available
            channels = priority.slice(0, 1);
            break;
    }

    const urgencyLabel = urgency === URGENCY.CRITICAL ? '🔴 CRITICAL'
        : urgency === URGENCY.IMPORTANT ? '🟡 IMPORTANT'
        : '🟢 INFO';

    const formattedMessage = `[${urgencyLabel}] ${message}`;

    for (const channel of channels) {
        const handler = CHANNEL_HANDLERS[channel];
        if (!handler) continue;

        try {
            results[channel] = await handler(config, formattedMessage);
        } catch (e) {
            results[channel] = { ok: false, reason: e.message };
        }
    }

    // Log locally
    try {
        const logDir = path.join(process.cwd(), '.rex-data');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'notification-log.json');
        const existing = fs.existsSync(logPath)
            ? JSON.parse(fs.readFileSync(logPath, 'utf-8'))
            : { entries: [] };

        existing.entries.push({
            ts: new Date().toISOString(),
            urgency,
            message,
            results
        });

        // Keep last 200 entries
        if (existing.entries.length > 200) {
            existing.entries = existing.entries.slice(-200);
        }

        fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
    } catch {}

    return results;
}

// ─── CLI Menu ────────────────────────────────────────────────────────────────

export async function notificationRouterMenu() {
    const action = await p.select({
        message: pc.dim('notification router'),
        options: [
            { value: 'test', label: '🔔 Send Test Notification' },
            { value: 'config', label: '⚙️  Configure Channels' },
            { value: 'log', label: '📜 View Notification Log' },
            { value: 'back', label: pc.dim('  back') }
        ]
    });

    if (p.isCancel(action) || action === 'back') return;

    if (action === 'test') {
        const urgency = await p.select({
            message: 'Urgency level:',
            options: [
                { value: URGENCY.INFO, label: '🟢 Info (single channel)' },
                { value: URGENCY.IMPORTANT, label: '🟡 Important (primary channels)' },
                { value: URGENCY.CRITICAL, label: '🔴 Critical (all channels)' }
            ]
        });
        if (p.isCancel(urgency)) return;

        const msg = await p.text({
            message: 'Notification message:',
            initialValue: 'Test notification from RexAI! 🦖'
        });
        if (p.isCancel(msg)) return;

        const s = p.spinner();
        s.start('Routing notification...');
        const results = await routeNotification(msg, urgency);
        s.stop('Done!');

        const resultsText = Object.entries(results)
            .map(([ch, r]) => `${r.ok ? '✅' : '❌'} ${ch}: ${r.ok ? 'Sent' : r.reason}`)
            .join('\n');

        p.note(resultsText || 'No channels configured', 'Notification Results');
    }

    if (action === 'config') {
        const config = loadConfig();

        const chatId = await p.text({
            message: 'Telegram Chat ID for notifications (leave empty to skip):',
            initialValue: config.telegramNotifyChatId || '',
            placeholder: '-1001234567890'
        });

        if (!p.isCancel(chatId)) {
            config.telegramNotifyChatId = chatId || '';
        }

        const priorityStr = await p.text({
            message: 'Channel priority (comma-separated):',
            initialValue: (config.notificationPriority || ['discord', 'telegram', 'toast']).join(', '),
            placeholder: 'discord, telegram, toast, email'
        });

        if (!p.isCancel(priorityStr)) {
            config.notificationPriority = priorityStr.split(',').map(s => s.trim()).filter(Boolean);
        }

        saveConfig(config);
        p.note(pc.green('Notification router configuration saved!'), 'Settings');
    }

    if (action === 'log') {
        try {
            const logPath = path.join(process.cwd(), '.rex-data', 'notification-log.json');
            if (!fs.existsSync(logPath)) {
                p.log.warn('No notification log found yet.');
                return;
            }
            const data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
            const recent = (data.entries || []).slice(-10).reverse();

            if (recent.length === 0) {
                p.log.warn('Notification log is empty.');
                return;
            }

            const lines = recent.map(e => {
                const channels = Object.entries(e.results || {})
                    .map(([ch, r]) => `${r.ok ? '✅' : '❌'}${ch}`)
                    .join(' ');
                return `[${e.ts}] ${e.urgency}: ${e.message.slice(0, 60)} → ${channels}`;
            });

            p.note(lines.join('\n'), '📜 Notification Log (last 10)');
        } catch (e) {
            p.log.error(`Failed to read log: ${e.message}`);
        }
    }
}
