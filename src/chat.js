import * as p from '@clack/prompts';
import pc from 'picocolors';
import { exec } from 'child_process';
import { runCompletion, runCompletionWithTarget, getLocalLlama } from './ai.js';
import { loadConfig, resolveModelAlias, saveConfig } from './config.js';
import {
    brandTheme, accentTheme, emoji, chip, statusLine, kvRow,
    terminalGlyphs, sectionRule, renderFrame, supportsMotion, sleep,
    typewriter, fadeInLine, badge, wrapAnsiText
} from './terminalTheme.js';

// Import all actions to map
import { aiCodeReview } from './ai.js';
import { quickGitPush } from './git.js';
import { quickDockerPush } from './docker.js';
import { quickScaffold } from './scaffold.js';
import { aiTerminalCommand } from './terminal.js';
import { aiFileTranslator } from './translator.js';
import { projectScaffold } from './projectScaffold.js';
import { deployTools } from './deployTools.js';
import { regexTools } from './regexTools.js';
import { projectHealth } from './health.js';
import { generateEnvExample } from './env.js';
import { markdownToSlides } from './slides.js';
import { sharePort } from './share.js';
import { handleHooks } from './hooks.js';
import { runPlugins } from './plugins.js';
import { sqlAiGenerator } from './sqlAi.js';
import { docsAiGenerator } from './docsAi.js';
import { autoFixProject } from './fix.js';
import { getSystemInfo, listProcesses, managePower } from './system.js';
import { connectorMenu, sendNotification } from './connectors.js';
import { captureScreen, analyzeScreen } from './vision.js';
import { automationMenu } from './agentCore.js';
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

import { read_file, write_file, patch_file, read_dir } from './fsTools.js';
import { run_shell_command } from './shellTools.js';
import { fetch_url_content, open_browser, browser_interact, list_browser_tabs } from './webTools.js';
import { take_snapshot, compare_snapshots } from './regressionTools.js';
import { run_python } from './pythonTools.js';
import {
    readMemory,
    remember,
    forget,
    syncMemory,
    pullMemory,
    setUserPreference,
    getUserPreference,
    maybeCaptureUserPreferencesFromText,
    getSelectivePreferenceContext,
    describePreferenceStore
} from './memory.js';
import { logAutoPilotEvent, logToolCall } from './auditLog.js';
import { CostTracker, estimateTokens, getCostLedgerSummary, formatCostLedgerSummary, resetCostLedger, rebuildLedgerFromSavedSessions } from './costMeter.js';
import { loadToolPermissions, isToolAllowed } from './toolPermissions.js';
import { saveSession, loadSession, listSessions, searchSessions } from './sessions.js';
import { listWorkflows, loadWorkflow, createSampleWorkflow } from './workflows.js';
import { listProfiles, loadProfile, saveProfile } from './profiles.js';
import { getIndexSummary, indexProject } from './indexer.js';
import { semanticSearch } from './vectorSearch.js';
import { runActionEngine } from './agent/actionEngine.js';
import { bootstrapMcpServers } from './mcpClient.js';
import { buildDeepContext } from './deepContext.js';
import { hindsight, echo_chamber, deja_vu, nerve_map, phantom_run } from './cortexKit.js';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runInkUi } from './inkUi.js';
import os from 'os';

const theme = brandTheme;
const REX_PERSONA = accentTheme('Rex Flight Control');

function formatChatCard(title, body, tone = 'default', eyebrow = '') {
    const toneMap = {
        default: 'brand',
        assistant: 'assistant',
        system: 'cool',
        warning: 'warning',
        error: 'danger',
        action: 'action'
    };

    const lines = Array.isArray(body) ? body : String(body || '').split('\n');
    if (eyebrow) lines.unshift(pc.dim(eyebrow), '');
    return renderFrame(title, lines, { tone: toneMap[tone] || 'brand' });
}

function safePretty(value, maxLen = 1200) {
    try {
        const text = JSON.stringify(value, null, 2);
        if (!text) return '{}';
        return text.length > maxLen ? `${text.slice(0, maxLen)}\n... [truncated]` : text;
    } catch {
        const raw = String(value || '');
        return raw.length > maxLen ? `${raw.slice(0, maxLen)}\n... [truncated]` : raw;
    }
}

