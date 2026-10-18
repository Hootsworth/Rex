import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig, saveConfig } from './config.js';

// Helper to mask sensitive keys
function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '*'.repeat(key.length);
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// ─── Google Auth Helper ──────────────────────────────────────────────────────
async function getGoogleAccessToken(config) {
    if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) {
        throw new Error('Google OAuth credentials not fully configured (googleClientId, googleClientSecret, googleRefreshToken).');
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: config.googleClientId,
            client_secret: config.googleClientSecret,
            refresh_token: config.googleRefreshToken,
            grant_type: 'refresh_token'
        })
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(`Google OAuth refresh failed: ${data.error_description || data.error || JSON.stringify(data)}`);
    }
    return data.access_token;
}

// ─── Gmail Integration ───────────────────────────────────────────────────────
export async function gmailList(args = {}) {
    try {
        const config = loadConfig();
        const token = await getGoogleAccessToken(config);
        const maxResults = args.maxResults || 5;
        const query = args.query || 'is:unread';

        const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
        const res = await fetch(listUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const listData = await res.json();
        if (!res.ok) throw new Error(listData.error?.message || 'Failed to list Gmail messages');

        const messages = listData.messages || [];
        if (messages.length === 0) return 'No emails found matching query.';

        const details = [];
        for (const msg of messages) {
            const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`;
            const detailRes = await fetch(detailUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const detailData = await detailRes.json();
            if (detailRes.ok) {
                const headers = detailData.payload?.headers || [];
                const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(No Subject)';
                const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || 'Unknown';
                const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || 'Unknown Date';
                details.push(`- **From:** ${from}\n  **Subject:** ${subject}\n  **Date:** ${date}\n  **Snippet:** ${detailData.snippet}\n  **ID:** ${msg.id}`);
            }
        }
        return `### Gmail Inbox / Search Results\n\n${details.join('\n\n')}`;
    } catch (e) {
        return `Gmail List Error: ${e.message}`;
    }
}

export async function gmailDraft(args = {}) {
    try {
        const config = loadConfig();
        const token = await getGoogleAccessToken(config);
        const { to, subject, body } = args;
        if (!to || !subject || !body) throw new Error('Missing required arguments: to, subject, body');

        const emailContent = [
            `To: ${to}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset="UTF-8"',
            '',
            body
        ].join('\r\n');
        const encoded = Buffer.from(emailContent).toString('base64url');

        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: { raw: encoded }
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to create draft');
        return `Email draft created successfully! Draft ID: ${data.id}`;
    } catch (e) {
        return `Gmail Draft Error: ${e.message}`;
    }
}

export async function gmailSend(args = {}) {
    try {
        const config = loadConfig();
        const token = await getGoogleAccessToken(config);
        const { to, subject, body } = args;
        if (!to || !subject || !body) throw new Error('Missing required arguments: to, subject, body');

        const emailContent = [
            `To: ${to}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset="UTF-8"',
            '',
            body
        ].join('\r\n');
        const encoded = Buffer.from(emailContent).toString('base64url');

        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ raw: encoded })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to send email');
        return `Email sent successfully! Message ID: ${data.id}`;
    } catch (e) {
        return `Gmail Send Error: ${e.message}`;
    }
}

// ─── Google Calendar Integration ─────────────────────────────────────────────
export async function calendarList(args = {}) {
    try {
        const config = loadConfig();
        const token = await getGoogleAccessToken(config);
        const maxResults = args.maxResults || 5;
        const timeMin = new Date().toISOString();

        const calendarUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=${maxResults}&orderBy=startTime&singleEvents=true&timeMin=${encodeURIComponent(timeMin)}`;
        const res = await fetch(calendarUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to list calendar events');

        const events = data.items || [];
        if (events.length === 0) return 'No upcoming calendar events found.';

        const list = events.map(event => {
            const start = event.start?.dateTime || event.start?.date || 'N/A';
            const end = event.end?.dateTime || event.end?.date || 'N/A';
            return `- **Event:** ${event.summary}\n  **Time:** ${start} to ${end}\n  **Description:** ${event.description || 'No description'}`;
        });
        return `### Upcoming Calendar Events\n\n${list.join('\n\n')}`;
    } catch (e) {
        return `Calendar List Error: ${e.message}`;
    }
}

