/**
 * voiceAssistant.js — Local Desktop Voice Assistant on macOS (JARVIS Hands-Free Mode)
 *
 * Provides continuous "Hey Rex" wake-word detection & voice companion loop:
 *   1. Continuously listens for the "Hey Rex" wake-word via microphone
 *   2. On "Hey Rex": pops up native macOS notification, plays wake chime, and activates
 *   3. If command was spoken in the same breath ("Hey Rex, turn the volume to 70"), executes immediately
 *   4. If only "Hey Rex" was spoken, speaks "Yes sir?", records follow-up, and executes
 *   5. Speaks reply back through Mac speakers using Cartesia sonic-2 & afplay
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadConfig } from './config.js';
import { playCue } from './audioCues.js';
import { generateSpeechFile } from './cartesia.js';
import { processAgentRequest } from './chatPlatformCore.js';
import { macSystem } from './appleScript.js';

const execAsync = promisify(exec);

function getFfmpegPath() {
    const local = path.resolve(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(local)) return local;
    return 'ffmpeg';
}

/**
 * Record audio from default microphone on macOS for a specific duration (in seconds)
 */
async function recordMicAudio(durationSeconds = 3, targetPath) {
    const ffmpeg = getFfmpegPath();
    // On macOS, avfoundation device ":default" or ":0" records default input
    const cmd = `"${ffmpeg}" -y -f avfoundation -i ":default" -t ${durationSeconds} -ar 16000 -ac 1 "${targetPath}"`;
    try {
        await execAsync(cmd, { stdio: 'ignore' });
        return fs.existsSync(targetPath);
    } catch (e) {
        // Fallback: try device ":0"
        try {
            const fallbackCmd = `"${ffmpeg}" -y -f avfoundation -i ":0" -t ${durationSeconds} -ar 16000 -ac 1 "${targetPath}"`;
            await execAsync(fallbackCmd, { stdio: 'ignore' });
            return fs.existsSync(targetPath);
        } catch {
            return false;
        }
    }
}

/**
 * Transcribe recorded WAV file using Whisper or Gemini
 */
