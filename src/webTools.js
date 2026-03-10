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

const execFileAsync = util.promisify(execFile);

function resolveNavigationExtensionPath() {
    const fromEnv = process.env.REX_NAV_EXTENSION_PATH;
    const defaultPath = path.join(process.cwd(), 'extensions', 'preflight-analyse-navigator');
    const candidate = fromEnv && String(fromEnv).trim() ? String(fromEnv).trim() : defaultPath;
    return fs.existsSync(candidate) ? candidate : '';
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
    }

    async ensureBrowser() {
        if (this.browser && !this.browser.isConnected()) {
            this.browser = null;
            this.context = null;
            this.pages = [];
            this.currentPageIndex = 0;
            this.lastHealthyUrl = '';
        }

        if (!this.browser) {
            const { chromium } = await import('playwright');
            const extensionPath = resolveNavigationExtensionPath();

            if (extensionPath) {
                const profilePath = path.join(process.cwd(), '.agent', 'playwright-profile');
                if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

                try {
                    this.context = await chromium.launchPersistentContext(profilePath, {
                        headless: false,
                        args: [
                            `--disable-extensions-except=${extensionPath}`,
                            `--load-extension=${extensionPath}`
                        ]
                    });
                    this.browser = this.context.browser();
                    this.usingExtension = true;
                    this.extensionPath = extensionPath;
                } catch (extErr) {
                    appendAutonomousBrowserDebug({
                        source: 'ensureBrowser',
                        phase: 'extension_launch_failed_fallback',
                        extensionPath,
                        error: extErr?.message || String(extErr)
                    });

                    this.browser = await chromium.launch({ headless: false });
                    this.context = await this.browser.newContext();
                    this.usingExtension = false;
                    this.extensionPath = '';
                }
            } else {
                this.browser = await chromium.launch({ headless: false });
                this.context = await this.browser.newContext();
                this.usingExtension = false;
                this.extensionPath = '';
            }

            const page = await this.context.newPage();
            this.pages.push(page);
        }

        if (!this.context) {
            this.context = await this.browser.newContext();
        }

        // Rebuild page list from context in case tabs were opened/closed outside manager bookkeeping.
        this.pages = this.context.pages().filter((p) => !p.isClosed());

        this.pages = this.pages.filter((p) => !p.isClosed());
        if (this.pages.length === 0 && this.context) {
            const page = await this.context.newPage();
            this.pages.push(page);
        }

        if (this.currentPageIndex >= this.pages.length) {
            this.currentPageIndex = Math.max(0, this.pages.length - 1);
        }

        return this.browser;
    }

    async getPage() {
        await this.ensureBrowser();
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

const manager = new BrowserManager();

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
                    resolve();
                }
            };

            state.raf = requestAnimationFrame(tick);
        });

        const clickPulse = () => {
            const before = state.style || 'default';
            const pressed = icons.handgrabbing ? 'handgrabbing' : before;
            showOnly(pressed);
            window.setTimeout(() => {
                showOnly(before);
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

function preflightRecommendation(health, targetAction, readiness) {
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
        const page = await manager.getPage();
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
        if (action === 'preflight_analyse' || action === 'preflight_analyze' || action === 'diagnose') {
            const targetAction = String(args.targetAction || args.nextAction || '').trim().toLowerCase();
            const autoHeal = args.autoHeal !== false;

            let readiness = { ok: true };
            if (autoHeal && targetAction) {
                readiness = await ensureActionablePage(page, targetAction, args);
            }

            const health = await collectBrowserHealth(page);
            const recommendation = preflightRecommendation(health, targetAction, readiness);
            const report = {
                feature: 'Preflight Analyse',
                targetAction: targetAction || 'unspecified',
                autoHeal,
                healed: readiness.recovered === true,
                readiness,
                health,
                recommendation
            };

            report.navigatorAssist = {
                usingExtension: manager.usingExtension,
                extensionPath: manager.extensionPath || ''
            };

            const plotSummary = getPreflightAnalysePlotSummary(health.url, targetAction);
            report.preflgihtAnalysePlot = plotSummary;
            report.preflightAnalysePlot = plotSummary;

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
            const summary = {
                feature: 'Preflight Analyse',
                page: {
                    url: page.url() || '',
                    title: await page.title().catch(() => 'Unknown')
                },
                totalInteractive: snapshot.length,
                sample: snapshot.slice(0, 40),
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
            const searchRes = await resilientSearch(page, searchQuery);
            if (!searchRes.ok) {
                return `Error: search failed for "${searchQuery}": ${searchRes.error}`;
            }
            manager.lastHealthyUrl = page.url() || manager.lastHealthyUrl;
            await smartHandleConsentAndOverlays(page, { maxClicks: 1, preferReject: true });
            await page.waitForTimeout(1000);
            const title = await page.title().catch(() => 'Search Results');
            result = `${recoveryPrefix}Searched for "${searchQuery}". Title: "${title}". URL: ${searchRes.url}`;
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

/**
 * Runs an autonomous loop using headful Playwright to achieve a web goal visually.
 */
export async function run_autonomous_web_agent(goal, signal = null) {
    const { runCompletion } = await import('./ai.js');
    const normalizedGoal = String(goal || '').trim();
    if (!normalizedGoal) return 'Agent Error: Missing goal.';
    if (signal?.aborted) return 'Aborted';
    
    try {
        const page = await manager.getPage();
        await ensureVisualCursor(page, pickBrowserCursorStyle('default'));

        let stepCount = 0;
        let lastResult = 'Started browser.';
        let actionHistory = []; // Tracks [{ action, id, url }]
        let authWallCount = 0;
        let blockerRecoveries = 0;

        if (isBlankUrl(page.url())) {
            const initRecovery = await recoverBlankPage(page, { query: normalizedGoal, goal: normalizedGoal });
            if (!initRecovery.ok) {
                return `Agent Error: Failed to initialize browsing context: ${initRecovery.error}`;
            }
            lastResult = `Initialized browser context via ${initRecovery.strategy}.`;
        }

        const initialBlock = await detectAutomationBlockers(page);
        if (initialBlock) {
            const recovery = await resilientSearch(page, normalizedGoal);
            if (!recovery.ok) {
                return `Agent stopped: ${initialBlock}`;
            }
            lastResult = `Recovered from initial blocker by re-searching goal.`;
        }
        
        while (stepCount < 35) {
            if (signal?.aborted) return 'Aborted';
            stepCount++;

            const popupActions = await smartHandleConsentAndOverlays(page, { maxClicks: 3, preferReject: true });
            if (popupActions.clickedCount > 0) {
                await page.waitForTimeout(500);
                lastResult = `Cleared ${popupActions.clickedCount} popup/overlay action(s).`;
            }

            const blockedNow = await detectAutomationBlockers(page);
            if (blockedNow) {
                blockerRecoveries++;
                if (blockerRecoveries > 2) {
                    return `Agent stopped at step ${stepCount}: ${blockedNow}`;
                }
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                const recovery = await resilientSearch(page, normalizedGoal);
                if (!recovery.ok) {
                    return `Agent stopped at step ${stepCount}: ${blockedNow}`;
                }
                lastResult = `Recovered from blocker by switching search surface.`;
                continue;
            }

            const authState = await detectAuthState(page);
            if (authState.requiresAuth) {
                authWallCount++;
                if (authWallCount >= 2) {
                    return `Agent paused: login is required and cannot be bypassed safely. Current URL: ${authState.url}. Please complete login manually, then continue with browser_interact action \"wait_for_auth\" or rerun the task.`;
                }
                lastResult = `Detected auth wall (${authState.hardGateHits.join(', ') || 'login required'}). Trying non-login bypass controls.`;
                continue;
            } else {
                authWallCount = 0;
            }
            
            let url = page.url();
            if (isBlankUrl(url)) {
                const recovery = await recoverBlankPage(page, { query: normalizedGoal, goal: normalizedGoal });
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
                    step: stepCount,
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

            // Escape hatch: if we keep scrolling on a search page, click the first likely external result.
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
                        lastResult = `Auto-opened search result ${candidate.id} to break scrolling loop.`;
                        actionHistory.push({ action: 'click', id: candidate.id, url: currentUrl });
                        continue;
                    }
                }
            }

            // Stuck/Loop Detection
            let stuckWarning = '';
            if (actionHistory.length >= 3) {
                const recent = actionHistory.slice(-3);
                const allSame = recent.every(h => h.url === currentUrl && h.action === actionHistory[actionHistory.length-1].action && h.id === actionHistory[actionHistory.length-1].id);
                if (allSame) {
                    stuckWarning = `\n[CRITICAL WARNING: You have performed "${recent[0].action}" on element "${recent[0].id}" 3 times in a row on this same URL. The page state is NOT changing. You are STUCK. DO NOT repeat the same action again. Try a DIFFERENT element, use "back", "refresh", or "search" for a different approach.]\n`;
                }
            }

            const prompt = `You are Rex, an advanced autonomous web agent.
You are interacting with a browser that has visual numeric markers (e.g., [1], [2]) placed over every clickable element.

Goal: ${normalizedGoal}
Current URL: ${currentUrl}
Current Page Title: ${pageTitle}
ACTION HISTORY (Last 5): ${actionHistory.slice(-5).map(h => `${h.action}(${h.id || ''})`).join(' -> ') || 'None'}
${stuckWarning}
Last Action Result: ${lastResult}

VISIBLE PAGE SUMMARY (READ THIS CAREFULLY BEFORE NEW ACTIONS):
- Headings: ${JSON.stringify(pageSummary.headings)}
- Text excerpt: ${pageSummary.text}
- Likely answer blocks: ${pageSummary.likelyAnswerBlocks}
- Extraction meta: ${JSON.stringify(pageSummary.meta || {})}

Visible Interactive Elements (ID -> Details):
${JSON.stringify(markers, null, 2)}

Analyze the page and decide the next step.
FACTUAL ANCHORING: You MUST report exactly what you see. If a tool output says "0% chance of rain", do NOT report high likelihood.
ANSWER-FIRST RULE: If the visible page summary already contains the answer (or strong evidence) for the user's goal, do NOT search/navigate again. Choose "done" and cite the exact evidence from the visible summary.
If the element you need isn't visible, use "scroll" to see more of the page.
If you need to view a dropdown, use "hover" on its ID.
If you hit a dead end, use "back" or "refresh" to escape.
If you need to discover websites, use "search" instead of guessing domains.
Never use placeholder domains like example.com, example.org, or example.net.

Respond with EXACTLY ONE JSON object using the ReAct framework:
{"thought": "I previously did X... The page shows Y... I will now do Z because... [Contradiction Check: My plan aligns with observed data]", "action": "search"|"navigate"|"click"|"type"|"scroll"|"hover"|"back"|"refresh"|"done", "url": "...", "id": "numeric_id_here", "text": "...", "query": "...", "reasoning": "..."}

IMPORTANT: Do NOT guess CSS selectors. Use the numeric "id" provided in the map above.`;

            const rawResponse = await runCompletion([{ role: 'user', content: prompt }], null, 'high');
            let command;
            try {
                command = parseFirstJsonObject(rawResponse);
            } catch (err) {
                lastResult = `Failed to parse AI response: ${rawResponse.substring(0, 40)}`;
                continue;
            }

            if (!command || !command.action) {
                lastResult = `Invalid command payload: ${String(rawResponse).substring(0, 60)}`;
                continue;
            }

            command.action = String(command.action || '').trim().toLowerCase();

            // Record history
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

                    // If the model says done without concrete data, force one more pass instead of ending empty.
                    lastResult = 'Done requested, but concrete ingredient list not yet extracted. Performing extract_text pass first.';
                    continue;
                }
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                return `Goal achieved: ${command.reasoning || command.thought}`;
            } else if (command.action === 'back') {
                await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
                lastResult = `Navigated back from ${currentUrl}`;
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                continue;
            } else if (command.action === 'refresh') {
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                lastResult = `Reloaded ${currentUrl}`;
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                continue;
            } else if (command.action === 'search') {
                try {
                    const q = String(command.query || command.text || normalizedGoal).trim();
                    const searchRes = await resilientSearch(page, q);
                    if (!searchRes.ok) {
                        lastResult = `Failed search action: ${searchRes.error}`;
                        continue;
                    }
                    await page.waitForTimeout(1200);
                    lastResult = `Searched for: ${q}`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                } catch (e) {
                    lastResult = `Failed search action: ${e.message}`;
                }
            } else if (command.action === 'navigate') {
                if (!command.url) {
                    lastResult = 'Navigate action missing url. Use action "search" if destination is unknown.';
                    continue;
                }

                let safeUrl;
                try {
                    safeUrl = normalizeWebUrl(command.url);
                } catch (e) {
                    lastResult = `Invalid navigate URL: ${e.message}`;
                    continue;
                }

                const host = new URL(safeUrl).hostname;
                if (isPlaceholderHost(host)) {
                    const fallbackQ = String(command.reasoning || command.thought || normalizedGoal).trim();
                    await resilientSearch(page, fallbackQ || normalizedGoal);
                    await page.waitForTimeout(1000);
                    lastResult = `Blocked placeholder domain ${host}; searched instead for: ${fallbackQ || normalizedGoal}`;
                    continue;
                }

                if (url === safeUrl) {
                    lastResult = `Already on ${url}. Skipping redundant navigation. Try searching or clicking an element.`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                } else {
                    const nav = await resilientGoto(page, safeUrl, {
                        timeout: 30000,
                        waitUntilPrimary: 'load',
                        waitUntilFallback: 'domcontentloaded'
                    });
                    if (!nav.ok) {
                        const recovery = await resilientSearch(page, safeUrl);
                        if (!recovery.ok) {
                            lastResult = `Failed navigate to ${safeUrl}: ${recovery.error}`;
                            continue;
                        }
                        lastResult = `Navigation to ${safeUrl} blanked. Recovered via search.`;
                        continue;
                    }
                    await page.waitForTimeout(600);
                    lastResult = `Navigated to ${safeUrl}`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                }
            } else if (command.action === 'click') {
                try {
                    const id = Number(command.id);
                    if (!Number.isFinite(id)) {
                        lastResult = `Click action missing/invalid id: ${command.id}`;
                        continue;
                    }
                    const selector = `[data-rex-id="${command.id}"]`;
                    await cursorMoveToSelector(page, selector, 250, pickBrowserCursorStyle('click'));
                    
                    // Specific check for visibility/interactivity
                    const isVisible = await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 && rect.top >= 0;
                    }, selector).catch((e) => {
                        appendAutonomousBrowserDebug({
                            source: 'run_autonomous_web_agent',
                            phase: 'click_visibility_check',
                            step: stepCount,
                            url: page.url(),
                            selector,
                            error: e?.message || String(e)
                        });
                        return false;
                    });

                    if (!isVisible) {
                        lastResult = `Element ID ${command.id} is not visible or stale. Run "evaluate" to see more or scroll.`;
                        continue;
                    }


                    const clicked = await robustClick(page, selector);
                    if (!clicked.ok) {
                        lastResult = `Failed click on ID ${command.id}: ${clicked.error}`;
                        continue;
                    }
                    await cursorClickPulse(page, pickBrowserCursorStyle('click'));

                    const settled = await settleAfterInteraction(page, { interaction: 'autonomous_click', popupClicks: 2, dropdownWaitMs: 320 });
                    const suffix = settled.note ? `; ${settled.note}` : '';
                    lastResult = `Clicked element ID ${command.id} (${clicked.mode}${suffix})`;
                } catch(e) { lastResult = `Failed click on ID ${command.id}: ${e.message}`; }
            } else if (command.action === 'type') {
                try {
                    const id = Number(command.id);
                    if (!Number.isFinite(id)) {
                        lastResult = `Type action missing/invalid id: ${command.id}`;
                        continue;
                    }
                    if (typeof command.text !== 'string' || !command.text.trim()) {
                        lastResult = `Type action missing text for ID ${command.id}.`;
                        continue;
                    }

                    const selector = `[data-rex-id="${command.id}"]`;
                    await cursorMoveToSelector(page, selector, 230, pickBrowserCursorStyle('type'));
                    const exists = await page.locator(selector).count();
                    if (!exists) {
                        lastResult = `Element ID ${command.id} is stale or not visible anymore. Re-evaluate the page.`;
                        continue;
                    }


                    const typed = await robustType(page, selector, command.text, true);
                    if (!typed.ok) {
                        lastResult = `Failed type on ID ${command.id}: ${typed.error}`;
                        continue;
                    }
                    await cursorClickPulse(page, pickBrowserCursorStyle('type'));
                    const settled = await settleAfterInteraction(page, { interaction: 'autonomous_type', popupClicks: 2, dropdownWaitMs: 260 });
                    const suffix = settled.note ? `; ${settled.note}` : '';
                    lastResult = `Typed into element ID ${command.id} (${typed.mode}${suffix})`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                } catch(e) { lastResult = `Failed type on ID ${command.id}: ${e.message}`; }
            } else if (command.action === 'hover') {
                try {
                    const id = Number(command.id);
                    if (!Number.isFinite(id)) {
                        lastResult = `Hover action missing/invalid id: ${command.id}`;
                        continue;
                    }
                    const selector = `[data-rex-id="${command.id}"]`;
                    await cursorMoveToSelector(page, selector, 220, pickBrowserCursorStyle('hover'));
                    const exists = await page.locator(selector).count();
                    if (!exists) {
                        lastResult = `Element ID ${command.id} is stale or not visible anymore. Re-evaluate the page.`;
                        continue;
                    }

                    const hovered = await robustHover(page, selector);
                    if (!hovered.ok) {
                        lastResult = `Failed hover on ID ${command.id}: ${hovered.error}`;
                        continue;
                    }
                    const settled = await settleAfterInteraction(page, { interaction: 'autonomous_hover', popupClicks: 1, dropdownWaitMs: 300 });
                    const suffix = settled.note ? `; ${settled.note}` : '';
                    lastResult = `Hovered over element ID ${command.id} (${hovered.mode}${suffix})`;
                    await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
                } catch(e) { lastResult = `Failed hover on ID ${command.id}: ${e.message}`; }
            } else if (command.action === 'scroll') {
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.6));
                await page.waitForTimeout(1000);
                lastResult = `Scrolled down`;
                await cursorParkIdle(page, 'auto', pickBrowserCursorStyle('default'));
            }
        }

        return `Stopped after 35 steps. Goal not fully reached. Last result: ${lastResult}`;
    } catch (err) {
        appendAutonomousBrowserDebug({
            source: 'run_autonomous_web_agent',
            phase: 'agent_fatal',
            error: err?.message || String(err)
        });
        return `Agent Error: ${err.message}`;
    }
}

