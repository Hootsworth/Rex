import http from 'http';
import https from 'https';

const PLACEHOLDER_HOSTS = new Set([
    'example.com',
    'www.example.com',
    'example.org',
    'www.example.org',
    'example.net',
    'www.example.net'
]);

function isPlaceholderHost(hostname = '') {
    return PLACEHOLDER_HOSTS.has(String(hostname).toLowerCase());
}

function normalizeWebUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Missing URL.');
    }

    const trimmed = rawUrl.trim();
    // Preserve http:// for localhost/local dev servers; default to https:// for everything else
    let maybeUrl;
    if (/^https?:\/\//i.test(trimmed)) {
        maybeUrl = trimmed;
    } else if (/^localhost/i.test(trimmed) || /^127\.0\.0\.1/i.test(trimmed) || /^\[::1\]/i.test(trimmed)) {
        maybeUrl = `http://${trimmed}`;
    } else {
        maybeUrl = `https://${trimmed}`;
    }
    const parsed = new URL(maybeUrl);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http and https URLs are allowed.');
    }

    return parsed.toString();
}

function canonicalizeUrlForLoopDetection(rawUrl) {
    try {
        const u = new URL(String(rawUrl || ''));
        const host = u.hostname.toLowerCase();
        const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
        return `${host}${path.toLowerCase()}`;
    } catch {
        return String(rawUrl || '').trim().toLowerCase();
    }
}

function deriveIntentQueryFromUrl(rawUrl) {
    try {
        const u = new URL(String(rawUrl || ''));
        const tokens = [];
        const push = (v) => {
            const s = String(v || '').trim().toLowerCase();
            if (!s) return;
            if (/^(www|in|com|org|net|co|home|index|search|s|ref|gp|dp|products?)$/.test(s)) return;
            tokens.push(s);
        };

        (u.pathname || '')
            .split('/')
            .map((x) => decodeURIComponent(x || '').replace(/[-_+]+/g, ' ').trim())
            .forEach(push);

        for (const [k, v] of u.searchParams.entries()) {
            if (!k || !v) continue;
            if (/^(q|query|k|keyword|keywords|search|term)$/i.test(k)) {
                push(decodeURIComponent(v).replace(/[-_+]+/g, ' ').trim());
            }
        }

        const unique = [...new Set(tokens)].filter(Boolean);
        return unique.join(' ').trim();
    } catch {
        return '';
    }
}

function buildSiteScopedRecoveryQuery(rawUrl, fallback = '') {
    let host = '';
    try {
        host = new URL(String(rawUrl || '')).hostname.replace(/^www\./i, '').trim();
    } catch {
        host = '';
    }

    const intent = deriveIntentQueryFromUrl(rawUrl) || String(fallback || '').trim();
    if (host && intent) return `${intent} site:${host}`;
    return intent || (host ? `site:${host}` : 'web search');
}

function buildSearchCandidates(query) {
    const q = String(query || '').trim();
    if (!q) throw new Error('Missing search query.');
    const encoded = encodeURIComponent(q);
    return [
        `https://duckduckgo.com/?q=${encoded}`,
        `https://duckduckgo.com/html/?q=${encoded}`,
        `https://www.bing.com/search?q=${encoded}`
    ];
}

function parseFirstJsonObject(input) {
    const str = String(input || '');
    const start = str.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                const candidate = str.substring(start, i + 1);
                return JSON.parse(candidate);
            }
        }
    }

    return null;
}

async function resilientGoto(page, targetUrl, options = {}) {
    const {
        timeout = 30000,
        waitUntilPrimary = 'load',
        waitUntilFallback = 'domcontentloaded'
    } = options;

    try {
        await page.goto(targetUrl, { waitUntil: waitUntilPrimary, timeout });
    } catch {
        try {
            await page.goto(targetUrl, { waitUntil: waitUntilFallback, timeout: Math.min(timeout, 22000) });
        } catch (fallbackErr) {
            return {
                ok: false,
                currentUrl: page.url(),
                error: fallbackErr.message
            };
        }
    }

    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);

    const currentUrl = page.url();
    const blank = !currentUrl || currentUrl === 'about:blank';
    return {
        ok: !blank,
        currentUrl,
        error: blank ? 'Navigation landed on about:blank' : ''
    };
}

async function resilientSearch(page, query) {
    const candidates = buildSearchCandidates(query);
    let lastErr = '';

    for (const candidate of candidates) {
        try {
            const nav = await resilientGoto(page, candidate, {
                timeout: 25000,
                waitUntilPrimary: 'domcontentloaded',
                waitUntilFallback: 'commit'
            });

            if (!nav.ok) {
                lastErr = nav.error || `Blank page after ${candidate}`;
                continue;
            }

            const blocker = await detectAutomationBlockers(page);
            if (blocker) {
                lastErr = blocker;
                continue;
            }

            return {
                ok: true,
                url: page.url(),
                engineUrl: candidate
            };
        } catch (e) {
            lastErr = e.message;
        }
    }

    return {
        ok: false,
        error: lastErr || 'Unable to load search page.'
    };
}

async function detectAutomationBlockers(page) {
    try {
        const detection = await page.evaluate(() => {
            const title = (document.title || '').toLowerCase();
            const body = (document.body?.innerText || '').toLowerCase().slice(0, 6000);
            const indicators = [
                'captcha',
                'verify you are human',
                'are you a robot',
                'access denied',
                '403 forbidden',
                'your ip has been blocked',
                'request blocked',
                'temporarily unavailable',
                'checking your browser'
            ];

            const hits = indicators.filter((k) => title.includes(k) || body.includes(k));
            const hasCaptchaElement = !!document.querySelector('iframe[src*="captcha"], .g-recaptcha, [id*="captcha"], [class*="captcha"]');

            return {
                title: document.title || 'Unknown',
                hasBlocker: hits.length > 0 || hasCaptchaElement,
                hits,
                hasCaptchaElement
            };
        });

        if (detection?.hasBlocker) {
            return `Blocked by site defenses. Title: "${detection.title}". Signals: ${detection.hits.join(', ') || 'captcha element detected'}.`;
        }
    } catch {
        // Non-fatal: blocker detection should never crash the flow.
    }

    return null;
}

async function dismissCommonPopups(page) {
    try {
        const clicked = await page.evaluate(() => {
            const phrases = [
                'accept',
                'accept all',
                'i agree',
                'agree',
                'allow all',
                'got it',
                'ok',
                'close',
                'dismiss',
                'continue'
            ];

            const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
            let count = 0;

            for (const el of candidates) {
                const text = (el.textContent || '').trim().toLowerCase();
                if (!text) continue;
                if (!phrases.some((p) => text === p || text.includes(p))) continue;

                const rect = el.getBoundingClientRect();
                const visible = rect.width > 0 && rect.height > 0;
                if (!visible) continue;

                if (count < 2) {
                    el.click();
                    count++;
                }
            }

            return count;
        });

        return clicked || 0;
    } catch {
        return 0;
    }
}

async function smartHandleConsentAndOverlays(page, options = {}) {
    const { maxClicks = 3, preferReject = true } = options;

    try {
        const result = await page.evaluate(({ maxClicks, preferReject }) => {
            const rejectWords = [
                'reject', 'reject all', 'decline', 'deny', 'disagree', 'only necessary',
                'necessary only', 'essential only', 'refuse', 'opt out', 'do not allow',
                'no thanks', 'not now', 'skip', 'continue as guest', 'use without account',
                'continue without signing in', 'continue without login', 'keep browsing'
            ];
            const closeWords = ['close', 'dismiss', '✕', '×', 'later', 'maybe later', 'cancel', 'got it', 'hide'];
            const acceptWords = ['accept', 'accept all', 'allow all', 'agree', 'i agree', 'ok'];
            const loginTrapWords = ['sign in', 'log in', 'login', 'register', 'create account', 'join now'];

            const textOf = (el) => (
                (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '')
                    .trim()
                    .replace(/\s+/g, ' ')
                    .toLowerCase()
            );

            const hasOverlayContext = (el) => {
                const isDialog = !!el.closest('[role="dialog"], dialog, [aria-modal="true"], .modal, .popup, .overlay, [id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"], [id*="gdpr"], [class*="gdpr"]');
                const fixedParent = !!el.closest('[style*="position: fixed"], [style*="z-index"]');
                return isDialog || fixedParent;
            };

            const scoreText = (txt) => {
                let score = 0;
                if (preferReject && rejectWords.some(w => txt === w || txt.includes(w))) score += 120;
                if (closeWords.some(w => txt === w || txt.includes(w))) score += 90;
                if (!preferReject && acceptWords.some(w => txt === w || txt.includes(w))) score += 70;
                if (acceptWords.some(w => txt === w || txt.includes(w))) score += 10;
                if (loginTrapWords.some(w => txt === w || txt.includes(w))) score -= 120;
                return score;
            };

            const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-label], [title]'));
            const scored = [];

            for (const el of candidates) {
                const txt = textOf(el);
                if (!txt) continue;

                const rect = el.getBoundingClientRect();
                const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
                if (!visible) continue;

                let score = scoreText(txt);
                if (hasOverlayContext(el)) score += 40;
                if (rect.top < window.innerHeight * 0.35) score += 8;

                if (score > 40) {
                    scored.push({ el, txt, score });
                }
            }

            scored.sort((a, b) => b.score - a.score);

            const clicked = [];
            const used = new Set();
            for (const item of scored) {
                if (clicked.length >= maxClicks) break;
                if (used.has(item.txt)) continue;
                used.add(item.txt);

                try {
                    item.el.click();
                    clicked.push(item.txt);
                } catch {
                    // ignore click failures
                }
            }

            return {
                clicked,
                clickedCount: clicked.length
            };
        }, { maxClicks, preferReject });

        return result || { clicked: [], clickedCount: 0 };
    } catch {
        return { clicked: [], clickedCount: 0 };
    }
}

async function settleAfterInteraction(page, options = {}) {
    const {
        interaction = 'action',
        popupClicks = 2,
        dropdownWaitMs = 260
    } = options;

    try { await page.waitForLoadState('domcontentloaded', { timeout: 1200 }); } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 1200 }); } catch {}
    await page.waitForTimeout(Math.max(80, dropdownWaitMs)).catch(() => {});

    const popupResult = await smartHandleConsentAndOverlays(page, { maxClicks: popupClicks, preferReject: true });
    const authState = await detectAuthState(page);

    const notes = [];
    if (popupResult.clickedCount > 0) notes.push(`cleared ${popupResult.clickedCount} popup action(s)`);
    if (authState.requiresAuth) notes.push('login wall detected');
    else if (authState.onLoginSurface && !authState.likelyLoggedIn) notes.push('login surface visible');

    return {
        interaction,
        popupResult,
        authState,
        note: notes.join('; ')
    };
}

async function detectAuthState(page) {
    try {
        return await page.evaluate(() => {
            const body = (document.body?.innerText || '').toLowerCase().slice(0, 8000);
            const title = (document.title || '').toLowerCase();
            const url = new URL(window.location.href);
            const pathname = (url.pathname || '').toLowerCase();

            const hasPasswordInput = !!document.querySelector('input[type="password"]');
            const hasEmailInput = !!document.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i]');
            const hasOauthButton = !!Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
                const t = (el.textContent || '').toLowerCase();
                return t.includes('continue with google') || t.includes('continue with github') || t.includes('continue with apple') || t.includes('single sign-on') || t.includes('sso');
            });

            const loginWords = ['enter your password', 'verify your identity', 'two-factor', '2fa', 'authentication required'];
            const hardGateWords = ['sign in to continue', 'log in to continue', 'members only', 'subscriber only', 'you must be logged in', 'please sign in first'];
            const loggedInWords = ['sign out', 'log out', 'logout', 'my account', 'profile', 'dashboard'];

            const hasLoginActionButton = !!Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
                const t = (el.textContent || '').toLowerCase().trim();
                return t === 'sign in' || t === 'log in' || t === 'login';
            });

            const hasAuthForm = !!document.querySelector('form input[type="password"], form input[type="email"], form input[name*="user" i], form input[name*="login" i]');

            const authPathHints = ['/login', '/log-in', '/signin', '/sign-in', '/auth', '/oauth', '/session', '/users/sign_in', '/account/login'];
            const urlSuggestsAuth = authPathHints.some(h => pathname.includes(h));

            const loginHits = loginWords.filter(w => title.includes(w) || body.includes(w));
            const hardGateHits = hardGateWords.filter(w => title.includes(w) || body.includes(w));
            const loggedInHits = loggedInWords.filter(w => body.includes(w));

            const onStrongLoginSurface = hasPasswordInput || hasEmailInput || hasOauthButton || hasAuthForm;
            const onWeakLoginSurface = hasLoginActionButton && (title.includes('sign in') || title.includes('log in') || title.includes('login') || urlSuggestsAuth);
            const requiresAuth = hardGateHits.length > 0 || (urlSuggestsAuth && onStrongLoginSurface);

            return {
                url: window.location.href,
                title: document.title || 'Unknown',
                requiresAuth,
                onLoginSurface: onStrongLoginSurface || onWeakLoginSurface || loginHits.length > 0,
                likelyLoggedIn: loggedInHits.length > 0 && !hasPasswordInput,
                hardGateHits,
                loginHits
            };
        });
    } catch {
        return {
            url: '',
            title: 'Unknown',
            requiresAuth: false,
            onLoginSurface: false,
            likelyLoggedIn: false,
            hardGateHits: [],
            loginHits: []
        };
    }
}

export function __test_parseFirstJsonObject(input) {
    return parseFirstJsonObject(input);
}

async function waitForAuthCompletion(page, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const auth = await detectAuthState(page);
        if (!auth.onLoginSurface || auth.likelyLoggedIn) {
            return {
                completed: true,
                state: auth,
                waitedMs: Date.now() - start
            };
        }

        await page.waitForTimeout(1500);
    }

    const state = await detectAuthState(page);
    return {
        completed: false,
        state,
        waitedMs: timeoutMs
    };
}

/**
 * Fetches content from a given URL and attempts to strip HTML to return clean text/markdown.
 * Useful for reading documentation or StackOverflow answers.
 */
export async function fetch_url_content(url) {
    let normalizedUrl;
    try {
        normalizedUrl = normalizeWebUrl(url);
    } catch (err) {
        return `Error: ${err.message}`;
    }

    const parsedUrl = new URL(normalizedUrl);
    if (isPlaceholderHost(parsedUrl.hostname)) {
        return `Error: ${parsedUrl.hostname} is a placeholder domain. Use a real website URL or run a search first.`;
    }

// Auto-follow redirects up to 3 times
    const fetchWithRedirects = (targetUrl, redirectsLeft = 3) => {
        // Fallback to Browser if manager is active and URL is complex
        if (manager.browser && manager.browser.isConnected()) {
            return manager.getPage().then(async (page) => {
                const nav = await resilientGoto(page, targetUrl, { timeout: 20000 });
                if (!nav.ok) return `Error: Browser failed to fetch ${targetUrl}: ${nav.error}`;
                
                return await page.evaluate(() => {
                    const scripts = document.querySelectorAll('script, style, noscript, nav, footer, iframe');
                    scripts.forEach(s => s.remove());
                    const main = document.querySelector('main, article, [role="main"], #content, .content');
                    return (main || document.body).innerText.replace(/\s+/g, ' ').trim();
                });
            }).catch(err => `Browser Fetch Error: ${err.message}`);
        }

        return new Promise((resolve) => {
            const client = targetUrl.startsWith('https') ? https : http;

            const req = client.get(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 RexAI/8.0'
                }
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (redirectsLeft <= 0) {
                        return resolve(`Error: Too many redirects. Last redirect: ${res.headers.location}`);
                    }
                    const redirectUrl = res.headers.location.startsWith('http') 
                        ? res.headers.location 
                        : new URL(res.headers.location, targetUrl).toString();
                    return resolve(fetchWithRedirects(redirectUrl, redirectsLeft - 1));
                }

                if (res.statusCode !== 200) {
                    return resolve(`Error: Received status code ${res.statusCode} from ${targetUrl}`);
                }

                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                    if (data.length > 1024 * 1024) {
                        req.destroy();
                        resolve(`Error: Response too large (exceeded 1MB limit). Read aborted.`);
                    }
                });

                res.on('end', () => {
                    const cleanText = stripHtml(data);
                    if (cleanText.length > 15000) {
                        resolve(cleanText.substring(0, 15000) + '\n\n...[Content truncated due to length]...');
                    } else {
                        resolve(cleanText);
                    }
                });
            });

            req.on('error', (err) => {
                resolve(`Network Error fetching ${targetUrl}: ${err.message}`);
            });

            req.setTimeout(15000, () => {
                req.destroy();
                resolve(`Error: Timeout fetching ${targetUrl}`);
            });
        });
    };

    return fetchWithRedirects(normalizedUrl);
}

/**
 * Opens a URL in the default system browser.
 * Useful for authentication flows or viewing documentation.
 */
export async function open_browser(url) {
    try {
        const normalizedUrl = normalizeWebUrl(url);
        const parsedUrl = new URL(normalizedUrl);
        if (isPlaceholderHost(parsedUrl.hostname)) {
            return `Error: ${parsedUrl.hostname} is a placeholder domain. Use a real website URL.`;
        }

        const { exec } = await import('child_process');
        const platform = process.platform;
        let command = '';

        if (platform === 'win32') command = `start "" "${normalizedUrl}"`;
        else if (platform === 'darwin') command = `open "${normalizedUrl}"`;
        else command = `xdg-open "${normalizedUrl}"`;

        exec(command);
        return `Successfully opened ${normalizedUrl} in your browser.`;
    } catch (err) {
        return `Error opening browser: ${err.message}`;
    }
}

/**
 * A very simple, lightweight HTML stripper without needing external dependencies like JSDOM or Cheerio
 */
