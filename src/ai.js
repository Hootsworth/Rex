import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, resolveModelAlias } from './config.js';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import gradient from 'gradient-string';
import { spawn } from 'child_process';
import { LlamaChatSession } from 'node-llama-cpp';
import { MODELS_DIR } from './config.js';

export const MODELS_CONFIG = {
    'rex-fast': {
        name: 'Rex-Fast (Llama 3.2 1B)',
        uri: 'hf:mradermacher/Llama-3.2-1B-Instruct-GGUF/Llama-3.2-1B-Instruct.Q4_K_M.gguf',
        desc: 'Lightweight, low RAM usage.'
    },
    'rex-balanced': {
        name: 'Rex-Balanced (Llama 3.2 3B)',
        uri: 'hf:mradermacher/Llama-3.2-3B-Instruct-GGUF/Llama-3.2-3B-Instruct.Q4_K_M.gguf',
        desc: 'Good balance of quality and speed.'
    },
    'rex-coder': {
        name: 'Rex-Coder (DeepSeek 1.3B)',
        uri: 'hf:mradermacher/DeepSeek-Coder-V2-Lite-Instruct-GGUF/DeepSeek-Coder-V2-Lite-Instruct.Q4_K_M.gguf',
        desc: 'Optimized for programming tasks.'
    },
    'rex-max': {
        name: 'Rex-Max (Mistral 7B)',
        uri: 'hf:mradermacher/Mistral-7B-Instruct-v0.3-GGUF/Mistral-7B-Instruct-v0.3.Q4_K_M.gguf',
        desc: 'High performance (requires 8GB+ RAM).'
    }
};

let llamaInstance = null;
let modelInstance = null;
let contextInstance = null;
let loadedLocalModelId = null;
let openaiClientInstance = null;
let openaiClientKey = '';
let localLlamaPromptChain = Promise.resolve();


export async function checkOllamaStatus() {
    return new Promise((resolve) => {
        try {
            const child = spawn('ollama', ['--version'], { shell: false, windowsHide: true });
            let stdout = '';

            child.stdout.on('data', (d) => {
                stdout += d.toString();
            });

            child.on('error', () => resolve(false));
            child.on('close', (code) => {
                resolve(code === 0 && stdout.toLowerCase().includes('ollama version'));
            });
        } catch {
            resolve(false);
        }
    });
}

function buildOllamaEnv(forceCpu = false) {
    if (!forceCpu) return process.env;
    return {
        ...process.env,
        OLLAMA_LLM_LIBRARY: 'cpu',
        OLLAMA_NUM_GPU: '0'
    };
}

export async function queryOllama(prompt, model = 'llama3:latest', signal = null, options = {}) {
    const forceCpu = !!options.forceCpu;
    return new Promise((resolve, reject) => {
        const child = spawn('ollama', ['run', model], {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: buildOllamaEnv(forceCpu)
        });
        let output = '';

        if (signal) {
            signal.addEventListener('abort', () => {
                child.kill();
                reject(new Error('Aborted'));
            });
        }

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            // ignore stderr unless error
        });

        child.on('close', (code) => {
            if (code === 0) resolve(output);
            else reject(new Error('Ollama process exited with code ' + code));
        });

        // Send prompt to ollama
        child.stdin.write(prompt);
        child.stdin.end();
    });
}

