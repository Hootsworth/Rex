import * as p from '@clack/prompts';
import pc from 'picocolors';
import gradient from 'gradient-string';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const theme = gradient(['#8b00ff', '#4b0082', '#0000ff', '#00ff00', '#ffff00', '#ff7f00', '#ff0000']);
const REX_PERSONA = pc.magenta('Rex (Intern)');

export async function autoFixProject() {
    console.clear();
    p.intro(theme('🦖 RexAI Auto-Fix Agent'));

    const s = p.spinner();
    s.start(pc.magenta('Rex is analyzing the project directory...'));

    const cwd = process.cwd();
    const files = fs.readdirSync(cwd);
    
    // 1. Detect Stack
    let language = 'Unknown';
    let framework = 'None detected';
    
    if (files.includes('package.json')) {
        language = 'Node.js (JavaScript/TypeScript)';
        const pkgStr = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
        try {
            const pkg = JSON.parse(pkgStr);
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps['express']) framework = 'Express';
            if (deps['react'] || deps['next']) framework = 'React/Next.js';
            if (deps['@nestjs/core']) framework = 'NestJS';
        } catch(e){}
    } else if (files.includes('requirements.txt') || files.includes('Pipfile') || files.includes('pyproject.toml') || files.find(f => f.endsWith('.py'))) {
        language = 'Python';
        if (files.find(f => f.includes('django'))) framework = 'Django';
        if (files.find(f => f.includes('main.py') || f.includes('app.py'))) framework = 'Generic Python Script / Flask / FastAPI';
    } else if (files.includes('go.mod')) {
        language = 'Go';
    } else if (files.includes('Cargo.toml')) {
        language = 'Rust';
    } else if (files.includes('pom.xml') || files.includes('build.gradle')) {
        language = 'Java';
    }

    // 2. Detect Issues
    const issues = [];
    const fixesToOffer = [];

    if (!files.includes('Dockerfile')) {
        issues.push('No Dockerfile available for containerization.');
        fixesToOffer.push({ value: 'dockerfile', label: '🐳 Generate a Dockerfile for this stack' });
    }

    if (!files.includes('README.md')) {
        issues.push('README.md is missing. Project has no documentation.');
        fixesToOffer.push({ value: 'readme', label: '📄 Generate comprehensive README.md' });
    }

    if (!fs.existsSync(path.join(cwd, '.github', 'workflows'))) {
        issues.push('No GitHub Actions CI/CD workflows detected.');
        fixesToOffer.push({ value: 'ci', label: '⚙️  Setup GitHub Actions testing/linting CI workflow' });
    }
    
    // Super fast arbitrary delay to sell the "agent thinking" illusion
    await new Promise(r => setTimeout(r, 1500));
    s.stop(pc.green('Analysis Complete.'));

    // Output Project Summary
    p.note(`Language: ${pc.cyan(language)}\nFramework: ${pc.cyan(framework)}\nTotal Root Files: ${pc.cyan(files.length)}\n\n${pc.red('Issues Detected:')}\n${issues.length ? issues.map(i => `- ${i}`).join('\n') : pc.green('- None! Perfect repo!')}`, 'Project Summary');

    if (fixesToOffer.length === 0) {
        p.outro(theme('Rex: Everything looks great. Nothing to fix!'));
        return;
    }

    const selectedFixes = await p.multiselect({
        message: 'Rex: I found some missing pieces. Want me to fix them automatically?',
        options: fixesToOffer,
        required: false
    });

    if (p.isCancel(selectedFixes) || selectedFixes.length === 0) {
        p.outro(pc.dim('Rex: Okay, ignoring issues for now.'));
        return;
    }

    // 3. Execute Fixes
    for (const fix of selectedFixes) {
        const fixStart = p.spinner();
        fixStart.start(pc.magenta(`Rex is resolving: ${fix}...`));
        try {
            await applyFix(fix, cwd, language, framework);
            fixStart.stop(pc.green(`✔ Resolved: ${fix}`));
        } catch (err) {
            fixStart.stop(pc.red(`❌ Failed to resolve ${fix}: ${err.message}`));
        }
    }

    p.outro(theme('Rex: Auto-Fix complete. You owe me a coffee!'));
}

async function applyFix(fixType, cwd, language, framework) {
    const { runCompletion } = await import('./ai.js');
    
    if (fixType === 'dockerfile') {
        const prompt = `Write a production-ready, highly optimized Dockerfile for a ${language} project using ${framework}. 
Return strictly the Dockerfile content. No markdown formatting, no explanations. Just the raw text.`;
        const content = await runCompletion(prompt);
        // Stripping markdown codeblocks if they sneak in
        const cleanContent = content.replace(/^```[a-z]*\n|```$/gm, '').trim();
        fs.writeFileSync(path.join(cwd, 'Dockerfile'), cleanContent);
        
        // Also write a .dockerignore if missing
        if (!fs.existsSync(path.join(cwd, '.dockerignore'))) {
            fs.writeFileSync(path.join(cwd, '.dockerignore'), 'node_modules\n.git\n.env\n__pycache__\ntarget\n');
        }

    } else if (fixType === 'readme') {
        // We will grab the package.json or main logic to give AI context
        let extraContext = '';
        if (fs.existsSync(path.join(cwd, 'package.json'))) {
            extraContext = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
        } else if (fs.existsSync(path.join(cwd, 'main.py'))) {
            extraContext = fs.readFileSync(path.join(cwd, 'main.py'), 'utf8').substring(0, 1000); // 1st 1000 chars
        }

        const prompt = `Write a beautiful, detailed, professional README.md for a ${language} project using ${framework}.
Here is some context file logic/metadata to help you understand the project:
---
${extraContext}
---
Include sections for Overview, Installation, Usage, and Project Structure. Use emojis.
Return strictly the markdown text. No chat responses.`;
        
        const content = await runCompletion(prompt);
        fs.writeFileSync(path.join(cwd, 'README.md'), content.trim());
        
    } else if (fixType === 'ci') {
        const githubDir = path.join(cwd, '.github', 'workflows');
        fs.mkdirSync(githubDir, { recursive: true });
        
        const prompt = `Write a simple GitHub Actions CI workflow (ci.yml) that tests a ${language} project on push to main and pull requests.
Return strictly the YAML content. No markdown formatting, no explanations.`;
        
        const content = await runCompletion(prompt);
        const cleanContent = content.replace(/^```[a-z]*\n|```$/gm, '').trim();
        fs.writeFileSync(path.join(githubDir, 'ci.yml'), cleanContent);
    }
}
