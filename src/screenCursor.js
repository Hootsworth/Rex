import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import util from 'util';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { ensureMacosPermissions, checkMacosPermissions } from './macosPermissions.js';

const execAsync = util.promisify(exec);

const NATIVE_DIR = path.join(process.cwd(), 'src', 'native');
const BIN_DIR = path.join(NATIVE_DIR, 'bin');
const BIN_PATH = path.join(BIN_DIR, 'rex-cursor-overlay');
const WINDOW_BOUNDS_BIN = path.join(BIN_DIR, 'rex-window-bounds');
const AX_INSPECT_BIN = path.join(BIN_DIR, 'rex-ax-inspect');
const SWIFT_SRC = path.join(NATIVE_DIR, 'RexScreenCursor.swift');
const WINDOW_BOUNDS_SRC = path.join(NATIVE_DIR, 'rex-window-bounds.swift');
const AX_INSPECT_SRC = path.join(NATIVE_DIR, 'rex-ax-inspect.swift');

let overlayProcess = null;
let overlayRl = null;
let currentMode = 'follow';
let currentAppearance = 'both';
let currentStyle = 'default';
let screenDimensions = { width: 1470, height: 956 };
let readyPromiseResolver = null;
let isStarting = false;
let onBargeInCallback = null;

/**
 * Ensure native swift binaries are compiled.
 */
