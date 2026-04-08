#!/usr/bin/env node

/**
 * Stenographer CLI
 * MCP court reporter for AI agent conversations
 */

import { parseArgs } from 'node:util';

const commands: Record<string, (args: string[]) => Promise<void>> = {
  start: async (args) => {
    const { runCLI } = await import('../dist/index.js');
    await runCLI(args);
  },
  init: async (args) => {
    const [name = 'stenographer'] = args;
    console.log(`Initializing ${name}...`);
    console.log(`Run: npx stenographer start <path-to-jsonl>`);
  },
};

async function main() {
  const { positionals, values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
Stenographer 🤖 MCP court reporter

Usage:
  stenographer start <log-path> [state-path]  Start the MCP server
  stenographer init [name]                     Initialize a new project
  stenographer -h, --help                      Show help

Examples:
  stenographer start ./conversation.jsonl
  stenographer start ./logs/chat.jsonl ./state.db
`);
    process.exit(0);
  }

  const [command, ...args] = positionals;
  const fn = commands[command as keyof typeof commands];

  if (!fn) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  await fn(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
