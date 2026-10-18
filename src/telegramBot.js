/**
 * telegramBot.js — Rex Telegram Bot Companion
 *
 * Mirrors the Discord bot's full agentic system but for Telegram.
 * Uses the shared chatPlatformCore.js for zero code duplication.
 *
 * Credit Policy: Zero background AI calls. All AI calls come from
 * the user sending a message. Same credit footprint as Discord.
 *
 * Opt-in: Only starts via rexai open → Labs → Start Telegram Bot
 */

import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig, saveConfig } from './config.js';
import {
    processAgentRequest,
    PLATFORM_PERSONAS,
    tryParseToolCall,
    executeBackendTool
} from './chatPlatformCore.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Split long messages into Telegram-safe chunks.
 */
function splitMessage(text, maxLen = TELEGRAM_MAX_MESSAGE_LENGTH) {
    const chunks = [];
    let remaining = String(text || '');
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }
        // Try to split at a newline near the limit
        let splitIdx = remaining.lastIndexOf('\n', maxLen);
        if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
        chunks.push(remaining.slice(0, splitIdx));
        remaining = remaining.slice(splitIdx);
    }
    return chunks;
}

export async function startTelegramBot() {
    const config = loadConfig();

    // Prompt for token if not set
    if (!config.telegramBotToken) {
        const token = await p.text({
            message: 'Enter your Telegram Bot Token (from @BotFather):',
            placeholder: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ'
        });
        if (p.isCancel(token) || !token) return;
        config.telegramBotToken = String(token).trim();
        saveConfig(config);
        p.note(pc.green('Token saved to your local configuration.'), 'Telegram Bot Setup');
    }

    const s = p.spinner();
    s.start('Connecting to Telegram...');

    // Dynamic import telegraf (so it only loads when opt-in)
    let Telegraf, message;
    try {
        const telegrafModule = await import('telegraf');
        Telegraf = telegrafModule.Telegraf;
        // Filters are available as telegrafModule.Filters in newer versions
        message = telegrafModule.message;
    } catch (e) {
        s.stop(pc.red('Failed to load Telegraf library.'));
        p.note([
            'The "telegraf" package is required for the Telegram bot.',
            'Run: npm install telegraf',
            `Error: ${e.message}`
        ].join('\n'), 'Missing Dependency');
        return;
    }

    const bot = new Telegraf(config.telegramBotToken);

    // Per-user state
    const chatHistory = {};
    const userPersonas = {};

    // ─── Access control ──────────────────────────────────────────────

    function isUserAllowed(userId) {
        const whitelist = Array.isArray(config.telegramAllowedUserIds)
            ? config.telegramAllowedUserIds
            : [];
        if (whitelist.length === 0) return true;
        if (whitelist.includes('*')) return true;
        return whitelist.includes(String(userId));
    }

    // ─── Persona resolution helper ───────────────────────────────────

    function resolvePriorityProvider(cfg) {
        if (cfg.geminiKey) return { provider: 'gemini', model: cfg.geminiModel || 'gemini-3.5-flash' };
        if (cfg.openaiKey) return { provider: 'openai', model: cfg.openaiModel || 'gpt-5-mini' };
        if (cfg.claudeKey) return { provider: 'claude', model: cfg.claudeModel || 'claude-3-haiku-20240307' };
        if (cfg.deepseekKey) return { provider: 'deepseek', model: cfg.deepseekModel || 'deepseek-chat' };
        return { provider: 'ollama', model: cfg.ollamaModel || 'llama3:latest' };
    }

    // ─── /start command ──────────────────────────────────────────────

    bot.start((ctx) => {
        const user = ctx.from;
        if (!isUserAllowed(user.id)) {
            return ctx.reply('🔒 You are not authorized to use this bot. Ask the admin to add your user ID.');
        }
        ctx.reply([
            '🦖 *Rex is online!*',
            '',
            "I'm your autonomous AI engineering companion.",
            "Just send me a message and I'll help with code, files, shell commands, and more!",
            '',
            '*Commands:*',
            '/persona - Change my personality',
            '/model - Show current AI model',
            "/mood - Check Rex's current mood",
            '/help - Show all commands',
            '',
            '_Made by Adi_ ☕🦕'
        ].join('\n')).catch(() => {
            // Fallback if formatting fails
            ctx.reply("🦖 Rex is online! Send me a message and I'll help with code, files, shell commands, and more!");
        });
    });

    // ─── /help command ───────────────────────────────────────────────

    bot.help((ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;
        ctx.reply([
            '🦖 Rex Commands:',
            '',
            '/start — Wake Rex up',
            '/help — Show this menu',
            '/persona <name> — Change personality',
            '  Available: ' + Object.keys(PLATFORM_PERSONAS).join(', '),
            '/model — Show active AI model',
            '/setmodel <provider> <model> — Change model',
            '/clear — Clear chat history',
            '/mood — Check Rex\'s mood',
            '',
            'Just type normally to chat! I can:',
            '• Run shell commands',
            '• Read/write files',
            '• Browse the web',
            '• Send GIFs',
            '• Analyze images & docs',
        ].join('\n'));
    });

    // ─── /persona command ────────────────────────────────────────────

    bot.command('persona', (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;
        const args = ctx.message.text.split(' ').slice(1);
        const requested = (args[0] || '').toLowerCase();

        if (!requested) {
            const current = userPersonas[ctx.from.id] || 'intern';
            return ctx.reply(
                `Current persona: ${current}\n\nAvailable: ${Object.keys(PLATFORM_PERSONAS).join(', ')}\n\nUsage: /persona <name>`
            );
        }

        if (PLATFORM_PERSONAS[requested]) {
            userPersonas[ctx.from.id] = requested;
            // Keep only last turn on persona change
            const hist = chatHistory[ctx.from.id] || [];
            chatHistory[ctx.from.id] = hist.length > 0 ? [hist[hist.length - 1]] : [];
            ctx.reply(`✅ Personality changed to *${requested}*! Context reset.`, { parse_mode: 'Markdown' });
        } else {
            ctx.reply(`❌ Unknown persona. Available: ${Object.keys(PLATFORM_PERSONAS).join(', ')}`);
        }
    });

    // ─── /model command ──────────────────────────────────────────────

    bot.command('model', (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;
        const cfg = loadConfig();
        const active = resolvePriorityProvider(cfg);
        ctx.reply([
            `Active provider: ${active.provider}`,
            `Active model: ${active.model}`,
            `Priority: gemini → openai → claude → deepseek → ollama`,
            '',
            `Use: /setmodel <provider> <model-name>`
        ].join('\n'));
    });

    // ─── /setmodel command ───────────────────────────────────────────

    bot.command('setmodel', (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;
        const args = ctx.message.text.split(' ').slice(1);
        const provider = (args[0] || '').toLowerCase();
        const modelName = args.slice(1).join(' ').trim();

        if (!provider || !modelName) {
            return ctx.reply('Usage: /setmodel <provider> <model-name>\nExample: /setmodel gemini gemini-3.5-flash');
        }

        const cfg = loadConfig();
        const providerMap = {
            'gemini': 'geminiModel', 'openai': 'openaiModel',
            'claude': 'claudeModel', 'deepseek': 'deepseekModel',
            'ollama': 'ollamaModel'
        };
        const keyMap = {
            'gemini': 'geminiKey', 'openai': 'openaiKey',
            'claude': 'claudeKey', 'deepseek': 'deepseekKey'
        };

        if (!providerMap[provider]) {
            return ctx.reply(`Unknown provider. Available: ${Object.keys(providerMap).join(', ')}`);
        }

        cfg[providerMap[provider]] = modelName;
        cfg.aiModel = provider;
        saveConfig(cfg);

        const active = resolvePriorityProvider(cfg);
        ctx.reply(`✅ Set ${provider} model: ${modelName}\nActive: ${active.provider} / ${active.model}`);
    });

    // ─── /clear command ──────────────────────────────────────────────

    bot.command('clear', (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;
        chatHistory[ctx.from.id] = [];
        ctx.reply('🧹 Chat history cleared! Fresh start.');
    });

    // ─── /mood command (zero AI calls — reads local state) ───────────

    bot.command('mood', async (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;
        try {
            const { getCurrentMood, getMoodEmoji } = await import('./moodEngine.js');
            const mood = getCurrentMood();
            ctx.reply(`${getMoodEmoji(mood.state)} Rex is currently feeling *${mood.state}*\n\nReason: ${mood.reason}`, { parse_mode: 'Markdown' });
        } catch {
            ctx.reply('🦖 Rex is feeling neutral. (Mood engine not yet activated)');
        }
    });

    // ─── Handle text messages ────────────────────────────────────────

    bot.on('text', async (ctx) => {
        // Skip commands (already handled above)
        if (ctx.message.text.startsWith('/')) return;
        if (!isUserAllowed(ctx.from.id)) {
            return ctx.reply('🔒 Not authorized.');
        }

        const userId = String(ctx.from.id);
        const userTag = ctx.from.username || ctx.from.first_name || 'User';
        const cleanContent = ctx.message.text.trim();

        if (!cleanContent) return;

        console.log(`\n${pc.bgMagenta(pc.white(' TELEGRAM '))} ${pc.bold(userTag)}: ${cleanContent}`);

        // Build platform context for the shared core
        const platformContext = {
            reply: async (text) => {
                const chunks = splitMessage(text);
                for (const chunk of chunks) {
                    await ctx.reply(chunk).catch(() => {});
                }
            },
            sendFile: async (filePath, caption) => {
                await ctx.replyWithDocument(
                    { source: filePath, filename: path.basename(filePath) },
                    { caption: caption || '' }
                ).catch((e) => {
                    ctx.reply(`📎 Failed to send file: ${e.message}`);
                });
            },
            sendTyping: async () => {
                await ctx.sendChatAction('typing').catch(() => {});
            },
            fileToolName: 'send_platform_file'
        };

        const textBody = `[From ${userTag}]: ${cleanContent}`;

        await processAgentRequest({
            userId,
            userTag,
            inputMessage: textBody,
            history: chatHistory,
            userPersonas,
            platformCtx: platformContext
        });
    });

    // ─── Handle photos (image analysis) ──────────────────────────────

    bot.on('photo', async (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;

        const userId = String(ctx.from.id);
        const userTag = ctx.from.username || ctx.from.first_name || 'User';
        const caption = ctx.message.caption || 'What is in this image?';

        console.log(`\n${pc.bgMagenta(pc.white(' TELEGRAM 📸 '))} ${pc.bold(userTag)}: [Photo] ${caption}`);

        // Get the highest-res photo
        const photos = ctx.message.photo;
        const bestPhoto = photos[photos.length - 1];

        try {
            const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
            const res = await fetch(fileLink.href);
            const buffer = await res.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');

            const contentArray = [
                { type: 'text', text: `[From ${userTag}]: ${caption}` },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
            ];

            const platformContext = {
                reply: async (text) => {
                    const chunks = splitMessage(text);
                    for (const chunk of chunks) {
                        await ctx.reply(chunk).catch(() => {});
                    }
                },
                sendFile: async (filePath, cap) => {
                    await ctx.replyWithDocument(
                        { source: filePath, filename: path.basename(filePath) },
                        { caption: cap || '' }
                    ).catch(() => {});
                },
                sendTyping: async () => {
                    await ctx.sendChatAction('typing').catch(() => {});
                },
                fileToolName: 'send_platform_file'
            };

            await processAgentRequest({
                userId,
                userTag,
                inputMessage: contentArray,
                history: chatHistory,
                userPersonas,
                platformCtx: platformContext
            });
        } catch (e) {
            ctx.reply(`Failed to process image: ${e.message}`);
        }
    });

    // ─── Handle documents (PDF, code, text files) ────────────────────

    bot.on('document', async (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;

        const userId = String(ctx.from.id);
        const userTag = ctx.from.username || ctx.from.first_name || 'User';
        const doc = ctx.message.document;
        const caption = ctx.message.caption || `Analyze this file: ${doc.file_name}`;
        const mimeType = doc.mime_type || '';

        console.log(`\n${pc.bgMagenta(pc.white(' TELEGRAM 📎 '))} ${pc.bold(userTag)}: [${doc.file_name}] ${caption}`);

        try {
            const fileLink = await ctx.telegram.getFileLink(doc.file_id);
            const res = await fetch(fileLink.href);
            let fileContent = '';

            if (mimeType === 'application/pdf') {
                const buffer = await res.arrayBuffer();
                const pdfLib = await import('pdf-parse');
                const pdfParse = pdfLib.default || pdfLib;
                const parsed = await pdfParse(Buffer.from(buffer));
                fileContent = `[Attached PDF: ${doc.file_name}]\n\`\`\`\n${parsed.text.slice(0, 15000)}\n\`\`\``;
            } else if (mimeType.startsWith('text/') || mimeType === 'application/json' ||
                       /\.(md|js|ts|py|json|html|css|txt|csv|log|jsx|tsx|yaml|yml|xml|sh|bat|ps1)$/i.test(doc.file_name)) {
                const text = await res.text();
                fileContent = `[Attached File: ${doc.file_name}]\n\`\`\`\n${text.slice(0, 15000)}\n\`\`\``;
            } else if (mimeType.includes('word') || doc.file_name.endsWith('.docx')) {
                const buffer = await res.arrayBuffer();
                const mammoth = await import('mammoth');
                const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
                fileContent = `[Attached DOCX: ${doc.file_name}]\n\`\`\`\n${result.value.slice(0, 15000)}\n\`\`\``;
            } else {
                fileContent = `[User attached: ${doc.file_name} (${mimeType}). Tell them you can read text/code/PDFs/images.]`;
            }

            const textBody = `[From ${userTag}]: ${caption}\n\n${fileContent}`;

            const platformContext = {
                reply: async (text) => {
                    const chunks = splitMessage(text);
                    for (const chunk of chunks) {
                        await ctx.reply(chunk).catch(() => {});
                    }
                },
                sendFile: async (filePath, cap) => {
                    await ctx.replyWithDocument(
                        { source: filePath, filename: path.basename(filePath) },
                        { caption: cap || '' }
                    ).catch(() => {});
                },
                sendTyping: async () => {
                    await ctx.sendChatAction('typing').catch(() => {});
                },
                fileToolName: 'send_platform_file'
            };

            await processAgentRequest({
                userId,
                userTag,
                inputMessage: textBody,
                history: chatHistory,
                userPersonas,
                platformCtx: platformContext
            });
        } catch (e) {
            ctx.reply(`Failed to process document: ${e.message}`);
        }
    });

    // ─── Handle voice messages (transcription via Whisper) ───────────

    bot.on('voice', async (ctx) => {
        if (!isUserAllowed(ctx.from.id)) return;

        const userId = String(ctx.from.id);
        const userTag = ctx.from.username || ctx.from.first_name || 'User';
        const cfg = loadConfig();

        if (!cfg.openaiKey) {
            return ctx.reply('🎙️ Voice transcription needs an OpenAI key for Whisper. You can still text me!');
        }

        console.log(`\n${pc.bgMagenta(pc.white(' TELEGRAM 🎙️ '))} ${pc.bold(userTag)}: [Voice Message]`);

        try {
            await ctx.sendChatAction('typing');

            const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
            const res = await fetch(fileLink.href);
            const buffer = Buffer.from(await res.arrayBuffer());

            // Save to temp file for Whisper
            const tmpPath = path.join(process.cwd(), `.rex_tg_voice_${Date.now()}.ogg`);
            fs.writeFileSync(tmpPath, buffer);

            try {
                const { default: OpenAI } = await import('openai');
                const openai = new OpenAI({ apiKey: cfg.openaiKey });
                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(tmpPath),
                    model: 'whisper-1'
                });

                const text = transcription.text.trim();
                if (!text || text.length < 2) {
                    return ctx.reply("I couldn't catch what you said. Try again?");
                }

                console.log(`${pc.bgMagenta(pc.white(' VOICE→TEXT '))} ${text}`);
                await ctx.reply(`🎙️ *Heard:* "${text}"`, { parse_mode: 'Markdown' }).catch(() => {});

                const platformContext = {
                    reply: async (replyText) => {
                        const chunks = splitMessage(replyText);
                        for (const chunk of chunks) {
                            await ctx.reply(chunk).catch(() => {});
                        }
                    },
                    sendFile: async (filePath, caption) => {
                        await ctx.replyWithDocument(
                            { source: filePath, filename: path.basename(filePath) },
                            { caption: caption || '' }
                        ).catch(() => {});
                    },
                    sendTyping: async () => {
                        await ctx.sendChatAction('typing').catch(() => {});
                    },
                    fileToolName: 'send_platform_file'
                };

                await processAgentRequest({
                    userId,
                    userTag,
                    inputMessage: `[From ${userTag} via voice]: ${text}`,
                    history: chatHistory,
                    userPersonas,
                    platformCtx: platformContext
                });
            } finally {
                try { fs.unlinkSync(tmpPath); } catch {}
            }
        } catch (e) {
            console.error(`Telegram voice error: ${e.message}`);
            ctx.reply('Failed to process voice message. 🦖');
        }
    });

    // ─── Error handler ───────────────────────────────────────────────

    bot.catch((err) => {
        console.error(pc.red(`Telegram bot error: ${err.message}`));
    });

    // ─── Launch ──────────────────────────────────────────────────────

    try {
        await bot.launch();
        s.stop(pc.green(`Connected to Telegram! Bot: @${bot.botInfo?.username || 'RexAI'}`));
        p.note(pc.cyan('Rex is now alive on Telegram. Send him a message to start chatting!'), 'Telegram Companion');

        // Graceful shutdown
        const shutdown = () => {
            bot.stop('SIGINT');
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);

        // Keep the bot running (it uses long polling)
        await new Promise(() => {}); // Block indefinitely
    } catch (e) {
        s.stop(pc.red('Failed to connect to Telegram.'));
        p.note(e.message, 'Telegram Error');
        if (e.message.includes('401') || e.message.includes('token')) {
            config.telegramBotToken = '';
            saveConfig(config);
            p.note('Invalid token detected. It has been cleared from your settings.', 'Settings Reset');
        }
    }
}
