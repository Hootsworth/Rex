import fs from 'fs';
import path from 'path';

const AGENT_DIR = path.join(process.cwd(), '.agent');
const INDEX_FILE = path.join(AGENT_DIR, 'index.json');

// File extensions grouped by language
const LANG_MAP = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript',
    '.jsx': 'React JSX',
    '.py': 'Python',
    '.rb': 'Ruby',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.swift': 'Swift',
    '.cs': 'C#',
    '.cpp': 'C++', '.cc': 'C++', '.c': 'C',
    '.php': 'PHP',
    '.vue': 'Vue',
    '.svelte': 'Svelte',
    '.html': 'HTML',
    '.css': 'CSS', '.scss': 'SCSS', '.less': 'LESS',
    '.json': 'JSON',
    '.yaml': 'YAML', '.yml': 'YAML',
    '.md': 'Markdown',
    '.sql': 'SQL',
    '.sh': 'Shell', '.bash': 'Shell',
    '.ps1': 'PowerShell',
    '.dockerfile': 'Docker', 
};

const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out',
    '__pycache__', '.venv', 'venv', '.env', 'vendor', 'coverage',
    '.agent', '.vscode', '.idea', 'target', 'bin', 'obj'
]);

/**
 * Scans the project directory and builds a lightweight index
 * @param {string} rootDir - The project root (typically cwd)
 * @returns {object} The project index
 */
export function indexProject(rootDir = process.cwd()) {
    const index = {
        root: rootDir,
        indexedAt: new Date().toISOString(),
        totalFiles: 0,
        totalDirs: 0,
        languages: {},
        frameworks: [],
        entryPoints: [],
        configFiles: [],
        fileTree: []
    };

    // Walk directory
    walkDir(rootDir, '', index, 0);

    // Detect frameworks from config files and deps
    index.frameworks = detectFrameworks(rootDir);

    // Save to .agent/index.json
    try {
        if (!fs.existsSync(AGENT_DIR)) fs.mkdirSync(AGENT_DIR, { recursive: true });
        fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
    } catch (e) { /* can't save — not critical */ }

    return index;
}

function walkDir(dir, relativePath, index, depth) {
    if (depth > 5) return; // Max depth

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
            if (IGNORE_DIRS.has(entry.name)) continue;

            const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                index.totalDirs++;
                if (depth < 3) index.fileTree.push(`📁 ${rel}/`);
                walkDir(path.join(dir, entry.name), rel, index, depth + 1);
            } else if (entry.isFile()) {
                index.totalFiles++;
                const ext = path.extname(entry.name).toLowerCase();
                const lang = LANG_MAP[ext];
                if (lang) {
                    index.languages[lang] = (index.languages[lang] || 0) + 1;
                }

                // Track config files
                const configNames = ['package.json', 'tsconfig.json', 'webpack.config.js', 'vite.config.js',
                    'next.config.js', '.eslintrc.json', 'Dockerfile', 'docker-compose.yml',
                    'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml'];
                if (configNames.includes(entry.name)) {
                    index.configFiles.push(rel);
                }

                // Track entry points
                const entryNames = ['index.js', 'main.js', 'app.js', 'server.js', 'main.py', 'app.py', 'main.go'];
                if (entryNames.includes(entry.name) && depth <= 2) {
                    index.entryPoints.push(rel);
                }

                if (depth < 3) index.fileTree.push(`  ${rel}`);
            }
        }
    } catch (e) { /* permission errors, etc */ }
}

function detectFrameworks(rootDir) {
    const frameworks = [];
    try {
        const pkgPath = path.join(rootDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            if (allDeps['next']) frameworks.push('Next.js');
            if (allDeps['react']) frameworks.push('React');
            if (allDeps['vue']) frameworks.push('Vue');
            if (allDeps['svelte']) frameworks.push('Svelte');
            if (allDeps['express']) frameworks.push('Express');
            if (allDeps['fastify']) frameworks.push('Fastify');
            if (allDeps['nestjs'] || allDeps['@nestjs/core']) frameworks.push('NestJS');
            if (allDeps['tailwindcss']) frameworks.push('Tailwind CSS');
            if (allDeps['prisma'] || allDeps['@prisma/client']) frameworks.push('Prisma');
            if (allDeps['mongoose']) frameworks.push('Mongoose');
            if (allDeps['typescript']) frameworks.push('TypeScript');
            if (allDeps['vite']) frameworks.push('Vite');
            if (allDeps['webpack']) frameworks.push('Webpack');
            if (allDeps['jest']) frameworks.push('Jest');
            if (allDeps['vitest']) frameworks.push('Vitest');
        }

        if (fs.existsSync(path.join(rootDir, 'requirements.txt'))) frameworks.push('Python');
        if (fs.existsSync(path.join(rootDir, 'Cargo.toml'))) frameworks.push('Rust/Cargo');
        if (fs.existsSync(path.join(rootDir, 'go.mod'))) frameworks.push('Go Modules');
        if (fs.existsSync(path.join(rootDir, 'Dockerfile'))) frameworks.push('Docker');
    } catch (e) { /* non-critical */ }

    return frameworks;
}

/**
 * Loads a previously saved index, or returns null
 */
export function loadIndex() {
    try {
        if (fs.existsSync(INDEX_FILE)) {
            return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
        }
    } catch (e) { /* index doesn't exist yet */ }
    return null;
}

/**
 * Returns a compact string summary of the index for injecting into AI prompts
 */
export function getIndexSummary() {
    const index = loadIndex();
    if (!index) return '';

    const langs = Object.entries(index.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([lang, count]) => `${lang}(${count})`)
        .join(', ');

    return `[Project Index: ${index.totalFiles} files, ${index.totalDirs} dirs | Languages: ${langs} | Frameworks: ${index.frameworks.join(', ') || 'none'} | Entry: ${index.entryPoints.join(', ') || 'unknown'} | Configs: ${index.configFiles.join(', ')}]`;
}
