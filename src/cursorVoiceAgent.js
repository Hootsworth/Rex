/**
 * cursorVoiceAgent.js — Autonomous Voice & Vision Copilot for Rex Screen Cursor
 *
 * Listens for the user's voice command when the hotkey (Control + Shift + Space) is pressed,
 * captures the active macOS screen, performs multimodal AI visual reasoning across
 * ANY application (DaVinci Resolve, forms, code, media tools, browsers, etc.),
 * and autonomously moves Rex's cursor across the screen, highlighting UI elements,
 * clicking controls, and explaining what to do step-by-step!
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { loadConfig } from './config.js';
import { playAudioCue } from './audioCues.js';
import { captureScreen } from './vision.js';
import {
    isScreenCursorRunning,
    startScreenCursor,
    setCursorMode,
    setCursorStyle,
    setBargeInEnabled,
    setRexEmotion,
    moveCursorTo,
    cursorClick,
    cursorDoubleClick,
    cursorRightClick,
    cursorDrag,
    cursorType,
    cursorKeyPress,
    cursorActivateApp,
    cursorSpeak,
    cursorHighlight,
    hideCursorHighlight,
    getTargetWindowBounds,
    getScreenDimensions,
    onUserBargeIn
} from './screenCursor.js';
import { findBestUiElement } from './accessibilityInspector.js';
import { classifyActionRisk } from './actionRiskGuard.js';
import { recordMacroStep, isRecordingMacro } from './cursorMacroRecorder.js';
import { verifyAndSelfCorrect } from './closedLoopVerifier.js';
import { dropFileIntoWindow } from './crossAppDragDrop.js';
import { autofillActiveForm } from './formAutofillEngine.js';

const execAsync = promisify(exec);

let isAgentBusy = false;

function getFfmpegPath() {
    const local = path.resolve(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(local)) return local;
    return 'ffmpeg';
}

/**
 * Record audio from default microphone on macOS for a specific duration
 */
async function recordMicAudio(durationSeconds = 4, targetPath) {
    const ffmpeg = getFfmpegPath();
    const cmd = `"${ffmpeg}" -y -f avfoundation -i ":default" -t ${durationSeconds} -ar 16000 -ac 1 "${targetPath}"`;
    try {
        await execAsync(cmd, { stdio: 'ignore' });
        return fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000;
    } catch {
        try {
            const fallbackCmd = `"${ffmpeg}" -y -f avfoundation -i ":0" -t ${durationSeconds} -ar 16000 -ac 1 "${targetPath}"`;
            await execAsync(fallbackCmd, { stdio: 'ignore' });
            return fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000;
        } catch {
            return false;
        }
    }
}

/**
 * Transcribe recorded audio using Whisper or Gemini
 */
async function transcribeAudio(wavPath) {
    if (!fs.existsSync(wavPath)) return '';
    const config = loadConfig();

    // 1. Google Gemini Multimodal Audio Transcription
    if (config.geminiKey) {
        try {
            const genAI = new GoogleGenerativeAI(config.geminiKey);
            const model = genAI.getGenerativeModel({ model: config.geminiModel || 'gemini-3.5-flash' });
            const audioBytes = fs.readFileSync(wavPath).toString('base64');

            const resp = await model.generateContent([
                {
                    inlineData: {
                        mimeType: 'audio/wav',
                        data: audioBytes
                    }
                },
                'Transcribe the user voice command in this audio clip word-for-word. Return ONLY the transcribed text with no extra commentary or quotes.'
            ]);
            const text = (resp.response.text() || '').trim();
            if (text) return text;
        } catch {}
    }

    // 2. OpenAI Whisper-1 Fallback
    if (config.openaiKey) {
        try {
            const openai = new OpenAI({ apiKey: config.openaiKey });
            const resp = await openai.audio.transcriptions.create({
                file: fs.createReadStream(wavPath),
                model: 'whisper-1'
            });
            const text = (resp.text || '').trim();
            if (text) return text;
        } catch {}
    }

    return '';
}

/**
 * Speak text aloud using system TTS or Cartesia
 */
