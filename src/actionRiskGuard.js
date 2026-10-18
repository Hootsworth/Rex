/**
 * actionRiskGuard.js — Action Risk Classification & Safety Guardrails
 *
 * Categorizes desktop actions into SAFE, MODERATE, and HIGH_RISK tiers.
 * Prevents unintended destructive OS operations (file deletions, payments,
 * password alterations, or critical system modifications).
 */

export const RiskLevel = {
    SAFE: 'SAFE',
    MODERATE: 'MODERATE',
    HIGH_RISK: 'HIGH_RISK'
};

const HIGH_RISK_PATTERNS = [
    /\b(?:delete|remove|erase|format|purge|drop\s+database|rm\s+-rf)\b/i,
    /\b(?:buy\s+now|place\s+order|checkout|pay\s+now|credit\s*card|purchase)\b/i,
    /\b(?:password|master\s*key|private\s*key|secret|api\s*key)\b/i,
    /\b(?:shutdown|reboot|restart|factory\s*reset)\b/i,
    /\b(?:uninstall|killall|erase\s+all)\b/i
];

const MODERATE_PATTERNS = [
    /\b(?:send|publish|post|tweet|deploy|push\s+to|commit|overwrite)\b/i,
    /\b(?:save\s+as|export\s+project|overwrite\s+file)\b/i
];

/**
 * Classify the risk tier of a planned UI action or user instruction.
 * @param {string} text User command or step description
 * @param {string} [elementLabel=''] Label of UI element being interacted with
 * @returns {{ level: 'SAFE'|'MODERATE'|'HIGH_RISK', reason: string, requiresExplicitPrompt: boolean }}
 */
export function classifyActionRisk(text = '', elementLabel = '') {
    const combined = `${text} ${elementLabel}`.toLowerCase();

    for (const pattern of HIGH_RISK_PATTERNS) {
        if (pattern.test(combined)) {
            return {
                level: RiskLevel.HIGH_RISK,
                reason: `Detected potentially irreversible or security-sensitive keyword: "${pattern.source}"`,
                requiresExplicitPrompt: true
            };
        }
    }

    for (const pattern of MODERATE_PATTERNS) {
        if (pattern.test(combined)) {
            return {
                level: RiskLevel.MODERATE,
                reason: `External action or file modification: "${pattern.source}"`,
                requiresExplicitPrompt: false
            };
        }
    }

    return {
        level: RiskLevel.SAFE,
        reason: 'Standard non-destructive desktop navigation or reading',
        requiresExplicitPrompt: false
    };
}
