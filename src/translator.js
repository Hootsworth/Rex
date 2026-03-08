import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import { runCompletion } from './ai.js';
import gradient from 'gradient-string';

export async function aiFileTranslator() {
    const srcPathRaw = await p.text({
        message: 'Path to the source file to translate:',
        validate: (val) => {
            const cleanVal = val.replace(/^["']|["']$/g, '');
            if (!fs.existsSync(cleanVal)) return 'File not found.';
            if (!fs.statSync(cleanVal).isFile()) return 'Must be a file, not a directory.';
        }
    });

    if (p.isCancel(srcPathRaw)) return;
    const srcPath = srcPathRaw.replace(/^["']|["']$/g, '');

    const targetLang = await p.text({
        message: 'What language should this be translated to? (e.g., Python, Rust, Go, TypeScript)',
        validate: (val) => {
            if (val.trim() === '') return 'Language is required.';
        }
    });

    if (p.isCancel(targetLang)) return;

    let defaultOut = path.parse(srcPath).name + '_translated.txt';
    const outPath = await p.text({
        message: `Output file path:`,
        initialValue: defaultOut
    });

    if (p.isCancel(outPath)) return;

    const s = p.spinner();
    s.start(`Translating ${pc.cyan(srcPath)} to ${pc.green(targetLang)}...`);

    try {
        const fileContent = fs.readFileSync(srcPath, 'utf8');

        const systemPrompt = `You are an expert polyglot software engineer.
Translate the following code strictly into ${targetLang}.
DO NOT include markdown code blocks. DO NOT provide explanations. ONLY output the raw translated code content that can be saved directly to a file. Keep the same core logic and variable names where appropriate.`;

        const userPrompt = `${systemPrompt}\n\nSource Code:\n${fileContent}`;

        let translatedData = await runCompletion(userPrompt, true);

        // Final cleanup in case the LLM ignored strict instructions
        translatedData = translatedData.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();

        fs.writeFileSync(outPath, translatedData, 'utf8');

        s.stop(`Successfully translated to ${pc.cyan(outPath)}!`);
        p.log.success(gradient.pastel(`File translation complete.`));

    } catch (e) {
        s.stop(pc.red('Translation failed.'));
        p.log.error(e.message);
    }
}