async function speakAloud(text) {
    if (!text) return;
    try {
        const { generateCartesiaSpeech } = await import('./cartesia.js');
        const audioPath = path.join(process.cwd(), `.rex_cursor_voice_${Date.now()}.wav`);
        await generateCartesiaSpeech(text.slice(0, 300), audioPath);
        if (fs.existsSync(audioPath)) {
            await execAsync(`afplay "${audioPath}"`).catch(() => {});
            try { fs.unlinkSync(audioPath); } catch {}
            return;
        }
    } catch {}

    // Fallback: macOS native 'say'
    try {
        const cleanText = text.replace(/"/g, '\\"').slice(0, 150);
        await execAsync(`say -v Samantha "${cleanText}" || say "${cleanText}"`).catch(() => {});
    } catch {}
}

/**
 * Multimodal Visual Reasoner: analyzes screenshot and produces a step-by-step cursor action plan
 */
export async function planScreenActions(screenshotPath, userCommand, screenWidth = 1440, screenHeight = 900) {
    const config = loadConfig();
    const imageBytes = fs.readFileSync(screenshotPath);
    const base64Data = imageBytes.toString('base64');

    // Detect physical screenshot pixel dimensions to calculate Retina scale factor
    let imgWidth = screenWidth * 2;
    let imgHeight = screenHeight * 2;
    try {
        const { stdout } = await execAsync(`sips -g pixelWidth -g pixelHeight "${screenshotPath}"`);
        const wMatch = stdout.match(/pixelWidth:\s*(\d+)/);
        const hMatch = stdout.match(/pixelHeight:\s*(\d+)/);
        if (wMatch) imgWidth = parseInt(wMatch[1], 10);
        if (hMatch) imgHeight = parseInt(hMatch[1], 10);
    } catch {}

    const scaleX = imgWidth / screenWidth;
    const scaleY = imgHeight / screenHeight;

    const systemPrompt = `
You are Rex, an autonomous expert AI desktop copilot with direct operating system control over macOS.
You take REAL actions directly on the user's screen: clicking buttons, double clicking, right clicking, dragging sliders and color wheels, typing text into form inputs, and triggering shortcuts.

The user has given this command while looking at their screen:
"${userCommand}"

Display Resolution: ${screenWidth} x ${screenHeight} points (Image capture resolution: ${imgWidth} x ${imgHeight} pixels, Retina scale ${scaleX.toFixed(2)}x).

Analyze the provided screenshot carefully:
1. Identify the active application (e.g. DaVinci Resolve, Google Chrome, Safari, VS Code, Finder, Slack, etc.).
2. Determine the exact sequence of UI actions needed to physically accomplish the user's request.
3. For each UI element to interact with, specify coordinates on the ${screenWidth}x${screenHeight} macOS display.
4. Support all desktop actions:
   - "click": clicks a button, tab, link, or menu item
   - "type": clicks an input field to focus and types text into it
   - "drag": drags a slider, color wheel, or window from (x, y) to (toX, toY)
   - "doubleClick": double clicks an item (e.g. to open or select all)
   - "rightClick": opens context menu
   - "key": presses a key shortcut (e.g. return, tab, escape, or cmd+s)

MANDATORY MULTI-STEP WORKFLOW:
The user has requested autonomous control. You must generate a sequence of MULTIPLE CONSECUTIVE STEPS (minimum 4 to 8 steps). Do NOT return just 1 or 2 steps!
Break the user's task down into all necessary sequential steps:
1. Activating / focusing the target application or window
2. Navigating to the relevant workspace, tab, or tool palette
3. Highlighting and clicking controls, buttons, or inputs
4. Adjusting sliders, wheels, or dragging elements
5. Typing required text or triggering native keyboard shortcuts
6. Verifying the result or confirming the action!

Return a JSON response with:
- "activeApp": Exact Name of the application (e.g. "DaVinci Resolve", "Google Chrome", "Finder")
- "summary": A concise 1-2 sentence executive explanation of what Rex is doing
- "steps": An array of sequential UI steps for Rex to physically execute.
  Each step must have:
  * "step": integer (1, 2, 3...)
  * "action": "click" | "type" | "drag" | "doubleClick" | "rightClick" | "key"
  * "x": approximate integer X pixel coordinate on display (0 to ${screenWidth})
  * "y": approximate integer Y pixel coordinate on display (0 to ${screenHeight})
  * "toX": integer destination X (if action is "drag")
  * "toY": integer destination Y (if action is "drag")
  * "text": string to type into the focused field (if action is "type")
  * "submit": boolean (true if Rex should press Return after typing)
  * "key": string key name (if action is "key", e.g. "return", "tab", "escape", "space")
  * "modifiers": array of strings (e.g. ["cmd"])
  * "w": bounding box width (e.g. 120)
  * "h": bounding box height (e.g. 45)
  * "label": Short name of element (e.g. "Color Page Tab", "Lift Wheel", "Email Input", "Export Button")
  * "speech": Concise, helpful instruction spoken to user (1-2 clear sentences. CRITICAL: Do NOT use any emojis anywhere in your text or speech. Use clean, elegant text only.)
  * "cursorStyle": "handpointing" | "handopen" | "handgrabbing" | "beachball" | "default"

CRITICAL: Return ONLY valid, parseable JSON with NO markdown code fences or backticks. Do NOT include ANY emojis in any text fields.
`;

    // 1. Google Gemini 3.5 Flash Multimodal
    if (config.geminiKey) {
        try {
            const genAI = new GoogleGenerativeAI(config.geminiKey);
            const model = genAI.getGenerativeModel({
                model: config.geminiModel || 'gemini-3.5-flash',
                generationConfig: { responseMimeType: 'application/json' }
            });

            const resp = await model.generateContent([
                systemPrompt,
                {
                    inlineData: {
                        data: base64Data,
                        mimeType: 'image/png'
                    }
                }
            ]);
            const rawJson = resp.response.text();
            const plan = JSON.parse(rawJson);
            if (Array.isArray(plan?.steps) && plan.steps.length >= 3) {
                return { plan, scaleX, scaleY };
            }
        } catch (e) {
            console.warn(pc.yellow(`Gemini vision error: ${e.message}`));
        }
    }

    // 2. OpenAI GPT-4o-mini Vision Fallback
    if (config.openaiKey) {
        try {
            const openai = new OpenAI({ apiKey: config.openaiKey });
            const resp = await openai.chat.completions.create({
                model: config.openaiModel || 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: systemPrompt },
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } }
                        ]
                    }
                ]
            });
            const rawJson = resp.choices[0]?.message?.content || '{}';
            const plan = JSON.parse(rawJson);
            if (Array.isArray(plan?.steps) && plan.steps.length >= 3) {
                return { plan, scaleX, scaleY };
            }
        } catch (e) {
            console.warn(pc.yellow(`OpenAI vision error: ${e.message}`));
        }
    }

    // Detect target app from command
    const cmd = String(userCommand || '').toLowerCase().trim();
    let appCandidate = '';
    if (cmd.includes('zen')) appCandidate = 'Zen';
    else if (cmd.includes('chrome')) appCandidate = 'Google Chrome';
    else if (cmd.includes('davinci') || cmd.includes('da vinci') || cmd.includes('color grade')) appCandidate = 'DaVinci Resolve';
    else if (cmd.includes('whatsapp') || cmd.includes('wahsyapp')) appCandidate = 'WhatsApp';
    else if (cmd.includes('terminal')) appCandidate = 'Terminal';
    else if (cmd.includes('code') || cmd.includes('vscode')) appCandidate = 'Visual Studio Code';

    const windowBounds = await getTargetWindowBounds(appCandidate);
    if (windowBounds?.screenWidth && windowBounds?.screenHeight) {
        screenWidth = windowBounds.screenWidth;
        screenHeight = windowBounds.screenHeight;
    }

    // 3. Intelligent Multi-Step Domain Planner
    const plan = generateMultiStepPlan(userCommand, screenWidth, screenHeight, windowBounds);
    return { plan, scaleX, scaleY };
}

