import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fg from 'fast-glob';
import {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { runCompletion, runCompletionWithTarget } from './ai.js';
import { parseIntent } from './intentPipeline/intentParser.js';
import { runAction } from './intentPipeline/actionRouter.js';
import { getAllowedDirs, isDiscordUserAllowed } from './intentPipeline/security.js';
import { rememberCommand, getRecentMemory } from './intentPipeline/memoryStore.js';
import { loadConfig } from './config.js';

const EPISODES_DIR = path.join(process.cwd(), '.rex-data');
const EPISODES_FILE = path.join(EPISODES_DIR, 'discord-episodes.json');
const execAsync = promisify(exec);
const FREEFALL_ROOT = path.join(process.cwd(), '.rex-data', 'freefall');
const FREEFALL_ALLOWED_PREFIX = path.resolve(process.cwd(), 'src');

function getFreefallTarget() {
    const config = loadConfig();
    if (config.geminiKey) {
        return { provider: 'gemini', model: config.geminiModel || 'gemini-3.7-flash-lite' };
    }
    if (config.openaiKey) {
        return { provider: 'openai', model: config.openaiModel || 'gpt-5-nano' };
    }
    if (config.claudeKey) {
        return { provider: 'claude', model: config.claudeModel || 'claude-3-5-sonnet-20241022' };
    }
    if (config.deepseekKey) {
        return { provider: 'deepseek', model: config.deepseekModel || 'deepseek-chat' };
    }
    return { provider: 'gemini', model: 'gemini-3.5-flash' };
}

function shouldRequestHumanInput({ ok, text = '', intentMissing = false }) {
    if (intentMissing) return true;
    if (ok) return false;

    const lower = String(text || '').toLowerCase();
    const blockers = [
        'confirmation required',
        'could not find',
        'not found',
        'outside allowed',
        'access denied',
        'missing',
        'ambiguous',
        'could not be mapped',
        'blocked by',
        'requires'
    ];
    return blockers.some((needle) => lower.includes(needle));
}

async function captureAssistanceScreenshot() {
    const outDir = path.join(process.cwd(), '.rex-data', 'assist');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const target = path.join(outDir, `assist_${Date.now()}.png`);

    try {
        if (process.platform === 'win32') {
            const cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $Screen = [System.Windows.Forms.Screen]::PrimaryScreen; $Bitmap = New-Object System.Drawing.Bitmap($Screen.Bounds.Width, $Screen.Bounds.Height); $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap); $Graphics.CopyFromScreen($Screen.Bounds.Left, $Screen.Bounds.Top, 0, 0, $Bitmap.Size); $Bitmap.Save('${target.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); $Graphics.Dispose(); $Bitmap.Dispose();"`;
            await execAsync(cmd);
            return target;
        }
        if (process.platform === 'darwin') {
            await execAsync(`screencapture -x \"${target}\"`);
            return target;
        }

        await execAsync(`import -window root \"${target}\"`);
        return target;
    } catch {
        return null;
    }
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function isEditableSelfCode(filePath) {
    const target = path.resolve(String(filePath || ''));
    const root = path.resolve(FREEFALL_ALLOWED_PREFIX);
    const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
    const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function toFreefallSessionDir(sessionId) {
    const dir = path.join(FREEFALL_ROOT, String(sessionId));
    ensureDir(dir);
    return dir;
}

function appendSessionDoc(sessionDir, fileName, lines) {
    const target = path.join(sessionDir, fileName);
    const body = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
    fs.appendFileSync(target, `${body}\n`, 'utf-8');
}

async function runNanoPrompt(prompt) {
    return await runCompletionWithTarget([{ role: 'user', content: prompt }], getFreefallTarget());
}

async function listEligibleSourceFiles() {
    const root = path.resolve(FREEFALL_ALLOWED_PREFIX);
    const items = await fg(['**/*.js'], {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        dot: false,
        suppressErrors: true,
        ignore: ['**/__tests__/**', '**/node_modules/**']
    });
    return items;
}

function parseJsonSafe(raw = '', fallback = {}) {
    try {
        return parseJsonObject(raw);
    } catch {
        return fallback;
    }
}

async function analyzeFileWithNano({ filePath, content, objective }) {
    const prompt = [
        'You are Freefall analyzer. Return JSON only.',
        'Model constraint: gpt-5-nano, so keep output compact and deterministic.',
        'Analyze this code for bugs, reliability issues, and valuable improvements.',
        'Classify each issue with severity low|medium|high and changeType minor|major.',
        'Return shape:',
        '{"summary":"...","issues":[{"title":"...","severity":"low|medium|high","changeType":"minor|major","why":"...","fix":"..."}]}',
        `Objective context: ${objective || 'Improve reliability and maintainability with safe edits.'}`,
        `File: ${filePath}`,
        'Code:',
        String(content || '').slice(0, 12000)
    ].join('\n');

    const out = await runNanoPrompt(prompt);
    const parsed = parseJsonSafe(out, { summary: '', issues: [] });
    if (!Array.isArray(parsed.issues)) parsed.issues = [];
    return parsed;
}

async function generateMinorPatchWithNano({ filePath, content, issue }) {
    const prompt = [
        'You are Freefall patcher. Return JSON only.',
        'Apply ONLY a small safe minor fix for the described issue.',
        'Do not refactor unrelated code. Preserve behavior except for the bug fix.',
        'Return shape:',
        '{"apply":true,"reason":"...","commitMessage":"...","newContent":"<entire updated file>"}',
        'If unsafe or uncertain, return apply=false with reason.',
        `File: ${filePath}`,
        `Issue: ${JSON.stringify(issue)}`,
        'Current file content:',
        String(content || '').slice(0, 14000)
    ].join('\n');

    const out = await runNanoPrompt(prompt);
    const parsed = parseJsonSafe(out, { apply: false, reason: 'Invalid patch output.' });
    return parsed;
}

async function writeIfChanged(filePath, newContent) {
    const current = fs.readFileSync(filePath, 'utf-8');
    if (current === newContent) return false;
    fs.writeFileSync(filePath, newContent, 'utf-8');
    return true;
}

async function tryGitCommit(filePath, commitMessage) {
    const safeMsg = String(commitMessage || 'freefall: automated minor improvement').replace(/"/g, "'");
    const cmd = `git add \"${filePath}\"; git commit -m \"${safeMsg}\"`;
    try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: process.cwd() });
        return { ok: true, stdout, stderr };
    } catch (e) {
        return { ok: false, error: String(e?.message || e) };
    }
}

function buildFreefallUpdateEmbed(session, note, color = 0x06b6d4) {
    return new EmbedBuilder()
        .setTitle('Freefall Mode')
        .setDescription(session.objective || 'Self-review and safe improvements')
        .addFields(
            { name: 'Status', value: session.active ? 'Running' : 'Stopped', inline: true },
            { name: 'Batch', value: String(session.batchCursor + 1), inline: true },
            { name: 'Applied Versions', value: String(session.versions.length), inline: true },
            { name: 'Update', value: String(note || 'No update').slice(0, 1024), inline: false }
        )
        .setColor(color)
        .setFooter({ text: `Freefall ID: ${session.id}` })
        .setTimestamp(new Date());
}

function ensureEpisodesFile() {
    if (!fs.existsSync(EPISODES_DIR)) {
        fs.mkdirSync(EPISODES_DIR, { recursive: true });
    }
    if (!fs.existsSync(EPISODES_FILE)) {
        fs.writeFileSync(EPISODES_FILE, JSON.stringify({ episodes: [] }, null, 2));
    }
}

function readEpisodes() {
    ensureEpisodesFile();
    try {
        const raw = fs.readFileSync(EPISODES_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.episodes) ? parsed.episodes : [];
    } catch {
        return [];
    }
}

function writeEpisodes(episodes) {
    ensureEpisodesFile();
    const capped = Array.isArray(episodes) ? episodes.slice(-1000) : [];
    fs.writeFileSync(EPISODES_FILE, JSON.stringify({ episodes: capped }, null, 2));
}

function appendEpisode(entry) {
    const episodes = readEpisodes();
    episodes.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        ...entry
    });
    writeEpisodes(episodes);
}

