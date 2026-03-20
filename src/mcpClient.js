import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pc from 'picocolors';

export async function bootstrapMcpServers(config) {
    const servers = config.mcpServers || {};
    const dynamicTools = [];

    for (const [name, serverConfig] of Object.entries(servers)) {
        try {
            const transport = new StdioClientTransport({
                command: serverConfig.command,
                args: serverConfig.args || [],
                env: { ...process.env, ...(serverConfig.env || {}) }
            });

            const client = new Client(
                { name: `RexMCPClient-${name}`, version: '1.0.0' },
                { capabilities: { prompts: {}, resources: {}, tools: {} } }
            );

            await client.connect(transport);
            
            const toolsResponse = await client.listTools();
            let toolCount = 0;
            
            if (toolsResponse?.tools) {
                for (const tool of toolsResponse.tools) {
                    const argSchema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : '';
                    dynamicTools.push({
                        name: `mcp_${name}_${tool.name}`,
                        desc: `[MCP: ${name}] ${tool.description || tool.name}. Schema: \${argSchema}`,
                        action: async (args) => {
                            try {
                                const res = await client.callTool({
                                    name: tool.name,
                                    arguments: args
                                });
                                if (res.isError) {
                                    return `MCP Tool Error: \${res.content.map(c => c.text).join('\\n')}`;
                                }
                                return res.content.map(c => c.text).join('\\n');
                            } catch (err) {
                                return `MCP Execution Exception: \${err.message}`;
                            }
                        }
                    });
                    toolCount++;
                }
            }
            console.log(`  \${pc.dim('Connected to MCP server:')} \${pc.cyan(name)} (\${toolCount} tools)`);
        } catch (e) {
            console.log(`  \${pc.red(\`Failed to connect to MCP server "\${name}": \${e.message}\`)}`);
        }
    }

    return dynamicTools;
}
