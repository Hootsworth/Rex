/**
 * desktopMascot.js — Retro 8-Bit Cute Mascot Companion for Rex
 *
 * A retro 8-bit baby T-Rex desktop pet that docks in the bottom-left of your macOS screen.
 * - Click Rex to speak to him (live voice recognition) or type commands.
 * - Has full autonomous control of Rex: shell, macOS volume/apps, Spotify, screen vision,
 *   webcam snapshots, iMessages, shortcuts, obsidian vault, web agent, and AI chat.
 * - Features authentic 8-bit retro pixel art, idle animations (breathing, tail wagging, blinking),
 *   listening audio equalizer, thinking gears, speech bubble with typewriter sound effects,
 *   and voice speech synthesis.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { processAgentRequest } from './chatPlatformCore.js';
import { loadConfig } from './config.js';
import {
    startScreenCursor,
    stopScreenCursor,
    isScreenCursorRunning,
    setCursorMode,
    cursorSpeak
} from './screenCursor.js';

const execAsync = promisify(exec);

let mascotServer = null;
let activePort = 19888;
const history = {};
const userId = 'desktop_mascot_user';

/**
 * Generate the complete HTML/CSS/JS for the Retro 8-Bit Mascot
 */
function getMascotHtml(port) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rex — Retro 8-Bit Desktop Companion</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap" rel="stylesheet">
    <style>
        :root {
            --rex-green: #38ef7d;
            --rex-dark-green: #11998e;
            --rex-belly: #ffeaa7;
            --rex-shadow: #0b4f3b;
            --bg-dark: #0f141c;
            --bg-panel: #161e2b;
            --border-pixel: #2b394f;
            --text-color: #ecf0f1;
            --accent-gold: #f1c40f;
            --accent-pink: #ff7675;
            --accent-blue: #74b9ff;
            --pixel-size: 3px;
        }

        * {
            box-sizing: border-box;
            user-select: none;
            -webkit-user-select: none;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Press Start 2P', 'VT323', monospace;
            background: rgba(15, 20, 28, 0.95);
            color: var(--text-color);
            height: 100vh;
            width: 100vw;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            padding: 12px;
            image-rendering: pixelated;
            border: 3px solid #222f3e;
            border-radius: 8px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8), inset 0 0 12px rgba(56, 239, 125, 0.15);
        }

        /* CRT Scanline Overlay */
        body::before {
            content: " ";
            display: block;
            position: absolute;
            top: 0; left: 0; bottom: 0; right: 0;
            background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03));
            z-index: 100;
            background-size: 100% 3px, 6px 100%;
            pointer-events: none;
        }

        /* Top Drag Handle / Bar */
        .window-bar {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 28px;
            background: #111722;
            border-bottom: 2px solid #222f3e;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 10px;
            cursor: move;
            -webkit-app-region: drag;
            font-size: 8px;
            letter-spacing: 1px;
            color: var(--rex-green);
        }

        .window-title {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .window-controls {
            display: flex;
            gap: 8px;
            -webkit-app-region: no-drag;
        }

        .icon-btn {
            background: none;
            border: none;
            color: #8395a7;
            cursor: pointer;
            font-size: 10px;
            padding: 2px;
            transition: color 0.2s;
        }

        .icon-btn:hover {
            color: #fff;
        }

        /* Dialogue Box / Speech Bubble */
        .speech-bubble {
            background: #101826;
            border: 3px solid #2ecc71;
            box-shadow: 0 0 0 2px #000, inset 0 0 8px rgba(46, 204, 113, 0.2);
            padding: 10px;
            margin-bottom: 12px;
            max-height: 190px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            position: relative;
            border-radius: 4px;
        }

        .speech-bubble::after {
            content: '';
            position: absolute;
            bottom: -10px;
            left: 50px;
            width: 0;
            height: 0;
            border-left: 8px solid transparent;
            border-right: 8px solid transparent;
            border-top: 10px solid #2ecc71;
        }

        .bubble-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 8px;
            color: var(--accent-gold);
            border-bottom: 1px dashed #243346;
            padding-bottom: 4px;
        }

        .bubble-content {
            font-size: 9px;
            line-height: 1.5;
            color: #ffffff;
            overflow-y: auto;
            max-height: 110px;
            word-break: break-word;
            padding-right: 4px;
        }

        .bubble-content::-webkit-scrollbar {
            width: 4px;
        }
        .bubble-content::-webkit-scrollbar-thumb {
            background: #2ecc71;
        }

        /* Audio Equalizer for Listening */
        .audio-eq {
            display: none;
            align-items: center;
            gap: 3px;
            height: 12px;
        }
        .audio-eq.active {
            display: flex;
        }
        .eq-bar {
            width: 3px;
            background: var(--rex-green);
            height: 100%;
            animation: bounce 0.4s infinite alternate ease-in-out;
        }
        .eq-bar:nth-child(1) { animation-delay: 0.1s; }
        .eq-bar:nth-child(2) { animation-delay: 0.25s; }
        .eq-bar:nth-child(3) { animation-delay: 0.15s; }
        .eq-bar:nth-child(4) { animation-delay: 0.3s; }
        .eq-bar:nth-child(5) { animation-delay: 0.05s; }

        @keyframes bounce {
            0% { height: 2px; }
            100% { height: 12px; }
        }

        /* Mascot Container */
        .mascot-stage {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            padding: 4px 6px;
        }

        .mascot-wrapper {
            position: relative;
            cursor: pointer;
            padding: 6px;
            border-radius: 6px;
            transition: transform 0.1s ease;
        }

        .mascot-wrapper:hover {
            transform: scale(1.05);
            background: rgba(46, 204, 113, 0.1);
        }

        .mascot-wrapper:active {
            transform: scale(0.95);
        }

        /* Mascot Canvas & Sprite */
        #mascot-canvas {
            width: 96px;
            height: 96px;
            image-rendering: pixelated;
        }

        .pulse-indicator {
            position: absolute;
            top: 2px;
            right: 2px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #e74c3c;
            border: 1px solid #fff;
            display: none;
        }
        .pulse-indicator.active {
            display: block;
            animation: pulse-ring 1s infinite;
        }

        @keyframes pulse-ring {
            0% { transform: scale(0.9); opacity: 1; }
            50% { transform: scale(1.3); opacity: 0.6; }
            100% { transform: scale(0.9); opacity: 1; }
        }

        /* Mascot Click Hint Pill */
        .click-hint {
            position: absolute;
            bottom: -4px;
            left: 50%;
            transform: translateX(-50%);
            background: #2ecc71;
            color: #000;
            font-size: 7px;
            padding: 2px 6px;
            border-radius: 3px;
            font-weight: bold;
            white-space: nowrap;
            pointer-events: none;
            box-shadow: 0 2px 4px rgba(0,0,0,0.4);
            animation: float-hint 1.5s infinite ease-in-out;
        }

        @keyframes float-hint {
            0%, 100% { transform: translate(-50%, 0); }
            50% { transform: translate(-50%, -3px); }
        }

        /* Controls Panel on right of mascot */
        .controls-panel {
            display: flex;
            flex-direction: column;
            gap: 6px;
            flex: 1;
            margin-left: 12px;
        }

        .input-row {
            display: flex;
            gap: 4px;
        }

        .pixel-input {
            background: #111722;
            border: 2px solid #243346;
            color: #fff;
            font-family: inherit;
            font-size: 8px;
            padding: 6px 8px;
            border-radius: 2px;
            flex: 1;
            outline: none;
        }
        .pixel-input:focus {
            border-color: var(--rex-green);
        }

        .pixel-btn {
            background: #243346;
            border: 2px solid #38ef7d;
            color: #fff;
            font-family: inherit;
            font-size: 8px;
            padding: 6px 8px;
            cursor: pointer;
            border-radius: 2px;
            transition: all 0.1s;
        }
        .pixel-btn:hover {
            background: #38ef7d;
            color: #000;
        }
        .pixel-btn:active {
            transform: translateY(1px);
        }

        .pixel-btn.mic-btn {
            background: #101826;
            border-color: #e74c3c;
            color: #e74c3c;
        }
        .pixel-btn.mic-btn.listening {
            background: #e74c3c;
            color: #fff;
            animation: pulse-ring 0.8s infinite;
        }

        /* Quick Action Chips */
        .chips-container {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-top: 2px;
        }

        .chip {
            background: #111722;
            border: 1px solid #2b394f;
            color: #8395a7;
            font-size: 7px;
            padding: 3px 5px;
            cursor: pointer;
            border-radius: 2px;
            transition: all 0.15s;
        }
        .chip:hover {
            border-color: var(--rex-green);
            color: var(--rex-green);
            background: #162234;
        }

        /* Heart / Star Particles */
        .particle {
            position: absolute;
            pointer-events: none;
            font-size: 12px;
            animation: float-up 1s forwards ease-out;
            z-index: 200;
        }

        @keyframes float-up {
            0% { opacity: 1; transform: translate(0, 0) scale(1); }
            100% { opacity: 0; transform: translate(var(--dx), -40px) scale(1.4); }
        }
    </style>