function stripHtml(html) {
    // Remove scripts and styles entirely
    let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    
    // Replace breaks and paragraphs with newlines
    text = text.replace(/<br\s*[\/]?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/div>/gi, '\n');
    
    // Remove all other HTML tags
    text = text.replace(/<[^>]+>/g, '');
    
    // Decode common entities
    text = text.replace(/&nbsp;/g, ' ')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"')
               .replace(/&#39;/g, "'");

    // Remove excessive whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n\s*\n/g, '\n\n');

    return text.trim();
}
export async function list_browser_tabs() {
    if (!manager.browser || !manager.browser.isConnected() || !manager.pages.length) {
        return '';
    }
    return await manager.listTabs();
}

import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import util from 'util';
import { loadConfig } from './config.js';

const execFileAsync = util.promisify(execFile);

function resolveNavigationExtensionPaths() {
    const cfg = loadConfig();
    const defaults = [path.join(process.cwd(), 'extensions', 'preflight-analyse-navigator')];
    if (cfg.babysitPromptExtensionEnabled !== false) {
        defaults.push(path.join(process.cwd(), 'extensions', 'babysit-task-prompter'));
    }

    const fromEnv = String(process.env.REX_NAV_EXTENSION_PATH || '').trim();
    const envPaths = fromEnv
        ? fromEnv
            .split(/[;,]/)
            .map((x) => String(x || '').trim())
            .filter(Boolean)
        : [];

    const candidates = envPaths.length > 0 ? envPaths : defaults;
    return [...new Set(candidates)].filter((p) => fs.existsSync(p));
}

function appendAutonomousBrowserDebug(entry) {
    try {
        const agentDir = path.join(process.cwd(), '.agent');
        if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
        const logPath = path.join(agentDir, 'autonomous-browser-debug.jsonl');
        fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch {
        // Logging must remain non-fatal.
    }
}

async function visuallyGroundElement(page, selectorOrText, promptGoal = '') {
    try {
        const screenshotDir = path.join(process.cwd(), '.agent');
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
        const screenshotPath = path.join(screenshotDir, 'viewport.png');
        await page.screenshot({ path: screenshotPath });

        const base64Image = fs.readFileSync(screenshotPath, 'base64');
        const response = await fetch('http://127.0.0.1:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llava',
                prompt: `Analyze this browser screenshot. Is the element "${selectorOrText}" (Goal: ${promptGoal}) visible and interactive on this screen? Respond with 'YES' or 'NO', followed by a very brief explanation of its visual location (e.g., top-right next to search bar).`,
                images: [base64Image],
                stream: false
            })
        });

        if (response.ok) {
            const data = await response.json();
            const textResponse = String(data.response || '').trim();
            appendAutonomousBrowserDebug({
                source: 'visuallyGroundElement',
                selectorOrText,
                response: textResponse
            });
            return {
                ok: true,
                visible: !textResponse.toUpperCase().includes('NO'),
                explanation: textResponse
            };
        }
        return { ok: false, error: `Ollama response status ${response.status}` };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

export async function fetchLocalSearchGrounding(query) {
    try {
        const encoded = encodeURIComponent(query);
        const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (!res.ok) return '';
        const html = await res.text();
        const snippets = [];
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        while ((match = regex.exec(html)) !== null && snippets.length < 5) {
            const cleanText = match[1].replace(/<[^>]*>/g, '').trim();
            if (cleanText) snippets.push(cleanText);
        }
        return snippets.join('\n');
    } catch {
        return '';
    }
}

function shouldForceHeadlessInCi() {
    const isCi = String(process.env.CI || '').toLowerCase() === 'true'
        || String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true';
    const isLinux = process.platform === 'linux';
    const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
    return isCi && isLinux && !hasDisplay;
}

/**
 * Manages a persistent browser instance across multiple tool calls
 */
class BrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.pages = [];
        this.currentPageIndex = 0;
        this.lastHealthyUrl = '';
        this.usingExtension = false;
        this.extensionPath = '';
        this.extensionPaths = [];
        this.navigationAttempts = [];
        this.babysitHookedPages = new WeakSet();
        this.babysitSession = {
            active: false,
            startedAt: '',
            goal: '',
            model: 'gpt-5-nano',
            followCursor: true,
            snapshots: 0,
            notesSaved: 0,
            feedback: {
                useful: 0,
                notUseful: 0,
                replayAsked: 0
            }
        };
        this.babysitAutoCapture = {
            timer: null,
            running: false,
            intervalMs: 0,
            lastError: ''
        };
    }

    trackNavigationAttempt(targetUrl, source = 'navigate') {
        const now = Date.now();
        const canonicalTarget = canonicalizeUrlForLoopDetection(targetUrl);
        this.navigationAttempts.push({
            ts: now,
            targetUrl: String(targetUrl || ''),
            canonicalTarget,
            source: String(source || 'navigate')
        });

        // Keep only a small rolling window to detect loops quickly.
        this.navigationAttempts = this.navigationAttempts
            .filter((x) => now - Number(x.ts || 0) <= 150000)
            .slice(-25);
    }

    getNavigationLoopSignal(targetUrl) {
        const canonicalTarget = canonicalizeUrlForLoopDetection(targetUrl);
        if (!canonicalTarget) return { looping: false, repeats: 0 };

        const recent = this.navigationAttempts.slice(-8);
        const repeats = recent.filter((x) => x.canonicalTarget === canonicalTarget).length;
        const tail = recent.slice(-3);
        const tailAllSame = tail.length >= 3 && tail.every((x) => x.canonicalTarget === canonicalTarget);
        return {
            looping: repeats >= 3 || tailAllSame,
            repeats
        };
    }

    async ensureBrowser(opts = {}) {
        let justLaunched = false;
        const isHeadless = !!opts.headless || shouldForceHeadlessInCi();
        if (this.browser && !this.browser.isConnected()) {
            this.browser = null;
            this.context = null;
            this.pages = [];
            this.currentPageIndex = 0;
            this.lastHealthyUrl = '';
            this.navigationAttempts = [];
            this.babysitSession = {
                active: false,
                startedAt: '',
                goal: '',
                model: 'gpt-5-nano',
                followCursor: true,
                snapshots: 0,
                notesSaved: 0,
                feedback: {
                    useful: 0,
                    notUseful: 0,
                    replayAsked: 0
                }
            };
            if (this.babysitAutoCapture?.timer) {
                clearInterval(this.babysitAutoCapture.timer);
            }
            this.babysitAutoCapture = {
                timer: null,
                running: false,
                intervalMs: 0,
                lastError: ''
            };
        }

        if (!this.browser) {
            justLaunched = true;
            const { chromium } = await import('playwright');
            const extensionPaths = resolveNavigationExtensionPaths();

            const sandboxProfilePath = path.join(process.cwd(), '.agent', 'browser-sandbox-profile');
            if (!fs.existsSync(sandboxProfilePath)) fs.mkdirSync(sandboxProfilePath, { recursive: true });

            const defaultStealthArgs = [
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ];
            const defaultUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
            const defaultViewport = { width: 1280, height: 800 };

            if (extensionPaths.length > 0) {
                const joinedPaths = extensionPaths.join(',');

                try {
                    this.context = await chromium.launchPersistentContext(sandboxProfilePath, {
                        headless: isHeadless,
                        userAgent: defaultUserAgent,
                        viewport: defaultViewport,
                        args: [
                            ...defaultStealthArgs,
                            `--disable-extensions-except=${joinedPaths}`,
                            `--load-extension=${joinedPaths}`
                        ]
                    });
                    this.browser = this.context.browser();
                    this.usingExtension = true;
                    this.extensionPaths = extensionPaths;
                    this.extensionPath = joinedPaths;
                } catch (extErr) {
                    appendAutonomousBrowserDebug({
                        source: 'ensureBrowser',
                        phase: 'extension_launch_failed_fallback',
                        extensionPath: joinedPaths,
                        error: extErr?.message || String(extErr)
                    });

                    this.context = await chromium.launchPersistentContext(sandboxProfilePath, {
                        headless: isHeadless,
                        userAgent: defaultUserAgent,
                        viewport: defaultViewport,
                        args: defaultStealthArgs
                    });
                    this.browser = this.context.browser();
                    this.usingExtension = false;
                    this.extensionPath = '';
                    this.extensionPaths = [];
                }
            } else {
                this.context = await chromium.launchPersistentContext(sandboxProfilePath, {
                    headless: isHeadless,
                    userAgent: defaultUserAgent,
                    viewport: defaultViewport,
                    args: defaultStealthArgs
                });
                this.browser = this.context.browser();
                this.usingExtension = false;
                this.extensionPath = '';
                this.extensionPaths = [];
            }

            // Inject stealth scripts
            await this.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            });
        }

        // Rebuild page list from context in case tabs were opened/closed outside manager bookkeeping.
        this.pages = this.context.pages().filter((p) => {
            if (!p || p.isClosed()) return false;
            const u = String(p.url() || '');
            if (u.startsWith('chrome-extension://') || u.startsWith('devtools://')) return false;
            return true;
        });

        if (justLaunched && this.pages.length > 1) {
            const nonBlank = this.pages.filter((p) => !isBlankUrl(p.url() || ''));
            if (nonBlank.length > 0) {
                const blankTabs = this.pages.filter((p) => isBlankUrl(p.url() || ''));
                for (const t of blankTabs) {
                    await t.close().catch(() => {});
                }
                this.pages = nonBlank.filter((p) => !p.isClosed());
            } else {
                const keep = this.pages[0];
                for (let i = 1; i < this.pages.length; i++) {
                    await this.pages[i].close().catch(() => {});
                }
                this.pages = keep && !keep.isClosed() ? [keep] : [];
            }
        }

        this.pages = this.pages.filter((p) => !p.isClosed());
        if (this.pages.length === 0 && this.context) {
            const page = await this.context.newPage();
            this.pages.push(page);
        }

        if (this.currentPageIndex >= this.pages.length) {
            this.currentPageIndex = Math.max(0, this.pages.length - 1);
        }

        for (const p of this.pages) {
            if (this.babysitHookedPages.has(p)) continue;
            const rearm = async () => {
                if (!this.babysitSession?.active || !this.babysitSession?.followCursor) return;
                await ensureVisualCursor(p, pickBrowserCursorStyle('default'));
                await setBabysitCursorFollow(p, true);
            };

            p.on('framenavigated', () => { rearm().catch(() => {}); });
            p.on('domcontentloaded', () => { rearm().catch(() => {}); });
            this.babysitHookedPages.add(p);
        }

        return this.browser;
    }

    async getPage(opts = {}) {
        await this.ensureBrowser(opts);
        let page = this.pages[this.currentPageIndex];
        if (!page || page.isClosed()) {
            page = await this.context.newPage();
            this.pages.push(page);
            this.currentPageIndex = this.pages.length - 1;
        }

        const currentUrl = page.url();
        if (currentUrl && currentUrl !== 'about:blank') {
            this.lastHealthyUrl = currentUrl;
        }

        return page;
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.pages = [];
            this.currentPageIndex = 0;
            this.lastHealthyUrl = '';
            this.usingExtension = false;
            this.extensionPath = '';
            this.extensionPaths = [];
            this.navigationAttempts = [];
            this.babysitSession = {
                active: false,
                startedAt: '',
                goal: '',
                model: 'gpt-5-nano',
                followCursor: true,
                snapshots: 0,
                notesSaved: 0,
                feedback: {
                    useful: 0,
                    notUseful: 0,
                    replayAsked: 0
                }
            };
            if (this.babysitAutoCapture?.timer) {
                clearInterval(this.babysitAutoCapture.timer);
            }
            this.babysitAutoCapture = {
                timer: null,
                running: false,
                intervalMs: 0,
                lastError: ''
            };
        }
    }

    async newTab(url = 'about:blank') {
        await this.ensureBrowser();
        const page = await this.context.newPage();
        this.pages.push(page);
        this.currentPageIndex = this.pages.length - 1;
        if (url !== 'about:blank') {
            const safeUrl = normalizeWebUrl(url);
            if (isPlaceholderHost(new URL(safeUrl).hostname)) {
                return `Error: Refusing to open placeholder domain ${new URL(safeUrl).hostname}.`;
            }
            const nav = await resilientGoto(page, safeUrl, {
                timeout: 25000,
                waitUntilPrimary: 'domcontentloaded',
                waitUntilFallback: 'commit'
            });
            if (!nav.ok) {
                const recovery = await resilientSearch(page, safeUrl);
                if (!recovery.ok) {
                    return `Error: Opened tab but failed to load ${safeUrl}: ${recovery.error}`;
                }
                this.lastHealthyUrl = page.url() || this.lastHealthyUrl;
                return `Opened new tab; direct load failed, recovered via search at ${recovery.url}`;
            }
            this.lastHealthyUrl = page.url() || this.lastHealthyUrl;
            return `Opened new tab: ${safeUrl}`;
        }
        return `Opened new tab: ${url}`;
    }

    async switchTab(index) {
        await this.ensureBrowser();
        if (index >= 0 && index < this.pages.length) {
            this.currentPageIndex = index;
            const url = this.pages[index].url();
            if (url && url !== 'about:blank') this.lastHealthyUrl = url;
            return `Switched to tab ${index} (${url})`;
        }
        return `Error: Tab index ${index} out of range (0-${this.pages.length - 1})`;
    }

    async listTabs() {
        await this.ensureBrowser();
        const tabs = [];
        for (let i = 0; i < this.pages.length; i++) {
            const title = await this.pages[i].title().catch(() => 'Unknown');
            const url = this.pages[i].url() || 'Unknown';
            tabs.push(`${i}: ${title} (${url})${i === this.currentPageIndex ? ' [ACTIVE]' : ''}`);
        }
        return tabs.join('\n');
    }
}

export const manager = new BrowserManager();

const PREFLGIHT_ANALYSE_PLOT_NAME = 'Preflgiht Analyse Plot';
const PREFLIGHT_ANALYSE_PLOT_LIMIT = 1200;
let preflightAnalysePlotCache = null;

function getPreflightAnalysePlotPath() {
    return path.join(process.cwd(), '.rex', 'preflight-analyse-plot.json');
}

function normalizeHostFromUrl(rawUrl = '') {
    try {
        const host = new URL(String(rawUrl || '').trim()).hostname.toLowerCase();
        return host.startsWith('www.') ? host.slice(4) : host;
    } catch {
        return '';
    }
}

function buildPlotIntent(action = '', args = {}) {
    const base = normalizeForMatch(args.text || args.label || args.query || args.placeholder || args.role || 'generic');
    const role = normalizeForMatch(args.role || '');
    const anchor = normalizeForMatch(args.hrefContains || args.urlContains || '');
    return `${normalizeForMatch(action || 'unknown')}|${base}|${role}|${anchor}`;
}

function ensurePreflightAnalysePlotDir() {
    const dir = path.dirname(getPreflightAnalysePlotPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadPreflightAnalysePlotStore() {
    if (preflightAnalysePlotCache) return preflightAnalysePlotCache;

    const filePath = getPreflightAnalysePlotPath();
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (parsed && Array.isArray(parsed.entries)) {
                preflightAnalysePlotCache = parsed;
                return preflightAnalysePlotCache;
            }
        }
    } catch {
        // Corrupt store should not break browser actions.
    }

    preflightAnalysePlotCache = {
        feature: PREFLGIHT_ANALYSE_PLOT_NAME,
        schemaVersion: 1,
        entries: [],
        updatedAt: new Date().toISOString()
    };
    return preflightAnalysePlotCache;
}

function savePreflightAnalysePlotStore() {
    try {
        ensurePreflightAnalysePlotDir();
        const store = loadPreflightAnalysePlotStore();
        store.updatedAt = new Date().toISOString();
        if (store.entries.length > PREFLIGHT_ANALYSE_PLOT_LIMIT) {
            store.entries = store.entries
                .sort((a, b) => (new Date(b.lastSuccessAt || b.lastSeenAt || 0).getTime() - new Date(a.lastSuccessAt || a.lastSeenAt || 0).getTime()))
                .slice(0, PREFLIGHT_ANALYSE_PLOT_LIMIT);
        }
        fs.writeFileSync(getPreflightAnalysePlotPath(), JSON.stringify(store, null, 2), 'utf8');
    } catch {
        // Disk persistence issues are non-fatal.
    }
}

function addPreflightAnalysePlotObservation({ pageUrl = '', action = '', args = {}, selector = '', candidate = null, success = true }) {
    const host = normalizeHostFromUrl(pageUrl);
    if (!host || !selector) return;

    const intent = buildPlotIntent(action, args);
    const store = loadPreflightAnalysePlotStore();
    const key = `${host}::${intent}::${selector}`;
    const now = new Date().toISOString();

    let row = store.entries.find((x) => x.key === key);
    if (!row) {
        row = {
            key,
            host,
            intent,
            action: normalizeForMatch(action || 'unknown'),
            selector,
            id: String(candidate?.id || ''),
            tag: String(candidate?.tag || ''),
            role: String(candidate?.role || ''),
            text: String(candidate?.text || '').slice(0, 180),
            href: String(candidate?.href || '').slice(0, 220),
            placeholder: String(candidate?.placeholder || '').slice(0, 120),
            successCount: 0,
            failCount: 0,
            lastSeenAt: now,
            lastSuccessAt: ''
        };
        store.entries.push(row);
    }

    row.lastSeenAt = now;
    row.id = String(candidate?.id || row.id || '');
    row.tag = String(candidate?.tag || row.tag || '');
    row.role = String(candidate?.role || row.role || '');
    row.text = String(candidate?.text || row.text || '').slice(0, 180);
    row.href = String(candidate?.href || row.href || '').slice(0, 220);
    row.placeholder = String(candidate?.placeholder || row.placeholder || '').slice(0, 120);

    if (success) {
        row.successCount = Number(row.successCount || 0) + 1;
        row.lastSuccessAt = now;
    } else {
        row.failCount = Number(row.failCount || 0) + 1;
    }

    savePreflightAnalysePlotStore();
}

function getPreflightAnalysePlotBoost({ pageUrl = '', action = '', args = {}, candidate = null }) {
    const host = normalizeHostFromUrl(pageUrl);
    if (!host || !candidate) return { boost: 0, hits: 0 };

    const intent = buildPlotIntent(action, args);
    const store = loadPreflightAnalysePlotStore();
    const cText = normalizeForMatch(candidate.text || '');
    const cRole = normalizeForMatch(candidate.role || '');
    const cTag = normalizeForMatch(candidate.tag || '');
    const cHref = normalizeForMatch(candidate.href || '');
    const cId = String(candidate.id || '');
    const cSelector = String(candidate.selector || '');

    let boost = 0;
    let hits = 0;
    for (const row of store.entries) {
        if (row.host !== host) continue;
        if (row.intent !== intent) continue;

        let matched = false;
        if (cSelector && row.selector && cSelector === row.selector) matched = true;
        if (!matched && cId && row.id && cId === row.id) matched = true;
        if (!matched && cTag && row.tag && cTag === normalizeForMatch(row.tag)) matched = true;
        if (!matched && cRole && row.role && cRole === normalizeForMatch(row.role)) matched = true;
        if (!matched && cHref && row.href && cHref && cHref.includes(normalizeForMatch(row.href))) matched = true;
        if (!matched && cText && row.text && (cText === normalizeForMatch(row.text) || cText.includes(normalizeForMatch(row.text)))) matched = true;
        if (!matched) continue;

        const successCount = Number(row.successCount || 0);
        const failCount = Number(row.failCount || 0);
        const confidence = Math.max(0, successCount - failCount * 1.2);
        boost += Math.min(42, 8 + confidence * 5);
        hits += 1;
    }

    return { boost, hits };
}

function getPreflightAnalysePlotSummary(pageUrl = '', targetAction = '') {
    const host = normalizeHostFromUrl(pageUrl);
    const store = loadPreflightAnalysePlotStore();
    const hostEntries = host ? store.entries.filter((x) => x.host === host) : [];
    const totalSuccesses = hostEntries.reduce((sum, x) => sum + Number(x.successCount || 0), 0);
    const totalFailures = hostEntries.reduce((sum, x) => sum + Number(x.failCount || 0), 0);

    return {
        feature: PREFLGIHT_ANALYSE_PLOT_NAME,
        enabled: true,
        filePath: getPreflightAnalysePlotPath(),
        host,
        targetAction: normalizeForMatch(targetAction || ''),
        hostEntryCount: hostEntries.length,
        hostSuccesses: totalSuccesses,
        hostFailures: totalFailures,
        totalEntryCount: store.entries.length
    };
}

function normalizeForMatch(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function buildInteractiveSnapshot(page) {
    return await page.evaluate(() => {
        const selectors = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [aria-haspopup], [onclick], [data-rex-id], [data-rex-nav-id]';
        const elements = Array.from(document.querySelectorAll(selectors));
        const out = [];

        const extensionData = Array.isArray(window.__rexPreflightData) ? window.__rexPreflightData : [];
        const metaById = new Map(extensionData.map((m) => [String(m?.id || ''), m]));

        const pickText = (el) => (
            el.innerText ||
            el.textContent ||
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            ''
        ).replace(/\s+/g, ' ').trim();

        for (const el of elements) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            const inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight;
            const id = el.getAttribute('data-rex-id') || el.getAttribute('data-rex-nav-id') || '';
            const role = el.getAttribute('role') || '';
            const tag = el.tagName.toLowerCase();
            const href = el.getAttribute('href') || '';
            const name = el.getAttribute('name') || '';
            const placeholder = el.getAttribute('placeholder') || '';
            const text = pickText(el);
            let parsedMeta = null;
            try {
                const rawMeta = el.getAttribute('data-rex-nav-meta');
                if (rawMeta) parsedMeta = JSON.parse(rawMeta);
            } catch {
                parsedMeta = null;
            }

            const extMeta = parsedMeta || metaById.get(String(id || '')) || null;

            let selector = '';
            if (id) selector = `[data-rex-id="${id}"], [data-rex-nav-id="${id}"]`;
            else if (el.id) selector = `#${CSS.escape(el.id)}`;
            else if (name) selector = `${tag}[name="${CSS.escape(name)}"]`;

            out.push({
                id,
                selector,
                text,
                role,
                tag,
                href,
                name,
                placeholder,
                label: String(extMeta?.label || ''),
                anchorHeading: String(extMeta?.anchorHeading || ''),
                anchorSection: String(extMeta?.anchorSection || ''),
                formIntent: extMeta?.formIntent && typeof extMeta.formIntent === 'object'
                    ? extMeta.formIntent
                    : { primary: '', tags: [] },
                confidence: Number(extMeta?.confidence || 0),
                actionTags: Array.isArray(extMeta?.actionTags) ? extMeta.actionTags : [],
                stability: extMeta?.stability && typeof extMeta.stability === 'object'
                    ? extMeta.stability
                    : { sightings: 0, consecutiveSeen: 0, stabilityScore: 0 },
                obstruction: extMeta?.obstruction && typeof extMeta.obstruction === 'object'
                    ? extMeta.obstruction
                    : { blocked: false },
                inViewport,
                y: rect.top
            });
        }

        out.sort((a, b) => {
            if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
            return a.y - b.y;
        });

        return out.slice(0, 300);
    });
}

function inferFormIntentNeedles(args = {}) {
    const bag = normalizeForMatch([
        args.text,
        args.label,
        args.query,
        args.placeholder,
        args.targetText,
        args.heading,
        args.section
    ].filter(Boolean).join(' '));

    const out = new Set();
    if (!bag) return out;
    if (/\bemail\b/.test(bag) || /@/.test(String(args.text || ''))) out.add('email');
    if (/\b(pass|password|otp|pin|2fa|code)\b/.test(bag)) out.add('password');
    if (/\b(search|find|lookup|query)\b/.test(bag)) out.add('search');
    if (/\b(address|street|city|state|zip|postal|country|shipping|billing)\b/.test(bag)) out.add('address');
    if (/\b(phone|mobile|tel|contact)\b/.test(bag)) out.add('phone');
    if (/\bname|first|last|full name\b/.test(bag)) out.add('name');
    return out;
}

