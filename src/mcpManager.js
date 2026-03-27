import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import { loadConfig } from './config.js';

export async function mcpMenu() {
    const config = loadConfig();
    if (!config.mcpServers) config.mcpServers = {};

    while (true) {
        console.clear();
        const servers = Object.keys(config.mcpServers);
        
        const action = await p.select({
            message: pc.cyan('Productivity Suite (MCP) Manager'),
            options: [
                { value: 'list',   label: `List Active Servers (\${servers.length})` },
                { value: 'add',    label: 'Add New Connector (Notion, Google, etc.)' },
                { value: 'remove', label: 'Remove Connector' },
                { value: 'back',   label: pc.dim('  back') }
            ]
        });

        if (p.isCancel(action) || action === 'back') break;

        if (action === 'list') {
            if (servers.length === 0) {
                p.note('No MCP servers configured yet.', 'Productivity');
            } else {
                const list = servers.map(s => `  - \${pc.green(s)} (\${config.mcpServers[s].command})`).join('\n');
                p.note(list, 'Active Connectors');
            }
            await p.text({ message: 'Press Enter to continue...' });
        }

        if (action === 'add') {
            const type = await p.select({
                message: 'Select Connector Type:',
                options: [
                    { value: 'notion', label: 'Notion (@ramidecodes/mcp-server-notion)' },
                    { value: 'google', label: 'Google Drive/Calendar (mcp-server-google)' },
                    { value: 'custom', label: 'Custom Stdio Server' }
                ]
            });

            if (p.isCancel(type)) continue;

            let name = '';
            let command = '';
            let args = [];
            let env = {};

            if (type === 'notion') {
                name = 'notion';
                command = 'npx';
                const token = await p.password({ message: 'Notion Internal Integration Token:' });
                if (p.isCancel(token)) continue;
                args = ['-y', '@ramidecodes/mcp-server-notion'];
                env = { NOTION_TOKEN: token };
            } else if (type === 'google') {
                name = 'google';
                command = 'npx';
                args = ['-y', '@modelcontextprotocol/server-gdrive'];
                p.note('Note: Google Drive/Calendar requires OAuth setup. See MCP docs for details.', 'Auth');
            } else if (type === 'custom') {
                name = await p.text({ message: 'Server Name:' });
                command = await p.text({ message: 'Command (e.g. npx, node, python):' });
                const rawArgs = await p.text({ message: 'Args (space separated):' });
                args = rawArgs.split(' ').filter(Boolean);
            }

            if (name && command) {
                config.mcpServers[name] = { command, args, env };
                // Save config (usually config.js has a saveConfig but I'll do it manually if needed)
                // In this project, config is often just the object which might be saved on exit or manually.
                // I'll check for a saveConfig function.
                const configPath = path.join(process.env.USERPROFILE || process.env.HOME, '.power-cli', 'config.json');
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                p.note(`Added MCP server: \${name}`, 'Success');
            }
        }

        if (action === 'remove') {
            const toRemove = await p.select({
                message: 'Select server to remove:',
                options: servers.map(s => ({ value: s, label: s }))
            });
            if (!p.isCancel(toRemove)) {
                delete config.mcpServers[toRemove];
                const configPath = path.join(process.env.USERPROFILE || process.env.HOME, '.power-cli', 'config.json');
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                p.note(`Removed MCP server: \${toRemove}`, 'Success');
            }
        }
    }
}

import path from 'path';