</head>
<body>
    <div class="window-bar">
        <div class="window-title">
            <span>🦖</span>
            <span>REX 8-BIT PET</span>
        </div>
        <div class="window-controls">
            <button class="icon-btn" id="cursor-toggle" title="Toggle Persistent macOS Second Cursor (Rex)">🐾</button>
            <button class="icon-btn" id="sfx-toggle" title="Toggle 8-bit SFX">🔊</button>
            <button class="icon-btn" id="minimize-btn" title="Toggle Compact Mode">_</button>
        </div>
    </div>

    <!-- Speech Dialogue Box -->
    <div class="speech-bubble" id="speech-bubble">
        <div class="bubble-header">
            <span id="speaker-name">🦖 REX</span>
            <div class="audio-eq" id="audio-eq">
                <div class="eq-bar"></div>
                <div class="eq-bar"></div>
                <div class="eq-bar"></div>
                <div class="eq-bar"></div>
                <div class="eq-bar"></div>
            </div>
            <span id="bubble-status">IDLE</span>
        </div>
        <div class="bubble-content" id="bubble-text">
            Hi! Click me to speak, or pick an action below! 🦖✨
        </div>
    </div>

    <!-- Mascot & Controls -->
    <div class="mascot-stage">
        <div class="mascot-wrapper" id="mascot-btn" title="Click to talk to Rex!">
            <div class="pulse-indicator" id="mic-indicator"></div>
            <canvas id="mascot-canvas" width="32" height="32"></canvas>
            <div class="click-hint" id="click-hint">CLICK ME!</div>
        </div>

        <div class="controls-panel">
            <div class="input-row">
                <input type="text" class="pixel-input" id="cmd-input" placeholder="Speak or type..." autocomplete="off">
                <button class="pixel-btn mic-btn" id="mic-btn" title="Push-to-Talk">🎙️</button>
                <button class="pixel-btn" id="send-btn">GO</button>
            </div>

            <div class="chips-container">
                <div class="chip" data-cmd="screen_cursor">🐾 Cursor</div>
                <div class="chip" data-cmd="rex_voice_assist">🎙️ Voice Guide</div>
                <div class="chip" data-cmd="spotify">🎵 Spotify</div>
                <div class="chip" data-cmd="volume">🔊 Vol 70</div>
                <div class="chip" data-cmd="snapshot">📸 Photo</div>
                <div class="chip" data-cmd="screen">🖥️ Screen</div>
                <div class="chip" data-cmd="vitals">⚡ Vitals</div>
                <div class="chip" data-cmd="joke">🦖 Joke</div>
            </div>
        </div>
    </div>

    <script>
        // ─── Retro 8-Bit Web Audio Synthesizer ───────────────────────────────
        let audioCtx = null;
        let sfxEnabled = true;

        function initAudio() {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
        }

        function playRetroChime(type = 'click') {
            if (!sfxEnabled) return;
            initAudio();
            if (!audioCtx) return;

            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();

            osc.connect(gain);
            gain.connect(audioCtx.destination);

            if (type === 'click' || type === 'wake') {
                // Two-tone retro jump sound
                osc.type = 'square';
                osc.frequency.setValueAtTime(329.63, now); // E4
                osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.12); // E5
                gain.gain.setValueAtTime(0.12, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
                osc.start(now);
                osc.stop(now + 0.15);
            } else if (type === 'beep') {
                // Typewriter text bleep
                osc.type = 'triangle';
                const f = 400 + Math.random() * 200;
                osc.frequency.setValueAtTime(f, now);
                gain.gain.setValueAtTime(0.04, now);
                gain.gain.exponentialRampToValueAtTime(0.005, now + 0.05);
                osc.start(now);
                osc.stop(now + 0.05);
            } else if (type === 'victory') {
                // 3-note victory fanfare
                osc.type = 'square';
                osc.frequency.setValueAtTime(523.25, now); // C5
                osc.frequency.setValueAtTime(659.25, now + 0.1); // E5
                osc.frequency.setValueAtTime(783.99, now + 0.2); // G5
                gain.gain.setValueAtTime(0.15, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
                osc.start(now);
                osc.stop(now + 0.35);
            } else if (type === 'error') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(150, now);
                osc.frequency.setValueAtTime(110, now + 0.1);
                gain.gain.setValueAtTime(0.15, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
                osc.start(now);
                osc.stop(now + 0.25);
            }
        }

        // ─── 8-Bit Pixel Mascot Sprite Renderer ──────────────────────────────
        const canvas = document.getElementById('mascot-canvas');
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        // Mascot Animation States
        let mascotState = 'idle'; // 'idle', 'listen', 'think', 'speak', 'happy'
        let frameCount = 0;
        let isBlinking = false;
        let mouthOpen = false;

        // Color Palette
        const C = {
            g1: '#38ef7d', // Primary Lime
            g2: '#11998e', // Shadow Green
            g3: '#0b5345', // Deep Shadow / Outline
            y1: '#f9ca24', // Belly Yellow
            y2: '#f0932b', // Belly Shadow
            w:  '#ffffff', // Eye White
            k:  '#130f40', // Pupil
            p:  '#ff7979', // Cheek Blush
            o:  '#eb4d4b'  // Mouth Tongue
        };

        function drawPixel(x, y, color) {
            ctx.fillStyle = color;
            ctx.fillRect(x, y, 1, 1);
        }

        function drawRect(x, y, w, h, color) {
            ctx.fillStyle = color;
            ctx.fillRect(x, y, w, h);
        }

        function renderMascot() {
            ctx.clearRect(0, 0, 32, 32);

            // Subtle vertical bounce based on state
            let bounceY = 0;
            if (mascotState === 'idle') {
                bounceY = (Math.floor(frameCount / 30) % 2 === 0) ? 0 : 1;
            } else if (mascotState === 'listen') {
                bounceY = (Math.floor(frameCount / 10) % 2 === 0) ? 0 : 2;
            } else if (mascotState === 'think') {
                bounceY = (Math.floor(frameCount / 18) % 2 === 0) ? 0 : 1;
            } else if (mascotState === 'speak' || mascotState === 'happy') {
                bounceY = (Math.floor(frameCount / 8) % 2 === 0) ? 0 : 3;
            }

            const y0 = 4 - bounceY;

            // 1. Spikes / Crest on Back of Head & Neck
            drawRect(9, y0 + 5, 2, 2, C.g3);
            drawRect(8, y0 + 9, 2, 2, C.g3);
            drawRect(7, y0 + 13, 2, 2, C.g3);

            // 2. Dinosaur Head Outline & Base
            drawRect(11, y0 + 3, 13, 11, C.g1);
            drawRect(24, y0 + 6, 4, 8, C.g1); // Snout
            drawRect(10, y0 + 4, 1, 9, C.g3); // Left head outline
            drawRect(11, y0 + 2, 13, 1, C.g3); // Top head outline
            drawRect(24, y0 + 5, 4, 1, C.g3); // Top snout outline
            drawRect(28, y0 + 6, 1, 7, C.g3); // Front snout outline

            // 3. Shading on head
            drawRect(11, y0 + 12, 13, 2, C.g2);
            drawRect(24, y0 + 12, 3, 2, C.g2);

            // 4. Nostril
            drawPixel(26, y0 + 7, C.g3);

            // 5. Big Cute Eyes
            if (isBlinking) {
                // Blink line
                drawRect(17, y0 + 7, 5, 1, C.k);
            } else {
                // Open Eye
                drawRect(17, y0 + 5, 5, 5, C.w);
                drawRect(19, y0 + 6, 3, 4, C.k); // Pupil
                drawPixel(19, y0 + 6, C.w); // Glint
            }

            // 6. Cute Pink Cheek Blush
            drawRect(15, y0 + 10, 3, 2, C.p);

            // 7. Mouth (Animates when speaking or listening)
            if (mascotState === 'speak' && mouthOpen) {
                drawRect(23, y0 + 10, 4, 3, C.g3);
                drawPixel(24, y0 + 11, C.o);
            } else if (mascotState === 'listen') {
                // Cute open mouth
                drawRect(24, y0 + 10, 3, 2, C.g3);
            } else {
                // Smile line
                drawRect(24, y0 + 10, 3, 1, C.g3);
                drawPixel(27, y0 + 9, C.g3);
            }

            // 8. Body
            drawRect(10, y0 + 14, 12, 11, C.g1);
            drawRect(9, y0 + 15, 1, 9, C.g3); // Left body outline
            drawRect(10, y0 + 23, 12, 2, C.g2); // Body shadow

            // 9. Belly (Yellow cute patch)
            drawRect(16, y0 + 14, 6, 8, C.y1);
            drawRect(17, y0 + 21, 5, 1, C.y2);

            // 10. Tiny cute T-Rex arms!
            if (mascotState === 'listen' || mascotState === 'happy') {
                // Arms raised up
                drawRect(22, y0 + 14, 3, 2, C.g1);
                drawPixel(24, y0 + 13, C.g3);
            } else {
                // Arms down
                drawRect(21, y0 + 16, 3, 2, C.g1);
                drawPixel(23, y0 + 17, C.g3);
            }

            // 11. Tail (Wagging)
            const tailWag = (Math.floor(frameCount / 15) % 2 === 0);
            if (tailWag) {
                drawRect(6, y0 + 18, 4, 4, C.g1);
                drawRect(3, y0 + 19, 3, 3, C.g1);
                drawRect(2, y0 + 20, 2, 2, C.g1);
            } else {
                drawRect(6, y0 + 19, 4, 4, C.g1);
                drawRect(3, y0 + 18, 3, 3, C.g1);
                drawRect(2, y0 + 17, 2, 2, C.g1);
            }

            // 12. Feet & Paws
            drawRect(11, y0 + 25, 4, 3, C.g2);
            drawRect(10, y0 + 27, 5, 1, C.g3); // Left foot
            drawRect(17, y0 + 25, 4, 3, C.g2);
            drawRect(16, y0 + 27, 5, 1, C.g3); // Right foot

            // 13. State Indicators above head
            if (mascotState === 'listen') {
                // Equalizer wave particles
                const t = frameCount % 20;
                drawPixel(14, y0 - 1, C.g1);
                drawPixel(19, y0 - 2, C.g1);
                drawPixel(24, y0 - 1, C.g1);
            } else if (mascotState === 'think') {
                // Question mark or lightbulb
                drawRect(18, y0 - 3, 3, 1, C.y1);
                drawPixel(20, y0 - 2, C.y1);
                drawPixel(19, y0 - 1, C.y1);
                drawPixel(19, y0 + 1, C.y1);
            } else if (mascotState === 'happy') {
                // Sparkle
                drawPixel(25, y0 - 2, C.y1);
                drawPixel(26, y0 - 1, C.y1);
                drawPixel(24, y0 - 1, C.y1);
                drawPixel(25, y0, C.y1);
            }
        }

        // Animation Loop
        function animate() {
            frameCount++;

            // Blinking timer
            if (frameCount % 160 === 0) isBlinking = true;
            if (frameCount % 160 === 12) isBlinking = false;

            // Mouth toggle for speech
            if (mascotState === 'speak' && frameCount % 6 === 0) {
                mouthOpen = !mouthOpen;
            }

            renderMascot();
            requestAnimationFrame(animate);
        }
        animate();

        // ─── Floating Particle Generator ─────────────────────────────────────
        function spawnParticle(emoji) {
            const el = document.createElement('div');
            el.className = 'particle';
            el.textContent = emoji;
            const mascotRect = document.getElementById('mascot-btn').getBoundingClientRect();
            el.style.left = (mascotRect.left + 30 + Math.random() * 30) + 'px';
            el.style.top = (mascotRect.top + 20) + 'px';
            el.style.setProperty('--dx', (Math.random() * 40 - 20) + 'px');
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 1000);
        }

        // ─── Dialogue Box Typewriter Effect ──────────────────────────────────
        const bubbleTextEl = document.getElementById('bubble-text');
        const bubbleStatusEl = document.getElementById('bubble-status');
        const audioEqEl = document.getElementById('audio-eq');

        let typewriterTimer = null;

        function setDialogue(text, status = 'REPLY', onComplete = null) {
            clearInterval(typewriterTimer);
            bubbleStatusEl.textContent = status;
            bubbleTextEl.innerHTML = '';

            let idx = 0;
            const speed = 18; // ms per char

            typewriterTimer = setInterval(() => {
                if (idx < text.length) {
                    bubbleTextEl.textContent += text[idx];
                    if (idx % 3 === 0 && sfxEnabled) playRetroChime('beep');
                    bubbleTextEl.scrollTop = bubbleTextEl.scrollHeight;
                    idx++;
                } else {
                    clearInterval(typewriterTimer);
                    if (onComplete) onComplete();
                }
            }, speed);
        }

        // ─── Command Execution Bridge ────────────────────────────────────────
        async function runRexCommand(commandText) {
            const query = String(commandText || '').trim();
            if (!query) return;

            mascotState = 'think';
            bubbleStatusEl.textContent = 'COMPUTING...';
            setDialogue('Thinking...', 'COMPUTING');
            playRetroChime('click');

            try {
                const res = await fetch('/api/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query })
                });
                const data = await res.json();

                if (data.ok) {
                    mascotState = 'speak';
                    spawnParticle('⭐');
                    spawnParticle('💚');
                    playRetroChime('victory');

                    setDialogue(data.reply || 'Task complete!', 'REX SAYS', () => {
                        mascotState = 'idle';
                    });

                    // Speak response aloud via SpeechSynthesis if available
                    if ('speechSynthesis' in window) {
                        const cleanUtterance = (data.reply || '').replace(/[*_#]/g, '').replaceAll(String.fromCharCode(96), '').slice(0, 200);
                        const u = new SpeechSynthesisUtterance(cleanUtterance);
                        u.pitch = 1.1;
                        u.rate = 1.05;
                        window.speechSynthesis.speak(u);
                    }
                } else {
                    mascotState = 'idle';
                    playRetroChime('error');
                    setDialogue('Error: ' + (data.error || 'Failed to execute'), 'ERROR');
                }
            } catch (err) {
                mascotState = 'idle';
                playRetroChime('error');
                setDialogue('Connection error: ' + err.message, 'ERROR');
            }
        }

        // ─── Web Speech Recognition (Browser Mic) ────────────────────────────
        let recognition = null;
        let isListening = false;
        const micBtn = document.getElementById('mic-btn');
        const micIndicator = document.getElementById('mic-indicator');

        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
            const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
            recognition = new SpeechRec();
            recognition.continuous = false;
            recognition.interimResults = true;
            recognition.lang = 'en-US';

            recognition.onstart = () => {
                isListening = true;
                mascotState = 'listen';
                micBtn.classList.add('listening');
                micIndicator.classList.add('active');
                audioEqEl.classList.add('active');
                bubbleStatusEl.textContent = 'LISTENING...';
                bubbleTextEl.textContent = 'Listening to your voice...';
                playRetroChime('wake');
            };

            recognition.onresult = (event) => {
                let interim = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    interim += event.results[i][0].transcript;
                }
                bubbleTextEl.textContent = 'Hearing: "' + interim + '"';
                document.getElementById('cmd-input').value = interim;
            };

            recognition.onend = () => {
                isListening = false;
                micBtn.classList.remove('listening');
                micIndicator.classList.remove('active');
                audioEqEl.classList.remove('active');

                const spoken = document.getElementById('cmd-input').value.trim();
                if (spoken) {
                    runRexCommand(spoken);
                } else {
                    mascotState = 'idle';
                    bubbleStatusEl.textContent = 'IDLE';
                }
            };

            recognition.onerror = (e) => {
                isListening = false;
                micBtn.classList.remove('listening');
                micIndicator.classList.remove('active');
                audioEqEl.classList.remove('active');
                mascotState = 'idle';
                console.warn('Speech error:', e.error);
                if (e.error !== 'no-speech') {
                    setDialogue('Mic notice: ' + e.error + '. Try typing in the box!', 'MIC NOTICE');
                }
            };
        }

        function toggleListening() {
            if (isListening) {
                if (recognition) recognition.stop();
            } else {
                if (recognition) {
                    try { recognition.start(); } catch {}
                } else {
                    setDialogue('Speech recognition not available in this view. Type below!', 'NOTICE');
                }
            }
        }

        // Mascot Click -> Listen!
        document.getElementById('mascot-btn').addEventListener('click', () => {
            spawnParticle('✨');
            toggleListening();
        });

        micBtn.addEventListener('click', toggleListening);

        // Send Button / Enter Key
        const cmdInput = document.getElementById('cmd-input');
        const sendBtn = document.getElementById('send-btn');

        function submitInput() {
            const val = cmdInput.value.trim();
            if (val) {
                runRexCommand(val);
                cmdInput.value = '';
            }
        }

        sendBtn.addEventListener('click', submitInput);
        cmdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitInput();
        });

        // Quick Action Chips
        const CHIP_MAP = {
            spotify: 'Play or pause music on Spotify',
            volume: 'Set macOS system volume to 70 percent',
            snapshot: 'Take a webcam snapshot of me right now',
            screen: 'Take a screenshot and summarize what is on my screen',
            vitals: 'Check mac system hardware vitals and battery',
            joke: 'Tell me a funny developer inside joke'
        };

        document.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const key = chip.getAttribute('data-cmd');
                if (key === 'screen_cursor') {
                    toggleScreenCursor();
                    return;
                }
                if (key === 'rex_voice_assist') {
                    fetch('/api/screen-cursor/voice', { method: 'POST' }).catch(() => {});
                    typeWriterEffect('Rex is listening to your voice and looking at your screen! 🎙️🦖');
                    return;
                }
                const prompt = CHIP_MAP[key] || key;
                cmdInput.value = prompt;
                submitInput();
            });
        });

        // Screen Cursor Toggle
        const cursorToggleBtn = document.getElementById('cursor-toggle');
        let isCursorActive = false;

        async function toggleScreenCursor() {
            try {
                const res = await fetch('/api/screen-cursor/toggle', { method: 'POST' });
                const data = await res.json();
                isCursorActive = data.running;
                if (cursorToggleBtn) {
                    cursorToggleBtn.style.color = isCursorActive ? '#38ef7d' : '';
                    cursorToggleBtn.style.borderColor = isCursorActive ? '#38ef7d' : '';
                }
                typeWriterEffect(isCursorActive ? 'Rex Persistent Cursor active across your entire Mac! 🐾' : 'Screen Cursor stopped.');
                playRetroChime('success');
            } catch (err) {
                typeWriterEffect('Could not toggle cursor: ' + err.message);
            }
        }

        if (cursorToggleBtn) cursorToggleBtn.addEventListener('click', toggleScreenCursor);

        // Fetch initial cursor status
        fetch('/api/screen-cursor/status').then(r => r.json()).then(data => {
            isCursorActive = data.running;
            if (cursorToggleBtn && isCursorActive) {
                cursorToggleBtn.style.color = '#38ef7d';
                cursorToggleBtn.style.borderColor = '#38ef7d';
            }
        }).catch(() => {});

        // SFX Toggle
        const sfxToggleBtn = document.getElementById('sfx-toggle');
        sfxToggleBtn.addEventListener('click', () => {
            sfxEnabled = !sfxEnabled;
            sfxToggleBtn.textContent = sfxEnabled ? '🔊' : '🔇';
            playRetroChime('click');
        });

        // Minimize / Compact Mode
        const minBtn = document.getElementById('minimize-btn');
        let isMinimized = false;
        minBtn.addEventListener('click', () => {
            isMinimized = !isMinimized;
            document.getElementById('speech-bubble').style.display = isMinimized ? 'none' : 'flex';
            document.querySelector('.controls-panel').style.display = isMinimized ? 'none' : 'flex';
            playRetroChime('click');
        });
    </script>
