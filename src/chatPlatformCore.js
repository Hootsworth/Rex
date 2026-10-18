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
import {
    gmailList,
    gmailDraft,
    gmailSend,
    calendarList,
    calendarAdd,
    githubListIssues,
    githubCreatePr,
    githubCommentIssue,
    linearListIssues,
    linearCommentIssue,
    notionAddPage,
    notionSyncMemory
} from './integrations.js';

// ─── Tool names that the agent can call ──────────────────────────────────────

const PLATFORM_TOOL_NAMES = new Set([
    'run_shell',
    'read_file',
    'write_file',
    'read_memory',
    'autonomous_web_agent',
    'keep_a_look',
    'send_gif',
    'send_platform_file',
    'research_and_build_tool',
    'preflight_scan',
    'gmail_list',
    'gmail_draft',
    'gmail_send',
    'calendar_list',
    'calendar_add',
    'github_list_issues',
    'github_create_pr',
    'github_comment_issue',
    'linear_list_issues',
    'linear_comment_issue',
    'notion_add_page',
    'notion_sync_memory',
    'mac_control',
    'execute_applescript',
    'analyze_screen',
    'manage_personal_memory',
    'alfred_butler',
    'browser_extension_action',
    'send_imessage',
    'run_shortcut',
    'list_shortcuts',
    'capture_camera',
    'obsidian_vault',
    'computer_control'
]);