export async function ensureNativeBinary() {
    if (process.platform !== 'darwin') return false;

    if (!fs.existsSync(BIN_DIR)) {
        fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    const cacheDir = path.join(process.cwd(), '.rex', 'cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    let overlayOk = fs.existsSync(BIN_PATH);
    if (!overlayOk && fs.existsSync(SWIFT_SRC)) {
        const s = p.spinner();
        s.start('Compiling native Rex macOS Screen Cursor overlay...');
        try {
            const cmd = `swiftc -O -module-cache-path "${cacheDir}" "${SWIFT_SRC}" -o "${BIN_PATH}"`;
            await execAsync(cmd, { timeout: 30000 });
            s.stop(pc.green('✔ Compiled Rex Screen Cursor native overlay engine.'));
            overlayOk = true;
        } catch (err) {
            s.stop(pc.red(`✖ Failed to compile Swift overlay: ${err.message}`));
            return false;
        }
    }

    if (!fs.existsSync(WINDOW_BOUNDS_BIN) && fs.existsSync(WINDOW_BOUNDS_SRC)) {
        try {
            const cmd = `swiftc -O -module-cache-path "${cacheDir}" "${WINDOW_BOUNDS_SRC}" -o "${WINDOW_BOUNDS_BIN}"`;
            await execAsync(cmd, { timeout: 15000 });
        } catch {}
    }

    if (!fs.existsSync(AX_INSPECT_BIN) && fs.existsSync(AX_INSPECT_SRC)) {
        try {
            const cmd = `swiftc -O -module-cache-path "${cacheDir}" "${AX_INSPECT_SRC}" -o "${AX_INSPECT_BIN}"`;
            await execAsync(cmd, { timeout: 15000 });
        } catch {}
    }

    return overlayOk;
}

/**
 * Retrieve current screen dimensions in logical macOS points.
 */
export function getScreenDimensions() {
    return { ...screenDimensions };
}

/**
 * Get dynamic window frame (x, y, width, height) of target application or frontmost window.
 */
export async function getTargetWindowBounds(appName = '') {
    if (process.platform !== 'darwin') {
        return {
            found: false,
            owner: appName || 'macOS Desktop',
            x: 0,
            y: 0,
            width: screenDimensions.width,
            height: screenDimensions.height,
            screenWidth: screenDimensions.width,
            screenHeight: screenDimensions.height
        };
    }

    if (fs.existsSync(WINDOW_BOUNDS_BIN)) {
        try {
            const cleanApp = String(appName || '').replace(/"/g, '\\"');
            const { stdout } = await execAsync(`"${WINDOW_BOUNDS_BIN}" "${cleanApp}"`, { timeout: 2000 });
            const data = JSON.parse(stdout.trim());
            if (data?.screenWidth && data?.screenHeight) {
                screenDimensions = { width: data.screenWidth, height: data.screenHeight };
            }
            if (data?.found) {
                return data;
            }
        } catch {}
    }

    // Default to main display frame minus top macOS menu bar
    return {
        found: false,
        owner: appName || 'macOS Desktop',
        x: 0,
        y: 33,
        width: screenDimensions.width,
        height: Math.max(500, screenDimensions.height - 33),
        screenWidth: screenDimensions.width,
        screenHeight: screenDimensions.height
    };
}

/**
 * Check if the screen cursor overlay is currently running.
 */
export function isScreenCursorRunning() {
    return overlayProcess !== null && !overlayProcess.killed;
}

/**
 * Start the Rex macOS Full-Screen Persistent Cursor.
 * @param {object} options
 * @param {'follow'|'autonomous'|'idle'} [options.mode='follow']
 * @param {'both'|'dino'|'cursor'} [options.appearance='both']
 * @param {string} [options.style='default']
 * @param {boolean} [options.checkPermissions=true]
 * @param {boolean} [options.silent=false]
 */
export async function startScreenCursor(options = {}) {
    if (process.platform !== 'darwin') {
        p.log.warn('Rex Screen Cursor overlay is designed for macOS.');
        return { ok: false, error: 'macOS only' };
    }

    if (isScreenCursorRunning()) {
        if (!options.silent) p.log.info(pc.yellow('Rex Screen Cursor is already running across your display.'));
        if (options.mode) setCursorMode(options.mode);
        if (options.appearance) setCursorAppearance(options.appearance);
        if (options.style) setCursorStyle(options.style);
        return { ok: true, alreadyRunning: true, dimensions: screenDimensions };
    }

    if (isStarting) return { ok: true, starting: true };
    isStarting = true;

    try {
        // 1. Check & Request Permissions
        if (options.checkPermissions !== false) {
            const perms = await ensureMacosPermissions({ silent: options.silent });
            if (!perms.allGranted && !options.silent) {
                p.log.warn(pc.yellow('⚠️ Proceeding with available permissions. For full features (global mouse tracking & vision), enable Accessibility & Screen Recording in System Settings.'));
            }
        }

        // 2. Ensure native binary is compiled
        const compiled = await ensureNativeBinary();
        if (!compiled) {
            isStarting = false;
            return { ok: false, error: 'Compilation failed' };
        }

        // 3. Spawn native overlay process
        const readyPromise = new Promise((resolve, reject) => {
            readyPromiseResolver = resolve;
            const timeout = setTimeout(() => {
                if (isStarting) {
                    resolve({ ok: true, dimensions: screenDimensions });
                }
            }, 6000);
            readyPromiseResolver._timeout = timeout;
        });

        overlayProcess = spawn(BIN_PATH, [], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        currentMode = options.mode || 'follow';
        currentAppearance = options.appearance || 'both';
        currentStyle = options.style || 'default';

        overlayRl = readline.createInterface({
            input: overlayProcess.stdout,
            crlfDelay: Infinity
        });

        overlayRl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) return;
            try {
                const event = JSON.parse(trimmed);
                if (event.event === 'ready') {
                    screenDimensions = { width: event.screenWidth, height: event.screenHeight };
                    if (readyPromiseResolver) {
                        clearTimeout(readyPromiseResolver._timeout);
                        readyPromiseResolver({ ok: true, dimensions: screenDimensions });
                        readyPromiseResolver = null;
                    }
                } else if (event.event === 'hotkeyTriggered') {
                    console.log(pc.magenta(`\n⚡ Hotkey (${event.shortcut || 'Control+Shift+Space'}) detected! Activating Rex Voice Copilot...`));
                    import('./cursorVoiceAgent.js').then(m => {
                        m.triggerVoiceCommand({ dimensions: screenDimensions });
                    }).catch(console.error);
                } else if (event.event === 'bargeIn') {
                    console.log(pc.yellow(`\n🛑 Emergency Brake / User Barge-In detected (${event.reason || 'user intervention'}). Yielding control.`));
                    if (onBargeInCallback) {
                        try { onBargeInCallback(event); } catch {}
                    }
                }
            } catch {}
        });

        // Start uiohook hotkey fallback listener
        startGlobalHotkeyListener().catch(() => {});

        overlayProcess.stderr.on('data', () => {});

        overlayProcess.on('exit', () => {
            overlayProcess = null;
            overlayRl = null;
            isStarting = false;
        });

        process.on('exit', () => {
            stopScreenCursor();
        });

        await readyPromise;
        isStarting = false;

        // Configure initial state
        setCursorMode(currentMode);
        setCursorAppearance(currentAppearance);
        setCursorStyle(currentStyle);

        if (!options.silent) {
            console.log(pc.green(`\n🦖 Rex macOS Persistent Screen Cursor is active across all screens! (Mode: ${currentMode}, Appearance: ${currentAppearance})\n`));
        }

        return { ok: true, dimensions: screenDimensions };
    } catch (err) {
        isStarting = false;
        return { ok: false, error: err.message };
    }
}

/**
 * Send a JSON command to the overlay process via stdin.
 */
function sendCommand(cmdObj) {
    if (!isScreenCursorRunning() || !overlayProcess.stdin.writable) return false;
    try {
        overlayProcess.stdin.write(JSON.stringify(cmdObj) + '\n');
        return true;
    } catch {
        return false;
    }
}

let uiohookActive = false;
async function startGlobalHotkeyListener() {
    if (uiohookActive || process.platform === 'darwin') return;
    try {
        const { uIOhook, UiohookKey } = await import('uiohook-napi');
        let ctrlPressed = false;
        let shiftPressed = false;

        uIOhook.on('keydown', (e) => {
            if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) {
                ctrlPressed = true;
            }
            if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftRight) {
                shiftPressed = true;
            }
            // Control + Shift + Space OR Control + Shift + R
            if ((e.keycode === UiohookKey.Space || e.keycode === UiohookKey.R) && ctrlPressed && shiftPressed) {
                console.log(pc.magenta('\nGlobal Hotkey (Control + Shift + Space) triggered! Activating Rex Voice Copilot...'));
                import('./cursorVoiceAgent.js').then(m => {
                    m.triggerVoiceCommand({ dimensions: screenDimensions });
                }).catch(() => {});
            }
        });

        uIOhook.on('keyup', (e) => {
            if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) {
                ctrlPressed = false;
            }
            if (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftRight) {
                shiftPressed = false;
            }
        });

        try {
            uIOhook.start();
            uiohookActive = true;
        } catch {}
    } catch {}
}

