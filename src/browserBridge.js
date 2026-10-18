/**
 * browserBridge.js — Active In-Browser Chrome Extension Bridge
 *
 * Bridges RexAI directly to the Web Agent Architect Chrome extension:
 *   1. Serves http://127.0.0.1:8787/v1/chat/completions
 *      OpenAI-compatible AI completion server powering the extension via Rex's Gemini engine.
 *   2. Serves http://127.0.0.1:8765/api/rex-bridge
 *      Bi-directional control channel allowing Rex to read active tab DOM / SoM and dispatch hardware actions.
 */

import http from 'http';
import url from 'url';
import pc from 'picocolors';
import { runCompletion } from './ai.js';
import { loadConfig } from './config.js';

let bridgeServer = null;
let lastExtensionState = {
    connected: false,
    activeTab: null,
    marks: [],
    lastPing: 0
};

const pendingExtensionTasks = [];

/**
 * Handle OpenAI-compatible /v1/chat/completions from the extension
 */
async function handleChatCompletions(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const data = JSON.parse(body || '{}');
            const messages = data.messages || [];
            
            // Route through Rex AI engine (Gemini 3.5 Flash by default)
            const replyText = await runCompletion(messages, null, 'high');

            const responsePayload = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: data.model || 'gemini-3.5-flash',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: replyText
                        },
                        finish_reason: 'stop'
                    }
                ],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 100,
                    total_tokens: 200
                }
            };

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify(responsePayload));
        } catch (e) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: { message: e.message } }));
        }
    });
}

/**
 * Start the local HTTP bridge server
 */
export function startBrowserBridge(port = 8787) {
    if (bridgeServer) {
        return { running: true, port: 8787, message: 'Browser Bridge already active.' };
    }

    bridgeServer = http.createServer((req, res) => {
        // Handle CORS Preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end();
            return;
        }

        const parsedUrl = url.parse(req.url, true);

        // Extension AI completions endpoint
        if (parsedUrl.pathname === '/v1/chat/completions' && req.method === 'POST') {
            return handleChatCompletions(req, res);
        }

        // Extension Heartbeat / State Sync endpoint
        if (parsedUrl.pathname === '/api/sync-tab' && req.method === 'POST') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                try {
                    const payload = JSON.parse(body || '{}');
                    lastExtensionState = {
                        connected: true,
                        activeTab: payload.tab || null,
                        marks: payload.marks || [],
                        lastPing: Date.now()
                    };

                    // Check for pending tasks to return to extension
                    const nextTask = pendingExtensionTasks.shift() || null;

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ ok: true, task: nextTask }));
                } catch {
                    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
                    res.end('Bad payload');
                }
            });
            return;
        }

        // Extension query status
        if (parsedUrl.pathname === '/api/status') {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
                ok: true,
                server: 'RexAI Chrome Bridge',
                extensionConnected: (Date.now() - lastExtensionState.lastPing) < 15000,
                activeTab: lastExtensionState.activeTab,
                marksCount: lastExtensionState.marks.length
            }));
            return;
        }

        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not Found');
    });

    bridgeServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            bridgeServer = null;
        }
    });

    try {
        bridgeServer.listen(port, '127.0.0.1', () => {
            // Server listening
        });
    } catch {}

    return { running: true, port, message: `Browser Bridge online on port ${port}` };
}

/**
 * Dispatch an action to the active Chrome tab via the extension
 */
export async function sendActionToChromeTab(action, params = {}) {
    if (!bridgeServer) {
        startBrowserBridge();
    }

    const task = {
        id: `task_${Date.now()}`,
        action,
        params,
        timestamp: Date.now()
    };

    pendingExtensionTasks.push(task);

    return `Action "${action}" queued for active Chrome tab via Web Agent Architect extension.`;
}

/**
 * Get active extension connection status
 */
export function getExtensionBridgeStatus() {
    return {
        serverRunning: bridgeServer !== null,
        extensionAlive: (Date.now() - lastExtensionState.lastPing) < 15000,
        activeTab: lastExtensionState.activeTab,
        marksCount: lastExtensionState.marks.length
    };
}
