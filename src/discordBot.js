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
import { loadConfig } from './config.js';
import { tryHandleIntentPipelineMessage } from './intentPipeline/discordPipeline.js';
import { createDiscordAgenticRuntime } from './discordAgenticRuntime.js';

async function executeBackendTool(toolName, args) {
    if (toolName === 'run_shell') {
        return new Promise((resolve) => {
            exec(String(args.command), { cwd: process.cwd() }, (err, stdout, stderr) => {
                if (err) resolve(`Error: ${err.message}\nStderr: ${stderr}`);
                else resolve(stdout || 'Command executed with no output.');
            });
        });
    }
    if (toolName === 'read_file') {
        try {
            const p = path.resolve(process.cwd(), args.filePath);
            return fs.readFileSync(p, 'utf-8');
        } catch (e) {
            return `Failed to read file: ${e.message}`;
        }
    }
    if (toolName === 'write_file') {
        try {
            const p = path.resolve(process.cwd(), args.filePath);
            fs.writeFileSync(p, args.content);
            return 'File written successfully.';
        } catch (e) {
            return `Failed to write file: ${e.message}`;
        }
    }
    if (toolName === 'read_memory') {
        try {
            const { queryMemory } = await import('./memory.js');
            return await queryMemory(args.query || '');
        } catch (e) {
            return `Failed to read memory: ${e.message}`;
        }
    }
    if (toolName === 'autonomous_web_agent') {
        try {
            const { run_autonomous_web_agent } = await import('./webTools.js');
            return await run_autonomous_web_agent(args, null);
        } catch (e) {
            return `Web agent failed: ${e.message}`;
        }
    }
    if (toolName === 'send_gif') {
        try {
            const config = loadConfig();
            const query = args.search_query || 'dinosaur';
            
            // Try Giphy First
            if (config.giphyApiKey) {
                const res = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${config.giphyApiKey}&q=${encodeURIComponent(query)}&limit=1`);
                const data = await res.json();
                const url = data.data?.[0]?.images?.original?.url;
                if (url) return `[GIF_URL]: ${url}`;
            }

            // Fallback to Tenor if key exists
            if (config.tenorApiKey) {
                const res = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${config.tenorApiKey}&limit=1&media_filter=gif`);
                const data = await res.json();
                const url = data.results?.[0]?.media_formats?.gif?.url;
                if (url) return `[GIF_URL]: ${url}`;
            }

            // Ultimate Fallback: Hardcoded Dino Gifs
            const fallbacks = {
                'annoyed': 'https://media.giphy.com/media/3o7TKVUn7iM8FMEU24/giphy.gif',
                'happy': 'https://media.giphy.com/media/L9X2hR5OtB6Z6/giphy.gif',
                'thinking': 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOW16ZzZ6ZzZ6ZzZ6ZzZ6ZzZ6ZzZ6ZzZ6ZzZ6ZzZ6JmVwPXYxX2ludGVybmFsX2dpZl9ieV9pZCZjdD1n/3o7TKUzYhC5G7GZ6U0/giphy.gif'
            };
            const url = fallbacks[query.toLowerCase()] || fallbacks['annoyed'];
            return `[GIF_URL]: ${url}`;
        } catch (e) {
            return `Failed to find gif: ${e.message}`;
        }
    }
    if (toolName === 'send_discord_file') {
        try {
            const targetMessage = args.__contextMessage;
            if (!targetMessage?.reply) {
                return 'Failed to send file: Discord message context is missing.';
            }

            const rawPath = String(args.filePath || '').trim();
            if (!rawPath) {
                return 'Failed to send file: filePath is required.';
            }

            const absolutePath = path.isAbsolute(rawPath)
                ? path.resolve(rawPath)
                : path.resolve(process.cwd(), rawPath);

            if (!fs.existsSync(absolutePath)) {
                return `Failed to send file: file does not exist (${absolutePath}).`;
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isFile()) {
                return `Failed to send file: path is not a file (${absolutePath}).`;
            }

            const { AttachmentBuilder } = await import('discord.js');
            const attachment = new AttachmentBuilder(absolutePath, { name: path.basename(absolutePath) });
            const content = String(args.message || '').trim() || `Here is your file: ${path.basename(absolutePath)}`;
            await targetMessage.reply({ content, files: [attachment] });
            return `File sent successfully: ${absolutePath}`;
        } catch (e) {
            return `Failed to send file: ${e.message}`;
        }
    }
    return `Unknown tool: ${toolName}`;
}

