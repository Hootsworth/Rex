import { exec } from 'child_process';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';

// A simple in-memory job store (could be backed by a JSON file for persistence)
const jobs = [];

export function scheduleTask(delayMs, promptText, callback) {
    const fireAt = Date.now() + delayMs;
    const job = {
        id: Math.random().toString(36).substr(2, 9),
        promptText,
        fireAt,
        timeoutId: setTimeout(async () => {
            try {
                // Execute the callback which will trigger the AI
                await callback(promptText);
            } catch (e) {
                console.error(pc.red(`Scheduled task failed: \${e.message}`));
            } finally {
                // Remove from active jobs
                const idx = jobs.findIndex(j => j.id === job.id);
                if (idx > -1) jobs.splice(idx, 1);
            }
        }, delayMs)
    };
    jobs.push(job);
    return job;
}

export function parseDelayToMs(delayStr) {
    const match = delayStr.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const val = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case 's': return val * 1000;
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': return val * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

export function listScheduledTasks() {
    return jobs.map(j => ({
        id: j.id,
        promptText: j.promptText,
        timeRemainingMs: j.fireAt - Date.now()
    }));
}

export async function sendWindowsToast(title, message) {
    if (process.platform !== 'win32') return;

    // Use PowerShell to trigger a native Windows 10/11 Toast Notification
    const psScript = `
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $textElements = $template.GetElementsByTagName("text")
        $textElements[0].AppendChild($template.CreateTextNode("\${title}")) > $null
        $textElements[1].AppendChild($template.CreateTextNode("\${message}")) > $null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("RexAI").Show($toast)
    `.replace(/'/g, "''"); // escape single quotes for powershell -c

    return new Promise((resolve) => {
        exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, { windowsHide: true }, (err) => {
            resolve(!err);
        });
    });
}
