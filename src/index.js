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
import updateNotifier from 'update-notifier';
import { brandTheme, menuLabel, sectionRule, terminalGlyphs } from './terminalTheme.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Professional Update Notifier
updateNotifier({ pkg }).notify();

const theme = brandTheme;
const errorTheme = pc.red;
const successTheme = pc.green;
const infoTheme = pc.cyan;
const warningTheme = pc.yellow;

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const platformLabel = isMac ? 'macOS' : isWindows ? 'Windows' : 'Linux';

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
        .option('--quiet', 'Hide internal tool actions and reasoning traces (default behavior)')
        .option('--show-actions', 'Show internal tool actions and reasoning traces')
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
                quiet: opts.quiet,
                showActions: opts.showActions,
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
        await showComprehensiveHelp();
        process.exit(0);
    }

    program.parse();

    // If args were passed (other than node and script), commander handled it.
    if (process.argv.length > 2) return;

    await runInteractiveMenu();
}

async function runInteractiveMenu() {
    const g = terminalGlyphs();

    console.clear();
    
    // Clean typographic header — no CFonts banner
    console.log('');
    console.log(`  ${brandTheme('rex')}`);  
    console.log(`  ${pc.dim(`v${pkg.version}  ·  ${platformLabel}`)}`);  
    console.log('');
    console.log(sectionRule());
    console.log('');

    let running = true;
    while (running) {
        const action = await p.select({
            message: pc.dim('choose'),
            options: [
                { value: 'dev_tools',    label: menuLabel('01', 'Code',    'review · docs · translate') },
                { value: 'project_tools',label: menuLabel('02', 'Project', 'health · scaffold · slides') },
                { value: 'devops_tools', label: menuLabel('03', 'Ship',    'git · docker · deploy') },
                { value: 'power_tools',  label: menuLabel('04', 'Ops',     'terminal · system · share') },
                { value: 'lab_tools',    label: menuLabel('05', 'Lab',     'cortex · swarm · fix') },
                { value: 'settings',     label: menuLabel('06', 'Settings','models · permissions · logs') },
                { value: 'exit',         label: menuLabel('00', 'Exit',    '', 'muted') }
            ]
        });

        if (p.isCancel(action) || action === 'exit') {
            p.outro(pc.dim('session ended.'));
            running = false;
            process.exit(0);
        }

        try {
            switch (action) {
                case 'dev_tools': {
                    console.log('');
                    const devAction = await p.select({
                        message: pc.dim('code tools'),
                        options: [
                            { value: 'ai_review',  label: menuLabel('rev', 'Code Review') },
                            { value: 'translator', label: menuLabel('trn', 'Translator') },
                            { value: 'sql',         label: menuLabel('sql', 'SQL Query') },
                            { value: 'docs',        label: menuLabel('doc', 'Documentation') },
                            { value: 'regex',       label: menuLabel('rgx', 'Regex') },
                            { value: 'back',        label: pc.dim('  back') }
                        ]
                    });
                    if (p.isCancel(devAction) || devAction === 'back') break;

                    if (devAction === 'ai_review') await aiCodeReview();
                    if (devAction === 'translator') await aiFileTranslator();
                    if (devAction === 'sql') { const { sqlAiGenerator } = await import('./sqlAi.js'); await sqlAiGenerator(); }
                    if (devAction === 'docs') { const { docsAiGenerator } = await import('./docsAi.js'); await docsAiGenerator(); }
                    if (devAction === 'regex') await regexTools();
                    break;
                }

                case 'project_tools': {
                    console.log('');
                    const projAction = await p.select({
                        message: pc.dim('project tools'),
                        options: [
                            { value: 'health',           label: menuLabel('hlt', 'Health Scan') },
                            { value: 'doctor',           label: menuLabel('doc', 'Doctor') },
                            { value: 'scaffold',         label: menuLabel('sca', 'Quick Scaffold') },
                            { value: 'project_scaffold', label: menuLabel('bld', 'Full Project') },
                            { value: 'env',              label: menuLabel('env', 'Env Template') },
                            { value: 'slides',           label: menuLabel('sld', 'Slides') },
                            { value: 'back',             label: pc.dim('  back') }
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
                }

                case 'devops_tools': {
                    console.log('');
                    const devopsAction = await p.select({
                        message: pc.dim('ship'),
                        options: [
                            { value: 'git_push',    label: menuLabel('git', 'Git Push') },
                            { value: 'docker_push', label: menuLabel('dck', 'Docker Push') },
                            { value: 'deploy',      label: menuLabel('dep', 'Deploy') },
                            { value: 'back',        label: pc.dim('  back') }
                        ]
                    });
                    if (p.isCancel(devopsAction) || devopsAction === 'back') break;

                    if (devopsAction === 'git_push') await quickGitPush();
                    if (devopsAction === 'docker_push') await quickDockerPush();
                    if (devopsAction === 'deploy') await deployTools();
                    break;
                }

                case 'power_tools': {
                    console.log('');
                    const powerAction = await p.select({
                        message: pc.dim('ops'),
                        options: [
                            { value: 'terminal_gen', label: menuLabel('cmd', 'Terminal') },
                            { value: 'system',      label: menuLabel('sys', 'System') },
                            { value: 'connect',     label: menuLabel('cnx', 'Connectors') },
                            { value: 'vision',      label: menuLabel('vis', 'Vision') },
                            { value: 'automate',    label: menuLabel('aut', 'Automation') },
                            { value: 'media',       label: menuLabel('med', 'Media') },
                            { value: 'clip',        label: menuLabel('clp', 'Clipboard') },
                            { value: 'mail',        label: menuLabel('ml',  'Email') },
                            { value: 'gui',         label: menuLabel('gui', 'GUI') },
                            { value: 'share',       label: menuLabel('shr', 'Share Port') },
                            { value: 'hooks',       label: menuLabel('hok', 'Git Hooks') },
                            { value: 'plugins',     label: menuLabel('plg', 'Plugins') },
                            { value: 'back',        label: pc.dim('  back') }
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
                        const port = await p.text({ message: 'Port:', initialValue: '3000' });
                        if (!p.isCancel(port)) { const { sharePort } = await import('./share.js'); await sharePort(port); }
                    }
                    if (powerAction === 'hooks') {
                        const hAction = await p.select({ message: pc.dim('hooks'), options: [{ value: 'install', label: 'install' }, { value: 'remove', label: 'remove' }] });
                        if (!p.isCancel(hAction)) { const { handleHooks } = await import('./hooks.js'); await handleHooks(hAction); }
                    }
                    if (powerAction === 'plugins') { const { runPlugins } = await import('./plugins.js'); await runPlugins(); }
                    break;
                }

                case 'lab_tools': {
                    console.log('');
                    const labAction = await p.select({
                        message: pc.dim('experimental'),
                        options: [
                            { value: 'nerve_map',  label: menuLabel('ctx', 'Nerve Map (CortexKit)') },
                            { value: 'hindsight',  label: menuLabel('hst', 'Hindsight Explorer') },
                            { value: 'auto_fix',   label: menuLabel('fix', 'Auto-Fix (Self-Healing)') },
                            { value: 'swarm',      label: menuLabel('swm', 'Swarm Delegation') },
                            { value: 'mcp',        label: menuLabel('mcp', 'Productivity Suite (MCP)') },
                            { value: 'sentinel',   label: menuLabel('srv', 'Start Sentinel Server (Webhooks)') },
                            { value: 'discord',    label: menuLabel('bot', 'Start Discord Bot Companion') },
                            { value: 'back',       label: pc.dim('  back') }
                        ]
                    });
                    if (p.isCancel(labAction) || labAction === 'back') break;
                    
                    if (labAction === 'nerve_map') { const { nerve_map } = await import('./cortexKit.js'); const res = await nerve_map({ directory: process.cwd() }); p.note(res, 'CortexKit'); }
                    if (labAction === 'mcp') { const { mcpMenu } = await import('./mcpManager.js'); await mcpMenu(); }
                    if (labAction === 'sentinel') { 
                        const { startProductionVisionServer } = await import('./server.js'); 
                        await startProductionVisionServer(); 
                        p.note(pc.green('Production Vision Sentinel is running in the background.'), 'Sentinel Server');
                    }
                    if (labAction === 'discord') {
                        const { startDiscordBot } = await import('./discordBot.js');
                        await startDiscordBot();
                    }
                    if (labAction === 'hindsight') { 
                        const dir = path.join(process.cwd(), '.agent', 'hindsight');
                        if (!fs.existsSync(dir)) { p.log.warn('No hindsight records found.'); break; }
                        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
                        if (!files.length) { p.log.warn('No hindsight records found.'); break; }
                        const file = await p.select({ message: 'Select record:', options: files.map(f => ({ value: f, label: f })) });
                        if (!p.isCancel(file)) p.note(fs.readFileSync(path.join(dir, file), 'utf-8'), 'Hindsight');
                    }
                    if (labAction === 'auto_fix') { const { autoFixProject } = await import('./fix.js'); await autoFixProject(); }
                    if (labAction === 'swarm') { 
                        const task = await p.text({ message: 'Task for sub-agent:', placeholder: 'Research the latest version of React' });
                        if (!p.isCancel(task)) { const { delegate_task } = await import('./swarm.js'); const res = await delegate_task({ task }); p.note(res, 'Swarm Result'); }
                    }
                    break;
                }

                case 'settings':
                    await handleSettings();
                    break;
            }
        } catch (e) {
            p.log.error(errorTheme(`Error: ${e.message}`));
        }

        if (running) {
            console.log('');
            console.log(sectionRule());
            const continu = await p.confirm({ message: pc.dim('continue?'), initialValue: true });
            if (!continu || p.isCancel(continu)) {
                p.outro(pc.dim('session ended.'));
                running = false;
            }
        }
    }
}

async function handleSettings() {
    let config = loadConfig();
    const g = terminalGlyphs();

    console.log('');
    
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
            { value: 'openai', label: '🟢 OpenAI (Requires API Key) [gpt-5-nano | gpt-4o-mini | gpt-5-mini]' },
            { value: 'gemini', label: '🟦 Google Gemini (Requires API Key) [gemini-2.5-flash | gemini-2.0-flash | gemini-2.5-flash-lite]' },
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

        if (config.aiModel === 'openai') {
            const openaiModel = await p.select({
                message: `${g.arrow} OpenAI model`,
                options: [
                    { value: 'gpt-5-nano', label: 'gpt-5-nano (fastest / lowest cost)' },
                    { value: 'gpt-4o-mini', label: 'gpt-4o-mini (balanced)' },
                    { value: 'gpt-5-mini', label: 'gpt-5-mini (best quality of the three)' }
                ],
                initialValue: config.openaiModel || 'gpt-5-mini'
            });

            if (!p.isCancel(openaiModel)) config.openaiModel = openaiModel;
        }

        if (config.aiModel === 'gemini') {
            const geminiModel = await p.select({
                message: `${g.arrow} Gemini model`,
                options: [
                    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash (best quality)' },
                    { value: 'gemini-2.0-flash', label: 'gemini-2.0-flash (stable + fast)' },
                    { value: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite (cheapest / fastest)' }
                ],
                initialValue: config.geminiModel || 'gemini-2.5-flash'
            });

            if (!p.isCancel(geminiModel)) config.geminiModel = geminiModel;
        }
    }

    const dualMode = await p.confirm({
        message: `${g.arrow} Enable dual-model agent mode (planner + runner)?`,
        initialValue: Boolean(config.multiModelAgentEnabled)
    });
    if (p.isCancel(dualMode)) return;
    config.multiModelAgentEnabled = Boolean(dualMode);

    if (config.multiModelAgentEnabled) {
        config.agentRunnerProvider = 'openai';
        config.agentRunnerModel = config.agentRunnerModel || 'gpt-5-mini';
        config.agentPlannerOpenAIModel = config.agentPlannerOpenAIModel || 'gpt-4o-mini';
        config.agentPlannerGeminiModel = config.agentPlannerGeminiModel || 'gemini-2.5-flash';

        const plannerProvider = config.aiModel === 'gemini' ? 'gemini' : 'openai';
        const plannerModel = plannerProvider === 'gemini'
            ? config.agentPlannerGeminiModel
            : config.agentPlannerOpenAIModel;

        p.note(
            `Planner: ${plannerProvider}/${plannerModel}\nRunner: openai/${config.agentRunnerModel}`,
            'Dual-Model Routing'
        );

        if (!config.openaiKey) {
            p.log.warn('OpenAI key missing: dual-model runner (gpt-5-mini) will not activate until key is set.');
        }
        if (plannerProvider === 'gemini' && !config.geminiKey) {
            p.log.warn('Gemini key missing: planner will fall back to single-model behavior until key is set.');
        }
        if (plannerProvider === 'openai' && !config.openaiKey) {
            p.log.warn('OpenAI key missing: planner will fall back to single-model behavior until key is set.');
        }
    }

    const babysitEnabled = await p.confirm({
        message: `${g.arrow} Enable Babysit mode (user-guided browser assist)?`,
        initialValue: config.babysitModeEnabled !== false
    });
    if (p.isCancel(babysitEnabled)) return;
    config.babysitModeEnabled = Boolean(babysitEnabled);

    const babysitFollowCursor = await p.confirm({
        message: `${g.arrow} Babysit default: mirror user's cursor with Rex cursor?`,
        initialValue: config.babysitFollowCursor !== false
    });
    if (p.isCancel(babysitFollowCursor)) return;
    config.babysitFollowCursor = Boolean(babysitFollowCursor);

    const babysitModel = await p.select({
        message: `${g.arrow} Babysit notes model`,
        options: [
            { value: 'gpt-5-nano', label: 'gpt-5-nano (recommended lightweight observer)' },
            { value: 'gpt-4o-mini', label: 'gpt-4o-mini (higher quality, more cost)' },
            { value: 'gpt-5-mini', label: 'gpt-5-mini (best quality of the three)' }
        ],
        initialValue: config.babysitNotesModel || 'gpt-5-nano'
    });
    if (p.isCancel(babysitModel)) return;
    config.babysitNotesModel = babysitModel;

    const babysitPromptExtensionEnabled = await p.confirm({
        message: `${g.arrow} Enable Babysit popup extension prompts?`,
        initialValue: config.babysitPromptExtensionEnabled !== false
    });
    if (p.isCancel(babysitPromptExtensionEnabled)) return;
    config.babysitPromptExtensionEnabled = Boolean(babysitPromptExtensionEnabled);

    const babysitAutoSnapshotMs = await p.text({
        message: `${g.arrow} Babysit auto snapshot interval (ms)`,
        initialValue: String(config.babysitAutoSnapshotMs || 18000)
    });
    if (!p.isCancel(babysitAutoSnapshotMs)) config.babysitAutoSnapshotMs = Number(babysitAutoSnapshotMs);

    const voiceMode = await p.confirm({
        message: `${g.arrow} Enable Voice Mode (Rex speaks responses aloud using high-quality AI voice)?`,
        initialValue: Boolean(config.voiceEnabled)
    });
    if (p.isCancel(voiceMode)) return;
    config.voiceEnabled = Boolean(voiceMode);

    const showInternalLogs = await p.confirm({
        message: `${g.arrow} Show internal tool logs (detailed reasoning)?`,
        initialValue: Boolean(config.showInternalToolLogs)
    });
    if (!p.isCancel(showInternalLogs)) config.showInternalToolLogs = Boolean(showInternalLogs);

    const budgetMode = await p.select({
        message: `${g.arrow} Web Agent budget mode`,
        options: [
            { value: 'low', label: 'Low (Cheaper, potential errors)' },
            { value: 'balanced', label: 'Balanced (Standard)' },
            { value: 'max-quality', label: 'Max Quality (Heavy token usage)' }
        ],
        initialValue: config.webAgentBudgetMode || 'balanced'
    });
    if (!p.isCancel(budgetMode)) config.webAgentBudgetMode = budgetMode;

    const progressLogs = await p.confirm({
        message: `${g.arrow} Show Auto-Pilot progress logs?`,
        initialValue: Boolean(config.showAutoPilotProgressLogs)
    });
    if (!p.isCancel(progressLogs)) config.showAutoPilotProgressLogs = Boolean(progressLogs);

    p.note(
        `Babysit: ${config.babysitModeEnabled ? 'enabled' : 'disabled'}\n` +
        `Follow cursor default: ${config.babysitFollowCursor ? 'on' : 'off'}\n` +
        `Notes model: ${config.babysitNotesModel}\n` +
        `Popup extension: ${config.babysitPromptExtensionEnabled ? 'enabled' : 'disabled'}\n` +
        `Auto snapshot interval: ${config.babysitAutoSnapshotMs}ms`,
        'Babysit Configuration'
    );

    
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

async function showComprehensiveHelp() {
    console.clear();
    console.log('');
    console.log(`  ${brandTheme('rex')}${pc.dim(' · commands')}`);
    console.log(`  ${pc.dim(`v${pkg.version}  ·  ${platformLabel}`)}`);
    console.log('');
    console.log(sectionRule());

    const sections = [
        {
            title: 'ai',
            commands: [
                { cmd: 'rexai chat', desc: 'Interactive agent loop' },
                { cmd: 'rexai ask-ai <prompt>', desc: 'Direct question to AI' },
                { cmd: 'rexai x <cmd>', desc: 'Shell command with self-healing' },
                { cmd: 'rexai review', desc: 'AI code review' },
                { cmd: 'rexai sql', desc: 'SQL from natural language' },
                { cmd: 'rexai regex', desc: 'RegEx from description' }
            ]
        },
        {
            title: 'project',
            commands: [
                { cmd: 'rexai health', desc: 'Project health scan' },
                { cmd: 'rexai doctor', desc: 'Diagnose and safe-fix' },
                { cmd: 'rexai scaffold', desc: 'Quick file scaffold' },
                { cmd: 'rexai project-scaffold', desc: 'Full project boilerplate' },
                { cmd: 'rexai env', desc: '.env.example from .env' },
                { cmd: 'rexai docs', desc: 'HTML documentation' },
                { cmd: 'rexai slides', desc: 'Markdown to slides' },
                { cmd: 'rexai translate', desc: 'Translate source files' }
            ]
        },
        {
            title: 'devops',
            commands: [
                { cmd: 'rexai push', desc: 'Git stage, commit, push' },
                { cmd: 'rexai docker-push', desc: 'Docker build and push' },
                { cmd: 'rexai deploy', desc: 'Cloud deployment' },
                { cmd: 'rexai share <port>', desc: 'Public tunnel for local port' },
                { cmd: 'rexai os-agent', desc: 'Windows OS automation' },
                { cmd: 'rexai hook install', desc: 'AI git commit hooks' },
                { cmd: 'rexai plugins', desc: 'Community plugins' }
            ]
        },
        {
            title: 'chat commands',
            commands: [
                { cmd: '/save <name>', desc: 'Save session' },
                { cmd: '/load <name>', desc: 'Reload session' },
                { cmd: '/history [q]', desc: 'Search sessions' },
                { cmd: '/workflow [w]', desc: 'Run workflows' },
                { cmd: '/profile [p]', desc: 'Switch profiles' },
                { cmd: '/plan [args]', desc: 'Planner controls' },
                { cmd: '/index', desc: 'Re-index project' },
                { cmd: '/help', desc: 'Help' }
            ]
        },
        {
            title: 'context',
            commands: [
                { cmd: '@file:path', desc: 'Inject file into prompt' },
                { cmd: '@url:link', desc: 'Fetch web content into prompt' },
                { cmd: '| rexai chat', desc: 'Pipe terminal output' }
            ]
        },
        {
            title: 'flags',
            commands: [
                { cmd: '--debug', desc: 'Show prompt and token costs' },
                { cmd: '--readonly', desc: 'Block write tools' },
                { cmd: '--plan', desc: 'Structured plan mode' },
                { cmd: '--plan-max-steps <n>', desc: 'Max autonomous steps (default 12)' },
                { cmd: '--model <m>', desc: 'Override model per-session' },
                { cmd: '--attach <g>', desc: 'Attach files by glob' }
            ]
        }
    ];

    for (const section of sections) {
        console.log(`\n  ${pc.dim(section.title)}`);
        for (const item of section.commands) {
            console.log(`    ${pc.cyan(item.cmd.padEnd(26))} ${pc.dim(item.desc)}`);
        }
    }

    console.log(`\n  ${pc.dim('tip: rexai open for interactive mode')}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

