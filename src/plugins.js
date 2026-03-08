import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import gradient from 'gradient-string';

const theme = gradient(['#00008b', '#00ffff']);

export async function runPlugins() {
    const pluginDir = path.join(process.cwd(), '.rex', 'scripts');

    if (!fs.existsSync(pluginDir)) {
        p.log.warn('No custom plugins found.');
        p.note(`To add a plugin, create a JS file in ${pc.cyan('./.rex/scripts/')}.`, 'Rex Customization');
        return;
    }

    const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));

    if (files.length === 0) {
        p.log.warn('No JS/MJS plugin files found in ./.rex/scripts/.');
        return;
    }

    const pluginChoice = await p.select({
        message: 'Select a custom plugin to run:',
        options: files.map(f => ({ value: f, label: `🔌 ${f}` }))
    });

    if (p.isCancel(pluginChoice)) return;

    const s = p.spinner();
    s.start(`Executing plugin: ${pc.cyan(pluginChoice)}...`);

    try {
        const fullPath = path.join(pluginDir, pluginChoice);
        // Using file:// URL for dynamic import on Windows
        const plugin = await import(`file://${fullPath}`);

        if (typeof plugin.default === 'function') {
            s.stop('Plugin initialized.');
            await plugin.default();
            p.log.success(theme(`${pluginChoice} execution complete.`));
        } else {
            s.stop(pc.red('Plugin failed.'));
            p.log.error(`Plugin ${pluginChoice} does not export a default function.`);
        }

    } catch (err) {
        s.stop(pc.red('Plugin execution failed.'));
        p.log.error(err.message);
    }
}
