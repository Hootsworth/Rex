import pc from 'picocolors';
import gradient from 'gradient-string';

// ── Atlas Console Palette ──
// Cobalt core with mint telemetry and coral alerts.
export const brandTheme = gradient(['#0EA5E9', '#2563EB']);
export const accentTheme = (v) => pc.cyan(v);
const assistantFlow = gradient(['#22D3EE', '#14B8A6']);
const coolSteel = gradient(['#94A3B8', '#64748B']);
const mintFresh = gradient(['#34D399', '#10B981']);
const coralAlert = gradient(['#FB7185', '#F43F5E']);

const toneDecorators = {
    brand:     (v) => brandTheme(v),
    cool:      (v) => coolSteel(v),
    assistant: (v) => assistantFlow(v),
    action:    (v) => pc.cyan(v),
    success:   (v) => mintFresh(v),
    warning:   (v) => pc.magenta(v),
    danger:    (v) => coralAlert(v),
    muted:     (v) => pc.dim(v),
    info:      (v) => pc.blue(v)
};

// ── Emoji Palette ──
export const emoji = {
    rex:       '🦕',
    thinking:  '💭',
    spark:     '✨',
    bolt:      '⚡',
    check:     '✅',
    cross:     '❌',
    warn:      '⚠️',
    gear:      '⚙️',
    brain:     '🧠',
    rocket:    '🚀',
    eye:       '👁️',
    pin:       '📌',
    folder:    '📁',
    file:      '📄',
    search:    '🔍',
    link:      '🔗',
    clock:     '🕐',
    shield:    '🛡️',
    flame:     '🔥',
    crystal:   '💎',
    wave:      '👋',
    arrow:     '➜',
    dot:       '•',
    star:      '⭐',
    key:       '🔑',
    globe:     '🌐',
    paint:     '🎨',
    music:     '🎵',
    tool:      '🔧',
    plant:     '🌱',
    ghost:     '👻',
    mirror:    '🪞',
    map:       '🗺️'
};

// ── Micro-animation utilities ──
const FRAME_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export async function typewriter(text, speed = 12) {
    if (!supportsMotion()) { process.stdout.write(text); return; }
    for (const char of text) {
        process.stdout.write(char);
        await new Promise(r => setTimeout(r, speed));
    }
}

export async function fadeInLine(text, steps = 5) {
    if (!supportsMotion()) { console.log(text); return; }
    const plain = stripAnsi(text);
    for (let i = 0; i < steps; i++) {
        const opacity = i / (steps - 1);
        const faded = opacity < 0.3 ? pc.dim(pc.dim(plain)) : opacity < 0.6 ? pc.dim(plain) : text;
        process.stdout.write(`\r${faded}`);
        await new Promise(r => setTimeout(r, 30));
    }
    process.stdout.write('\n');
}

export async function pulseText(text, pulses = 2) {
    if (!supportsMotion()) { console.log(text); return; }
    for (let i = 0; i < pulses; i++) {
        process.stdout.write(`\r${pc.dim(text)}`);
        await new Promise(r => setTimeout(r, 100));
        process.stdout.write(`\r${text}     `);
        await new Promise(r => setTimeout(r, 100));
    }
    process.stdout.write('\n');
}

// ── Core utilities ──

