import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runCompletion } from './ai.js';
import { exec } from 'child_process';
import util from 'util';
import gradient from 'gradient-string';

const execPromise = util.promisify(exec);

export async function projectScaffold() {
    const prompt = await p.text({
        message: 'Describe down to the detail the project you want to create (e.g., "A Next.js 14 app with Tailwind CSS, TypeScript, and a src directory"):',
        validate: (val) => {
            if (val.trim() === '') return 'Please describe your project.';
        }
    });

    if (p.isCancel(prompt)) return;

    const directory = await p.text({
        message: 'Name of the output directory for this project:',
        initialValue: 'my-new-app'
    });

    if (p.isCancel(directory)) return;

    p.log.info(gradient('cyan', 'blue', 'magenta')(`Starting Agentic Scaffold for ./${directory}...`));

    const mode = await p.select({
        message: 'Select Execution Mode:',
        options: [
            { value: 'manual', label: '✋ Manual Approval (Step-by-Step)' },
            { value: 'auto', label: '🚀 Auto-Run (Agent Mode - Execute autonomously)' }
        ]
    });

    if (p.isCancel(mode)) return;

    let isAutoRun = mode === 'auto';
    let memory = [];
    let isFinished = false;

    while (!isFinished) {
        const s = p.spinner();
        s.start(isAutoRun ? 'Agent is working autonomously...' : 'Agent is calculating the next step...');

        const systemPrompt = `You are an autonomous expert developer agent scaffolding a project.
Target directory: "${directory}"
Goal: ${prompt}

Here is the memory of what you have executed so far and the output of those commands:
${memory.length > 0 ? memory.map(m => `COMMAND RUN: ${m.command}\nOUTPUT:\n${m.output}\n`).join('\n') : '(No commands run yet)'}

Based on the goal and the memory, determine the IMMEDIATE NEXT single terminal command to run.
RULES:
1. If you are certain of the command, ONLY return the raw command string to run. NO markdown. NO explanations.
2. If the command requires a directory change, include it in the same command string (e.g., cd ${directory} && npm install foo).
3. Use non-interactive flags (e.g., --yes) to avoid hanging the terminal.
4. If you determine the project scaffolding is completely finished, return exactly the string: [DONE]

CRITICAL: If the user request is ambiguous, or if a previous command failed and there are multiple wildly different ways to fix it, you MUST ask them to clarify by providing a multiple-choice JSON array.
Return EXACTLY THIS FORMAT if you need clarification:
[CLARIFY]
[
  {"label": "Use NPM", "command": "npm install..."},
  {"label": "Use Yarn", "command": "yarn add..."}
]`;

        let generatedCommand = '';
        let isClarifying = false;
        let clarificationOptions = [];

        try {
            const rawResponse = await runCompletion(systemPrompt, true);

            if (rawResponse.includes('[CLARIFY]')) {
                isClarifying = true;
                const jsonStr = rawResponse.replace('[CLARIFY]', '').trim();
                clarificationOptions = JSON.parse(jsonStr);
            } else {
                generatedCommand = rawResponse.replace(/```(bash|powershell|cmd)?\n?/gi, '').replace(/```/g, '').trim();
            }
        } catch (e) {
            s.stop(pc.red('Agent generation failed.'));
            p.log.error(e.message);
            break;
        }

        s.stop(isAutoRun ? 'Step calculated.' : 'Agent has decided the next step.');

        if (generatedCommand === '[DONE]') {
            p.log.success(pc.green(`🎉 Agent has completed scaffolding ./${directory}!`));
            isFinished = true;
            break;
        }

        if (isClarifying) {
            isAutoRun = false; // Always pause for clarification
            p.log.warn('The AI needs more context to proceed with scaffolding.');
            const choice = await p.select({
                message: 'Please choose the approach you prefer:',
                options: [...clarificationOptions.map((opt, i) => ({ value: i.toString(), label: opt.label })), { value: 'cancel', label: '❌ Cancel' }]
            });

            if (p.isCancel(choice) || choice === 'cancel') {
                p.log.warn('Agent scaffolding aborted.');
                break;
            }

            generatedCommand = clarificationOptions[parseInt(choice)].command;
            p.note(pc.cyan(generatedCommand), 'Selected Context Command');
        }

        if (!isAutoRun) {
            p.note(pc.cyan(generatedCommand), 'Next Executing Command');
            const shouldRun = await p.select({
                message: `Execute this step?`,
                options: [
                    { value: 'run', label: '🚀 Run Step' },
                    { value: 'auto', label: '🤖 Enable Auto-Run (Agent Mode)' },
                    { value: 'retry', label: '🔄 Ask AI to try a different approach' },
                    { value: 'abort', label: '❌ Abort Scaffolding' }
                ]
            });

            if (p.isCancel(shouldRun) || shouldRun === 'abort') {
                p.log.warn('Agent scaffolding aborted.');
                break;
            }

            if (shouldRun === 'auto') {
                isAutoRun = true;
            } else if (shouldRun === 'retry') {
                memory.push({ command: generatedCommand, output: 'USER REJECTED THIS COMMAND ASKING FOR AN ALTERNATIVE TRY.' });
                continue;
            }
        } else {
            p.log.info(pc.cyan(`⚡ Executing: ${generatedCommand}`));
        }

        s.start(`Executing...`);
        let stepOutput = '';
        try {
            const { stdout, stderr } = await execPromise(generatedCommand);
            s.stop(pc.green(`Step successful.`));
            stepOutput = stdout || 'Silence (Success)';
            if (stdout) p.log.info(pc.dim(stdout.substring(0, 300) + (stdout.length > 300 ? '...\n[Truncated]' : '')));
            if (stderr && !stderr.toLowerCase().includes('warn')) {
                // p.log.warn(pc.yellow(stderr.substring(0, 300) + (stderr.length > 300 ? '...\n[Truncated]' : '')));
                stepOutput += `\nSTDERR: ${stderr}`;
            }
        } catch (err) {
            s.stop(pc.red('Step failed!'));
            p.log.error(pc.red(err.message));
            stepOutput = `FAILED WITH ERROR: ${err.message}`;
            isAutoRun = false; // Stop auto-run on error
            p.log.info('Auto-Run paused due to error. Switch to manual mode for review.');
        }

        // Push to memory to feed back into loop
        memory.push({ command: generatedCommand, output: stepOutput.substring(0, 1000) });
    }
}