function scoreTargetCandidate(candidate, args) {
    const textNeedle = normalizeForMatch(args.text || args.label || args.query || '');
    const hrefNeedle = normalizeForMatch(args.hrefContains || args.urlContains || '');
    const roleNeedle = normalizeForMatch(args.role || '');
    const placeholderNeedle = normalizeForMatch(args.placeholder || '');
    const headingNeedle = normalizeForMatch(args.heading || args.contextHeading || '');
    const sectionNeedle = normalizeForMatch(args.section || args.contextSection || '');
    const labelNeedle = normalizeForMatch(args.label || args.targetText || '');
    const action = normalizeForMatch(args.action || '');

    const cText = normalizeForMatch(candidate.text);
    const cHref = normalizeForMatch(candidate.href);
    const cRole = normalizeForMatch(candidate.role);
    const cPlaceholder = normalizeForMatch(candidate.placeholder);
    const cHeading = normalizeForMatch(candidate.anchorHeading || '');
    const cSection = normalizeForMatch(candidate.anchorSection || '');
    const cLabel = normalizeForMatch(candidate.label || '');
    const cIntentPrimary = normalizeForMatch(candidate.formIntent?.primary || '');
    const cIntentTags = Array.isArray(candidate.formIntent?.tags)
        ? candidate.formIntent.tags.map((t) => normalizeForMatch(t)).filter(Boolean)
        : [];
    const cActionTags = Array.isArray(candidate.actionTags)
        ? candidate.actionTags.map((t) => normalizeForMatch(t)).filter(Boolean)
        : [];
    const intentNeedles = inferFormIntentNeedles(args);

    let score = 0;
    if (candidate.inViewport) score += 20;
    if (candidate.id) score += 8;

    if (textNeedle) {
        if (cText === textNeedle) score += 120;
        else if (cText.includes(textNeedle)) score += 70;
    }

    if (hrefNeedle) {
        if (cHref === hrefNeedle) score += 80;
        else if (cHref.includes(hrefNeedle)) score += 60;
    }

    if (roleNeedle) {
        if (cRole === roleNeedle) score += 50;
    }

    if (placeholderNeedle) {
        if (cPlaceholder === placeholderNeedle) score += 55;
        else if (cPlaceholder.includes(placeholderNeedle)) score += 35;
    }

    if (headingNeedle) {
        if (cHeading === headingNeedle) score += 34;
        else if (cHeading.includes(headingNeedle)) score += 22;
    }

    if (sectionNeedle) {
        if (cSection === sectionNeedle) score += 30;
        else if (cSection.includes(sectionNeedle)) score += 18;
    }

    if (labelNeedle) {
        if (cLabel === labelNeedle) score += 40;
        else if (cLabel.includes(labelNeedle)) score += 24;
    }

    if ((action === 'type' || action === 'fill') && intentNeedles.size > 0) {
        for (const need of intentNeedles) {
            if (cIntentPrimary === need) score += 36;
            else if (cIntentTags.includes(need)) score += 28;
        }
    }

    if (candidate.confidence > 0) {
        score += Math.min(30, Math.floor(Number(candidate.confidence || 0) * 0.34));
    }

    if (candidate.stability?.stabilityScore > 0) {
        score += Math.min(20, Math.floor(Number(candidate.stability.stabilityScore || 0) * 0.2));
    }

    if (action && cActionTags.includes(action)) {
        score += 22;
    }

    if (candidate.obstruction?.blocked) {
        score -= 110;
        if (normalizeForMatch(candidate.obstruction?.by || '').includes('cookie')) score -= 8;
        if (normalizeForMatch(candidate.obstruction?.byTag || '') === 'dialog') score -= 12;
    }

    if (args.preferLinks && candidate.tag === 'a') score += 20;
    if (args.preferButtons && (candidate.tag === 'button' || cRole === 'button')) score += 20;
    return score;
}

async function resolveTargetSelector(page, args = {}) {
    if (args.selector && typeof args.selector === 'string') {
        return { ok: true, selector: args.selector, reason: 'explicit selector' };
    }

    if (args.id !== undefined && args.id !== null && String(args.id).trim() !== '') {
        const id = String(args.id).trim();
        return { ok: true, selector: `[data-rex-id="${id}"], [data-rex-nav-id="${id}"]`, reason: 'numeric marker id' };
    }

    const snapshot = await buildInteractiveSnapshot(page);
    if (!snapshot.length) {
        return { ok: false, error: 'No interactive elements detected on page.' };
    }

    const currentUrl = page.url() || '';
    const action = String(args.action || '').trim().toLowerCase();

    let best = null;
    let bestScore = -1;
    let bestPlotHits = 0;
    for (const candidate of snapshot) {
        const baseScore = scoreTargetCandidate(candidate, args);
        const plot = getPreflightAnalysePlotBoost({
            pageUrl: currentUrl,
            action,
            args,
            candidate
        });
        const score = baseScore + plot.boost;
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
            bestPlotHits = plot.hits;
        }
    }

    if (!best || bestScore < 30) {
        const preview = snapshot.slice(0, 8).map((x) => `${x.id || '?'}:${x.tag}:${x.text || x.placeholder || x.href || 'untitled'}`).join(' | ');
        return { ok: false, error: `Could not confidently resolve target. Top visible candidates: ${preview}` };
    }

    const selector = best.selector || (best.id ? `[data-rex-id="${best.id}"], [data-rex-nav-id="${best.id}"]` : '');
    if (!selector) {
        return { ok: false, error: 'Resolved candidate lacks a stable selector.' };
    }

    return {
        ok: true,
        selector,
        reason: `resolved by semantic match (${best.tag}, score=${bestScore}, plotHits=${bestPlotHits})`,
        candidate: best
    };
}

async function robustClick(page, selector) {
    try {
        const locator = page.locator(selector).first();
        await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        await locator.click({ timeout: 9000 });
        return { ok: true, mode: 'locator.click' };
    } catch (e1) {
        try {
            await page.click(selector, { timeout: 9000, force: true });
            return { ok: true, mode: 'page.click(force)' };
        } catch (e2) {
            try {
                const clicked = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return false;
                    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    el.click();
                    return true;
                }, selector);
                if (clicked) return { ok: true, mode: 'dom.click-fallback' };
                return { ok: false, error: `Element not found for selector: ${selector}` };
            } catch (e3) {
                return { ok: false, error: `${e1.message}; ${e2.message}; ${e3.message}` };
            }
        }
    }
}

async function robustType(page, selector, text, pressEnter = true) {
    try {
        const locator = page.locator(selector).first();
        await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        await locator.fill(text, { timeout: 9000 });
        if (pressEnter) await locator.press('Enter').catch(() => {});
        return { ok: true, mode: 'locator.fill' };
    } catch (e1) {
        try {
            await page.fill(selector, text, { timeout: 9000 });
            if (pressEnter) await page.press(selector, 'Enter').catch(() => {});
            return { ok: true, mode: 'page.fill' };
        } catch (e2) {
            return { ok: false, error: `${e1.message}; ${e2.message}` };
        }
    }
}

async function robustHover(page, selector) {
    try {
        const locator = page.locator(selector).first();
        await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        await locator.hover({ timeout: 8000 });
        return { ok: true, mode: 'locator.hover' };
    } catch (e1) {
        try {
            await page.hover(selector, { timeout: 8000 });
            return { ok: true, mode: 'page.hover' };
        } catch (e2) {
            return { ok: false, error: `${e1.message}; ${e2.message}` };
        }
    }
}

const VISUAL_CURSOR_DEFAULT_SVG = `<svg height="32" viewBox="0 0 32 32" width="32" xmlns="http://www.w3.org/2000/svg"><g fill="none" fill-rule="evenodd" transform="translate(10 7)"><path d="m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z" fill="#fff"/><path d="m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z" fill="#000"/></g></svg>`;
const VISUAL_CURSOR_HANDOPEN_SVG = `<svg height="32" viewBox="0 0 32 32" width="32" xmlns="http://www.w3.org/2000/svg"><g fill="none" fill-rule="evenodd" transform="translate(7 6)"><path d="m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121" fill="#fff"/><g stroke="#000" stroke-linecap="round" stroke-width=".75"><path d="m4.5557 8.5742c-.098-.375-.196-.847-.406-1.552-.167-.557-.342-.859-.47-1.233-.155-.455-.303-.721-.496-1.181-.139-.329-.364-1.048-.457-1.44-.119-.509.033-.924.244-1.206.253-.339.962-.49 1.357-.351.371.13.744.512.916.788.288.46.357.632.717 1.542.393.992.564 1.918.611 2.231l.085.452c-.001-.04-.043-1.122-.044-1.162-.035-1.029-.06-1.823-.038-2.939.002-.126.064-.587.084-.715.078-.5.305-.8.673-.979.412-.201.926-.215 1.401-.017.423.173.626.55.687 1.022.014.109.094.987.093 1.107-.013 1.025.006 1.641.015 2.174.004.231.003 1.625.017 1.469.061-.656.094-3.189.344-3.942.144-.433.405-.746.794-.929.431-.203 1.113-.07 1.404.243.285.305.446.692.482 1.153.032.405-.019.897-.02 1.245 0 .867-.021 1.324-.037 2.121-.001.038-.015.298.023.182.094-.28.188-.542.266-.745.049-.125.241-.614.359-.859.114-.234.211-.369.415-.688.2-.313.415-.448.668-.561.54-.235 1.109.112 1.301.591.086.215.009.713-.028 1.105-.061.647-.254 1.306-.352 1.648-.128.447-.274 1.235-.34 1.601-.072.394-.234 1.382-.359 1.82-.086.301-.371.978-.652 1.384 0 0-1.074 1.25-1.192 1.812-.117.563-.078.567-.101.965-.024.399.121.923.121.923s-.802.104-1.234.034c-.391-.062-.875-.841-1-1.078-.172-.328-.539-.265-.682-.023-.225.383-.709 1.07-1.051 1.113-.668.084-2.054.03-3.139.02 0 0 .185-1.011-.227-1.358-.305-.26-.83-.784-1.144-1.06l-.832-.921c-.284-.36-.629-1.093-1.243-1.985-.348-.504-1.027-1.085-1.284-1.579-.223-.425-.331-.954-.19-1.325.225-.594.675-.897 1.362-.832.519.05.848.206 1.238.537.225.19.573.534.75.748.163.195.203.276.377.509.23.307.302.459.214.121" stroke-linejoin="round"/><path d="m11.566 12.734v-3.459"/><path d="m9.551 12.746-.016-3.473"/><path d="m7.555 9.305.021 3.426"/></g></g></svg>`;

function loadCursorSvgAsset(name) {
    try {
        const filePath = path.join(process.cwd(), 'assets', `${String(name || '').toLowerCase()}.svg`);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf8');
        }
    } catch {
        // Non-fatal fallback.
    }
    return '';
}

const VISUAL_CURSOR_STYLE_MAP = {
    default: loadCursorSvgAsset('default') || VISUAL_CURSOR_DEFAULT_SVG,
    handopen: loadCursorSvgAsset('handopen') || VISUAL_CURSOR_HANDOPEN_SVG,
    handpointing: loadCursorSvgAsset('handpointing') || VISUAL_CURSOR_DEFAULT_SVG,
    handgrabbing: loadCursorSvgAsset('handgrabbing') || VISUAL_CURSOR_HANDOPEN_SVG,
    busy: loadCursorSvgAsset('busy') || VISUAL_CURSOR_DEFAULT_SVG,
    beachball: loadCursorSvgAsset('beachball') || VISUAL_CURSOR_DEFAULT_SVG,
    copy: loadCursorSvgAsset('copy') || VISUAL_CURSOR_DEFAULT_SVG
};

function pickBrowserCursorStyle(action = '') {
    const a = String(action || '').toLowerCase();
    if (a === 'click') return 'handpointing';
    if (a === 'hover') return 'handopen';
    if (a === 'type') return 'handgrabbing';
    if (a === 'search' || a === 'navigate' || a === 'wait_for_auth') return 'beachball';
    if (a === 'wait') return 'busy';
    return 'default';
}

