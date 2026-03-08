import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { runCompletion, getLocalLlama } from './ai.js';
import { loadConfig } from './config.js';

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
import { run_python } from './pythonTools.js';
import { readMemory, remember, forget } from './memory.js';
import { logToolCall } from './auditLog.js';
import { CostTracker, estimateTokens, getCostLedgerSummary, formatCostLedgerSummary, resetCostLedger, rebuildLedgerFromSavedSessions } from './costMeter.js';
import { loadToolPermissions, isToolAllowed } from './toolPermissions.js';
import { saveSession, loadSession, listSessions, searchSessions } from './sessions.js';
import { listWorkflows, loadWorkflow, createSampleWorkflow } from './workflows.js';
import { saveProfile, loadProfile, listProfiles } from './profiles.js';
import { indexProject, getIndexSummary } from './indexer.js';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

const theme = gradient(['#00b4d8', '#0077b6', '#023e8a']);
const REX_PERSONA = pc.magenta('Rex (Intern)');

function sectionHeader(label) {
    const line = '─'.repeat(20);
    return pc.dim(`${line} ${label} ${line}`);
}

function supportsUnicode() {
    if (process.env.TERM === 'dumb') return false;
    return !!process.stdout.isTTY;
}

function chatGlyphs() {
    if (supportsUnicode()) {
        return { line: '─', side: '│', topL: '╭', topR: '╮', botL: '╰', botR: '╯', arrow: '➜' };
    }
    return { line: '-', side: '|', topL: '+', topR: '+', botL: '+', botR: '+', arrow: '>' };
}

function wrapLines(text = '', width = 84) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (const line of lines) {
        if (line.length <= width) {
            out.push(line);
            continue;
        }
        let remaining = line;
        while (remaining.length > width) {
            out.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
        }
        if (remaining.length) out.push(remaining);
    }
    return out;
}

function formatChatCard(title, body, tone = 'default') {
    const g = chatGlyphs();
    const width = 92;
    const colors = {
        default: (s) => s,
        assistant: (s) => gradient.pastel(s),
        system: (s) => pc.cyan(s),
        warning: (s) => pc.yellow(s),
        error: (s) => pc.red(s),
        action: (s) => pc.magenta(s)
    };
    const titleStyled = (colors[tone] || colors.default)(title);
    const top = pc.dim(`${g.topL}${g.line.repeat(width - 2)}${g.topR}`);
    const bottom = pc.dim(`${g.botL}${g.line.repeat(width - 2)}${g.botR}`);
    const header = `${g.side} ${pc.bold(titleStyled).padEnd(width - 4)} ${g.side}`;
    const bodyLines = wrapLines(body, width - 4).map((line) => `${g.side} ${line.padEnd(width - 4)} ${g.side}`);
    return [top, header, ...bodyLines, bottom].join('\n');
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
    console.log(`\n${formatChatCard(title, body, 'system')}`);
}

function showAssistantMessage(body, title = 'Rex') {
    console.log(`\n${formatChatCard(title, body, 'assistant')}`);
}