function searchEpisodes(query = '', limit = 8) {
    const q = String(query || '').toLowerCase().trim();
    const episodes = readEpisodes();
    if (!q) return episodes.slice(-limit).reverse();
    return episodes
        .filter((e) => JSON.stringify(e).toLowerCase().includes(q))
        .slice(-limit)
        .reverse();
}

function toId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonObject(text = '') {
    const raw = String(text || '').trim();
    const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = block ? block[1].trim() : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    const sliced = start >= 0 && end > start ? body.slice(start, end + 1) : body;
    return JSON.parse(sliced);
}

function buildGoalButtons(sessionId, finished = false) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`goal_approve:${sessionId}`)
                .setLabel('Approve Step')
                .setStyle(ButtonStyle.Success)
                .setDisabled(finished),
            new ButtonBuilder()
                .setCustomId(`goal_skip:${sessionId}`)
                .setLabel('Skip Step')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(finished),
            new ButtonBuilder()
                .setCustomId(`goal_retry:${sessionId}`)
                .setLabel('Retry Step')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(finished),
            new ButtonBuilder()
                .setCustomId(`goal_explain:${sessionId}`)
                .setLabel('Explain Why')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(finished),
            new ButtonBuilder()
                .setCustomId(`goal_stop:${sessionId}`)
                .setLabel(finished ? 'Stopped' : 'Stop Goal')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(finished)
        )
    ];
}

function buildGoalEmbed(session) {
    const done = session.steps.filter((s) => s.status === 'done').length;
    const failed = session.steps.filter((s) => s.status === 'failed').length;
    const skipped = session.steps.filter((s) => s.status === 'skipped').length;
    const total = session.steps.length;
    const current = session.currentIndex < total ? session.steps[session.currentIndex] : null;

    const lines = session.steps.map((step, idx) => {
        const marker = step.status === 'done'
            ? 'DONE'
            : step.status === 'failed'
                ? 'FAIL'
                : step.status === 'skipped'
                    ? 'SKIP'
                    : step.status === 'waiting_input'
                        ? 'INPUT'
                        : idx === session.currentIndex
                            ? 'NOW'
                            : 'WAIT';
        return `${idx + 1}. [${marker}] ${step.text}`;
    });

    const embed = new EmbedBuilder()
        .setTitle('Goal Mode')
        .setDescription(session.objective)
        .addFields(
            { name: 'Progress', value: `${done}/${total} done | ${failed} failed | ${skipped} skipped`, inline: false },
            { name: 'Current Step', value: current ? current.text : 'All steps complete', inline: false },
            { name: 'Plan', value: lines.join('\n').slice(0, 1024) || 'No steps', inline: false }
        )
        .setColor(session.finished ? 0x22c55e : 0x3b82f6)
        .setFooter({ text: `Goal ID: ${session.id}` })
        .setTimestamp(new Date());

    return embed;
}

function buildProactiveEmbed(session, note) {
    return new EmbedBuilder()
        .setTitle('Proactive Mode')
        .setDescription(session.objective)
        .addFields(
            { name: 'Status', value: session.active ? 'Running' : 'Stopped', inline: true },
            { name: 'Runs', value: String(session.runCount), inline: true },
            { name: 'Ends At', value: new Date(session.endAt).toLocaleString(), inline: true },
            { name: 'Latest', value: String(note || 'No updates yet').slice(0, 1024), inline: false }
        )
        .setColor(session.active ? 0xa855f7 : 0x6b7280)
        .setFooter({ text: `Proactive ID: ${session.id}` })
        .setTimestamp(new Date());
}

async function planGoalSteps(objective) {
    const prompt = [
        'Create a concise execution plan for this goal.',
        'Return JSON only in this exact shape:',
        '{"steps":["step 1", "step 2", "step 3"]}',
        'Rules:',
        '- 3 to 7 steps',
        '- Each step must be an actionable command-like instruction',
        '- Keep each step under 120 characters',
        `Goal: ${objective}`
    ].join('\n');

    try {
        const out = await runCompletion([{ role: 'user', content: prompt }], null, 'high');
        const parsed = parseJsonObject(out);
        const steps = Array.isArray(parsed.steps) ? parsed.steps.map((s) => String(s || '').trim()).filter(Boolean) : [];
        if (steps.length > 0) return steps.slice(0, 7);
    } catch {
        // Fallback below.
    }

    return [
        `Clarify exact deliverable for: ${objective}`,
        `Find required files or context for: ${objective}`,
        `Execute the main action for: ${objective}`,
        `Verify result quality for: ${objective}`,
        `Deliver summary and next actions for: ${objective}`
    ];
}