export async function runCompletion(messages, signal = null, complexity = 'high') {
    // Backward compatibility: older callers passed booleans as the 2nd arg
    // expecting a "raw" mode. We now always return plain text, so treat
    // boolean signal values as "no abort signal" to avoid SDK type errors.
    if (typeof signal === 'boolean') {
        signal = null;
    }

    // Backward compatibility: callers may pass complexity as non-string values.
    if (typeof complexity !== 'string') {
        complexity = 'high';
    }

    const config = loadConfig();
    const resolvedModel = resolveModelAlias(config.aiModel);

    // Ensure messages is in the correct format for role-based APIs
    const formattedMessages = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];

    if (resolvedModel === 'openai') {
        if (!config.openaiKey) throw new Error('OpenAI key is missing! Please configure it in Settings.');
        const openai = getOpenAIClient(config.openaiKey);
        const allowedOpenAIModels = new Set(['gpt-5-nano', 'gpt-4o-mini', 'gpt-5-mini']);
        const configuredOpenAIModel = String(config.openaiModel || 'gpt-5-mini').trim();
        const targetModel = allowedOpenAIModels.has(configuredOpenAIModel)
            ? configuredOpenAIModel
            : 'gpt-5-mini';

        const response = await createOpenAICompletionWithRetry(openai, {
            model: targetModel,
            messages: formattedMessages,
        }, signal);
        return extractOpenAIText(response);

    } else if (resolvedModel === 'deepseek') {
        if (!config.deepseekKey) throw new Error('Deepseek key is missing! Please configure it in Settings.');
        const deepseek = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: config.deepseekKey });
        const response = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: formattedMessages,
        }, { signal });
        return response.choices[0].message.content;

    } else if (resolvedModel === 'gemini') {
        if (!config.geminiKey) throw new Error('Gemini key is missing! Please configure it in Settings.');
        if (signal?.aborted) throw new Error('Aborted');
        const genAI = new GoogleGenerativeAI(config.geminiKey);
        const allowedGeminiModels = new Set(['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite']);
        const configuredGeminiModel = String(config.geminiModel || 'gemini-2.5-flash').trim();
        const selectedGeminiModel = allowedGeminiModels.has(configuredGeminiModel)
            ? configuredGeminiModel
            : 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({ model: selectedGeminiModel });
        
        const combinedPrompt = formattedMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        
        // Wrap in abort-aware promise
        const resultPromise = model.generateContent(combinedPrompt);
        const abortPromise = signal ? new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        }) : null;
        
        const result = abortPromise ? await Promise.race([resultPromise, abortPromise]) : await resultPromise;
        return result.response.text();

    } else if (resolvedModel === 'claude') {
        if (!config.claudeKey) throw new Error('Claude key is missing! Please configure it in Settings.');
        const anthropic = new Anthropic({ apiKey: config.claudeKey });
        
        // Separate system message for Anthropic
        const systemMessage = formattedMessages.find(m => m.role === 'system')?.content || '';
        const chatMessages = formattedMessages.filter(m => m.role !== 'system');

        const msg = await anthropic.messages.create({
            model: 'claude-3-haiku-20240307',
            max_tokens: 4096,
            system: systemMessage,
            messages: chatMessages
        }, { abortSignal: signal });
        return msg.content[0].text;

    } else if (resolvedModel === 'local-llama') {
        const lastUserMessage = formattedMessages.filter(m => m.role === 'user').pop()?.content || '';
        try {
            return await promptLocalLlamaWithRecovery(lastUserMessage, signal, config);
        } catch (e) {
            const allowOllamaFallback = config.localLlamaFallbackToOllama !== false;
            if (!allowOllamaFallback) throw e;
            const combinedPrompt = formattedMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
            const forceCpu = !!config.ollamaForceCpu || process.env.POWER_CLI_OLLAMA_FORCE_CPU === '1';
            return await queryOllama(combinedPrompt, config.ollamaModel, signal, { forceCpu });
        }
    } else {
        // Use Ollama locally
        try {
            const combinedPrompt = formattedMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
            const forceCpu = !!config.ollamaForceCpu || process.env.POWER_CLI_OLLAMA_FORCE_CPU === '1';
            return await queryOllama(combinedPrompt, config.ollamaModel, signal, { forceCpu });
        } catch (e) {
            throw new Error(`Failed to run local model via Ollama: ${e.message}\nPlease ensure Ollama is installed.`);
        }
    }
}

function isRecoverableLocalLlamaError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    if (!msg) return false;
    return [
        'inconsistent sequence positions',
        'failed to initialize batch',
        'llama_decode: failed to decode',
        'vk::device::allocatememory',
        'erroroutofdevicememory',
        'ggml_vulkan',
        'context full',
        'kv cache'
    ].some((needle) => msg.includes(needle));
}

