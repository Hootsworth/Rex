import {
    resolveWebAgentBudget,
    createWebPlanState,
    canRequestPlannerStep,
    notePlannerStepRequested,
    noteWebPlannerIssue,
    noteWebPlannerSuccess,
    advanceWebStepCounter,
    shouldTerminateForBudget
} from '../src/agent/planEngine.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function run() {
    const low = resolveWebAgentBudget({}, { mode: 'low' });
    assert(low.mode === 'low', 'Expected low budget mode');
    assert(low.maxSteps <= 20, 'Low mode should keep maxSteps constrained');

    const custom = resolveWebAgentBudget({}, { mode: 'balanced', maxSteps: 9, maxPlannerCalls: 4 });
    assert(custom.maxSteps === 9, 'Custom maxSteps override failed');
    assert(custom.maxPlannerCalls === 4, 'Custom maxPlannerCalls override failed');

    const plan = createWebPlanState('Collect product pricing', custom);
    assert(canRequestPlannerStep(plan), 'Expected planner step to be available initially');

    notePlannerStepRequested(plan, 'main');
    notePlannerStepRequested(plan, 'main');
    notePlannerStepRequested(plan, 'main');
    notePlannerStepRequested(plan, 'main');
    assert(!canRequestPlannerStep(plan), 'Planner budget gate should close after maxPlannerCalls');

    noteWebPlannerIssue(plan, 'selector_failed', 'Primary selector was stale');
    assert(plan.activeSubplan, 'Issue should create an active subplan when depth allows');
    assert(plan.execution.mode === 'subplan', 'Execution mode should switch to subplan on issue');

    noteWebPlannerSuccess(plan, 'Recovered via alternate selector');
    assert(plan.execution.mode === 'main', 'Execution mode should return to main after subplan success');
    assert(plan.activeSubplan === null, 'Active subplan should clear after success');

    for (let i = 0; i < 9; i++) {
        advanceWebStepCounter(plan);
    }
    const stop = shouldTerminateForBudget(plan);
    assert(stop.stop === true, 'Expected budget termination after step cap');

    console.log('plan_engine_test: PASS');
}

run();