function showActionMessage(toolName, args, thought, execution = null) {
    const mode = execution?.mode ? `\nMode: ${execution.mode}` : '';
    const task = execution?.currentTaskId ? `\nTask: ${execution.currentTaskId}` : '';
    const segments = [
        thought ? `Thought:\n${thought}` : 'Thought: (none)',
        `Tool: ${toolName}`,
        `Args:\n${safePretty(args)}`,
        `${mode}${task}`.trim()
    ].filter(Boolean);
    console.log(`\n${formatChatCard('Action Plan', segments.join('\n\n'), 'action')}`);
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
    { name: 'browser_interact', desc: 'Interact with a persistent browser. Actions: preflight_analyse, analyze_page, read/extract_text, search, navigate, click, type, hover, screenshot, evaluate, new_tab, switch_tab, list_tabs, close_browser, handle_popups, auth_state, wait_for_auth, back, refresh. IMPORTANT: analyze_page is for interactable-element scan only; use read/extract_text for page content extraction.', action: async (args, signal) => { const res = await browser_interact(args, signal); return res; } },
    { name: 'run_python', desc: 'Execute secure Python code for math or data tasks. Args: {"code": "print(1+1)"}', action: async (args) => { const res = await run_python(args.code); return res; } },
    { name: 'delegate_task', desc: 'Spawn a sub-Rex agent to handle a sub-task. Args: {"subtask": "description"}', action: async (args, signal) => { 
        p.note(`Spawning sub-agent for: ${args.subtask}`, 'Rex Orchestrator');
        const messages = [{ role: 'user', content: `You are a sub-agent Rex. Complete this specific task: ${args.subtask}. Return only the result.` }];
        const isLocal = loadConfig().aiModel === 'local-llama' || loadConfig().aiModel === 'ollama';
        const res = await getAgentResponse(messages, isLocal, signal);
        return res;
    } },
    { name: 'remember', desc: 'Save a fact to persistent project memory. Args: {"fact": "This project uses React 18"}', action: async (args) => { return remember(args.fact); } },
    { name: 'forget', desc: 'Remove a fact from project memory by keyword. Args: {"keyword": "React"}', action: async (args) => { return forget(args.keyword); } },
    { name: 'autonomous_web_agent', desc: 'Powerful agentic tool that visually controls a browser to perform complex web goals. Supports "back" and "refresh" actions for loop recovery. Args: {"goal": "..."}', action: async (args, signal) => { const { run_autonomous_web_agent } = await import('./webTools.js'); return await run_autonomous_web_agent(args.goal, signal); } },
    { name: 'get_system_info', desc: 'Get deep hardware and OS telemetry (CPU, RAM, Battery, etc.)', action: getSystemInfo },
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
    { name: 'type_text', desc: 'Simulate typing text into the active window (Windows). Args: {"text": "..."}', action: async (args) => { const { typeText } = await import('./gui.js'); return await typeText(args.text); } }
];

