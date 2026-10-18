/**
 * whatsappBot.js — Rex WhatsApp Linked Device Companion
 *
 * Capabilities:
 * - 100% Free: Emulates WhatsApp Web companion device using local Puppeteer.
 * - One-time QR code scan in terminal; persistent session in .rex-data/whatsapp_auth/.
 * - Powered by chatPlatformCore.js: full toolset (shell, git, vision, reminders, obsidian, vitals).
 * - Multi-modal: Handles text messages, photos/images, and outgoing file attachments.
 * - Security: Whitelist allowed phone numbers or chat with Rex in "Message yourself".
 */

import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadConfig, saveConfig } from './config.js';
import {
    processAgentRequest,
    PLATFORM_PERSONAS
} from './chatPlatformCore.js';

const WA_MAX_MESSAGE_LENGTH = 3500;
const AUTH_DIR = path.join(process.cwd(), '.rex-data', 'whatsapp_auth');

/**
 * Split long messages into WhatsApp-safe chunks
 */
function splitMessage(text, maxLen = WA_MAX_MESSAGE_LENGTH) {
    const chunks = [];
    let remaining = String(text || '');
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }
        let splitIdx = remaining.lastIndexOf('\n', maxLen);
        if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
        chunks.push(remaining.slice(0, splitIdx));
        remaining = remaining.slice(splitIdx);
    }
    return chunks;
}

/**
 * Normalize phone number to match WhatsApp serialized JID
 */
function normalizePhoneNumber(num) {
    if (!num) return '';
    const clean = String(num).replace(/[^0-9]/g, '');
    return clean ? `${clean}@c.us` : '';
}

/**
 * WhatsApp Bot Interactive Configuration Menu
 */
export async function whatsappConfigMenu() {
    let active = true;
    while (active) {
        const config = loadConfig();
        const choice = await p.select({
            message: pc.dim('whatsapp bot config'),
            options: [
                {
                    value: 'owner',
                    label: `Set Owner Phone Number ${config.whatsappOwnerNumber ? pc.green(`(${config.whatsappOwnerNumber})`) : pc.yellow('(Not set - responds to self)')}`
                },
                {
                    value: 'allowed',
                    label: `Allowed Numbers Whitelist ${config.whatsappAllowedNumbers?.length ? pc.green(`(${config.whatsappAllowedNumbers.length} added)`) : pc.dim('(None)')}`
                },
                {
                    value: 'prefix',
                    label: `Command Prefix ${config.whatsappPrefix ? pc.green(`("${config.whatsappPrefix}")`) : pc.dim('(None - responds to all DMs)')}`
                },
                {
                    value: 'reset_session',
                    label: pc.red('Clear WhatsApp Session (Log Out / Reset QR)')
                },
                { value: 'back', label: pc.dim('  back') }
            ]
        });

        if (p.isCancel(choice) || choice === 'back') {
            active = false;
            break;
        }

        if (choice === 'owner') {
            const input = await p.text({
                message: 'Enter Owner Phone Number with country code (e.g. 919876543210):',
                initialValue: config.whatsappOwnerNumber || '',
                placeholder: 'CountryCode + Number'
            });
            if (p.isCancel(input)) continue;
            config.whatsappOwnerNumber = String(input).replace(/[^0-9]/g, '');
            saveConfig(config);
            p.note(pc.green(`Owner set to: ${config.whatsappOwnerNumber || '(Cleared)'}`), 'Success');
        }

        if (choice === 'allowed') {
            const input = await p.text({
                message: 'Enter comma-separated phone numbers allowed to chat with Rex:',
                initialValue: (config.whatsappAllowedNumbers || []).join(', '),
                placeholder: '919876543210, 14155552671'
            });
            if (p.isCancel(input)) continue;
            config.whatsappAllowedNumbers = input.split(',').map(s => s.replace(/[^0-9]/g, '')).filter(Boolean);
            saveConfig(config);
            p.note(pc.green(`Allowed numbers updated (${config.whatsappAllowedNumbers.length} numbers)`), 'Success');
        }

        if (choice === 'prefix') {
            const input = await p.text({
                message: 'Enter command prefix (leave blank to respond to all direct messages):',
                initialValue: config.whatsappPrefix || '',
                placeholder: 'e.g. !rex or rex'
            });
            if (p.isCancel(input)) continue;
            config.whatsappPrefix = String(input).trim();
            saveConfig(config);
            p.note(pc.green(`Prefix set to: "${config.whatsappPrefix}"`), 'Success');
        }

        if (choice === 'reset_session') {
            const confirm = await p.confirm({
                message: 'Are you sure you want to delete the saved WhatsApp session? You will need to scan QR again.',
                initialValue: false
            });
            if (confirm && !p.isCancel(confirm)) {
                if (fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }
                p.note(pc.green('Session cleared! The bot will prompt for a new QR scan on next start.'), 'Session Reset');
            }
        }
    }
}

