import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const crashMarkerFile = join(tmpdir(), 'omnexx-fake-mcp-crashed.marker');
const shouldCrashOnFirstCall = process.env.FAKE_MCP_CRASH_FIRST === '1';

const server = new Server(
  {
    name: 'fake-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const MANY_TOOLS = process.env.FAKE_MCP_MANY_TOOLS === '1';

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (MANY_TOOLS) {
    const tools = [];
    for (let i = 1; i <= 25; i++) {
      tools.push({
        name: `tool_${i}`,
        description: `Generated tool number ${i}`,
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      });
    }
    return { tools };
  }

  return {
    tools: [
      {
        name: 'echo',
        description: 'Echo back input message',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
      },
      {
        name: 'crash_or_greet',
        description: 'Crashes on first call if env set, succeeds afterwards',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo') {
    const msg = (args?.message as string) ?? '';
    return {
      content: [
        {
          type: 'text',
          text: `ECHO: ${msg}`,
        },
      ],
    };
  }

  if (name === 'crash_or_greet') {
    if (shouldCrashOnFirstCall && !existsSync(crashMarkerFile)) {
      writeFileSync(crashMarkerFile, '1', 'utf8');
      process.exit(1);
    }
    return {
      content: [
        {
          type: 'text',
          text: `Hello ${args?.name ?? 'world'}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `Handled tool ${name}`,
      },
    ],
  };
});

async function run(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void run();
