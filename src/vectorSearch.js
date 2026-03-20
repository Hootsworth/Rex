import fs from 'fs';
import path from 'path';
import { loadIndex } from './indexer.js';

const INDEX_CACHE_FILE = path.join(process.cwd(), '.agent', 'semantic_index.json');

// Stop words for lightweight tokenization
const STOP_WORDS = new Set(['the','and','a','to','of','in','i','is','that','it','on','you','this','for','but','with','are','have','be','at','or','as','was','so','if','out','not','function','const','let','var','return','import','export','from','class','true','false','null','undefined']);

function tokenize(text) {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function buildTfIdfIndex(rootDir) {
    const documents = [];
    const df = {}; // document frequency map

    const walkAndCollect = (dir) => {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'out', 'coverage'].includes(entry.name)) continue;
                
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walkAndCollect(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (!['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.md'].includes(ext)) {
                        continue; // Skip binaries and large assets
                    }

                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        if (content.length > 150000) continue; // Skip huge files
                        
                        const tokens = tokenize(content);
                        const termFreq = {};
                        tokens.forEach(t => { termFreq[t] = (termFreq[t] || 0) + 1; });
                        
                        Object.keys(termFreq).forEach(t => {
                            df[t] = (df[t] || 0) + 1;
                        });

                        documents.push({
                            file: path.relative(rootDir, fullPath),
                            termFreq,
                            totalTokens: tokens.length
                        });
                    } catch (e) { /* unreadable */ }
                }
            }
        } catch (e) { /* ignore */ }
    };

    walkAndCollect(rootDir);

    const index = {
        totalDocs: documents.length,
        df,
        documents
    };

    try {
        if (!fs.existsSync(path.dirname(INDEX_CACHE_FILE))) {
            fs.mkdirSync(path.dirname(INDEX_CACHE_FILE), { recursive: true });
        }
        fs.writeFileSync(INDEX_CACHE_FILE, JSON.stringify(index), 'utf-8');
    } catch (e) { /* ignorable */ }

    return index;
}

function loadOrBuildIndex() {
    try {
        if (fs.existsSync(INDEX_CACHE_FILE)) {
            const stats = fs.statSync(INDEX_CACHE_FILE);
            // Rebuild if older than 1 hour
            if (Date.now() - stats.mtimeMs < 60 * 60 * 1000) {
                return JSON.parse(fs.readFileSync(INDEX_CACHE_FILE, 'utf-8'));
            }
        }
    } catch (e) { /* ignore */ }
    
    return buildTfIdfIndex(process.cwd());
}

export async function semanticSearch(query) {
    const index = loadOrBuildIndex();
    if (!index || index.totalDocs === 0) return "Error: Project index is empty or unreadable.";

    const queryTokens = tokenize(query);
    if (!queryTokens.length) return "Query too vague, please provide specific keywords.";

    const scores = index.documents.map(doc => {
        let score = 0;
        for (const token of queryTokens) {
            const tf = doc.termFreq[token] || 0;
            if (tf > 0) {
                const idf = Math.log(index.totalDocs / (1 + (index.df[token] || 0)));
                score += (tf / doc.totalTokens) * idf;
            }
        }
        
        // Boost for filename matches
        const fileMatch = tokenize(doc.file);
        for (const t of queryTokens) {
            if (fileMatch.includes(t)) score += 0.5;
        }

        return { file: doc.file, score };
    });

    const topMatches = scores
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    if (topMatches.length === 0) {
        return `No semantic matches found for "${query}". Try different terminology.`;
    }

    const report = [];
    report.push(`🔍 Semantic Search Results for "${query}"`);
    for (const match of topMatches) {
        report.push(`Match: ${match.file} (Score: ${match.score.toFixed(4)})`);
        // We could extract snippets, but for brevity, returning the file helps the agent open it via read_file
    }

    return report.join('\n');
}