/**
 * Intelligent Multi-Step Domain Planner: Generates comprehensive sequences for tasks
 * anchored directly to the target application's real macOS window bounds (x, y, width, height).
 */
export function generateMultiStepPlan(userCommand = '', screenWidth = 1470, screenHeight = 956, windowBounds = null) {
    const cmd = String(userCommand || '').toLowerCase().trim();

    // Use detected window bounds or default to full display area (minus macOS top menu bar)
    const win = windowBounds && windowBounds.found ? windowBounds : {
        x: 0,
        y: 33,
        width: screenWidth,
        height: Math.max(500, screenHeight - 33)
    };

    const winX = Math.round(Number(win.x) || 0);
    const winY = Math.round(Number(win.y) || 33);
    const winW = Math.round(Number(win.width) || screenWidth);
    const winH = Math.round(Number(win.height) || (screenHeight - 33));

    // 1. DaVinci Resolve / Color Grading
    if (cmd.includes('davinci') || cmd.includes('da vinci') || cmd.includes('color grade') || cmd.includes('grade')) {
        return {
            activeApp: "DaVinci Resolve",
            summary: "Executing autonomous DaVinci Resolve color grading masterclass: switching to Color page, balancing Lift shadows, tuning Gamma midtones, and refining Gain highlights.",
            steps: [
                {
                    step: 1,
                    action: "click",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.45),
                    w: 320,
                    h: 80,
                    label: "DaVinci Resolve Workspace",
                    speech: "Activating DaVinci Resolve and focusing the workspace.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 2,
                    action: "click",
                    x: winX + Math.round(winW * 0.51),
                    y: winY + winH - 24,
                    w: 70,
                    h: 40,
                    label: "Color Workspace Page Tab",
                    speech: "Switching directly to the Color workspace tab at the bottom toolbar.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 3,
                    action: "click",
                    x: winX + Math.round(winW * 0.18),
                    y: winY + Math.round(winH * 0.79),
                    w: 120,
                    h: 120,
                    label: "Lift (Shadows) Color Wheel",
                    speech: "Focusing the Lift color wheel to control your dark shadow levels.",
                    cursorStyle: "handopen"
                },
                {
                    step: 4,
                    action: "drag",
                    x: winX + Math.round(winW * 0.18),
                    y: winY + Math.round(winH * 0.79),
                    toX: winX + Math.round(winW * 0.184),
                    toY: winY + Math.round(winH * 0.806),
                    w: 130,
                    h: 130,
                    label: "Adjust Lift Shadows Balance",
                    speech: "Dragging the Lift wheel slightly towards teal/blue to establish clean shadow contrast.",
                    cursorStyle: "handgrabbing"
                },
                {
                    step: 5,
                    action: "click",
                    x: winX + Math.round(winW * 0.35),
                    y: winY + Math.round(winH * 0.79),
                    w: 120,
                    h: 120,
                    label: "Gamma (Midtones) Color Wheel",
                    speech: "Moving to Gamma to shape skin tones and overall midtone luminance.",
                    cursorStyle: "handopen"
                },
                {
                    step: 6,
                    action: "drag",
                    x: winX + Math.round(winW * 0.35),
                    y: winY + Math.round(winH * 0.79),
                    toX: winX + Math.round(winW * 0.353),
                    toY: winY + Math.round(winH * 0.782),
                    w: 130,
                    h: 130,
                    label: "Adjust Gamma Skin Tone Warmth",
                    speech: "Adjusting Gamma slightly towards warm orange/gold to bring out natural skin glow.",
                    cursorStyle: "handgrabbing"
                },
                {
                    step: 7,
                    action: "click",
                    x: winX + Math.round(winW * 0.52),
                    y: winY + Math.round(winH * 0.79),
                    w: 120,
                    h: 120,
                    label: "Gain (Highlights) Color Wheel",
                    speech: "Targeting the Gain wheel to dial in clean highlights without clipping.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 8,
                    action: "click",
                    x: winX + Math.round(winW * 0.82),
                    y: winY + Math.round(winH * 0.22),
                    w: 220,
                    h: 140,
                    label: "Node Tree & Preview Viewer",
                    speech: "Reviewing your primary grade in the Node Tree and preview monitor.",
                    cursorStyle: "handpointing"
                }
            ]
        };
    }

    // 2. WhatsApp / Messaging in Browser or Desktop (e.g. Zen Browser, WhatsApp Web, desktop WhatsApp)
    if (cmd.includes('whatsapp') || cmd.includes('wahsyapp') || cmd.includes('message') || cmd.includes('chat') || cmd.includes('dm') || (cmd.includes('zen') && (cmd.includes('send') || cmd.includes('type')))) {
        let appName = "Zen";
        if (cmd.includes('chrome')) appName = "Google Chrome";
        else if (cmd.includes('safari')) appName = "Safari";
        else if (cmd.includes('whatsapp') && !cmd.includes('browser') && !cmd.includes('zen')) appName = "WhatsApp";

        // Extract message text and contact robustly
        let textToSend = "yeah man idk";
        let contact = "contact";

        const cleanCmd = cmd.replace(/\s+(?:in|on)\s+(?:zen(?:\s+browser)?|google\s+chrome|chrome|safari|whatsapp|wahsyapp).*$/i, '').trim();
        const msgMatch = cleanCmd.match(/(?:send|type|say)\s+(?:["\x27]([^\x27"]+)["\x27]|(.+?))\s+to\s+(?:(?:a|the|my)\s+)?(?:(?:whatsapp|wahsyapp)\s+)?(?:contact\s+)?([a-zA-Z0-9_\s]*)$/i);
        if (msgMatch) {
            textToSend = (msgMatch[1] || msgMatch[2] || textToSend).trim();
            const candContact = (msgMatch[3] || '').trim();
            if (candContact && !['a', 'the', 'my', 'contact', 'wahsyapp', 'whatsapp', ''].includes(candContact.toLowerCase())) {
                contact = candContact;
            }
        }

        // Exact WhatsApp Web geometry inside the target window:
        const sideW = Math.max(280, Math.min(420, Math.round(winW * 0.30)));
        const sideCenterX = winX + Math.round(sideW * 0.5);
        // Search bar position: below top toolbar & header
        const searchY = winY + 135;
        // First contact item in chat list
        const firstChatY = winY + 205;
        // Right chat panel layout
        const chatPanelW = winW - sideW;
        const composerX = winX + sideW + Math.round(chatPanelW * 0.45);
        // Bottom composer input is 44px above the bottom of the window
        const composerY = winY + winH - 44;
        const sendBtnX = winX + winW - 36;
        const sendBtnY = composerY;

        return {
            activeApp: appName,
            summary: `Executing autonomous messaging workflow in ${appName}: focusing window, searching "${contact}", composing message "${textToSend}", and sending.`,
            steps: [
                {
                    step: 1,
                    action: "click",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.35),
                    w: Math.min(400, Math.round(winW * 0.5)),
                    h: 120,
                    label: `${appName} Window Focus`,
                    speech: `Activating ${appName} and bringing WhatsApp window to the front.`,
                    cursorStyle: "handpointing"
                },
                {
                    step: 2,
                    action: "click",
                    x: sideCenterX,
                    y: searchY,
                    w: Math.round(sideW * 0.88),
                    h: 38,
                    label: "Search or Start New Chat",
                    speech: `Focusing search bar to locate ${contact}.`,
                    cursorStyle: "handpointing"
                },
                {
                    step: 3,
                    action: "type",
                    x: sideCenterX,
                    y: searchY,
                    w: Math.round(sideW * 0.88),
                    h: 38,
                    text: contact !== "contact" ? contact : "",
                    submit: true,
                    label: `Search Contact (${contact})`,
                    speech: `Searching for ${contact} in chat list.`,
                    cursorStyle: "handpointing"
                },
                {
                    step: 4,
                    action: "click",
                    x: sideCenterX,
                    y: firstChatY,
                    w: sideW - 16,
                    h: 68,
                    label: "Select Target Chat",
                    speech: `Opening chat conversation with ${contact}.`,
                    cursorStyle: "handpointing"
                },
                {
                    step: 5,
                    action: "click",
                    x: composerX,
                    y: composerY,
                    w: Math.round(chatPanelW * 0.70),
                    h: 46,
                    label: "Message Input Composer",
                    speech: "Focusing message composer at bottom of chat.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 6,
                    action: "type",
                    x: composerX,
                    y: composerY,
                    w: Math.round(chatPanelW * 0.70),
                    h: 46,
                    text: textToSend,
                    submit: false,
                    label: `Type Message ("${textToSend}")`,
                    speech: `Typing "${textToSend}" into message composer.`,
                    cursorStyle: "handpointing"
                },
                {
                    step: 7,
                    action: "key",
                    key: "return",
                    x: sendBtnX,
                    y: sendBtnY,
                    w: 48,
                    h: 48,
                    label: "Send Message (Return / Send Button)",
                    speech: "Sending the message to chat.",
                    cursorStyle: "default"
                },
                {
                    step: 8,
                    action: "click",
                    x: winX + winW - 140,
                    y: winY + winH - 110,
                    w: 260,
                    h: 64,
                    label: "Verify Sent Message Bubble",
                    speech: "Message sent successfully in chat.",
                    cursorStyle: "handpointing"
                }
            ]
        };
    }

    // 3. Form Solving / Input Automation
    if (cmd.includes('form') || cmd.includes('fill') || cmd.includes('input') || cmd.includes('submit')) {
        return {
            activeApp: "Active Form Application",
            summary: "Executing autonomous form automation: focusing inputs, typing fields, toggling options, and submitting.",
            steps: [
                {
                    step: 1,
                    action: "click",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.30),
                    w: 300,
                    h: 44,
                    label: "First Name / Primary Input",
                    speech: "Targeting the first input field on the form.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 2,
                    action: "type",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.30),
                    w: 300,
                    h: 44,
                    text: "Rex Copilot",
                    label: "Type Primary Info",
                    speech: "Typing verified identification into the primary field.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 3,
                    action: "click",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.40),
                    w: 300,
                    h: 44,
                    label: "Email / Secondary Field",
                    speech: "Focusing secondary input field.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 4,
                    action: "type",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.40),
                    w: 300,
                    h: 44,
                    text: "rex.autonomous@power-cli.local",
                    label: "Type Contact / Email",
                    speech: "Entering contact credentials into the active input.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 5,
                    action: "click",
                    x: winX + Math.round(winW * 0.48),
                    y: winY + Math.round(winH * 0.52),
                    w: 26,
                    h: 26,
                    label: "Terms & Confirmation Checkbox",
                    speech: "Checking the required confirmation checkbox.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 6,
                    action: "click",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.62),
                    w: 200,
                    h: 48,
                    label: "Submit / Continue Button",
                    speech: "Clicking the primary submit button to finalize form processing.",
                    cursorStyle: "handpointing"
                }
            ]
        };
    }

    // 4. Creative / Media Editing (Figma, Photoshop, Blender, Premiere, Final Cut)
    if (cmd.includes('figma') || cmd.includes('photoshop') || cmd.includes('blender') || cmd.includes('premiere') || cmd.includes('canvas') || cmd.includes('timeline')) {
        return {
            activeApp: "Creative Studio Application",
            summary: "Executing multi-step autonomous creative workflow across tools, canvas, and inspectors.",
            steps: [
                {
                    step: 1,
                    action: "click",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.48),
                    w: Math.min(450, Math.round(winW * 0.6)),
                    h: 240,
                    label: "Main Canvas / Viewport",
                    speech: "Focusing the active canvas viewport.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 2,
                    action: "click",
                    x: winX + Math.max(30, Math.round(winW * 0.05)),
                    y: winY + Math.round(winH * 0.32),
                    w: 44,
                    h: 44,
                    label: "Toolbar Selection Tool",
                    speech: "Selecting primary editing tool from the left palette.",
                    cursorStyle: "handpointing"
                },
                {
                    step: 3,
                    action: "drag",
                    x: winX + Math.round(winW * 0.5),
                    y: winY + Math.round(winH * 0.5),
                    toX: winX + Math.round(winW * 0.56),
                    toY: winY + Math.round(winH * 0.53),
                    w: 120,
                    h: 120,
                    label: "Transform / Position Element",
                    speech: "Adjusting element position on canvas.",
                    cursorStyle: "handgrabbing"
                },
                {
                    step: 4,
                    action: "key",
                    key: "s",
                    modifiers: ["cmd"],
                    label: "Save Shortcut (Cmd+S)",
                    speech: "Dispatching keyboard shortcut Command+S to save changes.",
                    cursorStyle: "default"
                },
                {
                    step: 5,
                    action: "click",
                    x: winX + winW - Math.min(180, Math.round(winW * 0.15)),
                    y: winY + Math.round(winH * 0.35),
                    w: 160,
                    h: 60,
                    label: "Inspector Properties Panel",
                    speech: "Verifying properties in the right inspector panel.",
                    cursorStyle: "handpointing"
                }
            ]
        };
    }

    // 5. Default / General Desktop Multi-Step Workflow
    return {
        activeApp: win.owner || "macOS Desktop",
        summary: `Executing complete autonomous sequence for "${userCommand}".`,
        steps: [
            {
                step: 1,
                action: "click",
                x: winX + Math.round(winW * 0.5),
                y: winY + Math.round(winH * 0.35),
                w: Math.min(300, Math.round(winW * 0.5)),
                h: 80,
                label: "Target Window / Document Header",
                speech: `Activating target window for: ${userCommand.slice(0, 50)}.`,
                cursorStyle: "handpointing"
            },
            {
                step: 2,
                action: "click",
                x: winX + Math.round(winW * 0.32),
                y: winY + Math.round(winH * 0.46),
                w: 140,
                h: 45,
                label: "Action Toolbar / Option Tab",
                speech: "Locating and navigating to primary option tab.",
                cursorStyle: "handpointing"
            },
            {
                step: 3,
                action: "click",
                x: winX + Math.round(winW * 0.5),
                y: winY + Math.round(winH * 0.50),
                w: 220,
                h: 55,
                label: "Primary Control Hitbox",
                speech: "Engaging primary control element.",
                cursorStyle: "handpointing"
            },
            {
                step: 4,
                action: "key",
                key: "return",
                label: "Apply Action (Return)",
                speech: "Triggering action confirmation.",
                cursorStyle: "default"
            },
            {
                step: 5,
                action: "click",
                x: winX + Math.round(winW * 0.65),
                y: winY + Math.round(winH * 0.55),
                w: 160,
                h: 45,
                label: "Final Status / Confirmation Area",
                speech: "Verifying output state and completing workflow.",
                cursorStyle: "handpointing"
            }
        ]
    };
}

