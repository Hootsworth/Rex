import { program } from 'commander';
import { runCompletion } from './ai.js';
import pc from 'picocolors';

program
    .name('rex-ci')
    .description('Rex CI/CD Ghost Reviewer')
    .requiredOption('--repo <name>', 'GitHub repository name (e.g. owner/repo)')
    .requiredOption('--pr <number>', 'Pull Request number')
    .option('--token <token>', 'GitHub PAT (defaults to GITHUB_TOKEN env var)', process.env.GITHUB_TOKEN)
    .parse(process.argv);

const options = program.opts();

async function fetchPrDiff(repo, pr, token) {
    const url = `https://api.github.com/repos/${repo}/pulls/${pr}`;
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3.diff',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch PR diff: ${res.statusText}`);
    }

    return await res.text();
}

async function postReviewComment(repo, pr, token, comment) {
    const url = `https://api.github.com/repos/${repo}/issues/${pr}/comments`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ body: comment })
    });

    if (!res.ok) {
        throw new Error(`Failed to post comment: ${res.statusText}`);
    }
}

async function runGhostReviewer() {
    console.log(pc.cyan(`👻 Starting Rex Ghost Reviewer for ${options.repo}#${options.pr}...`));

    if (!options.token) {
        console.error(pc.red('Error: GitHub token is required (--token or GITHUB_TOKEN)'));
        process.exit(1);
    }

    try {
        console.log(pc.dim('Fetching PR diff...'));
        const diff = await fetchPrDiff(options.repo, options.pr, options.token);
        
        if (!diff || diff.trim().length === 0) {
            console.log(pc.yellow('No changes found in the PR diff.'));
            process.exit(0);
        }

        console.log(pc.dim(`Received diff (${diff.length} characters). Analyzing...`));
        
        const prompt = `You are an expert Senior Software Engineer acting as a CI/CD Ghost Reviewer.
Review the following Pull Request diff and provide a constructive, thorough code review. 
Focus on:
1. Potential bugs or edge cases
2. Performance/security issues
3. Code clarity and best practices

Keep your response in Markdown format, specifically tailored as a GitHub PR comment. Be polite but extremely rigorous. Do not emit filler text, just the review.

Diff:
\`\`\`diff
${diff}
\`\`\`
`;

        const reviewContent = await runCompletion(prompt, false);
        
        console.log(pc.dim('Analysis complete. Posting review...'));
        
        const commentBody = `👽 **Rex Ghost Reviewer**\n\n${reviewContent}`;
        await postReviewComment(options.repo, options.pr, options.token, commentBody);
        
        console.log(pc.green('✅ Review posted successfully!'));
    } catch (err) {
        console.error(pc.red(`Ghost Reviewer failed: ${err.message}`));
        process.exit(1);
    }
}

runGhostReviewer();