/**
 * Stop and terminate the Rex Screen Cursor overlay.
 */
export function stopScreenCursor() {
    if (uiohookActive) {
        try {
            import('uiohook-napi').then(({ uIOhook }) => {
                uIOhook.stop();
                uiohookActive = false;
            }).catch(() => {});
        } catch {}
    }
    if (overlayProcess) {
        sendCommand({ cmd: 'quit' });
        try {
            overlayProcess.kill('SIGTERM');
        } catch {}
        overlayProcess = null;
        overlayRl = null;
    }
}

/**
 * Register a listener for user emergency brake / barge-in.
 * @param {function} fn
 */
export function onUserBargeIn(fn) {
    onBargeInCallback = fn;
}

/**
 * Pause autonomous takeover and yield control to user.
 */
export function pauseScreenCursor() {
    return sendCommand({ cmd: 'pause' });
}

/**
 * Resume autonomous takeover.
 */
export function resumeScreenCursor() {
    return sendCommand({ cmd: 'resume' });
}

/**
 * Enable or disable automatic barge-in detection.
 * @param {boolean} enabled
 */
export function setBargeInEnabled(enabled = true) {
    return sendCommand({ cmd: 'setBargeIn', enabled });
}

/**
 * Set Rex listening visual state (equalizer + mic indicator).
 */
export function setCursorListening(listening = true) {
    return sendCommand({ cmd: 'setListening', listening });
}

/**
 * Set Rex thinking visual state (gears / busy).
 */
export function setCursorThinking(thinking = true) {
    return sendCommand({ cmd: 'setThinking', thinking });
}