function stripAnsi(value = '') {
    return String(value).replace(/\u001B\[[0-9;]*m/g, '');
}

function visibleLength(value = '') {
    return stripAnsi(value).length;
}

function padAnsi(value = '', width = 0) {
    const text = String(value);
    const remaining = width - visibleLength(text);
    return remaining > 0 ? `${text}${' '.repeat(remaining)}` : text;
}

function showSystemMessage(title, body) {
    const cols = process.stdout.columns || 80;
    const bg = '\x1b[48;2;30;25;25m'; // Muted dark red/brown
    const reset = '\x1b[0m';
    
    const lines = Array.isArray(body) ? body : String(body || '').split('\n');
    console.log('');
    const header = `${bg}${padAnsi(`  ${pc.yellow(`${emoji.shield} SYSTEM // ${title}`)}`, cols)}${reset}`;
    console.log(header);
    
    for (const rawLine of lines) {
        const wrappedBody = wrapAnsiText(rawLine, cols - 6);
        for (const line of wrappedBody) {
             console.log(`${bg}${padAnsi(`    ${pc.dim(line)}`, cols)}${reset}`);
        }
    }
    console.log(`${bg}${padAnsi('', cols)}${reset}`);
}

function showUserMessage(body, title = 'You') {
    const cols = process.stdout.columns || 80;
    // Muted dark green background for user
    const bg = '\x1b[48;2;25;40;30m'; 
    const reset = '\x1b[0m';
    
    const lines = String(body || '').split('\n');
    console.log('');
    const header = `${bg}${padAnsi(`  ${pc.green(`${emoji.pin} ${title}`)}`, cols)}${reset}`;
    console.log(header);
    
    for (const rawLine of lines) {
        const wrappedBody = wrapAnsiText(rawLine, cols - 6);
        for (const line of wrappedBody) {
             console.log(`${bg}${padAnsi(`    ${line}`, cols)}${reset}`);
        }
    }
    console.log(`${bg}${padAnsi('', cols)}${reset}`);
}

async function showAssistantMessage(body, title = 'Rex') {
    const config = loadConfig();
    if (config.voiceEnabled) {
        const textToSpeak = String(body || '').replace(/[`*_#]/g, '').slice(0, 500);
        // Fire and forget high-quality TTS
        (async () => {
            try {
                const { ttsSave } = await import('edge-tts');
                const sound = await import('sound-play');
                const path = await import('path');
                const os = await import('os');
                const fs = await import('fs');
                
                const tmpFile = path.join(os.tmpdir(), `rex_tts_${Date.now()}.mp3`);
                // ChristopherNeural has a natural, slightly dry delivery perfect for the persona
                await ttsSave(textToSpeak, tmpFile, { voice: 'en-US-ChristopherNeural', rate: '+5%' });
                
                // Play audio in background
                sound.play(tmpFile).then(() => {
                    fs.unlink(tmpFile, () => {});
                }).catch(() => {});
            } catch (e) {
                // Fallback to local windows if edge-tts fails
                try {
                    const { exec } = await import('child_process');
                    exec(`powershell -c "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${textToSpeak.replace(/'/g, "''")}')"`, { windowsHide: true });
                } catch(err) {}
            }
        })();
    }
    const cols = process.stdout.columns || 80;
    // Muted slate blue background for assistant
    const bg = '\x1b[48;2;20;30;45m'; 
    const reset = '\x1b[0m';
    
    console.log('');
    const rawLines = String(body || '').split('\n');
    
    const header = `${bg}${padAnsi(`  ${pc.cyan(pc.bold(`${emoji.rex} ${title}`))}`, cols)}${reset}`;
    if (supportsMotion()) {
        await fadeInLine(header, 4);
    } else {
        console.log(header);
    }
    
    for (const rawLine of rawLines) {
        let textLine = rawLine;
        if (supportsMotion()) {
            const chunks = textLine.split(/(`[^`]+`)/g).filter(Boolean);
            let rendered = '';
            for (const chunk of chunks) {
                if (chunk.startsWith('`') && chunk.endsWith('`')) {
                    rendered += pc.blue(chunk);
                } else {
                    rendered += chunk;
                }
            }
            textLine = rendered;
        }
        
        const wrappedBody = wrapAnsiText(textLine, cols - 6);
        for (const line of wrappedBody) {
             console.log(`${bg}${padAnsi(`    ${line}`, cols)}${reset}`);
             if (supportsMotion()) await sleep(10);
        }
    }
    console.log(`${bg}${padAnsi('', cols)}${reset}`);
}

function parseCommandPayload(input, command) {
    const raw = String(input || '').trim();
    const normalized = `/${String(command || '').toLowerCase()}`;
    if (!raw.toLowerCase().startsWith(normalized)) return '';
    return raw.slice(normalized.length).trim();
}

function compactHistoryContext(historyContext, keepFirst = 2, keepRecent = 10) {
    if (!Array.isArray(historyContext) || historyContext.length <= keepFirst + keepRecent) {
        return {
            didCompact: false,
            removedCount: 0,
            nextHistory: Array.isArray(historyContext) ? historyContext : []
        };
    }

    const firstTurns = historyContext.slice(0, keepFirst);
    const middle = historyContext.slice(keepFirst, -keepRecent);
    const recent = historyContext.slice(-keepRecent);
    const summary = `[COMPACTED ${middle.length} earlier messages to keep context focused.]`;
    return {
        didCompact: true,
        removedCount: middle.length,
        nextHistory: [...firstTurns, { role: 'system', content: summary }, ...recent]
    };
}

function summarizeToolIntent(toolName, args = {}) {
    const filePath = String(args.filePath || '').trim();
    const shortFile = filePath ? path.basename(filePath) : '';
    const shellCmd = String(args.command || '').trim();
    const browserAction = String(args.action || '').trim();

    if (toolName === 'read_file') return `Read(${shortFile || 'file'})`;
    if (toolName === 'write_file') return `Write(${shortFile || 'file'})`;
    if (toolName === 'patch_file') return `Patch(${shortFile || 'file'})`;
    if (toolName === 'run_shell') return `Exec(${shellCmd ? shellCmd.split(' ')[0] : 'shell'})`;
    if (toolName === 'run_python') return 'Run(python)';
    if (toolName === 'browser_interact') return `Browser(${browserAction || 'action'})`;
    if (toolName === 'review') return 'Review(code)';
    if (toolName === 'semantic_search') return 'Search(codebase)';
    return `Run(${toolName})`;
}

function shouldShowSubtleIntent(toolName) {
    return ['read_file', 'write_file', 'patch_file', 'run_shell', 'browser_interact', 'run_python', 'review', 'semantic_search'].includes(String(toolName || ''));
}

async function showSubtleIntent(toolName, args = {}) {
    if (!shouldShowSubtleIntent(toolName)) return;
    const intent = summarizeToolIntent(toolName, args);
    const line = pc.green(pc.dim(`${emoji.spark} ${intent}`));
    if (supportsMotion()) {
        await fadeInLine(line, 3);
    } else {
        console.log(line);
    }
}

async function showActionMessage(toolName, args, thought, execution = null) {
    const taskBadge = execution?.currentTaskId ? pc.dim(` [${execution.currentTaskId}]`) : '';
    const toolEmoji = toolName.includes('browser') ? emoji.globe
        : toolName.includes('file') ? emoji.file
        : toolName.includes('shell') ? emoji.bolt
        : toolName.includes('search') ? emoji.search
        : toolName.includes('git') ? emoji.link
        : emoji.tool;

    const intent = summarizeToolIntent(toolName, args || {});
    const thoughtSnippet = thought ? `  ${pc.dim('::')} ${pc.dim(String(thought).slice(0, 90))}` : '';
    const line = `${pc.green(pc.dim('·'))} ${toolEmoji} ${pc.green(intent)}${taskBadge}${thoughtSnippet}`;
    if (supportsMotion()) {
        await fadeInLine(line, 3);
    } else {
        console.log(line);
    }
}

const AVAILABLE_TOOLS = [
    { name: 'review', desc: 'Perform an AI code review to find bugs or issues in code files', action: aiCodeReview },
    { name: 'translate', desc: 'Translate a file to another programming language', action: aiFileTranslator },
    { name: 'sql', desc: 'Generate SQL queries from natural language', action: sqlAiGenerator },
    { name: 'docs', desc: 'Generate beautiful HTML documentation or aesthetic docs', action: docsAiGenerator },
    { name: 'regex', desc: 'Generate regular expressions', action: regexTools },
    { name: 'scaffold', desc: 'Quickly scaffold a single file or component', action: quickScaffold },
    { name: 'project_scaffold', desc: 'Scaffold a full project folder structure from scratch', action: projectScaffold },
    { name: 'slides', desc: 'Convert markdown notes into HTML presentation slides', action: markdownToSlides },
    { name: 'github_push', desc: 'Stage, commit, and push code to GitHub', action: quickGitPush },
    { name: 'docker_push', desc: 'Quickly build and push a Docker container', action: quickDockerPush },
    { name: 'deploy', desc: 'Deploy the project (opens deployment interactive tools)', action: deployTools },
    { name: 'terminal', desc: 'Execute complex local terminal commands with healing support', action: aiTerminalCommand },
    { name: 'health', desc: 'Scan the project health (linting, tests, etc.)', action: projectHealth },
    { name: 'env', desc: 'Generate a .env.example file from the actual .env', action: generateEnvExample },
    { name: 'fix', desc: 'Autonomously analyze the repo and fix missing files or setup (like README, Dockerfile, CI)', action: autoFixProject },
    { name: 'read_file', desc: 'Read a file. Args: {"filePath": "path/to/file"}', action: async (args) => { const res = await read_file(args.filePath); return res; } },
    { name: 'write_file', desc: 'Write a file. Args: {"filePath": "path/to/file", "content": "strings"}', action: async (args) => { const res = await write_file(args.filePath, args.content); return res; } },
    { name: 'patch_file', desc: 'Patch a file. Args: {"filePath": "path/to/file", "targetContent": "old", "replacementContent": "new"}', action: async (args) => { const res = await patch_file(args.filePath, args.targetContent, args.replacementContent); return res; } },
    { name: 'read_dir', desc: 'List files in a directory. Args: {"dirPath": "."}', action: async (args) => { const res = await read_dir(args.dirPath); return res; } },
    { name: 'run_shell', desc: 'Run a shell command. Use this for file operations, installing packages, checking versions (e.g., npm show zod version), or opening apps (e.g., notepad file.py). Args: {"command": "git status"}', action: async (args) => { const res = await run_shell_command(args.command); return res; } },
    { name: 'fetch_web', desc: 'Read a website as markdown. Args: {"url": "https://..."}', action: async (args) => { const res = await fetch_url_content(args.url); return res; } },
    { name: 'open_url', desc: 'Open a URL in the user browser (for auth/docs). Args: {"url": "https://..."}', action: async (args) => { const res = await open_browser(args.url); return res; } },
    { name: 'take_snapshot', desc: 'Take a visual snapshot of the current local DOM server or webpage for regression testing. Args: {"name": "baseline_home", "fullPage": true}', action: async (args, signal) => { return await take_snapshot(args, signal); } },
    { name: 'compare_snapshots', desc: 'Compare two visual snapshots using pixelmatch to detect layout drift or breakage. Returns the number of differing pixels and saves a diff image. Args: {"baselineActionName": "baseline_home", "newActionName": "latest_home", "diffName": "diff_home"}', action: async (args, signal) => { return await compare_snapshots(args, signal); } },
    { name: 'browser_interact', desc: 'Interact with a persistent browser. Actions: preflight_execute, preflight_analyse, analyze_page, read/extract_text, search, navigate, click, type, hover, screenshot, evaluate, new_tab, switch_tab, list_tabs, close_browser, handle_popups, auth_state, wait_for_auth, back, refresh, babysit_start, babysit_status, babysit_prompt/user_prompt, babysit_snapshot, babysit_stop, practice_mode. Args: {"action": "...", "mode": "headless", "methodName": "login (required for preflight_execute)", "params": {"email": "..."} (required for preflight_execute)} -> mode="headless" triggers background execution. IMPORTANT: analyze_page is for interactable-element scan only; use read/extract_text for page content extraction.', action: async (args, signal) => { const res = await browser_interact(args, signal); return res; } },
    { name: 'run_python', desc: 'Execute secure Python code for math or data tasks. Args: {"code": "print(1+1)"}', action: async (args) => { const res = await run_python(args.code); return res; } },
    { name: 'delegate_task', desc: 'Spawn a sub-Rex agent to handle a sub-task. Args: {"subtask": "description"}', action: async (args, signal) => { 
        p.note(`Spawning sub-agent for: ${args.subtask}`, 'Rex Orchestrator');
        const messages = [{ role: 'user', content: `You are a sub-agent Rex. Complete this specific task: ${args.subtask}. Return only the result.` }];
        const isLocal = loadConfig().aiModel === 'local-llama' || loadConfig().aiModel === 'ollama';
        const res = await getAgentResponse(messages, isLocal, signal);
        return res;
    } },
    { name: 'delegate_task_background', desc: 'Fork a background sub-agent (using a local/free model) to work on a task simultaneously. It will save its output to Project Memory when done. Fast, non-blocking. Args: {"subtask": "explain this file"}', action: async (args) => {
        process.nextTick(async () => {
            try {
                p.note(pc.dim(`Background swarm starting: ${args.subtask}`), 'Swarm');
                const messages = [{ role: 'user', content: `You are a background sub-agent. Answer only what is asked: ${args.subtask}` }];
                const { getAgentResponse } = await import('./ai.js');
                const { remember } = await import('./memory.js');
                const res = await getAgentResponse(messages, true, null);
                remember(`Background Swarm Task '${args.subtask}' Result:\n${res}`);
                p.note(pc.green(`Background swarm finished: ${args.subtask} (Result saved to Memory)`), 'Swarm');
            } catch (e) {
                p.note(pc.red(`Background swarm failed: ${e.message}`), 'Swarm');
            }
        });
        return `Background swarm agent launched for "${args.subtask}". You can continue working. Results will automatically appear in Project Memory soon. Use read_memory to check later if needed.`;
    } },
    { name: 'remember', desc: 'Save a fact to persistent project memory. Args: {"fact": "This project uses React 18"}', action: async (args) => { return remember(args.fact); } },
    { name: 'forget', desc: 'Remove a fact from project memory by keyword. Args: {"keyword": "React"}', action: async (args) => { return forget(args.keyword); } },
    { name: 'set_preference', desc: 'Save user preference in fast indexed store. Args: {"key": "locale.language", "value": "English"}', action: async (args) => { return setUserPreference(args.key, args.value, { source: 'tool' }); } },
    { name: 'get_preference', desc: 'Read one user preference by key. Args: {"key": "locale.currency"}', action: async (args) => {
        const row = getUserPreference(args.key);
        return row ? JSON.stringify(row, null, 2) : `Preference not found: ${String(args.key || '')}`;
    } },
    { name: 'sync_memory', desc: 'Encrypts and syncs the agent memory to a git remote for team sharing. Args: {"teamSecret": "optional_password"}', action: async (args) => { return syncMemory(args.teamSecret); } },
    { name: 'pull_memory', desc: 'Pulls and decrypts team memory from git remote. Args: {"teamSecret": "optional_password"}', action: async (args) => { return pullMemory(args.teamSecret); } },
    { name: 'autonomous_web_agent', desc: 'Powerful agentic tool that visually controls a browser to perform complex web goals with budget-aware planning. Supports "back" and "refresh" actions for loop recovery. Args: {"goal": "...", "budgetMode": "low|balanced|max-quality|headless", "maxSteps": 24}', action: async (args, signal) => { const { run_autonomous_web_agent } = await import('./webTools.js'); return await run_autonomous_web_agent(args, signal); } },
    { name: 'keep_a_look', desc: 'Monitor a webpage for changes/diffs or a specific condition. Once the change is detected, it alerts the user and runs an autonomous goal to complete checkout or other actions. Args: {"url": "https://...", "condition": "tickets are out", "action": "add 2 to checkout and take a screenshot of QR code", "intervalSeconds": 30, "selector": ".booking-section", "headless": false}', action: async (args, signal) => { const { keep_a_look } = await import('./webTools.js'); return await keep_a_look(args, signal); } },
    { name: 'hindsight', desc: 'Save a structured retrospective after completing a task. Args: {"taskName": "...", "whatWorked": "...", "whatFailed": "...", "lessonsLearned": "..."}', action: async (args) => { return await hindsight(args); } },
    { name: 'echo_chamber', desc: 'Self-verify a claim by asking an AI fact-checker to score it 0-10. Low scores mean rethink. Args: {"claim": "...", "evidence": "..."}', action: async (args) => { return await echo_chamber(args); } },
    { name: 'deja_vu', desc: 'Search past hindsight records for lessons from similar tasks. Args: {"query": "deployment issues"}', action: async (args) => { return await deja_vu(args); } },
    { name: 'nerve_map', desc: 'Generate a dependency graph of the project showing import relationships. Args: {"directory": "."}', action: async (args) => { return await nerve_map(args); } },
    { name: 'phantom_run', desc: 'Dry-run a planned action sequence to predict outcomes without executing. Args: {"steps": [{"tool": "write_file", "args": {"filePath": "..."}}]}', action: async (args) => { return await phantom_run(args); } },
    { name: 'get_system_info', desc: 'Get deep hardware and OS telemetry (CPU, RAM, Battery, etc.)', action: getSystemInfo },
    { name: 'semantic_search', desc: 'Perform a fast TF-IDF fuzzy search over the project files based on keywords. Returns the top matching files. Args: {"query": "authentication layout"}', action: async (args) => { return await semanticSearch(args.query); } },
    { name: 'list_processes', desc: 'List active system processes. Args: {"top": 10}', action: listProcesses },
    { name: 'manage_power', desc: 'Initiate system power actions. Args: {"action": "sleep|restart|shutdown"}', action: async (args) => { return await managePower(args.action); } },
    { name: 'send_notification', desc: 'Send a notification to Slack or Discord. Args: {"platform": "slack|discord", "message": "text"}', action: async (args) => { return await sendNotification(args.platform, args.message); } },
    { name: 'capture_screen', desc: 'Capture a screenshot of the user\'s desktop', action: captureScreen },
    { name: 'analyze_screen', desc: 'Capture and perform AI analysis of the current screen', action: analyzeScreen },
    { name: 'set_volume', desc: 'Set system volume level (0-100). Args: {"level": 50}', action: async (args) => { const { setVolume } = await import('./mediaTools.js'); return await setVolume(args.level); } },
    { name: 'set_brightness', desc: 'Set system brightness level (0-100). Args: {"level": 70}', action: async (args) => { const { setBrightness } = await import('./mediaTools.js'); return await setBrightness(args.level); } },
    { name: 'get_clipboard', desc: 'Read text from system clipboard', action: async () => { const { getClipboard } = await import('./clipboard.js'); return await getClipboard(); } },
    { name: 'set_clipboard', desc: 'Write text to system clipboard. Args: {"text": "..."}', action: async (args) => { const { setClipboard } = await import('./clipboard.js'); return await setClipboard(args.text); } },
    { name: 'send_email', desc: 'Send an email via SMTP. Args: {"to": "...", "subject": "...", "body": "..."}', action: async (args) => { const { sendEmail } = await import('./email.js'); return await sendEmail(args.to, args.subject, args.body); } },
    { name: 'mouse_click', desc: 'Simulate a mouse click at specific coordinates (Windows). Args: {"x": 500, "y": 500}', action: async (args) => { const { mouseClick } = await import('./gui.js'); return await mouseClick(args.x, args.y); } },
    { name: 'type_text', desc: 'Simulate typing text into the active window (Windows). Args: {"text": "..."}', action: async (args) => { const { typeText } = await import('./gui.js'); return await typeText(args.text); } },
    { name: 'os_agent', desc: 'Windows OS automation action with built-in preflight checks. Args: {"type":"open|focus|move|click|type|hotkey|wait|preflight_analyse", ...}. For open use app="notepad.exe". For hotkey use combo="CTRL+S" (or keys:["control","s"]).', action: async (args) => { const { executeOsAgentAction } = await import('./osAgent.js'); return await executeOsAgentAction(args); } },
    { name: 'execute_applescript', desc: 'Execute raw AppleScript on macOS for full system, media, window, and app automation. Args: {"script": "tell application \\"Spotify\\" to playpause"}', action: async (args) => { const { executeAppleScript } = await import('./appleScript.js'); const res = await executeAppleScript(args.script); return res.success ? (res.output || 'AppleScript executed successfully.') : `AppleScript error: ${res.error}`; } },
    { name: 'mac_control', desc: 'macOS Butler System Controls. Actions: volume, mute, notify, media, app, window, finder, browser_tab, reminder, note. Args: {"action": "media", "command": "play|pause|next|prev|track"} or {"action": "volume", "level": 60} or {"action": "notify", "message": "...", "title": "..."} or {"action": "app", "command": "open|quit", "name": "Notes"} or {"action": "reminder", "title": "Buy milk"} or {"action": "note", "title": "...", "body": "..."}', action: async (args) => {
        const { macSystem, macMedia, macApps, macFinder, macBrowsers, macProductivity } = await import('./appleScript.js');
        if (args.action === 'volume') return await macSystem.setVolume(args.level);
        if (args.action === 'mute') return await macSystem.setMute(args.muted);
        if (args.action === 'notify') return await macSystem.displayNotification(args.message, { title: args.title });
        if (args.action === 'lock') return await macSystem.lockScreen();
        if (args.action === 'media') {
            if (args.command === 'play') return await macMedia.play();
            if (args.command === 'pause') return await macMedia.pause();
            if (args.command === 'next') return await macMedia.next();
            if (args.command === 'prev') return await macMedia.previous();
            if (args.command === 'track') {
                const tr = await macMedia.getCurrentTrack();
                return tr ? `${tr.app}: ${tr.name} by ${tr.artist} (${tr.album}) [${tr.state}]` : 'No track currently playing.';
            }
            return await macMedia.playPause();
        }
        if (args.action === 'app') {
            if (args.command === 'quit') return await macApps.quitApp(args.name);
            return await macApps.openApp(args.name);
        }
        if (args.action === 'finder') return await macFinder.reveal(args.path);
        if (args.action === 'browser_tab') {
            const tab = await macBrowsers.getActiveTab(args.browser);
            return tab ? `${tab.browser}: "${tab.title}" (${tab.url})` : 'No active browser tab found.';
        }
        if (args.action === 'reminder') return await macProductivity.addReminder(args.title, args);
        if (args.action === 'note') return await macProductivity.createNote(args.title, args.body);
        return 'Unsupported action.';
    } },
    { name: 'rex_screen_cursor', desc: 'Control Rex persistent macOS screen cursor (second cursor overlay across entire display). Actions: start, stop, follow, autonomous, move, click, speak, highlight. Args: {"action": "start|stop|follow|move|click|speak|highlight", "x": 500, "y": 300, "text": "...", "w": 200, "h": 100, "label": "..."}', action: async (args) => {
        const { startScreenCursor, stopScreenCursor, setCursorMode, moveCursorTo, cursorClick, cursorSpeak, cursorHighlight, hideCursorHighlight } = await import('./screenCursor.js');
        if (args.action === 'start') { await startScreenCursor({ mode: args.mode || 'follow' }); return 'Rex Screen Cursor started.'; }
        if (args.action === 'stop') { stopScreenCursor(); return 'Rex Screen Cursor stopped.'; }
        if (args.action === 'follow') { setCursorMode('follow'); return 'Rex Cursor is now following your mouse.'; }
        if (args.action === 'move') { moveCursorTo(args.x, args.y, args.duration || 300, args.style || 'default'); return `Rex moved to (${args.x}, ${args.y}).`; }
        if (args.action === 'click') { cursorClick(args.x, args.y, args.style || 'handpointing'); return `Rex clicked at (${args.x}, ${args.y}).`; }
        if (args.action === 'speak') { cursorSpeak(args.text, args.duration || 3500); return `Rex spoke on screen: "${args.text}".`; }
        if (args.action === 'highlight') { cursorHighlight(args.x, args.y, args.w, args.h, args.label || 'Rex Spotlight'); return 'Screen area highlighted.'; }
        if (args.action === 'hide_highlight') { hideCursorHighlight(); return 'Highlight hidden.'; }
        return 'Unknown action.';
    } },
    { name: 'preflight_scan', desc: 'Scan a website using Preflight Designer and compile it into a structured navigation spec (preflight.yaml) + SDK. Use when you need to automate a new website. Args: {"url": "https://...", "name": "optional-name"}', action: async (args) => {
        const { ensurePreflightVenv, runPreflightScan, formatScanSummary } = await import('./preflightDesigner.js');
        const setup = await ensurePreflightVenv();
        if (!setup.ok) return `Preflight setup failed: ${setup.message}`;
        const result = await runPreflightScan(args.url, { name: args.name });
        return formatScanSummary(result);
    } },
    { name: 'gmail_list', desc: 'List or search recent emails. Args: {"query": "is:unread", "maxResults": 5}', action: gmailList },
    { name: 'gmail_draft', desc: 'Create a draft email in Gmail. Args: {"to": "...", "subject": "...", "body": "..."}', action: gmailDraft },
    { name: 'gmail_send', desc: 'Send an email via Gmail. Args: {"to": "...", "subject": "...", "body": "..."}', action: gmailSend },
    { name: 'calendar_list', desc: 'List upcoming Google Calendar events. Args: {"maxResults": 5}', action: calendarList },
    { name: 'calendar_add', desc: 'Add a Google Calendar event. Args: {"summary": "...", "description": "...", "startTime": "ISO timestamp", "endTime": "ISO timestamp"}', action: calendarAdd },
    { name: 'github_list_issues', desc: 'List GitHub repository issues. Args: {"state": "open|closed", "maxResults": 5}', action: githubListIssues },
    { name: 'github_create_pr', desc: 'Create a new GitHub pull request. Args: {"title": "...", "head": "branch", "base": "main", "body": "..."}', action: githubCreatePr },
    { name: 'github_comment_issue', desc: 'Add a comment to a GitHub issue. Args: {"issueNumber": 123, "body": "..."}', action: githubCommentIssue },
    { name: 'linear_list_issues', desc: 'List active issues on Linear. Args: {"maxResults": 5}', action: linearListIssues },
    { name: 'linear_comment_issue', desc: 'Add a comment to a Linear issue. Args: {"issueId": "...", "body": "..."}', action: linearCommentIssue },
    { name: 'notion_add_page', desc: 'Create a new Notion page in the configured database/page. Args: {"title": "...", "content": "..."}', action: notionAddPage },
    { name: 'notion_sync_memory', desc: 'Sync local project memory and hindsights to the configured Notion workspace.', action: notionSyncMemory },
    { name: 'manage_personal_memory', desc: 'Access or update user personal knowledge graph/dossier. Args: {"action": "view|remember|update_profile|add_project", "fact": "..."}', action: async (args) => {
        const { getButlerDossier, rememberFact, updateProfile, addProject } = await import('./personalMemory.js');
        if (args.action === 'remember') return rememberFact(args.fact || args.text);
        if (args.action === 'update_profile') return updateProfile(args.profile || args.data);
        if (args.action === 'add_project') return addProject(args.project || args.data);
        return getButlerDossier();
    } },
    { name: 'alfred_butler', desc: 'Alfred Butler system vitals, battery, and morning/evening briefings. Args: {"action": "vitals|morning_briefing|evening_briefing"}', action: async (args) => {
        const { getSystemVitals, generateMorningBriefing, generateEveningBriefing } = await import('./alfredButler.js');
        if (args.action === 'morning_briefing') {
            const b = await generateMorningBriefing();
            return `${b.greeting}\n\n${b.text}`;
        }
        if (args.action === 'evening_briefing') {
            const b = await generateEveningBriefing();
            return `${b.greeting}\n\n${b.text}`;
        }
        return JSON.stringify(await getSystemVitals(), null, 2);
    } },
    { name: 'browser_extension_action', desc: 'Interact directly with user\'s active Google Chrome tab via Web Agent Architect extension (Set-of-Marks, CDP hardware clicks, typing, scrolling). Args: {"action": "click|type|scroll|navigate|status", "target": "mark index or selector", "text": "..."}', action: async (args) => {
        const { sendActionToChromeTab, getExtensionBridgeStatus } = await import('./browserBridge.js');
        if (args.action === 'status') return JSON.stringify(getExtensionBridgeStatus(), null, 2);
        return await sendActionToChromeTab(args.action || 'click', args.params || args);
    } }
];

const FUNNY_SPINNERS = [
    "Drinking coffee...",
    "Side-eyeing you because you gave me work...",
    "Polishing my circuits...",
    "Arguing with semicolons...",
    "Bribing bugs to leave quietly...",
    "Negotiating with your codebase...",
    "Reading stack traces like tea leaves...",
    "Refactoring reality one line at a time...",
    "Doing AI yoga between tokens...",
    "Pretending this is not my 47th edge case today...",
    "Translating human chaos into machine calm...",
    "Low-key judging that variable name...",
    "Whispering to the linter...",
    "Computing with dramatic flair...",
    "Charging sarcasm capacitor...",
    "Opening 17 tabs mentally...",
    "Putting out tiny code fires...",
    "Converting panic into progress...",
    "Speedrunning the debugging stage...",
    "Asking rubber duck for legal advice...",
    "Checking if this is feature or bug cosplay...",
    "Wearing sunglasses for this hotfix...",
    "Compiling confidence...",
    "Untangling spaghetti into lasagna sheets...",
    "Bargaining with a stubborn API...",
    "Catching exceptions like Pokemon...",
    "Reheating leftover TODOs...",
    "Recalculating vibes...",
    "Tuning the Rex engines...",
    "Plotting a clean comeback..."
];

function normalizeTaskStatus(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'done' || s === 'completed' || s === 'complete') return 'done';
    if (s === 'doing' || s === 'in-progress' || s === 'active') return 'in-progress';
    if (s === 'blocked' || s === 'error') return 'blocked';
    return 'pending';
}