function stripAnsi(value = '') {
    return String(value).replace(/\u001B\[[0-9;]*m/g, '');
}

function visibleLength(value = '') {
    return stripAnsi(value).length;
}

function padAnsi(value = '', width = 0) {
    const text = String(value);
    const remaining = width - visibleLength(text);
    return remaining > 0 ? `${text}${' '.repeat(remaining)}` : text;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function supportsUnicode() {
    if (process.env.TERM === 'dumb') return false;
    return !!process.stdout.isTTY;
}

export function supportsMotion() {
    return !!process.stdout.isTTY && process.env.CI !== 'true' && process.env.TERM !== 'dumb';
}

export function terminalGlyphs() {
    if (supportsUnicode()) {
        return {
            arrow:   '›',
            line:    '─',
            side:    '│',
            topL:    '╭',
            topR:    '╮',
            botL:    '╰',
            botR:    '╯',
            spark:   '·',
            dot:     '•',
            diamond: '◆',
            bullet:  '▸',
            chevron: '❯',
            pipe:    '┃',
            tick:    '✔',
            cross:   '✖'
        };
    }
    return {
        arrow: '>', line: '-', side: '|', topL: '+', topR: '+',
        botL: '+', botR: '+', spark: '.', dot: '.', diamond: '*',
        bullet: '>', chevron: '>', pipe: '|', tick: '√', cross: 'x'
    };
}

export function sleep(ms = 0) {
    if (!supportsMotion() || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Premium UI Components ──

// Pill badge with emoji
export function badge(text, tone = 'brand') {
    const decorate = toneDecorators[tone] || toneDecorators.brand;
    return decorate(`⟦ ${String(text)} ⟧`);
}

// Status chip with icon
export function chip(icon, label, tone = 'muted') {
    const decorate = toneDecorators[tone] || toneDecorators.muted;
    return `${decorate(`${icon} ${label}`)}`;
}

// Menu label with clean formatting
export function menuLabel(code, title, hint = '', tone = 'cool') {
    const decorate = toneDecorators[tone] || toneDecorators.cool;
    const lead = decorate(`${code}`);
    const suffix = hint ? `  ${pc.dim(hint)}` : '';
    return `${lead}  ${pc.bold(title)}${suffix}`;
}

// Premium horizontal divider with optional label
export function sectionRule(label = '', style = 'normal') {
    const g = terminalGlyphs();
    const baseWidth = clamp((process.stdout.columns || 84) - 4, 32, 84);
    
    if (style === 'thick') {
        if (!label) return brandTheme('═'.repeat(baseWidth));
        const plainLabel = stripAnsi(label);
        const sideWidth = Math.max(4, Math.floor((baseWidth - plainLabel.length - 4) / 2));
        return pc.blue(pc.dim('═'.repeat(sideWidth))) + `  ${label}  ` + pc.blue(pc.dim('═'.repeat(sideWidth)));
    }

    if (style === 'dots') {
        if (!label) return pc.dim('• '.repeat(Math.floor(baseWidth / 2)));
        const plainLabel = stripAnsi(label);
        const sideWidth = Math.max(4, Math.floor((baseWidth - plainLabel.length - 4) / 4));
        return pc.dim('• '.repeat(sideWidth)) + `  ${label}  ` + pc.dim('• '.repeat(sideWidth));
    }

    if (!label) return pc.dim(`┈${g.line.repeat(Math.max(0, baseWidth - 2))}┈`);
    const plainLabel = stripAnsi(label);
    const sideWidth = Math.max(4, Math.floor((baseWidth - plainLabel.length - 4) / 2));
    return pc.dim(g.line.repeat(sideWidth)) + `  ${label}  ` + pc.dim(g.line.repeat(sideWidth));
}

export function wrapAnsiText(text = '', width = 78) {
    const source = String(text).replace(/\r/g, '');
    const rawLines = source.split('\n');
    const output = [];

    for (const rawLine of rawLines) {
        if (!rawLine.trim()) { output.push(''); continue; }
        const indentMatch = rawLine.match(/^\s+/);
        const indent = indentMatch ? indentMatch[0] : '';
        const words = rawLine.trim().split(/\s+/);
        let current = indent;

        for (const word of words) {
            const candidate = current.trim().length ? `${current} ${word}` : `${indent}${word}`;
            if (visibleLength(candidate) <= width) { current = candidate; continue; }
            if (current.trim().length) output.push(current);
            if (visibleLength(word) > width) {
                let remaining = word;
                while (visibleLength(remaining) > width) {
                    output.push(remaining.slice(0, width));
                    remaining = remaining.slice(width);
                }
                current = `${indent}${remaining}`;
            } else {
                current = `${indent}${word}`;
            }
        }
        output.push(current);
    }
    return output;
}

// Premium unboxed container with full-width aesthetics
export function renderFrame(title, lines = [], options = {}) {
    const cols = process.stdout.columns || 80;
    const tone = toneDecorators[options.tone] || toneDecorators.brand;
    const icon = options.icon || '';
    const body = Array.isArray(lines) ? lines : String(lines).split('\n');
    const wrappedBody = body.flatMap((line) => wrapAnsiText(line, cols - 6));

    const bg = tone === toneDecorators.danger ? '\x1b[48;2;45;20;20m' :
               tone === toneDecorators.warning ? '\x1b[48;2;45;35;15m' :
               tone === toneDecorators.success ? '\x1b[48;2;15;35;25m' :
               '\x1b[48;2;20;25;35m'; // Default slate/brand
    const reset = '\x1b[0m';
    const rows = [];

    rows.push('');
    const titleCaps = String(title).toUpperCase();
    const titleText = icon ? `${icon}  ${tone(pc.bold(titleCaps))}` : tone(pc.bold(titleCaps));
    
    // Header
    rows.push(`${bg}${padAnsi(`  ${titleText}`, cols)}${reset}`);
    rows.push(`${bg}${padAnsi(`  ${pc.dim('─'.repeat(Math.min(cols - 4, titleCaps.length + 6)))}`, cols)}${reset}`);

    if (wrappedBody.length) {
        for (const line of wrappedBody) {
            rows.push(`${bg}${padAnsi(`  ${line}`, cols)}${reset}`);
        }
    }

    if (options.footer) {
        rows.push(`${bg}${padAnsi('', cols)}${reset}`);
        rows.push(`${bg}${padAnsi(`  ${pc.dim(options.footer)}`, cols)}${reset}`);
    }

    rows.push(`${bg}${padAnsi('', cols)}${reset}`);
    return rows.join('\n');
}

// Premium hero panel for startup splash
export function renderHeroPanel({ eyebrow, title, subtitle, stats = [], tone = 'brand' }) {
    const lines = [];
    if (eyebrow) lines.push(pc.dim(eyebrow));
    if (subtitle) lines.push(pc.dim(subtitle));
    if (stats.length) {
        lines.push('');
        lines.push(stats.map((s) => `${pc.dim(`${s.label}:`)} ${s.value}`).join('    '));
    }
    return renderFrame(title, lines, { tone, icon: emoji.rex });
}

export async function playTerminalSplash({ hero, panels = [], delay = 50 }) {
    if (hero) console.log(renderHeroPanel(hero));
    for (const panel of panels) {
        await sleep(delay);
        console.log(`\n${renderFrame(panel.title, panel.lines, panel)}`);
    }
}

// ── Premium status line (for tool progress / planner updates) ──
export function statusLine(icon, label, detail = '', tone = 'muted') {
    const decorate = toneDecorators[tone] || toneDecorators.muted;
    const detailStr = detail ? ` ${pc.dim('::')} ${pc.dim(detail)}` : '';
    return `  ${decorate(`${icon} ${label}`)}${detailStr}`;
}

// ── Compact key-value row ──
export function kvRow(key, value, icon = '') {
    const prefix = icon ? `${icon} ` : pc.dim('∙ ');
    return `${prefix}${pc.dim(`${key}:`)} ${pc.white(value)}`;
}