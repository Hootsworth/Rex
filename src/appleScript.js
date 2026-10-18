import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pc from 'picocolors';

const execPromise = util.promisify(exec);

/**
 * Low-level execution of AppleScript code via osascript
 * @param {string} script - Multi-line or single-line AppleScript code
 * @param {number} timeoutMs - Max execution time
 * @returns {Promise<{ success: boolean, output: string, error?: string }>}
 */
export async function executeAppleScript(script, timeoutMs = 12000) {
    if (process.platform !== 'darwin') {
        return {
            success: false,
            output: '',
            error: 'AppleScript execution is only available on macOS.'
        };
    }

    try {
        // For multi-line scripts or scripts containing quotes, write to temporary file to avoid shell escaping pitfalls
        const tempScriptPath = path.join(os.tmpdir(), `rex_script_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.scpt`);
        fs.writeFileSync(tempScriptPath, script, 'utf8');

        try {
            const { stdout, stderr } = await execPromise(`osascript "${tempScriptPath}"`, {
                timeout: timeoutMs
            });
            const output = (stdout || '').trim();
            return { success: true, output, error: stderr ? stderr.trim() : undefined };
        } finally {
            try { fs.unlinkSync(tempScriptPath); } catch {}
        }
    } catch (err) {
        return {
            success: false,
            output: '',
            error: err.message || String(err)
        };
    }
}

// ─── System Controls ─────────────────────────────────────────────────────────

export const macSystem = {
    async getVolume() {
        const res = await executeAppleScript('output volume of (get volume settings)');
        return res.success ? parseInt(res.output, 10) : null;
    },

    async setVolume(percent) {
        const level = Math.max(0, Math.min(100, Math.round(percent)));
        const res = await executeAppleScript(`set volume output volume ${level}`);
        return res.success ? `Volume set to ${level}%` : res.error;
    },

    async setMute(muted = true) {
        const res = await executeAppleScript(`set volume output muted ${Boolean(muted)}`);
        return res.success ? `Mute ${muted ? 'enabled' : 'disabled'}` : res.error;
    },

    async displayNotification(message, options = {}) {
        const title = options.title || 'Rex Butler';
        const subtitle = options.subtitle ? `subtitle "${options.subtitle.replace(/"/g, '\\"')}"` : '';
        const sound = options.sound ? `sound name "${options.sound}"` : 'sound name "Hero"';
        const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" ${subtitle} ${sound}`;
        return executeAppleScript(script);
    },

    async lockScreen() {
        // macOS lock screen via System Events
        return executeAppleScript(`
            tell application "System Events"
                keystroke "q" using {control down, command down}
            end tell
        `);
    },

    async sleep() {
        return executeAppleScript('tell application "System Events" to sleep');
    },

    async getFrontmostApp() {
        const res = await executeAppleScript(`
            tell application "System Events"
                name of first application process whose frontmost is true
            end tell
        `);
        return res.success ? res.output : 'Unknown';
    }
};

// ─── Media & Music (Spotify & Apple Music) ───────────────────────────────────

export const macMedia = {
    async detectActiveMediaApp() {
        const res = await executeAppleScript(`
            tell application "System Events"
                set isSpotify to (name of processes) contains "Spotify"
                set isMusic to (name of processes) contains "Music"
                if isSpotify then
                    return "Spotify"
                else if isMusic then
                    return "Music"
                else
                    return "none"
                end if
            end tell
        `);
        return res.success && res.output !== 'none' ? res.output : 'Spotify';
    },

    async playPause() {
        const app = await macMedia.detectActiveMediaApp();
        return executeAppleScript(`tell application "${app}" to playpause`);
    },

    async play() {
        const app = await macMedia.detectActiveMediaApp();
        return executeAppleScript(`tell application "${app}" to play`);
    },

    async pause() {
        const app = await macMedia.detectActiveMediaApp();
        return executeAppleScript(`tell application "${app}" to pause`);
    },

    async next() {
        const app = await macMedia.detectActiveMediaApp();
        return executeAppleScript(`tell application "${app}" to next track`);
    },

    async previous() {
        const app = await macMedia.detectActiveMediaApp();
        return executeAppleScript(`tell application "${app}" to previous track`);
    },

    async getCurrentTrack() {
        const app = await macMedia.detectActiveMediaApp();
        if (app === 'Spotify') {
            const script = `
                tell application "Spotify"
                    if player state is stopped then
                        return "Stopped"
                    end if
                    set trackName to name of current track
                    set artistName to artist of current track
                    set albumName to album of current track
                    set pState to player state as string
                    return trackName & "|||" & artistName & "|||" & albumName & "|||" & pState
                end tell
            `;
            const res = await executeAppleScript(script);
            if (res.success && res.output.includes('|||')) {
                const [name, artist, album, state] = res.output.split('|||');
                return { app: 'Spotify', name, artist, album, state };
            }
        } else if (app === 'Music') {
            const script = `
                tell application "Music"
                    if player state is stopped then
                        return "Stopped"
                    end if
                    set trackName to name of current track
                    set artistName to artist of current track
                    set albumName to album of current track
                    set pState to player state as string
                    return trackName & "|||" & artistName & "|||" & albumName & "|||" & pState
                end tell
            `;
            const res = await executeAppleScript(script);
            if (res.success && res.output.includes('|||')) {
                const [name, artist, album, state] = res.output.split('|||');
                return { app: 'Music', name, artist, album, state };
            }
        }
        return null;
    }
};