async function ensureVisualCursor(page, style = 'default') {
    const desiredStyle = String(style || 'default').toLowerCase();
    await page.evaluate(({ styleMap, desiredStyle }) => {
        if (window.__rex_visual_cursor?.version === 3) {
            window.__rex_visual_cursor.setStyle(desiredStyle);
            return;
        }
        if (window.__rex_visual_cursor?.host && window.__rex_visual_cursor.host.isConnected) {
            window.__rex_visual_cursor.host.remove();
        }
        window.__rex_visual_cursor = null;

        const styleId = 'rex-visual-cursor-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .rex-visual-cursor {
                    position: fixed;
                    left: 0;
                    top: 0;
                    width: 0;
                    height: 0;
                    z-index: 2147483647;
                    pointer-events: none;
                }
                .rex-visual-cursor-icon {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 32px;
                    height: 32px;
                    transform: translate(-4px, -3px);
                    transform-origin: 10px 7px;
                    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
                    transition: transform 140ms ease, filter 140ms ease;
                }
                .rex-visual-cursor.selecting .rex-visual-cursor-icon {
                    transform: translate(-4px, -3px) scale(0.95);
                    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.4));
                }
            `;
            document.documentElement.appendChild(style);
        }

        const el = document.createElement('div');
        el.className = 'rex-visual-cursor';
        const parseSvg = (svgMarkup) => {
            const tpl = document.createElement('template');
            tpl.innerHTML = String(svgMarkup || '').trim();
            const node = tpl.content.firstElementChild;
            if (!node || String(node.tagName || '').toLowerCase() !== 'svg') return null;
            node.classList.add('rex-visual-cursor-icon');
            node.setAttribute('aria-hidden', 'true');
            return node;
        };

        const icons = {};
        for (const [key, markup] of Object.entries(styleMap || {})) {
            const icon = parseSvg(markup);
            if (!icon) continue;
            icon.style.display = 'none';
            icons[key] = icon;
            el.appendChild(icon);
        }

        const hasAnyIcon = Object.keys(icons).length > 0;

        if (!hasAnyIcon) {
            const fallback = document.createElement('div');
            fallback.className = 'rex-visual-cursor-icon';
            fallback.style.borderRadius = '999px';
            fallback.style.background = '#d0d4dc';
            fallback.style.border = '1px solid #969baa';
            fallback.style.width = '10px';
            fallback.style.height = '10px';
            fallback.style.transform = 'translate(-50%, -50%)';
            el.appendChild(fallback);
        }

        // 8-Bit Baby T-Rex Dino Companion alongside Cursor
        const dinoWrap = document.createElement('div');
        dinoWrap.className = 'rex-visual-dino-wrap';
        dinoWrap.style.cssText = 'position:absolute;left:16px;top:10px;pointer-events:none;filter:drop-shadow(0 4px 8px rgba(0,0,0,0.45));';

        const dinoCanvas = document.createElement('canvas');
        dinoCanvas.width = 32;
        dinoCanvas.height = 32;
        dinoCanvas.style.cssText = 'width:36px;height:36px;image-rendering:pixelated;';
        dinoWrap.appendChild(dinoCanvas);
        el.appendChild(dinoWrap);

        const dCtx = dinoCanvas.getContext('2d');
        if (dCtx) dCtx.imageSmoothingEnabled = false;

        let dFrame = 0;
        let dState = 'idle'; // 'idle', 'walk', 'happy'
        let dBlink = false;

        const C = {
            g1: '#38ef7d', g2: '#11998e', g3: '#0b5345',
            y1: '#f9ca24', y2: '#f0932b', w: '#ffffff',
            k: '#130f40', p: '#ff7979', o: '#eb4d4b'
        };

        function drawRect(x, y, w, h, col) {
            if (!dCtx) return;
            dCtx.fillStyle = col;
            dCtx.fillRect(x, y, w, h);
        }

        function renderVisualDino() {
            if (!dCtx) return;
            dCtx.clearRect(0, 0, 32, 32);
            let bounceY = 0;
            if (dState === 'idle') bounceY = (Math.floor(dFrame / 25) % 2 === 0) ? 0 : 1;
            else if (dState === 'walk') bounceY = (Math.floor(dFrame / 8) % 2 === 0) ? 0 : 2;
            else if (dState === 'happy') bounceY = (Math.floor(dFrame / 6) % 2 === 0) ? 0 : 3;

            const y0 = 4 - bounceY;

            // Spikes
            drawRect(9, y0 + 5, 2, 2, C.g3);
            drawRect(8, y0 + 9, 2, 2, C.g3);
            drawRect(7, y0 + 13, 2, 2, C.g3);

            // Head
            drawRect(11, y0 + 3, 13, 11, C.g1);
            drawRect(24, y0 + 6, 4, 8, C.g1);
            drawRect(10, y0 + 4, 1, 9, C.g3);
            drawRect(11, y0 + 2, 13, 1, C.g3);
            drawRect(24, y0 + 5, 4, 1, C.g3);
            drawRect(28, y0 + 6, 1, 7, C.g3);
            drawRect(11, y0 + 12, 13, 2, C.g2);
            drawRect(24, y0 + 12, 3, 2, C.g2);

            // Eye
            if (dBlink) {
                drawRect(17, y0 + 7, 5, 1, C.k);
            } else {
                drawRect(17, y0 + 5, 5, 5, C.w);
                drawRect(19, y0 + 6, 3, 4, C.k);
                drawRect(19, y0 + 6, 1, 1, C.w);
            }

            // Blush & Snout
            drawRect(15, y0 + 10, 3, 2, C.p);
            drawRect(24, y0 + 10, 3, 1, C.g3);

            // Body
            drawRect(10, y0 + 14, 12, 11, C.g1);
            drawRect(9, y0 + 15, 1, 9, C.g3);
            drawRect(10, y0 + 23, 12, 2, C.g2);
            drawRect(16, y0 + 14, 6, 8, C.y1);
            drawRect(17, y0 + 21, 5, 1, C.y2);

            // Arms
            if (dState === 'happy') {
                drawRect(22, y0 + 13, 3, 2, C.g1);
            } else {
                drawRect(21, y0 + 16, 3, 2, C.g1);
            }

            // Tail wag
            const tailWag = (Math.floor(dFrame / 14) % 2 === 0);
            if (tailWag) {
                drawRect(6, y0 + 18, 4, 4, C.g1);
                drawRect(3, y0 + 19, 3, 3, C.g1);
                drawRect(2, y0 + 20, 2, 2, C.g1);
            } else {
                drawRect(6, y0 + 19, 4, 4, C.g1);
                drawRect(3, y0 + 21, 3, 3, C.g1);
                drawRect(1, y0 + 23, 2, 2, C.g1);
            }

            // Feet
            drawRect(12, y0 + 25, 3, 3, C.g3);
            drawRect(17, y0 + 25, 3, 3, C.g3);
        }

        function dinoAnimLoop() {
            dFrame++;
            if (dFrame % 180 === 0) dBlink = true;
            if (dFrame % 180 === 12) dBlink = false;
            renderVisualDino();
            requestAnimationFrame(dinoAnimLoop);
        }
        requestAnimationFrame(dinoAnimLoop);

        document.documentElement.appendChild(el);

        const state = {
            x: Math.round(window.innerWidth * 0.8),
            y: Math.round(window.innerHeight * 0.5),
            raf: null,
            style: 'default'
        };

        const showOnly = (name) => {
            const key = icons[name] ? name : (icons.default ? 'default' : Object.keys(icons)[0]);
            for (const k of Object.keys(icons)) {
                icons[k].style.display = k === key ? 'block' : 'none';
            }
            state.style = key || 'default';
            return state.style;
        };

        const setPos = (x, y) => {
            state.x = Math.max(8, Math.min(window.innerWidth - 8, x));
            state.y = Math.max(8, Math.min(window.innerHeight - 8, y));
            el.style.left = `${state.x}px`;
            el.style.top = `${state.y}px`;
        };

        setPos(state.x, state.y);

        const moveTo = (x, y, duration = 260) => new Promise((resolve) => {
            if (state.raf) cancelAnimationFrame(state.raf);

            dState = 'walk';
            const startX = state.x;
            const startY = state.y;
            const endX = x;
            const endY = y;
            const t0 = performance.now();

            const tick = (now) => {
                const p = Math.min(1, (now - t0) / Math.max(80, duration));
                const eased = 1 - Math.pow(1 - p, 3);
                const nx = startX + (endX - startX) * eased;
                const ny = startY + (endY - startY) * eased;
                setPos(nx, ny);
                if (p < 1) {
                    state.raf = requestAnimationFrame(tick);
                } else {
                    state.raf = null;
                    dState = 'idle';
                    resolve();
                }
            };

            state.raf = requestAnimationFrame(tick);
        });

        const clickPulse = () => {
            const before = state.style || 'default';
            const pressed = icons.handgrabbing ? 'handgrabbing' : before;
            dState = 'happy';
            showOnly(pressed);
            window.setTimeout(() => {
                showOnly(before);
                dState = 'idle';
            }, 170);
        };

        const setStyle = (name) => showOnly(String(name || 'default').toLowerCase());

        const park = (side = 'auto') => {
            const sidePick = side === 'auto' ? (Math.random() > 0.5 ? 'left' : 'right') : side;
            const targetX = sidePick === 'left' ? window.innerWidth * 0.2 : window.innerWidth * 0.8;
            const targetY = window.innerHeight * 0.5;
            return moveTo(targetX, targetY, 240);
        };

        window.__rex_visual_cursor = {
            version: 3,
            host: el,
            moveTo,
            clickPulse,
            park,
            setStyle,
            current: () => ({ x: state.x, y: state.y, style: state.style || 'default' })
        };

        setStyle(desiredStyle);
    }, {
        styleMap: VISUAL_CURSOR_STYLE_MAP,
        desiredStyle
    }).catch(() => {});
}

async function cursorMoveToSelector(page, selector, duration = 260, style = 'default') {
    await ensureVisualCursor(page, style);
    await page.evaluate(async ({ sel, duration, style }) => {
        const cursor = window.__rex_visual_cursor;
        if (!cursor) return;
        cursor.setStyle(style);
        const el = document.querySelector(sel);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        await cursor.moveTo(x, y, duration);
    }, { sel: selector, duration, style }).catch(() => {});
}

async function cursorClickPulse(page, style = 'handpointing') {
    await ensureVisualCursor(page, style);
    await page.evaluate(({ style }) => {
        window.__rex_visual_cursor?.setStyle(style);
        window.__rex_visual_cursor?.clickPulse();
    }, { style }).catch(() => {});
}

async function cursorParkIdle(page, side = 'auto', style = 'default') {
    await ensureVisualCursor(page, style);
    await page.evaluate(async ({ side, style }) => {
        if (window.__rex_visual_cursor) {
            window.__rex_visual_cursor.setStyle(style);
            await window.__rex_visual_cursor.park(side);
        }
    }, { side, style }).catch(() => {});
}

function getBabysitNotesPath() {
    return path.join(process.cwd(), '.rex', 'babysit-notes.json');
}

function ensureBabysitNotesDir() {
    const dir = path.dirname(getBabysitNotesPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadBabysitNotesStore() {
    const filePath = getBabysitNotesPath();
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.entries) return parsed;
        }
    } catch {
        // Corrupt note file should not crash runtime.
    }

    return {
        feature: 'Babysit Notes',
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        entries: []
    };
}

function saveBabysitNotesStore(store) {
    try {
        ensureBabysitNotesDir();
        const normalized = {
            feature: 'Babysit Notes',
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            entries: Array.isArray(store?.entries) ? store.entries.slice(-3000) : []
        };
        fs.writeFileSync(getBabysitNotesPath(), JSON.stringify(normalized, null, 2), 'utf8');
    } catch {
        // Persistence failure is non-fatal.
    }
}

function hostFromUrl(url = '') {
    try {
        return new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
        return '';
    }
}

async function setBabysitCursorFollow(page, enabled = true) {
    await ensureVisualCursor(page, pickBrowserCursorStyle('default'));
    await page.evaluate(({ enabled }) => {
        const key = '__rexBabysitCursorSync';
        const win = window;

        if (!enabled) {
            const prev = win[key];
            if (prev && prev.handler) {
                window.removeEventListener('mousemove', prev.handler, true);
                window.removeEventListener('pointermove', prev.handler, true);
                window.removeEventListener('rex-babysit-replay-move', prev.replayHandler, true);
                window.removeEventListener('rex-babysit-feedback', prev.feedbackHandler, true);
            }
            delete win[key];
            return;
        }

        if (win[key]?.enabled) return;

        const throttled = { busy: false };
        if (!Array.isArray(window.__rexBabysitMoves)) {
            window.__rexBabysitMoves = [];
        }
        if (!Array.isArray(window.__rexBabysitFeedback)) {
            window.__rexBabysitFeedback = [];
        }

        const handler = (event) => {
            const cursor = window.__rex_visual_cursor;
            if (!cursor || throttled.busy) return;
            const now = Date.now();
            const prev = window.__rexBabysitMoves.length > 0
                ? window.__rexBabysitMoves[window.__rexBabysitMoves.length - 1]
                : null;

            if (!prev || Math.hypot((event.clientX - prev.x), (event.clientY - prev.y)) >= 12 || (now - prev.t) >= 450) {
                window.__rexBabysitMoves.push({ x: event.clientX, y: event.clientY, t: now });
                if (window.__rexBabysitMoves.length > 350) {
                    window.__rexBabysitMoves = window.__rexBabysitMoves.slice(-350);
                }
            }

            throttled.busy = true;
            cursor.setStyle('default');
            cursor.moveTo(event.clientX, event.clientY, 36).finally(() => {
                window.setTimeout(() => { throttled.busy = false; }, 18);
            });
        };

        const replayHandler = async () => {
            const cursor = window.__rex_visual_cursor;
            const moves = Array.isArray(window.__rexBabysitMoves) ? window.__rexBabysitMoves : [];
            if (!cursor || moves.length < 2) return;

            let i = moves.length - 1;
            let from = moves[i - 1];
            let to = moves[i];
            while (i > 1 && Math.hypot((to.x - from.x), (to.y - from.y)) < 22) {
                i -= 1;
                from = moves[i - 1];
                to = moves[i];
            }

            cursor.setStyle('handopen');
            await cursor.moveTo(from.x, from.y, 130);
            await cursor.moveTo(to.x, to.y, 340);
            cursor.clickPulse();
        };

        const feedbackHandler = (event) => {
            const detail = event?.detail || {};
            window.__rexBabysitFeedback.push({
                at: new Date().toISOString(),
                taskId: String(detail.taskId || ''),
                verdict: String(detail.verdict || ''),
                note: String(detail.note || '').slice(0, 240)
            });
            if (window.__rexBabysitFeedback.length > 240) {
                window.__rexBabysitFeedback = window.__rexBabysitFeedback.slice(-240);
            }
        };

        window.addEventListener('mousemove', handler, true);
        window.addEventListener('pointermove', handler, true);
        window.addEventListener('rex-babysit-replay-move', replayHandler, true);
        window.addEventListener('rex-babysit-feedback', feedbackHandler, true);
        win[key] = { enabled: true, handler, replayHandler, feedbackHandler };
    }, { enabled: !!enabled }).catch(() => {});
}

async function triggerBabysitPromptInPage(page, payload = {}) {
    return await page.evaluate((detail) => {
        const rootId = 'rex-babysit-fallback-root';
        const styleId = 'rex-babysit-fallback-style';

        const ensureFallbackStyle = () => {
            if (document.getElementById(styleId)) return;
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                #${rootId} {
                    position: fixed;
                    right: 18px;
                    top: 16px;
                    width: min(340px, 90vw);
                    z-index: 2147483647;
                    font-family: "Segoe UI", Tahoma, sans-serif;
                }
                #${rootId} .rex-card {
                    background: rgba(255, 255, 255, 0.94);
                    border: 1px solid rgba(17, 24, 39, 0.08);
                    border-radius: 12px;
                    box-shadow: 0 12px 28px rgba(2, 6, 23, 0.12);
                    backdrop-filter: blur(8px);
                    padding: 10px 10px 9px 10px;
                    color: #0f172a;
                }
                #${rootId} .rex-title { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin: 0 0 6px 0; }
                #${rootId} .rex-task { font-size: 14px; font-weight: 600; margin: 0 0 4px 0; }
                #${rootId} .rex-note { font-size: 12px; color: #475569; margin: 0 0 8px 0; }
                #${rootId} .rex-actions { display: flex; gap: 8px; }
                #${rootId} button { border: 1px solid rgba(15,23,42,.12); border-radius: 999px; padding: 6px 10px; font-size: 11px; font-weight: 600; cursor: pointer; background: #f8fafc; color: #0f172a; }
                #${rootId} .rex-which { background: #0f172a; color: #f8fafc; border-color: #0f172a; }
                #${rootId} .rex-yes { background: #ecfeff; color: #155e75; border-color: #67e8f9; }
                #${rootId} .rex-no { background: #fff1f2; color: #9f1239; border-color: #fecdd3; }
                #${rootId} .rex-swoosh { display: inline-block; opacity: 0; transform: translateX(16px) skewX(-8deg); filter: blur(1px); animation: rexSwoosh .42s cubic-bezier(.19,.84,.31,1) forwards; }
                #${rootId} .rex-note.rex-swoosh { animation-delay: .06s; }
                @keyframes rexSwoosh {
                    from { opacity: 0; transform: translateX(16px) skewX(-8deg); filter: blur(1px); }
                    to { opacity: 1; transform: translateX(0) skewX(0); filter: blur(0); }
                }
            `;
            document.documentElement.appendChild(style);
        };

        const removeFallback = () => {
            const existing = document.getElementById(rootId);
            if (existing) existing.remove();
        };

        const showFallback = () => {
            ensureFallbackStyle();
            removeFallback();

            const taskId = String(detail?.taskId || `task-${Date.now()}`);
            const task = String(detail?.task || 'hmm... please complete this step.');
            const note = String(detail?.note || 'wait, was that move necessary?');

            const root = document.createElement('div');
            root.id = rootId;
            root.innerHTML = `
                <div class="rex-card">
                    <div class="rex-title">Rex Babysit Request</div>
                    <div class="rex-task rex-swoosh"></div>
                    <div class="rex-note rex-swoosh"></div>
                    <div class="rex-actions">
                        <button class="rex-which">which move?</button>
                        <button class="rex-yes">yes</button>
                        <button class="rex-no">no</button>
                    </div>
                </div>
            `;

            root.querySelector('.rex-task').textContent = task;
            root.querySelector('.rex-note').textContent = note;

            root.querySelector('.rex-which')?.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('rex-babysit-replay-move', { detail: { taskId } }));
            });

            root.querySelector('.rex-yes')?.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('rex-babysit-feedback', {
                    detail: { taskId, verdict: 'yes', note: 'Marked as useful/important move' }
                }));
                removeFallback();
            });

            root.querySelector('.rex-no')?.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('rex-babysit-feedback', {
                    detail: { taskId, verdict: 'no', note: 'Marked as not useful' }
                }));
                removeFallback();
            });

            document.documentElement.appendChild(root);
        };

        window.dispatchEvent(new CustomEvent('rex-babysit-prompt', { detail }));

        // Fallback in case extension listener is unavailable in this tab/context.
        window.setTimeout(() => {
            const extRoot = document.getElementById('rex-babysit-prompt-root');
            const fallbackRoot = document.getElementById(rootId);
            if (!extRoot && !fallbackRoot) {
                showFallback();
            }
        }, 140);

        return true;
    }, payload).catch(() => false);
}

function stopBabysitAutoCapture() {
    if (manager.babysitAutoCapture?.timer) {
        clearInterval(manager.babysitAutoCapture.timer);
    }
    manager.babysitAutoCapture = {
        timer: null,
        running: false,
        intervalMs: 0,
        lastError: ''
    };
}

function startBabysitAutoCapture(options = {}) {
    stopBabysitAutoCapture();
    const intervalMs = Math.max(10000, Number(options.intervalMs || 18000));
    const model = String(options.model || manager.babysitSession.model || 'gpt-5-nano');

    manager.babysitAutoCapture.intervalMs = intervalMs;
    manager.babysitAutoCapture.timer = setInterval(async () => {
        if (!manager.babysitSession?.active || manager.babysitAutoCapture.running) return;
        manager.babysitAutoCapture.running = true;
        try {
            const page = await manager.getPage();
            const snapshot = await collectBabysitSnapshot(page, {
                task: manager.babysitSession.goal || '',
                note: 'auto-capture'
            });
            const summary = await summarizeBabysitSnapshot(snapshot, {
                askModel: true,
                model
            });
            persistBabysitNote(snapshot, summary);
            manager.babysitSession.snapshots = Number(manager.babysitSession.snapshots || 0) + 1;
            manager.babysitSession.notesSaved = Number(manager.babysitSession.notesSaved || 0) + 1;

            const feedbackRecent = Array.isArray(snapshot?.moveLearning?.feedbackRecent)
                ? snapshot.moveLearning.feedbackRecent
                : [];
            const yesCount = feedbackRecent.filter((x) => String(x?.verdict || '').toLowerCase() === 'yes').length;
            const noCount = feedbackRecent.filter((x) => String(x?.verdict || '').toLowerCase() === 'no').length;
            manager.babysitSession.feedback.useful = yesCount;
            manager.babysitSession.feedback.notUseful = noCount;

            if (snapshot?.moveLearning?.movesCount >= 8 && feedbackRecent.length === 0 && (manager.babysitSession.snapshots % 2 === 1)) {
                await triggerBabysitPromptInPage(page, {
                    taskId: `babysit-auto-${Date.now()}`,
                    task: 'hmm... wait, was that move necessary?',
                    note: 'click which move to replay and label yes/no.'
                });
            }
        } catch (err) {
            manager.babysitAutoCapture.lastError = String(err?.message || err);
        } finally {
            manager.babysitAutoCapture.running = false;
        }
    }, intervalMs);
}

async function collectBabysitSnapshot(page, args = {}) {
    const url = page.url() || '';
    const title = await page.title().catch(() => 'Unknown');
    const snapshot = await buildInteractiveSnapshot(page).catch(() => []);

    const sample = snapshot.slice(0, 60).map((x) => ({
        id: x.id || '',
        tag: x.tag || '',
        role: x.role || '',
        text: String(x.text || '').slice(0, 140),
        placeholder: String(x.placeholder || '').slice(0, 90),
        href: String(x.href || '').slice(0, 220),
        inViewport: !!x.inViewport
    }));

    const moveAndFeedback = await page.evaluate(() => {
        const moves = Array.isArray(window.__rexBabysitMoves) ? window.__rexBabysitMoves : [];
        const feedback = Array.isArray(window.__rexBabysitFeedback) ? window.__rexBabysitFeedback : [];
        return {
            movesCount: moves.length,
            recentMoves: moves.slice(-20),
            feedbackCount: feedback.length,
            feedbackRecent: feedback.slice(-16)
        };
    }).catch(() => ({ movesCount: 0, recentMoves: [], feedbackCount: 0, feedbackRecent: [] }));

    return {
        at: new Date().toISOString(),
        url,
        title,
        host: hostFromUrl(url),
        task: String(args.task || args.goal || args.query || manager.babysitSession.goal || '').trim(),
        userNote: String(args.note || '').trim(),
        interactiveCount: snapshot.length,
        sample,
        moveLearning: moveAndFeedback
    };
}

async function summarizeBabysitSnapshot(snapshot, args = {}) {
    const askModel = args.askModel !== false;
    const model = String(args.model || manager.babysitSession.model || 'gpt-5-nano').trim() || 'gpt-5-nano';
    if (!askModel) {
        return {
            model,
            notes: [
                `Site host: ${snapshot.host || 'unknown'}`,
                `Top interactive elements observed: ${snapshot.interactiveCount}`,
                'Use this snapshot for selector confidence and repeat-task handling.'
            ],
            modelUsed: false
        };
    }

    try {
        const { runCompletionWithTarget } = await import('./ai.js');
        const prompt = [
            'You are assisting a browser babysit mode.',
            'Generate compact autonomous navigation notes from this snapshot.',
            'Return strict JSON with this shape:',
            '{"general":["..."],"siteSpecific":["..."],"taskSpecific":["..."]}',
            'Keep each bullet under 140 chars, max 5 items per section.',
            `Task: ${snapshot.task || 'unspecified'}`,
            `Host: ${snapshot.host}`,
            `Title: ${snapshot.title}`,
            `URL: ${snapshot.url}`,
            `Interactive sample: ${JSON.stringify(snapshot.sample.slice(0, 24))}`
        ].join('\n');

        const raw = await runCompletionWithTarget(
            [{ role: 'user', content: prompt }],
            { provider: 'openai', model },
            null
        );

        const parsed = parseFirstJsonObject(raw) || {};
        const general = Array.isArray(parsed.general) ? parsed.general.map((x) => String(x || '').trim()).filter(Boolean) : [];
        const siteSpecific = Array.isArray(parsed.siteSpecific) ? parsed.siteSpecific.map((x) => String(x || '').trim()).filter(Boolean) : [];
        const taskSpecific = Array.isArray(parsed.taskSpecific) ? parsed.taskSpecific.map((x) => String(x || '').trim()).filter(Boolean) : [];

        const fallback = [
            `Primary host path: ${snapshot.host || 'unknown'}`,
            `Prefer visible IDs first; avoid stale selectors on ${snapshot.title}`
        ];

        return {
            model,
            notes: [...general, ...siteSpecific, ...taskSpecific, ...fallback].filter(Boolean).slice(0, 16),
            modelUsed: true,
            raw: String(raw || '').slice(0, 1200)
        };
    } catch (err) {
        return {
            model,
            notes: [
                `Model summary unavailable: ${String(err?.message || err)}`,
                `Fallback note: keep interaction around top visible controls on ${snapshot.host || 'site'}.`
            ],
            modelUsed: false
        };
    }
}

function persistBabysitNote(snapshot, summary) {
    const store = loadBabysitNotesStore();
    const host = snapshot.host || hostFromUrl(snapshot.url || '');
    const entry = {
        at: snapshot.at || new Date().toISOString(),
        host,
        url: snapshot.url || '',
        title: snapshot.title || '',
        task: snapshot.task || '',
        model: summary.model || 'gpt-5-nano',
        modelUsed: !!summary.modelUsed,
        notes: Array.isArray(summary.notes) ? summary.notes.slice(0, 24) : [],
        sample: Array.isArray(snapshot.sample) ? snapshot.sample.slice(0, 24) : []
    };

    store.entries.push(entry);
    saveBabysitNotesStore(store);
    return entry;
}

function normalizeExtractedText(text) {
    return String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

function tokenizeQuery(query) {
    const stopwords = new Set([
        'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'from', 'with', 'and', 'or', 'is', 'are', 'be', 'was', 'were',
        'find', 'show', 'give', 'get', 'list', 'tell', 'what', 'which', 'who', 'where', 'when', 'how', 'all', 'about', 'into',
        'make', 'made', 'recipe', 'page', 'website', 'site'
    ]);

    return String(query || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !stopwords.has(t))
        .slice(0, 14);
}

function lineLooksLikeIngredient(line) {
    const l = String(line || '').trim().toLowerCase();
    if (!l || l.length < 3 || l.length > 130) return false;
    if (/^title:|^headings:|^main content:|^paragraphs:|^structured blocks:|^accessibility snapshot:|^full visible:/i.test(l)) return false;
    if (/^(method|instruction|directions|steps|prep|cook)\b/.test(l)) return false;
    if (/^[-*•\d\.)\s]+/.test(line)) return true;
    if (/\b(cup|cups|tbsp|tsp|teaspoon|tablespoon|gram|grams|g|kg|ml|l|pinch|salt|oil|onion|tomato|garlic|ginger|chili|paneer)\b/i.test(l)) return true;
    return false;
}

function scoreLineForFocus(line, tokens, intent = '') {
    const raw = String(line || '').trim();
    if (!raw) return -50;
    const l = raw.toLowerCase();
    let score = 0;

    if (l.length >= 8 && l.length <= 180) score += 4;
    if (/^[-*•\d\.)\s]+/.test(raw)) score += 8;

    for (const token of tokens) {
        if (l.includes(token)) score += 12;
    }

    if (intent === 'ingredients') {
        if (lineLooksLikeIngredient(raw)) score += 18;
        if (/\b(ingredients?)\b/.test(l)) score += 10;
    }

    if (intent === 'steps') {
        if (/\b(step|method|instruction|directions?)\b/.test(l)) score += 14;
    }

    if (intent === 'price') {
        if (/(\$|usd|inr|rs\.?|eur|price|cost|mrp)/i.test(raw)) score += 14;
    }

    if (/cookie|privacy policy|terms|subscribe|advertis/i.test(l)) score -= 18;
    return score;
}

function detectFocusIntent(query) {
    const q = String(query || '').toLowerCase();
    if (/ingredient|ingredients|what goes into|required to make/.test(q)) return 'ingredients';
    if (/steps|method|instructions|how to make/.test(q)) return 'steps';
    if (/price|cost|fare|rate/.test(q)) return 'price';
    return 'generic';
}