export async function calendarAdd(args = {}) {
    try {
        const config = loadConfig();
        const token = await getGoogleAccessToken(config);
        const { summary, description, startTime, endTime } = args;
        if (!summary || !startTime || !endTime) throw new Error('Missing required arguments: summary, startTime, endTime');

        const calendarUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
        const res = await fetch(calendarUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                summary,
                description: description || '',
                start: { dateTime: startTime },
                end: { dateTime: endTime }
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to add calendar event');
        return `Calendar event added successfully! Event Link: ${data.htmlLink}`;
    } catch (e) {
        return `Calendar Add Error: ${e.message}`;
    }
}

// ─── GitHub Integration ──────────────────────────────────────────────────────
export async function githubListIssues(args = {}) {
    try {
        const config = loadConfig();
        if (!config.githubToken || !config.githubRepo) {
            throw new Error('GitHub settings not configured (githubToken, githubRepo).');
        }
        const state = args.state || 'open';
        const maxResults = args.maxResults || 5;

        const url = `https://api.github.com/repos/${config.githubRepo}/issues?state=${state}&per_page=${maxResults}`;
        const res = await fetch(url, {
            headers: {
                'Authorization': `token ${config.githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'RexAI-Assistant'
            }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Failed to fetch issues');

        if (!Array.isArray(data)) return `No issues found.`;
        const list = data.map(issue => `- **[Issue #${issue.number}] ${issue.title}**\n  State: ${issue.state} | Comments: ${issue.comments}\n  URL: ${issue.html_url}`);
        return `### GitHub Issues for ${config.githubRepo}\n\n${list.join('\n')}`;
    } catch (e) {
        return `GitHub List Issues Error: ${e.message}`;
    }
}

export async function githubCreatePr(args = {}) {
    try {
        const config = loadConfig();
        if (!config.githubToken || !config.githubRepo) {
            throw new Error('GitHub settings not configured (githubToken, githubRepo).');
        }
        const { title, head, base, body } = args;
        if (!title || !head || !base) throw new Error('Missing required arguments: title, head, base');

        const url = `https://api.github.com/repos/${config.githubRepo}/pulls`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `token ${config.githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'RexAI-Assistant',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, head, base, body: body || '' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || JSON.stringify(data.errors || data));
        return `Pull Request created successfully! PR Link: ${data.html_url}`;
    } catch (e) {
        return `GitHub Create PR Error: ${e.message}`;
    }
}

export async function githubCommentIssue(args = {}) {
    try {
        const config = loadConfig();
        if (!config.githubToken || !config.githubRepo) {
            throw new Error('GitHub settings not configured (githubToken, githubRepo).');
        }
        const { issueNumber, body } = args;
        if (!issueNumber || !body) throw new Error('Missing required arguments: issueNumber, body');

        const url = `https://api.github.com/repos/${config.githubRepo}/issues/${issueNumber}/comments`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `token ${config.githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'RexAI-Assistant',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ body })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Failed to comment');
        return `Comment added to issue #${issueNumber}! Comment Link: ${data.html_url}`;
    } catch (e) {
        return `GitHub Comment Issue Error: ${e.message}`;
    }
}

// ─── Linear Integration ──────────────────────────────────────────────────────
export async function linearListIssues(args = {}) {
    try {
        const config = loadConfig();
        if (!config.linearApiKey) throw new Error('Linear API key not configured (linearApiKey).');
        const maxResults = args.maxResults || 5;

        const query = `
            query {
                issues(first: ${maxResults}, filter: { state: { name: { nin: ["Completed", "Canceled"] } } }) {
                    nodes {
                        id
                        identifier
                        title
                        description
                        state { name }
                    }
                }
            }
        `;

        const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
                'Authorization': config.linearApiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query })
        });
        const data = await res.json();
        if (!res.ok || data.errors) throw new Error(data.errors?.[0]?.message || 'GraphQL error');

        const issues = data.data?.issues?.nodes || [];
        if (issues.length === 0) return 'No active Linear issues found.';

        const list = issues.map(issue => `- **[${issue.identifier}] ${issue.title}**\n  State: ${issue.state?.name || 'N/A'}\n  Description: ${issue.description || 'No description'}`);
        return `### Linear Active Issues\n\n${list.join('\n\n')}`;
    } catch (e) {
        return `Linear List Issues Error: ${e.message}`;
    }
}

export async function linearCommentIssue(args = {}) {
    try {
        const config = loadConfig();
        if (!config.linearApiKey) throw new Error('Linear API key not configured.');
        const { issueId, body } = args;
        if (!issueId || !body) throw new Error('Missing required arguments: issueId, body');

        const query = `
            mutation($issueId: String!, $body: String!) {
                commentCreate(input: { issueId: $issueId, body: $body }) {
                    success
                    comment {
                        id
                    }
                }
            }
        `;

        const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
                'Authorization': config.linearApiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query, variables: { issueId, body } })
        });
        const data = await res.json();
        if (!res.ok || data.errors) throw new Error(data.errors?.[0]?.message || 'GraphQL error');

        if (data.data?.commentCreate?.success) {
            return `Comment added to Linear issue successfully! Comment ID: ${data.data.commentCreate.comment?.id}`;
        }
        return 'Linear failed to add comment.';
    } catch (e) {
        return `Linear Comment Issue Error: ${e.message}`;
    }
}

