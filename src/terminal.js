import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { runCompletion } from './ai.js';
import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import { loadConfig } from './config.js';
import { validateCommandPolicy } from './commandPolicy.js';

import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);

/**
 * Gathers context about the current project to help the AI be "smarter".
 */
async function getProjectContext() {
    const context = {
        platform: os.platform(),
        cwd: process.cwd(),
        files: [],
        dependencies: {}
    };

    try {
        // Get top-level files
        context.files = fs.readdirSync(process.cwd()).slice(0, 20);

        // Try to read package.json
        const pkgPath = path.join(process.cwd(), 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            context.projectName = pkg.name;
            context.dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
        }
    } catch (e) {
        // Silently fail, context is optional
    }

    return context;
}

export async function aiTerminalCommand() {
    const config = loadConfig();
    const s = p.spinner();
    const prompt = await p.text({
        message: 'What do you want the terminal to do? (e.g., "find all open ports")',
        validate: (val) => {
            if (val.trim() === '') return 'Input is required';
        }
    });

    if (p.isCancel(prompt)) {
        p.log.warn('Operation cancelled.');
        return;
    }

    let executedCommand = false;
    let memoryOptions = '';

    while (!executedCommand) {
        s.start('Generating command...');

        let aiPrompt = `You are a terminal command generator. 
OS: ${os.platform()} (${os.release()})
Goal: ${prompt}

If you are 100% confident in the command required, provide ONLY the exact raw terminal command. Do not provide markdown formatting, backticks, or explanations. Just the command string itself.

If the user's request is ambiguous or there are multiple wildly different ways to achieve this (e.g. they want to find a file but didn't say if they prefer powershell or cmd on Windows, or asking to install something but didn't specify npm vs yarn), then you MUST ask them to clarify by providing a multiple-choice JSON array of options.
Return EXACTLY THIS FORMAT if you need clarification:
[CLARIFY]
[
  {"label": "Use PowerShell (Recommended)", "command": "Get-ChildItem..."},
  {"label": "Use standard CMD", "command": "dir /s..."}
]`;
        if (memoryOptions) aiPrompt += `\n\nPrevious clarification provided: ${memoryOptions}\n`;

        let generatedCommand = '';
        let isClarifying = false;
        let clarificationOptions = [];

        try {
            const rawResponse = await runCompletion(aiPrompt, null, 'high');

            if (rawResponse.includes('[CLARIFY]')) {
                isClarifying = true;
                const jsonStr = rawResponse.replace('[CLARIFY]', '').trim();
                clarificationOptions = JSON.parse(jsonStr);
            } else {
                generatedCommand = rawResponse.replace(/```(bash|powershell|cmd)?\n?/gi, '').replace(/```/g, '').trim();
            }
        } catch (e) {
            s.stop(pc.red('Generation failed.'));
            p.log.error(e.message);
            return;
        }

        s.stop('Command generated.');

        if (isClarifying) {
            p.log.warn('The AI needs more context to generate the best command.');
            const choice = await p.select({
                message: 'Please choose the approach you prefer:',
                options: [...clarificationOptions.map((opt, i) => ({ value: i.toString(), label: opt.label })), { value: 'cancel', label: '❌ Cancel' }]
            });

            if (p.isCancel(choice) || choice === 'cancel') return;

            generatedCommand = clarificationOptions[parseInt(choice)].command;
            p.note(gradient.pastel.multiline(generatedCommand), 'Selected Command');
        } else {
            p.note(gradient.pastel.multiline(generatedCommand), 'Suggested Command');
        }

        const action = await p.select({
            message: 'What would you like to do?',
            options: [
                { value: 'run', label: '🚀 Run command immediately' },
                { value: 'explain', label: '📖 Explain command' },
                { value: 'copy', label: '📋 Print to copy' },
                { value: 'retry', label: '🔄 Ask AI for a different approach' },
                { value: 'cancel', label: '❌ Cancel' }
            ]
        });

        if (p.isCancel(action) || action === 'cancel') return;

        if (action === 'retry') {
            memoryOptions = "User rejected the previous command. Try an alternative method.";
            continue;
        }

        if (action === 'explain') {
            s.start('Generating explanation...');
            try {
                const explPrompt = `Briefly explain what this command does:\n${generatedCommand}`;
                const explanation = await runCompletion(explPrompt, null, 'high');
                s.stop('Explanation generated.');
                p.note(gradient.pastel.multiline(explanation), 'Explanation');
            } catch (e) {
                s.stop(pc.red('Failed to explain.'));
            }

            const runAfter = await p.confirm({ message: 'Do you want to run it now?' });
            if (!runAfter || p.isCancel(runAfter)) return;
        }

        if (action === 'copy') {
            p.log.info(pc.cyan(`\n${generatedCommand}\n`));
            return;
        }

        // Run action
        try {
            // Intentional: AI terminal mode is policy-guarded but not strict-safe-mode-only.
            const policy = validateCommandPolicy(generatedCommand, { enforceSafeMode: false });
            if (!policy.safe) {
                p.log.error(`Blocked by command policy: ${policy.reason}`);
                memoryOptions = `The previous command was blocked by policy (${policy.reason}). Provide a safer alternative.`;
                continue;
            }

            s.start(`Executing: ${pc.cyan(generatedCommand)}`);
            const { stdout, stderr } = await execPromise(generatedCommand);
            s.stop(pc.green('Execution complete.'));
            executedCommand = true;
            if (stdout) p.log.info(`\n${stdout}`);
            if (stderr && !stderr.toLowerCase().includes('warn')) p.log.warn(`\n${stderr}`);
        } catch (err) {
            s.stop(pc.red('Execution failed.'));
            p.log.error(`\n${err.message}`);

            const errorAction = await p.select({
                message: 'The command failed. What now?',
                options: [
                    { value: 'retry', label: '🔄 Send error to AI and try again' },
                    { value: 'cancel', label: '❌ Cancel' }
                ]
            });

            if (errorAction === 'retry') {
                memoryOptions = `The previous command failed with error: ${err.message}. Provide a multiple choice option of alternative fixes.`;
            } else {
                return;
            }
        }
    }

}

