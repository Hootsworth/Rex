import fs from 'fs';
import path from 'path';
import os from 'os';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';

const theme = gradient(['#7cfc00', '#00ff7f']);
const SCHEDULE_FILE = path.join(os.homedir(), '.power-cli', 'tasks.json');

export function loadTasks() {
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

export function saveTasks(tasks) {
    const dir = path.dirname(SCHEDULE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(tasks, null, 2));
}

export async function scheduleTask() {
    p.note('Rex Automation Scheduler (v1.0)', 'Rex Agent');
    
    const taskNameRaw = await p.text({ message: 'Task name:', placeholder: 'Backup source code' });
    if (p.isCancel(taskNameRaw)) return;
    const taskName = taskNameRaw.trim();
    if (!taskName) {
        p.log.warn('Task name cannot be empty.');
        return;
    }

    const commandRaw = await p.text({ message: 'Shell command to run:', placeholder: 'git push origin main' });
    if (p.isCancel(commandRaw)) return;
    const command = commandRaw.trim();
    if (!command) {
        p.log.warn('Shell command cannot be empty.');
        return;
    }

    const interval = await p.select({
        message: 'Repeat interval:',
        options: [
            { value: 60000, label: 'Every minute' },
            { value: 3600000, label: 'Every hour' },
            { value: 86400000, label: 'Every day' },
            { value: 0, label: 'One-time' }
        ]
    });

    if (p.isCancel(interval)) return;

    const tasks = loadTasks();
    tasks.push({
        id: Date.now(),
        name: taskName,
        command: command,
        interval: interval,
        lastRun: 0,
        createdAt: Date.now()
    });
    saveTasks(tasks);

    p.log.success(theme(`Task '${taskName}' scheduled successfully.`));
    p.note(`Rex must be running in 'daemon' mode for scheduled tasks to execute.`, 'Tip');
}

export async function automationDaemon() {
    p.note('Rex Automation Daemon is now active. Keeping this terminal alive.', 'Rex Persistent Mode');
    
    setInterval(async () => {
        const tasks = loadTasks();
        const now = Date.now();
        let changed = false;

        for (const task of tasks) {
            const isOneTime = Number(task.interval) === 0;
            const neverRun = !task.lastRun || Number(task.lastRun) === 0;
            const repeatDue = Number(task.interval) > 0 && (now - Number(task.lastRun || 0)) >= Number(task.interval);
            const shouldRun = (isOneTime && neverRun) || repeatDue;

            if (shouldRun) {
                p.log.info(theme(`[${new Date().toLocaleTimeString()}] Running scheduled task: ${task.name}`));
                // Integration with shellTools would go here
                try {
                    const { run_shell_command } = await import('./shellTools.js');
                    await run_shell_command(task.command);
                    task.lastRun = now;
                    changed = true;
                } catch (e) {
                    p.log.error(`Task '${task.name}' failed: ${e.message}`);
                }
            }
        }

        if (changed) saveTasks(tasks);
    }, 10000); // Check every 10s
}

export async function keepALookMenuTask() {
    const url = await p.text({
        message: 'Webpage URL to monitor:',
        placeholder: 'https://example.com/tickets',
        validate: (v) => !v.trim() ? 'URL is required.' : undefined
    });
    if (p.isCancel(url)) return;

    const condition = await p.text({
        message: 'Condition to watch for (optional, leave empty for any change):',
        placeholder: 'tickets are available'
    });
    if (p.isCancel(condition)) return;

    const action = await p.text({
        message: 'Goal to execute once condition is met:',
        placeholder: 'add 2 to checkout and take a screenshot of QR code',
        validate: (v) => !v.trim() ? 'Goal is required.' : undefined
    });
    if (p.isCancel(action)) return;

    const intervalStr = await p.text({
        message: 'Check interval in seconds (default 30):',
        placeholder: '30'
    });
    if (p.isCancel(intervalStr)) return;
    const intervalSeconds = Number(intervalStr) || 30;

    const selector = await p.text({
        message: 'CSS selector to narrow down monitoring (optional):',
        placeholder: '.ticket-booking-status'
    });
    if (p.isCancel(selector)) return;

    const headless = await p.confirm({
        message: 'Run browser in headless mode?',
        initialValue: false
    });
    if (p.isCancel(headless)) return;

    p.note(`Starting Keep-A-Look monitor job...\nURL: ${url}\nWatching: ${condition || 'Any content change'}\nAction: ${action}`, 'Keep-A-Look');

    const { keep_a_look } = await import('./webTools.js');
    try {
        const res = await keep_a_look({
            url: url.trim(),
            condition: condition.trim(),
            action: action.trim(),
            intervalSeconds,
            selector: selector.trim() || undefined,
            headless
        });
        p.note(res, 'Keep-A-Look Done');
    } catch (err) {
        p.log.error(`Keep-A-Look Error: ${err.message}`);
    }
}

export async function automationMenu() {
    const choice = await p.select({
        message: 'Advanced Automation:',
        options: [
            { value: 'schedule', label: '📅 Schedule New Task' },
            { value: 'list', label: '📋 List Scheduled Tasks' },
            { value: 'look', label: '👀 Keep-A-Look (Monitor Webpage)' },
            { value: 'daemon', label: '🚀 Start Automation Daemon' },
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(choice) || choice === 'back') return;

    if (choice === 'schedule') await scheduleTask();
    if (choice === 'look') await keepALookMenuTask();
    if (choice === 'list') {
        const tasks = loadTasks();
        if (tasks.length === 0) {
            p.log.warn('No tasks scheduled.');
        } else {
            tasks.forEach(t => {
                const schedule = Number(t.interval) === 0 ? 'One-time' : `Every ${Number(t.interval) / 60000}m`;
                p.note(`${pc.cyan(t.name)}: ${t.command} (${schedule})`, 'Task');
            });
        }
    }
    if (choice === 'daemon') await automationDaemon();
}
