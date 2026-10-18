import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import Table from 'cli-table3';
import { simpleGit } from 'simple-git';
import { runCompletion } from './ai.js';

const theme = gradient(['#0ea5e9', '#22d3ee', '#14b8a6']);

function commandFor(bin) {
    return bin;
}

function runCommand(bin, args = [], options = {}) {
    const timeoutMs = Number(options.timeoutMs || 120000);
    const cwd = options.cwd || process.cwd();

    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const child = spawn(commandFor(bin), args, {
            cwd,
            shell: process.platform === 'win32',
            windowsHide: true,
            env: process.env,
        });

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            } catch {
                // ignore
            }
        }, timeoutMs);

        child.stdout.on('data', (d) => {
            stdout += d.toString();
        });

        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ ok: false, code: -1, stdout, stderr: err.message, timedOut: false });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: !timedOut && code === 0, code: timedOut ? -1 : code, stdout, stderr, timedOut });
        });
    });
}

function parseAuditJson(output = '') {
    const text = String(output || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

function safeWriteFile(targetPath, content) {
    const resolved = path.resolve(targetPath);
    const cwd = path.resolve(process.cwd());
    const resolvedCmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const cwdCmp = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
    const cwdWithSep = cwdCmp.endsWith(path.sep) ? cwdCmp : `${cwdCmp}${path.sep}`;
    const inWorkspace = resolvedCmp === cwdCmp || resolvedCmp.startsWith(cwdWithSep);
    if (!inWorkspace) {
        throw new Error(`Refusing to write outside workspace: ${targetPath}`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
}

function inferProjectSignals(cwd) {
    const pkgPath = path.join(cwd, 'package.json');
    const signals = {
        hasGit: fs.existsSync(path.join(cwd, '.git')),
        hasPackageJson: fs.existsSync(pkgPath),
        hasReadme: fs.existsSync(path.join(cwd, 'README.md')),
        hasEnv: fs.existsSync(path.join(cwd, '.env')),
        hasEnvExample: fs.existsSync(path.join(cwd, '.env.example')),
        hasGithubWorkflows: fs.existsSync(path.join(cwd, '.github', 'workflows')),
        hasDockerfile: fs.existsSync(path.join(cwd, 'Dockerfile')),
        hasNodeModules: fs.existsSync(path.join(cwd, 'node_modules')),
    };

    let pkg = null;
    if (signals.hasPackageJson) {
        try {
            pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch {
            pkg = null;
        }
    }

    const scripts = pkg?.scripts || {};
    return {
        signals,
        pkg,
        scripts,
    };
}

function createReadmeTemplate(projectName, scripts) {
    const commands = Object.keys(scripts || {}).slice(0, 6);
    const commandBlock = commands.length
        ? commands.map((name) => `- \`npm run ${name}\``).join('\n')
        : '- Add scripts to package.json to document runnable tasks.';

    return `# ${projectName || 'Project'}\n\n## Overview\nA production-oriented project managed with RexAI Doctor baseline standards.\n\n## Setup\n1. Install dependencies: \`npm install\`\n2. Run local development command (if available): \`npm run dev\`\n\n## Quality Gates\n${commandBlock}\n\n## Security Notes\n- Keep secrets in \`.env\` and commit only \`.env.example\`.\n- Run \`npm audit\` before releases.\n`;
}

function createNodeCiWorkflow(hasTest, hasLint, hasBuild) {
    const steps = [
        '      - name: Checkout',
        '        uses: actions/checkout@v4',
        '      - name: Setup Node',
        '        uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '20'",
        "          cache: 'npm'",
        '      - name: Install dependencies',
        '        run: npm ci',
    ];

    if (hasLint) {
        steps.push('      - name: Lint', '        run: npm run lint --if-present');
    }
    if (hasBuild) {
        steps.push('      - name: Build', '        run: npm run build --if-present');
    }
    if (hasTest) {
        steps.push('      - name: Test', '        run: npm test --if-present');
    }

    return `name: CI\n\non:\n  push:\n    branches: [main, master]\n  pull_request:\n\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n${steps.join('\n')}\n`;
}

async function collectDiagnostics(cwd, scripts) {
    const findings = [];
    const checks = [];

    const git = simpleGit({ baseDir: cwd });
    let isRepo = false;
    try {
        isRepo = await git.checkIsRepo();
    } catch {
        isRepo = false;
    }

    if (isRepo) {
        const status = await git.status();
        checks.push({ name: 'Git Repository', status: 'ok', details: status.isClean() ? 'clean working tree' : 'changes present' });
        if (!status.isClean()) {
            findings.push({
                severity: 'low',
                code: 'git_dirty',
                title: 'Working tree has uncommitted changes',
                details: `modified:${status.modified.length}, created:${status.created.length}, deleted:${status.deleted.length}`,
                fixType: null,
            });
        }
    } else {
        checks.push({ name: 'Git Repository', status: 'warn', details: 'not a git repository' });
        findings.push({
            severity: 'medium',
            code: 'git_missing',
            title: 'Repository is not initialized with git',
            details: 'Initialize git to enable reliable workflows, reviews, and releases.',
            fixType: null,
        });
    }

    if (fs.existsSync(path.join(cwd, 'package.json'))) {
        const auditResult = await runCommand('npm', ['audit', '--json'], { cwd, timeoutMs: 180000 });
        const auditJson = parseAuditJson(`${auditResult.stdout}\n${auditResult.stderr}`);
        const total = Number(auditJson?.metadata?.vulnerabilities?.total || 0);
        checks.push({
            name: 'Dependency Audit',
            status: total > 0 ? 'warn' : 'ok',
            details: total > 0 ? `${total} vulnerabilities` : 'no known vulnerabilities',
        });
        if (total > 0) {
            findings.push({
                severity: total >= 5 ? 'high' : 'medium',
                code: 'npm_audit_vulns',
                title: 'Dependency vulnerabilities detected',
                details: `${total} vulnerabilities reported by npm audit.`,
                fixType: null,
            });
        }

        const outdatedResult = await runCommand('npm', ['outdated', '--json'], { cwd, timeoutMs: 120000 });
        let outdatedCount = 0;
        try {
            const parsed = JSON.parse(outdatedResult.stdout || outdatedResult.stderr || '{}');
            outdatedCount = Object.keys(parsed || {}).length;
        } catch {
            outdatedCount = 0;
        }
        checks.push({
            name: 'Outdated Packages',
            status: outdatedCount > 0 ? 'warn' : 'ok',
            details: outdatedCount > 0 ? `${outdatedCount} outdated` : 'up to date',
        });
        if (outdatedCount > 0) {
            findings.push({
                severity: 'low',
                code: 'npm_outdated',
                title: 'Packages are outdated',
                details: `${outdatedCount} packages can be updated after compatibility checks.`,
                fixType: null,
            });
        }
    } else {
        checks.push({ name: 'Dependency Audit', status: 'skip', details: 'package.json not found' });
    }

    const hasTests = Boolean(scripts.test);
    const hasLint = Boolean(scripts.lint);
    const hasBuild = Boolean(scripts.build);
    checks.push({ name: 'Quality Scripts', status: hasTests || hasLint || hasBuild ? 'ok' : 'warn', details: `test:${hasTests} lint:${hasLint} build:${hasBuild}` });

    if (!hasTests) {
        findings.push({
            severity: 'medium',
            code: 'missing_test_script',
            title: 'No test script configured',
            details: 'Add a reliable test script to enforce regression checks.',
            fixType: null,
        });
    }

    return { findings, checks };
}

function renderChecksTable(checks) {
    const table = new Table({
        head: [theme('Check'), theme('Status'), theme('Details')],
        colWidths: [28, 14, 56],
        wordWrap: true,
    });

    for (const check of checks) {
        const statusLabel = check.status === 'ok'
            ? pc.green('OK')
            : check.status === 'warn'
                ? pc.yellow('WARN')
                : pc.dim('SKIP');
        table.push([check.name, statusLabel, check.details || '']);
    }

    console.log(`\n${table.toString()}\n`);
}

function renderFindings(findings) {
    if (!findings.length) {
        p.log.success(pc.green('No significant issues detected by doctor checks.'));
        return;
    }

    p.note(
        findings
            .map((f, idx) => `${idx + 1}. [${f.severity.toUpperCase()}] ${f.title}\n   ${pc.dim(f.details)}`)
            .join('\n'),
        'Doctor Findings'
    );
}

async function maybeRunAiRecommendation(findings, checks, shouldUseAi) {
    if (!shouldUseAi) return null;

    const constrainedPayload = {
        findings: findings.map((f) => ({ severity: f.severity, code: f.code, title: f.title, details: f.details })),
        checks: checks.map((c) => ({ name: c.name, status: c.status, details: c.details })),
    };

    const prompt = [
        'You are a senior staff engineer.',
        'Given this diagnostics JSON, provide a concise remediation plan with exactly 3 sections:',
        '1) Immediate (today)',
        '2) Next sprint',
        '3) Deferred risks',
        'Keep each section max 3 bullets, avoid generic wording, no markdown table.',
        JSON.stringify(constrainedPayload),
    ].join('\n\n');

    try {
        const res = await runCompletion(prompt, null, 'low');
        return String(res || '').trim();
    } catch (err) {
        return `AI recommendation skipped: ${err.message}`;
    }
}

async function applySafeFixes(cwd, pkg, scripts) {
    const applied = [];

    const projectName = pkg?.name || path.basename(cwd);
    const readmePath = path.join(cwd, 'README.md');
    if (!fs.existsSync(readmePath)) {
        safeWriteFile(readmePath, createReadmeTemplate(projectName, scripts));
        applied.push('Created README.md baseline');
    }

    const envPath = path.join(cwd, '.env');
    const envExamplePath = path.join(cwd, '.env.example');
    if (fs.existsSync(envPath) && !fs.existsSync(envExamplePath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const redacted = content
            .split(/\r?\n/)
            .map((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return line;
                const key = trimmed.split('=')[0];
                return `${key}=REPLACE_ME`;
            })
            .join('\n');
        safeWriteFile(envExamplePath, redacted + '\n');
        applied.push('Generated .env.example with placeholder values');
    }

    const workflowPath = path.join(cwd, '.github', 'workflows', 'ci.yml');
    if (!fs.existsSync(workflowPath) && pkg) {
        const ci = createNodeCiWorkflow(Boolean(scripts.test), Boolean(scripts.lint), Boolean(scripts.build));
        safeWriteFile(workflowPath, ci);
        applied.push('Created .github/workflows/ci.yml');
    }

    return applied;
}

async function runVerification(cwd, scripts) {
    const steps = [];
    const verificationScripts = ['lint', 'test', 'build'].filter((name) => Boolean(scripts[name]));

    for (const scriptName of verificationScripts) {
        const res = await runCommand('npm', ['run', scriptName, '--if-present'], { cwd, timeoutMs: 300000 });
        steps.push({
            name: `npm run ${scriptName}`,
            ok: res.ok,
            code: res.code,
            output: (res.stdout || res.stderr || '').slice(-800),
        });
    }

    return steps;
}

async function maybeCreateCommit(appliedFixes, useAiCommitMessage) {
    if (!appliedFixes.length) return null;

    const git = simpleGit();
    let isRepo = false;
    try {
        isRepo = await git.checkIsRepo();
    } catch {
        isRepo = false;
    }

    if (!isRepo) return 'Skipped commit: not a git repository.';

    const candidates = ['README.md', '.env.example', '.github/workflows/ci.yml']
        .filter((rel) => fs.existsSync(path.join(process.cwd(), rel)));

    if (!candidates.length) {
        return 'Skipped commit: no doctor-managed files were found to stage.';
    }

    await git.add(candidates);

    let msg = 'chore(doctor): apply safe baseline repository fixes';
    if (useAiCommitMessage) {
        try {
            const diff = await git.diff(['--staged']);
            const prompt = `Write one professional conventional-commit message for this diff. Keep it under 72 chars. Return only the message.\n\n${diff.slice(0, 2000)}`;
            const aiMsg = await runCompletion(prompt, null, 'low');
            const trimmed = String(aiMsg || '').trim();
            if (trimmed) msg = trimmed.split('\n')[0].slice(0, 72);
        } catch {
            // fall back to deterministic message
        }
    }

    await git.commit(msg);
    return `Created commit: ${msg}`;
}

export async function runDoctor(options = {}) {
    const cwd = process.cwd();
    const s = p.spinner();

    const useAi = Boolean(options.ai);
    const applySafe = Boolean(options.applySafe);
    const verify = Boolean(options.verify);
    const assumeYes = Boolean(options.yes);
    const autoCommit = Boolean(options.commit);

    p.intro(theme('RexAI Doctor - Secure Project Diagnosis'));
    p.note(
        [
            `Mode: ${pc.bold('read-first')} (no writes unless approved)`,
            `AI: ${useAi ? pc.green('enabled (minimal structured context)') : pc.dim('disabled')}`,
        ].join('\n'),
        'Safety Profile'
    );

    const { signals, pkg, scripts } = inferProjectSignals(cwd);

    s.start('Running project diagnostics...');
    const { findings, checks } = await collectDiagnostics(cwd, scripts);
    s.stop('Diagnostics complete.');

    renderChecksTable(checks);
    renderFindings(findings);

    const aiPlan = await maybeRunAiRecommendation(findings, checks, useAi);
    if (aiPlan) {
        p.note(aiPlan, 'AI Recommendation');
    }

    const report = {
        timestamp: new Date().toISOString(),
        cwd,
        safety: { useAi, applySafeRequested: applySafe, verifyRequested: verify, autoCommitRequested: autoCommit },
        projectSignals: signals,
        checks,
        findings,
    };

    const reportPath = path.join(cwd, '.rex', 'doctor-last-report.json');
    safeWriteFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    p.log.info(pc.dim(`Report saved: ${reportPath}`));

    let shouldApply = applySafe;
    if (!applySafe && !assumeYes) {
        shouldApply = await p.confirm({
            message: 'Apply safe baseline fixes (README, .env.example, CI workflow) if missing?',
            initialValue: false,
        });
        if (p.isCancel(shouldApply)) shouldApply = false;
    }

    let appliedFixes = [];
    if (shouldApply) {
        s.start('Applying safe fixes...');
        appliedFixes = await applySafeFixes(cwd, pkg, scripts);
        s.stop('Safe fix phase complete.');

        if (!appliedFixes.length) {
            p.log.info(pc.dim('No safe fixes were needed.'));
        } else {
            p.note(appliedFixes.map((f) => `- ${f}`).join('\n'), 'Applied Fixes');
        }
    }

    let shouldVerify = verify;
    if (!verify && !assumeYes) {
        shouldVerify = await p.confirm({
            message: 'Run verification scripts (lint/test/build) where available?',
            initialValue: true,
        });
        if (p.isCancel(shouldVerify)) shouldVerify = false;
    }

    if (shouldVerify) {
        s.start('Running verification scripts...');
        const verification = await runVerification(cwd, scripts);
        s.stop('Verification complete.');

        if (!verification.length) {
            p.log.info(pc.dim('No verification scripts configured in package.json.'));
        } else {
            const table = new Table({ head: [theme('Step'), theme('Result'), theme('Exit')], colWidths: [36, 16, 10] });
            for (const step of verification) {
                table.push([step.name, step.ok ? pc.green('PASS') : pc.red('FAIL'), String(step.code)]);
            }
            console.log(`\n${table.toString()}\n`);

            const failed = verification.filter((v) => !v.ok);
            if (failed.length) {
                p.note(failed.map((f) => `- ${f.name}: ${f.output || 'no output captured'}`).join('\n'), 'Verification Failures');
            }
        }
    }

    if (autoCommit && appliedFixes.length) {
        if (!assumeYes) {
            const okCommit = await p.confirm({ message: 'Create a local commit for applied safe fixes?', initialValue: false });
            if (!p.isCancel(okCommit) && okCommit) {
                const commitRes = await maybeCreateCommit(appliedFixes, useAi);
                if (commitRes) p.log.info(commitRes);
            }
        } else {
            const commitRes = await maybeCreateCommit(appliedFixes, useAi);
            if (commitRes) p.log.info(commitRes);
        }
    }

    p.outro(theme('Doctor run completed. Review findings before risky upgrades.'));
}
