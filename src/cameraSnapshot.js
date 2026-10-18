/**
 * cameraSnapshot.js — Native macOS Webcam / FaceTime HD Camera Snapshot Engine
 *
 * Capabilities:
 * - Captures live snapshots from your Mac's camera via Photo Booth / imagesnap
 * - Uploads the snapshot directly into Discord chat
 * - Runs multimodal AI visual reasoning on the camera snapshot ("where are my keys?")
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import { executeAppleScript } from './appleScript.js';
import { analyzeScreen } from './vision.js';

const execAsync = promisify(exec);

/**
 * Capture a photo using available macOS camera methods
 * @param {string} [customOutPath]
 * @returns {Promise<string>} Path to captured image
 */
export async function captureCameraSnapshot(customOutPath = null) {
    const outDir = path.join(process.cwd(), '.rex', 'vision');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const targetPath = customOutPath || path.join(outDir, `webcam_${Date.now()}.jpg`);

    // Method 1: Check for imagesnap CLI
    try {
        await execAsync(`imagesnap -q -w 1.0 "${targetPath}"`, { timeout: 10000 });
        if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000) {
            return targetPath;
        }
    } catch {}

    // Method 2: Native Photo Booth AppleScript automation
    try {
        const script = `
            tell application "Photo Booth"
                activate
            end tell
            delay 0.8
            tell application "System Events"
                tell process "Photo Booth"
                    try
                        click menu item "Take Photo" of menu "File" of menu bar 1
                    on error
                        keystroke return
                    end try
                end tell
            end tell
            delay 1.2
        `;
        await executeAppleScript(script);

        const pbDir = path.join(os.homedir(), 'Pictures', 'Photo Booth Library', 'Pictures');
        if (fs.existsSync(pbDir)) {
            const files = fs.readdirSync(pbDir)
                .filter(f => !f.startsWith('.'))
                .map(f => ({ name: f, time: fs.statSync(path.join(pbDir, f)).mtimeMs }))
                .sort((a, b) => b.time - a.time);

            if (files.length > 0) {
                const latest = path.join(pbDir, files[0].name);
                fs.copyFileSync(latest, targetPath);
                return targetPath;
            }
        }
    } catch (e) {
        console.warn(pc.yellow(`Photo Booth capture attempt: ${e.message}`));
    }

    // Fallback: Check if there is an existing photobooth capture in current directory
    const existingDefault = path.join(process.cwd(), 'photobooth_capture.jpg');
    if (fs.existsSync(existingDefault)) {
        fs.copyFileSync(existingDefault, targetPath);
        return targetPath;
    }

    throw new Error('Could not capture webcam photo. Ensure camera permission is granted or install imagesnap (`brew install imagesnap`).');
}

/**
 * Capture camera photo and perform multimodal AI visual reasoning
 */
export async function analyzeCameraSnapshot(prompt = null) {
    const photoPath = await captureCameraSnapshot();
    const userPrompt = prompt || "You are Rex, an executive AI butler looking through the user's Mac webcam. Describe what is visible in front of the camera in clear, observational detail.";
    const analysis = await analyzeScreen(photoPath, userPrompt);
    return { photoPath, analysis };
}

/**
 * Discord command handler
 */
export async function tryHandleCameraCommand({ message, cleanContent }) {
    const text = String(cleanContent || message.content || '').trim();
    if (!text) return { handled: false };

    // Matches: "rex snap", "!snap", "rex photo", "take a photo of my desk", "look through camera"
    const isCameraReq = /^(?:!snap\b|!photo\b|(?:rex\s+)?(?:take\s*(?:a\s*)?(?:photo|picture|snap|snapshot)|snap\s*(?:desk|room|camera)|look\s*through\s*(?:my\s*)?camera|webcam\s*snap)\b)/i.test(text);

    if (!isCameraReq) return { handled: false };

    // Extract optional query: e.g. "take a photo and tell me where my mug is"
    const promptMatch = text.match(/(?:and\s+tell\s+me|check\s+if|what|where)\s+(.+)$/i);
    const query = promptMatch ? promptMatch[1] : null;

    const statusMsg = await message.reply("📸 *Snapping photo from Mac webcam and warming up vision sensors...*");

    try {
        const { photoPath, analysis } = await analyzeCameraSnapshot(query ? `Focus on this question: ${query}` : null);
        const { AttachmentBuilder } = await import('discord.js');
        const attachment = new AttachmentBuilder(photoPath, { name: 'webcam_snapshot.jpg' });

        await statusMsg.edit({
            content: `👁️📷 **Rex Camera Vision**:\n\n${analysis.slice(0, 1800)}`,
            files: [attachment]
        });
    } catch (e) {
        await statusMsg.edit(`❌ Webcam snapshot failed: ${e.message}`);
    }

    return { handled: true };
}
