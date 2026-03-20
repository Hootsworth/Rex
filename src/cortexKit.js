import fs from 'fs';
import path from 'path';

const HINDSIGHT_DIR = () => path.join(process.cwd(), '.agent', 'hindsight');
const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

/**
 * hindsight — Rex auto-saves a retrospective after completing a task.
 * Stores structured lessons in .agent/hindsight/<name>.md
 */
export async function hindsight(args) {
    const { taskName, whatWorked, whatFailed, lessonsLearned } = args;
    if (!taskName) return 'Error: hindsight requires a "taskName".';

    try {
        ensureDir(HINDSIGHT_DIR());
        const safeName = taskName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
        const filePath = path.join(HINDSIGHT_DIR(), `${safeName}.md`);
        const timestamp = new Date().toISOString().split('T')[0];

        const content = `# Hindsight: ${taskName}
_Recorded: ${timestamp}_

## What Worked
${whatWorked || 'N/A'}

## What Failed
${whatFailed || 'N/A'}

## Lessons Learned
${lessonsLearned || 'N/A'}
`;
        fs.writeFileSync(filePath, content, 'utf-8');
        return `Hindsight saved to ${filePath}`;
    } catch (e) {
        return `Hindsight error: ${e.message}`;
    }
}

/**
 * echo_chamber — Rex asks itself a verification question about its own output
 * and self-scores the answer (0-10). Low scores trigger a rethink.
 */
export async function echo_chamber(args) {
    const { claim, evidence } = args;
    if (!claim) return 'Error: echo_chamber requires a "claim" to verify.';

    try {
        const { runCompletion } = await import('./ai.js');
        const prompt = `You are a strict fact-checker. Score the following claim on a scale of 0-10 based on the provided evidence.
0 = completely unsupported/wrong, 10 = perfectly supported.

CLAIM: ${claim}
EVIDENCE: ${evidence || 'No evidence provided.'}

Respond ONLY with a JSON object: {"score": <number>, "reasoning": "<brief explanation>"}`;

        const raw = await runCompletion(prompt, false);
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            const score = Number(parsed.score || 0);
            if (score <= 4) {
                return `⚠️ Echo Chamber ALERT (Score: ${score}/10): "${parsed.reasoning}". Rex should rethink this claim.`;
            }
            return `✅ Echo Chamber (Score: ${score}/10): "${parsed.reasoning}"`;
        }
        return `Echo Chamber raw response: ${raw.slice(0, 300)}`;
    } catch (e) {
        return `Echo Chamber error: ${e.message}`;
    }
}

/**
 * déjà_vu — Before starting a task, Rex searches .agent/hindsight/
 * for similar past tasks and pre-loads lessons learned into context.
 */
export async function deja_vu(args) {
    const { query } = args;
    if (!query) return 'Error: déjà_vu requires a "query" to search past lessons.';

    try {
        const dir = HINDSIGHT_DIR();
        if (!fs.existsSync(dir)) return 'No past hindsight records found. This is a fresh start.';

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
        if (files.length === 0) return 'No past hindsight records found.';

        const queryLower = query.toLowerCase();
        const matches = [];

        for (const file of files) {
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            const contentLower = content.toLowerCase();
            const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);
            const hitCount = queryWords.filter(w => contentLower.includes(w)).length;

            if (hitCount >= 1) {
                matches.push({ file, hitCount, excerpt: content.slice(0, 400) });
            }
        }

        if (matches.length === 0) return 'No relevant hindsight records found for this query.';

        matches.sort((a, b) => b.hitCount - a.hitCount);
        const top = matches.slice(0, 3);
        const summaries = top.map(m => `--- ${m.file} (${m.hitCount} keyword hits) ---\n${m.excerpt}`).join('\n\n');
        return `🔮 Déjà Vu: Found ${matches.length} relevant past experience(s):\n\n${summaries}`;
    } catch (e) {
        return `Déjà Vu error: ${e.message}`;
    }
}

/**
 * nerve_map — Generates a dependency/relationship graph of the current project.
 * Returns structured JSON showing import relationships.
 */
export async function nerve_map(args) {
    const { directory } = args;
    const targetDir = directory || process.cwd();

    try {
        const jsFiles = [];
        scanForJsFiles(targetDir, jsFiles, 3);

        const graph = {};
        for (const file of jsFiles) {
            try {
                const content = fs.readFileSync(file, 'utf-8');
                const imports = [];
                const importRegex = /(?:import\s+.*?\s+from\s+['"](.+?)['"]|require\s*\(\s*['"](.+?)['"]\s*\))/g;
                let match;
                while ((match = importRegex.exec(content)) !== null) {
                    imports.push(match[1] || match[2]);
                }
                const relPath = path.relative(targetDir, file);
                graph[relPath] = imports;
            } catch {}
        }

        const summary = Object.entries(graph)
            .map(([file, deps]) => `${file} → [${deps.join(', ')}]`)
            .join('\n');

        return `🧬 Nerve Map (${Object.keys(graph).length} files):\n${summary}`;
    } catch (e) {
        return `Nerve Map error: ${e.message}`;
    }
}

function scanForJsFiles(dir, results, maxDepth, depth = 0) {
    if (depth >= maxDepth) return;
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.agent', '.next']);
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (IGNORE.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                scanForJsFiles(full, results, maxDepth, depth + 1);
            } else if (/\.(js|ts|jsx|tsx|mjs)$/.test(e.name)) {
                results.push(full);
            }
        }
    } catch {}
}

/**
 * phantom_run — Dry-runs a planned action sequence without executing.
 * Rex validates its plan before committing.
 */
export async function phantom_run(args) {
    const { steps } = args;
    if (!steps || !Array.isArray(steps)) return 'Error: phantom_run requires a "steps" array.';

    const predictions = [];
    for (const step of steps) {
        const tool = step.tool || step.name || 'unknown';
        const toolArgs = step.args || {};
        let prediction = 'unknown';

        if (tool === 'write_file') {
            const fp = toolArgs.filePath || 'unknown';
            prediction = fs.existsSync(fp) ? `Would OVERWRITE ${fp}` : `Would CREATE ${fp}`;
        } else if (tool === 'patch_file') {
            const fp = toolArgs.filePath || 'unknown';
            if (!fs.existsSync(fp)) {
                prediction = `⚠️ WOULD FAIL: ${fp} does not exist`;
            } else {
                const content = fs.readFileSync(fp, 'utf-8');
                if (content.includes(toolArgs.targetContent || '')) {
                    prediction = `Would PATCH ${fp} (target content found)`;
                } else {
                    prediction = `⚠️ WOULD FAIL: target content not found in ${fp}`;
                }
            }
        } else if (tool === 'run_shell') {
            prediction = `Would EXECUTE: ${toolArgs.command || 'n/a'}`;
        } else if (tool === 'read_file') {
            const fp = toolArgs.filePath || 'unknown';
            prediction = fs.existsSync(fp) ? `Would READ ${fp} (${fs.statSync(fp).size} bytes)` : `⚠️ WOULD FAIL: ${fp} not found`;
        } else if (tool === 'browser_interact') {
            prediction = `Would execute browser action: ${toolArgs.action || 'unknown'}`;
        } else {
            prediction = `Would call ${tool}(${JSON.stringify(toolArgs).slice(0, 100)})`;
        }

        predictions.push({ step: tool, prediction });
    }

    const summary = predictions.map((p, i) => `  ${i + 1}. ${p.step} → ${p.prediction}`).join('\n');
    return `👻 Phantom Run Results (${predictions.length} steps):\n${summary}`;
}
