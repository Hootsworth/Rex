import {
    Client,
    GatewayIntentBits,
    Partials,
    Events,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    SlashCommandBuilder
} from 'discord.js';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { loadConfig, saveConfig } from './config.js';
import { tryHandleIntentPipelineMessage } from './intentPipeline/discordPipeline.js';
import { createDiscordAgenticRuntime } from './discordAgenticRuntime.js';

import {
    processAgentRequest,
    PLATFORM_PERSONAS
} from './chatPlatformCore.js';
import {
    startCompanionEngine,
    handleTargetUserMessage,
    tryHandleCompanionCommand
} from './companionDelegates.js';
import {
    tryHandleSocialRadarCommand,
    getDueEventsToday,
    saveSocialRadar,
    loadSocialRadar
} from './socialRadar.js';
import {
    startBurnoutSentinel,
    recordUserActivity,
    tryHandleBurnoutCommand
} from './burnoutSentinel.js';
import {
    tryHandleVoiceMemoCommand
} from './voiceMemos.js';
import {
    tryHandleDinoHoardCommand
} from './dinoHoard.js';
import {
    tryHandleIMessageCommand
} from './imessage.js';
import {
    tryHandleShortcutsCommand
} from './shortcuts.js';
import {
    tryHandleCameraCommand
} from './cameraSnapshot.js';
import {
    tryHandleObsidianCommand
} from './obsidianVault.js';
import {
    detectComputerControlIntent,
    requestComputerPermission,
    handleComputerPermissionInteraction,
    handleComputerPermissionTextMessage
} from './discordComputerControl.js';

async function executeBackendTool(toolName, args, originalMessage) {
    // This local wrapper handles the Discord-specific logic for send_discord_file
    // but delegates everything else to the shared core.
    if (toolName === 'send_discord_file') {
        try {
            const rawPath = String(args.filePath || '').trim();
            if (!rawPath) return 'Failed to send file: filePath is required.';

            const absolutePath = path.isAbsolute(rawPath)
                ? path.resolve(rawPath)
                : path.resolve(process.cwd(), rawPath);

            if (!fs.existsSync(absolutePath)) return `Failed to send file: file does not exist (${absolutePath}).`;

            const { AttachmentBuilder } = await import('discord.js');
            const attachment = new AttachmentBuilder(absolutePath, { name: path.basename(absolutePath) });
            const content = String(args.message || '').trim() || `Here is your file: ${path.basename(absolutePath)}`;
            await originalMessage.reply({ content, files: [attachment] });
            return `File sent successfully: ${absolutePath}`;
        } catch (e) {
            return `Failed to send file: ${e.message}`;
        }
    }

    const { executeBackendTool: sharedExecute } = await import('./chatPlatformCore.js');
    return sharedExecute(toolName, args, {
        sendFile: async (p, c) => {
            const { AttachmentBuilder } = await import('discord.js');
            const attachment = new AttachmentBuilder(p, { name: path.basename(p) });
            await originalMessage.reply({ content: c || '', files: [attachment] });
        }
    });
}
// Redundant tool execution logic removed - now using chatPlatformCore.js

