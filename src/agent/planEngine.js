const WEB_AGENT_BUDGET_PRESETS = {
    low: {
        mode: 'low',
        maxSteps: 18,
        maxPlannerCalls: 12,
        maxSubplanDepth: 1,
        maxRecoveryAttempts: 2,
        plannerComplexity: 'low'
    },
    balanced: {
        mode: 'balanced',
        maxSteps: 28,
        maxPlannerCalls: 22,
        maxSubplanDepth: 2,
        maxRecoveryAttempts: 3,
        plannerComplexity: 'high'
    },
    'max-quality': {
        mode: 'max-quality',
        maxSteps: 40,
        maxPlannerCalls: 34,
        maxSubplanDepth: 3,
        maxRecoveryAttempts: 5,
        plannerComplexity: 'high'
    }
};

function normalizeTaskStatus(status) {
    const s = String(status || '').toLowerCase();
    if (['done', 'complete', 'completed'].includes(s)) return 'done';
    if (['in-progress', 'doing', 'active'].includes(s)) return 'in-progress';
    if (['blocked', 'error', 'failed'].includes(s)) return 'blocked';
    return 'pending';
}

function normalizeTaskList(items = [], prefix = 'T') {
    return (Array.isArray(items) ? items : [])
        .filter(Boolean)
        .map((item, idx) => {
            if (typeof item === 'string') {
                return {
                    id: `${prefix}${idx + 1}`,
                    title: item,
                    status: 'pending'
                };
            }

            return {
                id: String(item.id || `${prefix}${idx + 1}`),
                title: String(item.title || item.name || `${prefix}${idx + 1}`),
                status: normalizeTaskStatus(item.status)
            };
        });
}

export function resolveWebAgentBudget(config = {}, overrides = {}) {
    const configuredMode = String(overrides.mode || config.webAgentBudgetMode || 'balanced').toLowerCase();
    const preset = WEB_AGENT_BUDGET_PRESETS[configuredMode] || WEB_AGENT_BUDGET_PRESETS.balanced;

    const maxSteps = Number.isFinite(Number(overrides.maxSteps)) && Number(overrides.maxSteps) > 0
        ? Number(overrides.maxSteps)
        : preset.maxSteps;

    const maxPlannerCalls = Number.isFinite(Number(overrides.maxPlannerCalls)) && Number(overrides.maxPlannerCalls) > 0
        ? Number(overrides.maxPlannerCalls)
        : preset.maxPlannerCalls;

    const maxSubplanDepth = Number.isFinite(Number(overrides.maxSubplanDepth)) && Number(overrides.maxSubplanDepth) >= 0
        ? Number(overrides.maxSubplanDepth)
        : preset.maxSubplanDepth;

    const maxRecoveryAttempts = Number.isFinite(Number(overrides.maxRecoveryAttempts)) && Number(overrides.maxRecoveryAttempts) >= 0
        ? Number(overrides.maxRecoveryAttempts)
        : preset.maxRecoveryAttempts;

    return {
        mode: preset.mode,
        maxSteps,
        maxPlannerCalls,
        maxSubplanDepth,
        maxRecoveryAttempts,
        plannerComplexity: preset.plannerComplexity
    };
}

export function createWebPlanState(goal, budget) {
    return {
        goal: String(goal || ''),
        budget: {
            ...budget
        },
        counters: {
            steps: 0,
            plannerCalls: 0,
            recoveryAttempts: 0,
            issueCount: 0
        },
        main: {
            objective: String(goal || ''),
            tasks: []
        },
        execution: {
            mode: 'main',
            currentTaskId: ''
        },
        activeSubplan: null,
        timeline: []
    };
}

export function canRequestPlannerStep(planState) {
    return Number(planState?.counters?.plannerCalls || 0) < Number(planState?.budget?.maxPlannerCalls || 0);
}

export function notePlannerStepRequested(planState, reason = 'normal') {
    if (!planState || !planState.counters) return;
    planState.counters.plannerCalls += 1;
    planState.timeline.push({
        at: new Date().toISOString(),
        type: 'planner-call',
        reason: String(reason || 'normal')
    });
}

export function noteWebPlannerIssue(planState, trigger = 'unknown', detail = '') {
    if (!planState || !planState.counters) return;
    planState.counters.issueCount += 1;
    planState.timeline.push({
        at: new Date().toISOString(),
        type: 'issue',
        trigger: String(trigger || 'unknown'),
        detail: String(detail || '').slice(0, 300)
    });

    if (!planState.activeSubplan && planState.budget.maxSubplanDepth > 0) {
        planState.activeSubplan = {
            id: `SP-${Date.now()}`,
            parentTaskId: planState.execution.currentTaskId || '',
            trigger: String(trigger || 'unknown'),
            depth: 1,
            tasks: [
                {
                    id: 'SP1',
                    title: `Resolve ${String(trigger || 'issue').replace(/[_-]/g, ' ')}`,
                    status: 'in-progress'
                }
            ]
        };
        planState.execution.mode = 'subplan';
    }
}

export function noteWebPlannerSuccess(planState, note = '') {
    if (!planState) return;
    planState.timeline.push({
        at: new Date().toISOString(),
        type: 'success',
        note: String(note || '').slice(0, 300)
    });

    if (planState.activeSubplan && planState.execution.mode === 'subplan') {
        for (const step of planState.activeSubplan.tasks) {
            if (step.status !== 'done') step.status = 'done';
        }
        planState.execution.mode = 'main';
        planState.activeSubplan = null;
    }
}