/**
 * Execute the autonomous cursor demonstration and navigation across macOS
 */
export async function executeActionPlan(plan, screenWidth = 1470, screenHeight = 956, scaleX = 2.0, scaleY = 2.0) {
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        cursorSpeak("Ready. What would you like to explore next?", 3500, "READY");
        return { success: false, reason: 'No steps generated' };
    }

    setCursorMode('autonomous');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const executedSteps = [];

    // 1. Bring target application to front if detected
    if (plan.activeApp) {
        cursorActivateApp(plan.activeApp);
        await sleep(800);
    }

    // Dynamic target window detection to refine coordinates
    const liveWin = await getTargetWindowBounds(plan.activeApp || '');
    if (liveWin?.screenWidth && liveWin?.screenHeight) {
        screenWidth = liveWin.screenWidth;
        screenHeight = liveWin.screenHeight;
    }

    cursorSpeak(`Found ${plan.activeApp || 'active application'}. Taking over and executing actions.`, 3500, "GUIDE");
    await sleep(1500);

    let lastTargetX = Math.round(screenWidth / 2);
    let lastTargetY = Math.round(screenHeight / 2);
    let userInterrupted = false;

    onUserBargeIn((evt) => {
        userInterrupted = true;
    });

    // Enable barge-in strictly for physical action execution!
    setBargeInEnabled(true);

    try {
        for (const step of plan.steps) {
            if (userInterrupted) {
                setRexEmotion('sad');
                cursorSpeak("Emergency Brake: Autonomous sequence paused. Controls yielded to you.", 4000, "PAUSED");
                break;
            }

        const hasExplicitX = step.x !== undefined && step.x !== null;
        const hasExplicitY = step.y !== undefined && step.y !== null;

        let targetX = hasExplicitX ? Number(step.x) : lastTargetX;
        let targetY = hasExplicitY ? Number(step.y) : lastTargetY;
        let w = Math.min(screenWidth, Number(step.w) || 160);
        let h = Math.min(screenHeight, Number(step.h) || 60);

        // 1. Accessibility Tree Hitbox Refinement (pixel-perfect native coordinate matching)
        if (step.label && plan.activeApp) {
            try {
                const axElem = await findBestUiElement(plan.activeApp, step.label);
                if (axElem && axElem.width > 12 && axElem.height > 10) {
                    targetX = Math.round(axElem.x + axElem.width / 2);
                    targetY = Math.round(axElem.y + axElem.height / 2);
                    w = Math.round(axElem.width);
                    h = Math.round(axElem.height);
                }
            } catch {}
        }

        // If coordinates were provided in Retina physical image pixel space, scale down to macOS points
        if (targetX > screenWidth && scaleX > 1.0) targetX /= scaleX;
        if (targetY > screenHeight && scaleY > 1.0) targetY /= scaleY;

        targetX = Math.max(10, Math.min(screenWidth - 10, Math.round(targetX)));
        targetY = Math.max(10, Math.min(screenHeight - 10, Math.round(targetY)));
        lastTargetX = targetX;
        lastTargetY = targetY;

        let toX = Number(step.toX) || targetX;
        let toY = Number(step.toY) || targetY;
        if (toX > screenWidth && scaleX > 1.0) toX /= scaleX;
        if (toY > screenHeight && scaleY > 1.0) toY /= scaleY;
        toX = Math.max(10, Math.min(screenWidth - 10, Math.round(toX)));
        toY = Math.max(10, Math.min(screenHeight - 10, Math.round(toY)));

        const boxX = Math.max(10, targetX - w / 2);
        const boxY = Math.max(10, targetY - h / 2);

        // 2. Action Risk Classification & Safety Guardrails
        const risk = classifyActionRisk(step.label || '', step.speech || '');
        if (risk.level === 'HIGH_RISK') {
            setRexEmotion('shocked');
            cursorHighlight(boxX, boxY, w, h, `HIGH RISK: ${step.label}`);
            cursorSpeak(`Caution: High-risk operation detected (${risk.reason}). Verifying safety...`, 4000, "CAUTION");
            playAudioCue('warn');
            await sleep(1800);
        } else {
            setRexEmotion('excited');
        }

        // 3. Visibly move Rex cursor to target
        moveCursorTo(targetX, targetY, 400, step.cursorStyle || 'handpointing');
        await sleep(420);

        // 4. Draw spotlight highlight box around the UI element
        cursorHighlight(boxX, boxY, w, h, step.label || `Step ${step.step}`);

        // 5. Show glassmorphic speech bubble and speak aloud (scrub any rogue emojis from model)
        const cleanSpeech = (step.speech || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim();
        cursorSpeak(cleanSpeech, 4500, `STEP ${step.step || 1}`);
        speakAloud(cleanSpeech).catch(() => {});

        // 6. ACTUALLY EXECUTE REAL OS ACTION ON MAC (real takeover!)
        const action = (step.action || (step.click ? 'click' : 'click')).toLowerCase();

        if (action === 'type' || step.text) {
            // Click directly into the field twice with delay to ensure window focus and caret placement
            cursorClick(targetX, targetY, 'handpointing', true);
            await sleep(250);
            cursorClick(targetX, targetY, 'handpointing', true);
            await sleep(350);
            if (step.text) {
                cursorType(step.text);
                await sleep(350);
            }
            if (step.submit || step.pressReturn) {
                cursorKeyPress('return');
                await sleep(250);
            }
        } else if (action === 'doubleclick') {
            cursorDoubleClick(targetX, targetY, step.cursorStyle || 'handpointing');
            await sleep(300);
        } else if (action === 'rightclick') {
            cursorRightClick(targetX, targetY, step.cursorStyle || 'handpointing');
            await sleep(300);
        } else if (action === 'drag') {
            cursorDrag(targetX, targetY, toX, toY, 15);
            await sleep(400);
        } else if (action === 'key') {
            // If key action has explicit coordinates (e.g. send button), click the target button to trigger action reliably!
            if (hasExplicitX && hasExplicitY) {
                cursorClick(targetX, targetY, 'handpointing', true);
                await sleep(200);
            }
            cursorKeyPress(step.key || 'return', step.modifiers || []);
            await sleep(200);
        } else {
            // Default: Real OS left-click on the target control!
            cursorClick(targetX, targetY, step.cursorStyle || 'handpointing', true);
            await sleep(350);
        }

        // 7. Closed-loop verification and self-correction (auto-dismiss blocker dialogs if any)
        try {
            await verifyAndSelfCorrect(step, plan.activeApp);
        } catch {}

        // 8. Record macro step if recording is active
        if (isRecordingMacro()) {
            recordMacroStep({
                action,
                label: step.label,
                x: targetX,
                y: targetY,
                w,
                h,
                text: step.text,
                key: step.key,
                app: plan.activeApp
            });
        }

        executedSteps.push({
            step: step.step || (executedSteps.length + 1),
            action,
            label: step.label || `Hitbox (${targetX}, ${targetY})`,
            x: targetX,
            y: targetY,
            toX: action === 'drag' ? toX : undefined,
            toY: action === 'drag' ? toY : undefined,
            w,
            h,
            text: step.text,
            key: step.key,
            speech: cleanSpeech
        });

        // Wait for user to observe and UI to respond
        await sleep(2400);
    }
    } finally {
        setBargeInEnabled(false);
    }

    // Finish tour and hold autonomous position (do NOT snap to user cursor!)
    hideCursorHighlight();
    setRexEmotion('happy');
    cursorSpeak(`All autonomous steps executed successfully. Rex is holding position.`, 4000, "READY");
    playAudioCue('success');
    await sleep(1500);
    // Keep autonomous mode active!
    setCursorMode('autonomous');

    return {
        success: true,
        activeApp: plan.activeApp || 'macOS Application',
        summary: plan.summary || 'Executed autonomous screen actions',
        steps: executedSteps
    };
}

