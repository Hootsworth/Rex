import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import Table from 'cli-table3';
import { runCompletion } from './ai.js';

const execPromise = util.promisify(exec);
const theme = gradient(['#00008b', '#00ffff']);

function extractAuditJson(output = '') {
    const text = String(output || '');
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
        return null;
    }
}

export async function projectHealth() {
    const s = p.spinner();
    s.start('Analyzing project health...');

    try {
        let repoStatus = 'N/A';
        let vulnerabilities = 'N/A';
        let fileCount = 0;
        let totalLines = 0;

        // 1. Git Status
        try {
            const { stdout: gitStatus } = await execPromise('git status --short');
            repoStatus = gitStatus.trim() ? pc.yellow('Modified ⚠️') : pc.green('Clean ✅');
        } catch (e) {
            repoStatus = pc.dim('Not a git repository');
        }

        // 2. NPM Audit
        if (fs.existsSync('package.json')) {
            try {
                const { stdout: auditOut } = await execPromise('npm audit --json');
                const audit = extractAuditJson(auditOut);
                const totalVulns = Number(audit?.metadata?.vulnerabilities?.total || 0);
                vulnerabilities = totalVulns > 0 ? pc.red(`${totalVulns} found ❌`) : pc.green('0 found ✅');
            } catch (e) {
                // npm audit returns non-zero when vulnerabilities are found, so parse output from both streams.
                const audit = extractAuditJson(`${e?.stdout || ''}\n${e?.stderr || ''}`);
                if (audit?.metadata?.vulnerabilities) {
                    const totalVulns = Number(audit.metadata.vulnerabilities.total || 0);
                    vulnerabilities = totalVulns > 0 ? pc.red(`${totalVulns} found ❌`) : pc.green('0 found ✅');
                } else {
                    vulnerabilities = pc.dim('Audit failed or not applicable');
                }
            }
        } else {
            vulnerabilities = pc.dim('No package.json');
        }

        // 3. Simple LOC scan
        const walk = (dir) => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (file === 'node_modules' || file.startsWith('.')) continue;
                const fullPath = path.join(dir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    walk(fullPath);
                } else if (['.js', '.ts', '.py', '.go', '.html', '.css', '.json'].includes(path.extname(fullPath))) {
                    fileCount++;
                    totalLines += fs.readFileSync(fullPath, 'utf8').split('\n').length;
                }
            }
        };
        try { walk('.'); } catch (e) { }

        // 4. AI Code Quality Assessment (Brief)
        let aiScore = 'Calculating...';
        try {
            const files = fs.readdirSync('.').filter(f => f.endsWith('.js') || f.endsWith('.ts')).slice(0, 3);
            let contentStr = '';
            for (const f of files) {
                contentStr += fs.readFileSync(f, 'utf8').substring(0, 1000);
            }
            const prompt = `Assess the overall code quality, architecture, and complexity of this project snippet. Give a score out of 100 and a 1-sentence summary. Format: SCORE: [num] | SUMMARY: [text] \n\n${contentStr}`;
            const aiRes = await runCompletion(prompt, false);
            aiScore = aiRes.trim();
        } catch (e) {
            aiScore = 'AI assessment skipped.';
        }

        s.stop('Analysis complete.');

        const table = new Table({
            head: [theme('Metric'), theme('Status/Value')],
            colWidths: [25, 50],
            wordWrap: true
        });

        table.push(
            ['Repository Status', repoStatus],
            ['Vulnerabilities', vulnerabilities],
            ['Source Files', fileCount],
            ['Total Lines', totalLines],
            ['AI Assessment', aiScore]
        );

        console.log('\n' + table.toString() + '\n');

        p.note(theme('Tip: Use "rexai review" for a deeper dive into code quality.'), 'Rex Premium');

    } catch (err) {
        s.stop(pc.red('Health check failed.'));
        p.log.error(err.message);
    }
}