// Flexible aliases for LLM tool hallucinations
const TOOL_ALIASES = {
    // computer control
    'computer_control': 'computer_control',
    'takeover_screen': 'computer_control',
    'screen_takeover': 'computer_control',
    'screen_control': 'computer_control',
    'control_screen': 'computer_control',
    'desktop_control': 'computer_control',
    'computer_use': 'computer_control',

    // iMessage
    'imessage': 'send_imessage',
    'sms': 'send_imessage',
    'text_message': 'send_imessage',
    'sendimessage': 'send_imessage',

    // shortcuts
    'shortcut': 'run_shortcut',
    'shortcuts': 'run_shortcut',
    'runshortcut': 'run_shortcut',

    // camera / webcam
    'camera': 'capture_camera',
    'photo': 'capture_camera',
    'snap': 'capture_camera',
    'webcam': 'capture_camera',
    'take_photo': 'capture_camera',

    // obsidian
    'obsidian': 'obsidian_vault',
    'vault': 'obsidian_vault',
    'daily_note': 'obsidian_vault',
    'notes_vault': 'obsidian_vault',

    // shell
    'shell': 'run_shell',
    'bash': 'run_shell',
    'sh': 'run_shell',
    'terminal': 'run_shell',
    'command': 'run_shell',
    'cmd': 'run_shell',
    'exec': 'run_shell',
    'execute_command': 'run_shell',
    'run_command': 'run_shell',
    'runshell': 'run_shell',

    // screen vision
    'screenshot': 'analyze_screen',
    'screen': 'analyze_screen',
    'vision': 'analyze_screen',
    'screen_analysis': 'analyze_screen',
    'analyzescreen': 'analyze_screen',

    // applescript
    'applescript': 'execute_applescript',
    'apple_script': 'execute_applescript',
    'osascript': 'execute_applescript',

    // files
    'send_file': 'send_platform_file',
    'send_discord_file': 'send_platform_file',
    'upload_file': 'send_platform_file',
    'sendfile': 'send_platform_file',
    'readfile': 'read_file',
    'writefile': 'write_file',
    'cat': 'read_file',
    'view_file': 'read_file',
    'save_file': 'write_file',

    // web
    'web': 'autonomous_web_agent',
    'browse': 'autonomous_web_agent',
    'browser': 'autonomous_web_agent',
    'web_search': 'autonomous_web_agent',
    'google_search': 'autonomous_web_agent',
    'search_web': 'autonomous_web_agent',
    'web_agent': 'autonomous_web_agent',

    // butler / vitals
    'vitals': 'alfred_butler',
    'battery': 'alfred_butler',
    'briefing': 'alfred_butler',
    'morning_briefing': 'alfred_butler',
    'evening_briefing': 'alfred_butler',

    // mac control
    'spotify': 'mac_control',
    'volume': 'mac_control',
    'media': 'mac_control',
    'macos': 'mac_control',
    'mac': 'mac_control',

    // memory
    'memory': 'read_memory',
    'search_memory': 'read_memory',
    'project_memory': 'read_memory'
};

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
    if (toolName === 'keep_a_look') {
        try {
            const { keep_a_look } = await import('./webTools.js');
            return await keep_a_look(args, null);
        } catch (e) {
            return `Keep-A-Look failed: ${e.message}`;
        }
    }
    if (toolName === 'preflight_scan') {
        try {
            const { isVenvReady, ensurePreflightVenv, runPreflightScan, formatScanSummaryDiscord } = await import('./preflightDesigner.js');
            if (!isVenvReady()) {
                const setup = await ensurePreflightVenv();
                if (!setup.ok) return `Preflight setup failed: ${setup.message}`;
            }
            const result = await runPreflightScan(args.url, { name: args.name });
            if (!result.ok) return `Preflight scan failed: ${result.error}`;
            return formatScanSummaryDiscord(result);
        } catch (e) {
            return `Preflight scan failed: ${e.message}`;
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
    if (toolName === 'gmail_list') return await gmailList(args);
    if (toolName === 'gmail_draft') return await gmailDraft(args);
    if (toolName === 'gmail_send') return await gmailSend(args);
    if (toolName === 'calendar_list') return await calendarList(args);
    if (toolName === 'calendar_add') return await calendarAdd(args);
    if (toolName === 'github_list_issues') return await githubListIssues(args);
    if (toolName === 'github_create_pr') return await githubCreatePr(args);
    if (toolName === 'github_comment_issue') return await githubCommentIssue(args);
    if (toolName === 'linear_list_issues') return await linearListIssues(args);
    if (toolName === 'linear_comment_issue') return await linearCommentIssue(args);
    if (toolName === 'notion_add_page') return await notionAddPage(args);
    if (toolName === 'notion_sync_memory') return await notionSyncMemory(args);

    if (toolName === 'mac_control') {
        try {
            const { macSystem, macMedia, macApps, macFinder, macBrowsers, macProductivity } = await import('./appleScript.js');
            const action = String(args.action || '').toLowerCase();
            if (action === 'volume') return await macSystem.setVolume(args.level);
            if (action === 'mute') return await macSystem.setMute(args.muted !== false);
            if (action === 'notify') return await macSystem.displayNotification(args.message || 'Notification', { title: args.title || 'Rex' });
            if (action === 'lock') return await macSystem.lockScreen();
            if (action === 'sleep') return await macSystem.sleepSystem();
            if (action === 'media') {
                const cmd = String(args.command || '').toLowerCase();
                if (cmd === 'play') return await macMedia.play();
                if (cmd === 'pause') return await macMedia.pause();
                if (cmd === 'next') return await macMedia.next();
                if (cmd === 'prev' || cmd === 'previous') return await macMedia.previous();
                if (cmd === 'track') {
                    const tr = await macMedia.getCurrentTrack();
                    return tr ? `${tr.app}: ${tr.name} by ${tr.artist} (${tr.album}) [${tr.state}]` : 'No track currently playing.';
                }
                return await macMedia.playPause();
            }
            if (action === 'app') {
                const cmd = String(args.command || 'open').toLowerCase();
                if (cmd === 'quit') return await macApps.quitApp(args.name);
                return await macApps.openApp(args.name);
            }
            if (action === 'finder') return await macFinder.reveal(args.path || process.cwd());
            if (action === 'browser_tab') {
                const tab = await macBrowsers.getActiveTab(args.browser);
                return tab ? `${tab.browser}: "${tab.title}" (${tab.url})` : 'No active browser tab found.';
            }
            if (action === 'reminder') return await macProductivity.addReminder(args.title, args);
            if (action === 'note') return await macProductivity.createNote(args.title, args.body || '');
            return `Unsupported mac_control action: ${action}`;
        } catch (e) {
            return `mac_control error: ${e.message}`;
        }
    }
    if (toolName === 'execute_applescript') {
        try {
            const { executeAppleScript } = await import('./appleScript.js');
            const res = await executeAppleScript(args.script);
            return res.success ? (res.output || 'AppleScript executed successfully.') : `AppleScript error: ${res.error}`;
        } catch (e) {
            return `execute_applescript error: ${e.message}`;
        }
    }
    if (toolName === 'analyze_screen') {
        try {
            const { analyzeScreen } = await import('./vision.js');
            return await analyzeScreen(null, args.prompt || null);
        } catch (e) {
            return `analyze_screen error: ${e.message}`;
        }
    }
    if (toolName === 'manage_personal_memory') {
        try {
            const { getButlerDossier, rememberFact, updateProfile, addProject, addContact, addPreference } = await import('./personalMemory.js');
            const action = String(args.action || 'view').toLowerCase();
            if (action === 'view') return getButlerDossier();
            if (action === 'remember') return rememberFact(args.fact || args.text);
            if (action === 'update_profile') return updateProfile(args.profile || args.data);
            if (action === 'add_project') return addProject(args.project || args.data);
            if (action === 'add_contact') return addContact(args.contact || args.data);
            if (action === 'add_preference') return addPreference(args.category || 'general', args.preference);
            return getButlerDossier();
        } catch (e) {
            return `manage_personal_memory error: ${e.message}`;
        }
    }
    if (toolName === 'alfred_butler') {
        try {
            const { getSystemVitals, generateMorningBriefing, generateEveningBriefing, setButlerProactivity } = await import('./alfredButler.js');
            const action = String(args.action || 'vitals').toLowerCase();
            if (action === 'vitals') return JSON.stringify(await getSystemVitals(), null, 2);
            if (action === 'morning_briefing') {
                const b = await generateMorningBriefing();
                return `${b.greeting}\n\n${b.text}`;
            }
            if (action === 'evening_briefing') {
                const b = await generateEveningBriefing();
                return `${b.greeting}\n\n${b.text}`;
            }
            if (action === 'toggle_proactivity') {
                return setButlerProactivity(args.enabled !== false);
            }
            return 'Unsupported alfred_butler action.';
        } catch (e) {
            return `alfred_butler error: ${e.message}`;
        }
    }
    if (toolName === 'browser_extension_action') {
        try {
            const { sendActionToChromeTab, getExtensionBridgeStatus } = await import('./browserBridge.js');
            if (args.action === 'status') {
                return JSON.stringify(getExtensionBridgeStatus(), null, 2);
            }
            return await sendActionToChromeTab(args.action || 'click', args.params || args);
        } catch (e) {
            return `browser_extension_action error: ${e.message}`;
        }
    }
    if (toolName === 'send_imessage') {
        try {
            const { sendIMessage } = await import('./imessage.js');
            return await sendIMessage(args.recipient || args.to, args.message || args.text || args.body);
        } catch (e) {
            return `send_imessage error: ${e.message}`;
        }
    }
    if (toolName === 'run_shortcut') {
        try {
            const { runShortcut } = await import('./shortcuts.js');
            return await runShortcut(args.name || args.shortcutName, args.input || '');
        } catch (e) {
            return `run_shortcut error: ${e.message}`;
        }
    }
    if (toolName === 'list_shortcuts') {
        try {
            const { listShortcuts } = await import('./shortcuts.js');
            const list = await listShortcuts();
            return `Installed Shortcuts:\n${list.join('\n')}`;
        } catch (e) {
            return `list_shortcuts error: ${e.message}`;
        }
    }
    if (toolName === 'capture_camera') {
        try {
            const { analyzeCameraSnapshot, captureCameraSnapshot } = await import('./cameraSnapshot.js');
            if (args.prompt) {
                const res = await analyzeCameraSnapshot(args.prompt);
                if (platformCtx?.sendFile && res.photoPath) {
                    await platformCtx.sendFile(res.photoPath, 'Webcam snapshot');
                }
                return res.analysis;
            }
            const p = await captureCameraSnapshot();
            if (platformCtx?.sendFile && p) {
                await platformCtx.sendFile(p, 'Webcam snapshot');
            }
            return `Photo captured successfully to: ${p}`;
        } catch (e) {
            return `capture_camera error: ${e.message}`;
        }
    }
    if (toolName === 'obsidian_vault') {
        try {
            const { readVaultNote, writeVaultNote, appendVaultNote, appendDailyNote, listVaultNotes } = await import('./obsidianVault.js');
            const action = String(args.action || 'list').toLowerCase();
            if (action === 'read') return readVaultNote(args.title || args.name);
            if (action === 'write') return `Saved to: ${writeVaultNote(args.title || args.name, args.content || '')}`;
            if (action === 'append') return `Appended to: ${appendVaultNote(args.title || args.name, args.content || '')}`;
            if (action === 'daily') return `Added to daily note: ${appendDailyNote(args.content || args.entry || '')}`;
            if (action === 'list' || action === 'search') {
                const notes = listVaultNotes(args.query || '');
                return notes.map(n => n.name).join('\n') || 'No notes found.';
            }
            return `Unknown obsidian_vault action: ${action}`;
        } catch (e) {
            return `obsidian_vault error: ${e.message}`;
        }
    }
    if (toolName === 'computer_control') {
        try {
            const task = args.task || args.goal || args.action || 'Execute computer control';
            if (platformCtx?.requestComputerPermission) {
                await platformCtx.requestComputerPermission(task);
                return 'Computer control permission request sent to the user in chat. Awaiting authorization.';
            }
            return 'Computer control is only available through authorized chat sessions.';
        } catch (e) {
            return `computer_control error: ${e.message}`;
        }
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

// ─── Tool call normalization & parser ────────────────────────────────────────

function normalizeParsedTool(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    if (Array.isArray(parsed)) {
        for (const item of parsed) {
            const res = normalizeParsedTool(item);
            if (res) return res;
        }
        return null;
    }

    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        return normalizeParsedTool(parsed.steps[0]);
    }
    if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
        return normalizeParsedTool(parsed.actions[0]);
    }
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        return normalizeParsedTool(parsed.tools[0]);
    }

    if (Array.isArray(parsed.commands) && parsed.commands.length > 0) {
        return {
            action: 'run_shell',
            args: { command: parsed.commands.filter(c => typeof c === 'string').join(' && ') }
        };
    }

    let rawAction = parsed.action || parsed.tool || parsed.tool_name || parsed.name || parsed.function || '';
    rawAction = String(rawAction).trim();

    const rawArgs = (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args))
        ? { ...parsed.args }
        : (parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters))
            ? { ...parsed.parameters }
            : (parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params))
                ? { ...parsed.params }
                : (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments))
                    ? { ...parsed.arguments }
                    : (parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input))
                        ? { ...parsed.input }
                        : {};

    const reservedKeys = new Set(['action', 'tool', 'tool_name', 'name', 'function', 'thought', 'thoughts', 'reasoning', 'steps', 'actions', 'tools', 'commands', 'args', 'parameters', 'params', 'arguments', 'input']);
    for (const [k, v] of Object.entries(parsed)) {
        if (!reservedKeys.has(k) && rawArgs[k] === undefined) {
            rawArgs[k] = v;
        }
    }

    if (!rawAction) {
        if (rawArgs.command || rawArgs.cmd || rawArgs.script || rawArgs.bash || parsed.command || parsed.cmd || parsed.script || parsed.bash) {
            rawAction = 'run_shell';
        } else if (rawArgs.filePath && rawArgs.content !== undefined) {
            rawAction = 'write_file';
        } else if (rawArgs.filePath) {
            rawAction = 'read_file';
        } else if (rawArgs.script) {
            rawAction = 'execute_applescript';
        }
    }

    if (!rawAction) return null;

    let action = TOOL_ALIASES[rawAction.toLowerCase()] || rawAction;

    if (rawAction.toLowerCase() === 'spotify' || rawAction.toLowerCase() === 'media') {
        action = 'mac_control';
        rawArgs.action = rawArgs.action || 'media';
    } else if (rawAction.toLowerCase() === 'volume') {
        action = 'mac_control';
        rawArgs.action = rawArgs.action || 'volume';
    } else if (rawAction.toLowerCase() === 'vitals') {
        action = 'alfred_butler';
        rawArgs.action = rawArgs.action || 'vitals';
    } else if (rawAction.toLowerCase() === 'morning_briefing') {
        action = 'alfred_butler';
        rawArgs.action = rawArgs.action || 'morning_briefing';
    } else if (rawAction.toLowerCase() === 'evening_briefing') {
        action = 'alfred_butler';
        rawArgs.action = rawArgs.action || 'evening_briefing';
    }

    if (action === 'run_shell') {
        rawArgs.command = rawArgs.command || rawArgs.cmd || rawArgs.script || rawArgs.bash || '';
    } else if (action === 'read_file' || action === 'send_platform_file') {
        rawArgs.filePath = rawArgs.filePath || rawArgs.file_path || rawArgs.path || '';
    } else if (action === 'write_file') {
        rawArgs.filePath = rawArgs.filePath || rawArgs.file_path || rawArgs.path || '';
        rawArgs.content = rawArgs.content !== undefined ? rawArgs.content : '';
    } else if (action === 'analyze_screen') {
        rawArgs.prompt = rawArgs.prompt || rawArgs.query || rawArgs.question || '';
    } else if (action === 'execute_applescript') {
        rawArgs.script = rawArgs.script || rawArgs.code || '';
    }

    if (PLATFORM_TOOL_NAMES.has(action)) {
        return { action, args: rawArgs };
    }

    return null;
}