/**
 * Set Rex Mascot Emotion ('idle', 'happy', 'sad', 'angry', 'crying', 'sleepy', 'thinking', 'excited', 'shocked').
 * @param {'idle'|'happy'|'sad'|'angry'|'crying'|'sleepy'|'thinking'|'excited'|'shocked'} emotion
 */
export function setRexEmotion(emotion = 'idle') {
    return sendCommand({ cmd: 'setEmotion', emotion });
}

/**
 * Trigger voice recording & autonomous screen reasoning.
 */
export async function triggerVoiceCommand(opts) {
    const { triggerVoiceCommand: runVoice } = await import('./cursorVoiceAgent.js');
    return runVoice(opts || { dimensions: screenDimensions });
}

/**
 * Set the cursor mode.
 * @param {'follow'|'autonomous'|'idle'} mode
 */
export function setCursorMode(mode) {
    currentMode = mode;
    return sendCommand({ cmd: 'setMode', mode });
}

/**
 * Set cursor visual appearance.
 * @param {'both'|'dino'|'cursor'} appearance
 */
export function setCursorAppearance(appearance) {
    currentAppearance = appearance;
    return sendCommand({ cmd: 'setAppearance', appearance });
}

/**
 * Set the cursor icon style.
 * @param {'default'|'handpointing'|'handopen'|'handgrabbing'|'busy'|'beachball'|'copy'} style
 */
export function setCursorStyle(style) {
    currentStyle = style;
    return sendCommand({ cmd: 'setStyle', style });
}

/**
 * Move Rex to target screen coordinates with smooth animation.
 * @param {number} x Screen X coordinate
 * @param {number} y Screen Y coordinate
 * @param {number} [duration=300] Animation duration in ms
 * @param {string} [style='default']
 */
export function moveCursorTo(x, y, duration = 300, style = currentStyle) {
    return sendCommand({ cmd: 'moveTo', x, y, duration, style });
}

/**
 * Perform a real OS mouse click (or visual pulse) at given coordinates.
 * @param {number} [x]
 * @param {number} [y]
 * @param {string} [style='handpointing']
 * @param {boolean} [real=true] Whether to dispatch genuine macOS hardware input event
 * @param {'left'|'right'} [button='left']
 * @param {number} [count=1] 1 for single click, 2 for double click
 */
export function cursorClick(x, y, style = 'handpointing', real = true, button = 'left', count = 1) {
    return sendCommand({ cmd: 'click', x, y, style, real, button, count });
}

/**
 * Perform a real OS double-click at given coordinates.
 */
export function cursorDoubleClick(x, y, style = 'handpointing') {
    return sendCommand({ cmd: 'doubleClick', x, y, style });
}

/**
 * Perform a real OS right-click at given coordinates.
 */
export function cursorRightClick(x, y, style = 'handpointing') {
    return sendCommand({ cmd: 'rightClick', x, y, style });
}

/**
 * Perform a real OS mouse drag from one coordinate to another.
 */
export function cursorDrag(fromX, fromY, toX, toY, steps = 15) {
    return sendCommand({ cmd: 'drag', fromX, fromY, toX, toY, steps });
}

/**
 * Synthesize genuine keyboard typing into the active macOS input/window.
 * @param {string} text Text to type
 */
export function cursorType(text) {
    return sendCommand({ cmd: 'typeText', text });
}

/**
 * Dispatch a specific key press or key combination (e.g. 'return', 'tab', 'escape', 'space').
 * @param {string} key
 * @param {string[]} [modifiers=[]] ['cmd', 'shift', 'opt', 'ctrl']
 */
export function cursorKeyPress(key, modifiers = []) {
    return sendCommand({ cmd: 'keyPress', key, modifiers });
}

/**
 * Bring a target application window to the front.
 * @param {string} app Application name (e.g. 'DaVinci Resolve', 'Google Chrome', 'Finder')
 */
