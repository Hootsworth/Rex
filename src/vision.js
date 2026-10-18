import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { loadConfig } from './config.js';
import { playAudioCue } from './audioCues.js';
import { normalizeGeminiModel } from './ai.js';

const execPromise = util.promisify(exec);

/**
 * Capture current display or window screenshot
 * @param {string} [customOutPath] Optional custom save path
 * @returns {Promise<string|null>} Path to screenshot file
 */
export async function captureScreen(customOutPath = null) {
    try {
        const tempDir = path.join(process.cwd(), '.rex', 'vision');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const fullPath = customOutPath || path.join(tempDir, `screenshot_${Date.now()}.png`);

        let cmd = '';
        if (process.platform === 'darwin') {
            cmd = `screencapture -x "${fullPath}"`;
        } else if (process.platform === 'win32') {
            cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $Screen = [System.Windows.Forms.Screen]::PrimaryScreen; $Width = $Screen.Bounds.Width; $Height = $Screen.Bounds.Height; $Bitmap = New-Object System.Drawing.Bitmap($Width, $Height); $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap); $Graphics.CopyFromScreen(0, 0, 0, 0, $Bitmap.Size); $Bitmap.Save('${fullPath}', [System.Drawing.Imaging.ImageFormat]::Png); $Graphics.Dispose(); $Bitmap.Dispose();"`;
        } else {
            cmd = `import -window root "${fullPath}"`;
        }

        await execPromise(cmd);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0) {
            playAudioCue('confirm');
            return fullPath;
        }
        return null;
    } catch (err) {
        if (process.platform === 'darwin' && err.message?.includes('could not create image')) {
            console.warn(pc.yellow('⚠️ macOS Screen Recording permission needed: System Settings > Privacy & Security > Screen & System Audio Recording.'));
            import('./macosPermissions.js').then(m => m.ensureMacosPermissions({ silent: false })).catch(() => {});
        }
        return null;
    }
}

/**
 * Perform multimodal visual reasoning on screen capture or image file
 * @param {string} [imagePath] Path to image file (or captures screen if null)
 * @param {string} [userPrompt] Custom user question/instruction
 * @param {object} [options] { speak: boolean }
 * @returns {Promise<string>} Visual analysis result
 */
export async function analyzeScreen(imagePath = null, userPrompt = null, options = {}) {
    let targetPath = imagePath;

    let screenCursorModule = null;
    try {
        screenCursorModule = await import('./screenCursor.js');
        if (screenCursorModule.isScreenCursorRunning()) {
            screenCursorModule.cursorSpeak('Scanning your screen...', 3500, 'VISION');
            screenCursorModule.setCursorStyle('busy');
        }
    } catch {}

    if (!targetPath) {
        playAudioCue('listening');
        targetPath = await captureScreen();
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
        if (process.platform === 'darwin') {
            const { ensureMacosPermissions } = await import('./macosPermissions.js');
            await ensureMacosPermissions({ silent: false });
        }
        throw new Error('Screenshot capture failed. Please ensure Screen Recording permission is enabled or provide an image path.');
    }

    playAudioCue('thinking');
    const imageBytes = fs.readFileSync(targetPath);
    const base64Data = imageBytes.toString('base64');
    const config = loadConfig();

    const promptText = userPrompt || [
        "You are Rex, an executive AI butler like JARVIS.",
        "Analyze the provided screen capture in crisp, actionable detail.",
        "1. Identify active applications, errors, or code currently shown.",
        "2. If an error, stack trace, or bug is present, explain the root cause and provide the exact fix.",
        "3. Provide a concise butler-style executive summary."
    ].join(' ');

    let resultText = '';

    // Primary: Google Gemini 3.5 Flash
    if (config.geminiKey) {
        const genAI = new GoogleGenerativeAI(config.geminiKey);
        const modelName = normalizeGeminiModel(config.geminiModel || 'gemini-3.5-flash');
        const model = genAI.getGenerativeModel({ model: modelName });

        const response = await model.generateContent([
            promptText,
            {
                inlineData: {
                    data: base64Data,
                    mimeType: 'image/png'
                }
            }
        ]);
        resultText = response.response.text();
    } else if (config.openaiKey) {
        // Fallback: OpenAI Vision
        const openai = new OpenAI({ apiKey: config.openaiKey });
        const response = await openai.chat.completions.create({
            model: config.openaiModel || 'gpt-4o-mini',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: promptText },
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/png;base64,${base64Data}` }
                        }
                    ]
                }
            ]
        });
        resultText = response.choices[0]?.message?.content || '';
    } else {
        throw new Error('Vision analysis requires a Gemini or OpenAI API key. Configure one with `rexai open` or set geminiKey.');
    }

    playAudioCue('success');

    // Optional voice playback via Cartesia
    if (options.speak) {
        try {
            const { generateCartesiaSpeech } = await import('./cartesia.js');
            const audioPath = path.join(process.cwd(), `.rex_vision_speech_${Date.now()}.wav`);
            await generateCartesiaSpeech(resultText.slice(0, 500), audioPath);
            if (process.platform === 'darwin') {
                const { spawn } = await import('child_process');
                const child = spawn('afplay', [audioPath], { stdio: 'ignore', detached: true });
                child.unref();
                setTimeout(() => { try { fs.unlinkSync(audioPath); } catch {} }, 20000);
            }
        } catch {}
    }

    if (screenCursorModule?.isScreenCursorRunning?.()) {
        const cleanText = (resultText || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim();
        screenCursorModule.cursorSpeak(cleanText.slice(0, 130), 4500, 'VISION');
        screenCursorModule.setCursorStyle('default');
    }

    return resultText;
}

export async function visionMenu() {
    const choice = await p.select({
        message: 'Rex Vision (JARVIS Screen Intelligence):',
        options: [
            { value: 'capture', label: '📸 Capture Screen to File' },
            { value: 'analyze', label: '👁️ Analyze Screen with Gemini 3.5 Flash' },
            { value: 'analyze_voice', label: '🎙️ Analyze Screen & Speak Analysis Aloud' },
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(choice) || choice === 'back') return;

    if (choice === 'capture') {
        const s = p.spinner();
        s.start('Capturing display...');
        const file = await captureScreen();
        if (file) {
            s.stop(pc.green(`Screenshot saved: ${file}`));
        } else {
            s.stop(pc.red('Capture failed. Check screen recording permissions.'));
        }
    } else if (choice === 'analyze' || choice === 'analyze_voice') {
        const userPrompt = await p.text({
            message: 'What would you like Rex to look for? (Leave blank for general analysis):',
            placeholder: 'e.g. Debug this error / review UI'
        });
        if (p.isCancel(userPrompt)) return;

        const s = p.spinner();
        s.start('Rex is observing your screen...');
        try {
            const res = await analyzeScreen(null, userPrompt.trim() || null, { speak: choice === 'analyze_voice' });
            s.stop('Analysis complete.');
            p.note(res, 'Rex Vision (JARVIS)');
        } catch (err) {
            s.stop(pc.red('Analysis failed.'));
            p.log.error(err.message);
        }
    }
}
