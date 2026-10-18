/**
 * daemon.js — Proactive Alfred Butler Background Daemon
 *
 * Runs autonomously in the background (via launchd or detached process).
 * Monitored services:
 *   - Critical battery watcher (<15% & discharging -> audio chime, voice, notification)
 *   - Morning Executive Briefing (8:30 AM -> Cartesia greeting + system notification)
 *   - Evening Executive Briefing (7:30 PM -> Cartesia wrap-up + system notification)
 *   - Calendar Meeting Reminder (10 mins before event -> acoustic cue + notification)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execSync } from 'child_process';
import pc from 'picocolors';
import { loadConfig, saveConfig } from './config.js';
import { macSystem } from './appleScript.js';
import { generateMorningBriefing, generateEveningBriefing, getSystemVitals } from './alfredButler.js';
import { playCue } from './audioCues.js';
import { generateSpeechFile } from './cartesia.js';

const GLOBAL_DIR = path.join(os.homedir(), '.power-cli');
const DAEMON_PID_FILE = path.join(GLOBAL_DIR, 'butler_daemon.pid');
const DAEMON_LOG_FILE = path.join(GLOBAL_DIR, 'butler_daemon.log');
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.adityapdixit.rex-butler.plist');

function logDaemon(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        if (!fs.existsSync(GLOBAL_DIR)) fs.mkdirSync(GLOBAL_DIR, { recursive: true });
        fs.appendFileSync(DAEMON_LOG_FILE, line, 'utf8');
    } catch {}
}

async function speakAlert(text) {
    try {
        const wavPath = await generateSpeechFile(text);
        if (wavPath && fs.existsSync(wavPath)) {
            execSync(`afplay "${wavPath}"`, { stdio: 'ignore' });
            try { fs.unlinkSync(wavPath); } catch {}
        }
    } catch (e) {
        logDaemon(`Speech alert error: ${e.message}`);
    }
}

/**
 * The core heartbeat loop that runs continuously
 */
export async function runHeartbeatWorker() {
    logDaemon('Proactive Alfred Butler daemon started.');

    // Auto-start active in-browser Chrome extension bridge on 8787 by default
    try {
        const { startBrowserBridge } = await import('./browserBridge.js');
        startBrowserBridge(8787);
        logDaemon('Active In-Browser Chrome extension bridge auto-started on port 8787.');
    } catch (e) {
        logDaemon(`Browser Bridge auto-start error: ${e.message}`);
    }

    let lastBatteryAlert = 0;
    let lastMorningDate = '';
    let lastEveningDate = '';
    const warnedMeetings = new Set();

    while (true) {
        try {
            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10);
            const hours = now.getHours();
            const minutes = now.getMinutes();

            // ─── 1. Battery & Power Sentinel ───
            try {
                const batt = await macSystem.getBatteryInfo();
                if (batt && batt.charging === false && batt.percent <= 15) {
                    // Alert at most once every 30 minutes for low battery
                    if (Date.now() - lastBatteryAlert > 30 * 60 * 1000) {
                        lastBatteryAlert = Date.now();
                        logDaemon(`Low battery trigger: ${batt.percent}%`);
                        await macSystem.displayNotification(`Sir, your battery is critically low (${batt.percent}%). Please connect your charger.`, {
                            title: 'Rex Butler Alert'
                        });
                        playCue('warning');
                        await speakAlert(`Sir, your battery is at ${batt.percent} percent. Please connect your charger.`);
                    }
                }
            } catch (err) {
                logDaemon(`Battery check error: ${err.message}`);
            }

            // ─── 2. Morning Briefing (8:30 AM) ───
            if (hours === 8 && minutes >= 30 && lastMorningDate !== dateStr) {
                lastMorningDate = dateStr;
                logDaemon('Triggering Morning Briefing.');
                try {
                    const briefing = await generateMorningBriefing();
                    await macSystem.displayNotification(briefing.text.slice(0, 150), {
                        title: briefing.greeting || 'Rex Morning Briefing'
                    });
                    playCue('morning');
                    await speakAlert(`${briefing.greeting}. Here is your morning briefing: ${briefing.text.slice(0, 200)}`);
                } catch (e) {
                    logDaemon(`Morning briefing error: ${e.message}`);
                }
            }

            // ─── 3. Evening Wrap-up (7:30 PM) ───
            if (hours === 19 && minutes >= 30 && lastEveningDate !== dateStr) {
                lastEveningDate = dateStr;
                logDaemon('Triggering Evening Briefing.');
                try {
                    const briefing = await generateEveningBriefing();
                    await macSystem.displayNotification(briefing.text.slice(0, 150), {
                        title: briefing.greeting || 'Rex Evening Wrap-up'
                    });
                    playCue('evening');
                    await speakAlert(`${briefing.greeting}. ${briefing.text.slice(0, 200)}`);
                } catch (e) {
                    logDaemon(`Evening briefing error: ${e.message}`);
                }
            }

            // ─── 4. Calendar Heads-Up (Upcoming meetings in <= 10 mins) ───
            try {
                const { calendarList } = await import('./integrations.js');
                const calResult = await calendarList({ maxResults: 3 });
                if (calResult && typeof calResult === 'string' && !calResult.includes('No calendar integration')) {
                    const lines = calResult.split('\n');
                    for (const l of lines) {
                        const timeMatch = l.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
                        if (timeMatch) {
                            const eventTime = new Date(timeMatch[1]).getTime();
                            const diffMinutes = Math.round((eventTime - Date.now()) / (60 * 1000));
                            if (diffMinutes > 0 && diffMinutes <= 10) {
                                const eventKey = `${dateStr}:${timeMatch[1]}`;
                                if (!warnedMeetings.has(eventKey)) {
                                    warnedMeetings.add(eventKey);
                                    logDaemon(`Upcoming meeting in ${diffMinutes}m: ${l}`);
                                    await macSystem.displayNotification(`Meeting in ${diffMinutes} minutes: ${l.slice(0, 60)}`, {
                                        title: 'Calendar Alert'
                                    });
                                    playCue('notification');
                                    await speakAlert(`Sir, you have a meeting scheduled in ${diffMinutes} minutes.`);
                                }
                            }
                        }
                    }
                }
            } catch {}

        } catch (globalErr) {
            logDaemon(`Heartbeat error: ${globalErr.message}`);
        }

        // Sleep 45 seconds before next heartbeat check
        await new Promise(r => setTimeout(r, 45000));
    }
}

