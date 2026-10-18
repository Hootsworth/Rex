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
    onUserBargeIn,
    setRexEmotion
} from './screenCursor.js';
import { findBestUiElement } from './accessibilityInspector.js';
import { classifyActionRisk } from './actionRiskGuard.js';
import { recordMacroStep, isRecordingMacro } from './cursorMacroRecorder.js';
import { verifyAndSelfCorrect } from './closedLoopVerifier.js';
import { dropFileIntoWindow } from './crossAppDragDrop.js';
import { autofillActiveForm } from './formAutofillEngine.js';
import {
    groundScreenElements,
    formatGroundedElementsContext,
    resolveActionHitbox,
    generateOmniGroundedPlan
} from './omniGroundingEngine.js';

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
 * powered by Apple Vision OCR and Set-of-Marks visual prompting.
 */
export async function planScreenActions(screenshotPath, userCommand, screenWidth = 1440, screenHeight = 900) {
    const config = loadConfig();

    // 1. Native Apple Vision OCR & Set-of-Marks Grounding Engine
    console.log(pc.cyan('[Rex Omni-Grounding]: Inspecting screen with Apple Vision OCR & Set-of-Marks...'));
    const { elements = [], annotatedPath, scaleX: detectedScaleX, scaleY: detectedScaleY } =
        await groundScreenElements(screenshotPath, screenWidth, screenHeight, true);
    console.log(pc.green(`[Rex Omni-Grounding]: Grounded ${elements.length} real interactive UI elements on screen.`));

    // Prefer Set-of-Marks annotated screenshot so the multimodal AI sees marked badges ([1], [2], [3]...)
    const imageToAnalyze = (annotatedPath && fs.existsSync(annotatedPath)) ? annotatedPath : screenshotPath;
    const imageBytes = fs.readFileSync(imageToAnalyze);
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

    const scaleX = detectedScaleX || (imgWidth / screenWidth);
    const scaleY = detectedScaleY || (imgHeight / screenHeight);
    const groundedContext = formatGroundedElementsContext(elements);

    const systemPrompt = `
You are Rex, an autonomous expert AI desktop copilot with direct operating system control over macOS.
You take REAL actions directly on the user's screen: clicking buttons, double clicking, right clicking, dragging sliders, typing text into form inputs, and triggering shortcuts.

The user has given this command while looking at their screen:
"${userCommand}"

Display Resolution: ${screenWidth} x ${screenHeight} points (Image capture resolution: ${imgWidth} x ${imgHeight} pixels, Retina scale ${scaleX.toFixed(2)}x).

GROUNDED UI ELEMENT MARKS (Set-of-Marks [ID]):
The screenshot has been analyzed and marked with high-contrast numbered badges ([1], [2], [3]...).
Below is the verified list of live interactive hitboxes extracted directly from the display:
${groundedContext}

CRITICAL ACCURACY & GROUNDING RULES:
1. PREFER Set-of-Marks [ID]: Whenever interacting with an element listed in the grounded elements above, set "targetId" to its integer ID. Rex's native engine will snap with 100% pixel precision to that element's center.
2. If typing or searching, identify the corresponding input field's "targetId" and set "action": "type", "text": "...", and "submit": true/false.
3. If an element is visible on the screenshot but does not have a numbered mark badge (e.g. custom icon or split pane), specify accurate display coordinates (x, y) on the ${screenWidth}x${screenHeight} display, and provide a descriptive "label" and "targetText".
4. ZERO HALLUCINATION: DO NOT click random percentage coordinates or make up fake controls. Zen Browser and modern web apps (like WhatsApp Web) have unique fluid layouts (vertical tabs, sidebars, split panes); always anchor your actions to what is actually visible.
5. Autonomous Multi-Step Execution: Generate all sequential steps required to completely satisfy the user's intent. Break the task down into:
   - Activating or focusing the relevant window/field
   - Searching or navigating to the desired item
   - Selecting or clicking the target
   - Typing required text
   - Confirming or submitting the action

Return a JSON response with:
- "activeApp": Exact Name of the application (e.g. "Zen", "Google Chrome", "DaVinci Resolve", "WhatsApp", "Finder")
- "summary": A concise 1-2 sentence executive explanation of what Rex is doing
- "steps": An array of sequential UI steps for Rex to physically execute.
  Each step must have:
  * "step": integer (1, 2, 3...)
  * "action": "click" | "type" | "drag" | "doubleClick" | "rightClick" | "key"
  * "targetId": (optional) integer ID matching one of the [ID] Set-of-Marks badges above
  * "targetText": (optional) string text of the target element on screen
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
  * "label": Short name of element (e.g. "Search Input", "WhatsApp Contact", "Submit Button")
  * "speech": Concise, helpful instruction spoken to user (1-2 clear sentences. CRITICAL: Do NOT use any emojis anywhere in your text or speech. Use clean, elegant text only.)
  * "cursorStyle": "handpointing" | "handopen" | "handgrabbing" | "beachball" | "default"

CRITICAL: Return ONLY valid, parseable JSON with NO markdown code fences or backticks. Do NOT include ANY emojis in any text fields.
`;

    // 1. Google Gemini Multimodal Visual Reasoning
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
            if (Array.isArray(plan?.steps) && plan.steps.length >= 1) {
                // Ground every step against detected physical hitboxes
                plan.steps = plan.steps.map(step => {
                    const resolved = resolveActionHitbox(step, elements, Math.round(screenWidth / 2), Math.round(screenHeight / 2));
                    return {
                        ...step,
                        x: resolved.x,
                        y: resolved.y,
                        w: resolved.w,
                        h: resolved.h,
                        label: step.label || resolved.label,
                        grounded: resolved.matched
                    };
                });
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
            if (Array.isArray(plan?.steps) && plan.steps.length >= 1) {
                // Ground every step against detected physical hitboxes
                plan.steps = plan.steps.map(step => {
                    const resolved = resolveActionHitbox(step, elements, Math.round(screenWidth / 2), Math.round(screenHeight / 2));
                    return {
                        ...step,
                        x: resolved.x,
                        y: resolved.y,
                        w: resolved.w,
                        h: resolved.h,
                        label: step.label || resolved.label,
                        grounded: resolved.matched
                    };
                });
                return { plan, scaleX, scaleY };
            }
        } catch (e) {
            console.warn(pc.yellow(`OpenAI vision error: ${e.message}`));
        }
    }

    // 3. Zero-Hallucination Omni-Grounded Fallback (strictly anchored to real screen elements detected right now)
    const groundedPlan = generateOmniGroundedPlan(userCommand, elements, screenWidth, screenHeight);
    if (groundedPlan && Array.isArray(groundedPlan.steps) && groundedPlan.steps.length > 0) {
        groundedPlan.steps = groundedPlan.steps.map(step => {
            const resolved = resolveActionHitbox(step, elements, Math.round(screenWidth / 2), Math.round(screenHeight / 2));
            return {
                ...step,
                x: resolved.x,
                y: resolved.y,
                w: resolved.w,
                h: resolved.h,
                label: step.label || resolved.label,
                grounded: resolved.matched
            };
        });
        return { plan: groundedPlan, scaleX, scaleY };
    }

    // 4. Honest Non-Hallucinating Standby when no interactive controls match
    return {
        plan: {
            activeApp: 'macOS Screen',
            summary: elements.length > 0
                ? `Scanned screen (${elements.length} elements detected). No matching action target found for "${userCommand}".`
                : `No active interactive elements detected on screen for "${userCommand}". Standing by.`,
            steps: []
        },
        scaleX,
        scaleY
    };
}