function buildFocusedAnswerSnippet(text, query, maxLines = 22) {
    const clean = normalizeExtractedText(text);
    if (!clean) return '';

    const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
    const tokens = tokenizeQuery(query);
    const intent = detectFocusIntent(query);

    if (intent === 'ingredients') {
        const ingredients = extractIngredientListFromText(clean);
        if (ingredients.length >= 3) {
            return ingredients.slice(0, maxLines).map((i) => `- ${i}`).join('\n');
        }
    }

    const scored = lines
        .map((line, idx) => ({ line, idx, score: scoreLineForFocus(line, tokens, intent) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxLines)
        .sort((a, b) => a.idx - b.idx)
        .map((x) => x.line);

    if (scored.length === 0) return '';
    return dedupeLines(scored.join('\n'), maxLines);
}

function dedupeLines(text, maxLines = 500) {
    const seen = new Set();
    const lines = normalizeExtractedText(text)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const out = [];
    for (const line of lines) {
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
        if (out.length >= maxLines) break;
    }

    return out.join('\n');
}

function flattenAccessibilityNode(node, collector) {
    if (!node) return;

    const role = String(node.role || '');
    const name = String(node.name || '').trim();
    const value = String(node.value || '').trim();

    const usefulRole = new Set(['heading', 'text', 'statictext', 'paragraph', 'link', 'button', 'listitem', 'cell']);
    if (usefulRole.has(role) && (name || value)) {
        const parts = [name, value].filter(Boolean);
        collector.push(parts.join(' '));
    }

    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            flattenAccessibilityNode(child, collector);
        }
    }
}

async function extractViaAccessibility(page) {
    try {
        const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
        const chunks = [];
        flattenAccessibilityNode(snapshot, chunks);
        return dedupeLines(chunks.join('\n'), 350);
    } catch {
        return '';
    }
}

async function extractViaDomPasses(page) {
    return await page.evaluate(() => {
        const simplify = (txt) => (txt || '').replace(/\s+/g, ' ').trim();

        const bySelector = (selector, max = 8) => {
            const nodes = Array.from(document.querySelectorAll(selector)).slice(0, max);
            return nodes.map((n) => simplify(n.innerText || n.textContent || '')).filter(Boolean);
        };

        const fullVisible = simplify(document.body?.innerText || '');
        const headings = bySelector('h1, h2, h3', 14);
        const focusedCandidates = bySelector('main, article, [role="main"], #content, .content, .article, .post, .markdown-body, .docs, .documentation, .doc-main, .prose', 12)
            .sort((a, b) => b.length - a.length);
        const tableAndCode = bySelector('pre, code, table, td, th', 60);
        const paragraphBlocks = bySelector('p, li', 140);

        const hasCanvasHeavy = document.querySelectorAll('canvas').length >= 2;
        const hasPdfSignals = /\.pdf($|\?)/i.test(window.location.href) || !!document.querySelector('embed[type*="pdf"], iframe[src*="pdf"], object[type*="pdf"]');

        return {
            title: document.title || '',
            url: window.location.href,
            fullVisible,
            headings,
            focusedCandidates,
            tableAndCode,
            paragraphBlocks,
            signals: {
                hasCanvasHeavy,
                hasPdfSignals,
                bodyTextLength: fullVisible.length
            }
        };
    });
}

async function tryTesseractOcr(page) {
    const tempDir = path.join(process.cwd(), '.agent', 'tmp');
    const imgPath = path.join(tempDir, `ocr-${Date.now()}.png`);
    try {
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        await page.screenshot({ path: imgPath, fullPage: false, timeout: 12000 });
        const { stdout } = await execFileAsync('tesseract', [imgPath, 'stdout', '--psm', '6']);
        return normalizeExtractedText(stdout || '');
    } catch {
        return '';
    } finally {
        if (fs.existsSync(imgPath)) {
            try { fs.unlinkSync(imgPath); } catch {}
        }
    }
}

async function extractBestPageText(page, focusQuery = '') {
    const dom = await extractViaDomPasses(page);
    const ax = await extractViaAccessibility(page);

    const bestFocused = (dom.focusedCandidates || []).find((c) => c.length > 300) || '';
    const paragraphs = (dom.paragraphBlocks || []).slice(0, 120).join('\n');
    const codeAndTables = (dom.tableAndCode || []).slice(0, 80).join('\n');

    let combined = [
        dom.title ? `Title: ${dom.title}` : '',
        (dom.headings || []).length ? `Headings:\n${dom.headings.join('\n')}` : '',
        bestFocused ? `Main Content:\n${bestFocused}` : '',
        paragraphs ? `Paragraphs:\n${paragraphs}` : '',
        codeAndTables ? `Structured Blocks:\n${codeAndTables}` : '',
        ax ? `Accessibility Snapshot:\n${ax}` : '',
        !bestFocused && dom.fullVisible ? `Full Visible:\n${dom.fullVisible}` : ''
    ].filter(Boolean).join('\n\n');

    combined = dedupeLines(combined, 650);

    let focusedSnippet = '';
    if (String(focusQuery || '').trim()) {
        focusedSnippet = buildFocusedAnswerSnippet(combined, focusQuery, 26);
        if (focusedSnippet) {
            combined = dedupeLines(`Answer Candidates (Goal-Focused):\n${focusedSnippet}\n\n${combined}`, 700);
        }
    }

    const charCount = combined.length;
    const wordCount = combined.split(/\s+/).filter(Boolean).length;
    const baseConfidence = Math.min(1, (Math.min(charCount, 18000) / 18000) * 0.65 + (Math.min(wordCount, 2800) / 2800) * 0.35);
    const confidence = Math.min(1, baseConfidence + (focusedSnippet ? 0.08 : 0));

    let source = 'dom+accessibility';
    let ocrUsed = false;

    const weakExtraction = charCount < 700 || wordCount < 120;
    const likelyNeedsOcr = weakExtraction && (dom.signals?.hasCanvasHeavy || dom.signals?.hasPdfSignals || (dom.signals?.bodyTextLength || 0) < 500);
    if (likelyNeedsOcr) {
        const ocrText = await tryTesseractOcr(page);
        if (ocrText && ocrText.length > Math.max(charCount, 450)) {
            combined = dedupeLines(`${combined}\n\nOCR Fallback:\n${ocrText}`, 700);
            source = 'dom+accessibility+ocr';
            ocrUsed = true;
        }
    }

    return {
        text: combined,
        meta: {
            source,
            ocrUsed,
            confidence,
            focusQuery: String(focusQuery || ''),
            focusedSnippetChars: focusedSnippet.length,
            charCount: combined.length,
            wordCount: combined.split(/\s+/).filter(Boolean).length,
            signals: dom.signals || {}
        }
    };
}

function extractIngredientListFromText(rawText) {
    const text = String(rawText || '');
    if (!text) return [];

    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const out = [];
    let inIngredients = false;
    for (const line of lines) {
        const l = line.toLowerCase();
        if (/ingredient|what goes into|for the gravy|for paneer|for curry/.test(l) && line.length <= 140) {
            inIngredients = true;
            continue;
        }
        if (inIngredients && /instruction|method|directions|steps|prep|cook/.test(l) && line.length <= 120) {
            break;
        }
        if (inIngredients) {
            const cleaned = line.replace(/^[-*•\d\.\)\s]+/, '').trim();
            if (!cleaned || cleaned.length < 2) continue;
            if (cleaned.length > 120) continue;
            if (/^title:|^headings:|^main content:|^paragraphs:|^structured blocks:|^accessibility snapshot:/i.test(cleaned)) continue;
            out.push(cleaned);
            if (out.length >= 35) break;
        }
    }

    if (out.length >= 4) {
        const unique = [...new Set(out.map((x) => x.toLowerCase()))].map((k) => out.find((x) => x.toLowerCase() === k));
        return unique.filter(Boolean).slice(0, 30);
    }

    return [];
}

function isBlankUrl(url) {
    return !url || String(url).trim() === '' || String(url).trim() === 'about:blank';
}

async function recoverBlankPage(page, args = {}) {
    const hintQuery = String(args.query || args.text || args.goal || '').trim();

    if (manager.lastHealthyUrl) {
        const backToHealthy = await resilientGoto(page, manager.lastHealthyUrl, {
            timeout: 22000,
            waitUntilPrimary: 'domcontentloaded',
            waitUntilFallback: 'commit'
        });
        if (backToHealthy.ok) {
            return { ok: true, strategy: 'lastHealthyUrl', url: page.url() };
        }
    }

    const fallbackQuery = hintQuery || 'web search home';
    const searchRecovery = await resilientSearch(page, fallbackQuery);
    if (searchRecovery.ok) {
        manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
        return { ok: true, strategy: 'search', url: page.url() };
    }

    return {
        ok: false,
        strategy: 'failed',
        error: searchRecovery.error || 'Unable to recover from blank page.'
    };
}

async function ensureActionablePage(page, action, args = {}) {
    const actionsNeedingReadyPage = new Set([
        'click',
        'type',
        'hover',
        'evaluate',
        'auth_state',
        'wait_for_auth',
        'handle_popups',
        'screenshot'
    ]);

    if (!actionsNeedingReadyPage.has(action)) {
        return { ok: true };
    }

    const currentUrl = page.url();
    if (!isBlankUrl(currentUrl)) {
        manager.lastHealthyUrl = currentUrl;
        return { ok: true };
    }

    const recovered = await recoverBlankPage(page, args);
    if (recovered.ok) {
        return {
            ok: true,
            recovered: true,
            message: `Recovered from about:blank using ${recovered.strategy}. Current URL: ${recovered.url}`
        };
    }

    return {
        ok: false,
        error: `page is about:blank and recovery failed: ${recovered.error}`
    };
}

async function collectBrowserHealth(page) {
    const safePages = manager.pages.filter((p) => !p.isClosed());
    const currentUrl = page.url() || '';
    const title = await page.title().catch(() => 'Unknown');
    const activeTab = Math.max(0, manager.currentPageIndex);
    const tabCount = safePages.length;

    const interactiveCount = await page.evaluate(() => {
        const selectors = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [aria-haspopup], [onclick]';
        const nodes = Array.from(document.querySelectorAll(selectors));
        return nodes.filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }).length;
    }).catch(() => 0);

    return {
        url: currentUrl,
        title,
        isBlank: isBlankUrl(currentUrl),
        tabCount,
        activeTab,
        lastHealthyUrl: manager.lastHealthyUrl || '',
        interactiveCount
    };
}

async function collectPreflightExtensionIntel(page) {
    return await page.evaluate(() => {
        const intel = window.__rexPreflightIntelV2 && typeof window.__rexPreflightIntelV2 === 'object'
            ? window.__rexPreflightIntelV2
            : null;
        const snapshot = window.__rexPreflightSnapshot && typeof window.__rexPreflightSnapshot === 'object'
            ? window.__rexPreflightSnapshot
            : null;

        if (!intel && !snapshot) {
            return {
                available: false,
                version: '',
                riskLevel: 'unknown',
                blockedRatio: 0,
                volatility: 0,
                topCandidates: []
            };
        }

        const fallbackTotal = Number(snapshot?.total || 0);
        const fallbackBlocked = Number(snapshot?.blocked || 0);
        const fallbackRatio = fallbackTotal > 0 ? fallbackBlocked / fallbackTotal : 0;

        return {
            available: true,
            version: String(intel?.version || snapshot?.version || window.__rexPreflightVersion || ''),
            generatedAt: String(intel?.generatedAt || snapshot?.at || ''),
            riskLevel: String(intel?.riskProfile?.level || 'unknown'),
            blockedRatio: Number(intel?.riskProfile?.blockedRatio ?? fallbackRatio ?? 0),
            volatility: Number(intel?.riskProfile?.volatility ?? 0),
            blockedInteractables: Number(intel?.riskProfile?.blockedInteractables ?? fallbackBlocked ?? 0),
            totalInteractables: Number(intel?.riskProfile?.totalInteractables ?? fallbackTotal ?? 0),
            topCandidates: Array.isArray(intel?.topCandidates) ? intel.topCandidates.slice(0, 10) : [],
            lanes: intel?.actionLanes && typeof intel.actionLanes === 'object' ? intel.actionLanes : null,
            delta: intel?.delta && typeof intel.delta === 'object' ? intel.delta : null
        };
    }).catch(() => ({
        available: false,
        version: '',
        riskLevel: 'unknown',
        blockedRatio: 0,
        volatility: 0,
        topCandidates: []
    }));
}

function preflightRecommendation(health, targetAction, readiness, extensionIntel = null) {
    const actions = [];
    let riskScore = 14;

    if (!readiness.ok) {
        riskScore += 42;
        actions.push('run auto-heal and reconfirm actionable state');
    }

    if (health.isBlank) {
        riskScore += 50;
        actions.push('recover from about:blank using last healthy URL or resilient search');
    }

    const risky = new Set(['click', 'type', 'hover', 'evaluate']);
    if (risky.has(targetAction) && health.interactiveCount === 0) {
        riskScore += 28;
        actions.push('run analyze_page before risky interaction');
    }

    if (extensionIntel?.available) {
        if (Number(extensionIntel.blockedRatio || 0) >= 0.25) {
            riskScore += 26;
            actions.push('handle overlays/popups before continuing');
        }
        if (Number(extensionIntel.volatility || 0) >= 0.55) {
            riskScore += 18;
            actions.push('wait briefly for DOM to stabilize before interacting');
        }
        if (Array.isArray(extensionIntel.topCandidates) && extensionIntel.topCandidates.length === 0 && risky.has(targetAction)) {
            riskScore += 10;
            actions.push('re-scan action lanes to avoid stale selectors');
        }
    }

    if (!actions.length) {
        actions.push('continue with selected action');
    }

    let level = 'low';
    let next = targetAction || 'continue';
    let reason = 'Browser context appears healthy.';

    if (riskScore >= 75) {
        level = 'high';
        next = 'search';
        reason = readiness.error || 'High-risk browser state detected.';
    } else if (riskScore >= 42) {
        level = 'medium';
        next = targetAction || 'refresh';
        reason = readiness.error || 'Moderate risk detected; pre-action hardening recommended.';
    }

    return {
        version: '2.0.0',
        score: Math.max(0, Math.min(100, Math.round(riskScore))),
        level,
        next,
        reason,
        actions
    };
}

function preflightRecommendationLegacy(health, targetAction, readiness) {
    if (!readiness.ok) {
        return {
            level: 'high',
            next: 'search',
            reason: readiness.error || 'Page not actionable.'
        };
    }

    if (health.isBlank) {
        return {
            level: 'high',
            next: 'search',
            reason: 'Current tab is about:blank.'
        };
    }

    const risky = new Set(['click', 'type', 'hover', 'evaluate']);
    if (risky.has(targetAction) && health.interactiveCount === 0) {
        return {
            level: 'medium',
            next: 'refresh',
            reason: 'No visible interactive elements on page.'
        };
    }

    return {
        level: 'low',
        next: targetAction || 'continue',
        reason: 'Browser context appears healthy.'
    };
}

/**
 * Interacts with a website using Playwright.
 * Supports a persistent browser session and action sequences.
 * @param {object} args - { action: 'search'|'navigate'|'click'|'type'|'hover'|... or 'sequence', actions: [] }
 */
