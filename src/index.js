#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { Command } from 'commander';
import { loadConfig, saveConfig } from './config.js';
import { aiCodeReview } from './ai.js';
import { quickGitPush } from './git.js';
import { quickDockerPush } from './docker.js';
import { quickScaffold } from './scaffold.js';
import { aiTerminalCommand } from './terminal.js';
import { aiFileTranslator } from './translator.js';
import { projectScaffold } from './projectScaffold.js';
import { deployTools } from './deployTools.js';
import { regexTools } from './regexTools.js';
import { runDoctor } from './doctor.js';
import CFonts from 'cfonts';
import updateNotifier from 'update-notifier';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Professional Update Notifier
updateNotifier({ pkg }).notify();

const theme = gradient(['#12c2e9', '#c471ed', '#f64f59']);
const accentTheme = gradient(['#00c9a7', '#00b4d8', '#0077b6']);
const errorTheme = pc.red;
const successTheme = pc.green;
const infoTheme = pc.cyan;
const warningTheme = pc.yellow;

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const platformLabel = isMac ? 'macOS' : isWindows ? 'Windows' : 'Linux';

function supportsUnicode() {
    if (process.env.TERM === 'dumb') return false;
    return process.stdout.isTTY;
}

function glyphs() {
    if (supportsUnicode()) {
        return {
            bullet: '●',
            arrow: '➜',
            spark: '✦',
            panelL: '╭',
            panelR: '╮',
            panelBL: '╰',
            panelBR: '╯',
            line: '─',
            side: '│'
        };
    }
    return {
        bullet: '*',
        arrow: '>',
        spark: '*',
        panelL: '+',
        panelR: '+',
        panelBL: '+',
        panelBR: '+',
        line: '-',
        side: '|'
    };
}

function divider(width = 68) {
    const g = glyphs();
    return pc.dim(g.line.repeat(width));
}

function renderPanel(title, lines = []) {
    const g = glyphs();
    const width = 74;
    const top = `${g.panelL}${g.line.repeat(width - 2)}${g.panelR}`;
    const bottom = `${g.panelBL}${g.line.repeat(width - 2)}${g.panelBR}`;
    const titleLine = `${g.side} ${pc.bold(accentTheme(title)).padEnd(width - 4)} ${g.side}`;
    const body = lines.map((line) => `${g.side} ${line.padEnd(width - 4)} ${g.side}`);
    return [pc.dim(top), titleLine, ...body, pc.dim(bottom)].join('\n');
}

function menuLabel(icon, title, hint = '') {
    return `${icon} ${pc.bold(title)}${hint ? ` ${pc.dim('• ' + hint)}` : ''}`;
}

