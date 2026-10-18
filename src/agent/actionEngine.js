import { runPreflightAnalysis } from './preflight.js';
import { evaluateXRisk } from './xrisk.js';
import { runDebriefAnalysis } from './debrief.js';

export async function runActionEngine({
    toolName,
    toolArgs,
    sessionMeta,
    historyContext,
    runtime,
    confirm,
    execute
}) {
    const missionPacket = runPreflightAnalysis({
        toolName,
        toolArgs,
        sessionMeta,
        historyContext
    });

    const risk = evaluateXRisk({
        toolName,
        toolArgs,
        missionPacket,
        options: runtime?.options,
        toolPermissions: runtime?.toolPermissions,
        isToolAllowed: runtime?.isToolAllowed,
        writeTools: runtime?.writeTools,
        osGatedTools: runtime?.osGatedTools,
        state: runtime?.state
    });

    if (risk.decision === 'block') {
        return {
            status: 'blocked',
            missionPacket,
            risk,
            result: null,
            debrief: runDebriefAnalysis({
                toolName,
                toolArgs,
                missionPacket,
                riskDecision: risk.decision,
                execution: { durationMs: 0, retries: 0 },
                error: new Error(risk.reason)
            })
        };
    }

    if (risk.decision === 'confirm') {
        const approved = await confirm(risk);
        if (!approved) {
            return {
                status: 'cancelled',
                missionPacket,
                risk,
                result: null,
                debrief: runDebriefAnalysis({
                    toolName,
                    toolArgs,
                    missionPacket,
                    riskDecision: risk.decision,
                    execution: { durationMs: 0, retries: 0 },
                    error: new Error('User denied confirmation')
                })
            };
        }

        if (risk.code === 'os_access_gate' && runtime?.state) {
            runtime.state.osAccessGranted = true;
        }
    }

    const start = Date.now();
    try {
        const execution = await execute();
        const debrief = runDebriefAnalysis({
            toolName,
            toolArgs,
            missionPacket,
            riskDecision: risk.decision,
            execution: {
                durationMs: Date.now() - start,
                retries: Number(execution?.retries || 0)
            },
            error: null
        });

        return {
            status: 'success',
            missionPacket,
            risk,
            result: execution?.result,
            retries: Number(execution?.retries || 0),
            debrief
        };
    } catch (error) {
        if (error?.name === 'AbortError' || error?.message === 'Aborted') {
            throw error;
        }

        const debrief = runDebriefAnalysis({
            toolName,
            toolArgs,
            missionPacket,
            riskDecision: risk.decision,
            execution: {
                durationMs: Date.now() - start,
                retries: 0
            },
            error
        });

        return {
            status: 'error',
            missionPacket,
            risk,
            result: `Tool error: ${error.message}`,
            retries: 0,
            debrief
        };
    }
}