export async function browser_interact(args, signal = null) {
    if (signal?.aborted) return 'Aborted';
    if (!args || typeof args !== 'object') return 'Browser Error: Invalid arguments.';

    // Handle common hallucination: the agent sends a list of commands instead of one
    if (args.actions && Array.isArray(args.actions)) {
        let fullResult = '';
        for (const subAction of args.actions) {
            if (signal?.aborted) return 'Aborted';
            const res = await browser_interact(subAction, signal);
            fullResult += `${res}\n`;
            if (/^Browser Error:/i.test(String(res || ''))) break; // Stop sequence only on hard runtime failures
        }
        return fullResult.trim();
    }

    try {
        const cfg = loadConfig();

        // local model gate (credit protection)
        if (process.env.KEEP_A_LOOK_TEST_MOCK !== 'true') {
            const activeModel = String(cfg.aiModel || '').toLowerCase();
            if (!activeModel.includes('ollama') && !activeModel.includes('local') && !activeModel.includes('llama')) {
                return `Browser Error: Browser interaction is blocked to prevent cloud credit drainage. Active model is "${cfg.aiModel}". To enable browser automation, please switch to a local Ollama model (e.g., /model ollama).`;
            }
        }

        const runHeadless = args.mode === 'headless' || !!cfg.webAgentHeadless;
        const page = await manager.getPage({ headless: runHeadless });
        await ensureVisualCursor(page, pickBrowserCursorStyle('default'));
        let result = '';
        let { action, url, selector, text, code, tabIndex, id } = args;
        action = String(action || '').trim().toLowerCase();

        const selectorOrId = selector || (id !== undefined && id !== null ? `[data-rex-id="${id}"]` : '');

        const readiness = await ensureActionablePage(page, action, args);
        if (!readiness.ok) {
            return `Error: ${readiness.error}`;
        }
        let recoveryPrefix = readiness.recovered ? `${readiness.message}\n` : '';

        // Normalization
        if (action === 'preflight_execute') {
            const { getPreflightSpecJsonForUrl } = await import('./preflightDesigner.js');
            const targetUrl = page.url() || '';
            const matched = await getPreflightSpecJsonForUrl(targetUrl);
            if (!matched) {
                return `Error: No Preflight spec compiled for domain "${targetUrl}". Please run preflight_scan tool on this website first.`;
            }

            const { methodName, params } = args;
            if (!methodName) return 'Error: preflight_execute requires a "methodName" argument.';

            const specActions = matched.spec?.actions;
            const targetAction = specActions?.[methodName];
            if (!targetAction) {
                return `Error: Action "${methodName}" not defined in preflight.yaml for this site. Available actions: ${Object.keys(specActions || {}).join(', ')}`;
            }

            const actionType = String(targetAction.action_type || 'browser').toLowerCase();
            const actionParams = targetAction.parameters || [];
            
            // Validate required parameters
            const validatedParams = {};
            for (const param of actionParams) {
                const name = param.name;
                const required = param.required === true;
                const val = params?.[name];
                if (required && (val === undefined || val === null || val === '')) {
                    return `Error: Parameter "${name}" is required for action "${methodName}".`;
                }
                validatedParams[name] = val;
            }

            if (actionType === 'api' && targetAction.api) {
                // High-performance API execution bypassing visual browser steps!
                const apiDef = targetAction.api;
                const pathUrl = apiDef.url;
                const method = String(apiDef.method || 'POST').toUpperCase();
                
                // Fetch page cookies
                const cookies = await context.cookies();
                const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

                // Build full API endpoint URL
                const origin = new URL(targetUrl).origin;
                const fullApiUrl = pathUrl.startsWith('http') ? pathUrl : `${origin}${pathUrl}`;

                // Replace path parameters if any (e.g. /product/{id})
                let endpointUrl = fullApiUrl;
                for (const k of Object.keys(validatedParams)) {
                    endpointUrl = endpointUrl.replace(`{${k}}`, encodeURIComponent(validatedParams[k]));
                }

                // Dispatch direct fetch API request
                const fetchHeaders = {
                    'Content-Type': 'application/json',
                    'Cookie': cookieHeader,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                };
                
                const fetchBody = method !== 'GET' ? JSON.stringify(validatedParams) : undefined;
                
                const response = await fetch(endpointUrl, {
                    method,
                    headers: fetchHeaders,
                    body: fetchBody
                });

                const responseText = await response.text();
                manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;

                return `[API Upgrade] Executed ${methodName} via API ${method} ${endpointUrl}. Status: ${response.status}. Response: ${responseText.substring(0, 500)}`;
            } else {
                // DOM Browser interaction workflow execution!
                // Type values into input fields
                for (const param of actionParams) {
                    const name = param.name;
                    const val = validatedParams[name];
                    const paramSelector = param.selector;
                    if (val !== undefined && val !== null && val !== '' && paramSelector) {
                        await page.waitForSelector(paramSelector, { timeout: 8000 });
                        await page.locator(paramSelector).fill(String(val));
                    }
                }

                // Trigger main action submit selector
                const triggerSelector = targetAction.selector;
                if (triggerSelector) {
                    await page.waitForSelector(triggerSelector, { timeout: 8000 });
                    await page.locator(triggerSelector).click();
                    await page.waitForLoadState('networkidle').catch(() => {});
                }

                manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
                const title = await page.title().catch(() => 'Page');
                
                return `[DOM workflow] Executed semantic action "${methodName}". Title: "${title}". URL: ${page.url()}`;
            }
        }

        if (action === 'back') {
            await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
            if (isBlankUrl(page.url())) {
                const recovered = await recoverBlankPage(page, args);
                if (!recovered.ok) {
                    return `Error: back landed on about:blank and recovery failed: ${recovered.error}`;
                }
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                return `Navigated back, then recovered using ${recovered.strategy}. URL: ${recovered.url}`;
            }
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
            return `Navigated back to ${page.url()}`;
        }
        if (action === 'refresh') {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            if (isBlankUrl(page.url())) {
                const recovered = await recoverBlankPage(page, args);
                if (!recovered.ok) {
                    return `Error: refresh landed on about:blank and recovery failed: ${recovered.error}`;
                }
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                return `Reloaded page, then recovered using ${recovered.strategy}. URL: ${recovered.url}`;
            }
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
            return `Reloaded ${page.url()}`;
        }
        if (action === 'new' || action === 'new_tab') return await manager.newTab(url);
        if (action === 'switch' || action === 'switch_tab') {
            const idx = Number(tabIndex);
            if (!Number.isInteger(idx)) return 'Error: tabIndex must be an integer.';
            return await manager.switchTab(idx);
        }
        if (action === 'list' || action === 'list_tabs') return await manager.listTabs();
        if (action === 'close' || action === 'close_browser') { await manager.close(); return 'Browser closed.'; }
        if (action === 'babysit_start') {
            const forceEnable = args.forceEnable === true || args.force === true;
            if (cfg.babysitModeEnabled === false && !forceEnable) {
                return 'Error: Babysit mode is disabled in config. Enable it from rexai open -> Tuning Bay.';
            }
            const configuredModel = String(cfg.babysitNotesModel || 'gpt-5-nano').trim() || 'gpt-5-nano';
            const followCursor = args.followCursor !== undefined
                ? args.followCursor !== false
                : cfg.babysitFollowCursor !== false;
            manager.babysitSession = {
                active: true,
                startedAt: new Date().toISOString(),
                goal: String(args.goal || args.task || '').trim(),
                model: String(args.model || configuredModel).trim() || configuredModel,
                followCursor,
                snapshots: 0,
                notesSaved: 0,
                feedback: {
                    useful: 0,
                    notUseful: 0,
                    replayAsked: 0
                }
            };

            if (followCursor) {
                for (const p of manager.pages.filter((x) => x && !x.isClosed())) {
                    await setBabysitCursorFollow(p, true);
                }
            }
            await ensureVisualCursor(page, pickBrowserCursorStyle('default'));

            // Hard startup probe: always persist one deterministic hello marker per babysit start.
            const helloUrl = page.url() || '';
            const helloTitle = await page.title().catch(() => 'Unknown');
            persistBabysitNote({
                at: new Date().toISOString(),
                url: helloUrl,
                title: helloTitle,
                host: hostFromUrl(helloUrl),
                task: manager.babysitSession.goal || 'babysit-start',
                userNote: 'startup-handshake',
                interactiveCount: 0,
                sample: [],
                moveLearning: { movesCount: 0, recentMoves: [], feedbackCount: 0, feedbackRecent: [] }
            }, {
                model: manager.babysitSession.model,
                modelUsed: false,
                notes: ['hello!']
            });
            manager.babysitSession.notesSaved = Number(manager.babysitSession.notesSaved || 0) + 1;

            startBabysitAutoCapture({
                intervalMs: Number(args.intervalMs || cfg.babysitAutoSnapshotMs || 18000),
                model: manager.babysitSession.model
            });
            await triggerBabysitPromptInPage(page, {
                taskId: 'babysit-intro',
                task: 'hello!',
                note: 'wait, was that move necessary? mark it with yes/no, or ask which move to replay.'
            });
            return `Babysit mode enabled. followCursor=${followCursor}. model=${manager.babysitSession.model}.`;
        }
        if (action === 'babysit_status') {
            const active = !!manager.babysitSession?.active;
            const state = {
                active,
                ...manager.babysitSession,
                url: page.url() || '',
                title: await page.title().catch(() => 'Unknown'),
                notesPath: getBabysitNotesPath(),
                autoCapture: {
                    enabled: !!manager.babysitAutoCapture?.timer,
                    intervalMs: Number(manager.babysitAutoCapture?.intervalMs || 0),
                    running: !!manager.babysitAutoCapture?.running,
                    lastError: String(manager.babysitAutoCapture?.lastError || '')
                }
            };
            return JSON.stringify(state, null, 2);
        }
        if (action === 'babysit_prompt' || action === 'user_prompt') {
            const payload = {
                taskId: String(args.taskId || args.id || `task-${Date.now()}`),
                task: String(args.task || args.message || 'hmm... please complete the requested step.'),
                note: String(args.note || 'wait, was that move necessary?')
            };
            const shown = await triggerBabysitPromptInPage(page, payload);
            if (!shown) return 'Error: Unable to trigger babysit prompt in page context.';
            return `Babysit prompt shown. taskId=${payload.taskId}`;
        }
        if (action === 'practice_mode' || action === 'practice_start') {
            if (cfg.babysitModeEnabled === false) {
                return 'Error: Practice mode requires babysit mode to be enabled in config.';
            }

            const goal = String(args.goal || args.task || 'practice browser workflow').trim();
            await browser_interact({
                action: 'babysit_start',
                goal,
                followCursor: cfg.babysitFollowCursor !== false,
                model: cfg.babysitNotesModel || 'gpt-5-nano'
            }, signal);

            const runResult = await run_autonomous_web_agent({
                goal,
                budgetMode: String(args.budgetMode || 'low'),
                practiceMode: true,
                forcePlannerProvider: 'openai',
                forcePlannerModel: 'gpt-5-nano'
            }, signal);

            await triggerBabysitPromptInPage(page, {
                taskId: 'practice-review',
                task: 'hmm... practice pass finished. was that move sequence useful?',
                note: 'click which move to replay an important step, then mark yes/no.'
            });

            return `Practice mode run complete.\n${runResult}`;
        }
        if (action === 'babysit_snapshot') {
            const forceEnable = args.forceEnable === true || args.force === true;
            const hasActiveSession = !!manager.babysitSession?.active;
            if (cfg.babysitModeEnabled === false && !forceEnable && !hasActiveSession) {
                return 'Error: Babysit mode is disabled in config. Enable it from rexai open -> Tuning Bay.';
            }
            const snapshot = await collectBabysitSnapshot(page, args);
            const summary = await summarizeBabysitSnapshot(snapshot, {
                askModel: args.askModel !== false,
                model: args.model || manager.babysitSession.model || cfg.babysitNotesModel || 'gpt-5-nano'
            });

            const saveNotes = args.save !== false;
            let saved = null;
            if (saveNotes) {
                saved = persistBabysitNote(snapshot, summary);
                manager.babysitSession.notesSaved = Number(manager.babysitSession.notesSaved || 0) + 1;
            }
            manager.babysitSession.snapshots = Number(manager.babysitSession.snapshots || 0) + 1;

            return JSON.stringify({
                feature: 'Babysit Snapshot',
                snapshot,
                summary,
                saved,
                session: manager.babysitSession
            }, null, 2);
        }
        if (action === 'babysit_stop') {
            stopBabysitAutoCapture();
            for (const p of manager.pages.filter((x) => x && !x.isClosed())) {
                await setBabysitCursorFollow(p, false);
            }
            const prev = { ...manager.babysitSession };
            manager.babysitSession.active = false;
            manager.babysitSession.followCursor = false;
            await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
            return `Babysit mode disabled. snapshots=${Number(prev.snapshots || 0)}, notesSaved=${Number(prev.notesSaved || 0)}.`;
        }
        if (action === 'preflight_analyse' || action === 'preflight_analyze' || action === 'diagnose') {
            const targetAction = String(args.targetAction || args.nextAction || '').trim().toLowerCase();
            const autoHeal = args.autoHeal !== false;

            let readiness = { ok: true };
            if (autoHeal && targetAction) {
                readiness = await ensureActionablePage(page, targetAction, args);
            }

            const health = await collectBrowserHealth(page);
            const extensionIntel = await collectPreflightExtensionIntel(page);
            const recommendation = preflightRecommendation(health, targetAction, readiness, extensionIntel);
            const legacyRecommendation = preflightRecommendationLegacy(health, targetAction, readiness);
            const report = {
                feature: 'Preflight Analyse',
                version: '2.0.0',
                targetAction: targetAction || 'unspecified',
                autoHeal,
                healed: readiness.recovered === true,
                readiness,
                health,
                recommendation,
                recommendationLegacy: legacyRecommendation,
                extensionIntel
            };

            report.navigatorAssist = {
                usingExtension: manager.usingExtension,
                extensionPath: manager.extensionPath || ''
            };

            const plotSummary = getPreflightAnalysePlotSummary(health.url, targetAction);
            report.preflgihtAnalysePlot = plotSummary;
            report.preflightAnalysePlot = plotSummary;

            try {
                const { getPreflightSpecJsonForUrl } = await import('./preflightDesigner.js');
                const specData = await getPreflightSpecJsonForUrl(health.url);
                if (specData) {
                    report.preflightDesignerSpec = {
                        projectName: specData.projectName,
                        rootUrl: specData.rootUrl,
                        actions: Object.entries(specData.spec?.actions || {}).map(([name, act]) => ({
                            name,
                            type: act.action_type || act.type,
                            description: act.description
                        }))
                    };
                }
            } catch (e) {
                // Ignore
            }

            if (health.url && health.url !== 'about:blank') {
                manager.lastHealthyUrl = health.url;
            }

            return `Preflight Analyse Report:\n${JSON.stringify(report, null, 2)}`;
        }
        if (action === 'read' || action === 'extract_text') {
            const focusQuery = String(args.query || args.goal || args.focus || args.target || '').trim();
            const extracted = await extractBestPageText(page, focusQuery);
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            const payload = extracted.text || '';
            if (payload.length > 28000) {
                return payload.substring(0, 28000) + `\n\n...[Content truncated]...\n\n[Extraction Meta] ${JSON.stringify(extracted.meta)}`;
            }
            if (!payload) return 'No visible text content found on page.';
            return `${payload}\n\n[Extraction Meta] ${JSON.stringify(extracted.meta)}`;
        }
        if (action === 'scan' || action === 'analyze_page') {
            const snapshot = await buildInteractiveSnapshot(page);
            const plotSummary = getPreflightAnalysePlotSummary(page.url() || '', 'analyze_page');
            const extensionIntel = await collectPreflightExtensionIntel(page);
            const summary = {
                feature: 'Preflight Analyse',
                version: '2.0.0',
                page: {
                    url: page.url() || '',
                    title: await page.title().catch(() => 'Unknown')
                },
                totalInteractive: snapshot.length,
                sample: snapshot.slice(0, 40),
                extensionIntel,
                extensionAssist: {
                    enabled: manager.usingExtension,
                    extensionPath: manager.extensionPath || ''
                },
                preflgihtAnalysePlot: plotSummary,
                preflightAnalysePlot: plotSummary
            };
            return `Page Interaction Scan:\n${JSON.stringify(summary, null, 2)}`;
        }
        if (action === 'handle_popups') {
            const r = await smartHandleConsentAndOverlays(page, {
                maxClicks: Number.isFinite(Number(args.maxClicks)) ? Number(args.maxClicks) : 3,
                preferReject: args.preferReject !== false
            });
            if (r.clickedCount > 0) {
                await page.waitForTimeout(500);
            }
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            return `${recoveryPrefix}Popup handler clicked ${r.clickedCount} action(s): ${r.clicked.join(', ') || 'none'}`;
        }
        if (action === 'auth_state') {
            const state = await detectAuthState(page);
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            return `${recoveryPrefix}${JSON.stringify(state, null, 2)}`;
        }
        if (action === 'wait_for_auth') {
            const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 120000;
            const waited = await waitForAuthCompletion(page, Math.max(5000, timeoutMs));
            if (waited.completed) {
                manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
                return `${recoveryPrefix}Auth appears completed after ${waited.waitedMs}ms. URL: ${waited.state.url}`;
            }
            return `${recoveryPrefix}Auth still pending after ${waited.waitedMs}ms. Current URL: ${waited.state.url}`;
        }

        if (action === 'navigate') {
            if (!url) return 'Error: navigate action requires a \"url\" argument. Use action \"search\" if the destination is unknown.';
            const safeUrl = normalizeWebUrl(url);
            const host = new URL(safeUrl).hostname;
            if (isPlaceholderHost(host)) {
                return `Error: ${host} is a placeholder domain. Use action \"search\" first or provide a real site URL.`;
            }

            const malformedNavigateQuery = String(args.search_query || args.searchQuery || '').trim();
            if (malformedNavigateQuery) {
                const fallbackQuery = `${malformedNavigateQuery} site:${host.replace(/^www\./i, '')}`.trim();
                const searchRes = await resilientSearch(page, fallbackQuery);
                if (!searchRes.ok) {
                    return `Error: navigate payload included search_query and fallback search failed: ${searchRes.error}`;
                }
                manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
                return `${recoveryPrefix}Auto-corrected navigate+search_query to search. Query: \"${fallbackQuery}\". URL: ${searchRes.url}`;
            }

            manager.trackNavigationAttempt(safeUrl, 'navigate');
            const loopSignal = manager.getNavigationLoopSignal(safeUrl);
            if (loopSignal.looping) {
                const recoveryQuery = buildSiteScopedRecoveryQuery(safeUrl, args.query || args.goal || args.text || '');
                const searchRes = await resilientSearch(page, recoveryQuery);
                if (!searchRes.ok) {
                    return `Error: repeated navigation loop detected for ${safeUrl}, and recovery search failed: ${searchRes.error}`;
                }
                manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
                return `${recoveryPrefix}Detected repeated navigation loop (${loopSignal.repeats}x) for ${safeUrl}. Recovered using search query \"${recoveryQuery}\" at ${searchRes.url}`;
            }

            const nav = await resilientGoto(page, safeUrl, {
                timeout: 30000,
                waitUntilPrimary: 'load',
                waitUntilFallback: 'domcontentloaded'
            });

            if (!nav.ok) {
                const recovery = await resilientSearch(page, safeUrl);
                if (!recovery.ok) {
                    return `Error: Failed to navigate to ${safeUrl}. Recovery search also failed: ${recovery.error}`;
                }
                manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
                return `Direct navigation to ${safeUrl} landed on a blank page. Recovered with search at ${recovery.url}.`;
            }

            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;

            const popupResult = await smartHandleConsentAndOverlays(page, { maxClicks: 2, preferReject: true });
            await page.waitForTimeout(600);
            const title = await page.title();
            const body = await page.evaluate(() => {
                const clone = document.body.cloneNode(true);
                clone.querySelectorAll('script, style, noscript, nav, footer, iframe').forEach(s => s.remove());
                return clone.innerText.substring(0, 4500).replace(/\s+/g, ' ').trim();
            });
            result = `${recoveryPrefix}Navigated to ${safeUrl}. Title: "${title}". Popup actions: ${popupResult.clickedCount}. Visible Content: ${body}...`;
        } else if (action === 'search') {
            const searchQuery = (args.query || text || '').trim();
            if (!searchQuery) return 'Error: search action requires "query" or "text".';
            
            // Native Search Grounding (DuckDuckGo snippets)
            const groundingSnippet = await fetchLocalSearchGrounding(searchQuery);

            const searchRes = await resilientSearch(page, searchQuery);
            if (!searchRes.ok) {
                return `Error: search failed for "${searchQuery}": ${searchRes.error}`;
            }
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            await smartHandleConsentAndOverlays(page, { maxClicks: 1, preferReject: true });
            await page.waitForTimeout(1000);
            const title = await page.title().catch(() => 'Search Results');
            const groundingInfo = groundingSnippet ? `\n\n[Search Grounding Snippets]:\n${groundingSnippet}` : '';
            result = `${recoveryPrefix}Searched for "${searchQuery}". Title: "${title}". URL: ${searchRes.url}${groundingInfo}`;
        } else if (action === 'click') {
            const resolved = await resolveTargetSelector(page, {
                action,
                selector,
                id,
                text,
                label: args.label,
                hrefContains: args.hrefContains,
                role: args.role,
                placeholder: args.placeholder,
                preferLinks: args.preferLinks,
                preferButtons: args.preferButtons !== false
            });
            if (!resolved.ok) return `Error: ${resolved.error}`;

            const resolvedSelector = resolved.selector;
            await page.waitForSelector(resolvedSelector, { timeout: 8000 });

            // Visual Grounding verification using Ollama Vision
            if (process.env.KEEP_A_LOOK_TEST_MOCK !== 'true') {
                await visuallyGroundElement(page, resolvedSelector, String(args.query || args.text || 'click target'));
            }

            await cursorMoveToSelector(page, resolvedSelector, 250, pickBrowserCursorStyle('click'));

            const clicked = await robustClick(page, resolvedSelector);
            if (!clicked.ok) {
                addPreflightAnalysePlotObservation({
                    pageUrl: page.url() || '',
                    action,
                    args,
                    selector: resolvedSelector,
                    candidate: resolved.candidate,
                    success: false
                });
                return `Error: click failed after retries on ${resolvedSelector}. ${clicked.error}`;
            }
            addPreflightAnalysePlotObservation({
                pageUrl: page.url() || '',
                action,
                args,
                selector: resolvedSelector,
                candidate: resolved.candidate,
                success: true
            });
            await cursorClickPulse(page, pickBrowserCursorStyle('click'));
            const settled = await settleAfterInteraction(page, { interaction: 'click', popupClicks: 2, dropdownWaitMs: 320 });
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            const suffix = settled.note ? `; ${settled.note}` : '';
            result = `${recoveryPrefix}Clicked ${resolvedSelector} (${resolved.reason}; ${clicked.mode}${suffix})`;
        } else if (action === 'type') {
            if (typeof text !== 'string') return 'Error: type action requires text.';
            const resolved = await resolveTargetSelector(page, {
                action,
                selector,
                id,
                text: args.targetText || args.label,
                label: args.label,
                role: args.role,
                placeholder: args.placeholder,
                preferButtons: false
            });
            if (!resolved.ok) return `Error: ${resolved.error}`;

            const resolvedSelector = resolved.selector;
            await page.waitForSelector(resolvedSelector, { timeout: 8000 });

            // Visual Grounding verification using Ollama Vision
            if (process.env.KEEP_A_LOOK_TEST_MOCK !== 'true') {
                await visuallyGroundElement(page, resolvedSelector, String(args.query || args.text || 'type target'));
            }

            await cursorMoveToSelector(page, resolvedSelector, 230, pickBrowserCursorStyle('type'));

            const typed = await robustType(page, resolvedSelector, text, args.pressEnter !== false);
            if (!typed.ok) {
                addPreflightAnalysePlotObservation({
                    pageUrl: page.url() || '',
                    action,
                    args,
                    selector: resolvedSelector,
                    candidate: resolved.candidate,
                    success: false
                });
                return `Error: type failed after retries on ${resolvedSelector}. ${typed.error}`;
            }
            addPreflightAnalysePlotObservation({
                pageUrl: page.url() || '',
                action,
                args,
                selector: resolvedSelector,
                candidate: resolved.candidate,
                success: true
            });
            await cursorClickPulse(page, pickBrowserCursorStyle('type'));
            const settled = await settleAfterInteraction(page, { interaction: 'type', popupClicks: 2, dropdownWaitMs: 260 });
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            const suffix = settled.note ? `; ${settled.note}` : '';
            result = `${recoveryPrefix}Typed into ${resolvedSelector} (${resolved.reason}; ${typed.mode}${suffix})`;
        } else if (action === 'hover') {
            const resolved = await resolveTargetSelector(page, {
                action,
                selector,
                id,
                text,
                label: args.label,
                hrefContains: args.hrefContains,
                role: args.role,
                placeholder: args.placeholder
            });
            if (!resolved.ok) return `Error: ${resolved.error}`;

            const resolvedSelector = resolved.selector;
            await page.waitForSelector(resolvedSelector, { timeout: 8000 });

            await cursorMoveToSelector(page, resolvedSelector, 220, pickBrowserCursorStyle('hover'));

            const hovered = await robustHover(page, resolvedSelector);
            if (!hovered.ok) {
                addPreflightAnalysePlotObservation({
                    pageUrl: page.url() || '',
                    action,
                    args,
                    selector: resolvedSelector,
                    candidate: resolved.candidate,
                    success: false
                });
                return `Error: hover failed after retries on ${resolvedSelector}. ${hovered.error}`;
            }
            addPreflightAnalysePlotObservation({
                pageUrl: page.url() || '',
                action,
                args,
                selector: resolvedSelector,
                candidate: resolved.candidate,
                success: true
            });
            const settled = await settleAfterInteraction(page, { interaction: 'hover', popupClicks: 1, dropdownWaitMs: 300 });
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            const suffix = settled.note ? `; ${settled.note}` : '';
            result = `${recoveryPrefix}Hovered over ${resolvedSelector} (${resolved.reason}; ${hovered.mode}${suffix})`;
        } else if (action === 'screenshot') {
            const screenshotPath = path.join(process.cwd(), '.agent', `screenshot-${Date.now()}.png`);
            if (!fs.existsSync(path.dirname(screenshotPath))) fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
            await page.screenshot({ path: screenshotPath, timeout: 10000 });
            result = `${recoveryPrefix}Screenshot saved to ${screenshotPath}`;
        } else if (action === 'evaluate') {
            if (typeof code !== 'string' || !code.trim()) return 'Error: evaluate action requires JavaScript code in "code".';
            const evalResult = await page.evaluate(code);
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            result = `${recoveryPrefix}Evaluated JS. Result: ${JSON.stringify(evalResult)}`;
        } else if (action === 'get_cookies') {
            result = JSON.stringify(await manager.context.cookies());
        } else if (action === 'set_cookies') {
            let cookiePayload;
            try {
                cookiePayload = JSON.parse(code || text);
            } catch {
                return 'Error: set_cookies expects valid JSON in "code" or "text".';
            }
            await manager.context.addCookies(cookiePayload);
            result = 'Cookies updated.';
        } else {
            result = `Unknown action: ${action}.`;
        }

        if (action !== 'click') {
            await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
        }

        return result;
    } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) return 'Aborted';
        return `Browser Error: ${err.message}`;
    }
}

