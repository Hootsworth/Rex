import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { loadConfig } from './config.js';

const theme = gradient(['#ff4500', '#ffa500']);

export async function sendNotification(platform, message) {
    const config = loadConfig();
    const s = p.spinner();
    s.start(`Sending ${platform} notification...`);

    try {
        if (platform === 'slack') {
            const webhookUrl = config.slackWebhookUrl;
            if (!webhookUrl) throw new Error('Slack Webhook URL not configured in settings.');
            
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: message })
            });
            if (!response.ok) throw new Error(`Slack API returned ${response.status}`);
        } 
        
        else if (platform === 'discord') {
            const webhookUrl = config.discordWebhookUrl;
            if (!webhookUrl) throw new Error('Discord Webhook URL not configured in settings.');
            
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: message })
            });
            if (!response.ok) throw new Error(`Discord API returned ${response.status}`);
        }

        s.stop(`${platform.charAt(0).toUpperCase() + platform.slice(1)} notification sent!`);
    } catch (err) {
        s.stop(pc.red('Failed to send notification.'));
        p.log.error(err.message);
    }
}

export async function connectorMenu() {
    const choice = await p.select({
        message: 'Omni-Connect Platform:',
        options: [
            { value: 'slack', label: '💬 Slack' },
            { value: 'discord', label: '🎮 Discord' },
            { value: 'email', label: '📧 Email (Coming Soon)' },
            { value: 'back', label: '⬅️ Back' }
        ]
    });

    if (p.isCancel(choice) || choice === 'back') return;

    const action = await p.select({
        message: 'Action:',
        options: [
            { value: 'notify', label: '🔔 Send Test Notification' },
            { value: 'config', label: '⚙️ Configure Webhook' }
        ]
    });

    if (p.isCancel(action)) return;

    if (action === 'notify') {
        const msg = await p.text({ message: 'Enter message:', initialValue: 'Hello from RexAI! 🦖' });
        if (!p.isCancel(msg)) await sendNotification(choice, msg);
    } else if (action === 'config') {
        // This would interact with config.js/settings
        p.note(`Please set ${choice}WebhookUrl in your .env or via settings.`, 'Connector Config');
    }
}