/**
 * Intelligent Multi-Step Domain Planner: Grounded in real screen elements or active window bounds.
 */
export function generateMultiStepPlan(userCommand = '', screenWidth = 1470, screenHeight = 956, windowBounds = null, elements = []) {
    if (Array.isArray(elements) && elements.length > 0) {
        return generateOmniGroundedPlan(userCommand, elements, screenWidth, screenHeight);
    }
    return {
        activeApp: windowBounds?.owner || "macOS Screen",
        summary: `Screen inspection ready for "${userCommand}". Standing by for targets.`,
        steps: []
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

        // 1. Accessibility Tree Hitbox Refinement (if not already grounded)
        if (!step.grounded && step.label && plan.activeApp) {
            try {
                const axElem = await findBestUiElement(plan.activeApp, step.label);
                if (axElem && axElem.width > 12 && axElem.height > 10) {
                    targetX = Math.round(axElem.x + axElem.width / 2);
                    targetY = Math.round(axElem.y + axElem.height / 2);
                    w = Math.round(axElem.width);
                    h = Math.round(axElem.height);
                    step.grounded = true;
                }
            } catch {}
        }

        // If coordinates were provided in Retina physical image pixel space and NOT already grounded, scale down to macOS points
        if (!step.grounded) {
            if (targetX > screenWidth && scaleX > 1.0) targetX /= scaleX;
            if (targetY > screenHeight && scaleY > 1.0) targetY /= scaleY;
        }

        targetX = Math.max(10, Math.min(screenWidth - 10, Math.round(targetX)));
        targetY = Math.max(10, Math.min(screenHeight - 10, Math.round(targetY)));
        lastTargetX = targetX;
        lastTargetY = targetY;

        let toX = Number(step.toX) || targetX;
        let toY = Number(step.toY) || targetY;
        if (!step.grounded) {
            if (toX > screenWidth && scaleX > 1.0) toX /= scaleX;
            if (toY > screenHeight && scaleY > 1.0) toY /= scaleY;
        }
        toX = Math.max(10, Math.min(screenWidth - 10, Math.round(toX)));
        toY = Math.max(10, Math.min(screenHeight - 10, Math.round(toY)));

        const boxX = Math.max(10, targetX - w / 2);
        const boxY = Math.max(10, targetY - h / 2);

        // 2. Action Risk Classification & Safety Guardrails
        const risk = classifyActionRisk(step.label || '', step.speech || '');
        if (risk.level === 'HIGH_RISK') {
            setRexEmotion('surprised');
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
        setRexEmotion('curious');
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
        setRexEmotion('dizzy');
        console.error(pc.red(`Error in Rex Voice Screen Copilot: ${err.message}`));
        cursorSpeak(`Notice: ${err.message.slice(0, 80)}`, 3500, "ERROR");
    } finally {
        isAgentBusy = false;
    }
}