export async function runWithHealing(cmdString) {
    const s = p.spinner();
    let stdout = '';
    let stderr = '';
    try {
        // Intentional: healing flow allows broader commands while still enforcing dangerous-pattern policy.
        const policy = validateCommandPolicy(cmdString, { enforceSafeMode: false });
        if (!policy.safe) {
            s.stop(pc.red('Command blocked by policy.'));
            console.error(pc.dim(policy.reason));
            return;
        }

        s.start(`Running: ${pc.cyan(cmdString)}`);
        const result = await execPromise(cmdString);
        stdout = result.stdout || '';
        stderr = result.stderr || '';
        s.stop(pc.green('Command succeeded.'));
        if (stdout) console.log(stdout);
        if (stderr) console.warn(stderr);
    } catch (err) {
        s.stop(pc.red('Command failed.'));
        console.error(pc.dim(err.message));

        const heal = await p.confirm({
            message: 'I detected a failure. Should Rex-AI analyze and attempt to heal this?',
            initialValue: true
        });

        if (heal) {
            const { analyzeError } = await import('./ai.js');
            s.start('Rex is gathering project context...');
            const projectContext = await getProjectContext();
            
            s.start('Rex is diagnosing the issue...');
            try {
                // Combine stdout and stderr for full context, truncated if necessary
                const fullOutput = `STDOUT:\n${stdout.slice(-1000)}\n\nSTDERR:\n${stderr.slice(-1000)}\n\nERROR_MSG:\n${err.message}`;
                
                const diagnosis = await analyzeError(cmdString, fullOutput, projectContext);
                s.stop('Diagnosis complete.');

                p.note(pc.yellow(diagnosis.explanation), 'Rex Diagnosis');
                
                const applyFix = await p.confirm({
                    message: `Apply fix: ${pc.cyan(diagnosis.fixCommand)}?`,
                    initialValue: true
                });

                if (applyFix) {
                    await runWithHealing(diagnosis.fixCommand);
                    
                    const retry = await p.confirm({
                        message: 'Fix applied! Would you like to retry the original command?',
                        initialValue: true
                    });

                    if (retry) {
                        await runWithHealing(cmdString);
                    }
                }
            } catch (e) {
                s.stop(pc.red('Healing failed.'));
                p.log.error(e.message);
            }
        }
    }
}