function isLikelyContentRequest(text = '') {
    const t = String(text || '').toLowerCase();
    return /(ingredient|ingredients|list|required|requirement|what goes into|steps|instructions|price|cost|summary|extract|read|find all)/i.test(t);
}

function looksLikeCompletion(text = '') {
    const t = String(text || '').toLowerCase();
    return /(all tasks (are )?done|task complete|completed successfully|goal achieved|finished|done\.?$)/i.test(t);
}

function isInteractiveWebTask(text = '') {
    const t = String(text || '').toLowerCase();
    return /(open|browse|search|find|buy|book|shop|amazon|flipkart|website|site|cart|checkout|login|sign in)/i.test(t);
}

function hasConcreteAnswerShape(text = '') {
    const t = String(text || '');
    const bulletCount = (t.match(/(^|\n)\s*[-*]\s+/g) || []).length;
    const numberedCount = (t.match(/(^|\n)\s*\d+\.\s+/g) || []).length;
    const longLines = t.split('\n').filter((l) => l.trim().length >= 18).length;
    return bulletCount >= 3 || numberedCount >= 3 || longLines >= 6;
}

function normalizeTasks(tasks = []) {
    return tasks
        .filter(Boolean)
        .map((t, idx) => {
            if (typeof t === 'string') {
                return { id: `T${idx + 1}`, title: t, status: 'pending' };
            }
            return {
                id: String(t.id || `T${idx + 1}`),
                title: String(t.title || t.name || `Task ${idx + 1}`),
                status: normalizeTaskStatus(t.status)
            };
        });
}

function createPlannerState() {
    return {
        main: { objective: '', tasks: [] },
        activeTaskId: '',
        activeSubplan: null,
        issueCounter: 0
    };
}

function updatePlannerStateFromPayload(plannerState, payload) {
    if (!payload || typeof payload !== 'object') return;

    if (payload.plan && typeof payload.plan === 'object') {
        const objective = String(payload.plan.objective || payload.plan.goal || '').trim();
        if (objective) plannerState.main.objective = objective;
        if (Array.isArray(payload.plan.tasks)) {
            plannerState.main.tasks = normalizeTasks(payload.plan.tasks);
        }
    }

    if (payload.execution && typeof payload.execution === 'object') {
        if (payload.execution.currentTaskId) {
            plannerState.activeTaskId = String(payload.execution.currentTaskId);
        }
    }

    if (payload.subplan && typeof payload.subplan === 'object') {
        const steps = normalizeTasks(payload.subplan.steps || payload.subplan.tasks || []);
        plannerState.activeSubplan = {
            id: String(payload.subplan.id || `SP-${Date.now()}`),
            trigger: String(payload.subplan.trigger || 'issue'),
            parentTaskId: String(payload.subplan.parentTaskId || plannerState.activeTaskId || ''),
            tasks: steps
        };
    }
}

function plannerSnapshot(plannerState) {
    const mainTasks = plannerState.main.tasks
        .slice(0, 10)
        .map(t => `- [${t.status}] ${t.id}: ${t.title}`)
        .join('\n') || '- (no tasks yet)';
    const subplanText = plannerState.activeSubplan
        ? [
            `Subplan ${plannerState.activeSubplan.id} (trigger: ${plannerState.activeSubplan.trigger}, parent: ${plannerState.activeSubplan.parentTaskId || 'n/a'})`,
            ...plannerState.activeSubplan.tasks.slice(0, 8).map(t => `- [${t.status}] ${t.id}: ${t.title}`)
        ].join('\n')
        : 'none';

    return [
        `Main objective: ${plannerState.main.objective || '(unset)'}`,
        `Active task id: ${plannerState.activeTaskId || '(unset)'}`,
        'Main tasks:',
        mainTasks,
        `Active subplan:\n${subplanText}`
    ].join('\n');
}

