import os from 'os';

function classifyGoal(toolName) {
    const t = String(toolName || '').toLowerCase();
    if (['read_file', 'read_dir', 'fetch_web', 'browser_interact'].includes(t)) return 'inspect';
    if (['write_file', 'patch_file', 'scaffold', 'project_scaffold', 'fix'].includes(t)) return 'modify';
    if (['github_push', 'docker_push', 'deploy'].includes(t)) return 'release';
    if (['os_agent', 'mouse_click', 'type_text'].includes(t)) return 'os_automation';
    return 'general_assist';
}

function buildRiskFlags(toolName, toolArgs) {
    const t = String(toolName || '').toLowerCase();
    const argsText = JSON.stringify(toolArgs || {}).toLowerCase();
    const flags = [];

    if (['manage_power', 'deploy', 'github_push', 'docker_push', 'send_email'].includes(t)) {
        flags.push('external_side_effect');
    }

    if (['write_file', 'patch_file', 'run_shell', 'run_python', 'os_agent', 'mouse_click', 'type_text'].includes(t)) {
        flags.push('local_state_change');
    }

    if (t === 'run_shell' && /(shutdown|restart|format|rm\s+-rf|del\s+\/s|sc\s+stop)/i.test(argsText)) {
        flags.push('destructive_shell_pattern');
    }

    if (['os_agent', 'mouse_click', 'type_text'].includes(t)) {
        flags.push('os_control');
    }

    return flags;
}

export function runPreflightAnalysis({ toolName, toolArgs, sessionMeta, historyContext }) {
    const userGoal = String(sessionMeta?.topLevelRequest || '').trim();
    const recentTurns = Array.isArray(historyContext) ? historyContext.slice(-4).map(m => m?.content || '').join('\n').slice(0, 1000) : '';

    const missionPacket = {
        goal: classifyGoal(toolName),
        userObjective: userGoal || 'unspecified',
        environment: {
            platform: process.platform,
            osRelease: os.release(),
            cwd: process.cwd(),
            timestamp: new Date().toISOString()
        },
        plan: [
            `Validate action for tool ${toolName}`,
            `Execute tool ${toolName}`,
            'Capture output and record debrief'
        ],
        riskFlags: buildRiskFlags(toolName, toolArgs),
        contextSnippet: recentTurns
    };

    return missionPacket;
}
