/**
 * crossAppDragDrop.js — Native macOS File & Media Drag & Drop Engine
 *
 * Automates cross-application file transfers (e.g. dropping clips into DaVinci Resolve,
 * attaching media into WhatsApp / Slack / Discord composers, or dragging assets into web uploaders).
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { cursorActivateApp, cursorDrag, cursorKeyPress, moveCursorTo, cursorClick } from './screenCursor.js';

const execAsync = promisify(exec);

/**
 * Copy a file directly to the macOS system pasteboard as a genuine file reference (kUTTypeFileURL).
 * @param {string} filePath Absolute or relative path to file on disk
 */
export async function copyFileToPasteboard(filePath) {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
        throw new Error(`File does not exist: ${absPath}`);
    }

    const script = `
        use framework "Foundation"
        use framework "AppKit"
        set posixPath to "${absPath.replace(/"/g, '\\"')}"
        set fileURL to current application's NSURL's fileURLWithPath:posixPath
        set pb to current application's NSPasteboard's generalPasteboard()
        pb's clearContents()
        pb's writeObjects:{fileURL}
    `;

    try {
        await execAsync(`osascript -l AppleScript -e '${script}'`, { timeout: 3000 });
        return true;
    } catch {
        // Fallback: copy file path as text
        await execAsync(`osascript -e 'set the clipboard to (POSIX file "${absPath.replace(/"/g, '\\"')}")'`, { timeout: 3000 }).catch(() => {});
        return true;
    }
}

/**
 * Drag and drop a file from disk into a target application window or dropzone.
 * @param {string} filePath Path of file to drag
 * @param {number} targetX Target drop X coordinate
 * @param {number} targetY Target drop Y coordinate
 * @param {string} [appName=''] Target application to focus
 */
export async function dropFileIntoWindow(filePath, targetX, targetY, appName = '') {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
        return { ok: false, error: 'File not found' };
    }

    if (appName) {
        cursorActivateApp(appName);
        await new Promise(r => setTimeout(r, 600));
    }

    // 1. Copy file to system pasteboard as native file object
    await copyFileToPasteboard(absPath);

    // 2. Move Rex to target drop area with visual indicator
    moveCursorTo(targetX, targetY, 400, 'handgrabbing');
    await new Promise(r => setTimeout(r, 450));

    // 3. Click to focus drop zone and paste (Cmd + V)
    cursorClick(targetX, targetY, 'handpointing', true);
    await new Promise(r => setTimeout(r, 250));
    cursorKeyPress('v', ['cmd']);
    await new Promise(r => setTimeout(r, 400));

    return { ok: true, file: path.basename(absPath), target: { x: targetX, y: targetY } };
}
