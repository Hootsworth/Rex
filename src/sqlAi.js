import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import { runCompletion } from './ai.js';
import gradient from 'gradient-string';

const theme = gradient(['#00008b', '#00ffff']);

export async function sqlAiGenerator() {
    const schemaFile = await p.text({
        message: 'Path to your SQL schema file (optional, press Enter to skip):',
        initialValue: ''
    });

    if (p.isCancel(schemaFile)) return;

    let schemaContent = '';
    if (schemaFile && fs.existsSync(schemaFile)) {
        schemaContent = fs.readFileSync(schemaFile, 'utf8');
    }

    const request = await p.text({
        message: 'What SQL query do you want to generate?',
        placeholder: 'e.g., Get the total revenue from orders in the last 30 days',
        validate: (val) => {
            if (val.trim() === '') return 'Request is required.';
        }
    });

    if (p.isCancel(request)) return;

    const s = p.spinner();
    s.start('Generating SQL query...');

    try {
        const systemPrompt = `You are an expert database administrator and SQL developer. 
Generate a clean, efficient SQL query based on the user's request.
${schemaContent ? `\nUse the following schema context:\n${schemaContent}` : '\nIf no schema is provided, assume standard SQL syntax.'}
ONLY output the raw SQL query. NO markdown. NO explanations.`;

        const userPrompt = `${systemPrompt}\n\nUser request: ${request}`;

        let sqlQuery = await runCompletion(userPrompt, true);
        sqlQuery = sqlQuery.replace(/```sql\n?/gi, '').replace(/```/g, '').trim();

        s.stop('SQL query generated!');

        p.note(pc.cyan(sqlQuery), 'Generated SQL');
        p.log.info(pc.dim('Tip: Copy this into your DB manager or Rex Terminal Gen!'));

    } catch (err) {
        s.stop(pc.red('Generation failed.'));
        p.log.error(err.message);
    }
}
