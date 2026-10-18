import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import gradient from 'gradient-string';

const theme = gradient(['#8b00ff', '#4b0082', '#0000ff', '#00ff00', '#ffff00', '#ff7f00', '#ff0000']);

export async function markdownToSlides() {
    const mdFile = await p.text({
        message: 'Path to your Markdown file (e.g., README.md):',
        validate: (val) => {
            if (!fs.existsSync(val)) return 'File not found.';
            if (!fs.statSync(val).isFile()) return 'Must be a file.';
        }
    });

    if (p.isCancel(mdFile)) return;

    const outPath = await p.text({
        message: 'Output HTML file path:',
        initialValue: 'slides.html'
    });

    if (p.isCancel(outPath)) return;

    const s = p.spinner();
    s.start('Generating presentation...');

    try {
        const mdContent = fs.readFileSync(mdFile, 'utf8');
        const slides = mdContent.split('---').map(s => s.trim());

        // Simple HTML slide deck template
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rex Presentation</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;600&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; background: #0f172a; color: white; font-family: 'Outfit', sans-serif; overflow: hidden; }
        .slides { display: flex; transition: transform 0.8s cubic-bezier(0.645, 0.045, 0.355, 1); height: 100vh; }
        .slide { min-width: 100vw; height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 40px; box-sizing: border-box; }
        h1 { font-size: 4rem; margin-bottom: 2rem; background: linear-gradient(90deg, #8b00ff, #4b0082, #0000ff, #00ff00, #ffff00, #ff7f00, #ff0000); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p, li { font-size: 1.5rem; line-height: 1.6; opacity: 0.8; }
        pre { background: #1e293b; padding: 20px; border-radius: 10px; text-align: left; max-width: 80%; overflow: auto; }
        .controls { position: fixed; bottom: 30px; right: 30px; display: flex; gap: 20px; }
        button { background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.2); color: white; padding: 10px 20px; border-radius: 30px; cursor: pointer; backdrop-filter: blur(10px); }
        button:hover { background: rgba(59, 130, 246, 0.2); border-color: #3b82f6; }
    </style>
</head>
<body>
    <div class="slides" id="slides">
        ${slides.map(slide => {
            // Basic parsing
            const lines = slide.split('\n');
            let content = lines.map(line => {
                if (line.startsWith('# ')) return `<h1>${line.replace('# ', '')}</h1>`;
                if (line.startsWith('## ')) return `<h2>${line.replace('## ', '')}</h2>`;
                if (line.startsWith('### ')) return `<h3>${line.replace('### ', '')}</h3>`;
                if (line.startsWith('- ')) return `<li>${line.replace('- ', '')}</li>`;
                return `<p>${line}</p>`;
            }).join('\n');
            return `<div class="slide">${content}</div>`;
        }).join('')}
    </div>
    <div class="controls">
        <button onclick="prev()">Previous</button>
        <button onclick="next()">Next</button>
    </div>
    <script>
        let current = 0;
        const total = ${slides.length};
        const slidesDiv = document.getElementById('slides');
        function update() { slidesDiv.style.transform = \`translateX(-\${current * 100}vw)\`; }
        function next() { if (current < total - 1) { current++; update(); } }
        function prev() { if (current > 0) { current--; update(); } }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === ' ') next();
            if (e.key === 'ArrowLeft') prev();
        });
    </script>
</body>
</html>`;

        fs.writeFileSync(outPath, html, 'utf8');

        s.stop(`Successfully generated presentation! 📊`);
        p.log.success(theme(`Presentation saved to ${pc.cyan(outPath)}.`));
        p.note('Open the file in your browser and use Arrow keys to navigate!', 'Rex Showcase');

    } catch (err) {
        s.stop(pc.red('Failed to generate presentation.'));
        p.log.error(err.message);
    }
}