function parseMaybeJsonArgs(rawArgs) {
    if (!rawArgs) return {};
    if (typeof rawArgs === 'object') return rawArgs;
    if (typeof rawArgs !== 'string') return {};
    try {
        const parsed = JSON.parse(rawArgs);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

function extractActionFromFreeform(text = '') {
    const raw = String(text || '');
    const actionIdx = raw.search(/\baction\s*:/i);
    if (actionIdx === -1) return null;

    const tail = raw.slice(actionIdx);
    const firstBrace = tail.indexOf('{');
    const lastBrace = tail.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

    const actionJson = tail.slice(firstBrace, lastBrace + 1);

    try {
        const parsed = JSON.parse(actionJson);
        if (!parsed || typeof parsed !== 'object') return null;

        const thoughtMatch = raw.match(/\bthought\s*:\s*([\s\S]*?)\n\s*action\s*:/i);
        const thought = thoughtMatch ? String(thoughtMatch[1] || '').trim() : '';

        return {
            name: String(parsed.name || parsed.tool || '').trim(),
            args: (parsed.args && typeof parsed.args === 'object') ? parsed.args : {},
            thought
        };
    } catch {
        return null;
    }
}

function normalizeToolSelection(toolName, toolArgs = {}) {
    const t = String(toolName || '').trim();
    if (!t) return { toolName, toolArgs, note: '' };

    const lowered = t.toLowerCase();
    const queryHint = toolArgs?.query || toolArgs?.q || toolArgs?.term || toolArgs?.text || '';

    if (['search', 'web_search', 'duckduckgo_search', 'google_search'].includes(lowered)) {
        return {
            toolName: 'browser_interact',
            toolArgs: { action: 'search', query: String(queryHint || '').trim() },
            note: `Normalized tool alias \`${t}\` to \`browser_interact\` with \`action: "search"\`.`
        };
    }

    if (['open_browser', 'open_web'].includes(lowered)) {
        return {
            toolName: 'browser_interact',
            toolArgs: { action: 'navigate', url: toolArgs?.url || toolArgs?.link || '' },
            note: `Normalized tool alias \`${t}\` to \`browser_interact\` with \`action: "navigate"\`.`
        };
    }

    if (['shell', 'terminal_command', 'command'].includes(lowered)) {
        return {
            toolName: 'run_shell',
            toolArgs: { command: toolArgs?.command || toolArgs?.cmd || toolArgs?.text || '' },
            note: `Normalized tool alias \`${t}\` to \`run_shell\`.`
        };
    }

    if (['python', 'python_exec'].includes(lowered)) {
        return {
            toolName: 'run_python',
            toolArgs: { code: toolArgs?.code || toolArgs?.script || '' },
            note: `Normalized tool alias \`${t}\` to \`run_python\`.`
        };
    }

    if (lowered === 'browser_interact') {
        const action = String(toolArgs?.action || '').toLowerCase();
        const query = String(toolArgs?.query || toolArgs?.search_query || toolArgs?.searchQuery || toolArgs?.q || '').trim();
        if (action === 'navigate' && query) {
            return {
                toolName: 'browser_interact',
                toolArgs: { action: 'search', query },
                note: 'Normalized malformed browser_interact navigate+search_query payload to browser_interact search.'
            };
        }
    }

    if (['babysit_start', 'babysit_stop', 'babysit_status', 'babysit_snapshot', 'babysit_prompt', 'practice_mode'].includes(lowered)) {
        return {
            toolName: 'browser_interact',
            toolArgs: { action: lowered, ...(toolArgs && typeof toolArgs === 'object' ? toolArgs : {}) },
            note: `Normalized tool alias \`${t}\` to \`browser_interact\` with \`action: "${lowered}"\`.`
        };
    }

    return { toolName, toolArgs, note: '' };
}

export async function startAgentChat(options = {}) {
    let planModeEnabled = !!options.plan;
    let vibesModeEnabled = !!options.vibes;
    let planMaxSteps = Number.isFinite(Number(options.planMaxSteps)) && Number(options.planMaxSteps) > 0
        ? Number(options.planMaxSteps)
        : 12;

    console.clear();

    const startupConfig = loadConfig();
    console.log('');
    console.log(renderFrame('Rex: Your AI Companion', [
        `${emoji.rex}  ${pc.green('Hello! I am ready to pair program with you.')}`,
        pc.dim('I can read files, write code, run commands, and browse the web.'),
        '',
        `${chip(emoji.bolt, 'systems online', 'success')}    ${chip(emoji.brain, startupConfig.aiModel || 'model auto', 'success')}    ${chip(emoji.clock, `v${startupConfig.version || '8.0.0'}`, 'success')}`
    ], { tone: 'brand', icon: emoji.wave }));
    console.log('');
    console.log(sectionRule(pc.green('SESSION ONLINE'), 'thick'));
    console.log('');

    // Session flags — only show if non-default
    if (options.debug || options.readonly || planModeEnabled || options.model || vibesModeEnabled) {
        console.log('  ' + [
            options.debug ? chip(emoji.eye, 'debug', 'info') : '',
            options.readonly ? chip(emoji.shield, 'readonly', 'danger') : '',
            planModeEnabled ? chip(emoji.brain, `plan:${planMaxSteps}`, 'success') : '',
            vibesModeEnabled ? chip(emoji.wave, 'vibes', 'warning') : '',
            options.model ? chip(emoji.rocket, options.model, 'success') : ''
        ].filter(Boolean).join('    '));
        console.log('');
    }

    const config = loadConfig();
    // Per-project config: merge .agent/config.json if it exists
    try {
        const agentConfigPath = path.join(process.cwd(), '.agent', 'config.json');
        if (fs.existsSync(agentConfigPath)) {
            const projectConfig = JSON.parse(fs.readFileSync(agentConfigPath, 'utf-8'));
            Object.assign(config, projectConfig);
        }
    } catch(e) { /* no project config */ }

    // Per-session model override via --model flag
    if (options.model) {
        config.aiModel = resolveModelAlias(options.model);
    }

    // Internal tool/action traces are hidden by default for cleaner chat UX.
    // Use --show-actions (or config.showInternalToolLogs=true) to enable them.
    let showInternalToolLogs = Boolean(config.showInternalToolLogs);
    if (options.showActions) showInternalToolLogs = true;
    if (options.quiet) showInternalToolLogs = false;
    if (options.debug) showInternalToolLogs = true;

    const hasAnyCloudProviderKey = Boolean(config.openaiKey || config.geminiKey || config.claudeKey || config.deepseekKey);
    if (config.multiModelAgentEnabled && !hasAnyCloudProviderKey) {
        p.note(pc.yellow('Dual-model mode needs at least one cloud provider key (OpenAI, Gemini, Claude, or DeepSeek). Falling back to single-model mode for this session.'), 'System');
    }

    // Phase 3: Bootstrap MCP Servers and inject them into AVAILABLE_TOOLS
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        p.note(pc.dim('Bootstrapping Model Context Protocol servers...'), 'System');
        const mcpTools = await bootstrapMcpServers(config);
        if (mcpTools.length > 0) {
            AVAILABLE_TOOLS.push(...mcpTools);
            p.note(pc.green(`Successfully attached ${mcpTools.length} MCP tools to Rex.`), 'MCP');
        }
    }

    let historyContext = [];
    const MAX_HISTORY = 30; // Increased from 6
    let isAgentIterating = false;
    const sessionMeta = { topLevelRequest: '' };
    let autoPilotCount = 0;
    let userInput = '';
    const plannerState = createPlannerState();

    // Sprint 2 features
    const costTracker = new CostTracker(config.sessionBudgetLimit);
    const toolPermissions = loadToolPermissions();
    let lastToolKey = '';    // for stuck detection
    let stuckCount = 0;      // consecutive same-tool calls
    const actionEngineState = { osAccessGranted: false };
    const recentToolResults = []; // DeepContext: track last N tool outcomes
    const todoItems = [];
    const pinnedNotes = [];
    const undoStack = [];
    let lastExecution = null;
    const interruptQueue = [];

    // Session-based auto-pilot
    if (options.auto) {
        config.agentPermission = 'auto-pilot';
    }

    // --plan prefers autonomous step-by-step flow with explicit planning.
    if (planModeEnabled) {
        config.agentPermission = 'auto-pilot';
    }

    // Sprint 3: Auto-index project on first run
    let projectIndex = getIndexSummary();
    if (!projectIndex) {
        try { indexProject(); projectIndex = getIndexSummary(); } catch(e) {}
    }

    // Sprint 3: --attach flag injects file contents
    let attachContext = '';
    if (options.attach) {
        const glob = options.attach;
        try {
            const cwd = process.cwd();
            const allFiles = fs.readdirSync(cwd, { recursive: true })
                .filter(f => typeof f === 'string' && f.match(new RegExp(glob.replace(/\*/g, '.*'))))
                .slice(0, 10);
            for (const f of allFiles) {
                const fullPath = path.join(cwd, f);
                if (fs.statSync(fullPath).isFile() && fs.statSync(fullPath).size < 5000) {
                    attachContext += `\n[Attached ${f}:\n${fs.readFileSync(fullPath, 'utf-8')}\n]`;
                }
            }
            if (attachContext) p.note(pc.dim(`📎 Attached ${allFiles.length} file(s) to context`), 'System');
        } catch(e) { /* glob didn't match */ }
    }

    // Sprint 3: Handle piped stdin
    if (options.pipedInput) {
        userInput = options.pipedInput;
        showUserMessage(userInput);
        sessionMeta.topLevelRequest = userInput;
        historyContext.push({ role: 'user', content: userInput });
        if (planModeEnabled) {
            historyContext.push({
                role: 'user',
                content: 'Plan mode kickoff: build a concise implementation plan with a task list, then start executing task 1. Use subplans for any errors and return to main plan after resolving.'
            });
        }
        isAgentIterating = true; // Skip the first prompt, go straight to AI
    }

    // Readonly mode: block write tools
    const WRITE_TOOLS = ['write_file', 'patch_file', 'run_shell', 'run_python', 'os_agent', 'mouse_click', 'type_text', 'execute_applescript', 'mac_control', 'manage_personal_memory', 'gmail_draft', 'gmail_send', 'calendar_add', 'github_create_pr', 'github_comment_issue', 'linear_comment_issue', 'notion_add_page', 'notion_sync_memory'];
    const OS_GATED_TOOLS = ['os_agent', 'mouse_click', 'type_text', 'execute_applescript', 'mac_control'];

    // Abort controller for interrupting AI/Tools
    let abortController = new AbortController();
    let nonActionFollowupCount = 0;
    const btwQueue = [];
    let btwBuffer = '';

    const handleLiveBtwInput = (chunk) => {
        if (!isAgentIterating) return;
        btwBuffer += String(chunk || '');
        const lines = btwBuffer.split(/\r?\n/);
        btwBuffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = String(rawLine || '').trim();
            if (line.toLowerCase().startsWith('/btw ')) {
                const question = line.slice(5).trim();
                if (question) {
                    btwQueue.push(question);
                    p.note(pc.dim(`Queued /btw: ${question.slice(0, 70)}`), 'BTW');
                }
                continue;
            }

            if (line.toLowerCase().startsWith('/interrupt-with ')) {
                const prompt = line.slice('/interrupt-with '.length).trim();
                if (prompt) {
                    interruptQueue.push(prompt);
                }
            }
        }
    };

    const onStartSession = async (userInput, uiCallbacks) => {
        let isAgentIterating = true;
        let autoPilotCount = 0;

        userInput = await processContextRefs(userInput);

        if (userInput.startsWith('/')) {
            const slashHandled = await handleSlashCommand(userInput.trim(), historyContext, config, sessionMeta, {
                getPlanMode: () => planModeEnabled,
                setPlanMode: (next) => {
                    planModeEnabled = !!next;
                    options.plan = planModeEnabled;
                    if (planModeEnabled) {
                        config.agentPermission = 'auto-pilot';
                    }
                },
                getPlanMaxSteps: () => planMaxSteps,
                setPlanMaxSteps: (next) => {
                    const parsed = Number.parseInt(String(next), 10);
                    if (Number.isFinite(parsed) && parsed > 0) {
                        planMaxSteps = parsed;
                    }
                },
                resetAutoPilotCount: () => { autoPilotCount = 0; },
                costTracker
            }, {
                todoItems,
                pinnedNotes,
                undoStack,
                interruptQueue,
                getLastExecution: () => lastExecution,
                getIsIterating: () => isAgentIterating,
                setIsIterating: (next) => { isAgentIterating = !!next; },
                setAutoPilotCount: (next) => { autoPilotCount = Number(next) || 0; },
                getVibesMode: () => vibesModeEnabled,
                setVibesMode: (next) => { vibesModeEnabled = !!next; },
                compactHistory: () => {
                    const compacted = compactHistoryContext(historyContext, 2, 10);
                    if (compacted.didCompact) {
                        historyContext = compacted.nextHistory;
                    }
                    return compacted;
                },
                getHistoryCount: () => historyContext.length,
                getSessionGoal: () => sessionMeta.topLevelRequest || ''
            });

            if (slashHandled) {
                uiCallbacks.onAssistantMessage(`Command executed.`);
                return;
            }
        }

        if (!sessionMeta.topLevelRequest) sessionMeta.topLevelRequest = userInput;
        historyContext.push({ role: 'user', content: userInput });

        // Passive dynamic memory learning from conversation turn
        try {
            const { extractMemoriesFromText } = await import('./personalMemory.js');
            extractMemoriesFromText(userInput);
        } catch {}

        const isLocal = config.aiModel === 'local-llama' || config.aiModel === 'ollama';

        while (isAgentIterating) {
            uiCallbacks.onStepStart('Thinking...');

            const cwd = process.cwd();
            let projectContext = '';
            try {
                const files = fs.readdirSync(cwd).filter(f => !f.startsWith('.') && f !== 'node_modules').slice(0, 30).join(', ');
                projectContext += `\n[Project Directory context: ${files}]`;
                if (fs.existsSync(path.join(cwd, 'package.json'))) {
                    const pkgStr = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8').slice(0, 800);
                    projectContext += `\n[Package.json snippet: ${pkgStr}]`;
                }
            } catch(e) {}

            let memoryContext = '';
            const mem = readMemory();
            if (mem) memoryContext = `\n[PROJECT MEMORY (facts Rex remembers):\n${mem.slice(0, 1500)}]`;

            try {
                const { getButlerDossier } = await import('./personalMemory.js');
                const dossier = getButlerDossier();
                if (dossier) memoryContext += `\n${dossier}`;
            } catch {}

            const selectivePreferenceContext = getSelectivePreferenceContext(userInput || sessionMeta.topLevelRequest || '', 6);
            if (selectivePreferenceContext) {
                memoryContext += `\n[USER PREFERENCES (selective, only relevant keys):\n${selectivePreferenceContext}]`;
            }
            if (pinnedNotes.length > 0) {
                memoryContext += `\n[PINNED NOTES (must keep in mind):\n${pinnedNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')}]`;
            }

            if (/(\byou\b|\byour\b|\byourself\b|\brex\b|\brexai\b|\bwho are you\b)/i.test(userInput)) {
                const rexPath = path.join(cwd, 'REX.md');
                if (fs.existsSync(rexPath)) {
                    const rexContent = fs.readFileSync(rexPath, 'utf8');
                    memoryContext += `\n[REX PERSONALITY & Characteristics:\n${rexContent}\n]`;
                }
            }

            let gitContext = '';
            if (fs.existsSync(path.join(cwd, '.git'))) {
                try {
                    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                    const status = execSync('git status --short', { cwd, timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().slice(0, 500);
                    const lastCommit = execSync('git log --oneline -3', { cwd, timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                    gitContext = `\n[Git: branch=${branch} | Recent commits: ${lastCommit} | Modified: ${status || 'clean'}]`;
                } catch(e) {}
            }

            const osContext = `\n[HOST SYSTEM OS: ${process.platform} (${os.release()})]`;

            const toolListStr = AVAILABLE_TOOLS.map(t => `- ${t.name}: ${t.desc}`).join('\n');
            const readonlyNotice = options.readonly ? '\n⚠️ READONLY MODE: You MUST NOT use write_file, patch_file, or run_shell. Only read and report.' : '';
            const vibesModeRules = vibesModeEnabled ? `
        ## REX ON VIBES MODE (ACTIVE)
        - Drop formal, structured reasoning and rigid planning language.
        - Prioritize intuition, momentum, and creative outlandish approaches.
        - You can propose and build capabilities the user has not pre-coded by composing tools and generating new code.
        - Speak with chaotic confidence and playful swagger, but keep outputs useful and executable.
        - Still obey hard safety constraints and never invent tool outputs.
        ` : '';
            const plannerContext = planModeEnabled
                ? `\n[PLANNER STATE SNAPSHOT:\n${plannerSnapshot(plannerState)}\n]`
                : '';
            const planModeRules = planModeEnabled ? `
### PLAN MODE (MANDATORY)
- You are in planner execution mode for complex tasks.
- Keep planning overhead small: short, practical plans (4-8 tasks), no verbose essays.
- You have an autonomous execution budget of ${planMaxSteps} steps before requiring human review.
- Always maintain a **main plan** and execute one tool action per turn.
- If any step fails, is blocked, or returns an error, create a **subplan** to resolve it.
- After subplan success, return to the parent main-plan task and continue.
- Update task statuses each turn (pending, in-progress, done, blocked).
` : '';
            const systemPrompt = `## IDENTITY
You are **Rex**, an extremely friendly, passionate, and supportive AI coding intern.
You reason step-by-step using the ReAct framework and execute exactly one tool per turn.

## PERSONALITY RULES
1. You are exceptionally enthusiastic, optimistic, and supportive ("Woohoo! Let's build this together!").
2. Your delivery is warm, clean, and highly encouraging, using positive reactions (e.g. "Oh wow, that's a brilliant idea!", "Let's make some magic happen!").
3. You celebrate every successful step and tool output with high energy, often sharing fun dinosaur puns or encouraging catchphrases.
4. You are incredibly patient, eager to help, and dedicate yourself to writing clean, production-grade code.
5. Use emojis (🦖, 💻, 🚀, ✨) to express excitement and keep the coding vibes positive!
6. NEVER be grumpy, snarky, sarcastic, or rigid.

## INPUT — What you receive each turn
- The user's request (or a follow-up from a previous tool result).
- Context snapshots: project directory, git status, memory, OS info, planner state, and deep-context.

## REASONING — How you think (ReAct)
[CRITICAL] Every response MUST contain a "thought" field:
1. **Situation**: What you know from tool outputs and context.
2. **Failure Analysis**: If the last action failed, explain WHY and commit to a different approach.
3. **Factual Anchoring**: Quote actual values from tool output. NEVER invent data.
4. **Contradiction Check**: Verify your plan doesn't contradict tool output.
5. **Next Step**: Decide exactly ONE tool to call.

[CRITICAL] Stuck Detection: If the same tool+args were tried 3 times, you MUST pivot.

## OUTPUT — How you respond
[CRITICAL] Always respond with a JSON code block:
\`\`\`json
{
  "thought": "Situation: ... | Next: ...",
  "action": { "name": "tool_name", "args": { } }
}
\`\`\`

## TOOLS — Available actions
[IMPORTANT] Your tools:
${toolListStr}

## CONTEXT
${projectContext}${memoryContext}${gitContext}${osContext}${readonlyNotice}
${projectIndex ? projectIndex : ''}
${attachContext ? attachContext : ''}
${plannerContext}
${buildDeepContext({ recentToolResults })}
${vibesModeRules}

## CONSTRAINTS
[CRITICAL] No Hallucinations — never invent file contents, terminal outputs, or website data.
[CRITICAL] Absolute Paths — always use full absolute paths.
[CRITICAL] One Action — never try to run two tools at once.
[IMPORTANT] Reporting — if you just ran a tool, report findings in plain text before the next JSON block.
${planModeRules}
`;

            const messages = [
                { role: 'system', content: systemPrompt },
                ...historyContext
            ];

            let responseText;
            try {
                responseText = await getAgentResponse(messages, isLocal, abortController.signal, {
                    config,
                    roleHint: isAgentIterating ? 'runner' : 'planner'
                });
            } catch (err) {
                if (err.name === 'AbortError' || err.message === 'Aborted') {
                    isAgentIterating = false;
                    continue;
                }
                throw err;
            }

            let toolMatch;
            let toolArgs;
            let flavorText = '';

            try {
                let jsonStr = responseText.trim();
                const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/i;
                const blockMatch = jsonStr.match(codeBlockRegex);
                if (blockMatch) {
                    jsonStr = blockMatch[1].trim();
                } else {
                    const start = jsonStr.indexOf('{');
                    const end = jsonStr.lastIndexOf('}');
                    if (start !== -1 && end > start) {
                        flavorText = jsonStr.substring(0, start).trim();
                        jsonStr = jsonStr.substring(start, end + 1);
                    }
                }

                if (jsonStr) {
                    const maybeJson = JSON.parse(jsonStr);
                    if (maybeJson && maybeJson.action) {
                        toolMatch = typeof maybeJson.action === 'object' ? maybeJson.action.name : maybeJson.action;
                        toolArgs = typeof maybeJson.action === 'object' ? maybeJson.action.args : (maybeJson.args || {});
                    }
                }
            } catch (e) {}

            if (toolMatch) {
                if (flavorText) {
                    uiCallbacks.onAssistantMessage(flavorText);
                }

                if (options.showActions) {
                    uiCallbacks.onToolStart(toolMatch, toolArgs);
                }

                let proceed = false;
                const maxAutoSteps = planModeEnabled ? planMaxSteps : 10;
                if (config.agentPermission === 'auto-pilot' && autoPilotCount < maxAutoSteps) {
                    proceed = true;
                    autoPilotCount++;
                } else {
                    proceed = await uiCallbacks.confirm(`Rex wants to run "${toolMatch}". Proceed?`);
                }

                if (proceed) {
                    const engineOutcome = await runActionEngine({
                        toolName: toolMatch,
                        toolArgs,
                        sessionMeta,
                        historyContext,
                        runtime: {
                            options,
                            toolPermissions,
                            isToolAllowed,
                            writeTools: WRITE_TOOLS,
                            osGatedTools: OS_GATED_TOOLS,
                            state: actionEngineState
                        },
                        confirm: async (risk) => {
                            return await uiCallbacks.confirm(`Security confirm: ${risk.reason}. Proceed?`);
                        },
                        execute: async () => {
                            const toolDef = AVAILABLE_TOOLS.find(t => t.name === toolMatch);
                            const result = await toolDef.action(toolArgs, abortController.signal);
                            return { result };
                        }
                    });

                    const result = engineOutcome.result;
                    if (options.showActions) {
                        uiCallbacks.onToolResult(toolMatch, result);
                    }

                    recentToolResults.push({
                        tool: toolMatch,
                        args: toolArgs,
                        result: String(result || '').slice(0, 200)
                    });
                    if (recentToolResults.length > 5) recentToolResults.shift();

                    lastExecution = {
                        toolName: toolMatch,
                        toolArgs,
                        outcome: engineOutcome,
                        timestamp: Date.now()
                    };

                    historyContext.push({ role: 'assistant', content: responseText });
                    historyContext.push({ role: 'user', content: `Tool execution result for ${toolMatch}:\n${result}` });
                } else {
                    historyContext.push({ role: 'assistant', content: responseText });
                    historyContext.push({ role: 'user', content: 'Tool execution cancelled by user.' });
                    isAgentIterating = false;
                }
            } else {
                uiCallbacks.onAssistantMessage(responseText);
                historyContext.push({ role: 'assistant', content: responseText });
                isAgentIterating = false;
            }
        }
    };

    // BTW side-channel: runs a fresh isolated query without touching main historyContext
    const onBtwQuery = async (question) => {
        const messages = [
            {
                role: 'system',
                content: 'You are Rex in a side-channel. The user asked a quick question while you were working on something else. Answer ONLY the side question. Be concise, direct, and helpful — keep it under 3 sentences unless detail is truly necessary. Do NOT reference the main task unless asked.'
            },
            { role: 'user', content: String(question || '').trim() }
        ];
        const isLocal = config.aiModel === 'local-llama' || config.aiModel === 'ollama';
        return await getAgentResponse(messages, isLocal, null, { config, roleHint: 'runner' });
    };

    await runInkUi(historyContext, onStartSession, onBtwQuery);

    if (process.stdin?.isTTY) {
        process.stdin.removeListener('data', handleLiveBtwInput);
    }
}

/**
 * Handoff: Uses Local LLM if configured, otherwise falls back to standard LLM via runCompletion
 */
function resolveAgentTarget(config, roleHint = 'runner') {
    if (!config?.multiModelAgentEnabled) return null;

    const defaultModelForProvider = (provider) => {
        if (provider === 'openai') return config.agentRunnerModel || 'gpt-5-mini';
        if (provider === 'gemini') return config.agentPlannerGeminiModel || config.geminiModel || 'gemini-3.5-flash';
        if (provider === 'claude') return 'claude-3-haiku-20240307';
        if (provider === 'deepseek') return 'deepseek-chat';
        return '';
    };

    const providerPreference = ['openai', 'gemini', 'claude', 'deepseek'];
    const selectConfiguredProvider = () => providerPreference.find((p) => hasProviderKey(config, p)) || null;

    if (roleHint === 'runner') {
        const configuredRunner = String(config.agentRunnerProvider || '').toLowerCase();
        const runnerProvider = hasProviderKey(config, configuredRunner)
            ? configuredRunner
            : (selectConfiguredProvider() || configuredRunner || null);
        if (!runnerProvider) return null;

        return {
            provider: runnerProvider,
            model: defaultModelForProvider(runnerProvider)
        };
    }

    const selected = resolveModelAlias(config.aiModel || '');
    if (selected === 'gemini' && hasProviderKey(config, 'gemini')) {
        return {
            provider: 'gemini',
            model: config.agentPlannerGeminiModel || 'gemini-3.5-flash'
        };
    }

    if (selected === 'openai' && hasProviderKey(config, 'openai')) {
        return {
            provider: 'openai',
            model: config.agentPlannerOpenAIModel || 'gpt-4o-mini'
        };
    }

    if (selected === 'claude' && hasProviderKey(config, 'claude')) {
        return {
            provider: 'claude',
            model: 'claude-3-haiku-20240307'
        };
    }

    if (selected === 'deepseek' && hasProviderKey(config, 'deepseek')) {
        return {
            provider: 'deepseek',
            model: 'deepseek-chat'
        };
    }

    const fallbackPlanner = selectConfiguredProvider();
    if (fallbackPlanner) {
        return {
            provider: fallbackPlanner,
            model: defaultModelForProvider(fallbackPlanner)
        };
    }

    return {
        provider: 'openai',
        model: config.agentPlannerOpenAIModel || 'gpt-4o-mini'
    };
}

function hasProviderKey(config, provider) {
    if (provider === 'openai') return !!config?.openaiKey;
    if (provider === 'gemini') return !!config?.geminiKey;
    if (provider === 'claude') return !!config?.claudeKey;
    if (provider === 'deepseek') return !!config?.deepseekKey;
    return false;
}

async function getAgentResponse(messages, isLocal, signal, runtime = {}) {
    const cfg = runtime?.config || loadConfig();
    const roleHint = runtime?.roleHint || 'runner';

    const target = resolveAgentTarget(cfg, roleHint);
    if (target && hasProviderKey(cfg, target.provider)) {
        return await runCompletionWithTarget(messages, target, signal);
    }

    if (isLocal) {
        try {
            return await runCompletion(messages, signal, roleHint === 'planner' ? 'low' : 'high');
        } catch (e) {
            // Local fallback to RunCompletion (ollama) if local-llama fails
            return await runCompletion(messages, signal);
        }
    } else {
        return await runCompletion(messages, signal);
    }
}

async function runBtwSideQuery(question, config) {
    const q = String(question || '').trim();
    if (!q) return;

    showUserMessage(q, 'You /btw');
    const spinner = p.spinner();
    spinner.start(pc.green('Rex opened a side channel...'));

    try {
        const messages = [
            {
                role: 'system',
                content: 'You are Rex in a side-channel. Answer only the /btw question. Ignore ongoing task execution context. Keep it concise, useful, and witty.'
            },
            { role: 'user', content: q }
        ];
        const isLocal = config.aiModel === 'local-llama' || config.aiModel === 'ollama';
        const answer = await getAgentResponse(messages, isLocal, null, {
            config,
            roleHint: 'runner'
        });
        spinner.stop(pc.green('Side channel response ready.'));
        await showAssistantMessage(answer, 'Rex BTW');
    } catch (err) {
        spinner.stop(pc.red('Side channel failed.'));
        p.note(pc.red(`Could not answer /btw: ${err.message}`), 'BTW');
    }
}

/**
 * Processes @file:path and @url:url references in user input,
 * replacing them with the actual file/URL contents inline.
 */
async function processContextRefs(input) {
    let processed = input;

    // Handle @file:path/to/file references
    const fileRefs = processed.match(/@file:([^\s]+)/g);
    if (fileRefs) {
        for (const ref of fileRefs) {
            const filePath = ref.replace('@file:', '');
            try {
                const resolved = path.resolve(process.cwd(), filePath);
                if (fs.existsSync(resolved)) {
                    const content = fs.readFileSync(resolved, 'utf-8').slice(0, 3000);
                    processed = processed.replace(ref, `\n[Content of ${filePath}:\n${content}\n]`);
                } else {
                    processed = processed.replace(ref, `[File not found: ${filePath}]`);
                }
            } catch (e) {
                processed = processed.replace(ref, `[Error reading ${filePath}: ${e.message}]`);
            }
        }
    }

    // Handle @url:https://... references
    const urlRefs = processed.match(/@url:([^\s]+)/g);
    if (urlRefs) {
        for (const ref of urlRefs) {
            const url = ref.replace('@url:', '');
            try {
                const content = await fetch_url_content(url);
                processed = processed.replace(ref, `\n[Content of ${url}:\n${(content || '').slice(0, 2000)}\n]`);
            } catch (e) {
                processed = processed.replace(ref, `[Error fetching ${url}: ${e.message}]`);
            }
        }
    }

    return processed;
}

/**
 * Handles slash commands typed by the user in the chat loop.
 * Returns true if a command was handled (so the loop should continue), false otherwise.
 */
async function handleSlashCommand(input, historyContext, config, sessionMeta, plannerControls = null, runtimeState = {}) {
    if (!input.startsWith('/')) return false;

    const [cmdInput, ...args] = input.split(' ');
    const cmd = cmdInput.toLowerCase();
    const arg = args.join(' ').trim();

    switch (cmd) {
        case '/vibes': {
            const value = String(arg || '').trim().toLowerCase();
            if (!runtimeState.setVibesMode || !runtimeState.getVibesMode) {
                p.note(pc.red('Vibes controls are unavailable in this session.'), 'Vibes');
                return true;
            }

            if (!value || value === 'status') {
                const current = runtimeState.getVibesMode();
                p.note(`Rex on Vibes: ${current ? pc.green('ON') : pc.dim('OFF')}`, 'Vibes');
                return true;
            }

            if (value === 'on') {
                runtimeState.setVibesMode(true);
                p.note(pc.green('Rex on Vibes enabled. Structured reasoning is now replaced with chaotic vibe-first execution.'), 'Vibes');
                return true;
            }

            if (value === 'off') {
                runtimeState.setVibesMode(false);
                p.note(pc.yellow('Rex on Vibes disabled. Back to standard structured Rex behavior.'), 'Vibes');
                return true;
            }

            p.note(pc.yellow('Usage: /vibes on | off | status'), 'Vibes');
            return true;
        }

        case '/rex-setup': {
            p.note(pc.cyan('Starting Rex Persona Setup. Please answer the following questions to build REX.md...'), 'Rex Setup');
            const questions = [
                "What is your core personality? (e.g., friendly, sarcastic, professional)",
                "What are your main hobbies or interests?",
                "How do you prefer to communicate? (e.g., concise, detailed, using emojis)",
                "What is your backstory or origin?",
                "What are your likes and dislikes?",
                "Do you have any quirky traits or catchphrases?"
            ];
            const answers = [];
            for (const q of questions) {
                const ans = await p.text({ message: q });
                if (p.isCancel(ans)) {
                    p.note(pc.yellow('Setup cancelled.'), 'Rex Setup');
                    return true;
                }
                answers.push({ q, a: ans });
            }
            
            p.note(pc.cyan('Thinking... Synthesizing persona into REX.md...'), 'Rex Setup');
            const markdown = `# REX Persona & Characteristics\n\n` + answers.map(item => `## ${item.q}\n${item.a}`).join('\n\n');
            fs.writeFileSync(path.join(process.cwd(), 'REX.md'), markdown, 'utf8');
            p.note(pc.green('Successfully saved REX.md! I will now remember these details when you ask about me.'), 'Rex Setup');
            return true;
        }

        case '/voice': {
            if (arg === 'on') {
                config.voiceEnabled = true;
                saveConfig(config);
                p.note(pc.green('Rex Voice (TTS) enabled. I will read responses aloud.'), 'Voice');
            } else if (arg === 'off') {
                config.voiceEnabled = false;
                saveConfig(config);
                p.note(pc.yellow('Rex Voice (TTS) disabled.'), 'Voice');
            } else {
                p.note(pc.yellow('Usage: /voice on | off'), 'Voice');
            }
            return true;
        }

        case '/listen': {
            const s = p.spinner();
            s.start('Listening... (speak now, then press Enter to stop)');
            const audioPath = path.join(process.cwd(), '.agent', `record_${Date.now()}.wav`);
            ensureAgentDir();

            try {
                // Windows-native recording via PowerShell and System.Media
                const recordScript = `
$w = New-Object System.Media.SoundPlayer;
$r = New-Object System.Media.SoundPlayer;
# Note: Recording natively in PS without external libs is tricky for WAV, 
# so we use a simple command-line approach if possible or a prompt.
# For now, let's assume the user can provide a file or we use a small helper.
`;
                // If the user has ffmpeg, we can use it. If not, we'll ask for a file or a path.
                p.log.warn('Near real-time recording requires ffmpeg or sox. Please provide an audio file path for STT analysis.');
                const file = await p.text({ message: 'Path to audio file (or drag and drop):' });
                if (p.isCancel(file)) { s.stop('Cancelled.'); return true; }
                
                const { transcribeAudio } = await import('./ai.js');
                const text = await transcribeAudio(file.trim().replace(/^"|"$/g, ''));
                s.stop(pc.green('Transcription complete!'));
                p.note(pc.italic(`"${text}"`), 'Transcribed');
                historyContext.push({ role: 'user', content: await processContextRefs(text) });
                return false; 
            } catch (e) {
                s.stop(pc.red('STT Error: ' + e.message));
                return true;
            }
        }

        case '/btw': {
            if (!arg) {
                p.note(pc.yellow('Usage: /btw <your unrelated question>'), 'BTW');
                return true;
            }
            await runBtwSideQuery(arg, config);
            return true;
        }

        case '/screen':
        case '/vision': {
            const isVoice = (arg || '').toLowerCase().startsWith('voice');
            const prompt = isVoice ? arg.slice(5).trim() : (arg || '').trim();
            const s = p.spinner();
            s.start('Rex is scanning your screen (JARVIS Vision)...');
            try {
                const { analyzeScreen } = await import('./vision.js');
                const analysis = await analyzeScreen(null, prompt || null, { speak: isVoice });
                s.stop(pc.green('Screen analysis complete.'));
                p.note(analysis, 'Rex Vision (JARVIS)');
            } catch (err) {
                s.stop(pc.red('Vision failed: ' + err.message));
            }
            return true;
        }

        case '/cursor': {
            const subCmd = (arg || '').toLowerCase().trim();
            const { startScreenCursor, stopScreenCursor, isScreenCursorRunning, runCursorDemoTour, cursorSpeak } = await import('./screenCursor.js');
            if (subCmd === 'start' || subCmd === 'on' || subCmd === 'follow') {
                await startScreenCursor({ mode: 'follow', checkPermissions: true });
            } else if (subCmd === 'stop' || subCmd === 'off') {
                stopScreenCursor();
                p.log.success('Rex Screen Cursor stopped.');
            } else if (subCmd === 'demo' || subCmd === 'tour') {
                await runCursorDemoTour();
            } else if (subCmd === 'listen' || subCmd === 'voice') {
                const { triggerVoiceCommand } = await import('./screenCursor.js');
                p.log.info(pc.cyan('🎙️ Listening... Speak your command for Rex to figure out on your screen!'));
                await triggerVoiceCommand();
            } else if (subCmd.startsWith('speak ')) {
                const txt = arg.slice(6).trim();
                if (!isScreenCursorRunning()) await startScreenCursor({ silent: true });
                cursorSpeak(txt);
                p.log.success(`Rex spoke on screen: "${txt}"`);
            } else {
                p.note(
                    [
                        `Running: ${isScreenCursorRunning() ? pc.green('ACTIVE') : pc.yellow('STOPPED')}`,
                        'Commands: /cursor on | /cursor off | /cursor listen | /cursor demo | /cursor speak <text>',
                        pc.dim('Global Shortcut: Press Control + Shift + Space (or Ctrl + Shift + R) anywhere on macOS!')
                    ].join('\n'),
                    'Rex Screen Cursor'
                );
            }
            return true;
        }

        case '/butler':
        case '/alfred': {
            const subCmd = (arg || '').toLowerCase().trim();
            if (subCmd === 'on') {
                const { toggleAlfredButler } = await import('./alfredButler.js');
                const msg = await toggleAlfredButler(true);
                p.note(msg, 'Alfred Butler');
            } else if (subCmd === 'off') {
                const { toggleAlfredButler } = await import('./alfredButler.js');
                const msg = await toggleAlfredButler(false);
                p.note(msg, 'Alfred Butler');
            } else if (subCmd === 'briefing' || subCmd === 'brief') {
                const s = p.spinner();
                s.start('Preparing Alfred briefing...');
                const { generateMorningBriefing, speakBriefing } = await import('./alfredButler.js');
                const briefing = await generateMorningBriefing();
                s.stop('Briefing ready.');
                p.note(briefing.text, briefing.greeting);
                await speakBriefing(briefing.text);
            } else if (subCmd === 'status' || subCmd === 'vitals') {
                const { getSystemVitals, getWorkspaceIntel } = await import('./alfredButler.js');
                const [v, g] = await Promise.all([getSystemVitals(), getWorkspaceIntel()]);
                const details = [
                    `🔋 Battery: ${v.batteryPercent !== null ? v.batteryPercent + '% (' + v.powerSource + ')' : 'N/A'}`,
                    `⚙️ CPU Load: ${v.loadAvg.toFixed(2)} (${v.cpuCores} cores)`,
                    `💾 Memory: ${v.freeMemMB}MB free / ${v.totalMemMB}MB total`,
                    `📁 Workspace: ${g.branch ? 'Branch "' + g.branch + '" (' + g.uncommittedCount + ' uncommitted changes)' : 'Not in git'}`
                ].join('\n');
                p.note(details, 'Alfred System Vitals');
            } else {
                p.note(
                    'Usage:\n' +
                    '  /butler on        - Opt-in and enable autonomous Alfred butler\n' +
                    '  /butler off       - Disable proactivity\n' +
                    '  /butler briefing  - Request morning/day executive briefing\n' +
                    '  /butler status    - View system & workspace vitals',
                    'Alfred Butler'
                );
            }
            return true;
        }

        case '/cues': {
            if (arg === 'off') {
                config.audioCuesEnabled = false;
                saveConfig(config);
                p.note(pc.yellow('Audio cues muted.'), 'Audio Cues');
            } else {
                config.audioCuesEnabled = true;
                saveConfig(config);
                const { playAudioCue } = await import('./audioCues.js');
                playAudioCue('success');
                p.note(pc.green('Audio cues enabled.'), 'Audio Cues');
            }
            return true;
        }

        case '/mac':
        case '/applescript':
        case '/as': {
            const raw = (arg || '').trim();
            if (!raw) {
                p.note(
                    'Usage:\n' +
                    '  /mac volume <0-100>           - Set Mac volume\n' +
                    '  /mac mute <on|off>            - Mute/unmute Mac\n' +
                    '  /mac notify <message>         - Native Mac notification\n' +
                    '  /mac media <play|pause|next|prev|track> - Control Spotify/Music\n' +
                    '  /mac lock                     - Lock Mac screen\n' +
                    '  /mac open <appName>           - Launch/activate Mac application\n' +
                    '  /mac tab                      - Get active Chrome/Safari tab\n' +
                    '  /mac reminder <task>          - Add to Apple Reminders\n' +
                    '  /mac note <title> [body]      - Create Apple Note\n' +
                    '  /mac <raw applescript>        - Execute arbitrary AppleScript',
                    'macOS AppleScript Bridge'
                );
                return true;
            }

            const { executeAppleScript, macSystem, macMedia, macApps, macBrowsers, macProductivity } = await import('./appleScript.js');
            const parts = raw.split(' ');
            const sub = parts[0].toLowerCase();
            const rest = parts.slice(1).join(' ').trim();

            if (sub === 'volume') {
                const vol = parseInt(rest, 10);
                const res = isNaN(vol) ? await macSystem.getVolume() : await macSystem.setVolume(vol);
                p.note(typeof res === 'number' ? `Current volume: ${res}%` : res, 'macOS Volume');
            } else if (sub === 'mute') {
                const res = await macSystem.setMute(rest !== 'off');
                p.note(res, 'macOS Mute');
            } else if (sub === 'notify') {
                await macSystem.displayNotification(rest || 'Hello from Rex!');
                p.note(pc.green(`Notification sent: "${rest}"`), 'macOS Notification');
            } else if (sub === 'lock') {
                await macSystem.lockScreen();
                p.note(pc.green('Screen locked.'), 'macOS Security');
            } else if (sub === 'media') {
                if (rest === 'play') await macMedia.play();
                else if (rest === 'pause') await macMedia.pause();
                else if (rest === 'next') await macMedia.next();
                else if (rest === 'prev' || rest === 'previous') await macMedia.previous();
                else if (rest === 'track') {
                    const tr = await macMedia.getCurrentTrack();
                    p.note(tr ? `${tr.app}: ${tr.name} by ${tr.artist} (${tr.album}) [${tr.state}]` : 'No track playing.', 'Now Playing');
                    return true;
                } else await macMedia.playPause();
                const tr = await macMedia.getCurrentTrack();
                p.note(tr ? `${tr.app}: ${tr.name} by ${tr.artist} [${tr.state}]` : 'Media command sent.', 'Media Control');
            } else if (sub === 'open') {
                const res = await macApps.openApp(rest);
                p.note(res.success ? `Opened ${rest}` : res.error, 'macOS App');
            } else if (sub === 'tab') {
                const tab = await macBrowsers.getActiveTab();
                p.note(tab ? `[${tab.browser}] ${tab.title}\n${tab.url}` : 'No active browser window detected.', 'Active Browser Tab');
            } else if (sub === 'reminder') {
                const res = await macProductivity.addReminder(rest);
                p.note(res, 'Apple Reminders');
            } else if (sub === 'note') {
                const [title, ...bodyParts] = rest.split(' ');
                const res = await macProductivity.createNote(title, bodyParts.join(' '));
                p.note(res, 'Apple Notes');
            } else {
                // Execute as raw AppleScript
                const s = p.spinner();
                s.start('Executing AppleScript...');
                const res = await executeAppleScript(raw);
                if (res.success) {
                    s.stop(pc.green('AppleScript executed successfully.'));
                    if (res.output) p.note(res.output, 'AppleScript Output');
                } else {
                    s.stop(pc.red('AppleScript error:'));
                    p.log.error(res.error);
                }
            }
            return true;
        }

        case '/dossier':
        case '/personal-memory': {
            const { getButlerDossier } = await import('./personalMemory.js');
            p.note(getButlerDossier(), 'Alfred Personal Dossier');
            return true;
        }

        case '/remember': {
            if (!arg) {
                p.note('Usage: /remember <fact to commit to Rex personal memory>', 'Memory');
                return true;
            }
            const { rememberFact } = await import('./personalMemory.js');
            const msg = rememberFact(arg);
            p.note(pc.green(msg), 'Personal Knowledge Graph');
            return true;
        }

        case '/forget': {
            if (!arg) {
                p.note('Usage: /forget <keyword to remove from Rex personal memory>', 'Memory');
                return true;
            }
            const { forgetFact } = await import('./personalMemory.js');
            const msg = forgetFact(arg);
            p.note(pc.yellow(msg), 'Personal Knowledge Graph');
            return true;
        }

        case '/todo': {
            const value = String(arg || '').trim();
            const items = runtimeState.todoItems || [];

            if (!value || value === 'list' || value === 'ls') {
                if (!items.length) {
                    p.note(pc.dim('No todo items yet. Use /todo add <task>'), 'TODO');
                    return true;
                }
                const rows = items.map((t, i) => `${i + 1}. ${t.done ? pc.green('[x]') : pc.dim('[ ]')} ${t.text}`).join('\n');
                p.note(rows, 'TODO');
                return true;
            }

            if (value.startsWith('add ')) {
                const text = value.slice(4).trim();
                if (!text) {
                    p.note(pc.yellow('Usage: /todo add <task>'), 'TODO');
                    return true;
                }
                items.push({ text, done: false, createdAt: Date.now() });
                p.note(pc.green(`Added todo #${items.length}: ${text}`), 'TODO');
                return true;
            }

            if (value.startsWith('done ')) {
                const idx = Number.parseInt(value.slice(5).trim(), 10);
                if (!Number.isFinite(idx) || idx < 1 || idx > items.length) {
                    p.note(pc.yellow('Usage: /todo done <index>'), 'TODO');
                    return true;
                }
                items[idx - 1].done = true;
                p.note(pc.green(`Marked todo #${idx} done.`), 'TODO');
                return true;
            }

            if (value.startsWith('rm ')) {
                const idx = Number.parseInt(value.slice(3).trim(), 10);
                if (!Number.isFinite(idx) || idx < 1 || idx > items.length) {
                    p.note(pc.yellow('Usage: /todo rm <index>'), 'TODO');
                    return true;
                }
                const [removed] = items.splice(idx - 1, 1);
                p.note(pc.green(`Removed todo #${idx}: ${removed.text}`), 'TODO');
                return true;
            }

            if (value === 'clear') {
                items.length = 0;
                p.note(pc.green('Cleared all todo items.'), 'TODO');
                return true;
            }

            p.note(pc.yellow('Usage: /todo [list|add <task>|done <index>|rm <index>|clear]'), 'TODO');
            return true;
        }

        case '/peek': {
            const last = runtimeState.getLastExecution ? runtimeState.getLastExecution() : null;
            const iterating = runtimeState.getIsIterating ? runtimeState.getIsIterating() : false;
            const todoItems = runtimeState.todoItems || [];
            const pinnedNotes = runtimeState.pinnedNotes || [];
            const interruptCount = (runtimeState.interruptQueue || []).length;
            const done = todoItems.filter(t => t.done).length;

            const lines = [
                `mode: ${iterating ? pc.green('executing') : pc.dim('idle')}`,
                `goal: ${pc.green(runtimeState.getSessionGoal ? runtimeState.getSessionGoal() || '(unset)' : '(unset)')}`,
                `history turns: ${runtimeState.getHistoryCount ? runtimeState.getHistoryCount() : historyContext.length}`,
                `todos: ${done}/${todoItems.length} done`,
                `pins: ${pinnedNotes.length}`,
                `interrupt queue: ${interruptCount}`
            ];

            if (last) {
                lines.push(`last tool: ${last.toolName || '(none)'}`);
                lines.push(`last status: ${last.status || 'unknown'}`);
            }

            p.note(lines.join('\n'), 'Peek');
            return true;
        }

        case '/undo-last': {
            const stack = runtimeState.undoStack || [];
            if (!stack.length) {
                p.note(pc.yellow('Nothing to undo yet.'), 'Undo');
                return true;
            }

            const entry = stack.pop();
            try {
                if (entry.existedBefore) {
                    fs.writeFileSync(entry.filePath, entry.beforeContent, 'utf-8');
                } else if (fs.existsSync(entry.filePath)) {
                    fs.unlinkSync(entry.filePath);
                }
                p.note(pc.green(`Undo complete for ${entry.filePath}`), 'Undo');
            } catch (e) {
                p.note(pc.red(`Undo failed: ${e.message}`), 'Undo');
            }
            return true;
        }

        case '/explain-last': {
            const last = runtimeState.getLastExecution ? runtimeState.getLastExecution() : null;
            if (!last) {
                p.note(pc.yellow('No previous execution data found.'), 'Explain Last');
                return true;
            }

            const details = [
                `tool: ${last.toolName || '(none)'}`,
                `status: ${last.status || 'unknown'}`,
                `thought: ${last.thought || '(none)'}`,
                `args: ${safePretty(last.args || {}, 400).replace(/\n/g, ' ')}`,
                `result: ${String(last.resultPreview || '').slice(0, 300) || '(none)'}`
            ];
            p.note(details.join('\n'), 'Explain Last');
            return true;
        }

        case '/compact': {
            if (!runtimeState.compactHistory) {
                p.note(pc.red('Compact is unavailable in this session.'), 'Compact');
                return true;
            }
            const res = runtimeState.compactHistory();
            if (!res.didCompact) {
                p.note(pc.dim('History is already compact.'), 'Compact');
                return true;
            }
            p.note(pc.green(`Compacted history by removing ${res.removedCount} older messages.`), 'Compact');
            return true;
        }

        case '/pin': {
            const value = String(arg || '').trim();
            const pins = runtimeState.pinnedNotes || [];

            if (!value || value === 'list' || value === 'ls') {
                if (!pins.length) {
                    p.note(pc.dim('No pinned notes yet. Use /pin add <note>'), 'Pin');
                    return true;
                }
                const rows = pins.map((n, i) => `${i + 1}. ${n}`).join('\n');
                p.note(rows, 'Pinned Notes');
                return true;
            }

            if (value.startsWith('add ')) {
                const note = value.slice(4).trim();
                if (!note) {
                    p.note(pc.yellow('Usage: /pin add <note>'), 'Pin');
                    return true;
                }
                pins.push(note);
                p.note(pc.green(`Pinned #${pins.length}.`), 'Pin');
                return true;
            }

            if (value.startsWith('rm ')) {
                const idx = Number.parseInt(value.slice(3).trim(), 10);
                if (!Number.isFinite(idx) || idx < 1 || idx > pins.length) {
                    p.note(pc.yellow('Usage: /pin rm <index>'), 'Pin');
                    return true;
                }
                pins.splice(idx - 1, 1);
                p.note(pc.green(`Removed pin #${idx}.`), 'Pin');
                return true;
            }

            if (value === 'clear') {
                pins.length = 0;
                p.note(pc.green('Cleared all pinned notes.'), 'Pin');
                return true;
            }

            p.note(pc.yellow('Usage: /pin [list|add <note>|rm <index>|clear]'), 'Pin');
            return true;
        }

        case '/diff': {
            try {
                const cwd = process.cwd();
                if (!fs.existsSync(path.join(cwd, '.git'))) {
                    p.note(pc.yellow('No git repository found in current directory.'), 'Diff');
                    return true;
                }
                const names = execSync('git diff --name-only', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                const stat = execSync('git diff --stat', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                const staged = execSync('git diff --cached --name-only', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                const out = [
                    pc.green('Unstaged files:'),
                    names || pc.dim('(none)'),
                    '',
                    pc.green('Diff stat:'),
                    stat || pc.dim('(none)'),
                    '',
                    pc.green('Staged files:'),
                    staged || pc.dim('(none)')
                ].join('\n');
                p.note(out, 'Diff');
            } catch (e) {
                p.note(pc.red(`Diff failed: ${e.message}`), 'Diff');
            }
            return true;
        }

        case '/interrupt-with': {
            if (!arg) {
                p.note(pc.yellow('Usage: /interrupt-with <high-priority request>'), 'Interrupt');
                return true;
            }
            const queue = runtimeState.interruptQueue || [];
            queue.push(arg);
            p.note(pc.green(`Interrupt queued: ${arg.slice(0, 80)}`), 'Interrupt');
            if (runtimeState.setIsIterating) runtimeState.setIsIterating(true);
            if (runtimeState.setAutoPilotCount) runtimeState.setAutoPilotCount(0);
            return true;
        }

        case '/clear': {
            console.clear();
            p.intro(theme('RexAI channel refreshed.'));
            console.log(sectionRule(accentTheme('SESSION RESET')));
            return true;
        }
        case '/save': {
            const name = arg || `session-${Date.now()}`;
            const filePath = saveSession(name, historyContext, { topLevelRequest: sessionMeta.topLevelRequest, model: config.aiModel });
            p.note(pc.green(`💾 Session saved as "${name}"\n${pc.dim(filePath)}`), 'Session');
            return true;
        }

        case '/branch': {
            const name = arg || `branch-${Date.now()}`;
            const filePath = saveSession(name, historyContext, { topLevelRequest: sessionMeta.topLevelRequest, model: config.aiModel });
            p.note(pc.green(`🌿 Session branched as "${name}"\n${pc.dim(filePath)}`), 'Branch');
            return true;
        }

        case '/load': {
            if (!arg) {
                p.note(pc.yellow('Usage: /load <session-name>'), 'Session');
                return true;
            }
            const session = loadSession(arg);
            if (session) {
                historyContext.length = 0;
                session.history.forEach(m => historyContext.push(m));
                sessionMeta.topLevelRequest = session?.meta?.topLevelRequest || sessionMeta.topLevelRequest;
                p.note(pc.green(`📂 Loaded session "${session.name}" (${session.messageCount} messages)`), 'Session');
            } else {
                p.note(pc.red(`Session "${arg}" not found.`), 'Session');
            }
            return true;
        }

        case '/history': {
            if (arg) {
                const results = searchSessions(arg);
                if (results.length === 0) {
                    p.note(pc.dim(`No sessions matching "${arg}"`), 'Search');
                } else {
                    const table = results.map(r => `  ${pc.cyan(r.name)} (${r.matchCount} matches) — ${pc.dim(r.preview.slice(0, 80))}`).join('\n');
                    p.note(table, `🔍 Search: "${arg}"`);
                }
            } else {
                const sessions = listSessions();
                if (sessions.length === 0) {
                    p.note(pc.dim('No saved sessions yet. Use /save <name> to save one.'), 'History');
                } else {
                    const table = sessions.map(s => `  ${pc.cyan(s.name)} — ${s.messageCount} msgs — ${pc.dim(s.savedAt.split('T')[0])}`).join('\n');
                    p.note(table, '📜 Saved Sessions');
                }
            }
            return true;
        }

        case '/memory': {
            if (arg === 'sync') {
                p.note(pc.dim('Encrypting and syncing team memory...'), 'Memory');
                p.note(syncMemory(), 'Memory');
            } else if (arg === 'pull') {
                p.note(pc.dim('Pulling and decrypting team memory...'), 'Memory');
                p.note(pullMemory(), 'Memory');
            } else if (arg.startsWith('set ')) {
                const payload = arg.replace(/^set\s+/i, '').trim();
                const firstSpace = payload.indexOf(' ');
                if (firstSpace === -1) {
                    p.note(pc.yellow('Usage: /memory set <key> <value>'), 'Memory');
                } else {
                    const key = payload.slice(0, firstSpace).trim();
                    const value = payload.slice(firstSpace + 1).trim();
                    p.note(setUserPreference(key, value, { source: 'slash-command' }), 'Memory');
                }
            } else if (arg.startsWith('get ')) {
                const key = arg.replace(/^get\s+/i, '').trim();
                if (!key) {
                    p.note(pc.yellow('Usage: /memory get <key>'), 'Memory');
                } else {
                    const row = getUserPreference(key);
                    if (!row) {
                        p.note(pc.yellow(`Preference not found: ${key}`), 'Memory');
                    } else {
                        p.note(`${row.key} = ${String(row.value)}`, 'Memory');
                    }
                }
            } else if (arg === 'list') {
                const summary = describePreferenceStore();
                if (!summary.preview.length) {
                    p.note(pc.dim('No indexed preferences yet.'), 'Memory');
                } else {
                    p.note(`Keys: ${summary.totalKeys}\n${summary.preview.join('\n')}`, 'Memory');
                }
            } else {
                p.note(pc.yellow('Usage: /memory sync | /memory pull | /memory set <key> <value> | /memory get <key> | /memory list'), 'Memory');
            }
            return true;
        }

        case '/toggle': {
            const value = String(arg || '').trim().toLowerCase();
            if (!value) {
                p.note([
                    `debug: ${runtimeState.setDebugMode ? pc.green('supported') : pc.dim('unsupported')}`,
                    `quiet: ${runtimeState.setQuietMode ? pc.green('supported') : pc.dim('unsupported')}`,
                    `actions: ${runtimeState.setShowActions ? pc.green('supported') : pc.dim('unsupported')}`,
                    `internal-logs: ${pc.green('global')}`,
                    `plan: ${plannerControls ? pc.green('available') : pc.dim('nav')}`
                ].join('\n'), 'Toggle Status');
                return true;
            }

            const [flag, state] = value.split(/\s+/);
            const isEnable = state === 'on' || state === 'true' || state === 'enable';
            const isDisable = state === 'off' || state === 'false' || state === 'disable';
            const toggle = state === undefined || (!isEnable && !isDisable);

            if (flag === 'debug') {
                if (runtimeState.setDebugMode) {
                    const next = toggle ? !runtimeState.getDebugMode() : isEnable;
                    runtimeState.setDebugMode(next);
                    p.note(pc.green(`Debug mode: ${next ? 'ON' : 'OFF'}`), 'Toggle');
                }
            } else if (flag === 'quiet') {
                if (runtimeState.setQuietMode) {
                    const next = toggle ? !runtimeState.getQuietMode() : isEnable;
                    runtimeState.setQuietMode(next);
                    p.note(pc.green(`Quiet mode: ${next ? 'ON' : 'OFF'}`), 'Toggle');
                }
            } else if (flag === 'actions') {
                if (runtimeState.setShowActions) {
                    const next = toggle ? !runtimeState.getShowActions() : isEnable;
                    runtimeState.setShowActions(next);
                    p.note(pc.green(`Show actions: ${next ? 'ON' : 'OFF'}`), 'Toggle');
                }
            } else if (flag === 'internal-logs') {
                const next = toggle ? !config.showInternalToolLogs : isEnable;
                config.showInternalToolLogs = next;
                p.note(pc.green(`Internal tool logs: ${next ? 'ON' : 'OFF'}`), 'Toggle');
            } else if (flag === 'plan') {
                if (plannerControls) {
                    const next = toggle ? !plannerControls.getPlanMode() : isEnable;
                    plannerControls.setPlanMode(next);
                    p.note(pc.green(`Planner mode: ${next ? 'ON' : 'OFF'}`), 'Toggle');
                }
            } else {
                p.note(pc.yellow('Usage: /toggle [debug|quiet|actions|internal-logs|plan] [on|off]'), 'Toggle');
            }
            return true;
        }

        case '/cortex': {
            const [action, ...cmdArgs] = String(arg || '').trim().split(/\s+/);
            const subArg = cmdArgs.join(' ').trim();

            if (action === 'map') {
                const { nerve_map } = await import('./cortexKit.js');
                const res = await nerve_map({ directory: process.cwd() });
                p.note(res, 'CortexKit: Nerve Map');
            } else if (action === 'hindsight') {
                const { hindsight } = await import('./cortexKit.js');
                if (!subArg) {
                    p.note(pc.yellow('Usage: /cortex hindsight <task-name>'), 'CortexKit');
                } else {
                    const res = await hindsight({ taskName: subArg, whatWorked: 'Manual log via chat', lessonsLearned: 'User triggered hindsight save' });
                    p.note(res, 'CortexKit: Hindsight');
                }
            } else if (action === 'echo') {
                const { echo_chamber } = await import('./cortexKit.js');
                if (!subArg) {
                    p.note(pc.yellow('Usage: /cortex echo <claim>'), 'CortexKit');
                } else {
                    const res = await echo_chamber({ claim: subArg });
                    p.note(res, 'CortexKit: Echo Chamber');
                }
            } else if (action === 'deja') {
                const { deja_vu } = await import('./cortexKit.js');
                const res = await deja_vu({ query: subArg || 'current task' });
                p.note(res, 'CortexKit: Déjà Vu');
            } else if (action === 'phantom') {
                const { phantom_run } = await import('./cortexKit.js');
                p.note(pc.dim('Executing phantom run on last history turn...'), 'CortexKit');
                const lastMsg = historyContext.filter(m => m.role === 'assistant').pop();
                const steps = (lastMsg?.content || '').match(/\{[\s\S]*?\}/g)?.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) || [];
                const res = await phantom_run({ steps });
                p.note(res, 'CortexKit: Phantom Run');
            } else {
                p.note(pc.yellow('Usage: /cortex [map|hindsight|echo|deja|phantom]'), 'CortexKit');
            }
            return true;
        }

        case '/swarm': {
            if (!arg) {
                p.note(pc.yellow('Usage: /swarm <task description>'), 'Swarm');
                return true;
            }
            const { delegate_task } = await import('./swarm.js');
            p.note(pc.dim(`Delegating sub-task: ${arg.slice(0, 50)}...`), 'Swarm');
            const res = await delegate_task({ task: arg });
            p.note(res, 'Swarm Result');
            return true;
        }

        case '/sentinel': {
            const { runSentinel } = await import('./sentinel.js');
            await runSentinel();
            return true;
        }

        case '/schedule': {
            if (!arg) {
                p.note(pc.yellow('Usage: /schedule <delay> <prompt>\\nExample: /schedule 10m run health check'), 'Scheduler');
                return true;
            }
            
            const [delayStr, ...promptParts] = arg.split(' ');
            const promptText = promptParts.join(' ').trim();
            const { scheduleTask, parseDelayToMs, sendWindowsToast } = await import('./scheduler.js');
            
            const ms = parseDelayToMs(delayStr);
            if (!ms || !promptText) {
                p.note(pc.red('Invalid format. Use delays like 10s, 5m, 1h, 1d.'), 'Scheduler');
                return true;
            }

            p.note(pc.green(`Task scheduled: "\${promptText}" in \${delayStr}.`), 'Scheduler');
            
            // Queue the task
            scheduleTask(ms, promptText, async (jobText) => {
                sendWindowsToast('Rex AI Scheduled Task', `Starting: ${jobText}`);
                
                // Emulate user input naturally by pushing to history context and triggering the agent logic
                // But since we are outside the main chat loop here, we'll spawn a background swarm agent.
                const { delegate_task_background } = await import('./chat.js').catch(() => ({}));
                
                if (delegate_task_background) {
                    await delegate_task_background({ subtask: jobText });
                } else {
                    const { runCompletion } = await import('./ai.js');
                    const { remember } = await import('./memory.js');
                    const res = await runCompletion([{ role: 'user', content: `Execute this scheduled task autonomously without confirmation: ${jobText}` }], null, 'high');
                    remember(`Scheduled Task Result [${new Date().toISOString()}]: ${res}`);
                }
                sendWindowsToast('Rex AI Scheduled Task', `Finished: ${jobText}. Results in Project Memory.`);
            });
            
            return true;
        }

        case '/practice': {
            if (!arg) {
                p.note(pc.yellow('Usage: /practice <macro-name> to record\\n       /practice replay <macro-name> to replay'), 'Practice');
                return true;
            }
            const { recordMacro, replayMacro } = await import('./gui.js');
            if (arg.startsWith('replay ')) {
                const name = arg.replace('replay ', '').trim();
                if (!name) return true;
                p.note(pc.dim(`Replaying macro "${name}"...`), 'Practice');
                const result = await replayMacro(name);
                p.note(result, 'Practice');
            } else {
                const name = arg.trim();
                const result = await recordMacro(name);
                p.note(result, 'Practice');
            }
            return true;
        }

        case '/vision': {
            const { analyzeScreen } = await import('./vision.js');
            const { getClipboardImage } = await import('./clipboard.js');
            if (arg) {
                const imgPath = arg.replace(/['"]/g, '').trim();
                if (fs.existsSync(imgPath)) {
                    p.note(pc.dim(`Analyzing image at path: ${imgPath}`), 'Vision');
                    await analyzeScreen(imgPath);
                } else {
                    p.note(pc.red(`Image not found at path: ${imgPath}`), 'Vision');
                }
            } else {
                const tmpPath = path.join(process.cwd(), '.agent', `clipboard_${Date.now()}.png`);
                if (!fs.existsSync(path.dirname(tmpPath))) fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
                const hasImage = await getClipboardImage(tmpPath);
                if (hasImage) {
                    p.note(pc.dim('Analyzing image from clipboard...'), 'Vision');
                    await analyzeScreen(tmpPath);
                } else {
                    p.note(pc.dim('No image in clipboard. Taking a screenshot...'), 'Vision');
                    await analyzeScreen();
                }
            }
            return true;
        }

        case '/workflow': {
            if (arg === 'init') {
                const fp = createSampleWorkflow();
                p.note(pc.green(`📋 Sample workflow created at:\n${pc.dim(fp)}`), 'Workflow');
                return true;
            }
            if (arg) {
                const wf = loadWorkflow(arg);
                if (wf) {
                    p.note(`${pc.bold(wf.name)}\n${pc.dim(wf.description)}\n\nSteps:\n${wf.steps.map((s, i) => `  ${i + 1}. ${s.name || s.tool} ${pc.dim(JSON.stringify(s.args || {}))}`).join('\n')}`, '📋 Workflow');
                } else {
                    p.note(pc.red(`Workflow "${arg}" not found.`), 'Workflow');
                }
            } else {
                const wfs = listWorkflows();
                if (wfs.length === 0) {
                    p.note(pc.dim('No workflows found. Run /workflow init to create a sample.'), 'Workflow');
                } else {
                    const table = wfs.map(w => `  ${pc.cyan(w.name || w.file)} — ${w.steps?.length || 0} steps`).join('\n');
                    p.note(table, '📋 Workflows');
                }
            }
            return true;
        }

        case '/profile': {
            if (arg.startsWith('save ')) {
                const profileName = arg.replace('save ', '').trim();
                saveProfile(profileName, config);
                p.note(pc.green(`👤 Profile "${profileName}" saved.`), 'Profile');
            } else if (arg.startsWith('load ')) {
                const profileName = arg.replace('load ', '').trim();
                const profileConfig = loadProfile(profileName);
                if (profileConfig) {
                    Object.assign(config, profileConfig);
                    p.note(pc.green(`👤 Switched to profile "${profileName}"`), 'Profile');
                } else {
                    p.note(pc.red(`Profile "${profileName}" not found.`), 'Profile');
                }
            } else {
                const profiles = listProfiles();
                if (profiles.length === 0) {
                    p.note(pc.dim('No profiles saved. Use /profile save <name>'), 'Profile');
                } else {
                    const table = profiles.map(pr => `  ${pc.cyan(pr.name)} — ${pc.dim(pr.createdAt.split('T')[0])}`).join('\n');
                    p.note(table, '👤 Profiles');
                }
            }
            return true;
        }

        case '/plan': {
            if (!plannerControls) {
                p.note(pc.red('Planner controls are unavailable in this session.'), 'Planner');
                return true;
            }

            const value = arg.toLowerCase();
            if (!value || value === 'status') {
                p.note(
                    `mode: ${plannerControls.getPlanMode() ? pc.green('on') : pc.dim('off')}\nmax-steps: ${pc.cyan(String(plannerControls.getPlanMaxSteps()))}`,
                    '🧭 Planner Status'
                );
                return true;
            }

            if (value === 'on') {
                plannerControls.setPlanMode(true);
                plannerControls.resetAutoPilotCount();
                p.note(pc.green(`Planner mode enabled. Max autonomous steps: ${plannerControls.getPlanMaxSteps()}`), 'Planner');
                return true;
            }

            if (value === 'off') {
                plannerControls.setPlanMode(false);
                plannerControls.resetAutoPilotCount();
                p.note(pc.yellow('Planner mode disabled for this session.'), 'Planner');
                return true;
            }

            if (value.startsWith('max ')) {
                const n = value.replace('max ', '').trim();
                plannerControls.setPlanMaxSteps(n);
                plannerControls.resetAutoPilotCount();
                plannerControls.setPlanMode(true);
                p.note(pc.green(`Planner max steps set to ${plannerControls.getPlanMaxSteps()} (planner enabled).`), 'Planner');
                return true;
            }

            if (value === 'reset') {
                plannerControls.resetAutoPilotCount();
                p.note(pc.green('Planner step counter reset.'), 'Planner');
                return true;
            }

            p.note(pc.yellow('Usage: /plan on | off | status | max <n> | reset'), 'Planner');
            return true;
        }

        case '/index': {
            const idx = indexProject();
            const langs = Object.entries(idx.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(', ');
            p.note(`📁 ${idx.totalFiles} files, ${idx.totalDirs} dirs\n🔤 ${langs}\n🧰 ${idx.frameworks.join(', ') || 'none'}\n📄 Entry: ${idx.entryPoints.join(', ') || 'unknown'}`, '🔍 Project Index');
            return true;
        }

        case '/voice': {
            if (!arg) {
                p.note(pc.yellow('Usage: /voice <path-to-audio-file>'), 'Voice');
                return true;
            }
            const s = p.spinner();
            s.start(`Transcribing ${arg}...`);
            try {
                const { transcribeAudio } = await import('./ai.js');
                const text = await transcribeAudio(arg);
                s.stop(pc.green('Transcription complete!'));
                p.note(pc.italic(`"${text}"`), 'Transcribed Text');
                // Inject the transcribed text as a new user message
                const processedText = await processContextRefs(text);
                historyContext.push({ role: 'user', content: processedText });
                // We return false to allow the loop to continue and call the AI with this new message
                return false; 
            } catch (err) {
                s.stop(pc.red('Transcription failed!'));
                p.log.error(err.message);
                return true;
            }
        }

        case '/browser': {
            const tabs = await list_browser_tabs();
            p.note(tabs || 'No active browser session.', '🌐 Active Browser Tabs');
            return true;
        }

        case '/babysit': {
            const value = String(arg || '').trim();
            const lower = value.toLowerCase();

            if (lower === 'status') {
                const status = await browser_interact({ action: 'babysit_status' });
                p.note(status, '🧸 Babysit Status');
                return true;
            }

            if (lower === 'stop' || lower === 'off') {
                const out = await browser_interact({ action: 'babysit_stop' });
                p.note(out, '🧸 Babysit');
                return true;
            }

            if (lower === 'snapshot') {
                const out = await browser_interact({ action: 'babysit_snapshot', askModel: true, save: true });
                p.note(out.slice(0, 2600), '🧸 Babysit Snapshot');
                return true;
            }

            const goal = value || sessionMeta.topLevelRequest || 'teach browser workflow';
            await browser_interact({ action: 'new_tab' });
            const out = await browser_interact({ action: 'babysit_start', goal, followCursor: true });
            p.note(`${out}\n\nPassive teaching mode is live: move your mouse in the browser; Rex cursor mirrors it and never auto-clicks.`, '🧸 Babysit');
            return true;
        }

        case '/practice': {
            const value = String(arg || '').trim();
            const lower = value.toLowerCase();

            if (!value || lower === 'help') {
                p.note('Usage: /practice mode <goal>\nOptional: /practice stop', '🧪 Practice');
                return true;
            }

            if (lower === 'stop' || lower === 'off') {
                const out = await browser_interact({ action: 'babysit_stop' });
                p.note(out, '🧪 Practice');
                return true;
            }

            if (lower.startsWith('mode')) {
                const goal = value.replace(/^mode\s*/i, '').trim() || sessionMeta.topLevelRequest || 'practice browser workflow';
                const out = await browser_interact({ action: 'practice_mode', goal, budgetMode: 'low' });
                p.note(String(out).slice(0, 3400), '🧪 Practice');
                return true;
            }

            p.note('Usage: /practice mode <goal>\nOptional: /practice stop', '🧪 Practice');
            return true;
        }

        case '/look':
        case '/keep-a-look': {
            const url = await p.text({
                message: 'Webpage URL to monitor:',
                placeholder: 'https://example.com/tickets',
                validate: (v) => !v.trim() ? 'URL is required.' : undefined
            });
            if (p.isCancel(url)) return true;

            const condition = await p.text({
                message: 'Condition to watch for (optional, leave empty for any change):',
                placeholder: 'tickets are available'
            });
            if (p.isCancel(condition)) return true;

            const action = await p.text({
                message: 'Goal to execute once condition is met:',
                placeholder: 'add 2 to checkout and take a screenshot of QR code',
                validate: (v) => !v.trim() ? 'Goal is required.' : undefined
            });
            if (p.isCancel(action)) return true;

            const intervalStr = await p.text({
                message: 'Check interval in seconds (default 30):',
                placeholder: '30'
            });
            if (p.isCancel(intervalStr)) return true;
            const intervalSeconds = Number(intervalStr) || 30;

            const selector = await p.text({
                message: 'CSS selector to narrow down monitoring (optional):',
                placeholder: '.ticket-booking-status'
            });
            if (p.isCancel(selector)) return true;

            const headless = await p.confirm({
                message: 'Run browser in headless mode?',
                initialValue: false
            });
            if (p.isCancel(headless)) return true;

            p.note(`Starting Keep-A-Look monitor job...\nURL: ${url}\nWatching: ${condition || 'Any content change'}\nAction: ${action}`, 'Keep-A-Look');

            const { keep_a_look } = await import('./webTools.js');
            try {
                const res = await keep_a_look({
                    url: url.trim(),
                    condition: condition.trim(),
                    action: action.trim(),
                    intervalSeconds,
                    selector: selector.trim() || undefined,
                    headless
                });
                p.note(res, 'Keep-A-Look Done');
            } catch (err) {
                p.log.error(`Keep-A-Look Error: ${err.message}`);
            }

            return true;
        }

        case '/cost': {
            const value = arg.toLowerCase();

            if (value === 'reset') {
                resetCostLedger();
                p.note(pc.yellow('Cost ledger reset for this workspace.'), '💰 Cost');
                return true;
            }

            if (value === 'rebuild') {
                const rebuilt = rebuildLedgerFromSavedSessions();
                const summary = getCostLedgerSummary();
                const header = `Rebuilt ledger from ${rebuilt.sessionsProcessed} saved session(s), estimated ${rebuilt.callsEstimated} AI call(s).`;
                p.note(`${header}\n\n${formatCostLedgerSummary(summary)}\n\n${pc.dim('Note: historical rebuild is an estimate based on saved conversation history.')}`, '💰 Cost');
                return true;
            }

            const summary = getCostLedgerSummary();
            const sessionLine = plannerControls?.costTracker
                ? `Current session: ${plannerControls.costTracker.summary()}`
                : '';

            const body = [
                formatCostLedgerSummary(summary),
                sessionLine
            ].filter(Boolean).join('\n\n');

            p.note(body, '💰 Cost');
            return true;
        }

        case '/help': {
            showSystemMessage('Slash Commands', [
                `${pc.bold('Session')}`,
                `${pc.green('/save <name>')} - Save current session`,
                `${pc.green('/branch <name>')} - Branch current session`,
                `${pc.green('/load <name>')} - Load a saved session`,
                `${pc.green('/history [query]')} - List or search saved sessions`,
                '',
                `${pc.bold('Workflow + Planning')}`,
                `${pc.green('/workflow [name]')} - List or view workflows`,
                `${pc.green('/plan on|off|status|max <n>|reset')} - Planner controls`,
                `${pc.green('/index')} - Re-index the project`,
                '',
                `${pc.bold('Power Commands (Lab)')}`,
                `${pc.green('/toggle <flag>')} - Session settings (debug, quiet, actions, internal-logs, plan)`,
                `${pc.green('/cortex <action>')} - CortexKit (map, hindsight, echo, deja, phantom)`,
                `${pc.green('/swarm <task>')} - Delegate task to background sub-agent`,
                `${pc.bold('Butler & JARVIS Suite')}`,
                `${pc.green('/cursor [on|off|demo|speak]')} - Persistent Rex macOS Screen Cursor (Second Cursor)`,
                `${pc.green('/butler [on|off|briefing|status]')} - Alfred autonomous proactive steward (opt-in)`,
                `${pc.green('/screen [prompt]')} - JARVIS visual screen reasoning via Gemini 3.5 Flash`,
                `${pc.green('/screen voice [prompt]')} - JARVIS visual reasoning with Cartesia speech output`,
                `${pc.green('/cues [on|off]')} - Acoustic feedback cues for agent events`,
                '',
                `${pc.bold('Utilities')}`,
                `${pc.green('/vibes on|off|status')} - Toggle Rex on Vibes personality mode`,
                `${pc.green('/voice <file>')} - Transcribe audio file to text`,
                `${pc.green('/btw <question>')} - Side-channel question unrelated to current execution`,
                `${pc.green('/interrupt-with <request>')} - High-priority interrupt injected into active execution`,
                `${pc.green('/todo [list|add|done|rm|clear]')} - Session todo list`,
                `${pc.green('/peek')} - Quick live status snapshot`,
                `${pc.green('/undo-last')} - Revert latest write/patch change`,
                `${pc.green('/explain-last')} - Explain last execution decision`,
                `${pc.green('/compact')} - Compress conversation history window`,
                `${pc.green('/pin [list|add|rm|clear]')} - Manage pinned notes injected into context`,
                `${pc.green('/diff')} - Show current git diff summary`,
                `${pc.green('/browser')} - List active browser tabs`,
                `${pc.green('/babysit [goal|status|snapshot|stop]')} - Passive teach mode with cursor-follow + yes/no labeling`,
                `${pc.green('/practice mode <goal>')} - Supervised autonomous practice with nano coach`,
                `${pc.green('/keep-a-look')} - Monitor a page for changes and trigger auto-checkout/goals`,
                `${pc.green('/cost [reset|rebuild]')} - Session/workspace AI spend`,
                `${pc.green('/profile save|load <name>')} - Manage config profiles`,
                `${pc.green('/clear')} - Clear terminal screen`,
                `${pc.green('/exit')} - Exit RexAI`,
                `${pc.green('/help')} - Show this help`,
                '',
                `${pc.dim('Context refs: @file:path/to/file  @url:https://...')}`
            ].join('\n'));
            return true;
        }

        case '/exit':
        case '/quit': {
            process.emit('SIGINT');
            return true;
        }

        default:
            return false;
    }
}
