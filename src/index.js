#!/usr/bin/env node
import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { Command } from 'commander';
import { loadConfig, saveConfig } from './config.js';
import figlet from 'figlet';
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
        .command('keep-a-look')
        .alias('look')
        .description('Monitor a webpage for changes/conditions and trigger goals')
        .option('--url <url>', 'Webpage URL to monitor')
        .option('--condition <condition>', 'Condition to watch for (optional)')
        .option('--action <action>', 'Goal to execute once condition is met')
        .option('--interval <seconds>', 'Check interval in seconds (default: 30)')
        .option('--selector <selector>', 'CSS selector to narrow down monitoring (optional)')
        .option('--headless', 'Run browser in headless mode')
        .action(async (opts) => {
            const { keep_a_look } = await import('./webTools.js');
            const url = opts.url || await p.text({
                message: 'Webpage URL to monitor:',
                placeholder: 'https://example.com/tickets',
                validate: (v) => !v.trim() ? 'URL is required.' : undefined
            });
            if (p.isCancel(url)) process.exit(0);

            const condition = opts.condition !== undefined ? opts.condition : await p.text({
                message: 'Condition to watch for (optional, leave empty for any change):',
                placeholder: 'tickets are available'
            });
            if (p.isCancel(condition)) process.exit(0);

            const action = opts.action || await p.text({
                message: 'Goal to execute once condition is met:',
                placeholder: 'add 2 to checkout and take a screenshot of QR code',
                validate: (v) => !v.trim() ? 'Goal is required.' : undefined
            });
            if (p.isCancel(action)) process.exit(0);

            const intervalSeconds = opts.interval ? Number(opts.interval) : 30;
            const selector = opts.selector || '';
            const headless = opts.headless === true;

            p.note(`Starting Keep-A-Look monitor job...\nURL: ${url}\nWatching: ${condition || 'Any content change'}\nAction: ${action}`, 'Keep-A-Look');

            try {
                const res = await keep_a_look({
                    url: url.trim(),
                    condition: condition ? condition.trim() : undefined,
                    action: action.trim(),
                    intervalSeconds,
                    selector: selector ? selector.trim() : undefined,
                    headless
                });
                p.note(res, 'Keep-A-Look Done');
            } catch (err) {
                p.log.error(`Keep-A-Look Error: ${err.message}`);
            }
            process.exit(0);
        });

    program
        .command('screen [prompt...]')
        .description('JARVIS Screen Vision: capture and analyze display with Gemini 3.5 Flash')
        .option('--voice', 'Speak the analysis aloud using Cartesia TTS')
        .action(async (promptArr, opts) => {
            const { analyzeScreen } = await import('./vision.js');
            const prompt = promptArr && promptArr.length ? promptArr.join(' ') : null;
            const s = p.spinner();
            s.start('Rex is observing your screen (JARVIS Vision)...');
            try {
                const res = await analyzeScreen(null, prompt, { speak: Boolean(opts.voice) });
                s.stop('Screen analysis complete.');
                p.note(res, 'Rex Vision (JARVIS)');
            } catch (err) {
                s.stop(pc.red('Vision failed: ' + err.message));
            }
            process.exit(0);
        });

    program
        .command('butler [action]')
        .description('Alfred Butler: proactive executive steward (on | off | briefing | status)')
        .action(async (action) => {
            const { toggleAlfredButler, generateMorningBriefing, speakBriefing, getSystemVitals, getWorkspaceIntel } = await import('./alfredButler.js');
            const act = (action || '').toLowerCase().trim();
            if (act === 'on') {
                const msg = await toggleAlfredButler(true);
                p.note(msg, 'Alfred Butler');
            } else if (act === 'off') {
                const msg = await toggleAlfredButler(false);
                p.note(msg, 'Alfred Butler');
            } else if (act === 'status' || act === 'vitals') {
                const [v, g] = await Promise.all([getSystemVitals(), getWorkspaceIntel()]);
                const details = [
                    `🔋 Battery: ${v.batteryPercent !== null ? v.batteryPercent + '% (' + v.powerSource + ')' : 'N/A'}`,
                    `⚙️ CPU Load: ${v.loadAvg.toFixed(2)} (${v.cpuCores} cores)`,
                    `💾 Memory: ${v.freeMemMB}MB free / ${v.totalMemMB}MB total`,
                    `📁 Workspace: ${g.branch ? 'Branch "' + g.branch + '" (' + g.uncommittedCount + ' uncommitted changes)' : 'Not in git'}`
                ].join('\n');
                p.note(details, 'Alfred System Vitals');
            } else {
                const s = p.spinner();
                s.start('Preparing Alfred executive briefing...');
                const briefing = await generateMorningBriefing();
                s.stop('Briefing ready.');
                p.note(briefing.text, briefing.greeting);
                await speakBriefing(briefing.text);
            }
            process.exit(0);
        });

    program
        .command('mac <action> [extra...]')
        .description('Execute macOS AppleScript automation (volume, media, notify, lock, open, tab, raw)')
        .action(async (action, extra) => {
            const { executeAppleScript, macSystem, macMedia, macApps, macBrowsers } = await import('./appleScript.js');
            const act = String(action || '').toLowerCase().trim();
            const arg = extra && extra.length ? extra.join(' ') : '';

            if (act === 'volume') {
                const vol = parseInt(arg, 10);
                const res = isNaN(vol) ? await macSystem.getVolume() : await macSystem.setVolume(vol);
                p.note(typeof res === 'number' ? `Current volume: ${res}%` : res, 'macOS Volume');
            } else if (act === 'mute') {
                const res = await macSystem.setMute(arg !== 'off');
                p.note(res, 'macOS Mute');
            } else if (act === 'notify') {
                await macSystem.displayNotification(arg || 'Hello from Rex!');
                p.note(pc.green(`Notification sent: "${arg}"`), 'macOS Notification');
            } else if (act === 'lock') {
                await macSystem.lockScreen();
                p.note(pc.green('Screen locked.'), 'macOS Security');
            } else if (act === 'media') {
                if (arg === 'play') await macMedia.play();
                else if (arg === 'pause') await macMedia.pause();
                else if (arg === 'next') await macMedia.next();
                else if (arg === 'prev' || arg === 'previous') await macMedia.previous();
                else if (arg === 'track') {
                    const tr = await macMedia.getCurrentTrack();
                    p.note(tr ? `${tr.app}: ${tr.name} by ${tr.artist} (${tr.album}) [${tr.state}]` : 'No track playing.', 'Now Playing');
                    process.exit(0);
                } else await macMedia.playPause();
                const tr = await macMedia.getCurrentTrack();
                p.note(tr ? `${tr.app}: ${tr.name} by ${tr.artist} [${tr.state}]` : 'Media command dispatched.', 'Media Control');
            } else if (act === 'open') {
                const res = await macApps.openApp(arg);
                p.note(res.success ? `Opened ${arg}` : res.error, 'macOS App');
            } else if (act === 'tab') {
                const tab = await macBrowsers.getActiveTab();
                p.note(tab ? `[${tab.browser}] ${tab.title}\n${tab.url}` : 'No active browser window detected.', 'Active Browser Tab');
            } else {
                const fullScript = [action, ...extra].join(' ');
                const res = await executeAppleScript(fullScript);
                if (res.success) {
                    p.note(res.output || 'AppleScript executed successfully.', 'AppleScript Output');
                } else {
                    p.log.error(res.error);
                }
            }
            process.exit(0);
        });

    program
        .command('dossier')
        .description('View Alfred Personal Knowledge Graph & Dossier on user')
        .action(async () => {
            const { getButlerDossier } = await import('./personalMemory.js');
            p.note(getButlerDossier(), 'Alfred Personal Dossier');
            process.exit(0);
        });

    program
        .command('remember <fact...>')
        .description('Commit a personal fact to Rex persistent memory graph')
        .action(async (factArr) => {
            const { rememberFact } = await import('./personalMemory.js');
            const fact = factArr.join(' ');
            const res = rememberFact(fact);
            p.note(pc.green(res), 'Personal Knowledge Graph');
            process.exit(0);
        });

    program
        .command('listen')
        .description('Start JARVIS Local Desktop Hands-Free Voice Assistant')
        .action(async () => {
            const { startDesktopVoiceAssistant } = await import('./voiceAssistant.js');
            await startDesktopVoiceAssistant();
        });

    program
        .command('mascot')
        .alias('pet')
        .description('Start the Retro 8-Bit Desktop Mascot Companion (docked in bottom-left)')
        .option('--port <port>', 'Port to serve mascot on', '19888')
        .option('--no-open', 'Do not automatically open desktop window')
        .option('--screen', 'Also launch persistent macOS full-screen cursor')
        .action(async (opts) => {
            const { startDesktopMascot } = await import('./desktopMascot.js');
            await startDesktopMascot({
                port: parseInt(opts.port, 10) || 19888,
                openBrowser: opts.open !== false,
                screenCursor: Boolean(opts.screen)
            });
        });

    program
        .command('cursor [action]')
        .alias('screen-cursor')
        .description('Start or control Rex macOS Persistent Screen Cursor (Second Cursor across entire display)')
        .option('--mode <mode>', 'Cursor mode: follow | autonomous | idle', 'follow')
        .option('--appearance <appearance>', 'Appearance: both | dino | cursor', 'both')
        .option('--style <style>', 'Icon style: default | handpointing | beachball | busy | handopen', 'default')
        .action(async (action, opts) => {
            const act = String(action || '').toLowerCase();
            const {
                startScreenCursor,
                stopScreenCursor,
                isScreenCursorRunning,
                runCursorDemoTour,
                cursorMenu,
                cursorSpeak
            } = await import('./screenCursor.js');
            const { ensureMacosPermissions } = await import('./macosPermissions.js');

            if (act === 'start') {
                await startScreenCursor({
                    mode: opts.mode,
                    appearance: opts.appearance,
                    style: opts.style,
                    checkPermissions: true
                });
            } else if (act === 'follow') {
                await startScreenCursor({
                    mode: 'follow',
                    appearance: opts.appearance,
                    style: opts.style,
                    checkPermissions: true
                });
            } else if (act === 'stop') {
                stopScreenCursor();
                p.log.success('Rex Screen Cursor stopped.');
            } else if (act === 'status') {
                p.note(`Running: ${isScreenCursorRunning() ? pc.green('ACTIVE') : pc.yellow('STOPPED')}`, 'Rex Screen Cursor');
            } else if (act === 'demo' || act === 'test' || act === 'tour') {
                await runCursorDemoTour();
            } else if (act === 'listen' || act === 'voice') {
                const { triggerVoiceCommand } = await import('./screenCursor.js');
                p.log.info(pc.cyan('🎙️ Listening... Speak your command for Rex to figure out on your screen!'));
                await triggerVoiceCommand();
            } else if (act === 'permissions' || act === 'perms') {
                await ensureMacosPermissions({ silent: false });
            } else if (act === 'speak') {
                const text = process.argv.slice(4).join(' ') || 'Rawr! I am Rex! 🦖';
                if (!isScreenCursorRunning()) await startScreenCursor({ silent: true });
                cursorSpeak(text);
                p.log.success(`Rex spoke on screen: "${text}"`);
            } else if (act === 'emotion' || act === 'mood') {
                const emotion = process.argv[4] || 'happy';
                const { setCursorEmotion } = await import('./screenCursor.js');
                if (!isScreenCursorRunning()) await startScreenCursor({ silent: true });
                setCursorEmotion(emotion);
                p.log.success(`Rex cursor emotion set to: ${pc.cyan(emotion)}`);
            } else {
                await cursorMenu();
            }
        });

    program
        .command('permissions')
        .alias('perms')
        .description('Check and request macOS system permissions (Accessibility & Screen Recording)')
        .action(async () => {
            const { ensureMacosPermissions } = await import('./macosPermissions.js');
            await ensureMacosPermissions({ silent: false });
            process.exit(0);
        });

    program
        .command('daemon [action]')
        .description('Manage Alfred Proactive Background Daemon (start, stop, status, run)')
        .action(async (action) => {
            const act = String(action || 'status').toLowerCase();
            const { startDaemon, stopDaemon, getDaemonStatus, runHeartbeatWorker } = await import('./daemon.js');
            if (act === 'start') {
                const msg = startDaemon();
                p.note(msg, 'Alfred Daemon');
            } else if (act === 'stop') {
                const msg = stopDaemon();
                p.note(msg, 'Alfred Daemon');
            } else if (act === 'run') {
                await runHeartbeatWorker();
            } else {
                const status = getDaemonStatus();
                p.note(status.running ? pc.green(`Daemon is ACTIVE (PID: ${status.pid})`) : pc.yellow('Daemon is STOPPED'), 'Alfred Daemon Status');
            }
            process.exit(0);
        });

    program
        .command('whatsapp [action]')
        .description('Start or configure Rex WhatsApp Bot Companion (Linked Device)')
        .action(async (action) => {
            const act = String(action || 'start').toLowerCase();
            const { startWhatsAppBot, whatsappConfigMenu } = await import('./whatsappBot.js');
            if (act === 'config' || act === 'settings') {
                await whatsappConfigMenu();
            } else {
                await startWhatsAppBot();
            }
        });

    program
        .command('bridge [action]')
        .description('Manage Web Agent Architect Chrome extension HTTP/AI Bridge')
        .action(async (action) => {
            const act = String(action || 'start').toLowerCase();
            const { startBrowserBridge, getExtensionBridgeStatus } = await import('./browserBridge.js');
            if (act === 'status') {
                const stat = getExtensionBridgeStatus();
                p.note(stat.serverRunning ? pc.green(`Bridge Server: Online\nExtension Connected: ${stat.extensionAlive}`) : pc.yellow('Bridge Server: Stopped'), 'Chrome Extension Bridge');
            } else {
                const res = startBrowserBridge(8787);
                p.note(pc.green(res.message), 'Chrome Extension Bridge');
            }
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
            // Auto-start active in-browser Chrome extension bridge on 8787 by default
            try {
                const { startBrowserBridge } = await import('./browserBridge.js');
                startBrowserBridge(8787);
            } catch {}

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

    program
        .command('preflight [url]')
        .description('Scan a website and generate navigation specs, SDKs, and agent tools')
        .option('--name <name>', 'Project name (defaults to hostname)')
        .option('--setup', 'Set up the Preflight Designer Python environment')
        .action(async (url, opts) => {
            const { isVenvReady, ensurePreflightVenv, runPreflightScan, formatScanSummary, copySpecsToOutput, preflightMenu } = await import('./preflightDesigner.js');

            if (opts.setup) {
                const s = p.spinner();
                s.start('Setting up Preflight Designer environment...');
                const result = await ensurePreflightVenv();
                s.stop(result.ok ? pc.green(`✓ ${result.message}`) : pc.red(`✗ ${result.message}`));
                process.exit(result.ok ? 0 : 1);
            }

            if (!url) {
                await preflightMenu();
                process.exit(0);
            }

            // Ensure venv
            if (!isVenvReady()) {
                const s = p.spinner();
                s.start('Setting up Preflight Designer environment (first run)...');
                const setup = await ensurePreflightVenv();
                if (!setup.ok) {
                    s.stop(pc.red(`✗ ${setup.message}`));
                    process.exit(1);
                }
                s.stop(pc.green('✓ Environment ready.'));
            }

            const s = p.spinner();
            s.start(`Scanning ${url}...`);
            try {
                const result = await runPreflightScan(url, { name: opts.name });
                s.stop('Scan complete.');
                console.log(formatScanSummary(result));

                if (result.ok) {
                    const path = await import('path');
                    const outDir = path.join(process.cwd(), '.rex', 'preflight-specs', result.project_name);
                    const copied = copySpecsToOutput(outDir);
                    p.log.success(`Specs written to ${outDir} (${copied.length} files)`);
                }
            } catch (e) {
                s.stop(pc.red(`✗ Scan failed: ${e.message}`));
            }
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
    
    console.log('');
    console.log(gradient(['#0EA5E9', '#2563EB'])(figlet.textSync('REXAI')));
    console.log(`  ${pc.cyan(pc.bold('Your Autonomous AI Intern'))}`);
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
                            { value: 'cursor',      label: menuLabel('cur', 'Rex Screen Cursor (macOS 2nd Cursor)') },
                            { value: 'share',       label: menuLabel('shr', 'Share Port') },
                            { value: 'hooks',       label: menuLabel('hok', 'Git Hooks') },
                            { value: 'plugins',     label: menuLabel('plg', 'Plugins') },
                            { value: 'back',        label: pc.dim('  back') }
                        ]
                    });
                    if (p.isCancel(powerAction) || powerAction === 'back') break;

                    if (powerAction === 'cursor') { const { cursorMenu } = await import('./screenCursor.js'); await cursorMenu(); }
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
                            { value: 'cursor',     label: menuLabel('cur', 'Rex Screen Cursor (macOS 2nd Cursor)') },
                            { value: 'mascot',     label: menuLabel('pet', 'Retro 8-Bit Mascot Companion (Desktop Pet)') },
                            { value: 'discord',    label: menuLabel('bot', 'Start Discord Bot Companion') },
                            { value: 'telegram',   label: menuLabel('tg',  'Start Telegram Bot Companion') },
                            { value: 'whatsapp',   label: menuLabel('wa',  'Start WhatsApp Bot Companion (Linked Device)') },
                            { value: 'digest',     label: menuLabel('dgst','Daily Digest (Project Status)') },
                            { value: 'mood',       label: menuLabel('mood','Rex Mood Engine') },
                            { value: 'notif',      label: menuLabel('ntf', 'Notification Router') },
                            { value: 'reminders',  label: menuLabel('rmn', 'Reminders & Scheduling') },
                            { value: 'preflight',  label: menuLabel('pfl', 'Preflight Designer (Website Compiler)') },
                            { value: 'integrations', label: menuLabel('int', 'Integrations Config (Gmail, Notion, GitHub, Linear)') },
                            { value: 'back',       label: pc.dim('  back') }
                        ]
                    });
                    if (p.isCancel(labAction) || labAction === 'back') break;
                    
                    if (labAction === 'cursor') { const { cursorMenu } = await import('./screenCursor.js'); await cursorMenu(); }
                    if (labAction === 'nerve_map') { const { nerve_map } = await import('./cortexKit.js'); const res = await nerve_map({ directory: process.cwd() }); p.note(res, 'CortexKit'); }
                    if (labAction === 'mcp') { const { mcpMenu } = await import('./mcpManager.js'); await mcpMenu(); }
                    if (labAction === 'sentinel') { 
                        const { startProductionVisionServer } = await import('./server.js'); 
                        await startProductionVisionServer(); 
                        p.note(pc.green('Production Vision Sentinel is running in the background.'), 'Sentinel Server');
                    }
                    if (labAction === 'mascot') {
                        const { startDesktopMascot } = await import('./desktopMascot.js');
                        await startDesktopMascot();
                    }
                    if (labAction === 'discord') {
                        const { startDiscordBot } = await import('./discordBot.js');
                        await startDiscordBot();
                    }
                    if (labAction === 'telegram') {
                        const { startTelegramBot } = await import('./telegramBot.js');
                        await startTelegramBot();
                    }
                    if (labAction === 'whatsapp') {
                        const { startWhatsAppBot } = await import('./whatsappBot.js');
                        await startWhatsAppBot();
                    }
                    if (labAction === 'digest') {
                        const { showDailyDigest } = await import('./dailyDigest.js');
                        await showDailyDigest();
                    }
                    if (labAction === 'mood') {
                        const { showMoodMenu } = await import('./moodEngine.js');
                        await showMoodMenu();
                    }
                    if (labAction === 'notif') {
                        const { notificationRouterMenu } = await import('./notificationRouter.js');
                        await notificationRouterMenu();
                    }
                    if (labAction === 'reminders') {
                        const { remindersMenu } = await import('./reminders.js');
                        await remindersMenu();
                    }
                    if (labAction === 'integrations') {
                        const { integrationsConfigMenu } = await import('./integrations.js');
                        await integrationsConfigMenu();
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
                    if (labAction === 'preflight') {
                        const { preflightMenu } = await import('./preflightDesigner.js');
                        await preflightMenu();
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
            { value: 'gemini', label: '🟦 Google Gemini (Requires API Key) [gemini 3.5 flash | gemini 3.6flash | gemini 3.7 flash - lite]' },
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
                    { value: 'gemini-3.5-flash', label: 'gemini 3.5 flash (best quality)' },
                    { value: 'gemini-3.6-flash', label: 'gemini 3.6flash (stable + fast)' },
                    { value: 'gemini-3.7-flash-lite', label: 'gemini 3.7 flash - lite (cheapest / fastest)' }
                ],
                initialValue: config.geminiModel || 'gemini-3.5-flash'
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
        config.agentPlannerGeminiModel = config.agentPlannerGeminiModel || 'gemini-3.5-flash';

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
                { cmd: 'rexai preflight <url>', desc: 'Scan site → generate nav specs + SDKs' },
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