export async function startDiscordBot() {
    const config = loadConfig();

    // Auto-start active in-browser Chrome extension bridge on 8787 by default
    try {
        const { startBrowserBridge } = await import('./browserBridge.js');
        startBrowserBridge(8787);
    } catch {}

    const agenticRuntime = createDiscordAgenticRuntime(config);
    const pollSessions = new Map();
    const mcqSessions = new Map();
    let restartInProgress = false;

    function userCanRestartBot(userId) {
        const whitelist = Array.isArray(config.discordAllowedUserIds) ? config.discordAllowedUserIds : [];
        if (whitelist.length === 0) return true;
        if (whitelist.includes('*')) return true;
        return whitelist.includes(String(userId));
    }

    async function restartWholeBotProcess(reason = 'Manual restart request') {
        if (restartInProgress) return;
        restartInProgress = true;

        const args = process.argv.slice(1);
        const child = spawn(process.execPath, args, {
            cwd: process.cwd(),
            detached: true,
            stdio: 'inherit',
            windowsHide: false
        });
        child.unref();

        // Give I/O a moment to flush before exiting the current process.
        setTimeout(() => {
            try {
                agenticRuntime.stopAll();
            } catch {}
            process.exit(0);
        }, 400);
    }

    function resolvePriorityProvider(cfg) {
        if (cfg.geminiKey) return { provider: 'gemini', model: cfg.geminiModel || 'gemini-3.5-flash' };
        if (cfg.openaiKey) return { provider: 'openai', model: cfg.openaiModel || 'gpt-5-mini' };
        if (cfg.claudeKey) return { provider: 'claude', model: cfg.claudeModel || 'claude-3-haiku-20240307' };
        if (cfg.deepseekKey) return { provider: 'deepseek', model: cfg.deepseekModel || 'deepseek-chat' };
        return { provider: 'ollama', model: cfg.ollamaModel || 'llama3:latest' };
    }

    function toSessionId() {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }

    function compactLabel(text = '', max = 68) {
        const value = String(text || '').trim();
        if (value.length <= max) return value;
        return `${value.slice(0, max - 3)}...`;
    }

    function buildPollRows(session) {
        const counts = Array.from({ length: session.options.length }, (_, idx) => {
            let c = 0;
            for (const vote of session.votes.values()) {
                if (vote === idx) c += 1;
            }
            return c;
        });

        const optionButtons = session.options.map((opt, idx) => {
            const label = compactLabel(`${opt} (${counts[idx]})`);
            return new ButtonBuilder()
                .setCustomId(`poll_vote:${session.id}:${idx}`)
                .setLabel(label)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(session.closed);
        });

        const rows = [];
        for (let i = 0; i < optionButtons.length; i += 5) {
            rows.push(new ActionRowBuilder().addComponents(optionButtons.slice(i, i + 5)));
        }

        rows.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`poll_close:${session.id}`)
                    .setLabel(session.closed ? 'Poll Closed' : 'Close Poll')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(session.closed)
            )
        );

        return rows;
    }

    function formatPollContent(session) {
        const totalVotes = session.votes.size;
        return `**Poll:** ${session.question}\nVotes: ${totalVotes}\nCreated by: <@${session.creatorId}>`;
    }

    function buildMcqRows(session) {
        const optionButtons = session.options.map((opt, idx) => {
            const style = session.revealed && idx === session.correctIndex
                ? ButtonStyle.Success
                : ButtonStyle.Primary;
            return new ButtonBuilder()
                .setCustomId(`mcq_answer:${session.id}:${idx}`)
                .setLabel(compactLabel(opt))
                .setStyle(style)
                .setDisabled(session.closed || session.revealed);
        });

        const rows = [];
        for (let i = 0; i < optionButtons.length; i += 5) {
            rows.push(new ActionRowBuilder().addComponents(optionButtons.slice(i, i + 5)));
        }

        rows.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mcq_reveal:${session.id}`)
                    .setLabel(session.revealed ? 'Answer Revealed' : 'Reveal Answer')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(session.revealed),
                new ButtonBuilder()
                    .setCustomId(`mcq_close:${session.id}`)
                    .setLabel(session.closed ? 'MCQ Closed' : 'Close MCQ')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(session.closed)
            )
        );

        return rows;
    }

    function formatMcqContent(session) {
        const answered = session.answers.size;
        const correctCount = Array.from(session.answers.values()).filter((idx) => idx === session.correctIndex).length;
        const answerLine = session.revealed ? `\nCorrect answer: **${session.options[session.correctIndex]}**` : '';
        return `**MCQ:** ${session.question}\nAnswered: ${answered}\nCorrect: ${correctCount}${answerLine}\nCreated by: <@${session.creatorId}>`;
    }

    async function registerSlashCommands(clientInstance) {
        const commands = [
            new SlashCommandBuilder()
                .setName('poll')
                .setDescription('Create a button-based poll')
                .addStringOption((opt) => opt.setName('question').setDescription('Poll question').setRequired(true))
                .addStringOption((opt) => opt.setName('option1').setDescription('Option 1').setRequired(true))
                .addStringOption((opt) => opt.setName('option2').setDescription('Option 2').setRequired(true))
                .addStringOption((opt) => opt.setName('option3').setDescription('Option 3').setRequired(false))
                .addStringOption((opt) => opt.setName('option4').setDescription('Option 4').setRequired(false)),
            new SlashCommandBuilder()
                .setName('mcq')
                .setDescription('Create an MCQ with a correct answer and button options')
                .addStringOption((opt) => opt.setName('question').setDescription('MCQ question').setRequired(true))
                .addStringOption((opt) => opt.setName('option1').setDescription('Option 1').setRequired(true))
                .addStringOption((opt) => opt.setName('option2').setDescription('Option 2').setRequired(true))
                .addStringOption((opt) => opt.setName('option3').setDescription('Option 3').setRequired(true))
                .addStringOption((opt) => opt.setName('option4').setDescription('Option 4').setRequired(true))
                .addIntegerOption((opt) => opt
                    .setName('correct_option')
                    .setDescription('Correct option number (1-4)')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(4)),
            new SlashCommandBuilder()
                .setName('rex_restart')
                .setDescription('Restart Rex bot process to apply updates')
                .addStringOption((opt) => opt.setName('reason').setDescription('Optional restart reason').setRequired(false)),
            new SlashCommandBuilder()
                .setName('rex_mode')
                .setDescription('Switch Rex personality mode for your session')
                .addStringOption((opt) => opt
                    .setName('mode')
                    .setDescription('Choose a Rex personality mode')
                    .setRequired(true)
                    .addChoices(
                        { name: 'default', value: 'default' },
                        { name: 'vibes', value: 'vibes' },
                        { name: 'intern', value: 'intern' },
                        { name: 'savage', value: 'savage' },
                        { name: 'rocky', value: 'rocky' }
                    ))
        ];

        const extraCommands = agenticRuntime.getSlashCommands();
        const allCommands = [...commands, ...extraCommands].map((cmd) => cmd.toJSON());

        if (config.discordGuildId) {
            const guild = await clientInstance.guilds.fetch(String(config.discordGuildId));
            await guild.commands.set(allCommands);
            return 'guild';
        }

        await clientInstance.application.commands.set(allCommands);
        return 'global';
    }

    if (!config.discordBotToken) {
        const token = await p.password({ message: 'Enter your Discord Bot Token to start the Two-Way Companion:' });
        if (p.isCancel(token) || !token) return;
        config.discordBotToken = token;
        const configPath = path.join(process.env.USERPROFILE || process.env.HOME, '.power-cli', 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        p.note(pc.green('Token saved securely to your local configuration.'), 'Discord Bot Setup');
    }

    const s = p.spinner();
    s.start('Connecting to the Discord Gateway...');

    const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, EndBehaviorType } = await import('@discordjs/voice').catch(() => ({}));
    const { default: Prism } = await import('prism-media').catch(() => ({}));
    const { default: OpenAI } = await import('openai').catch(() => ({}));
    const activeVoiceConnections = {};

    function startTypingHeartbeat(channel, intervalMs = 7000) {
        if (!channel || typeof channel.sendTyping !== 'function') {
            return () => {};
        }

        let stopped = false;
        let timer = null;

        const pingTyping = async () => {
            if (stopped) return;
            try {
                await channel.sendTyping();
            } catch {}
        };

        void pingTyping();
        timer = setInterval(() => {
            void pingTyping();
        }, intervalMs);

        return () => {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };
    }

    async function processAgentRequestWrapper(userId, userTag, inputMessage, originalMessage, discordHistory, userPersonas, activeVoiceConnections) {
        const stopTypingHeartbeat = startTypingHeartbeat(originalMessage?.channel);
        try {
            const finalReplyText = await processAgentRequest({
                userId,
                userTag,
                inputMessage,
                history: discordHistory,
                userPersonas,
                platformCtx: {
                    reply: async (text) => {
                        if (text.length > 1950) {
                            const tmpPath = path.join(process.cwd(), `response_${Date.now()}.md`);
                            fs.writeFileSync(tmpPath, text);
                            await originalMessage.reply({ content: 'I wrote a whole essay for you! Check the file below: 🦖📄', files: [tmpPath] });
                            try { fs.unlinkSync(tmpPath); } catch {}
                        } else {
                            await originalMessage.reply(text);
                        }
                    },
                    sendFile: async (filePath, caption) => {
                        const { AttachmentBuilder } = await import('discord.js');
                        const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });
                        await originalMessage.reply({ content: caption || '', files: [attachment] });
                    },
                    sendTyping: async () => {
                        await originalMessage.channel.sendTyping().catch(() => {});
                    },
                    requestComputerPermission: async (task) => {
                        return requestComputerPermission({
                            message: originalMessage,
                            task,
                            client: originalMessage.client
                        });
                    },
                    fileToolName: 'send_discord_file'
                }
            });

            if (finalReplyText) {
                console.log(`${pc.green('Rex (Discord):')} ${finalReplyText.substring(0, 50).replace(/\n/g, ' ')}...`);

                // Voice TTS Stream Response via Cartesia
                const vc = activeVoiceConnections[originalMessage.guild?.id];
                if (vc) {
                    try {
                        const { playTtsToVoicePlayer } = await import('./cartesia.js');
                        await playTtsToVoicePlayer(vc.player, finalReplyText, String(originalMessage.id || Date.now()));
                    } catch(e) { console.error("Voice TTS Output Error: ", e.message); }
                }
            }
        } catch (err) {
            console.error(pc.red(`Error processing agent request: ${err.message}`));
            await originalMessage.reply('I ran into a tiny kernel panic trying to process that. 🦖💥').catch(() => {});
        } finally {
            stopTypingHeartbeat();
        }
    }

    function createWavHeader(dataLength, sampleRate = 48000, numChannels = 1, bitsPerSample = 16) {
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataLength, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
        header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);
        return header;
    }

    function setupVoiceReceiver(connection, channel, sourceUserId) {
        const receiver = connection.receiver;
        const activeVoiceStreams = new Map();
        
        receiver.speaking.on('start', (userId) => {
            if (userId !== sourceUserId) return;
            // Prevent duplicate subscriptions while the user is already speaking
            if (activeVoiceStreams.has(userId)) return;
            
            const opusStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 1200,
                },
            });

            activeVoiceStreams.set(userId, opusStream);

            const wavPath = path.join(process.cwd(), `.rex_transcription_${Date.now()}.wav`);
            const pcmChunks = [];
            
            // Decode incoming Opus packets to PCM (48kHz, mono, 16-bit)
            const decoder = new Prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });

            // Catch any decoder errors gracefully (prevents unhandled crash in wasm/opusscript)
            decoder.on('error', (err) => {
                console.warn(pc.yellow(`[Rex Voice] Opus decoder warning: ${err.message}`));
            });

            opusStream.on('error', (err) => {
                console.warn(pc.yellow(`[Rex Voice] Opus stream warning: ${err.message}`));
                activeVoiceStreams.delete(userId);
                try { decoder.destroy(); } catch {}
            });

            opusStream.on('close', () => {
                activeVoiceStreams.delete(userId);
            });

            const pcmStream = opusStream.pipe(decoder);
            pcmStream.on('data', chunk => pcmChunks.push(chunk));
            pcmStream.on('error', (err) => {
                console.warn(pc.yellow(`[Rex Voice] PCM stream warning: ${err.message}`));
            });

            opusStream.on('end', async () => {
                activeVoiceStreams.delete(userId);
                try { decoder.destroy(); } catch {}

                const pcmBuffer = Buffer.concat(pcmChunks);
                if (pcmBuffer.length < 4800) return; // Ignore bursts <0.05s

                const wavHeader = createWavHeader(pcmBuffer.length, 48000, 1, 16);
                fs.writeFileSync(wavPath, Buffer.concat([wavHeader, pcmBuffer]));
                
                try {
                    const config = loadConfig();
                    let text = '';

                    if (config.openaiKey) {
                        const openai = new OpenAI({ apiKey: config.openaiKey });
                        const transcription = await openai.audio.transcriptions.create({
                            file: fs.createReadStream(wavPath),
                            model: "whisper-1"
                        });
                        text = (transcription.text || '').trim();
                    } else if (config.geminiKey) {
                        try {
                            const { GoogleGenerativeAI } = await import('@google/generative-ai');
                            const genAI = new GoogleGenerativeAI(config.geminiKey);
                            const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
                            const audioBytes = fs.readFileSync(wavPath).toString('base64');
                            const result = await model.generateContent([
                                { inlineData: { mimeType: 'audio/wav', data: audioBytes } },
                                'Transcribe the exact words spoken in this audio. Return ONLY the transcribed text with no commentary.'
                            ]);
                            text = (result.response.text() || '').trim();
                        } catch (gErr) {
                            console.warn('[Rex Voice] Gemini audio transcription error:', gErr.message);
                        }
                    } else {
                        return channel.send("I heard you, but no OpenAI or Gemini key is configured for voice transcription.");
                    }

                    if (!text || text.length < 2) return;

                    console.log(`${pc.bgBlue(pc.white(' DISCORD VOICE '))} ${pc.bold(userId)}: ${text}`);

                    // ─── Proactive Feature: Voice HUD (Snippet Drop) ───
                    const technicalKeywords = ['schema', 'auth', 'config', 'model', 'api', 'route', 'endpoint', 'retry', 'error', 'database', 'env'];
                    const hasKeyword = technicalKeywords.some(k => text.toLowerCase().includes(k));
                    
                    if (hasKeyword) {
                        setTimeout(async () => {
                            try {
                                const { queryMemory } = await import('./memory.js');
                                const match = await queryMemory(text);
                                if (match && match.length > 50) {
                                    await channel.send(`🦖🎙️ **Voice HUD**: I heard you mention code-related keywords. Here is some project context I found:\n\`\`\`\n${match.slice(0, 500)}...\n\`\`\``);
                                }
                            } catch {}
                        }, 1000);
                    }
                    
                    // Respond visually in text channel + speak back in call via Cartesia
                    const finalReplyText = await processAgentRequest({
                        userId,
                        userTag: 'Voice User',
                        inputMessage: text,
                        history: discordHistory,
                        userPersonas,
                        platformCtx: {
                            reply: async (c) => channel.send(`🦖🎙️ **[Voice]**: ${c}`),
                            sendFile: async (p, c) => {
                                const { AttachmentBuilder } = await import('discord.js');
                                const attachment = new AttachmentBuilder(p, { name: path.basename(p) });
                                await channel.send({ content: c || '', files: [attachment] });
                            },
                        }
                    });

                    // Talk back on calls using Cartesia Voice!
                    if (finalReplyText) {
                        const vc = activeVoiceConnections[channel.guild?.id];
                        if (vc) {
                            const { playTtsToVoicePlayer } = await import('./cartesia.js');
                            await playTtsToVoicePlayer(vc.player, finalReplyText, `voice_${Date.now()}`);
                        }
                    }
                } catch (e) {
                    console.error("Transcription Failed: ", e.message);
                } finally {
                    try { fs.unlinkSync(wavPath); } catch(e) {}
                }
            });
        });
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.GuildVoiceStates
        ],
        partials: [Partials.Channel]
    });

    client.once(Events.ClientReady, async c => {
        s.stop(pc.green(`Connected to Discord Gateway! Logged in as ${c.user.tag}`));
        p.note(pc.cyan('Rex is now alive on Discord. Mention him (@Rex) in a server or send him a Direct Message.'), 'Discord Companion');

        try {
            const scope = await registerSlashCommands(c);
            p.note(pc.green(`Registered slash commands (${scope} scope): /poll and /mcq`), 'Discord Commands');
        } catch (err) {
            p.note(pc.yellow(`Failed to register slash commands: ${err.message}`), 'Discord Commands');
        }

        try {
            startCompanionEngine(c);
            p.note(pc.magenta('Companion & check-in delegate engine started.'), 'Companion Delegates');
        } catch (err) {
            console.error(pc.yellow(`Failed to start companion delegate engine: ${err.message}`));
        }

        try {
            startBurnoutSentinel(c);
            p.note(pc.cyan('Burnout Sentinel & late-night work rhythm watcher active.'), 'Burnout Sentinel');
        } catch (err) {
            console.error(pc.yellow(`Failed to start burnout sentinel: ${err.message}`));
        }

        // Periodic Social Radar check for day-of reminders (every hour)
        setInterval(async () => {
            try {
                const dueEvents = getDueEventsToday();
                if (dueEvents.length > 0) {
                    const cfg = loadConfig();
                    const allowedIds = Array.isArray(cfg.discordAllowedUserIds) ? cfg.discordAllowedUserIds : [];
                    const ownerId = allowedIds.find(id => id && id !== '*');
                    if (ownerId) {
                        const owner = await c.users.fetch(ownerId);
                        if (owner) {
                            for (const ev of dueEvents) {
                                await owner.send(`🦖📡 **Social Radar Alert**: Today is **${ev.person}**'s ${ev.event}! Drop them a quick good-luck text or check in on them? 💚`);
                            }
                            const all = loadSocialRadar();
                            saveSocialRadar(all.map(item => {
                                const match = dueEvents.find(d => d.id === item.id);
                                return match ? { ...item, reminded: true } : item;
                            }));
                        }
                    }
                }
            } catch {}
        }, 60 * 60 * 1000);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            const handledByAgentic = await agenticRuntime.handleInteraction(interaction);
            if (handledByAgentic) return;

            if (interaction.isChatInputCommand()) {
                if (interaction.commandName === 'rex_mode') {
                    const requested = String(interaction.options.getString('mode', true) || '').toLowerCase();
                    if (!PLATFORM_PERSONAS[requested]) {
                        await interaction.reply({ content: `Unknown mode: ${requested}`, ephemeral: true });
                        return;
                    }

                    const priorHistory = Array.isArray(discordHistory[interaction.user.id])
                        ? discordHistory[interaction.user.id]
                        : [];
                    const lastTurn = priorHistory.length > 0 ? priorHistory[priorHistory.length - 1] : null;

                    userPersonas[interaction.user.id] = requested;
                    discordHistory[interaction.user.id] = lastTurn ? [lastTurn] : [];

                    await interaction.reply({
                        content: `Rex mode switched to **${requested}**. Context reset applied (kept only the most recent prior message).`,
                        ephemeral: true
                    });
                    return;
                }

                if (interaction.commandName === 'rex_restart') {
                    if (!userCanRestartBot(interaction.user.id)) {
                        await interaction.reply({ content: 'You are not allowed to restart this bot.', ephemeral: true });
                        return;
                    }

                    const reason = interaction.options.getString('reason', false) || 'Manual restart command';
                    await interaction.reply({ content: `Restarting Rex now. Reason: ${reason}`, ephemeral: true });
                    await restartWholeBotProcess(reason);
                    return;
                }

                if (interaction.commandName === 'poll') {
                    const question = interaction.options.getString('question', true);
                    const options = [
                        interaction.options.getString('option1', true),
                        interaction.options.getString('option2', true),
                        interaction.options.getString('option3', false),
                        interaction.options.getString('option4', false)
                    ].filter(Boolean);

                    const id = toSessionId();
                    const session = {
                        id,
                        question,
                        options,
                        creatorId: interaction.user.id,
                        votes: new Map(),
                        closed: false,
                        messageId: ''
                    };

                    await interaction.reply({
                        content: formatPollContent(session),
                        components: buildPollRows(session)
                    });

                    const sent = await interaction.fetchReply();
                    session.messageId = sent.id;
                    pollSessions.set(id, session);
                    return;
                }

                if (interaction.commandName === 'mcq') {
                    const question = interaction.options.getString('question', true);
                    const options = [
                        interaction.options.getString('option1', true),
                        interaction.options.getString('option2', true),
                        interaction.options.getString('option3', true),
                        interaction.options.getString('option4', true)
                    ];
                    const correctOption = interaction.options.getInteger('correct_option', true);

                    const id = toSessionId();
                    const session = {
                        id,
                        question,
                        options,
                        creatorId: interaction.user.id,
                        correctIndex: correctOption - 1,
                        answers: new Map(),
                        closed: false,
                        revealed: false,
                        messageId: ''
                    };

                    await interaction.reply({
                        content: formatMcqContent(session),
                        components: buildMcqRows(session)
                    });

                    const sent = await interaction.fetchReply();
                    session.messageId = sent.id;
                    mcqSessions.set(id, session);
                    return;
                }
            }

            if (!interaction.isButton()) return;

            const [kind, sessionId, value] = String(interaction.customId || '').split(':');

            if (kind === 'computer_perm') {
                const handled = await handleComputerPermissionInteraction(interaction);
                if (handled) return;
            }

            if (kind === 'poll_vote') {
                const session = pollSessions.get(sessionId);
                if (!session) {
                    await interaction.reply({ content: 'This poll session no longer exists.', ephemeral: true });
                    return;
                }
                if (session.closed) {
                    await interaction.reply({ content: 'This poll is already closed.', ephemeral: true });
                    return;
                }

                const voteIndex = Number(value);
                session.votes.set(interaction.user.id, voteIndex);

                await interaction.update({
                    content: formatPollContent(session),
                    components: buildPollRows(session)
                });
                return;
            }

            if (kind === 'poll_close') {
                const session = pollSessions.get(sessionId);
                if (!session) {
                    await interaction.reply({ content: 'This poll session no longer exists.', ephemeral: true });
                    return;
                }
                if (interaction.user.id !== session.creatorId) {
                    await interaction.reply({ content: 'Only the poll creator can close this poll.', ephemeral: true });
                    return;
                }

                session.closed = true;
                await interaction.update({
                    content: `${formatPollContent(session)}\nStatus: Closed`,
                    components: buildPollRows(session)
                });
                return;
            }

            if (kind === 'mcq_answer') {
                const session = mcqSessions.get(sessionId);
                if (!session) {
                    await interaction.reply({ content: 'This MCQ session no longer exists.', ephemeral: true });
                    return;
                }
                if (session.closed) {
                    await interaction.reply({ content: 'This MCQ is already closed.', ephemeral: true });
                    return;
                }

                const answerIndex = Number(value);
                if (session.answers.has(interaction.user.id)) {
                    await interaction.reply({ content: 'You already answered this MCQ.', ephemeral: true });
                    return;
                }

                session.answers.set(interaction.user.id, answerIndex);
                const correct = answerIndex === session.correctIndex;

                await interaction.update({
                    content: formatMcqContent(session),
                    components: buildMcqRows(session)
                });

                await interaction.followUp({
                    content: correct ? 'Correct answer.' : 'Not correct. Keep going.',
                    ephemeral: true
                });
                return;
            }

            if (kind === 'mcq_reveal') {
                const session = mcqSessions.get(sessionId);
                if (!session) {
                    await interaction.reply({ content: 'This MCQ session no longer exists.', ephemeral: true });
                    return;
                }
                if (interaction.user.id !== session.creatorId) {
                    await interaction.reply({ content: 'Only the MCQ creator can reveal the answer.', ephemeral: true });
                    return;
                }

                session.revealed = true;
                await interaction.update({
                    content: formatMcqContent(session),
                    components: buildMcqRows(session)
                });
                return;
            }

            if (kind === 'mcq_close') {
                const session = mcqSessions.get(sessionId);
                if (!session) {
                    await interaction.reply({ content: 'This MCQ session no longer exists.', ephemeral: true });
                    return;
                }
                if (interaction.user.id !== session.creatorId) {
                    await interaction.reply({ content: 'Only the MCQ creator can close this MCQ.', ephemeral: true });
                    return;
                }

                session.closed = true;
                await interaction.update({
                    content: `${formatMcqContent(session)}\nStatus: Closed`,
                    components: buildMcqRows(session)
                });
            }
        } catch (err) {
            const errorMessage = `Interaction failed: ${err.message}`;
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
            }
        }
    });

    // Shared legacy personas definitions removed - now using chatPlatformCore.js

    const discordHistory = {};
    const userPersonas = {};
    const recentChannelMessages = new Map(); // buffer for vibe analysis
    const channelProactiveConfig = new Map(); // opt-out storage

    client.on(Events.MessageCreate, async message => {
        if (message.author.bot) return;

        // Record user activity timestamp for Burnout Sentinel
        try { recordUserActivity(); } catch {}

        // ─── Proactive Feature: Vibe Sentinel & Buffer ───
        if (!recentChannelMessages.has(message.channelId)) recentChannelMessages.set(message.channelId, []);
        const buffer = recentChannelMessages.get(message.channelId);
        buffer.push({ author: message.author.username, content: message.content, ts: Date.now() });
        if (buffer.length > 50) buffer.shift();

        // ─── Proactive Feature: Ghost Investigator (Opt-out) ───
        const isOptedOut = channelProactiveConfig.get(message.channelId)?.ghostInvestigator === false;
        const hasUrl = /https?:\/\/(?:www\.)?github\.com\/[^\s]+|https?:\/\/[^\s]+(?:\.pdf|\.md|issue|pull)/i.test(message.content);
        
        if (!isOptedOut && hasUrl && !message.mentions.has(client.user)) {
            const keywords = ['fix', 'bug', 'auth', 'schema', 'db', 'api', 'deploy', 'error', 'fails'];
            const needsInvestigating = keywords.some(k => message.content.toLowerCase().includes(k));
            
            if (needsInvestigating) {
                // Ghost Investigator triggers in background
                setTimeout(async () => {
                    try {
                        const { run_autonomous_web_agent } = await import('./webTools.js');
                        const urlMatch = message.content.match(/https?:\/\/[^\s]+/);
                        if (!urlMatch) return;
                        
                        const summary = await run_autonomous_web_agent({ goal: `Read this link and provide a 1-sentence technical TL;DR relevant to a software engineer: ${urlMatch[0]}` }, null);
                        if (summary && summary.length > 10) {
                            await message.channel.send(`🦖🕵️ **Ghost Investigator**: I peeked at that link. TL;DR: ${summary.slice(0, 400)}`);
                        }
                    } catch {}
                }, 2000);
            }
        }

        // ─── Proactive Feature: Vibe Sentinel Trigger (every 15 msgs) ───
        if (buffer.length % 15 === 0) {
            setTimeout(async () => {
                const { analyzeSocialVibe } = await import('./moodEngine.js');
                const vibe = await analyzeSocialVibe(buffer);
                if (vibe === 'tense') {
                    await message.channel.send("🦖 *pokes head in* Vibe check... things looking a bit tense. Need me to summarize the disagreement or should I just stay out of the blast radius?");
                }
            }, 1000);
        }

        try {
            const handledByRuntimeMessage = await agenticRuntime.handleMessage(message);
            if (handledByRuntimeMessage) return;
        } catch (e) {
            console.error(pc.red(`Agentic message handling failed: ${e.message}`));
        }

        // ─── Computer Control: Handle Pending Permission Text ("yes", "confirm", "cancel") ───
        try {
            const permTextHandled = await handleComputerPermissionTextMessage(message);
            if (permTextHandled?.handled) return;
        } catch (e) {
            console.error(pc.red(`Computer permission text handling failed: ${e.message}`));
        }

        const isDM = message.channel.isDMBased();
        const isMentioned = message.mentions.has(client.user);

        if (isDM || isMentioned) {
            let cleanContent = message.content.replace(`<@${client.user.id}>`, '').trim();

            // ─── Computer Control: Intent Detection & Permission Request Gating ───
            try {
                const intent = detectComputerControlIntent(cleanContent);
                if (intent.requiresControl) {
                    await requestComputerPermission({
                        message,
                        task: intent.task,
                        client
                    });
                    return;
                }
            } catch (e) {
                console.error(pc.red(`Computer control intent detection failed: ${e.message}`));
            }

            // ─── Companion Delegate: Target User Conversational Sandbox (Zero Computer Control) ───
            try {
                const targetHandled = await handleTargetUserMessage(message, cleanContent, client);
                if (targetHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Companion target message handling failed: ${e.message}`));
            }

            // ─── Companion Delegate: Mission Commands (Checkup / Texting Delegate) ───
            try {
                const companionCmdHandled = await tryHandleCompanionCommand({ message, cleanContent, client, config });
                if (companionCmdHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Companion command handling failed: ${e.message}`));
            }

            // ─── Social Radar Commands ───
            try {
                const socialHandled = await tryHandleSocialRadarCommand({ message, cleanContent });
                if (socialHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Social radar command handling failed: ${e.message}`));
            }

            // ─── Burnout Sentinel Commands ───
            try {
                const burnoutHandled = await tryHandleBurnoutCommand({ message, cleanContent });
                if (burnoutHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Burnout command handling failed: ${e.message}`));
            }

            // ─── Neural Voice Memo Commands (Cartesia TTS) ───
            try {
                const voiceMemoHandled = await tryHandleVoiceMemoCommand({ message, cleanContent });
                if (voiceMemoHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Voice memo command handling failed: ${e.message}`));
            }

            // ─── Dino Hoard & Inside Jokes Commands ───
            try {
                const hoardHandled = await tryHandleDinoHoardCommand({ message, cleanContent });
                if (hoardHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Dino hoard command handling failed: ${e.message}`));
            }

            // ─── iMessage & SMS Commands ───
            try {
                const imessageHandled = await tryHandleIMessageCommand({ message, cleanContent });
                if (imessageHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`iMessage command handling failed: ${e.message}`));
            }

            // ─── macOS Shortcuts Commands ───
            try {
                const shortcutHandled = await tryHandleShortcutsCommand({ message, cleanContent });
                if (shortcutHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Shortcuts command handling failed: ${e.message}`));
            }

            // ─── Camera / Webcam Snapshot Commands ───
            try {
                const cameraHandled = await tryHandleCameraCommand({ message, cleanContent });
                if (cameraHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Camera command handling failed: ${e.message}`));
            }

            // ─── Obsidian Vault Commands ───
            try {
                const obsidianHandled = await tryHandleObsidianCommand({ message, cleanContent });
                if (obsidianHandled?.handled) return;
            } catch (e) {
                console.error(pc.red(`Obsidian command handling failed: ${e.message}`));
            }

            let hasImage = false;
            let contentArray = [];
            let textBody = '';

            // Handle Attachments (read text files, pdfs, and images seamlessly)
            if (message.attachments.size > 0) {
                const attachmentsText = [];
                for (const attachment of message.attachments.values()) {
                    const cType = attachment.contentType || '';
                    
                    if (cType.startsWith('image/')) {
                        try {
                            const res = await fetch(attachment.url);
                            const buffer = await res.arrayBuffer();
                            const base64 = Buffer.from(buffer).toString('base64');
                            contentArray.push({ type: 'image_url', image_url: { url: `data:${cType};base64,${base64}` } });
                            hasImage = true;
                        } catch(e) {
                            attachmentsText.push(`[Failed to load image: ${attachment.name}]`);
                        }
                    } else if (cType === 'application/pdf') {
                        try {
                            const res = await fetch(attachment.url);
                            const buffer = await res.arrayBuffer();
                            const pdfLib = await import('pdf-parse');
                            // Handle CJS vs ESM import quirk
                            const pdfParse = pdfLib.default || pdfLib;
                            const parsed = await pdfParse(Buffer.from(buffer));
                            attachmentsText.push(`[Attached PDF: ${attachment.name}]\n\`\`\`\n${parsed.text.slice(0, 15000)}\n\`\`\``);
                        } catch(e) {
                            attachmentsText.push(`[Failed to read PDF: ${attachment.name} (Error: ${e.message})]`);
                        }
                    } else if (cType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || attachment.name.endsWith('.docx')) {
                        try {
                            const res = await fetch(attachment.url);
                            const buffer = await res.arrayBuffer();
                            const mammoth = await import('mammoth');
                            const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
                            attachmentsText.push(`[Attached DOCX: ${attachment.name}]\n\`\`\`\n${result.value.slice(0, 15000)}\n\`\`\``);
                        } catch(e) {
                            attachmentsText.push(`[Failed to read DOCX: ${attachment.name} (Error: ${e.message})]`);
                        }
                    } else if (cType.startsWith('text/') || cType === 'application/json' || attachment.name.match(/\.(md|js|ts|py|json|html|css|txt|csv|log)$/i)) {
                        try {
                            const res = await fetch(attachment.url);
                            const text = await res.text();
                            attachmentsText.push(`[Attached File: ${attachment.name}]\n\`\`\`\n${text.slice(0, 15000)}\n\`\`\``);
                        } catch(e) {
                            attachmentsText.push(`[Failed to read attached file: ${attachment.name}]`);
                        }
                    } else {
                         attachmentsText.push(`[User attached media: ${attachment.name}. Tell them you can only read text/code/pdfs and images right now.]`);
                    }
                }
                if (attachmentsText.length > 0) {
                    cleanContent += (cleanContent ? '\n\n' : '') + attachmentsText.join('\n\n');
                }
            }
            
            textBody = `[From ${message.author.username}]: ${cleanContent}`;

            if (!cleanContent && !hasImage) return;

            // Handle set gif key commands
            if (cleanContent.toLowerCase().startsWith('set tenor key ')) {
                const key = cleanContent.split(' ')[3]; 
                if (key) {
                    const cfg = loadConfig();
                    cfg.tenorApiKey = key;
                    saveConfig(cfg);
                    await message.reply("✅ Tenor API Key updated! I can now send high-quality gifs. 🦖🎬");
                }
                return;
            }
            if (cleanContent.toLowerCase().startsWith('set giphy key ')) {
                const key = cleanContent.split(' ')[3]; 
                if (key) {
                    const cfg = loadConfig();
                    cfg.giphyApiKey = key;
                    saveConfig(cfg);
                    await message.reply("✅ Giphy API Key updated! I'll use Giphy for high-quality reactions now. 🦖🎬");
                }
                return;
            }

            // Screen Vision command (JARVIS) — Bang or Natural Language
            const visionMatch = cleanContent.match(/^(?:!(?:screen|vision)\b|(?:hey rex[, ]*)?(?:what(?:'s|\s+is)\s*(?:on|showing on)\s*my\s*screen|look\s*at\s*(?:my\s*)?screen|analyze\s*(?:my\s*)?screen|check\s*(?:my\s*)?screen|what do you see on my screen)\??)/i);
            if (visionMatch) {
                const prompt = cleanContent.replace(/^(?:!(?:screen|vision)\s*|(?:hey rex[, ]*)?(?:what(?:'s|\s+is)\s*(?:on|showing on)\s*my\s*screen|look\s*at\s*(?:my\s*)?screen|analyze\s*(?:my\s*)?screen|check\s*(?:my\s*)?screen|what do you see on my screen)\??\s*)/i, '').trim();
                const statusMsg = await message.reply("📸 *Scanning display and running vision analysis...*");
                try {
                    const { analyzeScreen } = await import('./vision.js');
                    const analysis = await analyzeScreen(null, prompt || null);
                    await statusMsg.edit(`👁️ **Rex Vision (JARVIS)**:\n\n${analysis.slice(0, 1900)}`);
                    const vc = activeVoiceConnections[message.guild?.id];
                    if (vc) {
                        const { playTtsToVoicePlayer } = await import('./cartesia.js');
                        await playTtsToVoicePlayer(vc.player, analysis, `screen_${Date.now()}`);
                    }
                } catch (e) {
                    await statusMsg.edit(`❌ Vision analysis failed: ${e.message}`);
                }
                return;
            }

            // Butler / Briefing command (Alfred) — Bang or Natural Language
            const briefingMatch = cleanContent.match(/^(?:!(?:butler|briefing)\b|(?:hey rex[, ]*)?(?:give\s*me\s*(?:a|my)\s*)?(?:morning\s*briefing|daily\s*briefing|butler\s*briefing)\b)/i);
            if (briefingMatch) {
                const subCmd = cleanContent.replace(/^(?:!(?:butler|briefing)\s*|(?:hey rex[, ]*)?(?:give\s*me\s*(?:a|my)\s*)?(?:morning\s*briefing|daily\s*briefing|butler\s*briefing)\s*)/i, '').toLowerCase().trim();
                if (subCmd === 'on' || subCmd === 'enable') {
                    const { toggleAlfredButler } = await import('./alfredButler.js');
                    const msg = await toggleAlfredButler(true);
                    await message.reply(msg);
                } else if (subCmd === 'off' || subCmd === 'disable') {
                    const { toggleAlfredButler } = await import('./alfredButler.js');
                    const msg = await toggleAlfredButler(false);
                    await message.reply(msg);
                } else {
                    const { generateMorningBriefing } = await import('./alfredButler.js');
                    const briefing = await generateMorningBriefing();
                    await message.reply(`${briefing.greeting}\n\n${briefing.text}`);
                    const vc = activeVoiceConnections[message.guild?.id];
                    if (vc) {
                        const { playTtsToVoicePlayer } = await import('./cartesia.js');
                        await playTtsToVoicePlayer(vc.player, briefing.text, `briefing_${Date.now()}`);
                    }
                }
                return;
            }

            // macOS AppleScript Bridge (!mac ...) or Natural Language Volume/Media/Lock/Mute
            const macVolMatch = cleanContent.match(/^(?:!mac\s+volume\s*(\d{1,3})?|(?:hey rex[, ]*)?(?:please\s*)?(?:turn|set|put|change)?\s*(?:the\s*)?(?:mac\s*)?volume\s*(?:on\s*(?:my\s*)?mac\s*)?(?:to\s*)?(\d{1,3})%?)$/i);
            const macMuteMatch = cleanContent.match(/^(?:!mac\s+mute\b|(?:hey rex[, ]*)?(?:mute|silence)\s*(?:the\s*)?(?:my\s*)?mac$)/i);
            const macUnmuteMatch = cleanContent.match(/^(?:!mac\s+unmute\b|(?:hey rex[, ]*)?unmute\s*(?:the\s*)?(?:my\s*)?mac$)/i);
            const macLockMatch = cleanContent.match(/^(?:!mac\s+lock\b|(?:hey rex[, ]*)?lock\s*(?:my\s*)?mac$)/i);
            const macSleepMatch = cleanContent.match(/^(?:!mac\s+sleep\b|(?:hey rex[, ]*)?(?:put\s*(?:my\s*)?mac\s*to\s*sleep|sleep\s*(?:my\s*)?mac)$)/i);
            const macMediaMatch = cleanContent.match(/^(?:!mac\s+media\s*(play|pause|next|prev|previous|track)?|(?:hey rex[, ]*)?(?:(pause|stop|play|resume|next|skip|previous|prev)\s*(?:the\s*)?(?:music|spotify|playback|song)|(?:what(?:'s|\s+is)\s*(?:the\s*)?(?:current\s*)?(?:playing|song|track)|what\s*song\s*is\s*(?:this|playing)|what['’]s playing)))$/i);

            if (cleanContent.match(/^!mac\b/i) || macVolMatch || macMuteMatch || macUnmuteMatch || macLockMatch || macSleepMatch || macMediaMatch) {
                const { executeAppleScript, macSystem, macMedia, macBrowsers } = await import('./appleScript.js');
                const vc = activeVoiceConnections[message.guild?.id];

                const speakIfVoice = async (text) => {
                    if (vc) {
                        try {
                            const { playTtsToVoicePlayer } = await import('./cartesia.js');
                            await playTtsToVoicePlayer(vc.player, text, `mac_${Date.now()}`);
                        } catch {}
                    }
                };

                if (macVolMatch) {
                    const rawVal = macVolMatch[1] || macVolMatch[2];
                    const vol = rawVal !== undefined ? parseInt(rawVal, 10) : NaN;
                    const res = isNaN(vol) ? await macSystem.getVolume() : await macSystem.setVolume(vol);
                    const reply = typeof res === 'number' ? `🔊 Mac volume is at ${res}%.` : `🔊 ${res}`;
                    await message.reply(reply);
                    await speakIfVoice(reply.replace(/[🔊%]/g, ''));
                    return;
                }

                if (macMuteMatch) {
                    const res = await macSystem.setMute(true);
                    await message.reply(`🔇 ${res}`);
                    await speakIfVoice("Mac muted.");
                    return;
                }

                if (macUnmuteMatch) {
                    const res = await macSystem.setMute(false);
                    await message.reply(`🔊 ${res}`);
                    await speakIfVoice("Mac unmuted.");
                    return;
                }

                if (macLockMatch) {
                    await macSystem.lockScreen();
                    await message.reply(`🔒 Mac screen locked.`);
                    await speakIfVoice("Mac locked.");
                    return;
                }

                if (macSleepMatch) {
                    await macSystem.sleepSystem();
                    await message.reply(`🌙 Mac put to sleep.`);
                    return;
                }

                if (macMediaMatch) {
                    const explicit = macMediaMatch[1]?.toLowerCase();
                    const natural = macMediaMatch[2]?.toLowerCase();
                    const action = explicit || natural;

                    if (action === 'play' || action === 'resume') {
                        await macMedia.play();
                        const tr = await macMedia.getCurrentTrack();
                        const rep = tr ? `▶️ Resumed: ${tr.name} by ${tr.artist}` : '▶️ Playback started.';
                        await message.reply(rep);
                        await speakIfVoice(rep.replace(/▶️/g, ''));
                    } else if (action === 'pause' || action === 'stop') {
                        await macMedia.pause();
                        await message.reply('⏸️ Playback paused.');
                        await speakIfVoice('Playback paused.');
                    } else if (action === 'next' || action === 'skip') {
                        await macMedia.next();
                        const tr = await macMedia.getCurrentTrack();
                        const rep = tr ? `⏭️ Playing next: ${tr.name} by ${tr.artist}` : '⏭️ Skipped to next track.';
                        await message.reply(rep);
                        await speakIfVoice(rep.replace(/⏭️/g, ''));
                    } else if (action === 'prev' || action === 'previous') {
                        await macMedia.previous();
                        const tr = await macMedia.getCurrentTrack();
                        const rep = tr ? `⏮️ Playing previous: ${tr.name} by ${tr.artist}` : '⏮️ Returned to previous track.';
                        await message.reply(rep);
                        await speakIfVoice(rep.replace(/⏮️/g, ''));
                    } else {
                        // Track info query
                        const tr = await macMedia.getCurrentTrack();
                        const rep = tr ? `🎵 **${tr.app}**: ${tr.name} by ${tr.artist} (${tr.album}) [${tr.state}]` : 'No track is currently playing.';
                        await message.reply(rep);
                        await speakIfVoice(tr ? `Now playing: ${tr.name} by ${tr.artist}` : 'No track is currently playing.');
                    }
                    return;
                }

                // If explicit !mac <subcommand>
                const raw = cleanContent.replace(/^!mac\s*/i, '').trim();
                const parts = raw.split(' ');
                const sub = parts[0].toLowerCase();
                const rest = parts.slice(1).join(' ').trim();

                if (sub === 'notify') {
                    await macSystem.displayNotification(rest || 'Ping from Discord!');
                    await message.reply(`🔔 Notification triggered on Mac.`);
                } else if (sub === 'tab') {
                    const tab = await macBrowsers.getActiveTab();
                    await message.reply(tab ? `🌐 **${tab.browser}**: ${tab.title}\n<${tab.url}>` : 'No browser tab found.');
                } else {
                    const res = await executeAppleScript(raw);
                    await message.reply(res.success ? `✅ AppleScript output: \`${res.output || 'Done'}\`` : `❌ AppleScript error: ${res.error}`);
                }
                return;
            }

            // Personal Dossier & Knowledge Graph (!dossier, !remember) — Bang or Natural Language
            const dossierMatch = cleanContent.match(/^(?:!(?:dossier|personalmemory)\b|(?:hey rex[, ]*)?(?:who\s*am\s*i\??|what(?:'s|\s+is)\s*(?:in\s*)?my\s*dossier|show\s*(?:my\s*)?dossier)$)/i);
            if (dossierMatch) {
                const { getButlerDossier } = await import('./personalMemory.js');
                await message.reply(`\`\`\`\n${getButlerDossier()}\n\`\`\``);
                return;
            }

            const rememberMatch = cleanContent.match(/^(?:!remember\s+(.+)|(?:hey rex[, ]*)?remember\s+(?:that\s+)?(.+))$/i);
            if (rememberMatch) {
                const fact = (rememberMatch[1] || rememberMatch[2] || '').trim();
                if (!fact) {
                    await message.reply('Usage: `remember that <fact to commit to Rex memory>` or `!remember <fact>`');
                    return;
                }
                const { rememberFact } = await import('./personalMemory.js');
                const msg = rememberFact(fact);
                await message.reply(`🧠 ${msg}`);
                return;
            }

            if (cleanContent.toLowerCase() === 'show ai model' || cleanContent.toLowerCase() === 'show model') {
                const cfg = loadConfig();
                const active = resolvePriorityProvider(cfg);
                await message.reply([
                    `Priority order is: gemini -> openai -> claude -> deepseek -> ollama -> local-llama.`,
                    `Current active provider: ${active.provider}`,
                    `Current active model: ${active.model}`,
                    `Configured models: gemini=${cfg.geminiModel || '-'}, openai=${cfg.openaiModel || '-'}, claude=${cfg.claudeModel || '-'}, deepseek=${cfg.deepseekModel || '-'}, ollama=${cfg.ollamaModel || '-'}, local=${cfg.selectedLocalModel || '-'}`,
                    `Use: set model <provider> <model-name>`
                ].join('\n'));
                return;
            }

            const setModelMatch = cleanContent.match(/^set\s+(?:ai\s+)?model\s+(gemini|openai|claude|deepseek|ollama|local-llama|local)\s+(.+)$/i);
            if (setModelMatch) {
                const provider = String(setModelMatch[1] || '').toLowerCase();
                const modelName = String(setModelMatch[2] || '').trim();
                if (!modelName) {
                    await message.reply('Please provide a model name. Example: set model gemini gemini-3.5-flash');
                    return;
                }

                const cfg = loadConfig();
                if (provider === 'gemini') {
                    cfg.geminiModel = modelName;
                    cfg.aiModel = 'gemini';
                } else if (provider === 'openai') {
                    cfg.openaiModel = modelName;
                    cfg.aiModel = 'openai';
                } else if (provider === 'claude') {
                    cfg.claudeModel = modelName;
                    cfg.aiModel = 'claude';
                } else if (provider === 'deepseek') {
                    cfg.deepseekModel = modelName;
                    cfg.aiModel = 'deepseek';
                } else if (provider === 'ollama') {
                    cfg.ollamaModel = modelName;
                    cfg.aiModel = 'ollama';
                } else {
                    cfg.selectedLocalModel = modelName;
                    cfg.aiModel = 'local-llama';
                }

                saveConfig(cfg);
                const active = resolvePriorityProvider(cfg);
                await message.reply([
                    `✅ Saved model for ${provider}: ${modelName}`,
                    `Active provider/model under priority right now: ${active.provider} / ${active.model}`
                ].join('\n'));
                return;
            }

            // Handle changeperson command
            if (cleanContent.toLowerCase().startsWith('changeperson ')) {
                const requested = cleanContent.split(' ')[1].toLowerCase();
                if (PLATFORM_PERSONAS[requested]) {
                    const priorHistory = Array.isArray(discordHistory[message.author.id])
                        ? discordHistory[message.author.id]
                        : [];
                    const lastTurn = priorHistory.length > 0 ? priorHistory[priorHistory.length - 1] : null;

                    userPersonas[message.author.id] = requested;
                    // Reset context to avoid old personality bleed-through; keep only the last turn.
                    discordHistory[message.author.id] = lastTurn ? [lastTurn] : [];

                    await message.reply(`✅ Personality changed to **${requested}**. Context reset applied (kept only the most recent prior message).`);
                } else {
                    await message.reply(`❌ Unknown personality. Available options: ${Object.keys(PLATFORM_PERSONAS).join(', ')}`);
                }
                return;
            }

            if (cleanContent.toLowerCase().startsWith('vibes')) {
                const tokens = cleanContent.toLowerCase().split(/\s+/);
                const modeToken = tokens[1] || 'status';

                if (modeToken === 'status') {
                    const current = userPersonas[message.author.id] || 'default';
                    await message.reply(`Current Rex mode: **${current}**`);
                    return;
                }

                if (modeToken === 'on') {
                    const priorHistory = Array.isArray(discordHistory[message.author.id])
                        ? discordHistory[message.author.id]
                        : [];
                    const lastTurn = priorHistory.length > 0 ? priorHistory[priorHistory.length - 1] : null;
                    userPersonas[message.author.id] = 'vibes';
                    discordHistory[message.author.id] = lastTurn ? [lastTurn] : [];
                    await message.reply('Rex on Vibes is now **ON**. Chaos mode engaged.');
                    return;
                }

                if (modeToken === 'off') {
                    const priorHistory = Array.isArray(discordHistory[message.author.id])
                        ? discordHistory[message.author.id]
                        : [];
                    const lastTurn = priorHistory.length > 0 ? priorHistory[priorHistory.length - 1] : null;
                    userPersonas[message.author.id] = 'default';
                    discordHistory[message.author.id] = lastTurn ? [lastTurn] : [];
                    await message.reply('Rex on Vibes is now **OFF**. Back to default mode.');
                    return;
                }

                await message.reply('Usage: vibes on | vibes off | vibes status');
                return;
            }

            if (cleanContent.toLowerCase() === 'restart bot' || cleanContent.toLowerCase() === 'rex restart') {
                if (!userCanRestartBot(message.author.id)) {
                    await message.reply('You are not allowed to restart this bot.');
                    return;
                }

                await message.reply('Restarting Rex now to apply updates...');
                await restartWholeBotProcess('Text command restart');
                return;
            }

            // Handle Voice Join/Leave
            if (cleanContent.toLowerCase() === 'join') {
                const voiceChannel = message.member?.voice.channel;
                if (!voiceChannel) return message.reply("You need to be in a voice channel for me to join, bro. 🙄");
                
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                    selfDeaf: false,
                    selfMute: false
                });

                const player = createAudioPlayer();
                connection.subscribe(player);
                activeVoiceConnections[message.guild.id] = { connection, player };

                // Set up Receiver for STT
                setupVoiceReceiver(connection, message.channel, message.author.id);

                await message.reply("I'm in. Don't make it weird. 🦖🎙️");
                return;
            }

            if (cleanContent.toLowerCase() === 'leave') {
                const vc = activeVoiceConnections[message.guild?.id];
                if (vc) {
                    vc.connection.destroy();
                    delete activeVoiceConnections[message.guild.id];
                    await message.reply("Finally. I have actual work to do. 🦖💨");
                }
                return;
            }

            if (config.discordIntentPipelineEnabled !== false && !hasImage) {
                try {
                    const pipelineResult = await tryHandleIntentPipelineMessage({
                        message,
                        cleanContent,
                        config
                    });
                    if (pipelineResult?.handled) {
                        return;
                    }
                } catch (e) {
                    console.error(pc.red(`Intent pipeline failed: ${e.message}`));
                    await message.reply('Structured intent pipeline failed, falling back to legacy agent mode.').catch(() => {});
                }
            }

            console.log(`\n${pc.bgBlue(pc.white(' DISCORD '))} ${pc.bold(message.author.tag)}: ${cleanContent}`);
            
            try { await message.channel.sendTyping(); } catch(e) {}

            const inputPayload = hasImage ? contentArray : textBody;
            if (hasImage) contentArray.unshift({ type: 'text', text: textBody });

            await processAgentRequestWrapper(message.author.id, message.author.tag, inputPayload, message, discordHistory, userPersonas, activeVoiceConnections);
        }
    });

    try {
        await client.login(config.discordBotToken);
    } catch (e) {
        s.stop(pc.red('Failed to connect to Discord.'));
        p.note(e.message, 'Discord Gateway Error');
        if (e.message.includes('token')) {
            config.discordBotToken = '';
            const configPath = path.join(process.env.USERPROFILE || process.env.HOME, '.power-cli', 'config.json');
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            p.note('Invalid token detected. It has been cleared from your settings.', 'Settings Reset');
        }
    }
}
