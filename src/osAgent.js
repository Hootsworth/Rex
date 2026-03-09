import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const execPromise = util.promisify(exec);

function isWindows() {
    return process.platform === 'win32';
}

function assertWindows() {
    if (!isWindows()) {
        throw new Error('os-agent currently supports Windows only.');
    }
}

function toWindowsSendKeys(combo) {
    const raw = String(combo || '').trim();
    if (!raw) return '';

    // If it already looks like SendKeys format, trust it.
    if (raw.includes('^') || raw.includes('%') || raw.includes('+') || raw.includes('{')) {
        return raw;
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
        tokens.push(`{${part}}`);
    }

    return prefix + tokens.join('');
}

function q(value) {
    // Quote for PowerShell single-quoted string.
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPowerShell(script, timeoutMs = 20000) {
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command \"${script.replace(/\"/g, '\\\"').replace(/\r?\n/g, '; ')}\"`;
    const { stdout, stderr } = await execPromise(cmd, { timeout: timeoutMs, windowsHide: true });
    return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
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
    const type = String(action?.type || '').toLowerCase();

    if (type === 'open') {
        if (!action.app) throw new Error('open action requires app.');
        if (!dryRun) await openApplication(action.app);
        return `open app=${action.app}`;
    }
    if (type === 'focus') {
        if (!action.title) throw new Error('focus action requires title.');
        if (!dryRun) await focusWindowByTitle(action.title);
        return `focus title=${action.title}`;
    }
    if (type === 'move') {
        if (!dryRun) await moveMouse(action.x, action.y);
        return `move x=${action.x} y=${action.y}`;
    }
    if (type === 'click') {
        if (!dryRun) await mouseClick(action.x, action.y, action.button || 'left');
        return `click x=${action.x} y=${action.y} button=${action.button || 'left'}`;
    }
    if (type === 'type') {
        if (!action.text && action.text !== '') throw new Error('type action requires text.');
        if (!dryRun) await typeText(action.text);
        return `type text=${JSON.stringify(String(action.text))}`;
    }
    if (type === 'hotkey') {
        if (!action.combo) throw new Error('hotkey action requires combo.');
        if (!dryRun) await sendHotkey(action.combo);
        return `hotkey combo=${action.combo}`;
    }
    if (type === 'wait') {
        if (!dryRun) await waitMs(action.ms || 250);
        return `wait ms=${Number(action.ms || 250)}`;
    }

    throw new Error(`Unknown action type: ${type}`);
}

export async function executeOsAgentAction(args = {}, options = {}) {
    assertWindows();

    const dryRun = Boolean(options.dryRun || args.dryRun);
    const type = String(args.type || '').toLowerCase();

    const allowedTypes = new Set(['open', 'focus', 'move', 'click', 'type', 'hotkey', 'wait']);
    if (!allowedTypes.has(type)) {
        throw new Error(`Unsupported os_agent action type: ${type}`);
    }

    const summary = await runAction(args, dryRun);
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