// ─── Notion Integration ──────────────────────────────────────────────────────
export async function notionAddPage(args = {}) {
    try {
        const config = loadConfig();
        if (!config.notionToken || !config.notionDatabaseId) {
            throw new Error('Notion settings not fully configured (notionToken, notionDatabaseId).');
        }
        const { title, content } = args;
        if (!title) throw new Error('Missing required argument: title');

        const blockText = content || 'New page created from RexAI.';
        const contentChunks = blockText.match(/[\s\S]{1,1900}/g) || [blockText];

        const body = {
            parent: { database_id: config.notionDatabaseId },
            properties: {
                title: [
                    { text: { content: title } }
                ]
            },
            children: contentChunks.map(chunk => ({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [
                        { type: 'text', text: { content: chunk } }
                    ]
                }
            }))
        };

        const res = await fetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.notionToken}`,
                'Content-Type': 'application/json',
                'Notion-Version': '2022-06-28'
            },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || JSON.stringify(data));
        return `Notion page created successfully! Page Link: ${data.url}`;
    } catch (e) {
        return `Notion Add Page Error: ${e.message}`;
    }
}

export async function notionSyncMemory() {
    try {
        const config = loadConfig();
        if (!config.notionToken || !config.notionDatabaseId) {
            throw new Error('Notion settings not fully configured (notionToken, notionDatabaseId).');
        }

        // Read local memory facts
        const memoryPath = path.join(process.cwd(), '.agent', 'memory.md');
        const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : 'No local memory facts found.';

        // Read local hindsights
        const hindsightDir = path.join(process.cwd(), '.agent', 'hindsight');
        let hindsightContent = 'No hindsight records found.';
        if (fs.existsSync(hindsightDir)) {
            const files = fs.readdirSync(hindsightDir).filter(f => f.endsWith('.md'));
            if (files.length > 0) {
                const combined = [];
                for (const file of files) {
                    const content = fs.readFileSync(path.join(hindsightDir, file), 'utf-8');
                    combined.push(`### ${file}\n${content}`);
                }
                hindsightContent = combined.join('\n\n');
            }
        }

        const title = `Project Sync - ${new Date().toLocaleDateString()}`;
        const content = `Synced: ${new Date().toLocaleString()}\n\n## Local Facts\n${memoryContent}\n\n## Hindsight Retrospectives\n${hindsightContent}`;

        return await notionAddPage({ title, content });
    } catch (e) {
        return `Notion Sync Memory Error: ${e.message}`;
    }
}