async function main() {
    const program = new Command();
    program
        .name('rexai')
        .description('RexAI - The powerful AI CLI assistant')
        .version(pkg.version);

    // Setup direct subcommands
    program
        .command('github-push')
        .alias('push')
        .description('Quick stage, AI commit, and push')
        .action(async () => {
            await quickGitPush();
            process.exit(0);
        });

    program
        .command('ask-ai <prompt...>')
        .description('Ask the AI a direct question')
        .action(async (promptArr) => {
            const { runCompletion } = await import('./ai.js');
            const prompt = promptArr.join(' ');

            // Easter egg response for special phrases
            if (prompt.toLowerCase().includes('sudo make me a sandwich')) {
                p.note(gradient.pastel('What? Make it yourself.'), 'Rex');
                process.exit(0);
            }

            try {
                const s = p.spinner();
                s.start('Thinking...');
                const res = await runCompletion(prompt);
                s.stop('Done.');
                p.note(gradient.pastel.multiline(res), 'AI Response');
            } catch (e) {
                p.log.error(e.message);
            }
            process.exit(0);
        });

    program
        .command('dino')
        .description('Show the Rex mascot')
        .action(() => {
            console.log(gradient.pastel(`
                __
               /  \\
              / ^  \\
             |      |
             |  (o) |  < ( RAWR! )
             |      |
            /  \\____/\\
           /          \\
          /            \\
         /              \\
            `));
            process.exit(0);
        });

    program
        .command('fortune')
        .description('Get a Rex developer fortune')
        .action(() => {
            const fortunes = [
                "Your next commit will have 0 merge conflicts.",
                "The bug you've been searching for is just a typo on line 42.",
                "Coffee logic: 1 cup = 100 lines of code. 2 cups = 1 bug.",
                "The senior dev will actually approve your PR on the first try today.",
                "A dinosaur never forgets to git push.",
                "You will find the perfect stackoverflow answer on page 1."
            ];
            console.log(gradient.pastel(`\n🦖 Rex says: ${fortunes[Math.floor(Math.random() * fortunes.length)]}\n`));
            process.exit(0);
        });

    program
        .command('open')
        .description('Open the interactive Rex menu')
        .action(async () => {
            await runInteractiveMenu();
            process.exit(0);
        });

    program
        .command('health')
        .description('Check project health and code quality')
        .action(async () => {
            const { projectHealth } = await import('./health.js');
            await projectHealth();
            process.exit(0);
        });

    program
        .command('doctor')
        .description('Secure diagnostics with optional safe-fix and verification')
        .option('--apply-safe', 'Apply safe baseline fixes if files are missing')
        .option('--verify', 'Run lint/test/build scripts when available')
        .option('--ai', 'Use minimal-context AI remediation recommendations')
        .option('--commit', 'Create a local commit for doctor-applied fixes')
        .option('-y, --yes', 'Assume yes for confirmations')
        .action(async (opts) => {
            await runDoctor({
                applySafe: opts.applySafe,
                verify: opts.verify,
                ai: opts.ai,
                commit: opts.commit,
                yes: opts.yes,
            });
            process.exit(0);
        });

    program
        .command('share <port>')
        .description('Share a local port publicly')
        .action(async (port) => {
            const { sharePort } = await import('./share.js');
            await sharePort(port);
            process.exit(0);
        });

        program
        .command('system')
        .description('Deep system awareness and process management')
        .option('--processes', 'List top active processes')
        .option('--power <action>', 'Initiate power action (sleep, restart, shutdown)')
        .action(async (opts) => {
            const { getSystemInfo, listProcesses, managePower } = await import('./system.js');
            if (opts.processes) {
                await listProcesses();
            } else if (opts.power) {
                await managePower(opts.power);
            } else {
                await getSystemInfo();
            }
            process.exit(0);
        });

    program
        .command('connect')
        .description('Manage platform connectors (Slack, Discord)')
        .action(async () => {
            const { connectorMenu } = await import('./connectors.js');
            await connectorMenu();
            process.exit(0);
        });

    program
        .command('vision')
        .description('Agentic vision and UI automation')
        .action(async () => {
            const { visionMenu } = await import('./vision.js');
            await visionMenu();
            process.exit(0);
        });

    program
        .command('automate')
        .description('Advanced automation and task scheduling')
        .action(async () => {
            const { automationMenu } = await import('./agentCore.js');
            await automationMenu();
            process.exit(0);
        });

    program
        .command('media')
        .description('Control system volume and brightness')
        .action(async () => {
            const { mediaMenu } = await import('./mediaTools.js');
            await mediaMenu();
            process.exit(0);
        });

    program
        .command('clip')
        .description('Manage system clipboard')
        .action(async () => {
            const { clipboardMenu } = await import('./clipboard.js');
            await clipboardMenu();
            process.exit(0);
        });

    program
        .command('mail')
        .description('Send emails via SMTP')
        .action(async () => {
            const { emailMenu } = await import('./email.js');
            await emailMenu();
            process.exit(0);
        });

    program
        .command('gui')
        .description('Simulate mouse and keyboard actions')
        .action(async () => {
            const { guiMenu } = await import('./gui.js');
            await guiMenu();
            process.exit(0);
        });

    program
        .command('os-agent')
        .description('Isolated Windows OS-level automation mode')
        .option('--open <app>', 'Open an application (e.g. notepad.exe)')
        .option('--focus <title>', 'Focus a window by title substring')
        .option('--move <x,y>', 'Move mouse to coordinates')
        .option('--click <x,y>', 'Click at coordinates')
        .option('--button <button>', 'Mouse button for --click (left/right)', 'left')
        .option('--type <text>', 'Type text into the active window')
        .option('--hotkey <combo>', 'Send hotkey (e.g. CTRL+L, ALT+F4)')
        .option('--wait <ms>', 'Wait in milliseconds between actions')
        .option('--script <path>', 'Run action list from JSON file')
        .option('--dry-run', 'Print actions without controlling the OS')
        .action(async (opts) => {
            const { runOsAgentFromCli } = await import('./osAgent.js');
            await runOsAgentFromCli(opts);
            process.exit(0);
        });

    program
        .command('hook <action>')
        .description('Install or remove AI git hooks (install/remove)')
        .action(async (action) => {
            const { handleHooks } = await import('./hooks.js');
            await handleHooks(action);
            process.exit(0);
        });

    program
        .command('env')
        .description('Generate .env.example from .env')
        .action(async () => {
            const { generateEnvExample } = await import('./env.js');
            await generateEnvExample();
            process.exit(0);
        });

    program
        .command('docs')
        .description('Generate aesthetic AI documents')
        .action(async () => {
            const { docsAiGenerator } = await import('./docsAi.js');
            await docsAiGenerator();
            process.exit(0);
        });

    program
        .command('x <cmd...>')
        .alias('run')
        .description('Execute a command with RexAI self-healing support')
        .action(async (cmdArr) => {
            const { runWithHealing } = await import('./terminal.js');
            await runWithHealing(cmdArr.join(' '));
            process.exit(0);
        });

    program
        .command('review')
        .description('Perform an AI code review')
        .action(async () => {
            await aiCodeReview();
            process.exit(0);
        });

    program
        .command('translate')
        .description('Translate a file using AI')
        .action(async () => {
            await aiFileTranslator();
            process.exit(0);
        });

    program
        .command('sql')
        .description('Generate SQL queries from natural language')
        .action(async () => {
            const { sqlAiGenerator } = await import('./sqlAi.js');
            await sqlAiGenerator();
            process.exit(0);
        });

    program
        .command('regex')
        .description('Generate regular expressions using AI')
        .action(async () => {
            await regexTools();
            process.exit(0);
        });

    program
        .command('scaffold')
        .description('Quick scaffold a single file or component')
        .action(async () => {
            await quickScaffold();
            process.exit(0);
        });

    program
        .command('project-scaffold')
        .description('Scaffold a full project structure')
        .action(async () => {
            await projectScaffold();
            process.exit(0);
        });

    program
        .command('slides')
        .description('Convert markdown notes into HTML slides')
        .action(async () => {
            const { markdownToSlides } = await import('./slides.js');
            await markdownToSlides();
            process.exit(0);
        });

    program
        .command('docker-push')
        .description('Quick docker build and push')
        .action(async () => {
            await quickDockerPush();
            process.exit(0);
        });

    program
        .command('deploy')
        .description('Instant deployment tools')
        .action(async () => {
            await deployTools();
            process.exit(0);
        });

    program
        .command('plugins')
        .description('Run custom community plugins')
        .action(async () => {
            const { runPlugins } = await import('./plugins.js');
            await runPlugins();
            process.exit(0);
        });

    program
        .command('chat')
        .description('Open the interactive RexAI agent chat')
        .option('--debug', 'Show full prompt and token estimates')
        .option('--readonly', 'Block all write operations (read-only mode)')
        .option('--plan', 'Enable planner mode with task list + automatic subplans for issues')
        .option('--plan-max-steps <n>', 'Planner auto-run budget before human review is required (default: 12)')
        .option('--model <name>', 'Model override (ollama, openai, gemini, claude, deepseek, fast, smart, best)')
        .option('--attach <glob>', 'Attach files matching glob to context (e.g. "src/*.js")')
        .argument('[prompt...]', 'Optional prompt for pipe-in mode')
        .action(async (promptArgs, opts) => {
            const { startAgentChat } = await import('./chat.js');
            
            // Detect piped stdin (non-TTY)
            let pipedInput = '';
            if (!process.stdin.isTTY) {
                pipedInput = await new Promise((resolve) => {
                    let data = '';
                    process.stdin.setEncoding('utf-8');
                    process.stdin.on('data', chunk => data += chunk);
                    process.stdin.on('end', () => resolve(data.trim()));
                });
            }
            
            // Combine piped input with inline prompt: cat file | rexai chat "explain this"
            const inlinePrompt = promptArgs.length ? promptArgs.join(' ') : '';
            if (pipedInput && inlinePrompt) {
                pipedInput = `${inlinePrompt}\n\n[Piped Input]:\n${pipedInput}`;
            } else if (inlinePrompt && !pipedInput) {
                pipedInput = inlinePrompt;
            }
            
            await startAgentChat({
                debug: opts.debug,
                readonly: opts.readonly,
                plan: opts.plan || opts.planMaxSteps !== undefined,
                planMaxSteps: opts.planMaxSteps ? Number.parseInt(opts.planMaxSteps, 10) : undefined,
                model: opts.model,
                attach: opts.attach,
                pipedInput: pipedInput || undefined
            });
            process.exit(0);
        });

    // Provide help output if --commands is passed
    if (process.argv.includes('--commands')) {
        showComprehensiveHelp(program);
        process.exit(0);
    }

    program.parse();

    // If args were passed (other than node and script), commander handled it.
    if (process.argv.length > 2) return;

    await runInteractiveMenu();
}

