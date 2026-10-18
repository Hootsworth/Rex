/**
 * preflightDesigner.js — Rex ↔ Preflight Designer bridge module.
 *
 * Orchestrates the Python-based Preflight Designer (Shiny Fishstick) from Node.js.
 * Handles venv setup, subprocess communication via JSON stdin/stdout, and
 * exposes clean async APIs for the CLI, Discord bot, and agent chat tools.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { brandTheme, menuLabel, sectionRule, terminalGlyphs } from './terminalTheme.js';

const execAsync = promisify(exec);

// ─── Path constants ──────────────────────────────────────────────────────────

function getPreflightRoot() {
    // Walk up from src/ to project root, then into Preflight Designer
    const currentFilePath = fileURLToPath(import.meta.url);
    return path.join(path.dirname(currentFilePath), '..', 'Preflight Designer');
}

function getBackendDir() {
    return path.join(getPreflightRoot(), 'backend');
}

function getVenvDir() {
    return path.join(getBackendDir(), 'venv');
}

function getPythonBin() {
    const venv = getVenvDir();
    if (process.platform === 'win32') {
        return path.join(venv, 'Scripts', 'python.exe');
    }
    return path.join(venv, 'bin', 'python');
}

function getBridgeScript() {
    return path.join(getBackendDir(), 'rex_bridge.py');
}

function getSpecsDir() {
    return path.join(getPreflightRoot(), 'shared', 'specs');
}

// ─── Venv Management ─────────────────────────────────────────────────────────

/**
 * Check whether the Preflight Designer Python venv is set up and ready.
 */
export function isVenvReady() {
    const pythonBin = getPythonBin();
    return fs.existsSync(pythonBin);
}

/**
 * Set up the Python virtual environment and install dependencies.
 * Returns { ok: boolean, message: string }
 */
export async function ensurePreflightVenv() {
    if (isVenvReady()) {
        return { ok: true, message: 'Venv already exists.' };
    }

    const backendDir = getBackendDir();
    const requirementsFile = path.join(backendDir, 'requirements.txt');

    if (!fs.existsSync(requirementsFile)) {
        return { ok: false, message: `Missing requirements.txt at ${requirementsFile}` };
    }

    try {
        // Create venv
        await execAsync(`python3 -m venv "${getVenvDir()}"`, { cwd: backendDir });

        // Install dependencies
        const pip = process.platform === 'win32'
            ? path.join(getVenvDir(), 'Scripts', 'pip')
            : path.join(getVenvDir(), 'bin', 'pip');
        await execAsync(`"${pip}" install -r "${requirementsFile}"`, { cwd: backendDir, timeout: 300000 });

        // Install Playwright Chromium
        const python = getPythonBin();
        await execAsync(`"${python}" -m playwright install chromium`, { cwd: backendDir, timeout: 300000 });

        return { ok: true, message: 'Venv created and dependencies installed.' };
    } catch (e) {
        return { ok: false, message: `Venv setup failed: ${e.message}` };
    }
}

// ─── Bridge Communication ────────────────────────────────────────────────────

/**
 * Execute a command against the Preflight Designer Python bridge.
 *
 * @param {Object} command - JSON command to send (e.g. {action: "scan", url: "..."})
 * @param {number} [timeoutMs=600000] - Timeout in ms (default 10 min for large crawls)
 * @returns {Promise<Object>} Parsed JSON response from Python
 */