// ─── Window & App Management ────────────────────────────────────────────────

export const macApps = {
    async openApp(appName) {
        return executeAppleScript(`tell application "${appName}" to activate`);
    },

    async quitApp(appName) {
        return executeAppleScript(`tell application "${appName}" to quit`);
    },

    async listRunningApps() {
        const res = await executeAppleScript(`
            tell application "System Events"
                name of application processes whose background only is false
            end tell
        `);
        if (res.success) {
            return res.output.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
    },

    async minimizeFrontWindow() {
        return executeAppleScript(`
            tell application "System Events"
                set frontApp to first application process whose frontmost is true
                tell frontApp
                    if (count of windows) > 0 then
                        set collapsed of window 1 to true
                    end if
                end tell
            end tell
        `);
    },

    async sendKeyCombo(key, modifiers = []) {
        const modString = modifiers.length ? `using {${modifiers.join(', ')}}` : '';
        return executeAppleScript(`
            tell application "System Events"
                keystroke "${key}" ${modString}
            end tell
        `);
    }
};

// ─── Finder & Files ──────────────────────────────────────────────────────────

export const macFinder = {
    async reveal(filePath) {
        const absPath = path.resolve(filePath);
        const script = `
            tell application "Finder"
                activate
                reveal POSIX file "${absPath}"
            end tell
        `;
        return executeAppleScript(script);
    },

    async emptyTrash() {
        return executeAppleScript('tell application "Finder" to empty trash');
    },

    async getSelectedFiles() {
        const script = `
            tell application "Finder"
                set selectedItems to selection
                set fileList to {}
                repeat with anItem in selectedItems
                    set end of fileList to POSIX path of (anItem as alias)
                end repeat
                return fileList
            end tell
        `;
        const res = await executeAppleScript(script);
        if (res.success) {
            return res.output.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
    }
};

// ─── Browser Controls (Chrome & Safari) ──────────────────────────────────────

export const macBrowsers = {
    async getActiveTab(browser = 'Google Chrome') {
        let script = '';
        if (browser.toLowerCase().includes('safari')) {
            script = `
                tell application "Safari"
                    if (count of windows) > 0 then
                        set currentTab to current tab of window 1
                        return (URL of currentTab) & "|||" & (name of currentTab)
                    end if
                end tell
            `;
        } else {
            // Chrome / Brave / Edge
            script = `
                tell application "${browser}"
                    if (count of windows) > 0 then
                        set currentTab to active tab of window 1
                        return (URL of currentTab) & "|||" & (title of currentTab)
                    end if
                end tell
            `;
        }
        const res = await executeAppleScript(script);
        if (res.success && res.output.includes('|||')) {
            const [url, title] = res.output.split('|||');
            return { browser, url, title };
        }
        return null;
    },

    async openUrl(url, browser = 'Google Chrome') {
        const script = `
            tell application "${browser}"
                activate
                open location "${url}"
            end tell
        `;
        return executeAppleScript(script);
    },

    async runJsInActiveTab(code, browser = 'Google Chrome') {
        let script = '';
        if (browser.toLowerCase().includes('safari')) {
            script = `
                tell application "Safari"
                    do JavaScript "${code.replace(/"/g, '\\"')}" in current tab of window 1
                end tell
            `;
        } else {
            script = `
                tell application "${browser}"
                    execute active tab of window 1 javascript "${code.replace(/"/g, '\\"')}"
                end tell
            `;
        }
        return executeAppleScript(script);
    }
};

// ─── Native Productivity (Reminders & Notes) ─────────────────────────────────

export const macProductivity = {
    async addReminder(title, options = {}) {
        const listName = options.listName || 'Reminders';
        const notes = options.notes ? `body: "${options.notes.replace(/"/g, '\\"')}"` : '';
        const script = `
            tell application "Reminders"
                tell list "${listName}"
                    make new reminder with properties {name:"${title.replace(/"/g, '\\"')}"}
                end tell
            end tell
        `;
        const res = await executeAppleScript(script);
        return res.success ? `Added reminder: "${title}"` : res.error;
    },

    async createNote(title, body = '') {
        const script = `
            tell application "Notes"
                tell default account
                    make new note with properties {name:"${title.replace(/"/g, '\\"')}", body:"${body.replace(/"/g, '\\"')}"}
                end tell
            end tell
        `;
        const res = await executeAppleScript(script);
        return res.success ? `Created Apple Note: "${title}"` : res.error;
    }
};