export function cursorActivateApp(app) {
    if (!app) return false;
    let target = String(app).trim();
    const lower = target.toLowerCase();
    if (lower.includes('zen')) target = 'Zen';
    else if (lower.includes('chrome')) target = 'Google Chrome';
    else if (lower.includes('davinci')) target = 'DaVinci Resolve';
    else if (lower.includes('whatsapp') || lower.includes('wahsyapp')) target = 'WhatsApp';
    else if (lower.includes('vscode') || lower.includes('vs code') || lower === 'code') target = 'Visual Studio Code';

    sendCommand({ cmd: 'activateApp', app: target });

    try {
        const cmd = `osascript -e 'tell application "${target}" to activate' 2>/dev/null || open -a "${target}" 2>/dev/null || open -a "${app}" 2>/dev/null`;
        exec(cmd, () => {});
    } catch {}

    return true;
}

/**
 * Display a speech bubble from Rex directly on the macOS screen.
 * @param {string} text Message to display
 * @param {number} [duration=3500] Duration in ms
 * @param {string} [badge='COPILOT'] Badge label in glass card header
 */
export function cursorSpeak(text, duration = 3500, badge = 'COPILOT') {
    return sendCommand({ cmd: 'speak', text, duration, badge });
}

/**
 * Highlight a region of the screen with a neon dashed spotlight box and label.
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {string} [label='Rex Spotlight']
 */
export function cursorHighlight(x, y, w, h, label = 'Rex Spotlight') {
    return sendCommand({ cmd: 'highlight', x, y, w, h, label });
}

/**
 * Hide the active region spotlight box.
 */
export function hideCursorHighlight() {
    return sendCommand({ cmd: 'hideHighlight' });
}

/**
 * Run a multi-step interactive demo tour showcasing Rex as a second cursor across macOS.
 */
export async function runCursorDemoTour() {
    p.intro(pc.green('Launching Rex macOS Persistent Screen Cursor Demo Tour...'));

    const res = await startScreenCursor({ mode: 'autonomous', appearance: 'both' });
    if (!res.ok) {
        p.log.error(`Could not start cursor: ${res.error}`);
        return;
    }

    const { width, height } = screenDimensions;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const s = p.spinner();
    s.start('Rex is moving across your macOS screen...');

    // Step 1: Fly to top-left
    moveCursorTo(120, 100, 450, 'handpointing');
    await sleep(500);
    cursorSpeak("I am Rex, your persistent macOS assistant.", 3000, "REX");
    await sleep(2000);

    // Step 2: Highlight top area
    cursorHighlight(40, 40, 320, 140, "Menu Bar Area");
    await sleep(1500);
    hideCursorHighlight();

    // Step 3: Glide to center of screen with beachball/thinking
    s.message('Rex is moving to center...');
    moveCursorTo(width / 2, height / 2, 550, 'beachball');
    await sleep(650);
    cursorSpeak("I persist over all your macOS apps, full screen spaces, and windows.", 3200, "OVERLAY");
    await sleep(2200);

    // Step 4: Click ripple
    s.message('Triggering click pulse...');
    cursorClick(width / 2, height / 2, 'handpointing');
    await sleep(900);

    // Step 5: Switch to shadow follow mode
    s.message('Engaging Shadow Follow Mode: Rex will follow your cursor.');
    setCursorMode('follow');
    cursorSpeak("Move your mouse. I am now shadowing your cursor.", 4500, "FOLLOW");
    await sleep(4000);

    s.stop(pc.green('✔ Rex Screen Cursor Demo completed successfully!'));
    p.note(
        [
            'Rex is now active as a persistent second cursor on your Mac!',
            '• In Follow Mode: Rex tracks your mouse smoothly across Finder, VS Code, Browser, etc.',
            '• In Autonomous Mode: Rex navigates independently to click, inspect, and assist.',
            '• Run `rexai cursor stop` to close the overlay anytime.'
        ].join('\n'),
        'Rex Screen Cursor Active'
    );
}

/**
 * Interactive CLI menu for controlling Rex Screen Cursor.
 */
