import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const execPromise = util.promisify(exec);
const CURSOR_ASSETS_DIR = path.join(process.cwd(), 'assets');
const DEFAULT_CURSOR_STYLES = ['default', 'handopen', 'handpointing', 'handgrabbing', 'busy', 'beachball', 'copy'];
const cursorSession = {
    enabled: false,
    style: 'default',
    lastStyle: 'default'
};

function isWindows() {
    return process.platform === 'win32';
}

function assertWindows() {
    if (!isWindows()) {
        throw new Error('os-agent currently supports Windows only.');
    }
}

function toWindowsSendKeys(combo) {
    let raw = '';
    if (Array.isArray(combo)) {
        raw = combo.map((x) => String(x || '').trim()).filter(Boolean).join('+');
    } else {
        raw = String(combo || '').trim();
    }

    if (!raw) return '';

    // Convert common malformed forms like {CONTROL,S} -> CONTROL+S
    const braceComboMatch = raw.match(/^\{\s*([^{}]+)\s*\}$/);
    if (braceComboMatch && braceComboMatch[1].includes(',')) {
        raw = braceComboMatch[1].split(',').map((s) => s.trim()).filter(Boolean).join('+');
    }

    // Handle wrapped SendKeys operator forms like {^s} -> ^s
    const wrappedOps = raw.match(/^\{\s*([\^%+].*)\s*\}$/);
    if (wrappedOps) {
        raw = wrappedOps[1].trim();
    }

    // If already in raw SendKeys operator form, trust it.
    if (raw.includes('^') || raw.includes('%')) {
        return raw;
    }

    // Handle forms like {ENTER}, {F5}, etc.
    if (/^\{[A-Z0-9_]+\}$/i.test(raw)) {
        return raw.toUpperCase();
    }

    const parts = raw.split('+').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (parts.length === 0) return '';

    let prefix = '';
    const tokens = [];

    for (const part of parts) {
        if (part === 'CTRL' || part === 'CONTROL') {
            prefix += '^';
            continue;
        }
        if (part === 'ALT') {
            prefix += '%';
            continue;
        }
        if (part === 'SHIFT') {
            prefix += '+';
            continue;
        }
        if (part.length === 1 && /[A-Z0-9]/.test(part)) {
            tokens.push(part.toLowerCase());
            continue;
        }

        if (['ENTER', 'TAB', 'ESC', 'ESCAPE', 'BACKSPACE', 'DELETE', 'HOME', 'END', 'PGUP', 'PGDN', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE'].includes(part) || /^F\d{1,2}$/.test(part)) {
            tokens.push(`{${part === 'ESCAPE' ? 'ESC' : part}}`);
            continue;
        }

        tokens.push(`{${part}}`);
    }

    return prefix + tokens.join('');
}

function q(value) {
    // Quote for PowerShell single-quoted string.
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPowerShell(script, timeoutMs = 20000) {
    const cmd = `powershell.exe -NoProfile -Command \"${script.replace(/\"/g, '\\\"').replace(/\r?\n/g, '; ')}\"`;
    const { stdout, stderr } = await execPromise(cmd, { timeout: timeoutMs, windowsHide: true });
    return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
}

function getCursorStyles() {
    try {
        if (!fs.existsSync(CURSOR_ASSETS_DIR)) return DEFAULT_CURSOR_STYLES;
        const files = fs.readdirSync(CURSOR_ASSETS_DIR)
            .filter((f) => f.toLowerCase().endsWith('.svg'))
            .map((f) => path.basename(f, '.svg').toLowerCase());
        return files.length ? files : DEFAULT_CURSOR_STYLES;
    } catch {
        return DEFAULT_CURSOR_STYLES;
    }
}

function chooseCursorStyle(type, action) {
    if (action.cursorStyle) return String(action.cursorStyle).toLowerCase();
    if (action.loading === true) return 'beachball';

    if (type === 'click') {
        if (String(action.button || 'left').toLowerCase() === 'right') return 'copy';
        return 'handpointing';
    }
    if (type === 'move' || type === 'focus') return 'handopen';
    if (type === 'wait') return 'busy';
    return 'default';
}

function humanMoveOptions(style) {
    const s = String(style || 'default').toLowerCase();
    if (s === 'beachball' || s === 'busy') return { stepsBase: 28, sleepMin: 7, sleepMax: 14, jitter: 1.0 };
    if (s === 'handgrabbing') return { stepsBase: 16, sleepMin: 3, sleepMax: 7, jitter: 1.0 };
    if (s === 'handpointing') return { stepsBase: 20, sleepMin: 4, sleepMax: 9, jitter: 1.5 };
    if (s === 'copy') return { stepsBase: 22, sleepMin: 5, sleepMax: 10, jitter: 1.8 };
    return { stepsBase: 18, sleepMin: 4, sleepMax: 8, jitter: 1.3 };
}

function normalizeActionArgs(action) {
    const input = { ...(action || {}) };
    const type = String(input.type || '').toLowerCase();
    const normalized = { ...input, type };

    if (type === 'open') {
        normalized.app = input.app || input.application || input.program || input.name || '';
        if (normalized.app && !String(normalized.app).toLowerCase().endsWith('.exe') && /^[a-z0-9_-]+$/i.test(String(normalized.app))) {
            normalized.app = `${normalized.app}.exe`;
        }
    }

    if (type === 'hotkey') {
        const comboInput = input.combo ?? input.keys ?? input.key ?? input.shortcut;
        if (Array.isArray(comboInput)) {
            normalized.combo = comboInput.map((x) => String(x || '').trim()).filter(Boolean).join('+');
        } else {
            normalized.combo = comboInput;
        }
    }

    if (type === 'click' && !normalized.button) {
        normalized.button = 'left';
    }

    normalized.visualCursor = Boolean(input.visualCursor);
    normalized.cursorStyle = input.cursorStyle || input.style || '';
    normalized.loading = Boolean(input.loading);

    return normalized;
}

async function getActiveWindowTitle() {
    const script = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);' -Name 'Win32' -Namespace 'Rex';
$h = [Rex.Win32]::GetForegroundWindow();
$sb = New-Object System.Text.StringBuilder 1024;
[void][Rex.Win32]::GetWindowText($h, $sb, $sb.Capacity);
$sb.ToString();
`;
    try {
        const { stdout } = await runPowerShell(script, 8000);
        return String(stdout || '').trim();
    } catch {
        return '';
    }
}

export async function runOsPreflight(action = {}) {
    assertWindows();
    const normalizedAction = normalizeActionArgs(action);
    const type = String(normalizedAction.type || '').toLowerCase();
    const activeWindowTitle = await getActiveWindowTitle();
    const warnings = [];
    const errors = [];
    const availableStyles = getCursorStyles();

    if (!type) {
        errors.push('Missing action type.');
    }

    if (type === 'open' && !normalizedAction.app) {
        errors.push('open action requires app (e.g. "notepad.exe").');
    }

    if (type === 'hotkey') {
        if (!normalizedAction.combo) {
            errors.push('hotkey action requires combo (e.g. "CTRL+S").');
        } else {
            const sendKeys = toWindowsSendKeys(normalizedAction.combo);
            if (!sendKeys) errors.push('Could not parse hotkey combo to SendKeys format.');
            normalizedAction.combo = normalizedAction.combo;
            normalizedAction._sendKeys = sendKeys;
        }
    }

    if ((type === 'type' || type === 'hotkey') && !activeWindowTitle) {
        warnings.push('No active window title detected; keyboard input may go to the wrong target.');
    }

    if (type === 'type' && activeWindowTitle && !/notepad/i.test(activeWindowTitle)) {
        warnings.push(`Active window is "${activeWindowTitle}"; text may not land in Notepad.`);
    }

    if (normalizedAction.visualCursor) {
        const desired = chooseCursorStyle(type, normalizedAction);
        if (!availableStyles.includes(String(desired).toLowerCase())) {
            warnings.push(`Cursor style "${desired}" is not present in assets; using default profile.`);
        }
    }

    return {
        ok: errors.length === 0,
        type,
        normalizedAction,
        availableCursorStyles: availableStyles,
        activeWindowTitle,
        warnings,
        errors
    };
}

export async function openApplication(app) {
    assertWindows();
    const script = `Start-Process -FilePath ${q(app)}`;
    await runPowerShell(script);
}

export async function focusWindowByTitle(title) {
    assertWindows();
    const script = `$ws = New-Object -ComObject WScript.Shell; $ok = $ws.AppActivate(${q(title)}); if (-not $ok) { throw 'Window not found: ${String(title).replace(/'/g, "''")}' }`;
    await runPowerShell(script);
}