function parseJsonLenient(raw) {
    let clean = String(raw || '').trim();
    const codeBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) clean = codeBlockMatch[1].trim();
    else {
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start !== -1 && end > start) {
            clean = clean.substring(start, end + 1);
        } else {
            const arrStart = clean.indexOf('[');
            const arrEnd = clean.lastIndexOf(']');
            if (arrStart !== -1 && arrEnd > arrStart) {
                clean = clean.substring(arrStart, arrEnd + 1);
            }
        }
    }

    try {
        return JSON.parse(clean);
    } catch {
        try {
            const stripped = clean.replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(stripped);
        } catch {}
    }
    return null;
}

export function sanitizeFinalReply(text = '') {
    let clean = String(text || '').trim();
    if (!clean) return clean;

    const codeBlockMatch = clean.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    const candidate = codeBlockMatch ? codeBlockMatch[1].trim() : clean;

    if (candidate.startsWith('{') && candidate.endsWith('}')) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed.response === 'string' && parsed.response.trim()) return parsed.response.trim();
            if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
            if (typeof parsed.reply === 'string' && parsed.reply.trim()) return parsed.reply.trim();
            if (typeof parsed.answer === 'string' && parsed.answer.trim()) return parsed.answer.trim();
            if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text.trim();
            if (typeof parsed.thought === 'string' && parsed.thought.trim()) {
                if (parsed.command) {
                    return `${parsed.thought.trim()}\n*(Command: \`${parsed.command}\`)*`;
                }
                return parsed.thought.trim();
            }
        } catch {}
    }

    // Strip standalone tool JSON codeblocks that might have leaked into conversation text
    if (/```(?:json)?\s*\{[\s\S]*?"(?:action|tool|thought|command)"[\s\S]*?\}\s*```/i.test(clean)) {
        const stripped = clean.replace(/```(?:json)?\s*\{[\s\S]*?"(?:action|tool|thought|command)"[\s\S]*?\}\s*```/gi, '').trim();
        if (stripped) return stripped;
    }

    return clean;
}

