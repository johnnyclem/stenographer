#!/usr/bin/env node

/**
 * Stenographer CLI
 * MCP court reporter for AI agent conversations
 */

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
  // Don't parseArgs here — subcommand flags (e.g. --mode daemon) must reach
  // the command untouched
  const argv = process.argv.slice(2);
  const wantsHelp = argv.includes('-h') || argv.includes('--help');

  if (wantsHelp || argv.length === 0) {
    console.log(`
Stenographer 🤖 MCP court reporter

Usage:
  stenographer start <log-path> [state-path] [options]  Start the MCP server
  stenographer init [name]                              Initialize a new project
  stenographer -h, --help                               Show help

Options (start):
  -m, --mode <mode>        live | catchup | watch | daemon  (default: live)
                           live:    tail a file and serve MCP
                           catchup: index a completed file, then serve
                           watch:   watch a directory for *.jsonl session logs
                           daemon:  live + REST API (default port 8787)
  -a, --adapter <name>     jsonl | anthropic | openai | claude-code | generic
                           (default: auto-detect from file content)
  -e, --embeddings <name>  Transformer model name, or 'hashed' for the
                           offline lexical embedder
      --rest-port <port>   Serve the REST API on this port
      --rest-host <host>   Interface for the REST API to bind to
                           (default: 127.0.0.1 — the API has no auth,
                           so it stays loopback-only unless overridden)

Examples:
  stenographer start ./conversation.jsonl
  stenographer start ./logs/chat.jsonl ./state.db --mode daemon
  stenographer start ~/.claude/projects/myproj --mode watch --adapter claude-code
`);
    process.exit(0);
  }

  const [command, ...args] = argv;
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