export async function moveMouse(x, y) {
    assertWindows();
    const script = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Number(x)}, ${Number(y)})`;
    await runPowerShell(script);
}

async function moveMouseHumanized(x, y, style = 'default') {
    assertWindows();
    const tx = Number(x);
    const ty = Number(y);
    const profile = humanMoveOptions(style);
    const steps = Math.max(profile.stepsBase, Math.min(46, profile.stepsBase + Math.floor((Math.abs(tx) + Math.abs(ty)) / 220)));
    const sleepMin = profile.sleepMin;
    const sleepMax = profile.sleepMax;
    const jitter = profile.jitter;

    const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
$start = [System.Windows.Forms.Cursor]::Position;
$sx = [double]$start.X;
$sy = [double]$start.Y;
$tx = [double]${tx};
$ty = [double]${ty};
$steps = [int]${steps};
$sleepMin = [int]${sleepMin};
$sleepMax = [int]${sleepMax};
$j = [double]${jitter};
for ($i = 1; $i -le $steps; $i++) {
  $t = $i / [double]$steps;
  $ease = 1 - [math]::Pow(1 - $t, 3);
  $decay = 1 - $t;
  $jx = [math]::Sin($i * 0.75) * $j * $decay;
  $jy = [math]::Cos($i * 0.62) * $j * $decay;
  $x = [int]([math]::Round($sx + (($tx - $sx) * $ease) + $jx));
  $y = [int]([math]::Round($sy + (($ty - $sy) * $ease) + $jy));
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y);
  $delay = Get-Random -Minimum $sleepMin -Maximum ($sleepMax + 1);
  Start-Sleep -Milliseconds $delay;
}
`;
    await runPowerShell(script, 35000);
}