async function transcribeAudioFile(wavPath) {
    if (!fs.existsSync(wavPath)) return '';
    const config = loadConfig();

    // 1. If OpenAI key is present, use Whisper-1
    if (config.openaiKey) {
        try {
            const { OpenAI } = await import('openai');
            const openai = new OpenAI({ apiKey: config.openaiKey });
            const resp = await openai.audio.transcriptions.create({
                file: fs.createReadStream(wavPath),
                model: 'whisper-1'
            });
            return (resp.text || '').trim();
        } catch {}
    }

    // 2. Multimodal transcription using Google Gemini 3.5 Flash
    if (config.geminiKey) {
        try {
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(config.geminiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
            const audioBytes = fs.readFileSync(wavPath).toString('base64');

            const result = await model.generateContent([
                {
                    inlineData: {
                        mimeType: 'audio/wav',
                        data: audioBytes
                    }
                },
                'Transcribe the exact words spoken in this audio. Return ONLY the transcribed text with no extra commentary.'
            ]);

            return (result.response.text() || '').trim();
        } catch {}
    }

    return '';
}

/**
 * Speak text response back through Mac speakers using Cartesia and afplay
 */
async function speakResponse(text) {
    if (!text || text.length < 2) return;
    try {
        const cleanText = text.replace(/[`*_#]/g, '').slice(0, 400);
        const wavPath = await generateSpeechFile(cleanText);
        if (wavPath && fs.existsSync(wavPath)) {
            await execAsync(`afplay "${wavPath}"`);
            try { fs.unlinkSync(wavPath); } catch {}
        }
    } catch (e) {
        console.error(pc.dim(`Voice playback error: ${e.message}`));
    }
}

/**
 * Process a natural language query and speak the response
 */
async function handleQueryAndSpeak(userQuery, history, userId = 'local_desktop_user') {
    let agentResponse = '';
    try {
        agentResponse = await processAgentRequest({
            userId,
            userTag: 'Local User',
            inputMessage: userQuery,
            history,
            userPersonas: {},
            platformCtx: {
                reply: async (text) => { agentResponse = text; },
                sendFile: async () => {},
                fileToolName: 'send_platform_file'
            }
        });
    } catch (err) {
        agentResponse = `Error processing command: ${err.message}`;
    }

    console.log(`\n${pc.bold(pc.cyan('🦖 Rex:'))} ${agentResponse}\n`);
    await speakResponse(agentResponse);
    return agentResponse;
}

/**
 * Start interactive Local Desktop Voice Assistant with continuous "Hey Rex" Wake-Word
 */
export async function startDesktopVoiceAssistant() {
    console.clear();
    p.intro(pc.cyan(pc.bold('🎙️  Rex Local Voice Assistant (JARVIS Wake-Word Active)')));
    p.note([
        'Continuous "Hey Rex" wake-word radar is LIVE.',
        '• Say "Hey Rex" anytime to activate hands-free.',
        '• Or speak full phrases: "Hey Rex, turn the volume on my mac to 70".',
        '• Press [Enter] for manual push-to-talk, or type commands directly.',
        '• Type "exit" or press Ctrl+C to stop.'
    ].join('\n'), 'JARVIS Status');

    const history = {};
    const userId = 'local_desktop_user';
    const tmpDir = os.tmpdir();
    let isProcessing = false;
    let keepListening = true;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // ─── Continuous Background Wake-Word Radar Loop ───
    const runWakeWordRadar = async () => {
        while (keepListening) {
            if (isProcessing) {
                await new Promise(r => setTimeout(r, 800));
                continue;
            }

            const sliceWav = path.join(tmpDir, `rex_radar_${Date.now()}.wav`);
            const ok = await recordMicAudio(3, sliceWav);

            if (ok && fs.existsSync(sliceWav)) {
                try {
                    const text = await transcribeAudioFile(sliceWav);
                    try { fs.unlinkSync(sliceWav); } catch {}

                    const lower = (text || '').toLowerCase().trim();

                    // Check if wake-word "Hey Rex" or "Rex" was spoken
                    const wakeMatch = lower.match(/\b(?:hey\s+rex|hi\s+rex|ok\s+rex)\b(.*)/i);

                    if (wakeMatch && !isProcessing) {
                        isProcessing = true;
                        playCue('wake');

                        // macOS popup notification
                        await macSystem.displayNotification("I'm listening, sir.", {
                            title: '🦖 Hey Rex!'
                        }).catch(() => {});

                        const commandInBreath = (wakeMatch[1] || '').trim();

                        if (commandInBreath.length > 3) {
                            // User spoke command in the same breath ("Hey Rex, turn volume to 70")
                            console.log(`\n${pc.bgGreen(pc.black(' WAKE DETECTED '))} ${pc.bold(pc.white(`"${text}"`))}`);
                            await handleQueryAndSpeak(commandInBreath, history, userId);
                        } else {
                            // User only said "Hey Rex" -> acknowledge and record command
                            console.log(`\n${pc.bgGreen(pc.black(' WAKE DETECTED '))} ${pc.bold(pc.white('Rex activated! Listening for command...'))}`);
                            await speakResponse("Yes sir? I'm listening.");

                            // Record follow-up command
                            const followUpWav = path.join(tmpDir, `rex_cmd_${Date.now()}.wav`);
                            playCue('listening');
                            process.stdout.write(pc.yellow('🔴 Listening for your command (4s)... '));
                            
                            const recOk = await recordMicAudio(4, followUpWav);
                            let cmdText = '';
                            if (recOk) {
                                cmdText = await transcribeAudioFile(followUpWav);
                                try { fs.unlinkSync(followUpWav); } catch {}
                            }

                            if (cmdText) {
                                console.log(pc.bold(pc.white(`\nYou said: "${cmdText}"`)));
                                await handleQueryAndSpeak(cmdText, history, userId);
                            } else {
                                console.log(pc.dim('\nNo command heard. Standing by...'));
                            }
                        }

                        isProcessing = false;
                        process.stdout.write(`\n${pc.green('🟢 Wake radar active (Say "Hey Rex" or press Enter): ')}`);
                    }
                } catch (e) {
                    try { fs.unlinkSync(sliceWav); } catch {}
                }
            } else {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    };

    // Start wake-word radar in background
    runWakeWordRadar();

    // Terminal keyboard interface
    const askLoop = () => {
        rl.question(`\n${pc.green('🟢 Wake radar active (Say "Hey Rex" or press Enter): ')}`, async (line) => {
            const trimmed = line.trim();
            if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
                keepListening = false;
                p.outro('Rex Voice Assistant deactivated. Have a wonderful day, sir! 🦖✨');
                rl.close();
                process.exit(0);
            }

            isProcessing = true;
            let userQuery = trimmed;

            if (!userQuery) {
                // Manual push-to-talk burst
                const wavPath = path.join(tmpDir, `rex_mic_${Date.now()}.wav`);
                process.stdout.write(pc.yellow('🔴 Recording microphone (speak now for 4s)... '));
                playCue('listening');

                const ok = await recordMicAudio(4, wavPath);
                if (ok) {
                    process.stdout.write(pc.blue('Transcribing... '));
                    userQuery = await transcribeAudioFile(wavPath);
                    try { fs.unlinkSync(wavPath); } catch {}
                }
            }

            if (userQuery) {
                console.log(pc.bold(pc.white(`\nUser: "${userQuery}"`)));
                await handleQueryAndSpeak(userQuery, history, userId);
            } else {
                console.log(pc.dim('No speech detected.'));
            }

            isProcessing = false;
            askLoop();
        });
    };

    askLoop();
}