async function runInteractiveMenu() {
    const intros = ['🦖', '🐉', '🦕', '🐊'];
    const introEmoji = Math.random() < 0.1 ? '🍄' : intros[Math.floor(Math.random() * intros.length)];
    const g = glyphs();

    console.clear();
    try {
        CFonts.say('REXAI', {
            font: isWindows ? 'block' : 'simple3d',
            align: 'left',
            colors: ['#00c9a7', '#00b4d8', '#0077b6'],
            background: 'transparent',
            letterSpacing: 1,
            lineHeight: 1,
            space: true,
            maxLength: '0',
        });
    } catch {
        console.log(pc.bold(accentTheme('REXAI')));
    }

    console.log(renderPanel('Command Center', [
        `${g.spark} ${pc.bold('Version')} ${pc.dim('v' + pkg.version)}   ${g.spark} ${pc.bold('Platform')} ${pc.dim(platformLabel)}`,
        `${g.spark} ${pc.bold('Mode')} ${pc.dim('Interactive')}   ${g.spark} ${pc.bold('Tip')} ${pc.dim('Run rexai --commands for full map')}`
    ]));
    p.intro(theme(`${introEmoji} REXAI Developer Console`));

    let running = true;
    while (running) {
        const action = await p.select({
            message: `${g.arrow} Select a workspace lane`,
            options: [
                { value: 'dev_tools', label: menuLabel('AI', 'Developer Tools', 'review, docs, translate') },
                { value: 'project_tools', label: menuLabel('PRJ', 'Project Studio', 'health, scaffold, slides') },
                { value: 'devops_tools', label: menuLabel('OPS', 'DevOps Lane', 'git, docker, deploy') },
                { value: 'power_tools', label: menuLabel('PWR', 'Power Utilities', 'terminal, system, share') },
                { value: 'settings', label: menuLabel('CFG', 'Settings', 'model, permissions, webhooks') },
                ...(Math.random() < 0.2 ? [{ value: 'mystery', label: menuLabel('???', 'Hidden Item', 'curiosity unlocked') }] : []),
                { value: 'exit', label: menuLabel('BYE', 'Exit Console') }
            ]
        });

        if (p.isCancel(action) || action === 'exit') {
            p.outro(accentTheme('Session closed. Build something legendary.'));
            running = false;
            process.exit(0);
        }

        if (action === 'mystery') {
            p.note(accentTheme('You found the hidden node. Power user energy confirmed.'), 'Secret');
            continue;
        }

        try {
            switch (action) {
                case 'dev_tools':
                    const devAction = await p.select({
                        message: `${g.arrow} AI Developer Tools`,
                        options: [
                            { value: 'ai_review', label: menuLabel('REV', 'Code Review') },
                            { value: 'translator', label: menuLabel('TRN', 'File Translator') },
                            { value: 'sql', label: menuLabel('SQL', 'SQL Generator') },
                            { value: 'docs', label: menuLabel('DOC', 'Document Generator') },
                            { value: 'regex', label: menuLabel('RGX', 'Regex Generator') },
                            { value: 'back', label: menuLabel('BACK', 'Main Dashboard') }
                        ]
                    });
                    if (p.isCancel(devAction) || devAction === 'back') break;

                    if (devAction === 'ai_review') await aiCodeReview();
                    if (devAction === 'translator') await aiFileTranslator();
                    if (devAction === 'sql') { const { sqlAiGenerator } = await import('./sqlAi.js'); await sqlAiGenerator(); }
                    if (devAction === 'docs') { const { docsAiGenerator } = await import('./docsAi.js'); await docsAiGenerator(); }
                    if (devAction === 'regex') await regexTools();
                    break;

                case 'project_tools':
                    const projAction = await p.select({
                        message: `${g.arrow} Project Studio`,
                        options: [
                            { value: 'health', label: menuLabel('HLT', 'Project Health Scan') },
                            { value: 'doctor', label: menuLabel('DOC', 'Doctor (Secure Diagnose + Fix)') },
                            { value: 'scaffold', label: menuLabel('SCA', 'Quick File Scaffold') },
                            { value: 'project_scaffold', label: menuLabel('BLD', 'Full Project Scaffold') },
                            { value: 'env', label: menuLabel('ENV', 'Env Secret Generator') },
                            { value: 'slides', label: menuLabel('SLD', 'Markdown to Slides') },
                            { value: 'back', label: menuLabel('BACK', 'Main Dashboard') }
                        ]
                    });
                    if (p.isCancel(projAction) || projAction === 'back') break;

                    if (projAction === 'health') { const { projectHealth } = await import('./health.js'); await projectHealth(); }
                    if (projAction === 'doctor') await runDoctor();
                    if (projAction === 'scaffold') await quickScaffold();
                    if (projAction === 'project_scaffold') await projectScaffold();
                    if (projAction === 'env') { const { generateEnvExample } = await import('./env.js'); await generateEnvExample(); }
                    if (projAction === 'slides') { const { markdownToSlides } = await import('./slides.js'); await markdownToSlides(); }
                    break;

                case 'devops_tools':
                    const devopsAction = await p.select({
                        message: `${g.arrow} DevOps Lane`,
                        options: [
                            { value: 'git_push', label: menuLabel('GIT', 'Quick Git Commit & Push') },
                            { value: 'docker_push', label: menuLabel('DCK', 'Quick Docker Build & Push') },
                            { value: 'deploy', label: menuLabel('DEP', 'Instant Deploy') },
                            { value: 'back', label: menuLabel('BACK', 'Main Dashboard') }
                        ]
                    });
                    if (p.isCancel(devopsAction) || devopsAction === 'back') break;

                    if (devopsAction === 'git_push') await quickGitPush();
                    if (devopsAction === 'docker_push') await quickDockerPush();
                    if (devopsAction === 'deploy') await deployTools();
                    break;

                case 'power_tools':
                    const powerAction = await p.select({
                        message: `${g.arrow} Power Utilities`,
                        options: [
                            { value: 'terminal_gen', label: menuLabel('CMD', 'AI Terminal Command Gen') },
                            { value: 'system', label: menuLabel('SYS', 'System Info & Control') },
                            { value: 'connect', label: menuLabel('CNX', 'Platform Connectors') },
                            { value: 'vision', label: menuLabel('VIS', 'Agentic Vision') },
                            { value: 'automate', label: menuLabel('AUT', 'Advanced Automation') },
                            { value: 'media', label: menuLabel('MED', 'Media Control') },
                            { value: 'clip', label: menuLabel('CLP', 'Clipboard') },
                            { value: 'mail', label: menuLabel('ML', 'Email Alerts') },
                            { value: 'gui', label: menuLabel('GUI', 'GUI Control') },
                            { value: 'share', label: menuLabel('SHR', 'Share Local Port') },
                            { value: 'hooks', label: menuLabel('HOK', 'Manage AI Git Hooks') },
                            { value: 'plugins', label: menuLabel('PLG', 'Run Custom Plugins') },
                            { value: 'back', label: menuLabel('BACK', 'Main Dashboard') }
                        ]
                    });
                    if (p.isCancel(powerAction) || powerAction === 'back') break;

                    if (powerAction === 'terminal_gen') await aiTerminalCommand();
                    if (powerAction === 'system') { const { getSystemInfo } = await import('./system.js'); await getSystemInfo(); }
                    if (powerAction === 'connect') { const { connectorMenu } = await import('./connectors.js'); await connectorMenu(); }
                    if (powerAction === 'vision') { const { visionMenu } = await import('./vision.js'); await visionMenu(); }
                    if (powerAction === 'automate') { const { automationMenu } = await import('./agentCore.js'); await automationMenu(); }
                    if (powerAction === 'media') { const { mediaMenu } = await import('./mediaTools.js'); await mediaMenu(); }
                    if (powerAction === 'clip') { const { clipboardMenu } = await import('./clipboard.js'); await clipboardMenu(); }
                    if (powerAction === 'mail') { const { emailMenu } = await import('./email.js'); await emailMenu(); }
                    if (powerAction === 'gui') { const { guiMenu } = await import('./gui.js'); await guiMenu(); }
                    if (powerAction === 'share') {
                        const port = await p.text({ message: 'Port to share:', initialValue: '3000' });
                        if (!p.isCancel(port)) { const { sharePort } = await import('./share.js'); await sharePort(port); }
                    }
                    if (powerAction === 'hooks') {
                        const hAction = await p.select({ message: 'Git Hooks:', options: [{ value: 'install', label: '✅ Install' }, { value: 'remove', label: '❌ Remove' }] });
                        if (!p.isCancel(hAction)) { const { handleHooks } = await import('./hooks.js'); await handleHooks(hAction); }
                    }
                    if (powerAction === 'plugins') { const { runPlugins } = await import('./plugins.js'); await runPlugins(); }
                    break;

                case 'settings':
                    await handleSettings();
                    break;
            }
        } catch (e) {
            p.log.error(errorTheme(`Error: ${e.message}`));
        }

        if (running) {
            const continu = await p.confirm({ message: 'Do you want to perform another action?', initialValue: true });
            if (!continu || p.isCancel(continu)) {
                p.outro(accentTheme('Session closed. Build something legendary.'));
                running = false;
            }
        }
    }
}