// ─── Lab Config Menu ──────────────────────────────────────────────────────────
export async function integrationsConfigMenu() {
    let active = true;
    while (active) {
        const config = loadConfig();

        const choice = await p.select({
            message: pc.dim('integrations config'),
            options: [
                { value: 'google', label: `Google (Gmail & Calendar) ${config.googleRefreshToken ? pc.green('✔') : pc.red('✘')}` },
                { value: 'github', label: `GitHub ${config.githubToken ? pc.green('✔') : pc.red('✘')}` },
                { value: 'linear', label: `Linear ${config.linearApiKey ? pc.green('✔') : pc.red('✘')}` },
                { value: 'notion', label: `Notion ${config.notionToken ? pc.green('✔') : pc.red('✘')}` },
                { value: 'back', label: pc.dim('  back') }
            ]
        });

        if (p.isCancel(choice) || choice === 'back') {
            active = false;
            break;
        }

        if (choice === 'google') {
            const clientId = await p.text({
                message: 'Enter Google OAuth Client ID:',
                initialValue: config.googleClientId || '',
                placeholder: '12345-abc.apps.googleusercontent.com'
            });
            if (p.isCancel(clientId)) continue;

            const clientSecret = await p.password({
                message: 'Enter Google OAuth Client Secret:',
                mask: '*'
            });
            if (p.isCancel(clientSecret)) continue;

            const refreshToken = await p.password({
                message: 'Enter Google OAuth Refresh Token:',
                mask: '*'
            });
            if (p.isCancel(refreshToken)) continue;

            config.googleClientId = clientId.trim();
            if (clientSecret) config.googleClientSecret = clientSecret.trim();
            if (refreshToken) config.googleRefreshToken = refreshToken.trim();

            saveConfig(config);
            p.note(pc.green('Google credentials updated!'), 'Success');
        }

        if (choice === 'github') {
            const repo = await p.text({
                message: 'Enter GitHub Repository (owner/repo):',
                initialValue: config.githubRepo || '',
                placeholder: 'username/my-project'
            });
            if (p.isCancel(repo)) continue;

            const token = await p.password({
                message: 'Enter GitHub Personal Access Token:',
                mask: '*'
            });
            if (p.isCancel(token)) continue;

            config.githubRepo = repo.trim();
            if (token) config.githubToken = token.trim();

            saveConfig(config);
            p.note(pc.green('GitHub settings updated!'), 'Success');
        }

        if (choice === 'linear') {
            const apiKey = await p.password({
                message: 'Enter Linear API Key:',
                mask: '*'
            });
            if (p.isCancel(apiKey)) continue;

            if (apiKey) config.linearApiKey = apiKey.trim();

            saveConfig(config);
            p.note(pc.green('Linear API key updated!'), 'Success');
        }

        if (choice === 'notion') {
            const token = await p.password({
                message: 'Enter Notion Integration Token:',
                mask: '*'
            });
            if (p.isCancel(token)) continue;

            const dbId = await p.text({
                message: 'Enter Notion Database ID (or parent page ID):',
                initialValue: config.notionDatabaseId || '',
                placeholder: 'e.g. 5d5a6c...'
            });
            if (p.isCancel(dbId)) continue;

            if (token) config.notionToken = token.trim();
            config.notionDatabaseId = dbId.trim();

            saveConfig(config);
            p.note(pc.green('Notion settings updated!'), 'Success');
        }
    }
}