export async function mouseClick(x, y, button = 'left') {
    assertWindows();
    const isRight = String(button).toLowerCase() === 'right';
    const down = isRight ? '0x0008' : '0x0002';
    const up = isRight ? '0x0010' : '0x0004';

    const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);' -Name 'Win32Mouse' -Namespace Win32;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Number(x)}, ${Number(y)});
[Win32.Win32Mouse]::mouse_event(${down},0,0,0,0);
[Win32.Win32Mouse]::mouse_event(${up},0,0,0,0);
`;
    await runPowerShell(script);
}

async function mouseClickHumanized(x, y, button = 'left', style = 'handpointing') {
    await moveMouseHumanized(x, y, style);
    await waitMs(30 + Math.floor(Math.random() * 70));
    await mouseClick(x, y, button);
}

export async function typeText(text) {
    assertWindows();
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${q(text)})`;
    await runPowerShell(script);
}

export async function sendHotkey(combo) {
    assertWindows();
    const keySeq = toWindowsSendKeys(combo);
    if (!keySeq) throw new Error('Invalid hotkey sequence.');
    const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${q(keySeq)})`;
    await runPowerShell(script);
}

export async function waitMs(ms) {
    assertWindows();
    const value = Math.max(0, Number(ms) || 0);
    const script = `Start-Sleep -Milliseconds ${value}`;
    await runPowerShell(script, value + 5000);
}

function parseXY(value) {
    const [xRaw, yRaw] = String(value || '').split(',');
    const x = Number.parseInt(String(xRaw || '').trim(), 10);
    const y = Number.parseInt(String(yRaw || '').trim(), 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('Coordinates must be in format "x,y".');
    }
    return { x, y };
}

async function runAction(action, dryRun = false) {
    const normalized = normalizeActionArgs(action);
    const type = String(normalized?.type || '').toLowerCase();
    const visualCursor = Boolean(normalized.visualCursor);
    const selectedStyle = chooseCursorStyle(type, normalized);
    const activeStyle = getCursorStyles().includes(selectedStyle) ? selectedStyle : 'default';

    if (visualCursor) {
        cursorSession.enabled = true;
        cursorSession.style = activeStyle;
        cursorSession.lastStyle = activeStyle;
    }

    if (type === 'open') {
        if (!normalized.app) throw new Error('open action requires app.');
        if (!dryRun) await openApplication(normalized.app);
        return `open app=${normalized.app}`;
    }
    if (type === 'focus') {
        if (!normalized.title) throw new Error('focus action requires title.');
        if (!dryRun) await focusWindowByTitle(normalized.title);
        return `focus title=${normalized.title}`;
    }
    if (type === 'move') {
        if (!dryRun) {
            if (visualCursor) await moveMouseHumanized(normalized.x, normalized.y, activeStyle);
            else await moveMouse(normalized.x, normalized.y);
        }
        return `move x=${normalized.x} y=${normalized.y}${visualCursor ? ` style=${activeStyle}` : ''}`;
    }
    if (type === 'click') {
        if (!dryRun) {
            if (visualCursor) await mouseClickHumanized(normalized.x, normalized.y, normalized.button || 'left', activeStyle === 'default' ? 'handpointing' : activeStyle);
            else await mouseClick(normalized.x, normalized.y, normalized.button || 'left');
        }
        return `click x=${normalized.x} y=${normalized.y} button=${normalized.button || 'left'}${visualCursor ? ` style=${activeStyle}` : ''}`;
    }
    if (type === 'type') {
        if (!normalized.text && normalized.text !== '') throw new Error('type action requires text.');
        if (!dryRun) await typeText(normalized.text);
        return `type text=${JSON.stringify(String(normalized.text))}${visualCursor ? ` style=${activeStyle}` : ''}`;
    }
    if (type === 'hotkey') {
        if (!normalized.combo) throw new Error('hotkey action requires combo.');
        if (!dryRun) await sendHotkey(normalized.combo);
        return `hotkey combo=${normalized.combo}${visualCursor ? ` style=${activeStyle}` : ''}`;
    }
    if (type === 'wait') {
        if (!dryRun) await waitMs(normalized.ms || 250);
        return `wait ms=${Number(normalized.ms || 250)}${visualCursor ? ` style=${activeStyle}` : ''}`;
    }
    if (type === 'preflight_analyse' || type === 'preflight') {
        const report = await runOsPreflight(normalized);
        return `OS Preflight Report:\n${JSON.stringify(report, null, 2)}`;
    }

    throw new Error(`Unknown action type: ${type}`);
}

export async function executeOsAgentAction(args = {}, options = {}) {
    assertWindows();

    const dryRun = Boolean(options.dryRun || args.dryRun);
    const normalized = normalizeActionArgs(args);
    const type = String(normalized.type || '').toLowerCase();

    const allowedTypes = new Set(['open', 'focus', 'move', 'click', 'type', 'hotkey', 'wait', 'preflight_analyse', 'preflight']);
    if (!allowedTypes.has(type)) {
        throw new Error(`Unsupported os_agent action type: ${type}`);
    }

    if (type !== 'preflight_analyse' && type !== 'preflight') {
        const preflight = await runOsPreflight(normalized);
        if (!preflight.ok) {
            throw new Error(`OS preflight failed: ${preflight.errors.join(' | ')}`);
        }
    }

    const summary = await runAction(normalized, dryRun);
    return dryRun ? `${summary} (dry-run)` : summary;
}

export async function runOsAgentScript(scriptPath, options = {}) {
    assertWindows();
    const fullPath = path.resolve(scriptPath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Script file not found: ${fullPath}`);
    }

    const data = fs.readFileSync(fullPath, 'utf8');
    const payload = JSON.parse(data);
    const actions = Array.isArray(payload) ? payload : payload.actions;

    if (!Array.isArray(actions) || actions.length === 0) {
        throw new Error('Script must contain a non-empty actions array.');
    }

    const dryRun = Boolean(options.dryRun);
    p.note(`Loaded ${actions.length} actions from ${fullPath}`, 'os-agent');

    let step = 0;
    for (const action of actions) {
        step += 1;
        const summary = await runAction(action, dryRun);
        p.log.step(`${pc.cyan(`#${step}`)} ${summary}${dryRun ? pc.dim(' (dry-run)') : ''}`);
    }

    p.log.success(dryRun ? 'Dry-run complete.' : 'Script execution complete.');
}