async function handleSettings() {
    let config = loadConfig();
    const g = glyphs();

    console.log(divider());
    console.log(accentTheme(`${g.spark} Settings Console (${platformLabel})`));
    console.log(pc.dim('Tune model routing, permissions, and connector secrets.'));
    console.log(divider());
    
    const permissionChoice = await p.select({
        message: `${g.arrow} Agent permission profile`,
        options: [
            { value: 'safe', label: '🛡️ Safe Mode (Always ask for permission before execution)' },
            { value: 'auto-pilot', label: '⚠️ Auto-Pilot (Autonomous multi-step execution - up to 10 steps)' }
        ],
        initialValue: config.agentPermission || 'safe'
    });

    if (p.isCancel(permissionChoice)) return;
    config.agentPermission = permissionChoice;

    const modelChoice = await p.select({
        message: `${g.arrow} Primary AI model`,
        options: [
            { value: 'ollama', label: '🦙 Ollama (Local, Free, Resource Friendly)' },
            { value: 'local-llama', label: '🦖 Local Llama (Native, Offline, No Ollama Req.)' },
            { value: 'openai', label: '🟢 OpenAI (Requires API Key) [gpt-4o-mini]' },
            { value: 'gemini', label: '🟦 Google Gemini (Requires API Key) [gemini-2.5-flash]' },
            { value: 'claude', label: '🟧 Anthropic Claude (Requires API Key) [claude-3-5-haiku]' },
            { value: 'deepseek', label: '🐋 Deepseek (Requires API Key) [deepseek-chat]' }
        ],
        initialValue: config.aiModel
    });

    if (p.isCancel(modelChoice)) return;
    config.aiModel = modelChoice;

    if (config.aiModel === 'local-llama') {
        const { MODELS_CONFIG, downloadModel } = await import('./ai.js');
        const { MODELS_DIR } = await import('./config.js');
        const path = await import('path');
        const fs = await import('fs');

        const modelChoice = await p.select({
            message: `${g.arrow} Select a local Rex model`,
            options: Object.entries(MODELS_CONFIG).map(([id, cfg]) => ({
                value: id,
                label: `${cfg.name} - ${cfg.desc}`
            })),
            initialValue: config.selectedLocalModel || 'rex-fast'
        });

        if (p.isCancel(modelChoice)) return;
        config.selectedLocalModel = modelChoice;

        const modelPath = path.join(MODELS_DIR, `${modelChoice}.gguf`);
        if (!fs.existsSync(modelPath)) {
            const confirmDownload = await p.confirm({
                message: `The model ${modelChoice} is not downloaded yet. Download it now?`,
                initialValue: true
            });

            if (confirmDownload) {
                const s = p.spinner();
                s.start(`Downloading ${modelChoice}... This might take a few minutes.`);
                try {
                    await downloadModel(modelChoice, (progress) => {
                        // Progress bar could be added here if clack supports it easily, 
                        // for now just simple spinner with text update
                        s.message(`Downloading ${modelChoice}... ${Math.round(progress * 100)}%`);
                    });
                    s.stop(theme(`Successfully downloaded ${modelChoice}!`));
                } catch (e) {
                    s.stop(errorTheme(`Download failed: ${e.message}`));
                    return;
                }
            } else {
                p.log.warn('Model not downloaded. Rex Local Llama will not work until downloaded.');
            }
        }
    } else if (config.aiModel === 'ollama') {
        const ollamaModel = await p.text({
            message: `${g.arrow} Ollama model name (e.g. llama3:latest)`,
            initialValue: config.ollamaModel || 'llama3:latest'
        });
        if (!p.isCancel(ollamaModel)) config.ollamaModel = ollamaModel;
    } else {
        const keyPropMap = {
            'openai': 'openaiKey',
            'gemini': 'geminiKey',
            'claude': 'claudeKey',
            'deepseek': 'deepseekKey'
        };
        const propName = keyPropMap[config.aiModel];
        const key = await p.text({
            message: `${g.arrow} ${config.aiModel.charAt(0).toUpperCase() + config.aiModel.slice(1)} API key`,
            initialValue: config[propName] || '',
        });
        if (!p.isCancel(key)) config[propName] = key;
    }

    
    const webhookAction = await p.select({
        message: `${g.arrow} Platform connectors`,
        options: [
            { value: 'slack', label: 'Slack Webhook' },
            { value: 'discord', label: 'Discord Webhook' },
                                { value: 'smtp', label: 'SMTP (Email) Settings' },
            { value: 'none', label: 'Skip' }
        ]
    });

    if (!p.isCancel(webhookAction) && webhookAction !== 'none') {
        const url = await p.text({
            message: `${g.arrow} ${webhookAction.charAt(0).toUpperCase() + webhookAction.slice(1)} webhook URL`,
            initialValue: config[`${webhookAction}WebhookUrl`] || '',
        });
        if (!p.isCancel(url)) config[`${webhookAction}WebhookUrl`] = url;
    }

    saveConfig(config);
    p.log.success(successTheme('Settings saved successfully.'));
}