async function executeStepText({ stepText, actorId, channel, config, objective, mode }) {
    if (!isDiscordUserAllowed(config, actorId)) {
        return { ok: false, text: 'Blocked by Discord whitelist policy.' };
    }

    const intent = await parseIntent(stepText, config);
    if (!intent?.action || intent.action === 'help') {
        return { ok: false, text: 'Step could not be mapped to an executable action.' };
    }

    rememberCommand(intent);

    const fakeMessage = {
        author: { id: actorId },
        reply: async (payload) => {
            if (typeof payload === 'string') return await channel.send(payload);
            return await channel.send(payload);
        }
    };

    const ctx = {
        config,
        message: fakeMessage,
        allowedDirs: getAllowedDirs(config),
        recentMemory: getRecentMemory()
    };

    const result = await runAction(intent, ctx);
    appendEpisode({
        source: mode,
        objective,
        step: stepText,
        intent,
        success: Boolean(result?.ok),
        resultText: String(result?.text || '')
    });

    return {
        ok: Boolean(result?.ok),
        text: String(result?.text || 'No result text.'),
        intent
    };
}

export function createDiscordAgenticRuntime(config) {
    const goalSessions = new Map();
    const proactiveSessions = new Map();
    const pendingInputByUserKey = new Map();
    const freefallSessions = new Map();

    function keyFor(userId, channelId) {
        return `${channelId}:${userId}`;
    }

    async function promptForHumanInput({ channel, actorId, prompt, screenshotPath, mode, sessionId }) {
        const key = keyFor(actorId, channel.id);
        pendingInputByUserKey.set(key, {
            mode,
            sessionId,
            actorId,
            channelId: channel.id,
            prompt,
            screenshotPath,
            createdAt: Date.now()
        });

        const content = [
            'I need your input before I can safely continue this step.',
            `Question: ${prompt}`,
            'Reply in this channel with your answer. I will resume automatically.'
        ].join('\n');

        if (screenshotPath && fs.existsSync(screenshotPath)) {
            await channel.send({ content, files: [screenshotPath] }).catch(() => {});
        } else {
            await channel.send({ content }).catch(() => {});
        }
    }

    async function updateGoalCardMessage(session, channel) {
        if (!session?.messageId) return;
        try {
            const msg = await channel.messages.fetch(session.messageId);
            await msg.edit({ embeds: [buildGoalEmbed(session)], components: buildGoalButtons(session.id, session.finished) });
        } catch {
            // Best effort.
        }
    }

    function getSlashCommands() {
        return [
            new SlashCommandBuilder()
                .setName('goal')
                .setDescription('Create a multi-step goal with guided execution')
                .addStringOption((opt) => opt.setName('objective').setDescription('What should Rex accomplish?').setRequired(true)),
            new SlashCommandBuilder()
                .setName('proactive_start')
                .setDescription('Start bounded proactive mode in this channel')
                .addStringOption((opt) => opt.setName('objective').setDescription('What should Rex keep working on?').setRequired(true))
                .addIntegerOption((opt) => opt.setName('duration_minutes').setDescription('How long to run').setRequired(true).setMinValue(1).setMaxValue(180))
                .addIntegerOption((opt) => opt.setName('cadence_seconds').setDescription('Check interval in seconds').setRequired(false).setMinValue(20).setMaxValue(600)),
            new SlashCommandBuilder()
                .setName('proactive_stop')
                .setDescription('Stop proactive mode in this channel'),
            new SlashCommandBuilder()
                .setName('episodes')
                .setDescription('Search episodic memory')
                .addStringOption((opt) => opt.setName('query').setDescription('Filter keyword').setRequired(false)),
            new SlashCommandBuilder()
                .setName('freefall_start')
                .setDescription('Start Freefall: batched GPT-5-nano self-review and safe improvements')
                .addStringOption((opt) => opt.setName('objective').setDescription('Optional objective').setRequired(false))
                .addIntegerOption((opt) => opt.setName('interval_seconds').setDescription('Batch interval').setRequired(false).setMinValue(30).setMaxValue(900))
                .addIntegerOption((opt) => opt.setName('batch_size').setDescription('Files per batch').setRequired(false).setMinValue(1).setMaxValue(4))
                .addBooleanOption((opt) => opt.setName('strict_no_auto_apply').setDescription('If true, Freefall never applies changes without button approval').setRequired(false)),
            new SlashCommandBuilder()
                .setName('freefall_stop')
                .setDescription('Stop Freefall and receive full version/change report'),
            new SlashCommandBuilder()
                .setName('preflight')
                .setDescription('Scan a website and generate navigation specs, SDKs, and agent tools')
                .addStringOption((opt) => opt.setName('url').setDescription('Target URL to scan').setRequired(true))
                .addStringOption((opt) => opt.setName('name').setDescription('Project name (defaults to hostname)').setRequired(false))
        ];
    }

    async function restartRexProcessFromRuntime() {
        const child = spawn(process.execPath, process.argv.slice(1), {
            cwd: process.cwd(),
            detached: true,
            stdio: 'inherit',
            windowsHide: false
        });
        child.unref();
        setTimeout(() => process.exit(0), 500);
    }

    async function writeFreefallSummary(session) {
        const sessionDir = toFreefallSessionDir(session.id);
        const summaryPath = path.join(sessionDir, 'freefall-summary.md');
        const lines = [];
        lines.push(`# Freefall Summary (${session.id})`);
        lines.push('');
        lines.push(`- Objective: ${session.objective}`);
        lines.push(`- Started: ${new Date(session.startedAt).toISOString()}`);
        lines.push(`- Stopped: ${new Date().toISOString()}`);
        lines.push(`- Batches executed: ${session.batchCursor}`);
        lines.push(`- Versions applied: ${session.versions.length}`);
        lines.push('');
        lines.push('## Version Log');
        if (session.versions.length === 0) {
            lines.push('- No code versions applied in this run.');
        } else {
            session.versions.forEach((v, idx) => {
                lines.push(`### ${idx + 1}. ${v.filePath}`);
                lines.push(`- Time: ${v.ts}`);
                lines.push(`- Reason: ${v.reason}`);
                lines.push(`- Commit message: ${v.commitMessage}`);
                lines.push(`- Git: ${v.gitOk ? 'commit created' : `not committed (${v.gitError || 'unknown'})`}`);
                lines.push('');
            });
        }
        lines.push('## Pending Major Reviews');
        if (!session.pendingMajor.length) {
            lines.push('- None');
        } else {
            session.pendingMajor.forEach((m, idx) => {
                lines.push(`- ${idx + 1}. ${m.filePath} :: ${m.issue?.title || 'Untitled issue'} (${m.issue?.severity || 'unknown'})`);
            });
        }
        lines.push('');
        lines.push('## Pending Minor Reviews');
        if (!session.pendingMinor || !session.pendingMinor.length) {
            lines.push('- None');
        } else {
            session.pendingMinor.forEach((m, idx) => {
                lines.push(`- ${idx + 1}. ${m.filePath} :: ${m.issue?.title || 'Untitled issue'} (${m.issue?.severity || 'unknown'})`);
            });
        }

        fs.writeFileSync(summaryPath, lines.join('\n'), 'utf-8');
        return summaryPath;
    }

    async function tryPushGithubFromRuntime() {
        try {
            const { stdout, stderr } = await execAsync('git push', { cwd: process.cwd() });
            return { ok: true, note: (stdout || stderr || 'git push completed').trim() };
        } catch (e) {
            return { ok: false, note: String(e?.message || e) };
        }
    }

    async function runFreefallBatch(session) {
        if (!session.active || session.running) return;
        session.running = true;
        session.batchCursor += 1;

        const sessionDir = toFreefallSessionDir(session.id);
        const start = session.fileCursor;
        const end = Math.min(start + session.batchSize, session.files.length);
        const batchFiles = session.files.slice(start, end);
        session.fileCursor = end >= session.files.length ? 0 : end;

        const notes = [];
        for (const filePath of batchFiles) {
            if (!isEditableSelfCode(filePath)) continue;
            let content = '';
            try {
                content = fs.readFileSync(filePath, 'utf-8');
            } catch {
                notes.push(`Skip unreadable: ${filePath}`);
                continue;
            }

            const analysis = await analyzeFileWithNano({ filePath, content, objective: session.objective });
            appendSessionDoc(sessionDir, 'analysis.log.md', [
                `## Batch ${session.batchCursor} :: ${filePath}`,
                `Summary: ${analysis.summary || '-'}`,
                `Issues: ${(analysis.issues || []).length}`,
                ''
            ]);

            const issues = Array.isArray(analysis.issues) ? analysis.issues.slice(0, 3) : [];
            for (const issue of issues) {
                const changeType = String(issue.changeType || 'minor').toLowerCase();
                if (changeType === 'major') {
                    const reviewId = toId();
                    session.pendingMajor.push({ reviewId, filePath, issue, contentSnapshot: content });
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`freefall_major_yes:${session.id}:${reviewId}`).setLabel('Approve Major Change').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`freefall_major_no:${session.id}:${reviewId}`).setLabel('Skip').setStyle(ButtonStyle.Secondary)
                    );
                    const explain = [
                        `Major review requested for ${path.relative(process.cwd(), filePath)}.`,
                        `Why: ${issue.why || issue.title || 'High-impact improvement identified.'}`,
                        `Necessity: ${issue.fix || 'Change improves correctness/safety.'}`,
                        'Approve only if this aligns with your intent.'
                    ].join('\n');
                    await session.channel.send({ content: explain, components: [row] }).catch(() => {});
                    notes.push(`Major review queued: ${path.basename(filePath)} :: ${issue.title || 'untitled'}`);
                    continue;
                }

                const patch = await generateMinorPatchWithNano({ filePath, content, issue });
                if (!patch?.apply || typeof patch.newContent !== 'string' || patch.newContent.length < 10) {
                    notes.push(`Minor skipped: ${path.basename(filePath)} :: ${patch?.reason || 'not safe'}`);
                    continue;
                }

                if (session.strictNoAutoApply) {
                    const reviewId = toId();
                    session.pendingMinor.push({
                        reviewId,
                        filePath,
                        issue,
                        contentSnapshot: content,
                        patchProposal: patch
                    });
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`freefall_minor_yes:${session.id}:${reviewId}`).setLabel('Approve Minor Change').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`freefall_minor_no:${session.id}:${reviewId}`).setLabel('Skip').setStyle(ButtonStyle.Secondary)
                    );
                    const explain = [
                        `Minor review requested for ${path.relative(process.cwd(), filePath)}.`,
                        `Why: ${issue.why || issue.title || 'Small reliability improvement identified.'}`,
                        `Necessity: ${issue.fix || patch.reason || 'Improves maintainability/safety.'}`,
                        'Strict mode is on, so this will not auto-apply without your approval.'
                    ].join('\n');
                    await session.channel.send({ content: explain, components: [row] }).catch(() => {});
                    notes.push(`Minor review queued: ${path.basename(filePath)} :: ${issue.title || 'untitled'}`);
                    continue;
                }

                if (!isEditableSelfCode(filePath)) {
                    notes.push(`Blocked non-self file: ${filePath}`);
                    continue;
                }

                const changed = await writeIfChanged(filePath, patch.newContent);
                if (!changed) {
                    notes.push(`No diff: ${path.basename(filePath)}`);
                    continue;
                }

                const commitMessage = String(patch.commitMessage || `freefall: minor fix in ${path.basename(filePath)}`);
                const gitRes = await tryGitCommit(filePath, commitMessage);

                const version = {
                    ts: new Date().toISOString(),
                    filePath,
                    reason: String(issue.why || issue.title || 'Minor reliability improvement'),
                    commitMessage,
                    gitOk: Boolean(gitRes.ok),
                    gitError: gitRes.ok ? '' : String(gitRes.error || '')
                };
                session.versions.push(version);

                appendSessionDoc(sessionDir, 'versions.log.md', [
                    `## ${version.ts}`,
                    `- file: ${version.filePath}`,
                    `- reason: ${version.reason}`,
                    `- commit: ${version.commitMessage}`,
                    `- git: ${version.gitOk ? 'ok' : version.gitError}`,
                    ''
                ]);
                notes.push(`Applied minor: ${path.basename(filePath)}`);
            }
        }

        const note = notes.length ? notes.join('\n').slice(0, 1000) : 'Batch completed with no actionable changes.';
        await session.channel.send({ embeds: [buildFreefallUpdateEmbed(session, note)] }).catch(() => {});
        session.running = false;
    }

    async function handleFreefallStart(interaction) {
        const hasKey = Boolean(config.geminiKey || config.openaiKey || config.claudeKey || config.deepseekKey || config.ollamaHost);
        if (!hasKey) {
            await interaction.reply({ content: 'Freefall requires an active AI provider key (Gemini, OpenAI, Claude, or DeepSeek).', ephemeral: true });
            return;
        }

        const objective = interaction.options.getString('objective', false) || 'Find and safely improve bugs/issues in Rex codebase.';
        const intervalSeconds = interaction.options.getInteger('interval_seconds', false) || 120;
        const batchSize = interaction.options.getInteger('batch_size', false) || 2;
        const strictNoAutoApply = interaction.options.getBoolean('strict_no_auto_apply', false) === true;

        const existing = freefallSessions.get(interaction.channelId);
        if (existing && existing.active) {
            await interaction.reply({ content: 'Freefall is already active in this channel.', ephemeral: true });
            return;
        }

        const files = await listEligibleSourceFiles();
        const session = {
            id: toId(),
            channelId: interaction.channelId,
            creatorId: interaction.user.id,
            channel: interaction.channel,
            objective,
            active: true,
            running: false,
            startedAt: Date.now(),
            intervalSeconds,
            batchSize,
            files,
            fileCursor: 0,
            batchCursor: 0,
            timer: null,
            versions: [],
            pendingMajor: [],
            pendingMinor: [],
            strictNoAutoApply
        };

        const sessionDir = toFreefallSessionDir(session.id);
        fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
            id: session.id,
            objective,
            startedAt: new Date(session.startedAt).toISOString(),
            intervalSeconds,
            batchSize,
            strictNoAutoApply,
            fileCount: files.length,
            model: 'gpt-5-nano'
        }, null, 2), 'utf-8');

        const pushRes = await tryPushGithubFromRuntime();

        await interaction.reply({
            embeds: [buildFreefallUpdateEmbed(session, [
                `Started in this channel with ${files.length} eligible src files.`,
                `Model locked: gpt-5-nano`,
                `Batch size: ${batchSize}, interval: ${intervalSeconds}s`,
                `Strict no auto-apply: ${strictNoAutoApply ? 'enabled' : 'disabled'}`,
                `Pre-run git push: ${pushRes.ok ? 'ok' : `failed (${pushRes.note})`}`
            ].join('\n'))]
        });

        session.timer = setInterval(() => {
            runFreefallBatch(session).catch(async (e) => {
                await session.channel.send({ embeds: [buildFreefallUpdateEmbed(session, `Batch failure: ${e.message}`, 0xef4444)] }).catch(() => {});
            });
        }, intervalSeconds * 1000);
        freefallSessions.set(interaction.channelId, session);

        appendEpisode({
            source: 'freefall',
            objective,
            step: 'start',
            success: true,
            resultText: `interval=${intervalSeconds}s batch=${batchSize} files=${files.length}`
        });
    }

    async function stopFreefallSession(channelId, reason = 'Stopped by command') {
        const session = freefallSessions.get(channelId);
        if (!session) return null;
        session.active = false;
        if (session.timer) clearInterval(session.timer);
        freefallSessions.delete(channelId);

        const summaryPath = await writeFreefallSummary(session);
        appendEpisode({ source: 'freefall', objective: session.objective, step: 'stop', success: true, resultText: reason });

        return { session, summaryPath };
    }

    async function handleGoalCommand(interaction) {
        const objective = interaction.options.getString('objective', true);
        const steps = await planGoalSteps(objective);
        const session = {
            id: toId(),
            objective,
            steps: steps.map((s) => ({ text: s, status: 'pending', note: '' })),
            creatorId: interaction.user.id,
            channelId: interaction.channelId,
            currentIndex: 0,
            finished: false,
            messageId: ''
        };

        const embed = buildGoalEmbed(session);
        await interaction.reply({ embeds: [embed], components: buildGoalButtons(session.id, false) });
        const msg = await interaction.fetchReply();
        session.messageId = msg.id;
        goalSessions.set(session.id, session);

        appendEpisode({
            source: 'goal',
            objective,
            step: 'plan_created',
            success: true,
            resultText: `${steps.length} steps generated`
        });
    }

    function stopProactiveSession(channelId, reason = 'Stopped') {
        const session = proactiveSessions.get(channelId);
        if (!session) return null;
        session.active = false;
        if (session.timer) clearInterval(session.timer);
        proactiveSessions.delete(channelId);
        appendEpisode({
            source: 'proactive',
            objective: session.objective,
            step: 'stop',
            success: true,
            resultText: reason
        });
        return session;
    }

    async function handleProactiveStart(interaction) {
        const objective = interaction.options.getString('objective', true);
        const durationMinutes = interaction.options.getInteger('duration_minutes', true);
        const cadenceSeconds = interaction.options.getInteger('cadence_seconds', false) || 60;

        const existing = proactiveSessions.get(interaction.channelId);
        if (existing) {
            stopProactiveSession(interaction.channelId, 'Replaced by a new proactive session.');
        }

        const session = {
            id: toId(),
            objective,
            creatorId: interaction.user.id,
            channelId: interaction.channelId,
            cadenceSeconds,
            endAt: Date.now() + durationMinutes * 60 * 1000,
            runCount: 0,
            active: true,
            running: false,
            timer: null
        };

        await interaction.reply({
            embeds: [buildProactiveEmbed(session, 'Proactive mode armed. First run will execute on interval.')]
        });

        const runTick = async () => {
            if (!session.active || session.running) return;
            if (Date.now() > session.endAt) {
                stopProactiveSession(session.channelId, 'Duration elapsed.');
                await interaction.channel.send({ embeds: [buildProactiveEmbed({ ...session, active: false }, 'Proactive mode ended: duration elapsed.')] }).catch(() => {});
                return;
            }

            session.running = true;
            session.runCount += 1;

            try {
                const stepPrompt = [
                    'Turn this objective into one immediate executable action sentence.',
                    'It must be short and concrete.',
                    'Prefer actions that map to file operations when possible.',
                    `Objective: ${session.objective}`
                ].join('\n');
                const stepText = await runCompletion([{ role: 'user', content: stepPrompt }], null, 'high');
                const result = await executeStepText({
                    stepText: String(stepText || '').slice(0, 300),
                    actorId: session.creatorId,
                    channel: interaction.channel,
                    config,
                    objective: session.objective,
                    mode: 'proactive'
                });

                const note = `Run #${session.runCount}: ${result.ok ? 'OK' : 'FAIL'} - ${result.text}`;
                await interaction.channel.send({ embeds: [buildProactiveEmbed(session, note)] }).catch(() => {});

                if (!result.ok && shouldRequestHumanInput({ ok: result.ok, text: result.text, intentMissing: false })) {
                    const screenshotPath = await captureAssistanceScreenshot();
                    await promptForHumanInput({
                        channel: interaction.channel,
                        actorId: session.creatorId,
                        mode: 'proactive',
                        sessionId: session.id,
                        screenshotPath,
                        prompt: `Proactive run #${session.runCount} needs guidance. What should I do next? (${result.text})`
                    });
                }
            } catch (e) {
                const note = `Run #${session.runCount}: FAIL - ${e.message}`;
                await interaction.channel.send({ embeds: [buildProactiveEmbed(session, note)] }).catch(() => {});
            } finally {
                session.running = false;
            }
        };

        session.timer = setInterval(runTick, cadenceSeconds * 1000);
        proactiveSessions.set(interaction.channelId, session);

        appendEpisode({
            source: 'proactive',
            objective,
            step: 'start',
            success: true,
            resultText: `duration=${durationMinutes}m cadence=${cadenceSeconds}s`
        });
    }

    async function handleEpisodes(interaction) {
        const query = interaction.options.getString('query', false) || '';
        const rows = searchEpisodes(query, 8);
        if (rows.length === 0) {
            await interaction.reply({ content: 'No episodes found for that query.', ephemeral: true });
            return;
        }

        const text = rows
            .map((e, idx) => `${idx + 1}. [${e.source}] ${e.objective || '-'} | ${e.step || '-'} | ${e.success ? 'OK' : 'FAIL'}`)
            .join('\n')
            .slice(0, 1900);

        await interaction.reply({ content: `Recent episodes:\n${text}`, ephemeral: true });
    }

    async function handleGoalButton(interaction, action, sessionId) {
        const session = goalSessions.get(sessionId);
        if (!session) {
            await interaction.reply({ content: 'Goal session not found.', ephemeral: true });
            return;
        }

        if (interaction.user.id !== session.creatorId) {
            await interaction.reply({ content: 'Only the goal creator can control this goal card.', ephemeral: true });
            return;
        }

        if (action === 'stop') {
            session.finished = true;
            await interaction.update({ embeds: [buildGoalEmbed(session)], components: buildGoalButtons(session.id, true) });
            appendEpisode({ source: 'goal', objective: session.objective, step: 'stop', success: true, resultText: 'Stopped by user' });
            return;
        }

        const idx = session.currentIndex;
        if (idx >= session.steps.length) {
            session.finished = true;
            await interaction.update({ embeds: [buildGoalEmbed(session)], components: buildGoalButtons(session.id, true) });
            return;
        }

        const current = session.steps[idx];

        if (action === 'skip') {
            current.status = 'skipped';
            current.note = 'Skipped by user';
            session.currentIndex += 1;
        } else if (action === 'explain') {
            const explainPrompt = `Explain in 3 short bullets why this step matters for the goal.\nGoal: ${session.objective}\nStep: ${current.text}`;
            const why = await runCompletion([{ role: 'user', content: explainPrompt }], null, 'high');
            await interaction.reply({ content: String(why || 'No explanation available.'), ephemeral: true });
            return;
        } else {
            const stepText = current.text;
            const result = await executeStepText({
                stepText,
                actorId: interaction.user.id,
                channel: interaction.channel,
                config,
                objective: session.objective,
                mode: 'goal'
            });

            if (result.ok) {
                current.status = 'done';
                current.note = result.text;
                session.currentIndex += 1;
            } else {
                const needsInput = shouldRequestHumanInput({ ok: result.ok, text: result.text, intentMissing: false });
                if (needsInput) {
                    current.status = 'waiting_input';
                    current.note = result.text;
                    const screenshotPath = await captureAssistanceScreenshot();
                    await promptForHumanInput({
                        channel: interaction.channel,
                        actorId: interaction.user.id,
                        mode: 'goal',
                        sessionId: session.id,
                        screenshotPath,
                        prompt: `For goal step ${idx + 1}, what should I do next? (Current issue: ${result.text})`
                    });
                } else {
                    current.status = 'failed';
                    current.note = result.text;
                    if (action === 'approve') {
                        // Keep index on failed step until retry or skip.
                    }
                }
            }
        }

        if (session.currentIndex >= session.steps.length) {
            session.finished = true;
        }

        await interaction.update({
            embeds: [buildGoalEmbed(session)],
            components: buildGoalButtons(session.id, session.finished)
        });
    }

    async function handlePreflightCommand(interaction) {
        const url = interaction.options.getString('url', true);
        const name = interaction.options.getString('name', false) || '';

        const scanEmbed = new EmbedBuilder()
            .setTitle('🐟 Preflight Designer')
            .setDescription(`Scanning **${url}**...\nThis may take 1-3 minutes. Rex is crawling pages, analyzing the DOM, classifying semantic actions, and intercepting API calls.`)
            .setColor(0x06b6d4)
            .setFooter({ text: 'Preflight Designer · Website Compiler' })
            .setTimestamp(new Date());

        await interaction.deferReply();
        await interaction.editReply({ embeds: [scanEmbed] });

        try {
            const { isVenvReady, ensurePreflightVenv, runPreflightScan, copySpecsToOutput } = await import('./preflightDesigner.js');

            if (!isVenvReady()) {
                await interaction.editReply({ embeds: [scanEmbed.setDescription(`Setting up Preflight Designer environment for the first time...`)] });
                const setup = await ensurePreflightVenv();
                if (!setup.ok) {
                    await interaction.editReply({ embeds: [scanEmbed.setDescription(`❌ Setup failed: ${setup.message}`).setColor(0xef4444)] });
                    return;
                }
            }

            const result = await runPreflightScan(url, { name: name || undefined });

            if (!result.ok) {
                await interaction.editReply({ embeds: [scanEmbed.setDescription(`❌ Scan failed: ${result.error}`).setColor(0xef4444)] });
                return;
            }

            const s = result.summary;
            const actionsField = result.actions
                ? result.actions.map(a => {
                    const icon = a.type === 'api' ? '⚡' : '🖱️';
                    const api = a.api_url ? ` → \`${a.api_method} ${a.api_url}\`` : '';
                    return `${icon} **${a.name}** — ${a.description}${api}`;
                }).join('\n')
                : 'None';

            const workflowsField = result.workflows
                ? result.workflows.map(w => `📈 **${w.name}** — ${w.steps.join(' → ')}`).join('\n')
                : 'None';

            const resultEmbed = new EmbedBuilder()
                .setTitle('🐟 Preflight Scan Complete!')
                .setDescription(`Website compiled successfully into navigation specs.`)
                .addFields(
                    { name: 'Project', value: result.project_name, inline: true },
                    { name: 'URL', value: result.url, inline: true },
                    { name: 'Actions', value: `${s.total_actions} (${s.browser_actions} browser, ${s.api_upgrades} API)`, inline: true },
                    { name: 'Workflows', value: `${s.workflows} sequential flows`, inline: true },
                    { name: 'Discovered Actions', value: actionsField.slice(0, 1024) || 'None', inline: false },
                    { name: 'Workflows', value: workflowsField.slice(0, 1024) || 'None', inline: false }
                )
                .setColor(0x22c55e)
                .setFooter({ text: '📦 Generated: preflight.yaml, sdk.py, sdk.ts, tools.json, mcp_server.py' })
                .setTimestamp(new Date());

            // Copy specs and try to attach YAML file
            const specsDir = path.join(process.cwd(), '.rex', 'preflight-specs', result.project_name);
            const copied = copySpecsToOutput(specsDir);
            const yamlPath = path.join(specsDir, 'preflight.yaml');

            const replyPayload = { embeds: [resultEmbed] };
            if (fs.existsSync(yamlPath)) {
                replyPayload.files = [yamlPath];
            }

            await interaction.editReply(replyPayload);

            appendEpisode({
                source: 'preflight',
                objective: `Scan ${url}`,
                step: 'completed',
                success: true,
                resultText: `${s.total_actions} actions, ${s.api_upgrades} API upgrades, ${s.workflows} workflows`
            });

        } catch (e) {
            await interaction.editReply({
                embeds: [scanEmbed.setDescription(`❌ Scan failed: ${e.message}`).setColor(0xef4444)]
            });
        }
    }

    async function handleInteraction(interaction) {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'goal') {
                await handleGoalCommand(interaction);
                return true;
            }
            if (interaction.commandName === 'proactive_start') {
                await handleProactiveStart(interaction);
                return true;
            }
            if (interaction.commandName === 'proactive_stop') {
                const ended = stopProactiveSession(interaction.channelId, 'Stopped via command.');
                await interaction.reply({
                    embeds: [buildProactiveEmbed(ended || { id: '-', objective: '-', runCount: 0, endAt: Date.now(), active: false }, ended ? 'Stopped proactive mode.' : 'No active proactive mode in this channel.')],
                    ephemeral: true
                });
                return true;
            }
            if (interaction.commandName === 'episodes') {
                await handleEpisodes(interaction);
                return true;
            }
            if (interaction.commandName === 'freefall_start') {
                await handleFreefallStart(interaction);
                return true;
            }
            if (interaction.commandName === 'freefall_stop') {
                const ended = await stopFreefallSession(interaction.channelId, 'Stopped via slash command');
                if (!ended) {
                    await interaction.reply({ content: 'No active Freefall session in this channel.', ephemeral: true });
                    return true;
                }

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`freefall_restart_yes:${ended.session.id}`).setLabel('Restart Rex Now').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`freefall_restart_no:${ended.session.id}`).setLabel('Not Now').setStyle(ButtonStyle.Secondary)
                );

                await interaction.reply({
                    content: 'Freefall stopped. Here is the full version/change report. Restart Rex now to apply all runtime changes?',
                    files: [ended.summaryPath],
                    components: [row]
                });
                return true;
            }
            if (interaction.commandName === 'preflight') {
                await handlePreflightCommand(interaction);
                return true;
            }
            return false;
        }

        if (interaction.isButton()) {
            const customId = String(interaction.customId || '');
            const [prefix, action, sessionId] = customId.split(':');
            if (prefix === 'goal') {
                await handleGoalButton(interaction, action, sessionId);
                return true;
            }

            if (prefix === 'freefall_restart_yes' || prefix === 'freefall_restart_no') {
                if (prefix === 'freefall_restart_yes') {
                    await interaction.reply({ content: 'Restart vote accepted. Restarting Rex now...', ephemeral: true });
                    await restartRexProcessFromRuntime();
                    return true;
                }
                await interaction.reply({ content: 'Restart skipped.', ephemeral: true });
                return true;
            }

            if (prefix === 'freefall_major_yes' || prefix === 'freefall_major_no') {
                const reviewId = customId.split(':')[2];
                const ffSessionId = customId.split(':')[1];
                const session = Array.from(freefallSessions.values()).find((s) => s.id === ffSessionId);
                if (!session) {
                    await interaction.reply({ content: 'Freefall session expired.', ephemeral: true });
                    return true;
                }
                const review = session.pendingMajor.find((r) => r.reviewId === reviewId);
                if (!review) {
                    await interaction.reply({ content: 'Review item not found.', ephemeral: true });
                    return true;
                }

                if (prefix === 'freefall_major_no') {
                    session.pendingMajor = session.pendingMajor.filter((r) => r.reviewId !== reviewId);
                    await interaction.reply({ content: 'Skipped this major change request.', ephemeral: true });
                    return true;
                }

                const patch = await generateMinorPatchWithNano({
                    filePath: review.filePath,
                    content: review.contentSnapshot,
                    issue: review.issue
                });

                if (!patch?.apply || typeof patch.newContent !== 'string' || !isEditableSelfCode(review.filePath)) {
                    await interaction.reply({ content: `Major change was not safely applicable: ${patch?.reason || 'unsafe output'}`, ephemeral: true });
                    session.pendingMajor = session.pendingMajor.filter((r) => r.reviewId !== reviewId);
                    return true;
                }

                const changed = await writeIfChanged(review.filePath, patch.newContent);
                const commitMessage = String(patch.commitMessage || `freefall: approved major change in ${path.basename(review.filePath)}`);
                const gitRes = changed ? await tryGitCommit(review.filePath, commitMessage) : { ok: true };

                if (changed) {
                    session.versions.push({
                        ts: new Date().toISOString(),
                        filePath: review.filePath,
                        reason: String(review.issue?.why || review.issue?.title || 'Approved major change'),
                        commitMessage,
                        gitOk: Boolean(gitRes.ok),
                        gitError: gitRes.ok ? '' : String(gitRes.error || '')
                    });
                }

                session.pendingMajor = session.pendingMajor.filter((r) => r.reviewId !== reviewId);
                await interaction.reply({ content: changed ? 'Major change applied and versioned.' : 'No actual code diff was produced.', ephemeral: true });
                return true;
            }

            if (prefix === 'freefall_minor_yes' || prefix === 'freefall_minor_no') {
                const reviewId = customId.split(':')[2];
                const ffSessionId = customId.split(':')[1];
                const session = Array.from(freefallSessions.values()).find((s) => s.id === ffSessionId);
                if (!session) {
                    await interaction.reply({ content: 'Freefall session expired.', ephemeral: true });
                    return true;
                }
                const review = session.pendingMinor.find((r) => r.reviewId === reviewId);
                if (!review) {
                    await interaction.reply({ content: 'Review item not found.', ephemeral: true });
                    return true;
                }

                if (prefix === 'freefall_minor_no') {
                    session.pendingMinor = session.pendingMinor.filter((r) => r.reviewId !== reviewId);
                    await interaction.reply({ content: 'Skipped this minor change request.', ephemeral: true });
                    return true;
                }

                const patch = review.patchProposal;
                if (!patch?.apply || typeof patch.newContent !== 'string' || !isEditableSelfCode(review.filePath)) {
                    await interaction.reply({ content: `Minor change is not safely applicable: ${patch?.reason || 'unsafe output'}`, ephemeral: true });
                    session.pendingMinor = session.pendingMinor.filter((r) => r.reviewId !== reviewId);
                    return true;
                }

                const changed = await writeIfChanged(review.filePath, patch.newContent);
                const commitMessage = String(patch.commitMessage || `freefall: approved minor change in ${path.basename(review.filePath)}`);
                const gitRes = changed ? await tryGitCommit(review.filePath, commitMessage) : { ok: true };

                if (changed) {
                    session.versions.push({
                        ts: new Date().toISOString(),
                        filePath: review.filePath,
                        reason: String(review.issue?.why || review.issue?.title || 'Approved minor change'),
                        commitMessage,
                        gitOk: Boolean(gitRes.ok),
                        gitError: gitRes.ok ? '' : String(gitRes.error || '')
                    });
                }

                session.pendingMinor = session.pendingMinor.filter((r) => r.reviewId !== reviewId);
                await interaction.reply({ content: changed ? 'Minor change applied and versioned.' : 'No actual code diff was produced.', ephemeral: true });
                return true;
            }
            return false;
        }

        return false;
    }

    async function handleMessage(message) {
        const key = keyFor(message.author?.id, message.channel?.id);
        const pending = pendingInputByUserKey.get(key);
        if (!pending) return false;

        const answer = String(message.content || '').trim();
        if (!answer) {
            await message.reply('I am waiting for your answer text so I can continue.');
            return true;
        }

        pendingInputByUserKey.delete(key);

        if (pending.mode === 'goal') {
            const session = goalSessions.get(pending.sessionId);
            if (!session) {
                await message.reply('Goal session expired, so I cannot resume it.');
                return true;
            }

            const idx = session.currentIndex;
            const current = session.steps[idx];
            if (!current) {
                await message.reply('No active goal step to resume.');
                return true;
            }

            const resumedStepText = `${current.text}. User guidance: ${answer}`;
            const result = await executeStepText({
                stepText: resumedStepText,
                actorId: message.author.id,
                channel: message.channel,
                config,
                objective: session.objective,
                mode: 'goal'
            });

            if (result.ok) {
                current.status = 'done';
                current.note = `Resumed with user input: ${answer}`;
                session.currentIndex += 1;
                if (session.currentIndex >= session.steps.length) session.finished = true;
                await message.reply('Thanks, resumed successfully and moved to the next step.');
            } else {
                current.status = 'failed';
                current.note = result.text;
                await message.reply(`I tried with your input but still failed: ${result.text}`);
            }

            await updateGoalCardMessage(session, message.channel);
            return true;
        }

        if (pending.mode === 'proactive') {
            const session = proactiveSessions.get(pending.channelId);
            if (!session) {
                await message.reply('Proactive session expired, so I cannot resume it.');
                return true;
            }

            session.objective = `${session.objective} | User input: ${answer}`;
            await message.reply('Got it. I will continue proactive mode using your input.');
            return true;
        }

        return false;
    }

    return {
        getSlashCommands,
        handleInteraction,
        handleMessage,
        stopAll() {
            pendingInputByUserKey.clear();
            for (const [, session] of freefallSessions.entries()) {
                session.active = false;
                if (session.timer) clearInterval(session.timer);
            }
            freefallSessions.clear();
            for (const [channelId] of proactiveSessions.entries()) {
                stopProactiveSession(channelId, 'Runtime shutdown');
            }
        }
    };
}