export async function runOsAgentFromCli(opts = {}) {
    assertWindows();

    const operations = [];
    const dryRun = Boolean(opts.dryRun);

    if (opts.open) operations.push({ type: 'open', app: opts.open });
    if (opts.focus) operations.push({ type: 'focus', title: opts.focus });
    if (opts.move) {
        const { x, y } = parseXY(opts.move);
        operations.push({ type: 'move', x, y });
    }
    if (opts.click) {
        const { x, y } = parseXY(opts.click);
        operations.push({ type: 'click', x, y, button: opts.button || 'left' });
    }
    if (opts.type) operations.push({ type: 'type', text: opts.type });
    if (opts.hotkey) operations.push({ type: 'hotkey', combo: opts.hotkey });
    if (opts.wait) operations.push({ type: 'wait', ms: Number(opts.wait) });

    if (opts.script) {
        await runOsAgentScript(opts.script, { dryRun });
        return;
    }

    if (operations.length === 0) {
        p.note('No operation was provided. Use --help with rexai os-agent for examples.', 'os-agent');
        return;
    }

    p.note(`Ready to execute ${operations.length} action(s).`, 'os-agent');

    if (!dryRun) {
        const ok = await p.confirm({
            message: 'This will control your mouse/keyboard and active apps. Continue?',
            initialValue: false,
        });
        if (!ok || p.isCancel(ok)) {
            p.log.warn('Cancelled.');
            return;
        }
    }

    let step = 0;
    for (const op of operations) {
        step += 1;
        const summary = await runAction(op, dryRun);
        p.log.step(`${pc.cyan(`#${step}`)} ${summary}${dryRun ? pc.dim(' (dry-run)') : ''}`);
    }

    p.log.success(dryRun ? 'Dry-run complete.' : 'Done.');
}