async function showComprehensiveHelp(program) {
    const g = glyphs();
    console.clear();
    CFonts.say('COMMANDS', {
        font: 'slim',
        align: 'left',
        colors: ['#00ffff', '#00ff00'],
    });

    console.log(renderPanel('Command Atlas', [
        `${g.spark} ${pc.bold('Version')} ${pc.dim('v' + pkg.version)}   ${g.spark} ${pc.bold('Platform')} ${pc.dim(platformLabel)}`,
        `${g.spark} ${pc.bold('Invocation')} ${pc.dim('rexai <command> [options]')}`
    ]));

    const sections = [
        {
            title: '🤖 Core AI Commands',
            commands: [
                { cmd: 'rexai chat', desc: 'Main interactive agent loop (Sprint 1-3 features)' },
                { cmd: 'rexai ask-ai <prompt>', desc: 'Direct one-off question to AI' },
                { cmd: 'rexai x <cmd>', desc: 'Run shell command with AI self-healing' },
                { cmd: 'rexai review', desc: 'Perform AI code review of current dir' },
                { cmd: 'rexai sql', desc: 'Generate SQL from natural language' },
                { cmd: 'rexai regex', desc: 'Generate RegEx patterns from description' }
            ]
        },
        {
            title: '🏗️ Project & Dev Tools',
            commands: [
                { cmd: 'rexai health', desc: 'Scan project health, deps, and quality' },
                { cmd: 'rexai doctor', desc: 'Secure diagnose, safe-fix, verify workflow' },
                { cmd: 'rexai scaffold', desc: 'Quickly generate a single file/component' },
                { cmd: 'rexai project-scaffold', desc: 'Generate a full project boilerplate' },
                { cmd: 'rexai env', desc: 'Generate .env.example from .env' },
                { cmd: 'rexai docs', desc: 'Generate aesthetic HTML documentation' },
                { cmd: 'rexai slides', desc: 'Markdown notes → HTML slide deck' },
                { cmd: 'rexai translate', desc: 'Translate source files between languages' }
            ]
        },
        {
            title: '📦 DevOps & Power Tools',
            commands: [
                { cmd: 'rexai push', desc: 'Smart git stage, AI commit, and push' },
                { cmd: 'rexai docker-push', desc: 'Build and push docker image' },
                { cmd: CFonts.render('rexai deploy', {font:'console'}).string.trim(), desc: 'Cloud deployment assistant' },
                { cmd: 'rexai share <port>', desc: 'Public tunnel for local port (vía share.js)' },
                { cmd: 'rexai os-agent', desc: 'Isolated Windows OS-level automation mode' },
                { cmd: 'rexai hook install', desc: 'Install AI-powered git commit hooks' },
                { cmd: 'rexai plugins', desc: 'Browse and run community plugins' }
            ]
        },
        {
            title: '💬 Chat Loop Slash Commands',
            commands: [
                { cmd: '/save <name>', desc: 'Save current chat session to .agent/sessions/' },
                { cmd: '/load <name>', desc: 'Reload a previous session' },
                { cmd: '/history [q]', desc: 'Search or list session history' },
                { cmd: '/workflow [w]', desc: 'Run multi-step YAML/JSON workflows' },
                { cmd: '/profile [p]', desc: 'Switch config profiles (API keys, models)' },
                { cmd: '/plan [args]', desc: 'Toggle planner mode and set max-step budget' },
                { cmd: '/index', desc: 'Re-index project structure for AI' },
                { cmd: '/help', desc: 'Show this internal command list' }
            ]
        },
        {
            title: '📎 Intelligence Shortcuts (Context Refs)',
            commands: [
                { cmd: '@file:path', desc: 'Inline inject file content into prompt' },
                { cmd: '@url:link', desc: 'Inline fetch web content into prompt' },
                { cmd: '| rexai chat', desc: 'Pipe terminal output into Rex logic' }
            ]
        },
        {
            title: '⚙️ Chat Flags (CLI Options)',
            commands: [
                { cmd: '--debug', desc: 'Show full internal prompt & token costs' },
                { cmd: '--readonly', desc: 'Block all write-related AI tools' },
                { cmd: '--plan', desc: 'Use structured plan mode with subplans for errors' },
                { cmd: '--plan-max-steps <n>', desc: 'Max autonomous plan steps before review (default 12)' },
                { cmd: '--model <m>', desc: 'Override model per-session (fast/smart/best)' },
                { cmd: '--attach <g>', desc: 'Auto-attach files matching glob to context' }
            ]
        }
    ];

    for (const section of sections) {
        console.log(`\n${accentTheme(section.title)}`);
        console.log(divider(56));
        for (const item of section.commands) {
            console.log(`  ${pc.cyan(item.cmd.padEnd(26))} ${pc.dim('|')} ${item.desc}`);
        }
    }

    console.log(`\n${pc.bold(accentTheme('PRO TIP'))}: ${pc.dim('Use "rexai open" for the interactive dashboard.')}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