export async function runBridgeCommand(command, timeoutMs = 600000) {
    const python = getPythonBin();
    const bridge = getBridgeScript();

    if (!fs.existsSync(python)) {
        throw new Error('Preflight Designer venv not found. Run setup first.');
    }
    if (!fs.existsSync(bridge)) {
        throw new Error(`Bridge script not found at ${bridge}`);
    }

    return new Promise((resolve, reject) => {
        const child = spawn(python, [bridge], {
            cwd: getPreflightRoot(),
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                // Pass Rex's Gemini key to the Python backend if available
                GEMINI_API_KEY: process.env.GEMINI_API_KEY || ''
            },
            timeout: timeoutMs
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => {
            stderr += data.toString();
            // Forward diagnostic output in real-time
            const lines = data.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                if (line.includes('[rex_bridge]') || line.includes('[Crawler]')) {
                    process.stderr.write(pc.dim(`  ↳ ${line.trim()}\n`));
                }
            }
        });

        child.on('close', (code) => {
            if (code !== 0 && !stdout.trim()) {
                reject(new Error(`Bridge process exited with code ${code}. Stderr: ${stderr.slice(-500)}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}. Error: ${e.message}`));
            }
        });

        child.on('error', (err) => {
            reject(new Error(`Failed to spawn bridge: ${err.message}`));
        });

        // Send command as JSON to stdin
        child.stdin.write(JSON.stringify(command));
        child.stdin.end();
    });
}

// ─── High-Level APIs ─────────────────────────────────────────────────────────

/**
 * Run a full Preflight Designer scan on a target URL.
 */
export async function runPreflightScan(url, options = {}) {
    const { name } = options;
    return await runBridgeCommand({
        action: 'scan',
        url,
        name: name || ''
    });
}

/**
 * List all Preflight Designer projects.
 */
export async function listPreflightProjects() {
    return await runBridgeCommand({ action: 'list_projects' });
}

/**
 * Get the YAML spec for a project.
 */
export async function getPreflightSpec(projectId) {
    return await runBridgeCommand({ action: 'get_spec', project_id: projectId });
}

/**
 * Get a generated SDK for a project.
 */
export async function getPreflightSdk(projectId, lang = 'python') {
    return await runBridgeCommand({ action: 'get_sdk', project_id: projectId, lang });
}

let projectsCache = null;
let projectsCacheTime = 0;

/**
 * Get cached projects list to minimize Python process spawns.
 */
export async function getProjectsListCached() {
    const now = Date.now();
    // Cache for 30 seconds
    if (projectsCache && (now - projectsCacheTime < 30000)) {
        return projectsCache;
    }
    if (!isVenvReady()) {
        return [];
    }
    try {
        const result = await listPreflightProjects();
        if (result && result.ok) {
            projectsCache = result.projects || [];
            projectsCacheTime = now;
            return projectsCache;
        }
    } catch (e) {
        // Silently ignore
    }
    return [];
}

/**
 * Extract hostname without www.
 */
export function getHostname(urlStr) {
    try {
        const url = new URL(urlStr);
        return url.hostname.replace(/^www\./i, '');
    } catch {
        return '';
    }
}

/**
 * Get the JSON spec for a project.
 */
export async function getPreflightSpecJson(projectId) {
    return await runBridgeCommand({ action: 'get_spec_json', project_id: projectId });
}

/**
 * Find matched project spec for the given URL domain.
 */
