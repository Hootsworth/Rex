import os from 'os';
import { exec } from 'child_process';
import util from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import Table from 'cli-table3';

const execPromise = util.promisify(exec);
const theme = gradient(['#4169e1', '#00ced1']);

export async function getSystemInfo() {
    const s = p.spinner();
    s.start('Fetching system information...');

    try {
        const cpu = os.cpus();
        const mem = {
            total: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            free: (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            used: ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(2) + ' GB'
        };
        const platform = os.platform();
        const release = os.release();
        const uptime = (os.uptime() / 3600).toFixed(2) + ' hours';

        // Fetch battery info on Windows
        let battery = 'N/A';
        if (platform === 'win32') {
            try {
                const { stdout } = await execPromise('WMIC Path Win32_Battery Get EstimatedChargeRemaining');
                const lines = stdout.trim().split('\n');
                if (lines.length > 1) {
                    battery = lines[1].trim() + '%';
                }
            } catch (e) {}
        } else if (platform === 'darwin') {
            try {
                const { stdout } = await execPromise('pmset -g batt');
                const percentMatch = stdout.match(/(\d+)%/);
                if (percentMatch) battery = `${percentMatch[1]}%`;
            } catch (e) {}
        }

        s.stop('Information gathered.');

        const table = new Table({
            head: [theme('Component'), theme('Details')],
            colWidths: [20, 50],
            wordWrap: true
        });

        table.push(
            ['OS Platform', `${platform} (${release})`],
            ['CPU', `${cpu[0].model} (${cpu.length} cores)`],
            ['Memory', `Total: ${mem.total} | Used: ${mem.used} | Free: ${mem.free}`],
            ['Uptime', uptime],
            ['Battery', battery]
        );

        console.log('\n' + table.toString() + '\n');

    } catch (err) {
        s.stop(pc.red('Failed to fetch system info.'));
        p.log.error(err.message);
    }
}

export async function listProcesses() {
    const s = p.spinner();
    s.start('Scanning active processes...');

    try {
        let cmd = '';
        if (process.platform === 'win32') {
            cmd = 'tasklist /FO CSV /NH';
        } else {
            cmd = 'ps -e -o pid,comm,%mem,%cpu --sort=-%mem | head -n 20';
        }

        const { stdout } = await execPromise(cmd);
        s.stop('Scan complete.');

        const table = new Table({
            head: [theme('PID'), theme('Name'), theme('Memory'), theme('CPU')],
            colWidths: [10, 30, 15, 10]
        });

        if (process.platform === 'win32') {
            const lines = stdout.trim().split('\n').slice(0, 20);
            lines.forEach(line => {
                const parts = line.split(',').map(p => p.replace(/"/g, ''));
                table.push([parts[1], parts[0], parts[4], 'N/A']);
            });
        } else {
            const lines = stdout.trim().split('\n').slice(1);
            lines.forEach(line => {
                const parts = line.trim().split(/\s+/);
                table.push([parts[0], parts[1], parts[2] + '%', parts[3] + '%']);
            });
        }

        console.log('\n' + table.toString() + '\n');

    } catch (err) {
        s.stop(pc.red('Failed to list processes.'));
        p.log.error(err.message);
    }
}

export async function managePower(action) {
    const confirmed = await p.confirm({
        message: `Are you sure you want to ${action} the system?`,
        initialValue: false
    });

    if (!confirmed) return;

    try {
        let cmd = '';
        if (process.platform === 'win32') {
            if (action === 'shutdown') cmd = 'shutdown /s /t 60';
            if (action === 'restart') cmd = 'shutdown /r /t 60';
            if (action === 'sleep') cmd = 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0';
        } else if (process.platform === 'darwin') {
            if (action === 'shutdown') cmd = 'osascript -e "tell application \"System Events\" to shut down"';
            if (action === 'restart') cmd = 'osascript -e "tell application \"System Events\" to restart"';
            if (action === 'sleep') cmd = 'pmset sleepnow';
        } else {
            if (action === 'shutdown') cmd = 'shutdown -h +1';
            if (action === 'restart') cmd = 'shutdown -r +1';
            if (action === 'sleep') cmd = 'systemctl suspend';
        }

        if (cmd) {
            await execPromise(cmd);
            p.log.success(theme(`${action.charAt(0).toUpperCase() + action.slice(1)} command initiated. You have 60 seconds to cancel.`));
        } else {
            p.log.error('Power action not supported on this platform.');
        }
    } catch (err) {
        p.log.error(`Failed to initiate ${action}: ${err.message}`);
    }
}
