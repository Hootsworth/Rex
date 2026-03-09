import fs from 'fs';
import path from 'path';

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

    try {
        const dir = ensureAgentDir();
        const logPath = path.join(dir, 'debrief.log');
        fs.appendFileSync(logPath, `${JSON.stringify(report)}\n`);
    } catch {
        // Debrief logging should never break runtime execution.
    }

    return report;
}
