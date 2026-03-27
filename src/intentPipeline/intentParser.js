import { runCompletion, runCompletionWithTarget } from '../ai.js';
import { resolveModelAlias } from '../config.js';

const SUPPORTED_ACTIONS = [
    'send_file',
    'read_file',
    'transcribe_audio',
    'index_files',
    'search_files',
    'help'
];

function extractJson(text = '') {
    const trimmed = String(text || '').trim();
    const block = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = block ? block[1].trim() : trimmed;

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    return JSON.parse(candidate);
}

function normalizeIntent(intent = {}, raw = '') {
    const action = String(intent.action || '').toLowerCase();
    return {
        action: SUPPORTED_ACTIONS.includes(action) ? action : 'help',
        query: String(intent.query || '').trim(),
        time: String(intent.time || '').trim(),
        file_path: String(intent.file_path || intent.filePath || '').trim(),
        note: String(intent.note || '').trim(),
        confirmed: Boolean(intent.confirmed),
        raw: String(raw || '')
    };
}

function buildPrompt(input) {
    return [
        'You convert user requests into a strict JSON intent object.',
        `Allowed actions: ${SUPPORTED_ACTIONS.join(', ')}`,
        'Return ONLY valid JSON with keys: action, query, time, file_path, confirmed, note.',
        'If user requests sending a file use action=send_file and set query/time.',
        'If user asks to read/open/summarize file use action=read_file.',
        'If user asks transcript from audio/voice use action=transcribe_audio.',
        'If user asks to refresh/search index use action=index_files or search_files.',
        'If unclear use action=help and explain in note.',
        `User input: ${input}`
    ].join('\n');
}

function getIntentTarget(config = {}) {
    const preferred = String(config.intentProvider || '').toLowerCase();
    const fromModel = resolveModelAlias(config.aiModel || '').toLowerCase();
    const provider = preferred || fromModel;

    if (provider === 'gemini') {
        return { provider: 'gemini', model: config.geminiModel || 'gemini-2.5-flash' };
    }
    if (provider === 'openai') {
        return { provider: 'openai', model: config.openaiModel || 'gpt-5-mini' };
    }
    if (provider === 'claude') {
        return { provider: 'claude', model: 'claude-3-haiku-20240307' };
    }
    if (provider === 'deepseek') {
        return { provider: 'deepseek', model: 'deepseek-chat' };
    }
    if (provider === 'ollama-http') {
        return { provider: 'ollama-http', model: config.intentOllamaModel || 'llama3:latest' };
    }

    return null;
}

async function parseViaOllamaHttp(prompt, model) {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false })
    });
    if (!response.ok) {
        throw new Error(`Ollama HTTP failed (${response.status})`);
    }
    const payload = await response.json();
    return String(payload.response || '');
}

function parseByRules(input) {
    const text = String(input || '').toLowerCase();
    if (text.includes('send') && (text.includes('file') || text.includes('hw') || text.includes('homework'))) {
        return normalizeIntent({
            action: 'send_file',
            query: text.includes('hw') ? 'hw' : '',
            time: text.includes('yesterday') ? 'yesterday' : '',
            confirmed: text.includes('confirm')
        }, input);
    }
    if (text.includes('read') || text.includes('open')) {
        return normalizeIntent({ action: 'read_file', query: input }, input);
    }
    if (text.includes('transcribe') || text.includes('voice') || text.includes('audio')) {
        return normalizeIntent({ action: 'transcribe_audio', query: input }, input);
    }
    if (text.includes('index')) {
        return normalizeIntent({ action: 'index_files', query: input }, input);
    }
    return normalizeIntent({ action: 'help', note: 'Could not confidently parse this request.' }, input);
}

export async function parseIntent(input = '', config = {}) {
    const target = getIntentTarget(config);
    const prompt = buildPrompt(input);

    try {
        let output = '';
        if (target?.provider === 'ollama-http') {
            output = await parseViaOllamaHttp(prompt, target.model);
        } else if (target) {
            output = await runCompletionWithTarget([{ role: 'user', content: prompt }], target);
        } else {
            output = await runCompletion([{ role: 'user', content: prompt }]);
        }
        return normalizeIntent(extractJson(output), input);
    } catch {
        return parseByRules(input);
    }
}
