import { simpleGit } from 'simple-git';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runCompletion } from './ai.js';
import gradient from 'gradient-string';

const git = simpleGit();

export async function quickGitPush() {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
        p.log.error(pc.red('Not a git repository. Please initialize git first.'));
        return;
    }

    // Check if there are changes
    const status = await git.status();
    if (status.isClean()) {
        p.log.info(pc.green('Working directory clean. No changes to commit.'));
        return;
    }

    const s = p.spinner();
    s.start('Staging all changes...');
    await git.add('.');
    s.stop('Changes staged.');

    const diff = await git.diffSummary();
    p.log.info(`Files changed: ${diff.changed}, Insertions: ${diff.insertions}, Deletions: ${diff.deletions}`);

    // Generate a commit message based on the diff using AI.
    const rawDiff = await git.diff(['--staged']);

    let suggestedMessage = 'Update files';
    if (rawDiff.length > 0) {
        s.start('Generating commit message suggestion using AI...');
        try {
            const aiPrompt = `Write a concise and professional git commit message for the following diff:\n\n${rawDiff.substring(0, 3000)}\n\nOnly reply with the commit message, no explanation.`;
            const suggestion = await runCompletion(aiPrompt, true); // true = raw response
            suggestedMessage = suggestion.trim() || suggestedMessage;
            p.note(gradient.pastel.multiline(suggestedMessage), 'AI Generated Note');
        } catch (e) {
            p.log.warn(pc.yellow('Could not generate AI suggestion, using default.'));
        }
        s.stop('Suggestion generated.');
    }

    const finalMessage = await p.text({
        message: 'Enter commit message:',
        initialValue: suggestedMessage,
        validate: (val) => {
            if (val.trim() === '') return 'Commit message is required';
        }
    });

    if (p.isCancel(finalMessage)) {
        p.log.warn('Commit cancelled.');
        return;
    }

    s.start(`Committing: ${finalMessage}`);
    await git.commit(finalMessage);
    s.stop('Committed.');

    const shouldPush = await p.confirm({
        message: 'Do you want to push to the remote repository?',
        initialValue: true
    });

    if (p.isCancel(shouldPush)) {
        p.log.warn('Push cancelled.');
        return;
    }

    if (shouldPush) {
        try {
            const remotes = await git.getRemotes();
            if (remotes.length === 0) {
                p.log.error(pc.red('No remotes found. Please add a remote.'));
                return;
            }

            s.start('Pushing to remote...');
            await git.push();
            s.stop(pc.green('Successfully pushed to remote!'));
        } catch (e) {
            s.stop(pc.red('Push failed!'));
            p.log.error(`Error: ${e.message}`);
            p.log.info('You may need to sign in or set upstream branch.');
        }
    }
}
