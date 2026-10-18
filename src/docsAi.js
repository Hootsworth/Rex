import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import { runCompletion } from './ai.js';
import gradient from 'gradient-string';

const theme = gradient('cyan', 'blue', 'magenta');

export async function docsAiGenerator(autoTopic = null, autoFileName = null) {
    let topic = autoTopic;
    if (!topic) {
        topic = await p.text({
            message: 'What document would you like to generate today?',
            placeholder: 'e.g., A minimalist company manifesto for a creative studio',
            validate: (val) => {
                if (val.trim() === '') return 'Topic is required.';
            }
        });
        if (p.isCancel(topic)) return;
    }

    let fileName = autoFileName;
    if (!fileName) {
        fileName = await p.text({
            message: 'Enter the output filename (HTML):',
            initialValue: 'document.html'
        });
        if (p.isCancel(fileName)) return;
    }

    const s = p.spinner();
    s.start('Rex is drafting your premium document...');

    try {
        let projectContext = '';
        try {
            const files = fs.readdirSync(process.cwd()).filter(f => !f.startsWith('.') && f !== 'node_modules').slice(0, 30);
            projectContext += `Project Files: ${files.join(', ')}\n`;
            if (fs.existsSync('package.json')) projectContext += `Package.json: ${fs.readFileSync('package.json', 'utf8').slice(0, 1500)}\n`;
            if (fs.existsSync('README.md')) projectContext += `README (snippet): ${fs.readFileSync('README.md', 'utf8').slice(0, 1500)}\n`;
            
            // Read some main source files if they exist to provide deeply accurate documentation
            const srcFiles = files.filter(f => f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.go')).slice(0, 3);
            for (const sf of srcFiles) {
                 projectContext += `\nFile ${sf}: ${fs.readFileSync(sf, 'utf8').slice(0, 1000)}`;
            }
        } catch(e) {}

        const systemPrompt = `You are a high-end creative copywriter and document designer.
Generate a professionally written, aesthetically pleasing document based on the user's topic.
Include sections like "Overview", "Core Values", or relevant professional categories.
Here is the raw context of the project this documentation is for:\n${projectContext}\n\nOutput ONLY the document content in plain text with clear headings marked as # and ##. 
NO markdown syntax beyond headings. NO conversational filler.`;

        const content = await runCompletion(`${systemPrompt}\n\nUser Request Topic: ${topic}`, true);

        // Split content for aesthetic parsing
        const lines = content.split('\n');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rex AI Document</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&family=Playfair+Display:ital,wght@0,700;1,700&display=swap" rel="stylesheet">
    <style>
        :root { --primary: #06b6d4; --secondary: #3b82f6; --accent: #a855f7; --bg: #ffffff; --text: #1e293b; }
        body { margin: 0; background: var(--bg); color: var(--text); font-family: 'Outfit', sans-serif; line-height: 1.8; padding: 100px 15%; }
        h1 { font-family: 'Playfair Display', serif; font-size: 4.5rem; line-height: 1.1; margin-bottom: 3rem; background: linear-gradient(90deg, var(--primary), var(--accent)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        h2 { font-size: 1.8rem; margin-top: 3.5rem; color: var(--secondary); letter-spacing: -0.02em; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; }
        p { font-size: 1.15rem; margin-bottom: 1.5rem; color: #475569; }
        .decoration { width: 60px; height: 4px; background: var(--primary); margin-bottom: 40px; }
        @media print { body { padding: 40px; } .no-print { display: none; } }
        .no-print { position: fixed; top: 20px; right: 20px; }
        button { background: #0f172a; color: white; border: none; padding: 10px 20px; border-radius: 30px; cursor: pointer; font-family: inherit; font-weight: 600; }
        button:hover { background: var(--secondary); }
    </style>
</head>
<body>
    <div class="no-print"><button onclick="window.print()">Save as PDF / Print</button></div>
    <div class="decoration"></div>
    <div class="content">
        ${lines.map(line => {
            if (line.startsWith('# ')) return `<h1>${line.replace('# ', '')}</h1>`;
            if (line.startsWith('## ')) return `<h2>${line.replace('## ', '')}</h2>`;
            if (line.trim() === '') return '';
            return `<p>${line}</p>`;
        }).join('\n')}
    </div>
</body>
</html>`;

        fs.writeFileSync(fileName, html, 'utf8');

        s.stop('Document generated successfully! ✨');
        p.log.success(theme(`${fileName} created.`));
        p.note('Open the HTML file in your browser to view the aesthetic layout and click "Save as PDF"!', 'Rex Creative');

    } catch (err) {
        s.stop(pc.red('Failed to generate document.'));
        p.log.error(err.message);
    }
}