</body>
</html>`;
}

/**
 * Handle incoming API requests from the Mascot client
 */
async function handleApiRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${activePort}`);

    // Serve HTML UI
    if (url.pathname === '/' || url.pathname === '/mascot') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getMascotHtml(activePort));
        return;
    }

    // Command Execution Endpoint
    if (url.pathname === '/api/command' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { query } = JSON.parse(body || '{}');
                if (!query) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Query is required.' }));
                    return;
                }

                console.log(pc.cyan(`🦖 [Mascot Command]: "${query}"`));

                let agentReply = '';
                await processAgentRequest({
                    userId,
                    userTag: 'Desktop Mascot Pet',
                    inputMessage: query,
                    history,
                    userPersonas: {},
                    platformCtx: {
                        reply: async (text) => { agentReply = text; },
                        sendFile: async () => {},
                        fileToolName: 'send_platform_file'
                    }
                });

                if (isScreenCursorRunning() && agentReply) {
                    const cleanReply = (agentReply || '').replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim();
                    cursorSpeak(cleanReply.slice(0, 140), 4500, 'MASCOT');
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, reply: agentReply || 'Done!' }));
            } catch (e) {
                console.error(pc.red(`Mascot command error: ${e.message}`));
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // Screen Cursor API Endpoints
    if (url.pathname === '/api/screen-cursor/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, running: isScreenCursorRunning() }));
        return;
    }

    if (url.pathname === '/api/screen-cursor/toggle' && req.method === 'POST') {
        if (isScreenCursorRunning()) {
            stopScreenCursor();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, running: false }));
        } else {
            const startRes = await startScreenCursor({ mode: 'follow', checkPermissions: true, silent: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, running: isScreenCursorRunning(), dimensions: startRes.dimensions }));
        }
        return;
    }

    if (url.pathname === '/api/screen-cursor/mode' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            const { mode } = JSON.parse(body || '{}');
            if (mode) setCursorMode(mode);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, mode }));
        });
        return;
    }

    if (url.pathname === '/api/screen-cursor/voice' && req.method === 'POST') {
        import('./cursorVoiceAgent.js').then(m => m.triggerVoiceCommand()).catch(() => {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, triggered: true }));
        return;
    }

    // Status / Health Endpoint
    if (url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'active', port: activePort }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
}

