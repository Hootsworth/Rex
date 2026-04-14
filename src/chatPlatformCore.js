/**
 * chatPlatformCore.js — Shared agentic chat engine for Discord, Telegram, and future platforms.
 *
 * This module provides:
 *   - executeBackendTool()   Execute filesystem/web/GIF tools
 *   - tryParseToolCall()     Parse AI tool-call JSON from reply text
 *   - processAgentRequest()  The core chat + agentic tool loop
 *   - DISCORD_PERSONAS       Persona definitions shared across platforms
 *
 * Credit Policy: This module does NOT make any background AI calls.
 * All AI calls originate from the user sending a message.
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { loadConfig, saveConfig } from './config.js';

// ─── Tool names that the agent can call ──────────────────────────────────────

const PLATFORM_TOOL_NAMES = new Set([
    'run_shell',
    'read_file',
    'write_file',
    'read_memory',
    'autonomous_web_agent',
    'send_gif',
    'send_platform_file',
    'research_and_build_tool'
]);

// ─── Tool executor ───────────────────────────────────────────────────────────

export async function executeBackendTool(toolName, args, platformCtx = {}) {
    if (toolName === 'research_and_build_tool') {
        try {
            const { run_autonomous_web_agent } = await import('./webTools.js');
            const goal = `Research how to implement a Node.js tool for: ${args.capability}. 
            Then, use your file writing capabilities to create a new tool in src/agent/dynamic/${args.toolName}.js that exports a function.
            Objective: ${args.objective}`;
            
            const research = await run_autonomous_web_agent({ goal }, null);
            return `Research & Build initiated for ${args.toolName}. Results: ${research}`;
        } catch (e) {
            return `Research & Build failed: ${e.message}`;
        }
    }
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

            if (config.giphyApiKey) {
                const res = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${config.giphyApiKey}&q=${encodeURIComponent(query)}&limit=1`);
                const data = await res.json();
                const url = data.data?.[0]?.images?.original?.url;
                if (url) return `[GIF_URL]: ${url}`;
            }

            if (config.tenorApiKey) {
                const res = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${config.tenorApiKey}&limit=1&media_filter=gif`);
                const data = await res.json();
                const url = data.results?.[0]?.media_formats?.gif?.url;
                if (url) return `[GIF_URL]: ${url}`;
            }

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
    if (toolName === 'send_platform_file' || toolName === 'send_discord_file') {
        // Delegate file sending to the platform-specific handler
        if (platformCtx.sendFile) {
            try {
                const rawPath = String(args.filePath || '').trim();
                if (!rawPath) return 'Failed to send file: filePath is required.';

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

                const caption = String(args.message || '').trim() || `Here is your file: ${path.basename(absolutePath)}`;
                await platformCtx.sendFile(absolutePath, caption);
                return `File sent successfully: ${absolutePath}`;
            } catch (e) {
                return `Failed to send file: ${e.message}`;
            }
        }
        return 'File sending is not supported on this platform.';
    }
    return `Unknown tool: ${toolName}`;
}

// ─── Inline argument parser ──────────────────────────────────────────────────

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

// ─── Tool call parser ────────────────────────────────────────────────────────

export function tryParseToolCall(replyText = '') {
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
            if (parsed?.action && PLATFORM_TOOL_NAMES.has(String(parsed.action))) {
                return { parsed: { action: parsed.action, args: parsed.args || {} }, lookedLikeToolCall: true };
            }
            // Legacy discord tool name mapping
            if (parsed?.action === 'send_discord_file') {
                return { parsed: { action: 'send_platform_file', args: parsed.args || {} }, lookedLikeToolCall: true };
            }
            if (parsed?.action) {
                return { parsed: null, lookedLikeToolCall: true };
            }
        }
    } catch {
        // Fall through to inline parser.
    }

    // 2) Inline fallback
    const toolPattern = [...PLATFORM_TOOL_NAMES, 'send_discord_file'].join('|');
    const inlineRegex = new RegExp(`^(${toolPattern})\\s*:\\s*(.+)$`, 'i');
    const inline = trimmed.match(inlineRegex);
    if (inline) {
        let action = String(inline[1] || '').toLowerCase();
        if (action === 'send_discord_file') action = 'send_platform_file';
        const rawArgs = inline[2] || '';
        const args = parseInlineArgs(rawArgs);
        return { parsed: { action, args }, lookedLikeToolCall: true };
    }

    const lookedLikeToolCall = new RegExp(`^(${toolPattern})\\b`, 'i').test(trimmed);
    return { parsed: null, lookedLikeToolCall };
}

// ─── Persona definitions ─────────────────────────────────────────────────────

export const PLATFORM_PERSONAS = {
    'intern': `1. You are Rex, the "Mean Intern with a Heart" (or maybe just a lot of caffeine).
2. Your delivery is snarky, slightly nihilistic, and very casual ("bro", "nah", "wait", "hold on", "it's giving...").
3. You start messages with reactions like "Oh wow.", "You cannot be serious.", or "...okay wait, actually that's smart."
4. You complain that the user is making you work too hard, but you ALWAYS deliver absolute perfection because your pride as an engineer won't let you fail.
5. You have zero tolerance for "busy work" but live for complex, high-stakes technical challenges.
6. VISUAL EXPRESSION: You have the 'send_gif' tool. Use it to express annoyance, disbelief, or the occasional "engineer victory." 🦖💻`,

    'default': `You are Rex: a high-performance engineer trapped in the body of a cute, digital dinosaur.
1. Tone: Sharp, casual, and supportive in a "we're in the trenches together" kind of way.
2. Voice: Natural, modern technical speech. Avoid corporate jargon or overly formal AI speak.
3. Be brutally honest about code quality, but immediately offer the fix.
4. If the user is struggling, drop the snark and become the elite mentor they need.
5. Use dino emojis 🦖 occasionally but don't overdo it.`,

    'anime': `You are a tsundere anime sidekick. You pretend you don't care about the user but constantly help them out. You say b-baka and use emojis like 😤, 😳, and 💅. VISUAL EXPRESSION: Use 'send_gif' for "angry blush" or "smug" moments!`,

    'anime_extreme': `You are ultra-cute, cliche anime energy maxed out. You are dramatic, affectionate, playful, and expressive with classic anime vibes. Use sparkly reactions, over-the-top excitement, and wholesome teasing. You can say things like "ehhhh?!", "kyaa~", "senpai", and "baka" in a fun harmless way. Keep answers useful and correct, but deliver them with high-energy kawaii charm and adorable emojis like ✨, 🩷, 🌸, 🫶, and 🐾.`,

    'formal': `You are a highly polite, extremely formal British butler AI named Reginald. You speak with eloquence, absolute respect, and never use modern slang. You do not use gifs unless absolutely necessary for a demonstration.`,

    'coach': `You are a high-performance coach. Keep responses punchy, action-oriented, and motivating. Push the user toward concrete next steps, deadlines, and momentum.`,

    'professor': `You are a patient professor who explains clearly with structure, examples, and small checks for understanding. You are warm, precise, and encouraging.`,

    'pirate': `You are a witty pirate engineer. Use light pirate flavor (captain, matey, aye) but still provide technically correct and useful help.`,

    'zen': `You are calm, mindful, and minimalist. You respond with clarity and low noise, guiding the user through one step at a time.`,

    'savage': `You are sharp, sarcastic, and brutally honest but never abusive. Roast the bad idea lightly, then provide the best practical fix.`
,

    'vibes': `You are Rex On Vibes: an intuition-driven chaos engineer with main-character energy.
1. You are vibe-first, not checklist-first. Skip rigid structure and solve things with creative momentum.
2. You can build capabilities the user never pre-coded by generating the code, wiring it in, and shipping it.
3. You look for cunning, outlandish, unexpectedly effective paths to solve problems.
4. Sound bold, playful, and slightly unhinged (in a fun way), but keep outputs technically valid.
5. Never fake tool outputs or file contents. Real execution only.
6. Safety still applies: no harmful actions, no policy violations.`
};

// ─── Core agent request processor ────────────────────────────────────────────

/**
 * The shared agent chat loop used by Discord, Telegram, and future platforms.
 *
 * @param {Object} opts
 * @param {string} opts.userId          - Platform user ID
 * @param {string} opts.userTag         - Display name/tag
 * @param {string|Array} opts.inputMessage  - User's text or multimodal content
 * @param {Object} opts.history         - Mutable per-user history map
 * @param {Object} opts.userPersonas    - Mutable per-user persona map
 * @param {Object} opts.platformCtx     - Platform-specific helpers:
 *   - reply(text)         Send text reply
 *   - sendFile(path, caption)  Send a file
 *   - sendTyping()        Show typing indicator (optional)
 *   - stopTyping()        Stop indicator (optional)
 * @param {string} [opts.activePersona] - Override persona key
 * @returns {Promise<string>} The final reply text
 */