function trimPromptForLocal(prompt, maxChars) {
    const p = String(prompt || '');
    if (!maxChars || p.length <= maxChars) return p;
    return `[Local optimization: prompt trimmed to last ${maxChars} chars for stability.]\n${p.slice(-maxChars)}`;
}

async function withLocalLlamaLock(task) {
    const run = localLlamaPromptChain.then(() => task(), () => task());
    localLlamaPromptChain = run.catch(() => {});
    return run;
}

async function promptLocalLlamaWithRecovery(prompt, signal, config) {
    const retries = Math.max(0, Number(config.localLlamaRetries ?? 2));
    const maxChars = Math.max(1000, Number(config.localLlamaMaxPromptChars ?? 7000));
    const safePrompt = trimPromptForLocal(prompt, maxChars);

    return await withLocalLlamaLock(async () => {
        let lastErr = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (signal?.aborted) throw new Error('Aborted');
            try {
                const { session } = await getLocalLlama(attempt > 0);
                return await session.prompt(safePrompt, {
                    signal,
                    onToken: () => {}
                });
            } catch (err) {
                lastErr = err;
                if (signal?.aborted) throw new Error('Aborted');
                if (!isRecoverableLocalLlamaError(err) || attempt === retries) {
                    throw err;
                }

                // Force a context/session reset before retrying recoverable decode/cache faults.
                try {
                    const { session } = await getLocalLlama(true);
                    if (session?.sequence?.clearHistory) {
                        await session.sequence.clearHistory();
                    }
                } catch {
                    // Best effort; next retry will reconstruct session if needed.
                }
            }
        }

        throw lastErr || new Error('Local Llama failed without an explicit error.');
    });
}

export async function runCompletionWithTarget(messages, target = {}, signal = null) {
    if (typeof signal === 'boolean') signal = null;

    const config = loadConfig();
    const formattedMessages = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];
    const provider = String(target.provider || '').toLowerCase();
    const model = String(target.model || '').trim();

    if (!provider || !model) {
        return await runCompletion(formattedMessages, signal, 'high');
    }

    if (provider === 'openai') {
        if (!config.openaiKey) throw new Error('OpenAI key is missing! Please configure it in Settings.');
        const openai = getOpenAIClient(config.openaiKey);
        const response = await createOpenAICompletionWithRetry(openai, {
            model,
            messages: formattedMessages,
        }, signal);
        return extractOpenAIText(response);
    }

    if (provider === 'gemini') {
        if (!config.geminiKey) throw new Error('Gemini key is missing! Please configure it in Settings.');
        if (signal?.aborted) throw new Error('Aborted');
        const genAI = new GoogleGenerativeAI(config.geminiKey);
        const gm = genAI.getGenerativeModel({ model });
        const combinedPrompt = formattedMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

        const resultPromise = gm.generateContent(combinedPrompt);
        const abortPromise = signal ? new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        }) : null;

        const result = abortPromise ? await Promise.race([resultPromise, abortPromise]) : await resultPromise;
        return result.response.text();
    }

    // Unsupported target provider: fall back to default routing.
    return await runCompletion(formattedMessages, signal, 'high');
}

function getOpenAIClient(apiKey) {
    if (!openaiClientInstance || openaiClientKey !== apiKey) {
        openaiClientInstance = new OpenAI({ apiKey });
        openaiClientKey = apiKey;
    }
    return openaiClientInstance;
}

function sleepWithAbort(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Aborted'));
            return;
        }

        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(new Error('Aborted'));
        };

        const cleanup = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
        };

        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

function parseRetryAfterMs(err) {
    const retryAfter = err?.response?.headers?.['retry-after'];
    if (!retryAfter) return 0;

    const asNumber = Number(retryAfter);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
        return Math.round(asNumber * 1000);
    }

    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
        return Math.max(0, asDate - Date.now());
    }

    return 0;
}