/**
 * Start the WhatsApp Bot
 */
export async function startWhatsAppBot() {
    const config = loadConfig();

    console.log(pc.bold(pc.cyan('\n🦖 Initializing Rex WhatsApp Companion (Linked Device)...')));
    console.log(pc.dim('Session directory: ') + pc.cyan(AUTH_DIR));

    if (!fs.existsSync(path.dirname(AUTH_DIR))) {
        fs.mkdirSync(path.dirname(AUTH_DIR), { recursive: true });
    }

    // Configure Chrome/Chromium
    const chromePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
    let executablePath;
    for (const cp of chromePaths) {
        if (fs.existsSync(cp)) {
            executablePath = cp;
            break;
        }
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(process.cwd(), '.rex-data', 'whatsapp_auth')
        }),
        puppeteer: {
            headless: true,
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    const chatHistory = {};
    const userPersonas = {};

    // ─── Event: QR Code ─────────────────────────────────────────────
    client.on('qr', (qr) => {
        console.log('\n' + pc.bgGreen(pc.black(' WHATSAPP LINK REQUIRED ')));
        console.log(pc.bold('1. Open WhatsApp on your phone'));
        console.log(pc.bold('2. Tap Settings (iOS) or 3 Dots (Android) > Linked Devices'));
        console.log(pc.bold('3. Tap "Link a Device" and scan the QR code below:\n'));

        qrcode.generate(qr, { small: true });
        console.log(pc.dim('\nWaiting for QR scan... (This code updates every 20 seconds)\n'));
    });

    // ─── Event: Authenticated ───────────────────────────────────────
    client.on('authenticated', () => {
        console.log(pc.green('✔ WhatsApp authentication successful! Session stored locally.'));
    });

    client.on('auth_failure', (msg) => {
        console.error(pc.red(`❌ WhatsApp authentication failure: ${msg}`));
        console.log(pc.yellow('Run `rexai whatsapp` with reset session or delete .rex-data/whatsapp_auth to re-link.'));
    });

    // ─── Event: Ready ───────────────────────────────────────────────
    client.on('ready', () => {
        const myInfo = client.info;
        const myNumber = myInfo?.wid?.user || 'Unknown';
        const myName = myInfo?.pushname || 'Rex User';

        console.log('\n' + pc.bgGreen(pc.black(' REX WHATSAPP BOT ONLINE 🦖 ')));
        console.log(`• Connected as: ${pc.bold(myName)} (${pc.cyan(`+${myNumber}`)})`);
        console.log(`• Owner Number: ${config.whatsappOwnerNumber ? pc.cyan(`+${config.whatsappOwnerNumber}`) : pc.yellow(`Auto-set to +${myNumber}`)}`);
        console.log(`• Message Yourself: ${pc.green('Supported! Send messages to your own number/notes to chat with Rex.')}`);
        console.log(`• Type ${pc.bold('!help')} in WhatsApp for available commands.\n`);

        // If owner is not explicitly configured, default to the logged in account
        if (!config.whatsappOwnerNumber && myNumber !== 'Unknown') {
            config.whatsappOwnerNumber = myNumber;
            saveConfig(config);
        }
    });

    // ─── Access Control Checker ─────────────────────────────────────
    function isAllowed(msg) {
        const myWid = client.info?.wid?._serialized || '';
        const myNumber = client.info?.wid?.user || '';
        const sender = msg.from;
        const senderNumber = sender.replace(/[^0-9]/g, '');

        // 1. Message to self (chatting with oneself or Notes to self)
        if (msg.fromMe) {
            // Check if user is messaging themselves
            const to = msg.to;
            if (to === myWid || (myNumber && to.includes(myNumber))) {
                return true;
            }
            // User sent a message to someone else; do not intercept unless prefixed with !rex
            if (config.whatsappPrefix && msg.body.trim().toLowerCase().startsWith(config.whatsappPrefix.toLowerCase())) {
                return true;
            }
            return false;
        }

        // 2. Direct message from owner
        const ownerNorm = normalizePhoneNumber(config.whatsappOwnerNumber || myNumber);
        if (ownerNorm && sender === ownerNorm) return true;

        // 3. Whitelist check
        const allowed = Array.isArray(config.whatsappAllowedNumbers) ? config.whatsappAllowedNumbers : [];
        if (allowed.some(num => normalizePhoneNumber(num) === sender)) {
            return true;
        }

        // If whitelist is set and sender is not in it, ignore
        if (ownerNorm || allowed.length > 0) {
            return false;
        }

        return true;
    }

    // ─── Event: Message Handler ─────────────────────────────────────
    client.on('message', async (msg) => {
        await handleIncomingMessage(msg, false);
    });

    // Handle messages sent by the user themselves in "Message yourself" / Notes
    client.on('message_create', async (msg) => {
        if (!msg.fromMe) return; // Non-self messages are already handled by 'message'
        await handleIncomingMessage(msg, true);
    });

    async function handleIncomingMessage(msg, isFromMe) {
        try {
            if (!isAllowed(msg)) return;

            // Handle optional command prefix
            let content = String(msg.body || '').trim();
            const prefix = (config.whatsappPrefix || '').trim().toLowerCase();

            if (prefix) {
                if (!content.toLowerCase().startsWith(prefix)) {
                    // If chatting with oneself and no prefix, skip unless prefix not required for self
                    return;
                }
                content = content.slice(prefix.length).trim();
            }

            const chat = await msg.getChat();
            const senderJid = msg.from;
            const senderNumber = senderJid.replace(/[^0-9]/g, '');
            const senderName = msg._data?.notifyName || (isFromMe ? 'You' : `+${senderNumber}`);

            // ─── Built-in Commands ─────────────────────────────────
            const lower = content.toLowerCase();

            if (lower === '!help' || lower === '/help') {
                await chat.sendStateTyping();
                const helpText = [
                    '🦖 *Rex Personal Assistant — WhatsApp Companion*',
                    '',
                    '*Commands:*',
                    '• `!help` — Show this command list',
                    '• `!vitals` — Mac battery, load, and git status',
                    '• `!model` — Active AI model info',
                    '• `!persona <name>` — Change personality (e.g. `!persona butler`)',
                    '• `!clear` — Reset conversation context',
                    '• `!remind <time> : <task>` — Schedule a reminder',
                    '',
                    '*Agentic Capabilities:*',
                    '• Ask any coding, debugging, or system questions',
                    '• Run shell commands & inspect files',
                    '• Send photos for instant multimodal analysis',
                    '• Manage your Obsidian notes, Google Calendar & Gmail',
                    '',
                    '_Made with ☕ by Adi & Rex_'
                ].join('\n');
                await msg.reply(helpText);
                return;
            }

            if (lower === '!vitals' || lower === '/vitals') {
                await chat.sendStateTyping();
                try {
                    const { generateMorningBriefing } = await import('./alfredButler.js');
                    const briefing = await generateMorningBriefing();
                    await msg.reply(`🎩 ${briefing.greeting}\n\n${briefing.text}`);
                } catch (e) {
                    await msg.reply(`Vitals check error: ${e.message}`);
                }
                return;
            }

            if (lower === '!clear' || lower === '/clear') {
                chatHistory[senderJid] = [];
                await msg.reply('🧹 Chat history cleared for this session! Fresh start.');
                return;
            }

            if (lower === '!model' || lower === '/model') {
                const cfg = loadConfig();
                const modelInfo = cfg.geminiKey ? `Gemini (${cfg.geminiModel})` :
                                  cfg.openaiKey ? `OpenAI (${cfg.openaiModel})` :
                                  cfg.claudeKey ? `Claude (${cfg.claudeModel})` : 'Ollama Local';
                await msg.reply(`🤖 Active AI Model: *${modelInfo}*`);
                return;
            }

            if (lower.startsWith('!persona ') || lower.startsWith('/persona ')) {
                const reqPersona = lower.split(' ')[1]?.trim();
                if (PLATFORM_PERSONAS[reqPersona]) {
                    userPersonas[senderJid] = reqPersona;
                    chatHistory[senderJid] = [];
                    await msg.reply(`✅ Persona switched to *${reqPersona}*! Context refreshed.`);
                } else {
                    await msg.reply(`Available personas: ${Object.keys(PLATFORM_PERSONAS).join(', ')}`);
                }
                return;
            }

            // Quick reminder command: !remind in 20m : check build
            const remindMatch = content.match(/^(?:!remind|remind\s+me)\s+(.+?)\s*:\s*(.+)$/i);
            if (remindMatch) {
                const timeExpr = remindMatch[1].trim();
                const task = remindMatch[2].trim();
                try {
                    const { parseTimeExpression, createReminder, formatDuration } = await import('./reminders.js');
                    const delayMs = parseTimeExpression(timeExpr);
                    if (delayMs) {
                        const rem = createReminder(task, delayMs, false);
                        await msg.reply(`⏰ *Reminder Set!*\n• Task: "${task}"\n• Fires in: ${formatDuration(delayMs)}`);
                        return;
                    }
                } catch {}
            }

            // ─── Image Analysis (Photo attached) ───────────────────
            let inputMessage = content;
            if (msg.hasMedia && (msg.type === 'image' || msg.type === 'photo')) {
                try {
                    await chat.sendStateTyping();
                    console.log(`\n${pc.bgGreen(pc.black(' WHATSAPP 📸 '))} ${pc.bold(senderName)} sent an image.`);
                    const media = await msg.downloadMedia();
                    if (media && media.data) {
                        const mime = media.mimetype || 'image/jpeg';
                        const caption = content || 'Please inspect and analyze this image.';
                        inputMessage = [
                            { type: 'text', text: `[From ${senderName}]: ${caption}` },
                            { type: 'image_url', image_url: { url: `data:${mime};base64,${media.data}` } }
                        ];
                    }
                } catch (e) {
                    console.error(pc.red(`Failed to download WhatsApp media: ${e.message}`));
                }
            } else if (!content) {
                // Ignore empty messages or unhandled media
                return;
            } else {
                inputMessage = `[From ${senderName}]: ${content}`;
            }

            console.log(`\n${pc.bgGreen(pc.black(' WHATSAPP '))} ${pc.bold(senderName)}: ${typeof content === 'string' ? content : '[Media]'}`);

            // ─── Build Platform Context for Agent ──────────────────
            const platformContext = {
                reply: async (text) => {
                    const chunks = splitMessage(text);
                    for (const chunk of chunks) {
                        await chat.sendMessage(chunk);
                    }
                },
                sendFile: async (filePath, caption) => {
                    try {
                        if (fs.existsSync(filePath)) {
                            const media = MessageMedia.fromFilePath(filePath);
                            await chat.sendMessage(media, { caption: caption || '' });
                        } else {
                            await chat.sendMessage(`📎 File not found: ${filePath}`);
                        }
                    } catch (e) {
                        await chat.sendMessage(`📎 Failed to attach file: ${e.message}`);
                    }
                },
                sendTyping: async () => {
                    try {
                        await chat.sendSeen();
                        await chat.sendStateTyping();
                    } catch {}
                },
                fileToolName: 'send_platform_file'
            };

            await processAgentRequest({
                userId: senderJid,
                userTag: senderName,
                inputMessage,
                history: chatHistory,
                userPersonas,
                platformCtx: platformContext
            });

        } catch (err) {
            console.error(pc.red(`WhatsApp message handling error: ${err.message}`));
        }
    }

    // Initialize client
    await client.initialize();
}
