import { exec } from 'child_process';
import util from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const execPromise = util.promisify(exec);

export async function setVolume(level) {
    try {
        const normalizedLevel = Math.max(0, Math.min(100, Number.isFinite(level) ? level : 0));

        if (process.platform === 'win32') {
            // level should be 0-100
            const volumeValue = normalizedLevel / 100;
            // Better approach for Windows 10+:
            const setVolScript = `(new-object -com wscript.shell).SendKeys([char]174)*50; (new-object -com wscript.shell).SendKeys([char]175)*$(${Math.floor(volumeValue * 50)})`;

            await execPromise(`powershell -Command "${setVolScript}"`);
            p.log.success(`Volume set to ${pc.cyan(normalizedLevel + '%')}`);
            return;
        }

        if (process.platform === 'darwin') {
            await execPromise(`osascript -e "set volume output volume ${normalizedLevel}"`);
            p.log.success(`Volume set to ${pc.cyan(normalizedLevel + '%')}`);
            return;
        }

        p.log.warn('Volume control is currently supported on Windows and macOS.');
    } catch (err) {
        p.log.error(`Failed to set volume: ${err.message}`);
    }
}

export async function setBrightness(level) {
    try {
        const brightness = Math.max(0, Math.min(100, Number.isFinite(level) ? level : 0));

        if (process.platform === 'win32') {
            const cmd = `powershell -Command "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${brightness})"`;
            await execPromise(cmd);
            p.log.success(`Brightness set to ${pc.cyan(brightness + '%')}`);
            return;
        }

        if (process.platform === 'darwin') {
            // Built-in macOS does not expose direct percentage brightness control.
            // Use keyboard brightness events to move near the requested level.
            const steps = Math.round((brightness / 100) * 16);
            await execPromise("osascript -e 'tell application \"System Events\" to key code 145 using {fn down}'");
            if (steps > 0) {
                await execPromise(`osascript -e 'repeat ${steps} times' -e 'tell application \"System Events\" to key code 144 using {fn down}' -e 'end repeat'`);
            }
            p.log.success(`Brightness adjusted to approximately ${pc.cyan(brightness + '%')}`);
            return;
        }

        p.log.warn('Brightness control is currently supported on Windows and macOS.');
    } catch (err) {
        p.log.error(`Failed to set brightness: ${err.message}`);
    }
}

export async function mediaMenu() {
    const choice = await p.select({
        message: 'System Media Control:',
        options: [
            { value: 'volume', label: '🔊 Set Volume' },
            { value: 'brightness', label: '☀️ Set Brightness' },
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(choice) || choice === 'back') return;

    if (choice === 'volume') {
        const vol = await p.text({ message: 'Enter volume level (0-100):', placeholder: '50' });
        if (!p.isCancel(vol)) await setVolume(parseInt(vol));
    }
    if (choice === 'brightness') {
        const bright = await p.text({ message: 'Enter brightness level (0-100):', placeholder: '70' });
        if (!p.isCancel(bright)) await setBrightness(parseInt(bright));
    }
}
