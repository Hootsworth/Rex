import fs from 'fs';
import path from 'path';

const MAX_DEBRIEF_BYTES = 1024 * 1024; // 1MB
const KEEP_DEBRIEF_LINES = 500;

function ensureAgentDir() {
    const dir = path.join(process.cwd(), '.agent');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function summarizeLearning({ toolName, success, riskDecision }) {
    if (!success) return `${toolName} failed; add fallback or stronger preconditions.`;
    if (riskDecision === 'confirm') return `${toolName} succeeded after explicit safety confirmation.`;
    return `${toolName} completed under normal guardrails.`;
}

export function runDebriefAnalysis({
    toolName,
    toolArgs,
    missionPacket,
    riskDecision,
    execution,
    error
}) {
    const success = !error;
    const report = {
        timestamp: new Date().toISOString(),
        toolName,
        toolArgs,
        goal: missionPacket?.goal || 'unknown',
        riskFlags: missionPacket?.riskFlags || [],
        riskDecision,
        success,
        retries: Number(execution?.retries || 0),
        durationMs: Number(execution?.durationMs || 0),
        error: error ? String(error.message || error) : null,
        learning: summarizeLearning({ toolName, success, riskDecision })
    };

    // Debrief is operational telemetry: bounded, best-effort, and non-blocking.
    try {
        const dir = ensureAgentDir();
        const logPath = path.join(dir, 'debrief.log');

        setImmediate(() => {
            try {
                if (fs.existsSync(logPath)) {
                    const stat = fs.statSync(logPath);
                    if (stat.size > MAX_DEBRIEF_BYTES) {
                        const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
                        const trimmed = lines.slice(-KEEP_DEBRIEF_LINES).join('\n');
                        fs.writeFileSync(logPath, trimmed ? `${trimmed}\n` : '');
                    }
                }
                fs.appendFileSync(logPath, `${JSON.stringify(report)}\n`);
            } catch {
                // Telemetry errors are intentionally swallowed.
            }
        });
    } catch {
        // Debrief logging should never break runtime execution.
    }

    return report;
}
