import pc from 'picocolors';
import fs from 'fs';
import path from 'path';

/**
 * Approximate per-model pricing (USD per 1M tokens)
 * Prices for input tokens; output is typically 3-5x higher but we estimate conservatively.
 */
const MODEL_PRICING = {
    'ollama':       { input: 0, output: 0, label: 'Ollama (Free/Local)' },
    'local-llama':  { input: 0, output: 0, label: 'Local Llama (Free/Local)' },
    'openai':       { input: 0.15, output: 0.60, label: 'OpenAI gpt-4o-mini' },
    'gemini':       { input: 0.075, output: 0.30, label: 'Gemini 2.5 Flash' },
    'claude':       { input: 0.25, output: 1.25, label: 'Claude 3 Haiku' },
    'deepseek':     { input: 0.14, output: 0.28, label: 'Deepseek Chat' }
};

const LEDGER_PATH = path.join(process.cwd(), '.agent', 'cost-ledger.json');
const SESSIONS_DIR = path.join(process.cwd(), '.agent', 'sessions');

function ensureLedger() {
    const dir = path.dirname(LEDGER_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(LEDGER_PATH)) {
        const now = new Date().toISOString();
        const seed = {
            version: 1,
            createdAt: now,
            updatedAt: now,
            totalCost: 0,
            totalCalls: 0,
            totalTokens: 0,
            byModel: {}
        };
        fs.writeFileSync(LEDGER_PATH, JSON.stringify(seed, null, 2), 'utf-8');
    }
}

function readLedger() {
    try {
        ensureLedger();
        const raw = fs.readFileSync(LEDGER_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid ledger payload');
        if (!parsed.byModel || typeof parsed.byModel !== 'object') parsed.byModel = {};
        parsed.totalCost = Number(parsed.totalCost || 0);
        parsed.totalCalls = Number(parsed.totalCalls || 0);
        parsed.totalTokens = Number(parsed.totalTokens || 0);
        return parsed;
    } catch {
        const now = new Date().toISOString();
        return {
            version: 1,
            createdAt: now,
            updatedAt: now,
            totalCost: 0,
            totalCalls: 0,
            totalTokens: 0,
            byModel: {}
        };
    }
}

function writeLedger(ledger) {
    ensureLedger();
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf-8');
}

function modelLabel(modelName) {
    return (MODEL_PRICING[modelName] || MODEL_PRICING['ollama']).label;
}

export function addUsageToLedger(modelName, inputTokens, outputTokens, cost) {
    const ledger = readLedger();
    const key = String(modelName || 'ollama');
    const totalTokens = Number(inputTokens || 0) + Number(outputTokens || 0);
    const model = ledger.byModel[key] || {
        label: modelLabel(key),
        cost: 0,
        calls: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0
    };

    model.label = modelLabel(key);
    model.cost += Number(cost || 0);
    model.calls += 1;
    model.totalTokens += totalTokens;
    model.inputTokens += Number(inputTokens || 0);
    model.outputTokens += Number(outputTokens || 0);

    ledger.byModel[key] = model;
    ledger.totalCost += Number(cost || 0);
    ledger.totalCalls += 1;
    ledger.totalTokens += totalTokens;
    ledger.updatedAt = new Date().toISOString();

    writeLedger(ledger);
    return ledger;
}

export function getCostLedgerSummary() {
    const ledger = readLedger();
    const rows = Object.entries(ledger.byModel)
        .map(([model, data]) => ({
            model,
            label: String(data.label || modelLabel(model)),
            cost: Number(data.cost || 0),
            calls: Number(data.calls || 0),
            totalTokens: Number(data.totalTokens || 0)
        }))
        .sort((a, b) => b.cost - a.cost);

    return {
        path: LEDGER_PATH,
        totalCost: Number(ledger.totalCost || 0),
        totalCalls: Number(ledger.totalCalls || 0),
        totalTokens: Number(ledger.totalTokens || 0),
        updatedAt: ledger.updatedAt || '',
        byModel: rows
    };
}

export function resetCostLedger() {
    const now = new Date().toISOString();
    const fresh = {
        version: 1,
        createdAt: now,
        updatedAt: now,
        totalCost: 0,
        totalCalls: 0,
        totalTokens: 0,
        byModel: {}
    };
    writeLedger(fresh);
    return fresh;
}

export function rebuildLedgerFromSavedSessions() {
    const now = new Date().toISOString();
    const rebuilt = {
        version: 1,
        createdAt: now,
        updatedAt: now,
        totalCost: 0,
        totalCalls: 0,
        totalTokens: 0,
        byModel: {}
    };

    if (!fs.existsSync(SESSIONS_DIR)) {
        writeLedger(rebuilt);
        return { sessionsProcessed: 0, callsEstimated: 0, ledger: rebuilt };
    }

    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    let sessionsProcessed = 0;
    let callsEstimated = 0;

    for (const file of files) {
        try {
            const fullPath = path.join(SESSIONS_DIR, file);
            const session = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            const history = Array.isArray(session?.history) ? session.history : [];
            const modelName = String(session?.model || 'ollama');
            const label = modelLabel(modelName);

            if (!rebuilt.byModel[modelName]) {
                rebuilt.byModel[modelName] = {
                    label,
                    cost: 0,
                    calls: 0,
                    totalTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0
                };
            }

            for (let i = 0; i < history.length; i++) {
                const msg = history[i];
                if (!msg || msg.role !== 'assistant') continue;

                const priorContext = history
                    .slice(0, i)
                    .map((m) => String(m?.content || ''))
                    .join('\n');
                const response = String(msg?.content || '');

                const inputTokens = estimateTokens(priorContext);
                const outputTokens = estimateTokens(response);
                const { cost } = calculateCost(modelName, inputTokens, outputTokens);

                rebuilt.byModel[modelName].cost += cost;
                rebuilt.byModel[modelName].calls += 1;
                rebuilt.byModel[modelName].totalTokens += inputTokens + outputTokens;
                rebuilt.byModel[modelName].inputTokens += inputTokens;
                rebuilt.byModel[modelName].outputTokens += outputTokens;

                rebuilt.totalCost += cost;
                rebuilt.totalCalls += 1;
                rebuilt.totalTokens += inputTokens + outputTokens;
                callsEstimated += 1;
            }

            sessionsProcessed += 1;
        } catch {
            // Skip corrupt session files.
        }
    }

    rebuilt.updatedAt = new Date().toISOString();
    writeLedger(rebuilt);
    return { sessionsProcessed, callsEstimated, ledger: rebuilt };
}

export function formatCostLedgerSummary(summary) {
    const lines = [];
    lines.push(pc.bold('Lifetime Usage (this workspace)'));
    lines.push(`Total cost: ${summary.totalCost > 0 ? `$${summary.totalCost.toFixed(4)}` : 'FREE'}`);
    lines.push(`Total calls: ${summary.totalCalls}`);
    lines.push(`Total tokens: ~${summary.totalTokens}`);

    if (!summary.byModel.length) {
        lines.push(pc.dim('No model usage recorded yet.'));
    } else {
        lines.push('By model:');
        for (const row of summary.byModel) {
            const costText = row.cost > 0 ? `$${row.cost.toFixed(4)}` : 'FREE';
            lines.push(`- ${row.label}: ${costText} (${row.calls} calls, ~${row.totalTokens} tokens)`);
        }
    }

    if (summary.updatedAt) {
        lines.push(pc.dim(`Updated: ${summary.updatedAt}`));
    }
    lines.push(pc.dim(`Ledger: ${summary.path}`));
    return lines.join('\n');
}

/**
 * Rough token estimate: ~4 characters per token for English text
 */
export function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
}