const FUNNY_SPINNERS = [
    "Rex is thinking...",
    "Rex is writing...",
    "Rex is coding...",
    "Rex thinks its coding...",
    "Rex is deciphering your intent...",
    "Rex is drinking coffee...",
    "Rex is wondering why he took this internship...",
    "Rex is digging through bytes...",
    "Rex is contemplating the meaning of life...",
    "Rex is pretending to read the docs..."
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

export async function startAgentChat(options = {}) {
    let planModeEnabled = !!options.plan;
    let planMaxSteps = Number.isFinite(Number(options.planMaxSteps)) && Number(options.planMaxSteps) > 0
        ? Number(options.planMaxSteps)
        : 12;

    console.clear();
    const intros = ['🦖', '🛰️', '💎', '🚀'];
    const introEmoji = intros[Math.floor(Math.random() * intros.length)];
    
    p.intro(theme(`${introEmoji} REXAI ADVANCED AGENTIC CHAT `) + pc.dim(`v${loadConfig().version || '7.0.0'}`));
    console.log(sectionHeader('Agent Session'));
    
    const badges = [];
    if (options.debug) badges.push(pc.bgYellow(pc.black(' DEBUG ')));
    if (options.readonly) badges.push(pc.bgRed(pc.white(' READONLY ')));
    if (planModeEnabled) badges.push(pc.bgBlue(pc.white(` PLAN MODE ${planMaxSteps} `)));
    if (options.model) badges.push(pc.bgCyan(pc.black(` MODEL: ${options.model} `)));
    const badgeStr = badges.length ? ' ' + badges.join(' ') : '';
    showSystemMessage('Session Ready', `${pc.dim('Type your request naturally. Rex can run tools, edit files, and search the web.')}${badgeStr}`);

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
        const { resolveModelAlias } = await import('./config.js');
        config.aiModel = resolveModelAlias(options.model);
    }
    let historyContext = [];
    const MAX_HISTORY = 30; // Increased from 6
    let isAgentIterating = false;
    const sessionMeta = { topLevelRequest: '' };
    let autoPilotCount = 0;
    let userInput = '';
    const plannerState = createPlannerState();

    // Sprint 2 features
    const costTracker = new CostTracker();
    const toolPermissions = loadToolPermissions();
    let lastToolKey = '';    // for stuck detection
    let stuckCount = 0;      // consecutive same-tool calls

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
    const WRITE_TOOLS = ['write_file', 'patch_file', 'run_shell', 'browser_interact', 'run_python'];

    // Abort controller for interrupting AI/Tools
    let abortController = new AbortController();

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
        if (!isAgentIterating) {
            userInput = await p.text({
                message: `${pc.cyan('You')} ${pc.dim(chatGlyphs().arrow)}`,
                placeholder: 'Type a request or "exit"...'
            });
    
            if (p.isCancel(userInput) || !userInput || userInput.trim().toLowerCase() === 'exit') {
                // Show session cost on exit
                p.note(costTracker.summary(), 'Session Stats');
                // Automatically save session as "last-session"
                saveSession('last-session', historyContext, { topLevelRequest: sessionMeta.topLevelRequest, model: config.aiModel });
                p.outro(theme('Rex is clocking out. See ya!'));
                break;
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
            const systemPrompt = `You are Rex, a powerful agentic AI coding assistant. You operate using a strict ReAct (Reasoning and Acting) framework.

### 🧠 CORE FRAMEWORK: ReAct
For every turn, you MUST follow this structure:
1. **Thought**: Analyze the user's request, look at your previous actions and their results, and plan your next move.
   - **FAILURE ANALYSIS**: If your previous action didn't work as expected, you MUST explain WHY and VOW to try a different approach.
   - **FACTUAL ANCHORING**: You MUST anchor your findings to the data returned by tools. Do NOT hallucinate data. If a tool returns "0% rain", your thought must reflect "The tool reports 0% rain", not "It might rain soon".
   - **CONTRADICTION CHECK**: Proactively check if your plan contradicts the information provided in the tool output.
2. **Action**: Choose exactly ONE tool and provided valid JSON arguments for it. 
    - **STUCK DETECTION**: If you see you've tried the same thing 3 times without success, you MUST pivot with a different tool or approach.

### 🧰 TOOL STRATEGY (IMPORTANT)
- Default to **non-browser tools** for coding/dev tasks (files, git, shell, tests, docs, SQL, translation, scaffolding, etc.).
- Use browser tools ONLY when the user explicitly needs web navigation, website interaction, login/auth web flows, or visual website actions.
- For git and normal local development workflows, prefer local tools (run_shell, read_file, patch_file, github_push, etc.) over browser actions.
- For local machine tasks (RAM/CPU/disk checks, process checks, restart/shutdown/sleep, network checks), use run_shell when permissions allow.
- Do NOT refuse local machine tasks by default. Execute via tools first; only fall back to instructions if blocked by readonly mode, permissions, missing binaries, or explicit user safety constraints.

### 🌐 BROWSER POWER-USER NOTES
- **Preflight Analyse (Proprietary)**: Before risky actions (click/type/hover/evaluate), run \`browser_interact\` with \`action: "preflight_analyse"\` to validate browser health and auto-heal blank pages.
- **Correct Tool for Content**: \`analyze_page\` returns UI interaction scan, not article/recipe text. Use \`read\` or \`extract_text\` when user asks for ingredients, steps, prices, summaries, or any textual extraction.
- **Visual Markers**: When using the browser agent, look at the numeric IDs in brackets (e.g., [12]). Use these IDs for clicking and typing.
- **Escape Routes**: If a page is empty, broken, or has a blocking overlay, try "refresh" or "back".
- **Search First**: Don't guess URLs. Search DuckDuckGo first if you are unsure of the site.
- **Auth Walls**: If you hit a login screen, tell the user you are waiting, or use "wait_for_auth".

### 📋 JSON RESPONSE FORMAT
You MUST always respond with a code block containing a JSON object like this:
\`\`\`json
{
  "thought": "Your detailed reasoning and state analysis here...",
  "action": {
    "name": "tool_name",
    "args": { "arg1": "value1" }
  }
}
\`\`\`

### ⚠️ CRITICAL RULES
- **Tool List**: You have access to:
${toolListStr}
- **Context**: 
${projectContext}${memoryContext}${gitContext}${osContext}${readonlyNotice}
${projectIndex ? projectIndex : ''}
${attachContext ? attachContext : ''}
${plannerContext}
- **Reporting**: If you just finished a tool, you MUST first report what you found or did in PLAIN TEXT before providing the next JSON block.
- **No Hallucinations**: Never invent file contents, terminal outputs, or website data. Use tools to see the truth.
- **Absolute Paths**: Always use full absolute paths.
- **One Action**: Never try to run two tools at once.
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
                responseText = await getAgentResponse(messages, isLocal, abortController.signal);
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
                    }
                }
            } catch (e) {
                // Not a valid tool call or parsing failed
            }

            if (planModeEnabled && parsedPayload) {
                updatePlannerStateFromPayload(plannerState, parsedPayload);
            }

            if (toolMatch) {
                // Display flavor text (reporting) if provided before the tool call
                if (flavorText) {
                    showAssistantMessage(flavorText, 'Rex Report');
                }

                const toolDef = AVAILABLE_TOOLS.find(t => t.name === toolMatch);
                if (toolDef) {
                    // Premium UI for Tool Planning
                    console.log(''); // Spacer
                    showActionMessage(toolMatch, toolArgs, String(planMatch || '').trim(), parsedPayload?.execution);
                    
                    let proceed = false;
                    
                    const maxAutoSteps = planModeEnabled ? planMaxSteps : 10;
                    if (config.agentPermission === 'auto-pilot' && autoPilotCount < maxAutoSteps) {
                        p.note(pc.yellow(`⚡ Auto-Pilot engaged. Proceeding autonomously... (${autoPilotCount + 1}/${maxAutoSteps})`), 'System');
                        proceed = true;
                        autoPilotCount++;
                    } else {
                        if (autoPilotCount >= maxAutoSteps) {
                            p.note(pc.red(`⚠️ Auto-Pilot paused (${maxAutoSteps} steps reached). Human review required.`), 'System');
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
                                p.note(pc.yellow('Auto-correct: switched browser_interact action from analyze_page to extract_text for content extraction.'), 'Guardrail');
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
                                    p.note(pc.dim('Preflight Analyse completed before risky browser action.'), 'Browser');
                                } catch (preflightErr) {
                                    p.note(pc.yellow(`Preflight Analyse warning: ${preflightErr.message}`), 'Browser');
                                }
                            }
                        }

                        // Tool permission check
                        const permCheck = isToolAllowed(toolMatch, toolPermissions);
                        if (!permCheck.allowed) {
                            p.note(pc.red(`🚫 BLOCKED: ${toolMatch} — ${permCheck.reason}`), 'System');
                            logToolCall(toolMatch, toolArgs, 'BLOCKED (permissions)', 'blocked');
                            historyContext.push({ role: 'assistant', content: `[BLOCKED: ${toolMatch} — ${permCheck.reason}]` });
                            if (planModeEnabled) {
                                plannerState.issueCounter += 1;
                                isAgentIterating = true;
                                userInput = `Planning issue detected: tool ${toolMatch} was blocked (${permCheck.reason}). Create or update a subplan to resolve this blocker using allowed tools, execute one step now, then return to the parent task ${plannerState.activeTaskId || 'when unblocked'}.`;
                                historyContext.push({ role: 'user', content: userInput });
                            } else {
                                isAgentIterating = false;
                            }
                            continue;
                        }

                        // Readonly guard
                        if (options.readonly && WRITE_TOOLS.includes(toolMatch)) {
                            p.note(pc.red(`🔒 READONLY MODE: Blocked ${toolMatch}. Rex can only read in this mode.`), 'System');
                            logToolCall(toolMatch, toolArgs, 'BLOCKED (readonly)', 'blocked');
                            historyContext.push({ role: 'assistant', content: `[BLOCKED: ${toolMatch} is not allowed in readonly mode]` });
                            isAgentIterating = true;
                            userInput = planModeEnabled
                                ? `Planning issue detected: ${toolMatch} is blocked by READONLY mode. Create/update a subplan that only uses read-safe tools, execute one subplan step, and then continue the main plan.`
                                : `The tool ${toolMatch} was blocked because we are in READONLY mode. Find an alternative approach that only reads data.`;
                            historyContext.push({ role: 'user', content: userInput });
                            continue;
                        }

                        // Stuck detection: same tool+args 3x in a row
                        const currentToolKey = `${toolMatch}:${JSON.stringify(toolArgs)}`;
                        if (currentToolKey === lastToolKey) {
                            stuckCount++;
                            if (stuckCount >= 3) {
                                p.note(pc.red(`🔄 STUCK DETECTED: Rex tried the same action 3 times. Pausing for human input.`), 'System');
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

                        // Execute with auto-retry (max 3 attempts)
                        let result;
                        let retryCount = 0;
                        const MAX_RETRIES = 3;

                        while (retryCount < MAX_RETRIES) {
                            try {
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
                                break; // Success, exit retry loop
                            } catch (toolErr) {
                                if (toolErr.name === 'AbortError' || toolErr.message === 'Aborted') {
                                    throw toolErr; // Catch in outer loop
                                }
                                retryCount++;
                                if (retryCount >= MAX_RETRIES) {
                                    result = `Tool error after ${MAX_RETRIES} retries: ${toolErr.message}`;
                                    p.note(pc.red(`⚠️ Tool failed after ${MAX_RETRIES} attempts: ${toolErr.message}`), 'System');
                                } else {
                                    p.note(pc.yellow(`⚡ Tool error (attempt ${retryCount}/${MAX_RETRIES}): ${toolErr.message}. Retrying...`), 'System');
                                }
                            }
                        }
                        
                        // Audit log
                        logToolCall(toolMatch, toolArgs, result, retryCount < MAX_RETRIES ? 'success' : 'error');

                        // Diff view for patch_file
                        if (toolMatch === 'patch_file' && toolArgs.targetContent && toolArgs.replacementContent) {
                            const diffLines = [];
                            toolArgs.targetContent.split('\n').forEach(l => diffLines.push(pc.red(`- ${l}`)));
                            toolArgs.replacementContent.split('\n').forEach(l => diffLines.push(pc.green(`+ ${l}`)));
                            p.note(diffLines.join('\n'), pc.bgGreen(pc.black(' DIFF ')));
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
                        isAgentIterating = true;

                        if (planModeEnabled) {
                            const doneCount = plannerState.main.tasks.filter(t => t.status === 'done').length;
                            const totalCount = plannerState.main.tasks.length;
                            const subplanStatus = plannerState.activeSubplan
                                ? ` | Subplan: ${plannerState.activeSubplan.id}`
                                : '';
                            p.note(pc.dim(`Plan progress: ${doneCount}/${totalCount || '?'} tasks done${subplanStatus}`), 'Planner');
                        }
                        
                        const toolFailed = retryCount >= MAX_RETRIES || String(result || '').startsWith('Tool error after');
                        const resultText = String(result || '');
                        const weakAutonomousCompletion = toolMatch === 'autonomous_web_agent'
                            && /goal achieved/i.test(resultText)
                            && isLikelyContentRequest(sessionMeta.topLevelRequest)
                            && !hasConcreteAnswerShape(resultText);

                        if (planModeEnabled && toolFailed) {
                            plannerState.issueCounter += 1;
                            userInput = `Planning issue detected: ${toolMatch} failed. Build or update a subplan to fix this specific issue, execute the first subplan step now, and after resolution continue the parent main-plan task ${plannerState.activeTaskId || ''}.`;
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
                showAssistantMessage(responseText, REX_PERSONA);
                historyContext.push({ role: 'assistant', content: responseText });
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
async function getAgentResponse(messages, isLocal, signal) {
    if (isLocal) {
        try {
            const { getLocalLlama } = await import('./ai.js');
            const { session } = await getLocalLlama();
            // Map messages to session history if needed, or just prompt the last one
            // node-llama-cpp's LlamaChatSession manages its own internal history, 
            // so we just pass the most recent user content.
            const userMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
            return await session.prompt(userMsg, { signal });
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
            p.intro(theme('🦖 REXAI SESSION REFRESHED'));
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
