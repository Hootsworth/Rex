import { exec } from 'child_process';
import util from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const execPromise = util.promisify(exec);

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
            await execPromise(`osascript -e "${script}"`);
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
            const script = `tell application \"System Events\" to keystroke \"${escaped}\"`;
            await execPromise(`osascript -e "${script}"`);
            p.log.success(`Typed: "${pc.dim(text)}"`);
            return;
        }

        p.log.warn('GUI automation for typing is only available on Windows and macOS.');
        return;
    } catch (err) {
        p.log.error(`Failed to type: ${err.message}`);
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