/**
 * Calculates cost for a single AI call
 * @param {string} modelName - The resolved model name
 * @param {number} inputTokens - Estimated input tokens
 * @param {number} outputTokens - Estimated output tokens
 * @returns {{ cost: number, label: string }}
 */
export function calculateCost(modelName, inputTokens, outputTokens) {
    const pricing = MODEL_PRICING[modelName] || MODEL_PRICING['ollama'];
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    return {
        cost: inputCost + outputCost,
        label: pricing.label
    };
}

/**
 * Session cost tracker — accumulates costs across a chat session
 */
export class CostTracker {
    constructor() {
        this.totalCost = 0;
        this.callCount = 0;
    }

    /**
     * Records a single AI call's cost
     * @param {string} modelName
     * @param {string} promptText - The full prompt sent
     * @param {string} responseText - The AI response
     * @returns {string} A formatted cost line for display
     */
    track(modelName, promptText, responseText) {
        const inputTokens = estimateTokens(promptText);
        const outputTokens = estimateTokens(responseText);
        const { cost, label } = calculateCost(modelName, inputTokens, outputTokens);

        addUsageToLedger(modelName, inputTokens, outputTokens, cost);
        
        this.totalCost += cost;
        this.callCount++;

        if (cost === 0) {
            return pc.dim(`[${label} · Free · ~${inputTokens + outputTokens} tokens]`);
        }

        return pc.dim(`[${label} · $${cost.toFixed(6)} · ~${inputTokens + outputTokens} tokens · Session: $${this.totalCost.toFixed(4)}]`);
    }

    /**
     * Returns a summary string for session end
     */
    summary() {
        if (this.totalCost === 0) {
            return pc.green(`💰 Session cost: FREE (${this.callCount} AI calls, all local)`);
        }
        return pc.yellow(`💰 Session cost: $${this.totalCost.toFixed(4)} across ${this.callCount} AI calls`);
    }
}