/**
 * Check if the daemon process is running
 */
export function getDaemonStatus() {
    if (!fs.existsSync(DAEMON_PID_FILE)) {
        return { running: false, pid: null };
    }
    try {
        const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10);
        if (!pid) return { running: false, pid: null };
        process.kill(pid, 0); // test if process exists
        return { running: true, pid };
    } catch {
        return { running: false, pid: null };
    }
}

/**
 * Start the proactive daemon in the background
 */
export function startDaemon() {
    const status = getDaemonStatus();
    if (status.running) {
        return `Proactive Alfred daemon is already running (PID: ${status.pid}).`;
    }

    const scriptPath = path.resolve(import.meta.dirname, 'index.js');
    const child = spawn(process.execPath, [scriptPath, 'daemon', 'run'], {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd()
    });

    child.unref();

    if (!fs.existsSync(GLOBAL_DIR)) fs.mkdirSync(GLOBAL_DIR, { recursive: true });
    fs.writeFileSync(DAEMON_PID_FILE, String(child.pid), 'utf8');

    logDaemon(`Daemon spawned with PID ${child.pid}`);
    return `Alfred Proactive Daemon started successfully in background (PID: ${child.pid}).`;
}

/**
 * Stop the background daemon
 */
export function stopDaemon() {
    const status = getDaemonStatus();
    if (!status.running) {
        if (fs.existsSync(DAEMON_PID_FILE)) fs.unlinkSync(DAEMON_PID_FILE);
        return 'Alfred Proactive Daemon is not currently running.';
    }

    try {
        process.kill(status.pid, 'SIGTERM');
        if (fs.existsSync(DAEMON_PID_FILE)) fs.unlinkSync(DAEMON_PID_FILE);
        logDaemon(`Daemon PID ${status.pid} terminated.`);
        return `Alfred Proactive Daemon (PID: ${status.pid}) stopped.`;
    } catch (e) {
        if (fs.existsSync(DAEMON_PID_FILE)) fs.unlinkSync(DAEMON_PID_FILE);
        return `Failed to stop daemon PID ${status.pid}: ${e.message}`;
    }
}
