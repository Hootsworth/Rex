const HIGH_RISK_TOOLS = new Set([
    'manage_power',
    'deploy',
    'github_push',
    'docker_push',
    'send_email'
]);

export function evaluateXRisk({
    toolName,
    toolArgs,
    missionPacket,
    options,
    toolPermissions,
    isToolAllowed,
    writeTools,
    osGatedTools,
    state
}) {
    const t = String(toolName || '').toLowerCase();
    const args = toolArgs || {};

    if (toolPermissions && typeof isToolAllowed === 'function') {
        const permCheck = isToolAllowed(toolName, toolPermissions);
        if (!permCheck.allowed) {
            return {
                decision: 'block',
                level: 'high',
                reason: `Tool blocked by policy: ${permCheck.reason}`,
                code: 'permissions'
            };
        }
    }

    if (options?.readonly && Array.isArray(writeTools) && writeTools.includes(toolName)) {
        return {
            decision: 'block',
            level: 'high',
            reason: `${toolName} is not allowed in readonly mode.`,
            code: 'readonly'
        };
    }

    if (Array.isArray(osGatedTools) && osGatedTools.includes(toolName) && !state?.osAccessGranted) {
        return {
            decision: 'confirm',
            level: 'medium',
            reason: 'Allow Rex to access OS automation controls for this chat session?',
            code: 'os_access_gate',
            once: true
        };
    }

    const flags = missionPacket?.riskFlags || [];
    if (flags.includes('destructive_shell_pattern')) {
        return {
            decision: 'confirm',
            level: 'high',
            reason: 'Potentially destructive shell pattern detected. Continue?',
            code: 'destructive_shell_pattern'
        };
    }

    if (HIGH_RISK_TOOLS.has(t)) {
        return {
            decision: 'confirm',
            level: 'medium',
            reason: `High-impact action via ${toolName}. Continue?`,
            code: 'high_risk_action'
        };
    }

    return {
        decision: 'allow',
        level: 'low',
        reason: 'No additional risk constraints triggered.',
        code: 'allow'
    };
}
