import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const execPromise = util.promisify(exec);

let macroRecording = false;
let macroEvents = [];
let macroStartTime = 0;

function escapeAppleScriptString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function mouseClick(x, y) {
    try {
        if (process.platform === 'win32') {
            const psScript = `
$pos = New-Object System.Drawing.Point(${x}, ${y});
[System.Windows.Forms.Cursor]::Position = $pos;
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
'@ -Name "Win32MouseEvent" -Namespace Win32Functions
[Win32Functions.Win32MouseEvent]::mouse_event(0x0002, 0, 0, 0, 0); # Left down
[Win32Functions.Win32MouseEvent]::mouse_event(0x0004, 0, 0, 0, 0); # Left up
`;
            await execPromise(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; ${psScript.replace(/\n/g, ' ')}"`);
            p.log.success(`Clicked at (${x}, ${y})`);
            return;
        }

        if (process.platform === 'darwin') {
            const script = `tell application "System Events" to click at {${x}, ${y}}`;
            const safeScript = script.replace(/'/g, "'\\''");
            await execPromise(`osascript -e '${safeScript}'`);
            p.log.success(`Clicked at (${x}, ${y})`);
            return;
        }

        p.log.warn('GUI automation for mouse click is only available on Windows and macOS.');
        return;
    } catch (err) {
        p.log.error(`Failed to click: ${err.message}`);
    }
}

export async function typeText(text) {
    try {
        if (process.platform === 'win32') {
            const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
            const psScript = `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
            await execPromise(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; ${psScript}"`);
            p.log.success(`Typed: "${pc.dim(text)}"`);
            return;
        }

        if (process.platform === 'darwin') {
            const escaped = escapeAppleScriptString(text);
            const script = `tell application "System Events" to keystroke "${escaped}"`;
            const safeScript = script.replace(/'/g, "'\\''");
            await execPromise(`osascript -e '${safeScript}'`);
            p.log.success(`Typed: "${pc.dim(text)}"`);
            return;
        }

        p.log.warn('GUI automation for typing is only available on Windows and macOS.');
        return;
    } catch (err) {
        p.log.error(`Failed to type: ${err.message}`);
    }
}

export async function recordMacro(name) {
    if (macroRecording) return 'Already recording.';
    try {
        const { uIOhook, UiohookKey } = await import('uiohook-napi');
        macroRecording = true;
        macroEvents = [];
        macroStartTime = Date.now();
        
        const handleMouse = (e, type) => {
            if (!macroRecording) return;
            const time = Date.now() - macroStartTime;
            macroEvents.push({ type, x: e.x, y: e.y, button: e.button, time });
        };
        
        const handleMove = (e) => {
            if (!macroRecording) return;
            const time = Date.now() - macroStartTime;
            const last = macroEvents[macroEvents.length - 1];
            if (!last || last.type !== 'mousemove' || time - last.time > 40) {
                macroEvents.push({ type: 'mousemove', x: e.x, y: e.y, time });
            }
        };

        const handleKey = (e, type) => {
            if (!macroRecording) return;
            const time = Date.now() - macroStartTime;
            macroEvents.push({ type, key: e.keycode, time });
            if (e.keycode === UiohookKey.Escape) {
                stopMacroRecording(name);
            }
        };

        uIOhook.on('mousedown', e => handleMouse(e, 'mousedown'));
        uIOhook.on('mouseup', e => handleMouse(e, 'mouseup'));
        uIOhook.on('mousemove', handleMove);
        uIOhook.on('keydown', e => handleKey(e, 'keydown'));
        uIOhook.on('keyup', e => handleKey(e, 'keyup'));

        uIOhook.start();
        return `Started recording macro "${name}". Press ESC to stop.`;
    } catch (e) {
        macroRecording = false;
        return `Failed to start macro recording: ${e.message}`;
    }
}

function stopMacroRecording(name) {
    if (!macroRecording) return;
    macroRecording = false;
    try {
        const { uIOhook } = require('uiohook-napi');
        uIOhook.stop();
    } catch {}

    const macroPath = path.join(process.cwd(), '.agent', 'macros', `${name}.json`);
    if (!fs.existsSync(path.dirname(macroPath))) {
        fs.mkdirSync(path.dirname(macroPath), { recursive: true });
    }
    fs.writeFileSync(macroPath, JSON.stringify({ name, events: macroEvents }, null, 2));
    p.log.success(`Macro saved to ${macroPath} (${macroEvents.length} events)`);
}

export async function replayMacro(name) {
    const macroPath = path.join(process.cwd(), '.agent', 'macros', `${name}.json`);
    if (!fs.existsSync(macroPath)) return `Macro ${name} not found.`;
    
    try {
        const macro = JSON.parse(fs.readFileSync(macroPath, 'utf8'));
        if (process.platform === 'win32') {
            let scriptArgs = [];
            let lastTime = 0;
            
            for (const e of macro.events) {
                const delay = e.time - lastTime;
                if (delay > 0) scriptArgs.push(`D,${delay}`);
                lastTime = e.time;

                if (e.type === 'mousemove') scriptArgs.push(`M,${e.x},${e.y}`);
                else if (e.type === 'mousedown') scriptArgs.push(`B,${e.button === 2 ? 8 : 2}`); // 2=Ldown, 8=Rdown
                else if (e.type === 'mouseup') scriptArgs.push(`B,${e.button === 2 ? 16 : 4}`); // 4=Lup, 16=Rup
            }

            const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public class Replayer {
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    public static void Run(string script) {
        string[] cmds = script.Split('|');
        foreach(string c in cmds) {
            if(c=="") continue;
            string[] parts = c.Split(',');
            string type = parts[0];
            if(type=="D") Thread.Sleep(int.Parse(parts[1]));
            else if(type=="M") SetCursorPos(int.Parse(parts[1]), int.Parse(parts[2]));
            else if(type=="B") mouse_event(uint.Parse(parts[1]), 0, 0, 0, 0);
        }
    }
}
"@
[Replayer]::Run("${scriptArgs.join('|')}")
`;
            await execPromise(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`);
            return `Replayed macro "${name}" successfully.`;
        } else {
            return 'Macro playback is optimized for Windows currently.';
        }
    } catch (e) {
        return `Failed to replay macro: ${e.message}`;
    }
}

export async function guiMenu() {
    const choice = await p.select({
        message: 'GUI Automation:',
        options: [
            { value: 'click', label: '🖱️ Mouse Click (X,Y)' },
            { value: 'type', label: '⌨️ Type Text' },
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(choice) || choice === 'back') return;

    if (choice === 'click') {
        const coords = await p.text({ message: 'Enter X,Y coordinates:', placeholder: '500,500' });
        if (!p.isCancel(coords)) {
            const [x, y] = coords.split(',').map(s => parseInt(s.trim()));
            await mouseClick(x, y);
        }
    }
    if (choice === 'type') {
        const text = await p.text({ message: 'Enter text to type:', placeholder: 'Hello World' });
        if (!p.isCancel(text)) await typeText(text);
    }
}