function shouldRetryOpenAIError(err) {
    const status = Number(err?.status || err?.response?.status || 0);
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500 && status < 600) return true;

    const message = String(err?.message || '').toLowerCase();
    if (!message) return false;
    return message.includes('timeout') || message.includes('timed out') || message.includes('econnreset') || message.includes('enotfound') || message.includes('rate limit');
}

function extractOpenAIText(response) {
    const choice = response?.choices?.[0];
    const msg = choice?.message || {};

    if (typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content;
    }

    if (Array.isArray(msg.content)) {
        const parts = msg.content
            .map((part) => {
                if (!part) return '';
                if (typeof part === 'string') return part;
                if (typeof part.text === 'string') return part.text;
                if (typeof part.content === 'string') return part.content;
                return '';
            })
            .filter(Boolean);
        if (parts.length) return parts.join('\n');
    }

    if (typeof msg.refusal === 'string' && msg.refusal.trim()) {
        return msg.refusal;
    }

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        return JSON.stringify({ tool_calls: msg.tool_calls });
    }

    return '';
}

async function createOpenAICompletionWithRetry(openai, payload, signal) {
    const maxAttempts = 4;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) throw new Error('Aborted');

        const timeoutSignal = AbortSignal.timeout(90000);
        const composedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        try {
            return await openai.chat.completions.create(payload, { signal: composedSignal });
        } catch (err) {
            lastErr = err;
            if (signal?.aborted) throw new Error('Aborted');

            if (!shouldRetryOpenAIError(err) || attempt === maxAttempts) {
                const status = Number(err?.status || err?.response?.status || 0);
                const detail = status ? ` (HTTP ${status})` : '';
                throw new Error(`OpenAI request failed${detail}: ${err?.message || 'Unknown error'}`);
            }

            const retryAfterMs = parseRetryAfterMs(err);
            const jitter = Math.floor(Math.random() * 250);
            const backoffMs = Math.min(6000, 400 * Math.pow(2, attempt - 1)) + jitter;
            const waitMs = Math.max(retryAfterMs, backoffMs);
            await sleepWithAbort(waitMs, signal);
        }
    }

    throw new Error(`OpenAI request failed: ${lastErr?.message || 'Unknown error'}`);
}

let chatSessionInstance = null;

export async function getLocalLlama(stateless = false) {
    const config = loadConfig();
    const modelId = config.selectedLocalModel || 'rex-fast';
    const modelEntry = MODELS_CONFIG[modelId];
    const modelPath = path.join(MODELS_DIR, `${modelId}.gguf`);

    if (!fs.existsSync(modelPath)) {
        throw new Error(`Model ${modelId} not found at ${modelPath}. Please download it in Settings.`);
    }

    if (!llamaInstance) {
        const { getLlama } = await import('node-llama-cpp');
        const preferCpu = !!config.localLlamaForceCpu || process.env.POWER_CLI_LOCAL_LLAMA_FORCE_CPU === '1';
        if (preferCpu) {
            try {
                llamaInstance = await getLlama({ gpu: false });
            } catch {
                llamaInstance = await getLlama();
            }
        } else {
            llamaInstance = await getLlama();
        }
    }

    if (loadedLocalModelId && loadedLocalModelId !== modelId) {
        modelInstance = null;
        contextInstance = null;
        chatSessionInstance = null;
    }

    if (!modelInstance) {
        modelInstance = await llamaInstance.loadModel({ modelPath });
        contextInstance = await modelInstance.createContext();
        chatSessionInstance = new LlamaChatSession({ contextSequence: contextInstance.getSequence() });
        loadedLocalModelId = modelId;
    }

    // Only reset if stateless is explicitly requested or when a new session starts
    if (chatSessionInstance && stateless) {
        chatSessionInstance.resetChatHistory();
        await chatSessionInstance.sequence.clearHistory();
    }

    return { session: chatSessionInstance };
}

export async function downloadModel(modelId, onProgress) {
    if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
    
    const { createModelDownloader } = await import('node-llama-cpp');
    const modelEntry = MODELS_CONFIG[modelId];
    const downloader = await createModelDownloader({
        modelUri: modelEntry.uri,
        dirPath: MODELS_DIR,
        fileName: `${modelId}.gguf`,
        onProgress: ({ downloadedSize, totalSize }) => {
            if (onProgress && totalSize > 0) {
                onProgress(downloadedSize / totalSize);
            }
        }
    });

    await downloader.download();
}

