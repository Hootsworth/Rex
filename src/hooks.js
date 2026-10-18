import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);
const theme = gradient(['#00008b', '#00ffff']);

export async function handleHooks(action) {
    if (action === 'install') {
        const s = p.spinner();
        s.start('Installing AI Git Commit Hook...');

        try {
            // Check if git repo
            if (!fs.existsSync('.git')) {
                s.stop('Not a git repository.');
                p.log.error('Please run this in a git repository.');
                return;
            }

            // Install husky
            await execPromise('npx husky-init');

            // Overwrite the pre-commit hook or create prepare-commit-msg
            const hookPath = '.husky/prepare-commit-msg';
            const hookScript = `#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

# Rex AI Commit Message Generator
rex ask-ai "Generate a concise git commit message for the following diff: $(git diff --staged)" --no-interactive > .git/COMMIT_EDITMSG
`;

            // For now, simpler approach: just use a Rex internal command or script
            // Let's write a dedicated hook script instead
            const rexHookScript = `#!/usr/bin/env node
import { execSync } from 'child_process';
import { runCompletion } from '${path.join(process.cwd(), 'src', 'ai.js')}';
import fs from 'fs';

async function generate() {
    try {
        const diff = execSync('git diff --staged').toString();
        if (!diff) return;
        const prompt = "Generate a concise, professional git commit message based on this diff. ONLY return the message text.\\n" + diff;
        const res = await runCompletion(prompt);
        fs.appendFileSync(process.argv[2], "\\n" + res.trim());
    } catch (e) {}
}
generate();
`;
            // Actually, let's keep it simple and just use Rex command if globally linked
            const simpleHook = `#!/usr/bin/env sh
# Rex AI Commit Hook
echo "REX: Analyzing diff..."
git diff --staged | rex ask-ai "Write a one-line professional git commit message for this diff. Just the message." > .git/COMMIT_MSG_TMP
# (This is just a conceptual hook, actual implementation needs to handle COMMIT_EDITMSG)
`;

            // REAL IMPLEMENTATION:
            // We'll create a script that husky calls
            fs.writeFileSync('.husky/prepare-commit-msg', `#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Run Rex-AI to suggest a commit message
# (Assuming 'rex-ai' is in the PATH)
rex-ai ask-ai "Summarize this git diff into a professional one-line commit message: $(git diff --staged --stat)" > .git/COMMIT_EDITMSG_SUGGESTION
echo "\\n# --- Rex-AI Suggested Message ---" >> $1
cat .git/COMMIT_EDITMSG_SUGGESTION >> $1
echo "# --------------------------------" >> $1
`, { mode: 0o755 });

            s.stop('AI Git Hook installed successfully!');
            p.log.success(theme('Husky prepare-commit-msg hook created.'));
            p.note('Now, every time you run "git commit", Rex will append a suggestion to your commit message buffer!', 'Rex Power Feature');

        } catch (err) {
            s.stop(pc.red('Hook installation failed.'));
            p.log.error(err.message);
        }
    } else if (action === 'remove') {
        const s = p.spinner();
        s.start('Removing AI Git Commit Hook...');
        try {
            if (fs.existsSync('.husky/prepare-commit-msg')) {
                fs.unlinkSync('.husky/prepare-commit-msg');
                s.stop('Hook removed.');
            } else {
                s.stop('No AI hook found.');
            }
        } catch (e) {
            s.stop(pc.red('Failed to remove hook.'));
        }
    }
}
