import { runPreflightAnalysis } from '../src/agent/preflight.js';
import { runPreflightAnalysis as runCompatPreflightAnalysis } from '../xrisk-engine/src/compat/preflight.js';
import { __webToolsPreflightTestHooks } from '../src/webTools.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function runMissionPacketAssertions() {
    const mission = runPreflightAnalysis({
        toolName: 'browser_interact',
        toolArgs: { action: 'click', targetAction: 'click' },
        sessionMeta: { topLevelRequest: 'Open pricing page and click checkout' },
        historyContext: [
            { role: 'assistant', content: 'Overlay blocker detected on checkout button' }
        ]
    });

    assert(mission.preflightVersion === '2.0.0', 'preflightVersion should be 2.0.0');
    assert(mission.toolContext?.action === 'click', 'toolContext.action should be click');
    assert(Array.isArray(mission.executionHints) && mission.executionHints.length > 0, 'executionHints should be populated');
    assert(Array.isArray(mission.riskFlags) && mission.riskFlags.includes('high_precision_browser_step'), 'risk flag high_precision_browser_step missing');

    const compatMission = runCompatPreflightAnalysis({
        toolName: 'browser_interact',
        toolArgs: { action: 'preflight_analyse', targetAction: 'type' },
        sessionMeta: { topLevelRequest: 'Fill login form safely' },
        historyContext: [{ role: 'assistant', content: 'Running diagnose pass before typing' }]
    });

    assert(compatMission.preflightVersion === '2.0.0', 'compat preflightVersion should be 2.0.0');
    assert(Array.isArray(compatMission.executionHints), 'compat executionHints should be present');
}

function runScoringAssertions() {
    const { scoreTargetCandidate, preflightRecommendation } = __webToolsPreflightTestHooks;

    const args = {
        action: 'type',
        text: 'email',
        label: 'email',
        placeholder: 'Email address'
    };

    const strongCandidate = {
        inViewport: true,
        id: '17',
        text: 'Email',
        href: '',
        role: 'textbox',
        tag: 'input',
        placeholder: 'Email address',
        anchorHeading: 'Sign in',
        anchorSection: 'Account',
        label: 'Email',
        formIntent: { primary: 'email', tags: ['email'] },
        actionTags: ['type', 'hover'],
        confidence: 92,
        stability: { stabilityScore: 88 },
        obstruction: { blocked: false }
    };

    const weakCandidate = {
        inViewport: true,
        id: '',
        text: 'Continue',
        href: '',
        role: 'button',
        tag: 'button',
        placeholder: '',
        anchorHeading: '',
        anchorSection: '',
        label: '',
        formIntent: { primary: '', tags: [] },
        actionTags: ['click'],
        confidence: 18,
        stability: { stabilityScore: 12 },
        obstruction: { blocked: true, by: 'cookie dialog', byTag: 'dialog' }
    };

    const strongScore = scoreTargetCandidate(strongCandidate, args);
    const weakScore = scoreTargetCandidate(weakCandidate, args);
    assert(strongScore > weakScore, 'v2 scoring should prefer high-confidence stable candidate over blocked weak candidate');

    const recommendation = preflightRecommendation(
        {
            isBlank: false,
            interactiveCount: 9
        },
        'click',
        { ok: true },
        {
            available: true,
            blockedRatio: 0.32,
            volatility: 0.62,
            topCandidates: [{ id: '17' }]
        }
    );

    assert(recommendation.version === '2.0.0', 'recommendation version should be 2.0.0');
    assert(['medium', 'high'].includes(recommendation.level), 'recommendation level should escalate with risky extension intel');
    assert(Array.isArray(recommendation.actions) && recommendation.actions.length > 0, 'recommendation actions should be present');
    assert(recommendation.actions.some((x) => String(x).includes('overlays') || String(x).includes('stabilize')), 'recommendation should include hardening actions for blocked/volatile page');
}

function run() {
    runMissionPacketAssertions();
    runScoringAssertions();
    console.log('preflight_v2_test: PASS');
}

run();