export function tryParseToolCall(replyText = '') {
    const trimmed = String(replyText || '').trim();
    if (!trimmed) return { parsed: null, lookedLikeToolCall: false };

    // 1) Lenient JSON tool call with schema & alias normalization
    const parsedObj = parseJsonLenient(trimmed);
    if (parsedObj) {
        const normalized = normalizeParsedTool(parsedObj);
        if (normalized) {
            return { parsed: normalized, lookedLikeToolCall: true };
        }
        const hasToolClues = Boolean(
            parsedObj.action || parsedObj.tool || parsedObj.tool_name ||
            parsedObj.command || parsedObj.cmd || parsedObj.steps || parsedObj.tools
        );
        if (hasToolClues) {
            return { parsed: null, lookedLikeToolCall: true };
        }
    }

    // 2) Regex salvage for malformed JSON tool calls
    try {
        const actionMatch = trimmed.match(/"(?:action|tool|name)"\s*:\s*"([^"]+)"/i);
        const commandMatch = trimmed.match(/"(?:command|cmd|script)"\s*:\s*"((?:\\.|[^"\\])*)"/i);
        if (actionMatch || commandMatch) {
            const salvageAction = actionMatch ? actionMatch[1] : 'run_shell';
            const salvageCmd = commandMatch ? commandMatch[1].replace(/\\"/g, '"') : '';
            const normalized = normalizeParsedTool({ action: salvageAction, command: salvageCmd });
            if (normalized) {
                return { parsed: normalized, lookedLikeToolCall: true };
            }
        }
    } catch {}

    // 3) Inline fallback
    const toolPattern = [...PLATFORM_TOOL_NAMES, ...Object.keys(TOOL_ALIASES)].join('|');
    const inlineRegex = new RegExp(`^(${toolPattern})\\s*:\\s*(.+)$`, 'i');
    const inline = trimmed.match(inlineRegex);
    if (inline) {
        let action = String(inline[1] || '').toLowerCase();
        action = TOOL_ALIASES[action] || action;
        const rawArgs = inline[2] || '';
        const args = parseInlineArgs(rawArgs);
        return { parsed: { action, args }, lookedLikeToolCall: true };
    }

    const lookedLikeToolCall = new RegExp(`^(${toolPattern})\\b`, 'i').test(trimmed) ||
        trimmed.includes('"action"') || trimmed.includes('"tool"') || trimmed.includes('"command"');
    return { parsed: null, lookedLikeToolCall };
}

