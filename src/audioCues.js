import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { loadConfig } from './config.js';

const MAC_SOUNDS = {
    wake: '/System/Library/Sounds/Tink.aiff',
    listening: '/System/Library/Sounds/Tink.aiff',
    confirm: '/System/Library/Sounds/Pop.aiff',
    success: '/System/Library/Sounds/Hero.aiff',
    error: '/System/Library/Sounds/Basso.aiff',
    alert: '/System/Library/Sounds/Ping.aiff',
    thinking: '/System/Library/Sounds/Morse.aiff'
};

/**
 * Play a low-latency acoustic feedback cue
 * @param {'wake'|'listening'|'confirm'|'success'|'error'|'alert'|'thinking'} cueType
 */
export function playAudioCue(cueType = 'confirm') {
    const config = loadConfig();
    if (config.audioCuesEnabled === false) return;

    try {
        if (process.platform === 'darwin') {
            const soundFile = MAC_SOUNDS[cueType] || MAC_SOUNDS.confirm;
            if (fs.existsSync(soundFile)) {
                const child = spawn('afplay', [soundFile], {
                    stdio: 'ignore',
                    detached: true
                });
                child.unref();
            }
        } else if (process.platform === 'win32') {
            const child = spawn('powershell', ['-c', '[System.Media.SystemSounds]::Asterisk.Play()'], {
                stdio: 'ignore',
                detached: true
            });
            child.unref();
        }
    } catch {
        // Audio cues should never disrupt primary execution
    }
}

const BUTLER_PHRASES = {
    ack: [
        'Right away, sir.',
        'At once, sir.',
        'Consider it handled, sir.',
        'Immediately, sir.'
    ],
    done: [
        'Task completed, sir.',
        'All taken care of, sir.',
        'Finished, sir.'
    ],
    alert: [
        'Pardon the interruption, sir.',
        'A brief matter requires your attention, sir.'
    ],
    ready: [
        'Rex at your service, sir.',
        'Standing by, sir.'
    ]
};

/**
 * Get a random polite butler phrase
 * @param {'ack'|'done'|'alert'|'ready'} type
 */
export function getButlerPhrase(type = 'ack') {
    const list = BUTLER_PHRASES[type] || BUTLER_PHRASES.ack;
    return list[Math.floor(Math.random() * list.length)];
}

export const playCue = playAudioCue;
