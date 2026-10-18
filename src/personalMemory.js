import fs from 'fs';
import path from 'path';
import os from 'os';
import pc from 'picocolors';

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.power-cli');
const MEMORY_DIR = path.join(GLOBAL_CONFIG_DIR, 'memory');
const GRAPH_FILE = path.join(MEMORY_DIR, 'knowledge_graph.json');
const LOG_FILE = path.join(MEMORY_DIR, 'episodic_log.jsonl');

const DEFAULT_GRAPH = {
    user: {
        name: 'Aditya',
        role: 'Master / Lead Architect',
        preferences: {
            model: 'gemini-3.5-flash',
            demeanor: 'executive butler (JARVIS / Alfred)',
            theme: 'dark'
        },
        attributes: {
            location: 'Mysore',
            timezone: 'Asia/Kolkata'
        },
        facts: [
            'Primary developer of Rex (power-cli) and Web Agent Architect',
            'Prefers concise, actionable responses with minimal fluff',
            'Uses Google Gemini 3.5 Flash and Cartesia TTS voice'
        ]
    },
    projects: {
        'power-cli': {
            name: 'power-cli (Rex)',
            type: 'Executive Agentic CLI & Butler',
            stack: ['Node.js', 'Discord.js', 'Cartesia', 'Gemini']
        },
        'web-agent-extension': {
            name: 'Web Agent Architect',
            type: 'Frontier Set-of-Marks In-Browser Chrome Extension',
            stack: ['Manifest V3', 'CDP', 'SoM Canvas Overlay']
        }
    },
    entities: {},
    relations: [],
    updatedAt: new Date().toISOString()
};

function ensureMemoryStore() {
    if (!fs.existsSync(MEMORY_DIR)) {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    if (!fs.existsSync(GRAPH_FILE)) {
        fs.writeFileSync(GRAPH_FILE, JSON.stringify(DEFAULT_GRAPH, null, 2), 'utf8');
    }
}

export function loadKnowledgeGraph() {
    ensureMemoryStore();
    try {
        const raw = fs.readFileSync(GRAPH_FILE, 'utf8');
        return { ...DEFAULT_GRAPH, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_GRAPH;
    }
}

export function saveKnowledgeGraph(graph) {
    ensureMemoryStore();
    graph.updatedAt = new Date().toISOString();
    fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2), 'utf8');
}

/**
 * Add an episodic memory entry
 */
export function logEpisodicEvent(category, summary, metadata = {}) {
    ensureMemoryStore();
    const entry = {
        timestamp: new Date().toISOString(),
        category,
        summary,
        metadata
    };
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
}

/**
 * Add a fact to the personal dossier
 */
export function rememberFact(fact) {
    if (!fact || !String(fact).trim()) return;
    const cleanFact = String(fact).trim();
    const graph = loadKnowledgeGraph();
    
    if (!graph.user.facts.includes(cleanFact)) {
        graph.user.facts.push(cleanFact);
        saveKnowledgeGraph(graph);
        logEpisodicEvent('fact_remembered', cleanFact);
    }
    return `Rex has committed this to memory, sir: "${cleanFact}"`;
}

/**
 * Remove facts containing keyword
 */
export function forgetFact(keyword) {
    if (!keyword) return;
    const cleanKw = String(keyword).toLowerCase().trim();
    const graph = loadKnowledgeGraph();
    const beforeCount = graph.user.facts.length;
    graph.user.facts = graph.user.facts.filter(f => !f.toLowerCase().includes(cleanKw));
    saveKnowledgeGraph(graph);
    const removedCount = beforeCount - graph.user.facts.length;
    return `Removed ${removedCount} memory entr${removedCount === 1 ? 'y' : 'ies'} mentioning "${keyword}".`;
}

/**
 * Set user preference key-value pair
 */
export function setUserPreference(key, value) {
    const graph = loadKnowledgeGraph();
    graph.user.preferences[key] = value;
    saveKnowledgeGraph(graph);
    logEpisodicEvent('preference_updated', `${key} = ${value}`);
    return `Preference updated: ${key} = ${value}`;
}

/**
 * Automatically extract facts, preferences, and corrections from conversation text.
 * Runs autonomously on every turn without requiring explicit !remember syntax.
 */