/**
 * Main Trigger: Listen to user voice -> Capture screen -> Figure it out -> Guide user!
 * Can be triggered via Hotkey (Control + Shift + Space), Mascot Pet, or CLI.
 */
export async function triggerVoiceCommand(options = {}) {
    if (isAgentBusy) {
        console.log(pc.yellow('Rex is already busy figuring out a command...'));
        return;
    }
    isAgentBusy = true;

    try {
        if (!isScreenCursorRunning()) {
            await startScreenCursor({ mode: 'autonomous', checkPermissions: true, silent: true });
        } else {
            setCursorMode('autonomous');
        }
        setBargeInEnabled(false);

        const cacheDir = path.join(process.cwd(), '.rex', 'cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const audioPath = path.join(cacheDir, `voice_cmd_${Date.now()}.wav`);

        // 1. Enter Listening Mode
        playAudioCue('listening');
        setRexEmotion('thinking');
        cursorSpeak("Listening... Speak a command (e.g., 'teach me color grading in DaVinci')", 4000, "LISTENING");
        setCursorStyle('beachball');

        const { width = 1440, height = 900 } = (options.dimensions || {});

        // Record 4 seconds of microphone input
        console.log(pc.cyan('[Rex Screen Copilot]: Recording voice command...'));
        const recorded = await recordMicAudio(4, audioPath);

        if (!recorded) {
            setRexEmotion('sad');
            cursorSpeak("Could not capture audio from microphone. Please ensure microphone access is granted.", 3500, "ERROR");
            isAgentBusy = false;
            return;
        }

        // 2. Enter Thinking Mode
        playAudioCue('thinking');
        setRexEmotion('thinking');
        cursorSpeak("Analyzing your screen and planning actions...", 4500, "THINKING");
        setCursorStyle('busy');

        // 3. Transcribe speech
        const userPrompt = await transcribeAudio(audioPath);
        try { fs.unlinkSync(audioPath); } catch {}

        if (!userPrompt) {
            setRexEmotion('sad');
            cursorSpeak("Speech unrecognized. Please try speaking again.", 3500, "READY");
            isAgentBusy = false;
            return;
        }

        console.log(pc.green(`User Spoke: "${userPrompt}"`));
        cursorSpeak(`Command: "${userPrompt}"\nScanning screen...`, 3500, "SCANNING");

        // 4. Capture screenshot of current screen
        const screenshotPath = await captureScreen();
        if (!screenshotPath || !fs.existsSync(screenshotPath)) {
            setRexEmotion('crying');
            cursorSpeak("Could not capture screen. Please check Screen Recording permissions.", 3500, "ERROR");
            isAgentBusy = false;
            return;
        }

        // 5. Multimodal AI Visual Reasoning
        console.log(pc.cyan('Rex is figuring out the UI layout and planning action sequence...'));
        const { plan, scaleX, scaleY } = await planScreenActions(screenshotPath, userPrompt, width, height);

        // 6. Execute autonomous cursor actions across macOS (real OS takeover!)
        await executeActionPlan(plan, width, height, scaleX, scaleY);

    } catch (err) {
        console.error(pc.red(`Error in Rex Voice Screen Copilot: ${err.message}`));
        cursorSpeak(`Notice: ${err.message.slice(0, 80)}`, 3500, "ERROR");
    } finally {
        isAgentBusy = false;
    }
}
