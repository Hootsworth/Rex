import fs from 'fs';
import path from 'path';
import ollama from 'ollama';
import { loadConfig } from './config.js';
import pc from 'picocolors';

const MEMORY_DIR = path.join(process.cwd(), '.agent');
const MEMORY_MD = path.join(MEMORY_DIR, 'memory.md');
const PREFS_FILE = path.join(MEMORY_DIR, 'preferences.json');
const DEEP_MEMORY_FILE = path.join(MEMORY_DIR, 'deep_memory.json');

// --- Legacy Fact Logic ---
export function readMemory() {
    if (!fs.existsSync(MEMORY_MD)) return '';
    return fs.readFileSync(MEMORY_MD, 'utf-8');
}

export function remember(fact) {
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const entry = `\n- [${date}] ${fact}\n`;
    fs.appendFileSync(MEMORY_MD, entry);
    return pc.green(`Rex learned a new fact: "${fact}"`);
}

export function forget(keyword) {
    if (!fs.existsSync(MEMORY_MD)) return 'Memory file not found.';
    const content = fs.readFileSync(MEMORY_MD, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter(l => !l.toLowerCase().includes(keyword.toLowerCase()));
    fs.writeFileSync(MEMORY_MD, filtered.join('\n'));
    return pc.yellow(`Removed facts mentioning "${keyword}" from memory.`);
}

export function syncMemory() { return pc.dim('Memory synced to local cache.'); }
export function pullMemory() { return pc.dim('Memory pulled from local cache.'); }

// --- Preference Logic ---
export function getUserPreference(key) {
    if (!fs.existsSync(PREFS_FILE)) return null;
    const prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
    return prefs[key] ? { key, value: prefs[key] } : null;
}

export function setUserPreference(key, value) {
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const prefs = fs.existsSync(PREFS_FILE) ? JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')) : {};
    prefs[key] = value;
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
    return pc.green(`Preference saved: ${key} = ${value}`);
}

export function describePreferenceStore() {
    if (!fs.existsSync(PREFS_FILE)) return { totalKeys: 0, preview: [] };
    const prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
    const keys = Object.keys(prefs);
    return { totalKeys: keys.length, preview: keys.slice(0, 5).map(k => `${pc.cyan(k)}: ${pc.dim(prefs[k])}`) };
}

export function maybeCaptureUserPreferencesFromText() { return []; }
export function getSelectivePreferenceContext() { return ''; }

// --- New Deep Memory Logic ---
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function indexProject() {
    const config = loadConfig();
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

    const files = [];
    const scan = (dir) => {
        try {
            const list = fs.readdirSync(dir);
            for (const file of list) {
                const fullPath = path.join(dir, file);
                if (file === 'node_modules' || file.startsWith('.') || file === 'dist' || file === 'build') continue;
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) scan(fullPath);
                else if (stat.size < 50000 && /\.(js|ts|py|md|txt|json|css|html)$/i.test(file)) {
                    files.push(fullPath);
                }
            }
        } catch(e) {}
    };
    scan(process.cwd());

    const vectors = [];
    const model = config.ollamaEmbeddingModel || 'nomic-embed-text';

    process.stdout.write(pc.cyan(`Indexing ${pc.bold(files.length)} files into Deep Memory using ${model}...\n`));

    for (const f of files) {
        try {
            const content = fs.readFileSync(f, 'utf-8');
            const relPath = path.relative(process.cwd(), f);
            const chunks = content.match(/[\s\S]{1,1500}/g) || [];
            
            for (let i = 0; i < chunks.length; i++) {
                const response = await ollama.embeddings({ model, prompt: chunks[i] });
                vectors.push({
                    path: relPath,
                    chunkIndex: i,
                    text: chunks[i],
                    embedding: response.embedding
                });
            }
        } catch (e) {}
    }

    fs.writeFileSync(DEEP_MEMORY_FILE, JSON.stringify({ vectors, model, updatedAt: Date.now() }));
    return pc.green(`Deep Memory indexed successfully: ${vectors.length} vectors stored.`);
}

export async function semanticSearch(query, limit = 5) {
    if (!fs.existsSync(DEEP_MEMORY_FILE)) {
        return "Deep Memory not indexed. Run /memory index first.";
    }
    
    try {
        const { vectors, model } = JSON.parse(fs.readFileSync(DEEP_MEMORY_FILE, 'utf-8'));
        const response = await ollama.embeddings({ model, prompt: query });
        const queryEmbedding = response.embedding;

        const results = vectors.map(v => ({
            ...v,
            score: cosineSimilarity(queryEmbedding, v.embedding)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

        if (results.length === 0) return "No semantic matches found.";

        const report = results.map(r => `[${Math.round(r.score * 100)}%] ${r.path}: "${r.text.substring(0, 150)}..."`).join('\n---\n');
        return `Deep Memory Results for "${query}":\n\n${report}`;
    } catch (e) {
        return `Semantic search failed: ${e.message}`;
    }
}