export function noteRecoveryAttempt(planState, strategy = '') {
    if (!planState || !planState.counters) return;
    planState.counters.recoveryAttempts += 1;
    planState.timeline.push({
        at: new Date().toISOString(),
        type: 'recovery',
        strategy: String(strategy || '').slice(0, 120)
    });
}

export function applyWebPlannerPayload(planState, payload) {
    if (!planState || !payload || typeof payload !== 'object') return;

    if (payload.plan && typeof payload.plan === 'object') {
        const objective = String(payload.plan.objective || payload.plan.goal || '').trim();
        if (objective) planState.main.objective = objective;
        if (Array.isArray(payload.plan.tasks)) {
            planState.main.tasks = normalizeTaskList(payload.plan.tasks, 'T');
        }
    }

    if (payload.execution && typeof payload.execution === 'object') {
        if (payload.execution.mode) {
            const nextMode = String(payload.execution.mode).toLowerCase();
            if (nextMode === 'main' || nextMode === 'subplan') {
                planState.execution.mode = nextMode;
            }
        }
        if (payload.execution.currentTaskId) {
            planState.execution.currentTaskId = String(payload.execution.currentTaskId);
        }
    }

    if (payload.subplan && typeof payload.subplan === 'object') {
        planState.activeSubplan = {
            id: String(payload.subplan.id || `SP-${Date.now()}`),
            parentTaskId: String(payload.subplan.parentTaskId || planState.execution.currentTaskId || ''),
            trigger: String(payload.subplan.trigger || 'issue'),
            depth: 1,
            tasks: normalizeTaskList(payload.subplan.steps || payload.subplan.tasks || [], 'SP')
        };
    }
}

export function advanceWebStepCounter(planState) {
    if (!planState || !planState.counters) return;
    planState.counters.steps += 1;
}

export function shouldTerminateForBudget(planState) {
    if (!planState) return { stop: false, reason: '' };

    if (planState.counters.steps >= planState.budget.maxSteps) {
        return {
            stop: true,
            reason: `Step budget exhausted (${planState.counters.steps}/${planState.budget.maxSteps}).`
        };
    }

    if (planState.counters.plannerCalls >= planState.budget.maxPlannerCalls) {
        return {
            stop: true,
            reason: `Planner-call budget exhausted (${planState.counters.plannerCalls}/${planState.budget.maxPlannerCalls}).`
        };
    }

    if (planState.counters.recoveryAttempts > planState.budget.maxRecoveryAttempts) {
        return {
            stop: true,
            reason: `Recovery-attempt budget exhausted (${planState.counters.recoveryAttempts}/${planState.budget.maxRecoveryAttempts}).`
        };
    }

    return { stop: false, reason: '' };
}

export function buildWebPlannerContext(planState, runtime = {}) {
    const mainTasks = planState.main.tasks.slice(0, 8).map((t) => `- [${t.status}] ${t.id}: ${t.title}`).join('\n') || '- (not set)';
    const subplanText = planState.activeSubplan
        ? [
            `Subplan ${planState.activeSubplan.id} (trigger: ${planState.activeSubplan.trigger}, parent: ${planState.activeSubplan.parentTaskId || 'n/a'})`,
            ...planState.activeSubplan.tasks.slice(0, 6).map((t) => `- [${t.status}] ${t.id}: ${t.title}`)
        ].join('\n')
        : 'none';

    return [
        `Budget mode: ${planState.budget.mode}`,
        `Budget usage: steps ${planState.counters.steps}/${planState.budget.maxSteps}, plannerCalls ${planState.counters.plannerCalls}/${planState.budget.maxPlannerCalls}, recoveries ${planState.counters.recoveryAttempts}/${planState.budget.maxRecoveryAttempts}`,
        `Goal: ${planState.goal || '(unset)'}`,
        `Current URL: ${runtime.url || '(unknown)'}`,
        `Current page title: ${runtime.title || '(unknown)'}`,
        `Last result: ${runtime.lastResult || '(none)'}`,
        `Main objective: ${planState.main.objective || '(unset)'}`,
        `Execution mode: ${planState.execution.mode}`,
        `Current task id: ${planState.execution.currentTaskId || '(unset)'}`,
        'Main tasks:',
        mainTasks,
        `Active subplan:\n${subplanText}`
    ].join('\n');
}

export function getBudgetExhaustedMessage(planState, goal = '') {
    const doneCount = planState.main.tasks.filter((t) => t.status === 'done').length;
    const totalCount = planState.main.tasks.length;
    return [
        'Agent stopped to respect budget policy.',
        `Goal: ${String(goal || planState.goal || '').trim()}`,
        `Budget mode: ${planState.budget.mode}`,
        `Usage: steps ${planState.counters.steps}/${planState.budget.maxSteps}, plannerCalls ${planState.counters.plannerCalls}/${planState.budget.maxPlannerCalls}, recoveries ${planState.counters.recoveryAttempts}/${planState.budget.maxRecoveryAttempts}`,
        `Main plan progress: ${doneCount}/${totalCount || '?'} tasks done`,
        planState.activeSubplan ? `Active subplan: ${planState.activeSubplan.id} (${planState.activeSubplan.trigger})` : 'Active subplan: none',
        'Tip: rerun with budgetMode "balanced" or "max-quality" if you want deeper autonomous retries.'
    ].join('\n');
}