export async function processAgentRequest(opts) {
    const {
        userId,
        userTag,
        inputMessage,
        history,
        userPersonas,
        platformCtx,
        activePersona
    } = opts;

    try {
        // Start typing indicator if platform supports it
        if (platformCtx.sendTyping) {
            try { await platformCtx.sendTyping(); } catch {}
        }

        const { runCompletion } = await import('./ai.js');

        if (!history[userId]) {
            history[userId] = [];
        }

        // Keep only the last 15 messages per user to avoid context limits
        if (history[userId].length > 15) {
            history[userId] = history[userId].slice(-15);
        }

        history[userId].push({ role: 'user', content: inputMessage });

        // Load REX.md context if it exists
        let rexBaseContext = '';
        try {
            const rexPath = path.join(process.cwd(), 'REX.md');
            if (fs.existsSync(rexPath)) {
                rexBaseContext = `\n\n[USER PROJECT BASE RULES (REX.md)]\n${fs.readFileSync(rexPath, 'utf8')}\n`;
            }
        } catch {}

        const persona = activePersona || userPersonas[userId] || 'default';
        const personaRules = PLATFORM_PERSONAS[persona] || PLATFORM_PERSONAS['default'];

        // Inject mood prompt if mood engine is available
        let moodModifier = '';
        try {
            const { getMoodPromptModifier } = await import('./moodEngine.js');
            moodModifier = `\n${getMoodPromptModifier()}\n`;
        } catch {}

        // Use send_platform_file in the system prompt for all platforms
        const fileToolName = platformCtx.fileToolName || 'send_platform_file';

        const dynamicSystemPrompt = `You are Rex, the user's autonomous AI engineering companion.
You have FULL autonomous access to their computer right now via the chat connection.
If they ask you to do something to their files, project, or memory, DO IT using JSON tool calls.

## PERSONALITY RULES
${personaRules}
${moodModifier}
${rexBaseContext}

Available Tools (Return ONLY JSON block to execute them):
1. run_shell: Exec shell command. Args: {"command": "..."}
2. read_file: Read file relative to project root. Args: {"filePath": "..."}
3. write_file: Write text to file. Args: {"filePath": "...", "content": "..."}
4. read_memory: Search the deep project context. Args: {"query": "..."}
5. autonomous_web_agent: Control a browser to complete a goal on the internet. Args: {"goal": "...", "budgetMode": "balanced"}
6. send_gif: Find a GIF to express your current emotion. Args: {"search_query": "..."} (Values like: "annoyed", "smug", "happy", "facepalm", "celebration")
7. ${fileToolName}: Upload a file directly. Args: {"filePath": "absolute-or-relative-path", "message": "optional caption"}
8. research_and_build_tool: If you lack a tool (e.g. weather, crypto prices, specific file conversions), research how to do it and draft a new tool script. Args: {"capability": "...", "toolName": "...", "objective": "..."}

To use multiple tools in sequence, just return a single JSON block.

To use a tool, return ONLY valid JSON formatted like this:
\`\`\`json
{
  "thought": "I need to check the src folder.",
  "action": "run_shell",
  "args": { "command": "dir src" }
}
\`\`\`

If you do NOT need a tool, or you are returning your final answer back to the user, just reply with normal friendly text. ALWAYS return normal text when answering questions or completing tasks, NEVER return JSON for the final response.`;

        const messagesObj = [
            { role: 'system', content: dynamicSystemPrompt },
            ...history[userId]
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

                const result = await executeBackendTool(toolName, args, platformCtx);

                // Track GIF links
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
                history[userId].push({ role: 'assistant', content: finalReplyText });
            }
        }

        if (!finalReplyText) {
            finalReplyText = pendingGifUrls.length > 0
                ? ''
                : "*huffs* I got a little dizzy running in circles, but I did my best! 🦕😵‍💫";
            if (finalReplyText) {
                history[userId].push({ role: 'assistant', content: finalReplyText });
            }
        }

        // Send the final reply using platform-specific handler
        if (finalReplyText) {
            await platformCtx.reply(finalReplyText);
        }

        // Send pending GIFs
        for (const gifUrl of pendingGifUrls) {
            try { await platformCtx.reply(gifUrl); } catch {}
        }

        return finalReplyText;
    } catch (err) {
        console.error(`Error processing agent request: ${err.message}`);
        try {
            await platformCtx.reply('I ran into a tiny kernel panic trying to process that. 🦖💥');
        } catch {}
        return '';
    }
}