export async function cursorMenu() {
    const isRunning = isScreenCursorRunning();

    const action = await p.select({
        message: '🦖 Rex macOS Persistent Screen Cursor:',
        options: [
            isRunning
                ? { value: 'status', label: '📊 Status & Current Mode (Active)' }
                : { value: 'start', label: '🚀 Start Rex Screen Cursor (Persistent Overlay)' },
            { value: 'listen', label: '🎙️ Speak Command to Rex (Voice Copilot)' },
            { value: 'demo', label: '✨ Run Interactive Demo Tour' },
            { value: 'mode', label: '🔄 Switch Mode (Follow / Autonomous / Idle)' },
            { value: 'appearance', label: '🎨 Switch Appearance (Dino / Cursor / Both)' },
            { value: 'speak', label: '💬 Make Rex Speak on Screen' },
            { value: 'permissions', label: '🔐 Verify & Request macOS Permissions' },
            ...(isRunning ? [{ value: 'stop', label: '🛑 Stop Screen Cursor' }] : []),
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(action) || action === 'back') return;

    if (action === 'start') {
        const mode = await p.select({
            message: 'Select starting mode:',
            options: [
                { value: 'follow', label: '🐾 Follow Mode (Rex shadows your real cursor)' },
                { value: 'autonomous', label: '🤖 Autonomous Mode (Rex flies independently for tasks)' }
            ]
        });
        if (p.isCancel(mode)) return;

        await startScreenCursor({ mode, checkPermissions: true });
        await cursorMenu();
    } else if (action === 'listen') {
        if (!isScreenCursorRunning()) await startScreenCursor({ silent: true });
        p.log.info(pc.cyan('🎙️ Speak your command when ready...'));
        await triggerVoiceCommand();
        await cursorMenu();
    } else if (action === 'demo') {
        await runCursorDemoTour();
        await cursorMenu();
    } else if (action === 'mode') {
        if (!isScreenCursorRunning()) await startScreenCursor({ silent: true });
        const m = await p.select({
            message: 'Select cursor mode:',
            options: [
                { value: 'follow', label: '🐾 Follow Mode (Shadows your cursor across all apps)' },
                { value: 'autonomous', label: '🤖 Autonomous Co-Pilot (Moves independently to assist)' },
                { value: 'idle', label: '🛋️ Idle / Parked (Rests on screen)' }
            ]
        });
        if (!p.isCancel(m)) {
            setCursorMode(m);
            p.log.success(`Mode set to "${m}".`);
        }
        await cursorMenu();
    } else if (action === 'appearance') {
        if (!isScreenCursorRunning()) await startScreenCursor({ silent: true });
        const appChoice = await p.select({
            message: 'Select Rex appearance:',
            options: [
                { value: 'both', label: '🦖 + 🖱️ Duo (8-Bit Dino Mascot + SVG Cursor)' },
                { value: 'dino', label: '🦖 Dino Mascot Only (Retro 8-bit baby T-Rex)' },
                { value: 'cursor', label: '🖱️ Cursor Only (Stylized Rex pointer)' }
            ]
        });
        if (!p.isCancel(appChoice)) {
            setCursorAppearance(appChoice);
            p.log.success(`Appearance set to "${appChoice}".`);
        }
        await cursorMenu();
    } else if (action === 'speak') {
        if (!isScreenCursorRunning()) await startScreenCursor({ silent: true });
        const text = await p.text({
            message: 'What should Rex say on screen?',
            placeholder: 'Rex reporting for duty! 🦖✨'
        });
        if (!p.isCancel(text) && text.trim()) {
            cursorSpeak(text.trim());
        }
        await cursorMenu();
    } else if (action === 'permissions') {
        await ensureMacosPermissions({ silent: false });
        await cursorMenu();
    } else if (action === 'stop') {
        stopScreenCursor();
        p.log.success('Rex Screen Cursor stopped.');
        await cursorMenu();
    } else if (action === 'status') {
        p.note(
            [
                `Running: ${isScreenCursorRunning() ? pc.green('YES') : pc.red('NO')}`,
                `Mode: ${pc.cyan(currentMode)}`,
                `Appearance: ${pc.cyan(currentAppearance)}`,
                `Display Resolution: ${screenDimensions.width} x ${screenDimensions.height}`
            ].join('\n'),
            'Rex Screen Cursor Status'
        );
        await cursorMenu();
    }
}
