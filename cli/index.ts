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
  proposals: async (args) => {
    const { runNotaryCLI } = await import('../dist/index.js');
    await runNotaryCLI('proposals', args);
  },
  notarize: async (args) => {
    const { runNotaryCLI } = await import('../dist/index.js');
    await runNotaryCLI('notarize', args);
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
  stenographer proposals [state-path]                   List open proposals
  stenographer notarize <id> --as <name> [--state <path>] [--decline <reason>]
                                                        Approve (or decline) an agent-drafted
                                                        tombstone — interactive terminal only
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
  -e, --embeddings <name>  Transformer model name (default all-MiniLM-L6-v2;
                           fails to start if it can't load), 'hashed' for
                           the offline lexical embedder, or 'auto': the
                           embedder the state database is pinned to, else
                           the default model with a loud fallback to hashed
      --reembed            re-embed every stored message and truth entry
                           under the chosen embedder (the state database
                           refuses to open under a different one otherwise)
      --supersede-threshold <n>
                           cosine similarity at which a new decision
                           supersedes an active one (default: calibrated
                           per embedder — MiniLM 0.45, hashed 0.75)
      --rest-port <port>   Serve the REST API on this port
      --rest-host <host>   Interface for the REST API to bind to
                           (default: 127.0.0.1 — the API serves
                           transcripts, so it stays loopback-only unless
                           overridden)
      --rest-allow-host <name>
                           also answer to this Host name (repeatable;
                           loopback names and --rest-host always are)
      --rest-insecure      serve REST without a bearer token (by default
                           every route needs Authorization: Bearer <token>,
                           from STENOGRAPHER_REST_TOKEN or generated into
                           <state dir>/rest-token, mode 0600)
      --objections <mode>  off | shadow | deliver  (default: shadow)
                           real-time objections to tombstoned literals;
                           shadow records them without emitting on /flags
      --objection-channel <url>
                           smallchat channel bridge to push each objection
                           to as it's raised (repeatable; secret from
                           SMALLCHAT_CHANNEL_SECRET)
      --objection-webhook <url>
                           webhook for harnesses without interrupts: gets
                           objections in batches (repeatable; HMAC key from
                           STENOGRAPHER_WEBHOOK_SECRET)
      --objection-batch-size <n>
                           batch size for --objection-webhook (default: 3)
      --no-mcp-channel     don't push objections to the attached MCP client
                           as Claude Code channel events
      --require-notary     agents can't assert tombstones directly: they draft
                           with propose_tombstone and a person notarizes
                           (REST notary routes use STENOGRAPHER_NOTARY_SECRET)

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