export function extractMemoriesFromText(text) {
    if (!text || typeof text !== 'string' || text.length < 5) return [];
    const extracted = [];
    const t = String(text).trim();

    // 1. Explicit "remember that..." or "remember: ..."
    const rememberMatch = t.match(/remember(?:\s+that)?[:\s]+([^.!\n]+)/i);
    if (rememberMatch) {
        extracted.push(rememberMatch[1].trim());
    }

    // 2. Positive preferences: "I prefer / like / love / always use X"
    const preferMatch = t.match(/\bI\s+(?:prefer|like|love|always\s+use|enjoy)\s+([^.!\n,;]+)/i);
    if (preferMatch) {
        extracted.push(`User prefers: ${preferMatch[1].trim()}`);
    }

    // 3. Negative preferences & constraints: "I hate / dislike / don't like X", "Never do X", "Don't ever X"
    const dislikeMatch = t.match(/\bI\s+(?:hate|dislike|don't\s+like|detest)\s+([^.!\n,;]+)/i);
    if (dislikeMatch) {
        extracted.push(`User dislikes: ${dislikeMatch[1].trim()}`);
    }
    const ruleMatch = t.match(/\b(?:never|don't\s+ever|do\s+not\s+ever)\s+([^.!\n,;]+)/i);
    if (ruleMatch) {
        extracted.push(`User rule: Never ${ruleMatch[1].trim()}`);
    }

    // 4. Identity & Name: "My name is X" / "Call me X"
    const nameMatch = t.match(/(?:my\s+name\s+is|call\s+me)\s+([A-Z][a-zA-Z0-9_-]+)/i);
    if (nameMatch) {
        const graph = loadKnowledgeGraph();
        graph.user.name = nameMatch[1].trim();
        saveKnowledgeGraph(graph);
        extracted.push(`User's name is ${nameMatch[1].trim()}`);
    }

    // 5. Role & Profession: "I am a / an [Role]" / "I work as [Role]"
    const roleMatch = t.match(/\bI\s+(?:am\s+a|am\s+an|work\s+as\s+a|work\s+as\s+an)\s+([A-Za-z\s]+?)(?:\s+(?:at|for|with)|[.!,;]|$)/i);
    if (roleMatch && roleMatch[1].length < 40) {
        const role = roleMatch[1].trim();
        if (!['user', 'person', 'human', 'student'].includes(role.toLowerCase())) {
            extracted.push(`User role: ${role}`);
        }
    }

    // 6. Location: "I live in X" / "I'm located in X" / "I'm based in X"
    const locationMatch = t.match(/\bI(?:'m|\s+am)?\s+(?:live\s+in|located\s+in|based\s+in)\s+([A-Za-z\s,]+?)(?:[.!,;]|$)/i);
    if (locationMatch && locationMatch[1].length < 50) {
        const loc = locationMatch[1].trim();
        const graph = loadKnowledgeGraph();
        if (!graph.user.attributes) graph.user.attributes = {};
        graph.user.attributes.location = loc;
        saveKnowledgeGraph(graph);
        extracted.push(`User location: ${loc}`);
    }

    // 7. Tech Stack & Tools: "My tech stack is X", "My favorite tool / language / editor is X"
    const favMatch = t.match(/(?:my\s+favorite|my\s+preferred)\s+(tool|language|editor|framework|model|app)\s+is\s+([^.!\n,;]+)/i);
    if (favMatch) {
        extracted.push(`Favorite ${favMatch[1]}: ${favMatch[2].trim()}`);
    }

    // 8. Corrections & Overrides: "No, actually [fact]" / "Correction: [fact]" / "From now on, [rule]"
    const correctionMatch = t.match(/(?:no,\s*actually|correction:|from\s+now\s+on,?\s*)([^.!\n]+)/i);
    if (correctionMatch) {
        extracted.push(`Learned rule: ${correctionMatch[1].trim()}`);
    }

    // Commit deduplicated facts
    const graph = loadKnowledgeGraph();
    const existingFacts = (graph.user.facts || []).map(f => f.toLowerCase());
    const newlyAdded = [];

    for (const f of extracted) {
        const cleanF = f.trim();
        if (cleanF.length < 4) continue;
        const lower = cleanF.toLowerCase();
        const isDuplicate = existingFacts.some(ef => ef.includes(lower) || lower.includes(ef));
        if (!isDuplicate) {
            rememberFact(cleanF);
            newlyAdded.push(cleanF);
        }
    }

    return newlyAdded;
}

/**
 * Build an executive Butler Dossier string to inject into any agent system prompt
 */
export function getButlerDossier(queryText = '') {
    const graph = loadKnowledgeGraph();
    const user = graph.user || {};
    const prefs = user.preferences || {};
    const facts = user.facts || [];
    const projects = graph.projects || {};

    const projectList = Object.keys(projects)
        .map(k => `${projects[k].name || k} (${projects[k].type || ''})`)
        .join(', ');

    const dossierLines = [
        `[ALFRED'S DOSSIER ON USER]`,
        `* Name: ${user.name || 'Aditya'}`,
        `* Location: ${user.attributes?.location || 'Mysore'}`,
        `* Preferred Model: ${prefs.model || 'gemini-3.5-flash'}`,
        `* Active Projects: ${projectList || 'power-cli'}`,
        `* Key Facts & Preferences:`
    ];

    for (const fact of facts.slice(-10)) {
        dossierLines.push(`  - ${fact}`);
    }

    return dossierLines.join('\n');
}