// This script is injected to identify interactive elements with visual numeric markers
const markerScript = `
(() => {
    const markers = [];
    const showMarkers = Boolean(window.__rex_show_markers);
    // Clean existing
    document.querySelectorAll('.rex-marker').forEach(m => m.remove());
    
    const interactives = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [aria-haspopup], [onclick]'));
    let id = 0;
    
    interactives.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top <= window.innerHeight) {
            id++;
            el.setAttribute('data-rex-id', id.toString());
            if (showMarkers) {
                const marker = document.createElement('div');
                marker.className = 'rex-marker';
                marker.textContent = id.toString();
                marker.style.position = 'fixed';
                marker.style.top = rect.top + 'px';
                marker.style.left = rect.left + 'px';
                marker.style.background = 'rgba(255, 0, 255, 0.9)';
                marker.style.color = 'white';
                marker.style.padding = '2px 5px';
                marker.style.borderRadius = '3px';
                marker.style.fontSize = '12px';
                marker.style.fontWeight = 'bold';
                marker.style.zIndex = '1000000';
                marker.style.pointerEvents = 'none';
                document.body.appendChild(marker);
            }
            
            markers.push({
                id: id.toString(),
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.textContent || '').substring(0, 60).trim(),
                role: el.getAttribute('role'),
                href: el.getAttribute('href'),
                placeholder: el.getAttribute('placeholder')
            });
        }
    });
    return markers;
})();
`;

async function getVisiblePageSummary(page, focusQuery = '') {
    try {
        const extracted = await extractBestPageText(page, focusQuery);
        const lines = extracted.text.split('\n').map((l) => l.trim()).filter(Boolean);
        const headingLike = lines.filter((l) => /^title:|^headings:/i.test(l) || (l.length <= 90 && /[A-Za-z]/.test(l))).slice(0, 10);
        const likelyAnswerBlocks = lines.filter((l) => l.length >= 45).slice(0, 22).join(' | ').slice(0, 2600);

        return {
            text: extracted.text.slice(0, 2800),
            headings: headingLike,
            likelyAnswerBlocks,
            meta: extracted.meta
        };
    } catch {
        return { text: '', headings: [], likelyAnswerBlocks: '', meta: { source: 'none', ocrUsed: false } };
    }
}

function formatPreflightSpecForPrompt(spec) {
    if (!spec || !spec.actions) return '';
    
    let res = '\nPREFLIGHT DESIGNER WEBSITE MAP (Discovered Actions & API Upgrades for this site):\n';
    for (const [name, act] of Object.entries(spec.actions)) {
        const type = act.action_type || act.type || 'browser';
        res += `- Action: "${name}"\n`;
        res += `  Description: ${act.description || 'No description'}\n`;
        res += `  Type: ${type}\n`;
        if (type === 'browser' && act.selector) {
            res += `  Selector: "${act.selector}"\n`;
        }
        
        const params = act.parameters || [];
        if (params.length > 0) {
            res += `  Parameters:\n`;
            for (const p of params) {
                res += `    - ${p.name} (${p.type || 'string'}${p.required ? ', required' : ''})${p.selector ? ` -> selector: "${p.selector}"` : ''}\n`;
            }
        }
        
        if (type === 'api' && act.api) {
            res += `  API Upgrade Available: ${act.api.method || 'POST'} ${act.api.url}\n`;
        }
    }
    return res + '\n';
}

/**
 * Runs an autonomous loop using headful Playwright to achieve a web goal visually.
 */
export async function run_autonomous_web_agent(goal, signal = null) {
    const { runCompletion, runCompletionWithTarget } = await import('./ai.js');
    const { loadConfig, resolveModelAlias } = await import('./config.js');
    const {
        resolveWebAgentBudget,
        createWebPlanState,
        canRequestPlannerStep,
        notePlannerStepRequested,
        noteWebPlannerIssue,
        noteWebPlannerSuccess,
        noteRecoveryAttempt,
        applyWebPlannerPayload,
        advanceWebStepCounter,
        shouldTerminateForBudget,
        buildWebPlannerContext,
        getBudgetExhaustedMessage
    } = await import('./agent/planEngine.js');

    const parsedInput = (typeof goal === 'object' && goal !== null)
        ? {
            goal: String(goal.goal || '').trim(),
            budgetMode: String(goal.budgetMode || '').trim(),
            maxSteps: Number(goal.maxSteps),
            maxPlannerCalls: Number(goal.maxPlannerCalls),
            maxSubplanDepth: Number(goal.maxSubplanDepth),
            maxRecoveryAttempts: Number(goal.maxRecoveryAttempts),
            practiceMode: goal.practiceMode === true,
            forcePlannerProvider: String(goal.forcePlannerProvider || '').trim(),
            forcePlannerModel: String(goal.forcePlannerModel || '').trim()
        }
        : {
            goal: String(goal || '').trim(),
            budgetMode: '',
            maxSteps: undefined,
            maxPlannerCalls: undefined,
            maxSubplanDepth: undefined,
            maxRecoveryAttempts: undefined,
            practiceMode: false,
            forcePlannerProvider: '',
            forcePlannerModel: ''
        };

    const normalizedGoal = parsedInput.goal;
    if (!normalizedGoal) return 'Agent Error: Missing goal.';
    if (signal?.aborted) return 'Aborted';

    try {
        const config = loadConfig();
        const budget = resolveWebAgentBudget(config, {
            mode: parsedInput.budgetMode,
            maxSteps: parsedInput.maxSteps,
            maxPlannerCalls: parsedInput.maxPlannerCalls,
            maxSubplanDepth: parsedInput.maxSubplanDepth,
            maxRecoveryAttempts: parsedInput.maxRecoveryAttempts
        });

        const planState = createWebPlanState(normalizedGoal, budget);
        const runHeadless = parsedInput.budgetMode === 'headless' || !!config.webAgentHeadless;
        const page = await manager.getPage({ headless: runHeadless });
        await ensureVisualCursor(page, pickBrowserCursorStyle('default'));

        // AutoPilot Routines: try deterministic playbook before first LLM call
        let lastResult = 'Started browser.';
        const actionHistory = [];
        let authWallCount = 0;
        let autopilotRan = false;

        try {
            const { tryAutoPilotRoutine } = await import('./autopilotRoutines.js');
            const autopilot = await tryAutoPilotRoutine(page, normalizedGoal);
            if (autopilot.matched) {
                appendAutonomousBrowserDebug({
                    source: 'autopilot_routine',
                    routine: autopilot.routineName,
                    result: autopilot.result
                });
                lastResult = `[AutoPilot: ${autopilot.routineName}] ${autopilot.result}`;
                actionHistory.push({ action: 'autopilot', id: autopilot.routineName, url: page.url() });
                autopilotRan = true;
            }
        } catch (autopilotErr) {
            // Routine failed silently, continue with normal agent flow
        }

        if (!autopilotRan && isBlankUrl(page.url())) {
            const initRecovery = await recoverBlankPage(page, { query: normalizedGoal, goal: normalizedGoal });
            noteRecoveryAttempt(planState, initRecovery.strategy || 'init_blank_recovery');
            if (!initRecovery.ok) {
                return `Agent Error: Failed to initialize browsing context: ${initRecovery.error}`;
            }
            lastResult = `Initialized browser context via ${initRecovery.strategy}.`;
        }

        const initialBlock = await detectAutomationBlockers(page);
        if (initialBlock) {
            noteWebPlannerIssue(planState, 'initial_blocker', initialBlock);
            const recovery = await resilientSearch(page, normalizedGoal);
            noteRecoveryAttempt(planState, 'initial_blocker_search');
            if (!recovery.ok) {
                return `Agent stopped: ${initialBlock}`;
            }
            lastResult = 'Recovered from initial blocker by re-searching goal.';
        }

        while (true) {
            if (signal?.aborted) return 'Aborted';

            advanceWebStepCounter(planState);
            const budgetState = shouldTerminateForBudget(planState);
            if (budgetState.stop) {
                return getBudgetExhaustedMessage(planState, normalizedGoal);
            }

            const popupActions = await smartHandleConsentAndOverlays(page, { maxClicks: 3, preferReject: true });
            if (popupActions.clickedCount > 0) {
                await page.waitForTimeout(500);
                lastResult = `Cleared ${popupActions.clickedCount} popup/overlay action(s).`;
            }

            const blockedNow = await detectAutomationBlockers(page);
            if (blockedNow) {
                noteWebPlannerIssue(planState, 'automation_blocker', blockedNow);
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                const recovery = await resilientSearch(page, normalizedGoal);
                noteRecoveryAttempt(planState, 'blocker_reload_search');
                if (!recovery.ok) {
                    return `Agent stopped at step ${planState.counters.steps}: ${blockedNow}`;
                }
                lastResult = 'Recovered from blocker by switching search surface.';
                continue;
            }

            const authState = await detectAuthState(page);
            if (authState.requiresAuth) {
                authWallCount += 1;
                noteWebPlannerIssue(planState, 'auth_wall', authState.hardGateHits.join(', ') || 'login required');
                if (authWallCount >= 2) {
                    return `Agent paused: login is required and cannot be bypassed safely. Current URL: ${authState.url}. Please complete login manually, then continue with browser_interact action \"wait_for_auth\" or rerun the task.`;
                }
                lastResult = `Detected auth wall (${authState.hardGateHits.join(', ') || 'login required'}). Trying non-login bypass controls.`;
                continue;
            }
            authWallCount = 0;

            let url = page.url();
            if (isBlankUrl(url)) {
                const recovery = await recoverBlankPage(page, { query: normalizedGoal, goal: normalizedGoal });
                noteRecoveryAttempt(planState, recovery.strategy || 'blank_recovery');
                if (!recovery.ok) {
                    return `Agent stopped: browser remained on about:blank and recovery failed: ${recovery.error}`;
                }
                url = page.url();
                lastResult = `Recovered from blank page via ${recovery.strategy}.`;
            }

            const markers = await page.evaluate(markerScript).catch((e) => {
                appendAutonomousBrowserDebug({
                    source: 'run_autonomous_web_agent',
                    phase: 'marker_evaluate',
                    step: planState.counters.steps,
                    url: page.url(),
                    error: e?.message || String(e)
                });
                return [];
            });

            const pageSummary = await getVisiblePageSummary(page, normalizedGoal);
            const currentUrl = page.url();
            const pageTitle = await page.title().catch(() => 'Unknown');

            const recentActions = actionHistory.slice(-4).map((h) => h.action);
            const repeatedScrolling = recentActions.length >= 3 && recentActions.every((a) => a === 'scroll');
            const onSearchEnginePage = /duckduckgo\.com|bing\.com\/search|google\.[^/]+\/search/i.test(currentUrl);

            if (onSearchEnginePage && repeatedScrolling && Array.isArray(markers) && markers.length > 0) {
                const candidate = markers.find((m) => {
                    const href = String(m?.href || '');
                    const text = String(m?.text || '');
                    if (!href.startsWith('http')) return false;
                    if (/duckduckgo\.com|bing\.com|google\./i.test(href)) return false;
                    return text.length >= 6;
                });

                if (candidate?.id) {
                    const selector = `[data-rex-id="${candidate.id}"]`;
                    const clicked = await page.click(selector, { timeout: 7000 }).then(() => true).catch(() => false);
                    if (clicked) {
                        await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
                        await page.waitForTimeout(900);
                        noteWebPlannerSuccess(planState, 'auto-opened search result to break repeated scroll loop');
                        lastResult = `Auto-opened search result ${candidate.id} to break scrolling loop.`;
                        actionHistory.push({ action: 'click', id: candidate.id, url: currentUrl });
                        continue;
                    }
                }
            }

            if (!canRequestPlannerStep(planState)) {
                return getBudgetExhaustedMessage(planState, normalizedGoal);
            }

            let stuckWarning = '';
            if (actionHistory.length >= 3) {
                const recent = actionHistory.slice(-3);
                const latest = actionHistory[actionHistory.length - 1];
                const allSame = recent.every((h) => h.url === currentUrl && h.action === latest.action && h.id === latest.id);
                if (allSame) {
                    stuckWarning = `\n[CRITICAL WARNING: You have performed "${recent[0].action}" on element "${recent[0].id}" 3 times in a row on this same URL. You are STUCK. Use a different element or strategy.]\n`;
                    if (parsedInput.practiceMode) {
                        await triggerBabysitPromptInPage(page, {
                            taskId: `practice-stuck-${Date.now()}`,
                            task: 'hmm... I might be stuck here. was that move useful?',
                            note: 'click which move to replay, then yes/no to label this move.'
                        });
                    }
                }
            }

            let preflightDesignerSpecStr = '';
            let matchedSpecData = null;
            try {
                const { getPreflightSpecJsonForUrl } = await import('./preflightDesigner.js');
                matchedSpecData = await getPreflightSpecJsonForUrl(currentUrl);
                if (matchedSpecData) {
                    preflightDesignerSpecStr = formatPreflightSpecForPrompt(matchedSpecData.spec);
                }
            } catch (e) {
                // Ignore
            }

            const plannerContext = buildWebPlannerContext(planState, {
                url: currentUrl,
                title: pageTitle,
                lastResult
            });

            const prompt = `You are Rex, an advanced autonomous web agent.
You are interacting with a browser that has visual numeric markers (e.g., [1], [2]) placed over interactive elements.

Goal: ${normalizedGoal}
Current URL: ${currentUrl}
Current Page Title: ${pageTitle}${preflightDesignerSpecStr}
ACTION HISTORY (Last 5): ${actionHistory.slice(-5).map((h) => `${h.action}(${h.id || ''})`).join(' -> ') || 'None'}
${stuckWarning}
Last Action Result: ${lastResult}

PLANNER STATE:
${plannerContext}

VISIBLE PAGE SUMMARY:
- Headings: ${JSON.stringify(pageSummary.headings)}
- Text excerpt: ${pageSummary.text}
- Likely answer blocks: ${pageSummary.likelyAnswerBlocks}
- Extraction meta: ${JSON.stringify(pageSummary.meta || {})}

Visible Interactive Elements (ID -> Details):
${JSON.stringify(markers, null, 2)}

Rules:
- FACTUAL ANCHORING: Do not invent page facts.
- ANSWER-FIRST: If page summary already answers the goal, choose "done".
- Use numeric IDs for standard DOM actions, or use preflight_action if a spec matches.
- If blocked/failing, update subplan and pivot.
- PREFLIGHT ACTIONS: If a PREFLIGHT DESIGNER WEBSITE MAP is present, prefer using "action": "preflight_action" with "name": "<action_name>" and optional "params": {"<name>": "<value>"} rather than clicking around blindly.

Respond with exactly one JSON object:
{"thought":"...","plan":{"objective":"...","tasks":[{"id":"T1","title":"...","status":"pending|in-progress|done|blocked"}]},"execution":{"mode":"main|subplan","currentTaskId":"T1","note":"..."},"subplan":{"id":"SP-1","parentTaskId":"T1","trigger":"...","steps":[{"id":"SP1","title":"...","status":"pending|in-progress|done|blocked"}]},"action":"search|navigate|click|type|scroll|hover|back|refresh|preflight_action|done","url":"...","id":"...","text":"...","query":"...","name":"...","params":{},"reasoning":"..."}
Omit subplan when there is no active issue.`;

            const plannerComplexity = (planState.execution.mode === 'subplan' || planState.counters.issueCount >= 2)
                ? 'high'
                : planState.budget.plannerComplexity;

            let plannerTarget = null;
            if (parsedInput.practiceMode && parsedInput.forcePlannerModel) {
                plannerTarget = {
                    provider: parsedInput.forcePlannerProvider || 'openai',
                    model: parsedInput.forcePlannerModel
                };
            }
            if (!plannerTarget && config.multiModelAgentEnabled) {
                const provider = resolveModelAlias(config.aiModel || '') === 'gemini' ? 'gemini' : 'openai';
                plannerTarget = {
                    provider,
                    model: provider === 'gemini'
                        ? (config.agentPlannerGeminiModel || 'gemini-3.5-flash')
                        : (config.agentPlannerOpenAIModel || 'gpt-4o-mini')
                };
            }

            notePlannerStepRequested(planState, planState.execution.mode === 'subplan' ? 'subplan' : 'main');

            const rawResponse = plannerTarget
                ? await runCompletionWithTarget([{ role: 'user', content: prompt }], plannerTarget, signal)
                : await runCompletion([{ role: 'user', content: prompt }], signal, plannerComplexity);

            let command;
            try {
                command = parseFirstJsonObject(rawResponse);
            } catch {
                noteWebPlannerIssue(planState, 'planner_parse_error', String(rawResponse || '').slice(0, 180));
                lastResult = `Failed to parse AI response: ${String(rawResponse || '').substring(0, 60)}`;
                continue;
            }

            if (!command || !command.action) {
                noteWebPlannerIssue(planState, 'planner_missing_action', String(rawResponse || '').slice(0, 180));
                lastResult = `Invalid command payload: ${String(rawResponse || '').substring(0, 80)}`;
                continue;
            }

            applyWebPlannerPayload(planState, command);
            command.action = String(command.action || '').trim().toLowerCase();

            actionHistory.push({
                action: command.action,
                id: command.id || command.url || command.query || '',
                url: currentUrl
            });

            if (command.action === 'done') {
                const needsConcreteList = /(ingredient|ingredients|list all|required to make|what goes into)/i.test(normalizedGoal);
                if (needsConcreteList) {
                    const extracted = await extractBestPageText(page, normalizedGoal);
                    const ingredients = extractIngredientListFromText(extracted.text);
                    if (ingredients.length >= 4) {
                        await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                        return `Goal achieved. Ingredients found:\n- ${ingredients.join('\n- ')}`;
                    }

                    noteWebPlannerIssue(planState, 'weak_done_claim', 'done without concrete list evidence');
                    lastResult = 'Done requested, but concrete list not extracted yet. Continuing.';
                    continue;
                }

                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                return `Goal achieved: ${command.reasoning || command.thought}`;
            }

            if (command.action === 'back') {
                await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
                noteWebPlannerSuccess(planState, 'navigated back');
                lastResult = `Navigated back from ${currentUrl}`;
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                continue;
            }

            if (command.action === 'refresh') {
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                noteWebPlannerSuccess(planState, 'refreshed page');
                lastResult = `Reloaded ${currentUrl}`;
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                continue;
            }

            if (command.action === 'search') {
                try {
                    const q = String(command.query || command.text || normalizedGoal).trim();
                    const searchRes = await resilientSearch(page, q);
                    if (!searchRes.ok) {
                        noteWebPlannerIssue(planState, 'search_failed', searchRes.error || 'unknown search failure');
                        noteRecoveryAttempt(planState, 'search_failed');
                        lastResult = `Failed search action: ${searchRes.error}`;
                        continue;
                    }
                    await page.waitForTimeout(1200);
                    noteWebPlannerSuccess(planState, `search success for ${q.slice(0, 80)}`);
                    lastResult = `Searched for: ${q}`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                } catch (e) {
                    noteWebPlannerIssue(planState, 'search_exception', e.message);
                    noteRecoveryAttempt(planState, 'search_exception');
                    lastResult = `Failed search action: ${e.message}`;
                }
                continue;
            }

            if (command.action === 'navigate') {
                if (!command.url) {
                    noteWebPlannerIssue(planState, 'navigate_missing_url', 'missing url');
                    lastResult = 'Navigate action missing url. Use action "search" if destination is unknown.';
                    continue;
                }

                let safeUrl;
                try {
                    safeUrl = normalizeWebUrl(command.url);
                } catch (e) {
                    noteWebPlannerIssue(planState, 'navigate_invalid_url', e.message);
                    lastResult = `Invalid navigate URL: ${e.message}`;
                    continue;
                }

                const host = new URL(safeUrl).hostname;
                if (isPlaceholderHost(host)) {
                    const fallbackQ = String(command.reasoning || command.thought || normalizedGoal).trim();
                    await resilientSearch(page, fallbackQ || normalizedGoal);
                    noteRecoveryAttempt(planState, 'placeholder_redirect_to_search');
                    await page.waitForTimeout(1000);
                    lastResult = `Blocked placeholder domain ${host}; searched instead for: ${fallbackQ || normalizedGoal}`;
                    continue;
                }

                if (url === safeUrl) {
                    lastResult = `Already on ${url}. Skipping redundant navigation.`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                    continue;
                }

                manager.trackNavigationAttempt(safeUrl, 'autonomous_navigate');
                const loopSignal = manager.getNavigationLoopSignal(safeUrl);
                if (loopSignal.looping) {
                    const fallbackQuery = buildSiteScopedRecoveryQuery(safeUrl, normalizedGoal);
                    const searchRes = await resilientSearch(page, fallbackQuery);
                    noteRecoveryAttempt(planState, 'autonomous_navigation_loop_recovery');
                    if (!searchRes.ok) {
                        noteWebPlannerIssue(planState, 'navigation_loop_recovery_failed', searchRes.error || 'unknown search recovery failure');
                        lastResult = `Repeated navigate loop detected for ${safeUrl}, but recovery search failed: ${searchRes.error}`;
                        continue;
                    }
                    noteWebPlannerSuccess(planState, `loop recovery search: ${fallbackQuery.slice(0, 80)}`);
                    lastResult = `Detected repeated navigate loop for ${safeUrl}. Recovered by searching: ${fallbackQuery}`;
                    continue;
                }

                const nav = await resilientGoto(page, safeUrl, {
                    timeout: 30000,
                    waitUntilPrimary: 'load',
                    waitUntilFallback: 'domcontentloaded'
                });
                if (!nav.ok) {
                    const recovery = await resilientSearch(page, safeUrl);
                    noteRecoveryAttempt(planState, 'navigate_blank_recovery');
                    if (!recovery.ok) {
                        noteWebPlannerIssue(planState, 'navigate_failed', recovery.error || nav.error || 'unknown navigate failure');
                        lastResult = `Failed navigate to ${safeUrl}: ${recovery.error}`;
                        continue;
                    }
                    lastResult = `Navigation to ${safeUrl} blanked. Recovered via search.`;
                    continue;
                }

                await page.waitForTimeout(600);
                noteWebPlannerSuccess(planState, `navigated to ${safeUrl}`);
                lastResult = `Navigated to ${safeUrl}`;
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                continue;
            }

            if (command.action === 'click') {
                try {
                    const id = Number(command.id);
                    if (!Number.isFinite(id)) {
                        noteWebPlannerIssue(planState, 'click_invalid_id', String(command.id || '')); 
                        lastResult = `Click action missing/invalid id: ${command.id}`;
                        continue;
                    }

                    const selector = `[data-rex-id="${command.id}"]`;
                    await cursorMoveToSelector(page, selector, 250, pickBrowserCursorStyle('click'));
                    const isVisible = await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 && rect.top >= 0;
                    }, selector).catch(() => false);

                    if (!isVisible) {
                        noteWebPlannerIssue(planState, 'click_stale_target', `id ${command.id}`);
                        lastResult = `Element ID ${command.id} is not visible or stale.`;
                        continue;
                    }

                    const clicked = await robustClick(page, selector);
                    if (!clicked.ok) {
                        noteWebPlannerIssue(planState, 'click_failed', clicked.error || 'unknown click failure');
                        lastResult = `Failed click on ID ${command.id}: ${clicked.error}`;
                        continue;
                    }

                    await cursorClickPulse(page, pickBrowserCursorStyle('click'));
                    const settled = await settleAfterInteraction(page, { interaction: 'autonomous_click', popupClicks: 2, dropdownWaitMs: 320 });
                    const interactionDelta = await page.evaluate(() => window.__rexPreflightInteractionDelta || null).catch(() => null);
                    const mutationDelta = interactionDelta?.mutationDelta || {};
                    const mutationScore = Number(mutationDelta.added || 0)
                        + Number(mutationDelta.removed || 0)
                        + Number(mutationDelta.attributes || 0)
                        + Number(mutationDelta.text || 0);
                    if (mutationScore <= 0) {
                        noteWebPlannerIssue(planState, 'click_low_impact', `id ${command.id} produced no observed mutation delta`);
                    }
                    noteWebPlannerSuccess(planState, `clicked id ${command.id}`);
                    const suffix = settled.note ? `; ${settled.note}` : '';
                    lastResult = `Clicked element ID ${command.id} (${clicked.mode}${suffix})`;
                    continue;
                } catch (e) {
                    noteWebPlannerIssue(planState, 'click_exception', e.message);
                    lastResult = `Failed click on ID ${command.id}: ${e.message}`;
                    continue;
                }
            }

            if (command.action === 'type') {
                try {
                    const id = Number(command.id);
                    if (!Number.isFinite(id)) {
                        noteWebPlannerIssue(planState, 'type_invalid_id', String(command.id || ''));
                        lastResult = `Type action missing/invalid id: ${command.id}`;
                        continue;
                    }
                    if (typeof command.text !== 'string' || !command.text.trim()) {
                        noteWebPlannerIssue(planState, 'type_missing_text', `id ${command.id}`);
                        lastResult = `Type action missing text for ID ${command.id}.`;
                        continue;
                    }

                    const selector = `[data-rex-id="${command.id}"]`;
                    await cursorMoveToSelector(page, selector, 230, pickBrowserCursorStyle('type'));
                    const exists = await page.locator(selector).count();
                    if (!exists) {
                        noteWebPlannerIssue(planState, 'type_stale_target', `id ${command.id}`);
                        lastResult = `Element ID ${command.id} is stale or not visible anymore.`;
                        continue;
                    }

                    const typed = await robustType(page, selector, command.text, true);
                    if (!typed.ok) {
                        noteWebPlannerIssue(planState, 'type_failed', typed.error || 'unknown type failure');
                        lastResult = `Failed type on ID ${command.id}: ${typed.error}`;
                        continue;
                    }

                    await cursorClickPulse(page, pickBrowserCursorStyle('type'));
                    const settled = await settleAfterInteraction(page, { interaction: 'autonomous_type', popupClicks: 2, dropdownWaitMs: 260 });
                    const interactionDelta = await page.evaluate(() => window.__rexPreflightInteractionDelta || null).catch(() => null);
                    const mutationDelta = interactionDelta?.mutationDelta || {};
                    const mutationScore = Number(mutationDelta.added || 0)
                        + Number(mutationDelta.removed || 0)
                        + Number(mutationDelta.attributes || 0)
                        + Number(mutationDelta.text || 0);
                    if (mutationScore <= 0) {
                        noteWebPlannerIssue(planState, 'type_low_impact', `id ${command.id} produced no observed mutation delta`);
                    }
                    noteWebPlannerSuccess(planState, `typed in id ${command.id}`);
                    const suffix = settled.note ? `; ${settled.note}` : '';
                    lastResult = `Typed into element ID ${command.id} (${typed.mode}${suffix})`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                    continue;
                } catch (e) {
                    noteWebPlannerIssue(planState, 'type_exception', e.message);
                    lastResult = `Failed type on ID ${command.id}: ${e.message}`;
                    continue;
                }
            }

            if (command.action === 'hover') {
                try {
                    const id = Number(command.id);
                    if (!Number.isFinite(id)) {
                        noteWebPlannerIssue(planState, 'hover_invalid_id', String(command.id || ''));
                        lastResult = `Hover action missing/invalid id: ${command.id}`;
                        continue;
                    }

                    const selector = `[data-rex-id="${command.id}"]`;
                    await cursorMoveToSelector(page, selector, 220, pickBrowserCursorStyle('hover'));
                    const exists = await page.locator(selector).count();
                    if (!exists) {
                        noteWebPlannerIssue(planState, 'hover_stale_target', `id ${command.id}`);
                        lastResult = `Element ID ${command.id} is stale or not visible anymore.`;
                        continue;
                    }

                    const hovered = await robustHover(page, selector);
                    if (!hovered.ok) {
                        noteWebPlannerIssue(planState, 'hover_failed', hovered.error || 'unknown hover failure');
                        lastResult = `Failed hover on ID ${command.id}: ${hovered.error}`;
                        continue;
                    }

                    const settled = await settleAfterInteraction(page, { interaction: 'autonomous_hover', popupClicks: 1, dropdownWaitMs: 300 });
                    noteWebPlannerSuccess(planState, `hovered id ${command.id}`);
                    const suffix = settled.note ? `; ${settled.note}` : '';
                    lastResult = `Hovered over element ID ${command.id} (${hovered.mode}${suffix})`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                    continue;
                } catch (e) {
                    noteWebPlannerIssue(planState, 'hover_exception', e.message);
                    lastResult = `Failed hover on ID ${command.id}: ${e.message}`;
                    continue;
                }
            }

            if (command.action === 'preflight_action') {
                try {
                    const actionName = command.name;
                    if (!actionName) {
                        noteWebPlannerIssue(planState, 'preflight_action_missing_name', 'missing name');
                        lastResult = 'Preflight action missing "name".';
                        continue;
                    }

                    if (!matchedSpecData || !matchedSpecData.spec) {
                        noteWebPlannerIssue(planState, 'preflight_no_spec', actionName);
                        lastResult = `Failed: Preflight Designer spec not found/matched for this page.`;
                        continue;
                    }

                    const actionObj = matchedSpecData.spec.actions?.[actionName];
                    if (!actionObj) {
                        noteWebPlannerIssue(planState, 'preflight_invalid_action', actionName);
                        lastResult = `Failed: Preflight action "${actionName}" not found in spec.`;
                        continue;
                    }

                    const type = actionObj.action_type || actionObj.type || 'browser';
                    const params = command.params || {};

                    if (type === 'api') {
                        const apiInfo = actionObj.api;
                        if (!apiInfo || !apiInfo.url) {
                            noteWebPlannerIssue(planState, 'preflight_api_missing_config', actionName);
                            lastResult = `Failed: Preflight api action "${actionName}" lacks api config in spec.`;
                            continue;
                        }

                        let url = apiInfo.url;
                        let method = (apiInfo.method || 'POST').toUpperCase();
                        let body = {};
                        
                        const actionParams = actionObj.parameters || [];
                        for (const p of actionParams) {
                            const pName = p.name;
                            const pVal = params[pName] !== undefined ? params[pName] : '';
                            if (url.includes(`{${pName}}`)) {
                                url = url.replace(`{${pName}}`, encodeURIComponent(pVal));
                            } else if (method === 'GET') {
                                // Add to query string
                                const parsedUrl = new URL(url, page.url());
                                parsedUrl.searchParams.append(pName, String(pVal));
                                url = parsedUrl.pathname + parsedUrl.search;
                            } else {
                                body[pName] = pVal;
                            }
                        }

                        // Execute API upgrade via page.evaluate
                        const result = await page.evaluate(async ({ url, method, body }) => {
                            try {
                                const response = await fetch(url, {
                                    method,
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Accept': 'application/json'
                                    },
                                    body: method !== 'GET' && method !== 'HEAD' ? JSON.stringify(body) : undefined
                                });
                                const text = await response.text();
                                let json = null;
                                try {
                                    json = JSON.parse(text);
                                } catch {}
                                return {
                                    ok: response.ok,
                                    status: response.status,
                                    statusText: response.statusText,
                                    body: json || text
                                };
                            } catch (e) {
                                return { error: e.message };
                            }
                        }, { url, method, body });

                        if (result.error) {
                            noteWebPlannerIssue(planState, 'preflight_api_fetch_error', result.error);
                            lastResult = `Failed API upgrade for "${actionName}": ${result.error}`;
                            continue;
                        }

                        noteWebPlannerSuccess(planState, `executed api upgrade: ${actionName}`);
                        lastResult = `Preflight API Upgrade executed for action "${actionName}". Status: ${result.status} ${result.statusText}. Response: ${JSON.stringify(result.body)}`;
                        actionHistory.push({ action: 'preflight_api', id: actionName, url: currentUrl });
                        continue;
                    } else {
                        // DOM / browser action
                        // 1. Fill fields defined in parameters
                        const actionParams = actionObj.parameters || [];
                        let fieldsFilled = [];
                        for (const p of actionParams) {
                            const pName = p.name;
                            const pVal = params[pName];
                            if (pVal !== undefined && p.selector) {
                                await page.waitForSelector(p.selector, { timeout: 4000 });
                                await page.fill(p.selector, String(pVal));
                                fieldsFilled.push(pName);
                            }
                        }

                        // 2. Click main selector
                        if (actionObj.selector) {
                            await page.waitForSelector(actionObj.selector, { timeout: 4000 });
                            await page.click(actionObj.selector);
                            await page.waitForTimeout(600);
                            noteWebPlannerSuccess(planState, `executed DOM preflight action: ${actionName}`);
                            lastResult = `Preflight DOM action "${actionName}" executed. Filled fields: ${fieldsFilled.join(', ') || 'none'}. Clicked selector: ${actionObj.selector}`;
                            actionHistory.push({ action: 'preflight_dom', id: actionName, url: currentUrl });
                            continue;
                        }

                        noteWebPlannerSuccess(planState, `executed preflight form inputs: ${actionName}`);
                        lastResult = `Preflight DOM fields filled for "${actionName}": ${fieldsFilled.join(', ') || 'none'}. No click selector defined.`;
                        actionHistory.push({ action: 'preflight_dom_fields', id: actionName, url: currentUrl });
                        continue;
                    }
                } catch (e) {
                    noteWebPlannerIssue(planState, 'preflight_action_exception', e.message);
                    lastResult = `Preflight action execution exception: ${e.message}`;
                    continue;
                }
            }

            if (command.action === 'scroll') {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.6));
                await page.waitForTimeout(1000);
                noteWebPlannerSuccess(planState, 'scrolled for new targets');
                lastResult = 'Scrolled down';
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                continue;
            }

            noteWebPlannerIssue(planState, 'unknown_action', String(command.action || ''));
            lastResult = `Unknown action returned by planner: ${command.action}`;
        }
    } catch (err) {
        appendAutonomousBrowserDebug({
            source: 'run_autonomous_web_agent',
            phase: 'agent_fatal',
            error: err?.message || String(err)
        });
        return `Agent Error: ${err.message}`;
    }
}

