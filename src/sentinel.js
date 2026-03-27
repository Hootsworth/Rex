import pc from 'picocolors';
import * as p from '@clack/prompts';
import { exec } from 'child_process';
import { util } from 'util';
import { getLocalLlama } from './ai.js';
import { loadConfig } from './config.js';

const execAsync = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) resolve({ error: err, stdout, stderr }); // Resolve rather than reject to handle naturally
        else resolve({ stdout, stderr });
    });
});

export async function runSentinel() {
    const s = p.spinner();
    s.start('Checking for GitHub CLI (gh)...');
    
    const { error: ghCheckError } = await execAsync('gh --version');
    if (ghCheckError) {
        s.stop(pc.red('GitHub CLI not found.'));
        p.note(pc.yellow('Please install the GitHub CLI (gh) and run `gh auth login` to use Sentinel.'), 'Sentinel');
        return;
    }

    s.message('Fetching open pull requests...');
    const { stdout: prListRaw, error: prListError } = await execAsync('gh pr list --state open --json number,title,author,updatedAt');
    
    if (prListError) {
        s.stop(pc.red('Failed to fetch pull requests.'));
        p.note(pc.red(`Are you in a git repository with a GitHub remote?\n${prListError.message}`), 'Sentinel');
        return;
    }

    s.stop('Pull requests fetched.');

    let prs = [];
    try {
        prs = JSON.parse(prListRaw);
    } catch (e) {
        p.note(pc.red('Failed to parse GitHub CLI output.'), 'Sentinel');
        return;
    }

    if (prs.length === 0) {
        p.note(pc.green('No open pull requests found. Good job!'), 'Sentinel');
        return;
    }

    const prChoice = await p.select({
        message: 'Select a PR to review autonomously:',
        options: [
            ...prs.map(pr => ({
                value: pr.number,
                label: `[#\${pr.number}] \${pr.title} \${pc.dim('(by ' + pr.author.login + ')')}`
            })),
            { value: 'cancel', label: pc.dim('Cancel') }
        ]
    });

    if (p.isCancel(prChoice) || prChoice === 'cancel') return;

    s.start(`Fetching diff for PR #\${prChoice}...`);
    const { stdout: diffData, error: diffError } = await execAsync(`gh pr diff \${prChoice}`);
    
    if (diffError || !diffData) {
        s.stop(pc.red(`Failed to fetch diff for PR #\${prChoice}.`));
        return;
    }

    s.message(`Generating AI Review for PR #\${prChoice}...`);

    const config = loadConfig();
    const systemPrompt = `You are Rex Sentinel, an expert senior software engineer. Perform a detailed, constructive, and highly technical code review on the following git diff. Point out bugs, security issues, performance bottlenecks, and bad practices. If the code is perfect, say so, but usually there's room for improvement. Output in readable Markdown.`;
    
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the diff for PR #\${prChoice}:\n\n\`\`\`diff\n\${diffData.substring(0, 15000)}\n\`\`\`` }
    ];

    let reviewText = '';
    const isLocal = config.aiModel === 'local-llama' || config.aiModel === 'ollama';

    try {
        if (isLocal) {
            const { runCompletion } = await import('./ai.js');
            reviewText = await runCompletion(messages, null, 'high');
        } else {
            const { runCompletion } = await import('./ai.js');
            reviewText = await runCompletion(messages, null, 'high');
        }
        s.stop(pc.green(`Review completed for PR #\${prChoice}`));
        
        console.log('');
        p.note(reviewText, `Sentinel Review: PR #\${prChoice}`);

        const postChoice = await p.confirm({
            message: 'Would you like to post this review as a comment on the PR on GitHub?'
        });

        if (!p.isCancel(postChoice) && postChoice) {
            const tempFile = `.agent/tmp_pr_\${prChoice}_review.md`;
            const fs = await import('fs');
            const path = await import('path');
            const fullPath = path.join(process.cwd(), tempFile);
            
            // Ensure dir exists
            if (!fs.existsSync(path.dirname(fullPath))) {
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            }
            
            fs.writeFileSync(fullPath, reviewText);
            
            s.start('Publishing review to GitHub...');
            const { error: postError } = await execAsync(`gh pr comment \${prChoice} -F "\${fullPath}"`);
            
            if (postError) {
                s.stop(pc.red('Failed to publish review to GitHub.'));
                p.note(postError.message, 'Error');
            } else {
                s.stop(pc.green('Review successfully published to GitHub!'));
            }
            
            // Cleanup
            try { fs.unlinkSync(fullPath); } catch(e) {}
        }

    } catch (e) {
        s.stop(pc.red('AI Review failed.'));
        p.note(e.message, 'Sentinel Error');
    }
}