export async function analyzeError(command, error, projectContext = {}) {
    const prompt = `You are Rex-AI, an expert system debugger and devops engineer. 
I ran this command: "${command}"
It failed with this error:
---
${error}
---

Project Context:
- Platform: ${projectContext.platform || 'unknown'}
- Root Files: ${JSON.stringify(projectContext.files)}
- Project Name: ${projectContext.projectName || 'unnamed'}
- Key Dependencies: ${JSON.stringify(Object.keys(projectContext.dependencies || {}).slice(0, 30))}

Task:
Analyze the error following these steps:
1. SYMPTOMS: What is the immediate visible failure?
2. ROOT CAUSE: Why did this happen given the project context? (e.g. missing dependency, wrong platform, logic error)
3. CURE: What is the single most effective terminal command to fix this?

Return your response in this JSON format:
{
  "explanation": "Brief reasoning covering symptoms and root cause...",
  "fixCommand": "The actual fix command..."
}`;

    try {
        const response = await runCompletion([{ role: 'user', content: prompt }]);
        const jsonStart = response.indexOf('{');
        const jsonEnd = response.lastIndexOf('}') + 1;
        return JSON.parse(response.substring(jsonStart, jsonEnd));
    } catch (e) {
        throw new Error('Failed to analyze error.');
    }
}

export async function aiCodeReview() {
    const config = loadConfig();

    const targetRaw = await p.text({
        message: 'Enter the path of the file or directory to review:',
        initialValue: '.',
        validate: (val) => {
            const cleanVal = val.replace(/^["']|["']$/g, '');
            if (!fs.existsSync(cleanVal)) return 'Path does not exist';
        }
    });

    if (p.isCancel(targetRaw)) return;
    const target = targetRaw.replace(/^["']|["']$/g, '');

    const s = p.spinner();
    s.start(`Analyzing ${target} using ${config.aiModel}...`);

    try {
        // Very basic file reading logic, skipping large dirs like node_modules
        let filesToReview = [];
        const stat = fs.statSync(target);
        if (stat.isFile()) {
            filesToReview.push(target);
        } else {
            const files = fs.readdirSync(target);
            for (const item of files) {
                if (item === 'node_modules' || item.startsWith('.')) continue; // skip hidden/deps
                const fullPath = path.join(target, item);
                if (fs.statSync(fullPath).isFile()) {
                    filesToReview.push(fullPath);
                }
            }
        }

        if (filesToReview.length === 0) {
            s.stop('No files to review.');
            return;
        }

        let contentStr = '';
        for (const f of filesToReview) {
            contentStr += `\n--- File: ${f} ---\n`;
            contentStr += fs.readFileSync(f, 'utf-8').substring(0, 3000); // chunk it for API limits
        }

        const prompt = `Review the following code. Identify bugs, security issues, performance problems, and give a brief summary of code quality. Keep it concise, colorful (if possible in markdown), and well-structured:\n\n${contentStr}`;

        const response = await runCompletion([{ role: 'user', content: prompt }]);
        s.stop(pc.green(`Code review via ${config.aiModel} completed!`));

        p.note(gradient.pastel.multiline(response), 'AI Code Review Report');

    } catch (err) {
        s.stop(pc.red('Code review failed!'));
        p.log.error(err.message);
    }
}

/**
 * Transcribes audio using OpenAI Whisper API
 * @param {string} filePath - Path to the audio file
 * @returns {string} - The transcribed text
 */
export async function transcribeAudio(filePath) {
    const config = loadConfig();
    if (!config.openaiKey) {
        throw new Error('OpenAI key is missing! Whisper transcription requires an OpenAI API key.');
    }

    const openai = new OpenAI({ apiKey: config.openaiKey });
    
    const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
    });

    return transcription.text;
}

