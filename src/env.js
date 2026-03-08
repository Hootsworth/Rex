import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import gradient from 'gradient-string';

const theme = gradient(['#00008b', '#00ffff']);

export async function generateEnvExample() {
    const s = p.spinner();
    s.start('Generating .env.example...');

    try {
        if (!fs.existsSync('.env')) {
            s.stop('No .env file found.');
            p.log.error('Please create a .env file first.');
            return;
        }

        const lines = fs.readFileSync('.env', 'utf8').split('\n');
        const redactedLines = lines.map(line => {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) return line;

            const [key, ...rest] = line.split('=');
            if (rest.length === 0) return line;

            return `${key}=your_${key.toLowerCase()}_here`;
        });

        fs.writeFileSync('.env.example', redactedLines.join('\n'));

        s.stop('Successfully generated .env.example! 🔐');
        p.log.success(theme('All secrets have been redacted from the example file.'));
        p.note('You can now safely commit .env.example to your repository.', 'Rex Security Tip');

    } catch (err) {
        s.stop(pc.red('Failed to generate example file.'));
        p.log.error(err.message);
    }
}