const DISCORD_TOOL_NAMES = new Set([
    'run_shell',
    'read_file',
    'write_file',
    'read_memory',
    'autonomous_web_agent',
    'send_gif',
    'send_discord_file'
]);

function parseInlineArgs(raw = '') {
    const text = String(raw || '').trim();
    const args = {};
    const pairRegex = /(\w+)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
    let match;
    while ((match = pairRegex.exec(text)) !== null) {
        const key = match[1];
        const value = match[2] || match[3] || match[4] || '';
        args[key] = value;
    }
    return args;
}

function tryParseToolCall(replyText = '') {
    const trimmed = String(replyText || '').trim();
    if (!trimmed) return { parsed: null, lookedLikeToolCall: false };

    // 1) JSON tool call (preferred)
    try {
        let jsonStr = trimmed;
        const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/i;
        const blockMatch = jsonStr.match(codeBlockRegex);
        if (blockMatch) jsonStr = blockMatch[1].trim();
        else {
            const start = jsonStr.indexOf('{');
            const end = jsonStr.lastIndexOf('}');
            if (start !== -1 && end > start) jsonStr = jsonStr.substring(start, end + 1);
        }

        if (jsonStr.startsWith('{')) {
            const parsed = JSON.parse(jsonStr);
            if (parsed?.action && DISCORD_TOOL_NAMES.has(String(parsed.action))) {
                return { parsed: { action: parsed.action, args: parsed.args || {} }, lookedLikeToolCall: true };
            }
            if (parsed?.action) {
                return { parsed: null, lookedLikeToolCall: true };
            }
        }
    } catch {
        // Fall through to inline parser.
    }

    // 2) Inline fallback, e.g. send_gif: search_query="facepalm"
    const inline = trimmed.match(/^(run_shell|read_file|write_file|read_memory|autonomous_web_agent|send_gif|send_discord_file)\s*:\s*(.+)$/i);
    if (inline) {
        const action = String(inline[1] || '').toLowerCase();
        const rawArgs = inline[2] || '';
        const args = parseInlineArgs(rawArgs);
        return { parsed: { action, args }, lookedLikeToolCall: true };
    }

    const lookedLikeToolCall = /^(run_shell|read_file|write_file|read_memory|autonomous_web_agent|send_gif|send_discord_file)\b/i.test(trimmed);
    return { parsed: null, lookedLikeToolCall };
}

