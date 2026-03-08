import fs from 'fs';
import path from 'path';

const AGENT_DIR = path.join(process.cwd(), '.agent');
const WORKFLOWS_DIR = path.join(AGENT_DIR, 'workflows');

/**
 * Lists all available workflow files (.yaml/.yml/.json)
 */
export function listWorkflows() {
    if (!fs.existsSync(WORKFLOWS_DIR)) return [];
    return fs.readdirSync(WORKFLOWS_DIR)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'))
        .map(f => {
            const filePath = path.join(WORKFLOWS_DIR, f);
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = parseWorkflow(content, f);
            return { file: f, ...parsed };
        });
}

/**
 * Parses a workflow file (simple YAML-like format — no dependency needed)
 * 
 * Format (.yaml):
 * ---
 * name: Deploy to Production
 * description: Build, test, and deploy
 * ---
 * steps:
 *   - tool: run_shell
 *     args: { command: "npm test" }
 *     name: Run tests
 *   - tool: run_shell
 *     args: { command: "npm run build" }
 *     name: Build project
 *   - tool: github_push
 *     name: Push to GitHub
 * 
 * We use a simplified JSON-based format to avoid adding a YAML dependency:
 * {
 *   "name": "Deploy to Production",
 *   "description": "Build, test, and deploy",
 *   "steps": [ { "tool": "run_shell", "args": { "command": "npm test" }, "name": "Run tests" } ]
 * }
 */
function parseWorkflow(content, filename) {
    try {
        // Try JSON first
        if (filename.endsWith('.json')) {
            return JSON.parse(content);
        }

        // Simple YAML-like parser for our specific format
        const result = { name: '', description: '', steps: [] };

        // Extract frontmatter
        const nameMatch = content.match(/name:\s*(.+)/);
        const descMatch = content.match(/description:\s*(.+)/);
        if (nameMatch) result.name = nameMatch[1].trim();
        if (descMatch) result.description = descMatch[1].trim();

        // Extract steps — look for tool: lines
        const stepBlocks = content.split(/\s+-\s+tool:/g).slice(1);
        for (const block of stepBlocks) {
            const step = {};
            step.tool = block.split('\n')[0].trim();
            
            const argsMatch = block.match(/args:\s*\{([^}]+)\}/);
            if (argsMatch) {
                try {
                    step.args = JSON.parse(`{${argsMatch[1]}}`);
                } catch(e) {
                    // Try to parse key:value pairs manually
                    step.args = {};
                    argsMatch[1].split(',').forEach(pair => {
                        const [k, v] = pair.split(':').map(s => s.trim().replace(/["']/g, ''));
                        if (k && v) step.args[k] = v;
                    });
                }
            }

            const stepNameMatch = block.match(/name:\s*(.+)/);
            if (stepNameMatch) step.name = stepNameMatch[1].trim();

            result.steps.push(step);
        }

        return result;
    } catch (e) {
        return { name: filename, description: 'Parse error', steps: [] };
    }
}

/**
 * Loads a specific workflow by name or filename
 */
export function loadWorkflow(nameOrFile) {
    if (!fs.existsSync(WORKFLOWS_DIR)) return null;
    const lower = nameOrFile.toLowerCase();

    const files = fs.readdirSync(WORKFLOWS_DIR)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));

    // Exact filename match
    const exact = files.find(f => f === nameOrFile || f === `${nameOrFile}.json` || f === `${nameOrFile}.yaml`);
    if (exact) {
        const content = fs.readFileSync(path.join(WORKFLOWS_DIR, exact), 'utf-8');
        return parseWorkflow(content, exact);
    }

    // Fuzzy name match
    for (const f of files) {
        const content = fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf-8');
        const parsed = parseWorkflow(content, f);
        if (parsed.name && parsed.name.toLowerCase().includes(lower)) {
            return parsed;
        }
    }

    return null;
}

/**
 * Creates a sample workflow file in .agent/workflows/
 */
export function createSampleWorkflow() {
    if (!fs.existsSync(WORKFLOWS_DIR)) {
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }

    const sample = {
        name: "Quick Deploy",
        description: "Run tests, build, and push to GitHub",
        steps: [
            { tool: "run_shell", args: { command: "npm test" }, name: "Run tests" },
            { tool: "run_shell", args: { command: "npm run build" }, name: "Build project" },
            { tool: "github_push", args: {}, name: "Push to GitHub" }
        ]
    };

    const filePath = path.join(WORKFLOWS_DIR, 'quick-deploy.json');
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(sample, null, 2), 'utf-8');
    }
    return filePath;
}
