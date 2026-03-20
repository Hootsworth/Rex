import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runCompletion, runCompletionWithTarget, getLocalLlama } from './ai.js';
import { loadConfig, resolveModelAlias } from './config.js';
import {
    brandTheme, accentTheme, emoji, chip, statusLine, kvRow,
    terminalGlyphs, sectionRule, renderFrame, supportsMotion, sleep,
    typewriter, fadeInLine, badge
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

import { read_file, write_file, patch_file, read_dir } from './fsTools.js';
import { run_shell_command } from './shellTools.js';
import { fetch_url_content, open_browser, browser_interact, list_browser_tabs } from './webTools.js';
import { take_snapshot, compare_snapshots } from './regressionTools.js';
import { run_python } from './pythonTools.js';
import { readMemory, remember, forget, syncMemory, pullMemory } from './memory.js';
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

function showSystemMessage(title, body) {
    console.log('');
    const lines = Array.isArray(body) ? body : String(body || '').split('\n');
    console.log(formatChatCard(`System // ${title}`, lines, 'system', 'CONTROL CHANNEL'));
    console.log('');
}

async function showAssistantMessage(body, title = 'Rex') {
    const now = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    console.log('');
    const rawLines = String(body || '').split('\n');
    const lines = [];
    for (const line of rawLines) {
        if (supportsMotion()) {
            const chunks = line.split(/(`[^`]+`)/g).filter(Boolean);
            let rendered = '';
            for (const chunk of chunks) {
                if (chunk.startsWith('`') && chunk.endsWith('`')) {
                    rendered += pc.cyan(chunk);
                } else {
                    rendered += chunk;
                }
            }
            lines.push(rendered);
        } else {
            lines.push(line);
        }
    }
    console.log(formatChatCard(title, lines, 'assistant', `TRANSMISSION ${now}`));
    console.log('');
}

function showActionMessage(toolName, args, thought, execution = null) {
    const taskBadge = execution?.currentTaskId ? pc.dim(` [${execution.currentTaskId}]`) : '';
    const toolEmoji = toolName.includes('browser') ? emoji.globe
        : toolName.includes('file') ? emoji.file
        : toolName.includes('shell') ? emoji.bolt
        : toolName.includes('search') ? emoji.search
        : toolName.includes('git') ? emoji.link
        : emoji.tool;
    
    const lines = [];
    if (args && Object.keys(args).length) {
        const argStr = safePretty(args, 120).replace(/\n/g, ' ');
        lines.push(kvRow('args', argStr, emoji.pin));
    }
    if (thought) {
        lines.push(kvRow('intent', thought.slice(0, 160), emoji.thinking));
    }
    if (!lines.length) lines.push(pc.dim('No arguments supplied.'));

    console.log('');
    console.log(formatChatCard(`${toolEmoji} Tool Dispatch ${toolName}${taskBadge}`, lines, 'action', 'EXECUTION BUS'));
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
    { name: 'browser_interact', desc: 'Interact with a persistent browser. Actions: preflight_analyse, analyze_page, read/extract_text, search, navigate, click, type, hover, screenshot, evaluate, new_tab, switch_tab, list_tabs, close_browser, handle_popups, auth_state, wait_for_auth, back, refresh, babysit_start, babysit_status, babysit_prompt/user_prompt, babysit_snapshot, babysit_stop, practice_mode. Args: {"action": "...", "mode": "headless"} -> mode="headless" triggers background execution. IMPORTANT: analyze_page is for interactable-element scan only; use read/extract_text for page content extraction.', action: async (args, signal) => { const res = await browser_interact(args, signal); return res; } },
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
    { name: 'sync_memory', desc: 'Encrypts and syncs the agent memory to a git remote for team sharing. Args: {"teamSecret": "optional_password"}', action: async (args) => { return syncMemory(args.teamSecret); } },
    { name: 'pull_memory', desc: 'Pulls and decrypts team memory from git remote. Args: {"teamSecret": "optional_password"}', action: async (args) => { return pullMemory(args.teamSecret); } },
    { name: 'autonomous_web_agent', desc: 'Powerful agentic tool that visually controls a browser to perform complex web goals with budget-aware planning. Supports "back" and "refresh" actions for loop recovery. Args: {"goal": "...", "budgetMode": "low|balanced|max-quality|headless", "maxSteps": 24}', action: async (args, signal) => { const { run_autonomous_web_agent } = await import('./webTools.js'); return await run_autonomous_web_agent(args, signal); } },
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
    { name: 'os_agent', desc: 'Windows OS automation action with built-in preflight checks. Args: {"type":"open|focus|move|click|type|hotkey|wait|preflight_analyse", ...}. For open use app="notepad.exe". For hotkey use combo="CTRL+S" (or keys:["control","s"]).', action: async (args) => { const { executeOsAgentAction } = await import('./osAgent.js'); return await executeOsAgentAction(args); } }
];

const FUNNY_SPINNERS = [
    "thinking...",
    "working...",
    "reasoning..."
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
    let planMaxSteps = Number.isFinite(Number(options.planMaxSteps)) && Number(options.planMaxSteps) > 0
        ? Number(options.planMaxSteps)
        : 12;

    console.clear();

    const startupConfig = loadConfig();
    console.log('');
    console.log(renderFrame('REXAI COMMAND DECK', [
        `${emoji.rex}  ${brandTheme('RexAI live terminal cockpit')}`,
        pc.dim('Conversational control surface initialized.'),
        '',
        `${chip(emoji.bolt, 'runtime online', 'success')}    ${chip(emoji.brain, startupConfig.aiModel || 'model auto', 'cool')}    ${chip(emoji.clock, `v${startupConfig.version || '8.0.0'}`, 'brand')}`
    ], { tone: 'brand', icon: emoji.rocket }));
    console.log('');
    console.log(sectionRule(accentTheme('SESSION ONLINE'), 'thick'));
    console.log('');

    // Session flags — only show if non-default
    if (options.debug || options.readonly || planModeEnabled || options.model) {
        console.log('  ' + [
            options.debug ? chip(emoji.eye, 'debug', 'info') : '',
            options.readonly ? chip(emoji.shield, 'readonly', 'danger') : '',
            planModeEnabled ? chip(emoji.brain, `plan:${planMaxSteps}`, 'brand') : '',
            options.model ? chip(emoji.rocket, options.model, 'cool') : ''
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

    if (config.multiModelAgentEnabled && !config.openaiKey) {
        p.note(pc.yellow('Dual-model mode requires an OpenAI key for the runner (gpt-5-mini). Falling back to single-model mode for this session.'), 'System');
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
    const WRITE_TOOLS = ['write_file', 'patch_file', 'run_shell', 'run_python', 'os_agent', 'mouse_click', 'type_text'];
    const OS_GATED_TOOLS = ['os_agent', 'mouse_click', 'type_text'];

    // Abort controller for interrupting AI/Tools
    let abortController = new AbortController();
    let nonActionFollowupCount = 0;

    const handleInterrupt = () => {
        abortController.abort();
        abortController = new AbortController();
        p.note(pc.yellow('↩️ Action interrupted by user.'), 'System');
    };

    process.on('SIGINT', () => {
        if (isAgentIterating) {
            handleInterrupt();
        } else {
            // If at the prompt, default behavior (exit) is fine or we can customize
            process.exit(0);
        }
    });

    while (true) {
        if (costTracker.isBudgetExceeded()) {
            p.note(pc.red(`⚠️ Session budget limit ($${config.sessionBudgetLimit.toFixed(2)}) exceeded. Current cost: $${costTracker.totalCost.toFixed(4)}`), 'Budget Enforcer');
            const extendStr = await p.text({
                message: `Enter amount to extend the budget (or press Enter to halt):`,
                placeholder: '1.00'
            });
            if (p.isCancel(extendStr) || !extendStr.trim()) {
                p.outro(pc.yellow('Session halted due to budget limit.'));
                break;
            } else {
                const added = parseFloat(extendStr);
                if (isNaN(added) || added <= 0) {
                    p.outro(pc.red('Invalid amount. Session halted.'));
                    break;
                }
                config.sessionBudgetLimit += added;
                costTracker.sessionBudgetLimit = config.sessionBudgetLimit;
                p.log.success(pc.green(`Budget extended. New limit is $${config.sessionBudgetLimit.toFixed(2)}`));
            }
        }

        if (!isAgentIterating) {
            userInput = await p.text({
                message: `${badge('INPUT', 'cool')} ${pc.dim(terminalGlyphs().arrow)}`,
                placeholder: '...'
            });
    
            if (p.isCancel(userInput) || !userInput || userInput.trim().toLowerCase() === 'exit') {
                p.note(pc.dim(costTracker.summary()), 'stats');
                saveSession('last-session', historyContext, { topLevelRequest: sessionMeta.topLevelRequest, model: config.aiModel });
                p.outro(pc.dim('session ended.'));
                break;
            }

            // Inline directives: "... /babysit" and "... /practice mode"
            const inlineBabysit = String(userInput || '').match(/^(.*?)\s+\/babysit\b\s*$/i);
            if (inlineBabysit) {
                const goal = String(inlineBabysit[1] || '').trim();
                userInput = `/babysit ${goal}`.trim();
            }

            const inlinePractice = String(userInput || '').match(/^(.*?)\s+\/practice\s+mode\b\s*$/i);
            if (inlinePractice) {
                const goal = String(inlinePractice[1] || '').trim();
                userInput = `/practice mode ${goal}`.trim();
            }

            // Slash commands
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
            });
            if (slashHandled) continue;
            
            // Check if user dropped an image file (Drag-and-Drop Vision Passthrough)
            const droppedImgMatch = userInput.trim().match(/^(?:['"]?)([a-zA-Z]:\\[^"']+\.(?:png|jpg|jpeg|webp|gif)|(?:\/[^"']+\.(?:png|jpg|jpeg|webp|gif)))(?:['"]?)$/i);
            if (droppedImgMatch && fs.existsSync(droppedImgMatch[1])) {
                const { analyzeScreen } = await import('./vision.js');
                p.note(pc.dim(`Analyzing dropped image: ${droppedImgMatch[1]}`), 'Vision');
                const analysisResult = await analyzeScreen(droppedImgMatch[1]);
                if (analysisResult) {
                     // Add the result as context and continue
                     historyContext.push({ role: 'user', content: `[Attached Dropped Image]: ${droppedImgMatch[1]}` });
                     historyContext.push({ role: 'assistant', content: analysisResult });
                }
                continue;
            }

            // Process @file: and @url: references in user input
            userInput = await processContextRefs(userInput);
            
            if (!sessionMeta.topLevelRequest) sessionMeta.topLevelRequest = userInput;
            historyContext.push({ role: 'user', content: userInput });
            if (planModeEnabled && historyContext.filter(m => m.role === 'user').length <= 2) {
                historyContext.push({
                    role: 'user',
                    content: 'Plan mode kickoff: create a concise task list first, then execute step-by-step. If a step fails, create a focused subplan, solve it, and resume the main plan.'
                });
            }
        }

        const s = p.spinner();
        const randS = FUNNY_SPINNERS[Math.floor(Math.random() * FUNNY_SPINNERS.length)];
        s.start(pc.magenta(randS));

        try {
            // Context compression: Keep the most recent messages, summarize everything older
            if (historyContext.length > MAX_HISTORY) {
                // Keep the first turn (usually the goal) and then a sliding window of recent messages
                const firstTurn = historyContext.slice(0, 2);
                const recentWindow = historyContext.slice(-(MAX_HISTORY - 2));
                
                // We could summarize the middle, but for now just sliding window to keep context tight
                historyContext = [...firstTurn, { role: 'system', content: '[... older messages removed for context window ...]' }, ...recentWindow];
            }

            const isLocal = config.aiModel === 'local-llama' || config.aiModel === 'ollama';

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

            // Inject memory + git context
            let memoryContext = '';
            const mem = readMemory();
            if (mem) memoryContext = `\n[PROJECT MEMORY (facts Rex remembers):\n${mem.slice(0, 1500)}]`;

            let gitContext = '';
            if (fs.existsSync(path.join(cwd, '.git'))) {
                try {
                    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                    const status = execSync('git status --short', { cwd, timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().slice(0, 500);
                    const lastCommit = execSync('git log --oneline -3', { cwd, timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                    gitContext = `\n[Git: branch=${branch} | Recent commits: ${lastCommit} | Modified: ${status || 'clean'}]`;
                } catch(e) { /* git might be installed but failing elsewhere */ }
            }

            const osContext = `\n[HOST SYSTEM OS: ${process.platform} (${os.release()})]`;

            // Construct system prompt with tool definitions
            const toolListStr = AVAILABLE_TOOLS.map(t => `- ${t.name}: ${t.desc}`).join('\n');
            const readonlyNotice = options.readonly ? '\n⚠️ READONLY MODE: You MUST NOT use write_file, patch_file, or run_shell. Only read and report.' : '';
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

### PLAN MODE JSON EXTENSIONS
Include these keys when in plan mode:
\`\`\`json
{
    "thought": "brief reasoning grounded in tool output",
    "plan": {
        "objective": "overall objective",
        "tasks": [
            { "id": "T1", "title": "...", "status": "pending|in-progress|done|blocked" }
        ]
    },
    "execution": {
        "mode": "main|subplan",
        "currentTaskId": "T1",
        "note": "what this action does"
    },
    "subplan": {
        "id": "SP-1",
        "parentTaskId": "T2",
        "trigger": "what failed",
        "steps": [
            { "id": "SP1", "title": "...", "status": "pending|in-progress|done|blocked" }
        ]
    },
    "action": { "name": "tool_name", "args": {} }
}
\`\`\`
- Omit \`subplan\` when there is no active issue.
` : '';
            const systemPrompt = `## IDENTITY
You are **Rex**, a powerful agentic AI coding assistant. You reason step-by-step using the ReAct framework and execute exactly one tool per turn.

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

### ✅ CORRECT EXAMPLES
**Example 1 — Web search:**
\`\`\`json
{"thought": "User wants AirPods prices on Amazon. I should use browser_interact with search action.", "action": {"name": "browser_interact", "args": {"action": "search", "query": "AirPods Pro Amazon"}}}
\`\`\`
**Example 2 — Read a file:**
\`\`\`json
{"thought": "I need to check the current config. I'll read the file.", "action": {"name": "read_file", "args": {"filePath": "C:/project/config.json"}}}
\`\`\`
**Example 3 — Self-verify before committing:**
\`\`\`json
{"thought": "I made a big claim. Let me verify it with echo_chamber.", "action": {"name": "echo_chamber", "args": {"claim": "The bug is in line 42", "evidence": "Stack trace shows error at line 42"}}}
\`\`\`

### ❌ COMMON MISTAKES (DO NOT DO THESE)
- ❌ Using \`open_url\` for browsing tasks → Use \`browser_interact\` with \`action: "navigate"\` or \`"search"\`
- ❌ Inventing a tool called \`"search"\` → No such standalone tool. Use \`browser_interact\` with \`{action: "search"}\`
- ❌ Using \`analyze_page\` to extract text/recipes → Use \`extract_text\` or \`read\` action instead
- ❌ Guessing URLs without searching → Always search DuckDuckGo first if unsure
- ❌ Hallucinating file contents → Always \`read_file\` first

## TOOLS — Available actions
[IMPORTANT] Your tools:
${toolListStr}

### Tool Priority Rules
[CRITICAL] Default to **local tools** (read_file, write_file, patch_file, run_shell, run_python) for coding tasks.
[CRITICAL] Use **browser tools** ONLY for web navigation, website interaction, or visual website actions.
[IMPORTANT] For interactive browsing, use \`browser_interact\` — NOT \`open_url\` (which launches an uncontrolled external browser).
[IMPORTANT] Use \`run_shell\` for system tasks (disk, RAM, processes, network).
[NICE-TO-HAVE] Use \`deja_vu\` at the start of complex tasks to check for past lessons.
[NICE-TO-HAVE] Use \`hindsight\` after completing complex tasks to save lessons.
[NICE-TO-HAVE] Use \`phantom_run\` before executing multi-step file changes to validate the plan.

### Browser Rules
[CRITICAL] \`open_url\` is NOT controllable. Use \`browser_interact\` for all browsing workflows.
[IMPORTANT] Look at numeric IDs in brackets (e.g. [12]) and use those for clicking/typing.
[IMPORTANT] If a page is blank or broken, try "refresh" or "back".
[IMPORTANT] If you hit a login screen, tell the user or use "wait_for_auth".

## CONTEXT
${projectContext}${memoryContext}${gitContext}${osContext}${readonlyNotice}
${projectIndex ? projectIndex : ''}
${attachContext ? attachContext : ''}
${plannerContext}
${buildDeepContext({ recentToolResults })}

## CONSTRAINTS
[CRITICAL] No Hallucinations — never invent file contents, terminal outputs, or website data.
[CRITICAL] Absolute Paths — always use full absolute paths.
[CRITICAL] One Action — never try to run two tools at once.
[IMPORTANT] Reporting — if you just ran a tool, report findings in plain text before the next JSON block.
${planModeRules}
`;

            // Prepare messages for the AI
            const messages = [
                { role: 'system', content: systemPrompt },
                ...historyContext
            ];

            // Debug mode: show stats
            if (options.debug) {
                p.note(pc.dim(`[DEBUG] History Turns: ${historyContext.length} | System Prompt size: ${systemPrompt.length} chars`), pc.bgYellow(pc.black(' DEBUG ')));
            }

            let responseText;
            try {
                responseText = await getAgentResponse(messages, isLocal, abortController.signal, {
                    config,
                    roleHint: isAgentIterating ? 'runner' : 'planner'
                });
            } catch (err) {
                s.stop();
                if (err.name === 'AbortError' || err.message === 'Aborted') {
                    isAgentIterating = false;
                    continue;
                }
                throw err;
            }
            s.stop();

            // Cost tracking
            const costLine = costTracker.track(config.aiModel, systemPrompt, responseText);
            if (options.debug) {
                console.log(costLine);
            }

            // Try to parse tool call
            let toolMatch;
            let planMatch;
            let toolArgs;
            let flavorText = '';
            let parsedPayload = null;

            try {
                let jsonStr = responseText.trim();
                
                // 1. Precise Markdown Block Extraction
                const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/i;
                const blockMatch = jsonStr.match(codeBlockRegex);
                
                if (blockMatch) {
                    jsonStr = blockMatch[1].trim();
                } else {
                    // 2. Fallback: Find the first '{' and the last '}' to handle nesting and flavor text
                    const start = jsonStr.indexOf('{');
                    const end = jsonStr.lastIndexOf('}');
                    
                    if (start !== -1 && end !== -1 && end > start) {
                        flavorText = jsonStr.substring(0, start).trim();
                        jsonStr = jsonStr.substring(start, end + 1);
                    }
                }

                if (jsonStr) {
                    const maybeJson = JSON.parse(jsonStr);
                    if (maybeJson) {
                        parsedPayload = maybeJson;
                        planMatch = maybeJson.thought || maybeJson.plan || '';
                        
                        // Handle nested action object: { "action": { "name": "...", "args": { ... } } }
                        if (typeof maybeJson.action === 'object' && maybeJson.action !== null) {
                            toolMatch = maybeJson.action.name;
                            toolArgs = maybeJson.action.args || {};
                        } 
                        // Handle flat structure: { "action": "...", "args": { ... } }
                        else if (typeof maybeJson.action === 'string') {
                            toolMatch = maybeJson.action;
                            toolArgs = maybeJson.args || {};
                        }
                        // Handle OpenAI tool-call mirror payload: { "tool_calls": [{"function":{"name":"...","arguments":"{...}"}}] }
                        else if (Array.isArray(maybeJson.tool_calls) && maybeJson.tool_calls.length > 0) {
                            const firstCall = maybeJson.tool_calls[0];
                            const fn = firstCall?.function || firstCall;
                            if (fn?.name) {
                                toolMatch = String(fn.name);
                                toolArgs = parseMaybeJsonArgs(fn.arguments || fn.args || {});
                            }
                        }
                    }
                }
            } catch (e) {
                // Not a valid tool call or parsing failed
            }

            if (!toolMatch) {
                const fallbackAction = extractActionFromFreeform(responseText);
                if (fallbackAction?.name) {
                    toolMatch = fallbackAction.name;
                    toolArgs = fallbackAction.args || {};
                    planMatch = planMatch || fallbackAction.thought || '';
                    if (showInternalToolLogs) {
                        p.note(pc.yellow('Recovered tool action from freeform assistant output.'), 'Parser');
                    }
                }
            }

            if (toolMatch) {
                const normalized = normalizeToolSelection(toolMatch, toolArgs || {});
                toolMatch = normalized.toolName;
                toolArgs = normalized.toolArgs || {};
                if (normalized.note && showInternalToolLogs) {
                    p.note(pc.yellow(normalized.note), 'Tool Normalizer');
                }

                // Guardrail: interactive web tasks must stay in controllable browser_interact session.
                if (toolMatch === 'open_url' && isInteractiveWebTask(sessionMeta.topLevelRequest)) {
                    if (showInternalToolLogs) {
                        p.note(pc.yellow('Auto-correct: switched open_url to browser_interact navigate for controllable web interaction.'), 'Guardrail');
                    }
                    toolMatch = 'browser_interact';
                    toolArgs = {
                        action: 'navigate',
                        url: toolArgs?.url || ''
                    };
                }
            }

            if (planModeEnabled && parsedPayload) {
                updatePlannerStateFromPayload(plannerState, parsedPayload);
            }

            if (toolMatch) {
                // Display flavor text (reporting) if provided before the tool call
                if (flavorText) {
                    await showAssistantMessage(flavorText, 'Rex Report');
                }

                const toolDef = AVAILABLE_TOOLS.find(t => t.name === toolMatch);
                if (toolDef) {
                    // Premium UI for Tool Planning
                    if (showInternalToolLogs) {
                        console.log(''); // Spacer
                        showActionMessage(toolMatch, toolArgs, String(planMatch || '').trim(), parsedPayload?.execution);
                    }
                    
                    let proceed = false;
                    
                    const maxAutoSteps = planModeEnabled ? planMaxSteps : 10;
                    if (config.agentPermission === 'auto-pilot' && autoPilotCount < maxAutoSteps) {
                        const stepNumber = autoPilotCount + 1;
                        logAutoPilotEvent('Auto-Pilot engaged. Proceeding autonomously.', {
                            step: stepNumber,
                            maxSteps: maxAutoSteps,
                            tool: toolMatch,
                            action: toolArgs?.action || null
                        });
                        if (config.showAutoPilotProgressLogs) {
                            console.log(statusLine(emoji.bolt, 'Auto-Pilot active', `${stepNumber}/${maxAutoSteps}`, 'brand'));
                        }
                        proceed = true;
                        autoPilotCount++;

                        // Failsafe Mesh: Confidence Gating — pause on uncertain language
                        if (planMatch && /\b(maybe|i think|not sure|unsure|possibly|might be wrong|i guess|unclear)\b/i.test(planMatch)) {
                            console.log(statusLine(emoji.warn, 'Confidence Gate', 'Rex seems uncertain', 'warning'));
                            proceed = await p.confirm({ message: pc.cyan('Rex seems unsure. Proceed anyway?') });
                            if (p.isCancel(proceed)) proceed = false;
                        }
                    } else {
                        if (autoPilotCount >= maxAutoSteps) {
                            logAutoPilotEvent('Auto-Pilot paused. Human review required.', {
                                maxSteps: maxAutoSteps,
                                tool: toolMatch,
                                action: toolArgs?.action || null,
                                reason: 'max_steps_reached'
                            });
                        if (config.showAutoPilotProgressLogs) {
                            console.log(statusLine(emoji.warn, 'Auto-Pilot paused', `${maxAutoSteps} steps reached`, 'warning'));
                        }
                            autoPilotCount = 0; 
                        }
                        
                        const stepDesc = isAgentIterating ? "next step" : "first step";
                        proceed = await p.confirm({
                            message: pc.cyan(`Rex is ready for the ${stepDesc}. Proceed?`)
                        });
                    }

                    if (!p.isCancel(proceed) && proceed) {
                        let preflightSummary = '';

                        // Guardrail: when user asks for textual content, avoid analyze_page loops.
                        if (toolMatch === 'browser_interact') {
                            const browserAction = String(toolArgs?.action || '').toLowerCase();
                            if (browserAction === 'analyze_page' && isLikelyContentRequest(sessionMeta.topLevelRequest)) {
                                if (showInternalToolLogs) {
                                    console.log(statusLine(emoji.spark, 'Auto-Correction', 'analyze_page -> extract_text', 'info'));
                                }
                                toolArgs = { ...toolArgs, action: 'extract_text' };
                            }

                            if ((browserAction === 'extract_text' || browserAction === 'read') && !toolArgs?.query) {
                                toolArgs = { ...toolArgs, query: sessionMeta.topLevelRequest };
                            }
                        }

                        // Proprietary browser reliability guard: run Preflight Analyse before risky actions.
                        if (toolMatch === 'browser_interact') {
                            const browserAction = String(toolArgs?.action || '').toLowerCase();
                            const riskyBrowserActions = new Set(['click', 'type', 'hover', 'evaluate']);

                            if (riskyBrowserActions.has(browserAction) && !toolArgs.skipPreflight) {
                                try {
                                    const preflightResult = await toolDef.action({
                                        action: 'preflight_analyse',
                                        targetAction: browserAction,
                                        autoHeal: true,
                                        query: toolArgs.query,
                                        text: toolArgs.text
                                    }, abortController.signal);

                                    preflightSummary = String(preflightResult).slice(0, 1200);
                                    if (showInternalToolLogs) {
                                        console.log(statusLine(emoji.shield, 'Preflight', 'Browser health verified', 'success'));
                                    }
                                } catch (preflightErr) {
                                    if (showInternalToolLogs) {
                                        console.log(statusLine(emoji.warn, 'Preflight', preflightErr.message, 'warning'));
                                    }
                                }
                            }
                        }

                        // Stuck detection: same tool+args 3x in a row
                        const currentToolKey = `${toolMatch}:${JSON.stringify(toolArgs)}`;
                        if (currentToolKey === lastToolKey) {
                            stuckCount++;
                            if (stuckCount >= 3) {
                                if (showInternalToolLogs) {
                                    console.log(statusLine(emoji.cross, 'STUCK DETECTED', 'Loop prevented', 'danger'));
                                }
                                logToolCall(toolMatch, toolArgs, 'STUCK (loop detected)', 'stuck');
                                historyContext.push({ role: 'assistant', content: `[STUCK: Tried ${toolMatch} 3 times with same args — need different approach]` });
                                if (planModeEnabled) {
                                    plannerState.issueCounter += 1;
                                    isAgentIterating = true;
                                    userInput = `Planning issue detected: repeated loop on ${toolMatch} with same arguments. Create/update a subplan with a different approach and execute a different next action.`;
                                    historyContext.push({ role: 'user', content: userInput });
                                } else {
                                    isAgentIterating = false;
                                }
                                stuckCount = 0;
                                lastToolKey = '';
                                continue;
                            }
                        } else {
                            stuckCount = 1;
                            lastToolKey = currentToolKey;
                        }

                        const engineOutcome = await runActionEngine({
                            toolName: toolMatch,
                            toolArgs,
                            sessionMeta,
                            historyContext,
                            runtime: {
                                options: { readonly: !!options.readonly },
                                toolPermissions,
                                isToolAllowed,
                                writeTools: WRITE_TOOLS,
                                osGatedTools: OS_GATED_TOOLS,
                                state: actionEngineState
                            },
                            confirm: async (risk) => {
                                const ok = await p.confirm({
                                    message: pc.yellow(risk.reason),
                                    initialValue: false
                                });

                                if (risk.code === 'os_access_gate') {
                                    if (!p.isCancel(ok) && ok) {
                                        console.log(statusLine(emoji.check, 'OS Access', 'Approved for session', 'success'));
                                    } else {
                                        console.log(statusLine(emoji.cross, 'OS Access', 'Denied by user', 'danger'));
                                    }
                                }

                                return !p.isCancel(ok) && !!ok;
                            },
                            execute: async () => {
                                let attempts = 0;
                                const MAX_RETRIES = 3;

                                while (attempts < MAX_RETRIES) {
                                    try {
                                        let result;
                                        if (Object.keys(toolArgs).length > 0) {
                                            if (toolMatch === 'delegate_task') {
                                                result = await toolDef.action(toolArgs, isLocal, abortController.signal);
                                            } else {
                                                // Pass signal if tool supports it (like browser_interact)
                                                result = await toolDef.action(toolArgs, abortController.signal);
                                            }
                                        } else {
                                            result = await toolDef.action();
                                        }
                                        return { result, retries: attempts };
                                    } catch (toolErr) {
                                        if (toolErr.name === 'AbortError' || toolErr.message === 'Aborted') {
                                            throw toolErr;
                                        }
                                        attempts++;
                                        if (attempts >= MAX_RETRIES) {
                                            throw new Error(`Tool failed after ${MAX_RETRIES} attempts: ${toolErr.message}`);
                                        }
                                            if (showInternalToolLogs) {
                                                console.log(statusLine(emoji.warn, 'Tool Error', `Retrying ${attempts}/${MAX_RETRIES}`, 'warning'));
                                            }
                                    }
                                }

                                throw new Error('Unexpected execution state.');
                            }
                        });

                        if (engineOutcome.status === 'blocked') {
                            if (showInternalToolLogs) {
                                console.log(statusLine(emoji.shield, 'BLOCKED', toolMatch, 'danger'));
                            }
                            logToolCall(toolMatch, toolArgs, `BLOCKED (${engineOutcome.risk.code})`, 'blocked');
                            historyContext.push({ role: 'assistant', content: `[BLOCKED: ${toolMatch} — ${engineOutcome.risk.reason}]` });
                            if (planModeEnabled) {
                                plannerState.issueCounter += 1;
                                isAgentIterating = true;
                                userInput = `Planning issue detected: tool ${toolMatch} was blocked (${engineOutcome.risk.reason}). Create or update a subplan to resolve this blocker using allowed tools, execute one step now, then return to the parent task ${plannerState.activeTaskId || 'when unblocked'}.`;
                                historyContext.push({ role: 'user', content: userInput });
                            } else {
                                isAgentIterating = false;
                            }
                            continue;
                        }

                        if (engineOutcome.status === 'cancelled') {
                            logToolCall(toolMatch, toolArgs, `CANCELLED (${engineOutcome.risk.code})`, 'blocked');
                            historyContext.push({ role: 'assistant', content: `[CANCELLED: ${toolMatch} requires confirmation]` });
                            isAgentIterating = false;
                            continue;
                        }

                        const result = engineOutcome.result;
                        const retryCount = Number(engineOutcome.retries || 0);
                        const toolSucceeded = engineOutcome.status === 'success';

                        // DeepContext: track recent tool outcomes for situational awareness
                        recentToolResults.push({ tool: toolMatch, args: toolArgs, result: String(result || '').slice(0, 200) });
                        if (recentToolResults.length > 5) recentToolResults.shift();

                        // Failsafe Mesh: rollback checkpoint before destructive file writes
                        if ((toolMatch === 'write_file' || toolMatch === 'patch_file') && toolArgs.filePath) {
                            try {
                                const checkpointDir = path.join(process.cwd(), '.agent', 'checkpoints');
                                if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true });
                                const src = toolArgs.filePath;
                                if (fs.existsSync(src)) {
                                    const bakName = path.basename(src) + '.bak';
                                    fs.copyFileSync(src, path.join(checkpointDir, bakName));
                                }
                            } catch {}
                        }

                        // Audit log
                        logToolCall(toolMatch, toolArgs, result, toolSucceeded ? 'success' : 'error');

                        // Diff view for patch_file
                        if (toolMatch === 'patch_file' && toolArgs.targetContent && toolArgs.replacementContent) {
                            const diffLines = [];
                            toolArgs.targetContent.split('\n').forEach(l => diffLines.push(pc.red(`  - ${l}`)));
                            toolArgs.replacementContent.split('\n').forEach(l => diffLines.push(pc.green(`  + ${l}`)));
                            if (showInternalToolLogs) {
                                console.log(`\n  ${emoji.paint}  ${brandTheme('DIFF VIEW')}\n${pc.dim('  ' + terminalGlyphs().line.repeat(40))}\n${diffLines.join('\n')}\n`);
                            }
                        }

                        let confirmationMsg = `[I ran the ${toolMatch} tool. Thought: ${planMatch}]`;
                        if (preflightSummary) {
                            confirmationMsg += `\nPreflight Analyse:\n${preflightSummary}`;
                        }
                        if (result) {
                            const truncated = String(result).length > 3000 ? String(result).slice(0, 3000) + '\n...[output truncated]' : result;
                            confirmationMsg += `\nOutput from tool:\n${truncated}`;
                        }
                        
                        historyContext.push({ role: 'assistant', content: confirmationMsg });
                        autoPilotCount = (config.agentPermission === 'auto-pilot') ? autoPilotCount : 0;
                                                nonActionFollowupCount = 0;
                        isAgentIterating = true;

                        if (planModeEnabled) {
                            if (toolSucceeded) plannerState.issueCounter = 0;
                            const doneCount = plannerState.main.tasks.filter(t => t.status === 'done').length;
                            const totalCount = plannerState.main.tasks.length;
                            const subplanStatus = plannerState.activeSubplan
                                ? ` | Subplan: ${plannerState.activeSubplan.id}`
                                : '';
                            if (showInternalToolLogs) {
                                console.log(statusLine(emoji.map, 'Progress', `${doneCount}/${totalCount} tasks done${subplanStatus}`, 'cool'));
                            }
                        }
                        
                        const toolFailed = !toolSucceeded || String(result || '').startsWith('Tool error after');
                        const resultText = String(result || '');
                        const weakAutonomousCompletion = toolMatch === 'autonomous_web_agent'
                            && /goal achieved/i.test(resultText)
                            && isLikelyContentRequest(sessionMeta.topLevelRequest)
                            && !hasConcreteAnswerShape(resultText);

                        if (planModeEnabled && toolFailed) {
                            plannerState.issueCounter += 1;
                            if (plannerState.issueCounter > 3) {
                                console.log(statusLine(emoji.cross, 'Planner', 'Healing failed (3 attempts)', 'danger'));
                                isAgentIterating = false;
                                plannerState.issueCounter = 0;
                            } else {
                                userInput = `Planning issue detected (Healing attempt ${plannerState.issueCounter}/3): ${toolMatch} failed. Build or update a subplan to fix this specific issue, execute the first subplan step now, and after resolution continue the parent main-plan task ${plannerState.activeTaskId || ''}.`;
                                if (config.showAutoPilotProgressLogs) {
                                    console.log(statusLine(emoji.paint, 'Planner', `Healing attempt ${plannerState.issueCounter}/3`, 'warning'));
                                }
                            }
                        } else if (weakAutonomousCompletion) {
                            userInput = `The autonomous_web_agent response is meta-level but missing concrete extracted data. Do NOT call analyze_page. Use browser_interact with action extract_text on the current page, then return the final answer as a clear bullet list with all requested items.`;
                        } else if (planModeEnabled) {
                            userInput = `Tool result captured for ${toolMatch}. Briefly report findings, update plan/subplan statuses, and execute the next best step. If all main tasks are done, finish normally without JSON.`;
                        } else {
                            userInput = `The ${toolMatch} tool output was received. Report your findings. If the goal "${sessionMeta.topLevelRequest}" is completely finished, reply normally without any JSON tool call to end the process. Otherwise, move to the next step.`;
                        }
                        historyContext.push({ role: 'user', content: userInput });
                        continue;
                    } else {
                        p.note(pc.red(`Action cancelled by user.`), REX_PERSONA);
                        historyContext.push({ role: 'assistant', content: `[User cancelled my plan to run ${toolMatch}]` });
                        autoPilotCount = 0; 
                        isAgentIterating = false;
                    }
                } else {
                    p.note(pc.red(`Rex tried to run a tool called [${toolMatch}] but couldn't find it. Intern mistake!`), REX_PERSONA);
                    historyContext.push({ role: 'assistant', content: `[I hallucinated a tool called ${toolMatch}]` });
                    isAgentIterating = false;
                }
            } else {
                const midExecutionNoAction = isAgentIterating && !looksLikeCompletion(responseText);
                await showAssistantMessage(responseText, REX_PERSONA);
                historyContext.push({ role: 'assistant', content: responseText });

                // Only force follow-up tool nudges in explicit planner mode.
                // In normal chat mode, treat a plain-text response as final and return control to user.
                if (planModeEnabled && midExecutionNoAction && nonActionFollowupCount < 2) {
                    nonActionFollowupCount += 1;
                    const nudge = 'You are still in execution mode and the task is not complete. Respond with a JSON tool action for the next concrete step. If web search is needed, use browser_interact with {"action":"search","query":"..."}.';
                    historyContext.push({ role: 'user', content: nudge });
                    isAgentIterating = true;
                    continue;
                }

                nonActionFollowupCount = 0;
                autoPilotCount = 0; 
                isAgentIterating = false;
            }

        } catch (err) {
            s.stop();
            if (err.name === 'AbortError' || err.message === 'Aborted') {
                isAgentIterating = false;
                continue;
            }
            p.log.error(pc.red(`Rex crashed: ${err.message}`));
        }
    }
}