/**
 * Launch the desktop window docked to the bottom-left of the macOS screen
 */
async function openBottomLeftDesktopWindow(port) {
    const url = `http://127.0.0.1:${port}/`;

    if (process.platform === 'darwin') {
        // Try launching via Google Chrome App Mode (borderless standalone window pinned to bottom-left)
        const chromePaths = [
            '/Applications/Google Chrome.app',
            '/Applications/Brave Browser.app',
            '/Applications/Arc.app'
        ];

        let launchedWithAppMode = false;
        for (const cPath of chromePaths) {
            if (fs.existsSync(cPath)) {
                try {
                    // Position at bottom-left: x=24, y=650, width=380, height=440
                    const cmd = `open -na "${cPath}" --args --app="${url}" --window-position=24,650 --window-size=380,440`;
                    await execAsync(cmd);
                    launchedWithAppMode = true;
                    break;
                } catch {}
            }
        }

        if (!launchedWithAppMode) {
            // Fallback: Open with default browser and reposition using AppleScript
            try {
                await execAsync(`open "${url}"`);
                const script = `
                    tell application "System Events"
                        delay 0.5
                        set frontApp to first application process whose frontmost is true
                        try
                            set position of window 1 of frontApp to {24, 650}
                            set size of window 1 of frontApp to {380, 440}
                        end try
                    end tell
                `;
                await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`).catch(() => {});
            } catch {}
        }
    } else {
        // Windows or Linux fallback
        try {
            await execAsync(`open "${url}" || xdg-open "${url}" || start "${url}"`);
        } catch {}
    }
}

/**
 * Start the Retro 8-Bit Mascot Companion
 */
export async function startDesktopMascot(options = {}) {
    const desiredPort = options.port || 19888;
    activePort = desiredPort;

    if (mascotServer) {
        p.log.warn(`Mascot server already running on port ${activePort}`);
        if (options.openBrowser !== false) {
            await openBottomLeftDesktopWindow(activePort);
        }
        return { ok: true, port: activePort };
    }

    return new Promise((resolve) => {
        mascotServer = http.createServer((req, res) => {
            handleApiRequest(req, res).catch(err => {
                res.writeHead(500);
                res.end(err.message);
            });
        });

        mascotServer.on('error', async (err) => {
            if (err.code === 'EADDRINUSE') {
                activePort += 1;
                mascotServer.listen(activePort, '127.0.0.1');
            } else {
                p.log.error(`Mascot server error: ${err.message}`);
                resolve({ ok: false, error: err.message });
            }
        });

        mascotServer.listen(activePort, '127.0.0.1', async () => {
            console.log(pc.green(`\n🦖 Retro 8-Bit Mascot Companion active at http://127.0.0.1:${activePort}/\n`));
            
            if (options.openBrowser !== false) {
                await openBottomLeftDesktopWindow(activePort);
            }

            if (options.screenCursor) {
                await startScreenCursor({ mode: 'follow', checkPermissions: true });
            }

            resolve({ ok: true, port: activePort });
        });
    });
}

/**
 * Stop the mascot companion server
 */
export function stopDesktopMascot() {
    stopScreenCursor();
    if (mascotServer) {
        try { mascotServer.close(); } catch {}
        mascotServer = null;
    }
}