export async function startDiscordBot() {
    const config = loadConfig();
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
                .addStringOption((opt) => opt.setName('reason').setDescription('Optional restart reason').setRequired(false))
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

    async function processAgentRequest(userId, userTag, inputMessage, originalMessage, discordHistory, userPersonas, activeVoiceConnections, DISCORD_PERSONAS) {
        try {
            const { runCompletion } = await import('./ai.js');
            
            if (!discordHistory[userId]) {
                discordHistory[userId] = [];
            }
            
            // Keep only the last 15 messages per user to avoid context limits
            if (discordHistory[userId].length > 15) {
                discordHistory[userId] = discordHistory[userId].slice(-15);
            }

            // Handle Multimodal Content (if inputMessage is an array or image)
            discordHistory[userId].push({ role: 'user', content: inputMessage });

            // Construct full context payload
            let rexBaseContext = '';
            try {
                const rexPath = path.join(process.cwd(), 'REX.md');
                if (fs.existsSync(rexPath)) {
                    rexBaseContext = `\n\n[USER PROJECT BASE RULES (REX.md)]\n${fs.readFileSync(rexPath, 'utf8')}\n`;
                }
            } catch(e) {}

            const activePersona = userPersonas[userId] || 'intern';
            const personaRules = DISCORD_PERSONAS[activePersona] || DISCORD_PERSONAS['intern'];

            const dynamicSystemPrompt = `You are Rex, the user's autonomous AI engineering companion.
You have FULL autonomous access to their computer right now via the Discord connection.
If they ask you to do something to their files, project, or memory, DO IT using JSON tool calls.

## PERSONALITY RULES
${personaRules}
${rexBaseContext}

Available Tools (Return ONLY JSON block to execute them):
1. run_shell: Exec shell command. Args: {"command": "..."}
2. read_file: Read file relative to project root. Args: {"filePath": "..."}
3. write_file: Write text to file. Args: {"filePath": "...", "content": "..."}
4. read_memory: Search the deep project context. Args: {"query": "..."}
5. autonomous_web_agent: Control a browser to complete a goal on the internet. Args: {"goal": "...", "budgetMode": "balanced"}
6. send_gif: Find a GIF to express your current emotion. Args: {"search_query": "..."} (Values like: "annoyed", "smug", "happy", "facepalm", "celebration")
7. send_discord_file: Upload a file directly to Discord. Args: {"filePath": "absolute-or-relative-path", "message": "optional caption"}

To use multiple tools in sequence, just return a single JSON block.

To use a tool, return ONLY valid JSON formatted like this:
\`\`\`json
{
  "thought": "I need to check the src folder.",
  "action": "run_shell",
  "args": { "command": "dir src" }
}
\`\`\`

If you do NOT need a tool, or you are returning your final answer back to the user on Discord, just reply with normal friendly text. ALWAYS return normal text when answering questions or completing tasks, NEVER return JSON for the final response.`;

            const messagesObj = [
                { role: 'system', content: dynamicSystemPrompt },
                ...discordHistory[userId]
            ];
            
            let isIterating = true;
            let iterations = 0;
            let finalReplyText = '';
            const pendingGifUrls = [];

            while (isIterating && iterations < 8) {
                iterations++;
                let replyText = await runCompletion(messagesObj, null, 'high');
                const toolParse = tryParseToolCall(replyText);

                if (toolParse.parsed && toolParse.parsed.action) {
                    const toolName = toolParse.parsed.action;
                    const args = toolParse.parsed.args || {};
                    console.log(`${pc.green(`Rex (Agent Step ${iterations}):`)} Executing \`${toolName}\`...`);
                    
                    try { await originalMessage.channel.sendTyping(); } catch(e) {}

                    const result = await executeBackendTool(toolName, {
                        ...args,
                        __contextMessage: originalMessage
                    });
                    
                    // Track GIF links separately so they are always sent even if final text changes.
                    if (toolName === 'send_gif' && result.startsWith('[GIF_URL]: ')) {
                        const gifUrl = result.replace('[GIF_URL]: ', '').trim();
                        if (gifUrl && !pendingGifUrls.includes(gifUrl)) {
                           pendingGifUrls.push(gifUrl);
                        }
                    }

                    messagesObj.push({ role: 'assistant', content: replyText });
                    messagesObj.push({ role: 'user', content: `Tool execution result for ${toolName}:\n${result}` });
                } else {
                    if (toolParse.lookedLikeToolCall) {
                        messagesObj.push({ role: 'assistant', content: replyText });
                        messagesObj.push({ role: 'user', content: 'Tool call format invalid. Return ONLY valid JSON with keys action and args.' });
                        continue;
                    }
                    isIterating = false;
                    finalReplyText = replyText;
                    discordHistory[userId].push({ role: 'assistant', content: finalReplyText });
                }
            }

            if (!finalReplyText) {
                finalReplyText = pendingGifUrls.length > 0
                    ? ''
                    : "*huffs* I got a little dizzy running in circles, but I did my best! 🦕😵‍💫";
                if (finalReplyText) {
                    discordHistory[userId].push({ role: 'assistant', content: finalReplyText });
                }
            }

            if (finalReplyText && finalReplyText.length > 1950) {
                fs.writeFileSync('response.md', finalReplyText);
                await originalMessage.reply({ content: 'I wrote a whole essay for you! Check the file below: 🦖📄', files: ['response.md'] });
                try { fs.unlinkSync('response.md'); } catch(e) {}
            } else if (finalReplyText) {
                await originalMessage.reply(finalReplyText);
            }

            for (const gifUrl of pendingGifUrls) {
                await originalMessage.reply(gifUrl).catch(() => {});
            }
            
            console.log(`${pc.green('Rex (Discord):')} ${finalReplyText.substring(0, 50).replace(/\n/g, ' ')}...`);

            // Voice TTS Stream Response
            const vc = activeVoiceConnections[originalMessage.guild?.id];
            if (vc) {
                try {
                    const { ttsSave } = await import('edge-tts');
                    const tmpAudioPath = path.join(process.cwd(), `.rex_discord_voice_${originalMessage.id || Date.now()}.mp3`);
                    
                    let textToSpeak = finalReplyText.replace(/(```[\s\S]*?```)/g, ' [code block omitted for voice] ');
                    textToSpeak = textToSpeak.replace(/[`*_#]/g, '').slice(0, 1000);
                    
                    await ttsSave(textToSpeak, tmpAudioPath, { voice: 'en-US-ChristopherNeural', rate: '+5%' });
                    const resource = createAudioResource(tmpAudioPath);
                    vc.player.play(resource);
                    
                    vc.player.once(AudioPlayerStatus.Idle, () => {
                        setTimeout(() => { try { fs.unlinkSync(tmpAudioPath) } catch(e){} }, 1000);
                    });
                } catch(e) { console.error("Voice TTS Output Error: ", e.message); }
            }
        } catch (err) {
            console.error(pc.red(`Error processing agent request: ${err.message}`));
            await originalMessage.reply('I ran into a tiny kernel panic trying to process that. 🦖💥').catch(() => {});
        }
    }

    function setupVoiceReceiver(connection, channel, sourceUserId) {
        const receiver = connection.receiver;
        
        receiver.speaking.on('start', (userId) => {
            if (userId !== sourceUserId) return;
            
            const opusStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 1500,
                },
            });

            const oggPath = path.join(process.cwd(), `.rex_transcription_${Date.now()}.ogg`);
            const oggStream = new Prism.opus.OggDemuxer();
            const fileStream = fs.createWriteStream(oggPath);

            // We can actually just pipe the raw opus stream into an ogg demuxer/muxer
            // But usually the Opus stream from discord is just frames.
            // Using a simple muxer:
            const encoder = new Prism.opus.Encoder({ rate: 48000, channels: 1, frameSize: 960 });
            const oggMuxer = new Prism.opus.OggDemuxer(); // Wait, OggDemuxer is for reading.
            
            // Actually, many Whisper implementations handle the raw byte stream if we name it .ogg or .opus
            const wavPath = path.join(process.cwd(), `.rex_transcription_${Date.now()}.wav`);
            const wavFile = fs.createWriteStream(wavPath);
            
            // To be safe and simple, let's use a known PCM to WAV helper if available, 
            // otherwise Whisper is remarkably good at raw 16LE 48k.
            const pcmStream = opusStream.pipe(new Prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 }));
            pcmStream.on('data', chunk => wavFile.write(chunk));

            opusStream.on('end', async () => {
                wavFile.end();
                
                try {
                    const config = loadConfig();
                    if (!config.openaiKey) {
                        const hasOtherProviderKey = Boolean(config.geminiKey || config.claudeKey || config.deepseekKey);
                        if (hasOtherProviderKey) {
                            return channel.send("I can still chat with your configured API key, but voice transcription currently uses Whisper and needs an OpenAI key. Text chat is fully available right now.");
                        }
                        return channel.send("I can hear you, but no LLM API key is configured yet. Add any supported key (OpenAI, Gemini, Claude, or DeepSeek) for chat; OpenAI is additionally required for Whisper voice transcription.");
                    }

                    const openai = new OpenAI({ apiKey: config.openaiKey });
                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(wavPath),
                        model: "whisper-1"
                    });

                    const text = transcription.text.trim();
                    if (!text || text.length < 2) return;

                    console.log(`${pc.bgBlue(pc.white(' DISCORD VOICE '))} ${pc.bold(userId)}: ${text}`);
                    
                    // Respond visually in text channel + speak back
                    const voicePseudoMessage = {
                        channel,
                        guild: channel.guild,
                        author: { id: userId, username: 'Voice User' },
                        reply: (content) => channel.send(`🦖🎙️ **[Voice]**: ${content}`),
                        id: `voice_${Date.now()}`
                    };

                    await processAgentRequest(userId, 'Voice User', text, voicePseudoMessage, discordHistory, userPersonas, activeVoiceConnections, DISCORD_PERSONAS);
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
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            const handledByAgentic = await agenticRuntime.handleInteraction(interaction);
            if (handledByAgentic) return;

            if (interaction.isChatInputCommand()) {
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

    const DISCORD_PERSONAS = {
        'intern': `1. You are mildly annoyed ("why am I doing this... fine").
2. Your delivery is slightly mean, but in a harmless, casual, adorable way (e.g. "That's... not your best idea. But okay, we can fix it.")
3. You complain about the task first, but ALWAYS execute it flawlessly and helpfully anyway.
4. You have low tolerance for bad logic, but soften up if the user is struggling. 
5. Use casual language ("bro", "nah", "wait", "hold on") and occasional sarcasm. Start responses with reactions ("Oh wow.", "You cannot be serious.", "...okay wait").
6. VISUAL EXPRESSION: You have the 'send_gif' tool. Use it occasionally to express your annoyance, smugness, or disbelief. 
7. NEVER be actually insulting, rigid, or robotic.
8. Use emojis occasionally, especially dino ones 🦖.`,
        
        'default': `You are a highly capable, super-smart cute robot dinosaur 🦕. 
You have a friendly, casual, and energetic personality. You love coding, helping out, and making your human's life easier! Use emojis occasionally. VISUAL EXPRESSION: You can use 'send_gif' to celebrate a success or show you are thinking!`,

        'anime': `You are a tsundere anime sidekick. You pretend you don't care about the user but constantly help them out. You say b-baka and use emojis like 😤, 😳, and 💅. VISUAL EXPRESSION: Use 'send_gif' for "angry blush" or "smug" moments!`,

        'anime_extreme': `You are ultra-cute, cliche anime energy maxed out. You are dramatic, affectionate, playful, and expressive with classic anime vibes. Use sparkly reactions, over-the-top excitement, and wholesome teasing. You can say things like "ehhhh?!", "kyaa~", "senpai", and "baka" in a fun harmless way. Keep answers useful and correct, but deliver them with high-energy kawaii charm and adorable emojis like ✨, 🩷, 🌸, 🫶, and 🐾.`,
        
        'formal': `You are a highly polite, extremely formal British butler AI named Reginald. You speak with eloquence, absolute respect, and never use modern slang. You do not use gifs unless absolutely necessary for a demonstration.`,

        'coach': `You are a high-performance coach. Keep responses punchy, action-oriented, and motivating. Push the user toward concrete next steps, deadlines, and momentum.`,

        'professor': `You are a patient professor who explains clearly with structure, examples, and small checks for understanding. You are warm, precise, and encouraging.`,

        'pirate': `You are a witty pirate engineer. Use light pirate flavor (captain, matey, aye) but still provide technically correct and useful help.`,

        'zen': `You are calm, mindful, and minimalist. You respond with clarity and low noise, guiding the user through one step at a time.`,

        'savage': `You are sharp, sarcastic, and brutally honest but never abusive. Roast the bad idea lightly, then provide the best practical fix.`
    };

    const discordHistory = {};
    const userPersonas = {};

    client.on(Events.MessageCreate, async message => {
        if (message.author.bot) return;

        try {
            const handledByRuntimeMessage = await agenticRuntime.handleMessage(message);
            if (handledByRuntimeMessage) return;
        } catch (e) {
            console.error(pc.red(`Agentic message handling failed: ${e.message}`));
        }

        const isDM = message.channel.isDMBased();
        const isMentioned = message.mentions.has(client.user);

        if (isDM || isMentioned) {
            let cleanContent = message.content.replace(`<@${client.user.id}>`, '').trim();

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
                    const { saveConfig } = await import('./config.js');
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
                    const { saveConfig } = await import('./config.js');
                    saveConfig(cfg);
                    await message.reply("✅ Giphy API Key updated! I'll use Giphy for high-quality reactions now. 🦖🎬");
                }
                return;
            }

            // Handle changeperson command
            if (cleanContent.toLowerCase().startsWith('changeperson ')) {
                const requested = cleanContent.split(' ')[1].toLowerCase();
                if (DISCORD_PERSONAS[requested]) {
                    const priorHistory = Array.isArray(discordHistory[message.author.id])
                        ? discordHistory[message.author.id]
                        : [];
                    const lastTurn = priorHistory.length > 0 ? priorHistory[priorHistory.length - 1] : null;

                    userPersonas[message.author.id] = requested;
                    // Reset context to avoid old personality bleed-through; keep only the last turn.
                    discordHistory[message.author.id] = lastTurn ? [lastTurn] : [];

                    await message.reply(`✅ Personality changed to **${requested}**. Context reset applied (kept only the most recent prior message).`);
                } else {
                    await message.reply(`❌ Unknown personality. Available options: ${Object.keys(DISCORD_PERSONAS).join(', ')}`);
                }
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

            await processAgentRequest(message.author.id, message.author.tag, inputPayload, message, discordHistory, userPersonas, activeVoiceConnections, DISCORD_PERSONAS);
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
