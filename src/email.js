import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from './config.js';

function escapeAppleScriptString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function sendEmail(to, subject, body) {
    const config = loadConfig();

    const isWindows = process.platform === 'win32';
    if (isWindows && (!config.smtpHost || !config.smtpUser)) {
        p.log.error('Email not configured. Please set SMTP settings in Rex settings.');
        return;
    }

    const s = p.spinner();
    s.start(`Sending email to ${to}...`);

    try {
        if (isWindows) {
            const psScript = `
$SmtpClient = New-Object Net.Mail.SmtpClient('${config.smtpHost}', ${config.smtpPort});
$SmtpClient.EnableSsl = $true;
$SmtpClient.Credentials = New-Object System.Net.NetworkCredential('${config.smtpUser}', '${config.smtpPass}');
$SmtpClient.Send('${config.smtpUser}', '${to}', '${subject}', '${body}');
`;
            // Note: This requires .NET Mail and might be blocked by some security policies.
            // Better to use an actual Node library, but we stick to native tools for now.
            const { exec } = await import('child_process');
            const util = await import('util');
            const execPromise = util.promisify(exec);
            
            await execPromise(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`);
            s.stop('Email sent successfully via PowerShell.');
        } else if (process.platform === 'darwin') {
            const escapedTo = escapeAppleScriptString(to);
            const escapedSubject = escapeAppleScriptString(subject);
            const escapedBody = escapeAppleScriptString(body);
            const script = [
                'tell application "Mail"',
                `set newMessage to make new outgoing message with properties {visible:false, subject:"${escapedSubject}", content:"${escapedBody}"}`,
                'tell newMessage',
                `make new to recipient at end of to recipients with properties {address:"${escapedTo}"}`,
                'send',
                'end tell',
                'end tell'
            ].join('\n');

            const { exec } = await import('child_process');
            const util = await import('util');
            const execPromise = util.promisify(exec);
            await execPromise(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
            s.stop('Email sent successfully via Apple Mail.');
        } else {
            s.stop(pc.yellow('Native email sending is currently supported on Windows and macOS. Please install nodemailer for Linux support.'));
        }
    } catch (err) {
        s.stop(pc.red('Email failed.'));
        p.log.error(err.message);
    }
}

export async function emailMenu() {
    const to = await p.text({ message: 'Recipient Email:', placeholder: 'user@example.com' });
    if (p.isCancel(to)) return;

    const subject = await p.text({ message: 'Subject:', placeholder: 'Alert from RexAI' });
    if (p.isCancel(subject)) return;

    const body = await p.text({ message: 'Body:', placeholder: 'Hello, this is Rex...' });
    if (p.isCancel(body)) return;

    await sendEmail(to, subject, body);
}
