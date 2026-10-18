import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { loadConfig, saveConfig } from './config.js';
import { playAudioCue, getButlerPhrase } from './audioCues.js';

const execAsync = promisify(exec);

/**
 * Get Mac / System battery and thermal stats
 */
export async function getSystemVitals() {
    const vitals = {
        platform: process.platform,
        batteryPercent: null,
        charging: null,
        powerSource: 'Unknown',
        loadAvg: os.loadavg()[0],
        freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
        cpuCores: os.cpus().length
    };

    if (process.platform === 'darwin') {
        try {
            const { stdout } = await execAsync('pmset -g batt').catch(() => ({ stdout: '' }));
            if (stdout) {
                const percentMatch = stdout.match(/(\d+)%/);
                if (percentMatch) vitals.batteryPercent = parseInt(percentMatch[1], 10);
                vitals.charging = stdout.includes('charging') && !stdout.includes('discharging');
                vitals.powerSource = stdout.includes('AC Power') ? 'AC Power' : 'Battery Power';
            }
        } catch {}
    }

    return vitals;
}

/**
 * Get current Git status and open files for workspace
 */
export async function getWorkspaceIntel() {
    try {
        const [statusRes, branchRes, logRes] = await Promise.all([
            execAsync('git status --porcelain', { cwd: process.cwd() }).catch(() => ({ stdout: '' })),
            execAsync('git branch --show-current', { cwd: process.cwd() }).catch(() => ({ stdout: '' })),
            execAsync('git log -1 --oneline', { cwd: process.cwd() }).catch(() => ({ stdout: '' }))
        ]);

        const uncommitted = (statusRes.stdout || '').trim().split('\n').filter(Boolean);
        const branch = (branchRes.stdout || '').trim() || 'unknown';
        const lastCommit = (logRes.stdout || '').trim();

        return {
            isGit: Boolean(branch && branch !== 'unknown'),
            branch,
            uncommittedCount: uncommitted.length,
            lastCommit
        };
    } catch {
        return { isGit: false, branch: '', uncommittedCount: 0, lastCommit: '' };
    }
}

/**
 * Generate a butler-style morning or start-of-day briefing
 */
export async function generateMorningBriefing() {
    const vitals = await getSystemVitals();
    const git = await getWorkspaceIntel();
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

    let batteryReport = '';
    if (vitals.batteryPercent !== null) {
        batteryReport = `Your Mac is running on ${vitals.powerSource} at ${vitals.batteryPercent}%.`;
    }

    let gitReport = '';
    if (git.isGit) {
        if (git.uncommittedCount > 0) {
            gitReport = `You have ${git.uncommittedCount} uncommitted changes on branch "${git.branch}".`;
        } else {
            gitReport = `Workspace branch "${git.branch}" is completely clean.`;
        }
    }

    const message = [
        `Good day, sir. It is currently ${timeStr} on ${dateStr}.`,
        batteryReport,
        gitReport,
        `All systems are primed and standing by.`
    ].filter(Boolean).join(' ');

    return {
        greeting: `🎩 **Alfred Briefing (${timeStr})**`,
        text: message,
        vitals,
        git
    };
}

/**
 * Generate evening wrap-up briefing
 */
export async function generateEveningBriefing() {
    const git = await getWorkspaceIntel();
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let report = `Good evening, sir. As of ${timeStr}, `;
    if (git.isGit && git.uncommittedCount > 0) {
        report += `you have ${git.uncommittedCount} uncommitted changes remaining on "${git.branch}". Consider staging your progress before wrapping up.`;
    } else {
        report += `all code is committed and in order. Rest well, sir.`;
    }

    return {
        greeting: `🎩 **Alfred Evening Report**`,
        text: report,
        git
    };
}

/**
 * Check vitals and return alert if critical condition met (e.g. low battery discharging)
 */
export async function checkProactiveAlerts() {
    const config = loadConfig();
    if (!config.alfredProactivityEnabled) return null;

    const vitals = await getSystemVitals();
    
    // Low battery alert
    if (vitals.batteryPercent !== null && vitals.batteryPercent <= 20 && !vitals.charging) {
        return {
            type: 'battery_warning',
            text: `Pardon the interruption, sir. Your battery is at ${vitals.batteryPercent}% and currently discharging. Please connect a power adapter.`
        };
    }

    return null;
}

/**
 * Announce briefing or alert via Cartesia voice (if available) or system audio
 */
export async function speakBriefing(text) {
    const config = loadConfig();
    playAudioCue('alert');

    if (config.alfredVoiceAnnounce !== false) {
        try {
            const { generateCartesiaSpeech } = await import('./cartesia.js');
            const tmpPath = path.join(process.cwd(), `.rex_briefing_${Date.now()}.wav`);
            await generateCartesiaSpeech(text, tmpPath);
            if (process.platform === 'darwin') {
                const child = spawn('afplay', [tmpPath], { stdio: 'ignore', detached: true });
                child.unref();
                setTimeout(() => {
                    try { fs.unlinkSync(tmpPath); } catch {}
                }, 15000);
            }
        } catch (e) {
            // Audio failure should not stop message delivery
        }
    }
}

/**
 * Interactive Butler configuration toggle
 */
export async function toggleAlfredButler(enabled = null) {
    const config = loadConfig();
    const newState = enabled !== null ? Boolean(enabled) : !config.alfredProactivityEnabled;
    config.alfredProactivityEnabled = newState;
    saveConfig(config);

    if (newState) {
        playAudioCue('success');
        return `🎩 Alfred Proactivity has been **ENABLED**. Rex will autonomously track vitals, git state, and deliver timely briefings.`;
    } else {
        playAudioCue('confirm');
        return `🎩 Alfred Proactivity has been **DISABLED**. Rex will remain purely reactive.`;
    }
}