// Internal hooks for focused regression tests around Preflight Analyse v2 scoring.
export const __webToolsPreflightTestHooks = {
    scoreTargetCandidate,
    preflightRecommendation
};

/**
 * Monitor a webpage for content changes or a specific condition.
 * Once met, alerts the user and runs an autonomous goal.
 */
export async function keep_a_look(args, signal = null) {
    const { url, condition, action, intervalSeconds = 30, selector, headless = false } = args;
    if (!url) {
        return 'Error: keep_a_look requires a "url" parameter.';
    }
    const checkIntervalMs = Math.max(5, Number(intervalSeconds) || 30) * 1000;

    const page = await manager.getPage({ headless });
    const safeUrl = normalizeWebUrl(url);

    console.log(`\n🦖 [Keep-A-Look] Opening initial page: ${safeUrl}...`);
    const nav = await resilientGoto(page, safeUrl, {
        timeout: 30000,
        waitUntilPrimary: 'load',
        waitUntilFallback: 'domcontentloaded'
    });

    if (!nav.ok) {
        return `Error: Failed to open ${safeUrl} during initial load.`;
    }

    await smartHandleConsentAndOverlays(page, { maxClicks: 2, preferReject: true });
    await page.waitForTimeout(1000);

    const getPageState = async () => {
        try {
            return await page.evaluate((sel) => {
                let el = document.body;
                if (sel) {
                    const target = document.querySelector(sel);
                    if (target) el = target;
                }
                const clone = el.cloneNode(true);
                clone.querySelectorAll('script, style, noscript, nav, footer, iframe').forEach(s => s.remove());
                return clone.innerText;
            }, selector);
        } catch {
            return '';
        }
    };

    const cleanText = (text) => {
        if (!text) return '';
        let clean = text.replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, '');
        clean = clean.replace(/\b\d+\b/g, '');
        clean = clean.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi, '');
        return clean.replace(/\s+/g, ' ').trim();
    };

    const logTextDiff = (prev, curr) => {
        const prevWords = new Set(prev.split(/\s+/));
        const currWords = new Set(curr.split(/\s+/));

        const added = [...currWords].filter(w => !prevWords.has(w) && w.length > 2);
        const removed = [...prevWords].filter(w => !currWords.has(w) && w.length > 2);

        if (added.length > 0) {
            console.log(`🦖 [Keep-A-Look] Added words: ${added.slice(0, 15).join(', ')}${added.length > 15 ? '...' : ''}`);
        }
        if (removed.length > 0) {
            console.log(`🦖 [Keep-A-Look] Removed words: ${removed.slice(0, 15).join(', ')}${removed.length > 15 ? '...' : ''}`);
        }
    };

    let rawPrev = await getPageState();
    let previousStateClean = cleanText(rawPrev);

    console.log(`🦖 [Keep-A-Look] Initial state captured (${previousStateClean.length} chars).`);
    console.log(`🦖 [Keep-A-Look] Watching for: ${condition || 'Any content change (diff)'}`);
    console.log(`🦖 [Keep-A-Look] Interval: ${intervalSeconds}s. Press Ctrl+C to abort.`);

    let checkCount = 0;
    while (true) {
        if (signal?.aborted) {
            return 'Keep-a-look aborted.';
        }

        // Wait interval
        await new Promise(resolve => {
            const timeout = setTimeout(resolve, checkIntervalMs);
            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            }
        });
        if (signal?.aborted) return 'Keep-a-look aborted.';

        checkCount++;
        console.log(`\n🦖 [Keep-A-Look] Refreshing page... (Check #${checkCount})`);

        try {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await smartHandleConsentAndOverlays(page, { maxClicks: 1, preferReject: true });
            await page.waitForTimeout(1000);
        } catch (err) {
            console.log(`⚠️ Reload failed: ${err.message}. Retrying next interval.`);
            continue;
        }

        const rawCurrent = await getPageState();
        const currentStateClean = cleanText(rawCurrent);

        let triggered = false;
        let diffReason = '';

        if (condition) {
            const loweredCondition = condition.toLowerCase();
            const loweredCurrent = currentStateClean.toLowerCase();
            const loweredPrev = previousStateClean.toLowerCase();

            if (loweredCondition.includes('tickets') || loweredCondition.includes('out') || loweredCondition.includes('available')) {
                const releaseKeywords = ['book', 'buy', 'checkout', 'get tickets', 'now open', 'tickets available', 'add to cart', 'select tickets'];
                const currentHas = releaseKeywords.some(k => loweredCurrent.includes(k));
                const prevHas = releaseKeywords.some(k => loweredPrev.includes(k));
                if (currentHas && !prevHas) {
                    triggered = true;
                    diffReason = `Ticket booking keywords detected on reload (e.g. "book/buy/tickets").`;
                }
            }

            if (!triggered && loweredCurrent.includes(loweredCondition) && !loweredPrev.includes(loweredCondition)) {
                triggered = true;
                diffReason = `Target condition text "${condition}" appeared on the page.`;
            }
            
            if (!triggered && currentStateClean !== previousStateClean) {
                const charDiff = Math.abs(currentStateClean.length - previousStateClean.length);
                if (charDiff > 20) {
                    triggered = true;
                    diffReason = 'Content changed significantly.';
                }
            }
        } else {
            if (currentStateClean !== previousStateClean) {
                const charDiff = Math.abs(currentStateClean.length - previousStateClean.length);
                if (charDiff > 10) {
                    triggered = true;
                    diffReason = 'Content changed.';
                }
            }
        }

        if (triggered) {
            console.log(`\n🚨🚨🚨 [Keep-A-Look] CHANGE DETECTED! 🚨🚨🚨`);
            console.log(`Reason: ${diffReason}`);
            logTextDiff(previousStateClean, currentStateClean);

            process.stdout.write('\x07');

            try {
                const { loadConfig } = await import('./config.js');
                const cfg = loadConfig();
                const platform = cfg.discordBotToken ? 'discord' : cfg.slackBotToken ? 'slack' : null;
                if (platform) {
                    const { sendNotification } = await import('./connectors.js');
                    await sendNotification(platform, `🚨 **[Keep-A-Look]** Change detected on ${safeUrl}!\nReason: ${diffReason}\nStarting autonomous goal: "${action || 'Autonomously check out'}"`);
                }
            } catch (err) {
                // ignore
            }

            const finalGoal = action || `Autonomously complete checkout on current page`;
            console.log(`🦖 [Keep-A-Look] Handing control to autonomous web agent with goal: "${finalGoal}"`);
            
            let agentResult;
            if (process.env.KEEP_A_LOOK_TEST_MOCK === 'true') {
                console.log(`[MOCK] Handing control to mock web agent with goal: "${finalGoal}"`);
                agentResult = 'Mock execution success';
            } else {
                agentResult = await run_autonomous_web_agent({
                    goal: finalGoal,
                    budgetMode: 'balanced',
                    maxSteps: 30
                }, signal);
            }

            console.log(`\n🦖 [Keep-A-Look] Autonomous agent run finished.`);
            console.log(agentResult);

            return `Keep-A-Look triggered! Agent output:\n${agentResult}`;
        }

        previousStateClean = currentStateClean;
    }
}