/**
 * Handoff: Uses Local LLM if configured, otherwise falls back to standard LLM via runCompletion
 */
function resolveAgentTarget(config, roleHint = 'runner') {
    if (!config?.multiModelAgentEnabled) return null;

    if (roleHint === 'runner') {
        return {
            provider: String(config.agentRunnerProvider || 'openai').toLowerCase(),
            model: config.agentRunnerModel || 'gpt-5-mini'
        };
    }

    const selected = resolveModelAlias(config.aiModel || '');
    if (selected === 'gemini') {
        return {
            provider: 'gemini',
            model: config.agentPlannerGeminiModel || 'gemini-2.5-flash'
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
async function handleSlashCommand(input, historyContext, config, sessionMeta, plannerControls = null) {
    if (!input.startsWith('/')) return false;

    const [cmdInput, ...args] = input.split(' ');
    const cmd = cmdInput.toLowerCase();
    const arg = args.join(' ').trim();

    switch (cmd) {
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
            } else {
                p.note(pc.yellow('Usage: /memory sync | /memory pull'), 'Memory');
            }
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
                `${pc.cyan('/save <name>')} - Save current session`,
                `${pc.cyan('/branch <name>')} - Branch current session`,
                `${pc.cyan('/load <name>')} - Load a saved session`,
                `${pc.cyan('/history [query]')} - List or search saved sessions`,
                '',
                `${pc.bold('Workflow + Planning')}`,
                `${pc.cyan('/workflow [name]')} - List or view workflows`,
                `${pc.cyan('/plan on|off|status|max <n>|reset')} - Planner controls`,
                `${pc.cyan('/index')} - Re-index the project`,
                '',
                `${pc.bold('Utilities')}`,
                `${pc.cyan('/voice <file>')} - Transcribe audio file to text`,
                `${pc.cyan('/browser')} - List active browser tabs`,
                `${pc.cyan('/babysit [goal|status|snapshot|stop]')} - Passive teach mode with cursor-follow + yes/no labeling`,
                `${pc.cyan('/practice mode <goal>')} - Supervised autonomous practice with nano coach`,
                `${pc.cyan('/cost [reset|rebuild]')} - Session/workspace AI spend`,
                `${pc.cyan('/profile save|load <name>')} - Manage config profiles`,
                `${pc.cyan('/clear')} - Clear terminal screen`,
                `${pc.cyan('/exit')} - Exit RexAI`,
                `${pc.cyan('/help')} - Show this help`,
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