export async function getPreflightSpecJsonForUrl(urlStr) {
    if (!urlStr || urlStr === 'about:blank') return null;
    const hostname = getHostname(urlStr);
    if (!hostname) return null;

    try {
        const projects = await getProjectsListCached();
        const matchedProj = projects.find(proj => {
            const projHost = getHostname(proj.root_url);
            return projHost && (projHost === hostname || hostname.endsWith('.' + projHost) || projHost.endsWith('.' + hostname));
        });

        if (matchedProj) {
            const specResult = await getPreflightSpecJson(matchedProj.id);
            if (specResult && specResult.ok) {
                return {
                    projectId: matchedProj.id,
                    projectName: matchedProj.name,
                    rootUrl: matchedProj.root_url,
                    spec: specResult.spec
                };
            }
        }
    } catch (e) {
        // Silently ignore
    }
    return null;
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Copy generated spec files to a local output directory.
 */
export function copySpecsToOutput(outputDir) {
    const specsDir = getSpecsDir();
    if (!fs.existsSync(specsDir)) return [];

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const files = ['preflight.yaml', 'sdk.py', 'sdk.ts', 'tools.json', 'mcp_server.py', 'test_sdk.py'];
    const copied = [];
    for (const file of files) {
        const src = path.join(specsDir, file);
        const dest = path.join(outputDir, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            copied.push(dest);
        }
    }
    return copied;
}

/**
 * Format a scan result into a clean terminal summary.
 */
export function formatScanSummary(result) {
    if (!result.ok) {
        return pc.red(`✗ Scan failed: ${result.error}`);
    }

    const s = result.summary;
    const lines = [
        '',
        pc.green('✓ Preflight scan complete!'),
        '',
        `  ${pc.bold('Project')}     ${result.project_name}`,
        `  ${pc.bold('URL')}         ${result.url}`,
        `  ${pc.bold('Actions')}     ${s.total_actions} discovered (${s.browser_actions} browser, ${s.api_upgrades} API upgrades)`,
        `  ${pc.bold('Workflows')}   ${s.workflows} sequential flows`,
        ''
    ];

    if (result.actions && result.actions.length > 0) {
        lines.push(`  ${pc.dim('Discovered Actions:')}`);
        for (const a of result.actions) {
            const typeLabel = a.type === 'api' ? pc.cyan('API') : pc.yellow('DOM');
            const apiNote = a.api_url ? pc.dim(` → ${a.api_method} ${a.api_url}`) : '';
            lines.push(`    ${typeLabel} ${pc.bold(a.name)} — ${a.description}${apiNote}`);
        }
        lines.push('');
    }

    if (result.workflows && result.workflows.length > 0) {
        lines.push(`  ${pc.dim('Workflows:')}`);
        for (const w of result.workflows) {
            lines.push(`    ${pc.bold(w.name)} — ${w.steps.join(' → ')}`);
        }
        lines.push('');
    }

    if (result.generated_files) {
        lines.push(`  ${pc.dim('Generated Files:')}`);
        for (const [key, file] of Object.entries(result.generated_files)) {
            lines.push(`    ${pc.dim('•')} ${file}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format a scan result into a Discord-friendly markdown summary.
 */
export function formatScanSummaryDiscord(result) {
    if (!result.ok) {
        return `❌ **Preflight scan failed:** ${result.error}`;
    }

    const s = result.summary;
    const lines = [
        `🐟 **Preflight Scan Complete!**`,
        '',
        `> **Project:** ${result.project_name}`,
        `> **URL:** ${result.url}`,
        `> **Actions:** ${s.total_actions} discovered (${s.browser_actions} browser, ${s.api_upgrades} API upgrades)`,
        `> **Workflows:** ${s.workflows} sequential flows`
    ];

    if (result.actions && result.actions.length > 0) {
        lines.push('', '**Discovered Actions:**');
        for (const a of result.actions) {
            const typeEmoji = a.type === 'api' ? '⚡' : '🖱️';
            const apiNote = a.api_url ? ` → \`${a.api_method} ${a.api_url}\`` : '';
            lines.push(`${typeEmoji} **${a.name}** — ${a.description}${apiNote}`);
        }
    }

    if (result.workflows && result.workflows.length > 0) {
        lines.push('', '**Workflows:**');
        for (const w of result.workflows) {
            lines.push(`📈 **${w.name}** — ${w.steps.join(' → ')}`);
        }
    }

    lines.push('', '📦 Generated: `preflight.yaml`, `sdk.py`, `sdk.ts`, `tools.json`, `mcp_server.py`');

    return lines.join('\n');
}

// ─── Interactive CLI Menu ────────────────────────────────────────────────────

export async function preflightMenu() {
    const g = terminalGlyphs();

    console.log('');
    console.log(`  ${brandTheme('preflight designer')}`);
    console.log(`  ${pc.dim('website navigation compiler · OpenAPI for browsers')}`);
    console.log('');
    console.log(sectionRule());

    const action = await p.select({
        message: pc.dim('preflight'),
        options: [
            { value: 'scan',     label: menuLabel('scn', 'Scan New Website') },
            { value: 'projects', label: menuLabel('lst', 'View Past Scans') },
            { value: 'setup',    label: menuLabel('stp', 'Setup / Check Venv') },
            { value: 'back',     label: pc.dim('  back') }
        ]
    });

    if (p.isCancel(action) || action === 'back') return;

    if (action === 'setup') {
        const s = p.spinner();
        s.start('Checking Preflight Designer environment...');
        if (isVenvReady()) {
            s.stop(pc.green('✓ Python venv is ready.'));
        } else {
            s.message('Setting up Python venv (this may take a few minutes)...');
            const result = await ensurePreflightVenv();
            if (result.ok) {
                s.stop(pc.green(`✓ ${result.message}`));
            } else {
                s.stop(pc.red(`✗ ${result.message}`));
            }
        }
        return;
    }

    if (action === 'scan') {
        // Ensure venv first
        if (!isVenvReady()) {
            const s = p.spinner();
            s.start('Setting up Preflight Designer environment...');
            const setup = await ensurePreflightVenv();
            if (!setup.ok) {
                s.stop(pc.red(`✗ ${setup.message}`));
                return;
            }
            s.stop(pc.green('✓ Environment ready.'));
        }

        const url = await p.text({
            message: 'Target URL to scan:',
            placeholder: 'https://example.com',
            validate: (v) => {
                if (!v) return 'URL is required';
                if (!v.startsWith('http://') && !v.startsWith('https://')) return 'URL must start with http:// or https://';
            }
        });
        if (p.isCancel(url)) return;

        const name = await p.text({
            message: 'Project name (optional):',
            placeholder: 'auto-detected from hostname',
            initialValue: ''
        });
        if (p.isCancel(name)) return;

        const s = p.spinner();
        s.start(`Scanning ${url} — this may take 1-3 minutes...`);

        try {
            const result = await runPreflightScan(url, { name: name || undefined });
            s.stop('Scan complete.');
            console.log(formatScanSummary(result));

            if (result.ok) {
                // Offer to copy specs to cwd
                const copyChoice = await p.confirm({
                    message: 'Copy generated specs to .rex/preflight-specs/ in current directory?',
                    initialValue: true
                });
                if (!p.isCancel(copyChoice) && copyChoice) {
                    const outDir = path.join(process.cwd(), '.rex', 'preflight-specs', result.project_name);
                    const copied = copySpecsToOutput(outDir);
                    p.log.success(`Copied ${copied.length} files to ${outDir}`);
                }
            }
        } catch (e) {
            s.stop(pc.red(`✗ Scan failed: ${e.message}`));
        }

        return;
    }

    if (action === 'projects') {
        if (!isVenvReady()) {
            p.log.warn('Preflight Designer venv not set up yet. Run setup first.');
            return;
        }

        const s = p.spinner();
        s.start('Loading projects...');

        try {
            const result = await listPreflightProjects();
            s.stop('Projects loaded.');

            if (!result.ok) {
                p.log.error(result.error);
                return;
            }

            if (!result.projects || result.projects.length === 0) {
                p.log.info('No projects found. Run a scan first!');
                return;
            }

            const projectChoice = await p.select({
                message: pc.dim('select project'),
                options: result.projects.map(proj => ({
                    value: proj.id,
                    label: `${pc.bold(proj.name)} — ${proj.root_url} (${proj.actions_count} actions, ${proj.api_upgrades} API)`
                }))
            });
            if (p.isCancel(projectChoice)) return;

            const specResult = await getPreflightSpec(projectChoice);
            if (specResult.ok) {
                p.note(specResult.yaml, 'preflight.yaml');
            } else {
                p.log.warn(specResult.error || 'No spec found.');
            }
        } catch (e) {
            s.stop(pc.red(`✗ Failed: ${e.message}`));
        }

        return;
    }
}