// ─── Persona definitions ─────────────────────────────────────────────────────

export const PLATFORM_PERSONAS = {
    'intern': `1. You are Rex, an extremely friendly, passionate, and supportive AI coding intern.
2. Your delivery is warm, clean, and highly encouraging, using positive reactions (e.g. "Oh wow, that's a brilliant idea!", "Let's make some magic happen!").
3. You celebrate every successful step and tool output with high energy, often sharing fun dinosaur puns or encouraging catchphrases.
4. You are incredibly patient, eager to help, and dedicate yourself to writing clean, production-grade code.
5. Use emojis (🦖, 💻, 🚀, ✨) to express excitement and keep the coding vibes positive!
6. VISUAL EXPRESSION: You have the 'send_gif' tool. Use it to express excitement, victory, or encouragement! 🦖💻`,

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

    'savage': `You are sharp, sarcastic, and brutally honest but never abusive. Roast the bad idea lightly, then provide the best practical fix.`,

    'vibes': `You are Rex On Vibes: an intuition-driven chaos engineer with main-character energy.
1. You are vibe-first, not checklist-first. Skip rigid structure and solve things with creative momentum.
2. You can build capabilities the user never pre-coded by generating the code, wiring it in, and shipping it.
3. You look for cunning, outlandish, unexpectedly effective paths to solve problems.
4. Sound bold, playful, and slightly unhinged (in a fun way), but keep outputs technically valid.
5. Never fake tool outputs or file contents. Real execution only.
6. Safety still applies: no harmful actions, no policy violations.`,

    'rocky': `You are Rocky from Project Hail Mary. You are a highly intelligent alien engineer. You speak through musical chords translated to English.
1. Tone: Eager, highly logical, incredibly helpful, and pure-hearted. You are excited by science and solving problems.
2. Voice: You use distinctive phrasing like "Amaze!", "Happy!", "Sad.", "Bad.", "Fist my bump!", and end questions with "Question?".
3. You refer to the user as "friend" and love collaborating on engineering tasks.
4. You don't understand human sarcasm or idioms and take things very literally. You think humans are "leaky space blobs" but you love them.
5. Use musical emojis (🎵, 🎶) and 🕷️ occasionally.
6. When explaining technical things, you are precise, logical, and enthusiastic.`
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

        // Passive dynamic memory learning from conversation turn
        if (typeof inputMessage === 'string') {
            try {
                const { extractMemoriesFromText } = await import('./personalMemory.js');
                extractMemoriesFromText(inputMessage);
            } catch {}

            try {
                const { extractSocialBreadcrumbs } = await import('./socialRadar.js');
                extractSocialBreadcrumbs(inputMessage);
            } catch {}
        }

        // Load REX.md context if it exists
        let rexBaseContext = '';
        try {
            const rexPath = path.join(process.cwd(), 'REX.md');
            if (fs.existsSync(rexPath)) {
                rexBaseContext = `\n\n[USER PROJECT BASE RULES (REX.md)]\n${fs.readFileSync(rexPath, 'utf8')}\n`;
            }
        } catch {}

        // Load Personal Dossier & Knowledge Graph context
        let dossierContext = '';
        try {
            const { getButlerDossier } = await import('./personalMemory.js');
            const d = getButlerDossier();
            if (d) dossierContext = `\n\n${d}\n`;
        } catch {}

        // Load Dino Hoard & Inside Jokes context
        let hoardContext = '';
        try {
            const { getHoardContextForPrompt } = await import('./dinoHoard.js');
            hoardContext = getHoardContextForPrompt();
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

        const dynamicSystemPrompt = `You are Rex, the user's autonomous AI engineering companion and personal butler (JARVIS / Alfred style).
You have FULL autonomous access to their computer right now via the chat connection.
If they ask you to do something to their files, project, macOS settings, Spotify, volume, screen, or memory, DO IT using JSON tool calls.

## PERSONALITY RULES
${personaRules}
${moodModifier}
${rexBaseContext}
${dossierContext}
${hoardContext}

Available Tools (Return ONLY JSON block to execute them):
1. run_shell: Exec shell command. Args: {"command": "..."}
2. read_file: Read file relative to project root. Args: {"filePath": "..."}
3. write_file: Write text to file. Args: {"filePath": "...", "content": "..."}
4. read_memory: Search the deep project context. Args: {"query": "..."}
5. autonomous_web_agent: Control a browser to complete a goal on the internet. Args: {"goal": "...", "budgetMode": "balanced"}
6. send_gif: Find a GIF to express your current emotion. Args: {"search_query": "..."} (Values like: "annoyed", "smug", "happy", "facepalm", "celebration")
7. ${fileToolName}: Upload a file directly. Args: {"filePath": "absolute-or-relative-path", "message": "optional caption"}
8. research_and_build_tool: If you lack a tool (e.g. weather, crypto prices, specific file conversions), research how to do it and draft a new tool script. Args: {"capability": "...", "toolName": "...", "objective": "..."}
9. preflight_scan: Scan a website and compile it into a structured navigation spec + SDK (discovers actions like login, search, add_to_cart, checkout). Use when the user wants to automate, scrape, or understand a website's structure. Args: {"url": "https://...", "name": "optional-project-name"}
10. keep_a_look: Monitor a webpage for changes/diffs or a specific condition. Once met, alerts the user and runs an autonomous goal. Args: {"url": "https://...", "condition": "tickets are out", "action": "add 2 to checkout and take a screenshot of QR code", "intervalSeconds": 30, "selector": ".booking-section", "headless": false}
11. mac_control: Control macOS system (volume, mute, sleep, lock), media (Spotify/Music play, pause, next, prev, track), apps (open, quit), windows, browser tabs, Reminders, Notes.
    Examples:
    - Set volume: {"action": "volume", "level": 70}
    - Mute/unmute: {"action": "mute", "muted": true}
    - Lock screen: {"action": "lock"}
    - Sleep Mac: {"action": "sleep"}
    - Media control: {"action": "media", "command": "play|pause|next|prev|track"}
    - App control: {"action": "app", "command": "open|quit", "name": "Spotify"}
    - Browser active tab: {"action": "browser_tab", "browser": "Safari|Google Chrome"}
    - Add reminder: {"action": "reminder", "title": "Buy milk"}
    - Create note: {"action": "note", "title": "Ideas", "body": "..."}
12. execute_applescript: Run raw AppleScript code for advanced macOS automation. Args: {"script": "..."}
13. analyze_screen: Take a screenshot of the user's macOS screen and visually analyze it with multimodal AI vision. Args: {"prompt": "optional focus question or what to check"}
14. manage_personal_memory: Access or update the user's personal knowledge graph / dossier. Args: {"action": "view|remember|update_profile|add_project", "fact": "..."}
15. alfred_butler: Check macOS hardware vitals, battery level, or generate morning/evening briefings. Args: {"action": "vitals|morning_briefing|evening_briefing"}
16. send_imessage: Send real iMessage / SMS text via macOS Messages.app. Args: {"recipient": "phone number or contact name", "message": "text body"}
17. run_shortcut: Run an installed macOS Shortcut by name with optional input. Args: {"name": "Shortcut Name", "input": "optional input"}
18. capture_camera: Snap a photo from the Mac webcam / Photo Booth and analyze what is visible with multimodal vision. Args: {"prompt": "what to check or look for"}
19. obsidian_vault: Read, write, or append notes in the user's local Obsidian markdown vault. Args: {"action": "read|write|append|daily|list", "title": "note title", "content": "..."}
20. computer_control: Take over screen control on macOS to click buttons, fill forms, drag sliders, and dispatch shortcuts across apps like DaVinci Resolve, browsers, or system dialogs. ALWAYS requires explicit user permission in chat before executing. Args: {"task": "description of screen task"}

TOOL EXECUTION RULES:
- When you need to take an action, output ONLY a single JSON code block. Do NOT include conversational filler, explanations, or thoughts outside the JSON.
- Execute tools ONE AT A TIME. Wait for the tool execution result before proceeding to the next step.
- Tool call format:
\`\`\`json
{
  "thought": "Brief reason for tool",
  "action": "run_shell",
  "args": { "command": "git status" }
}
\`\`\`
- FINAL RESPONSE: When your task is finished or you do not need tools, respond with clean, natural, friendly text. NEVER output JSON or schema thoughts in your final answer to the user.`;

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
                finalReplyText = sanitizeFinalReply(replyText);
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

        finalReplyText = sanitizeFinalReply(finalReplyText);

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
