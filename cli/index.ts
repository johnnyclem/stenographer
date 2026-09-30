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
  verify: async (args) => {
    const { runVerifyCLI } = await import('../dist/index.js');
    process.exitCode = await runVerifyCLI(args);
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
  stenographer notarize <id> --as <name> [--state <path>] [--signer-registry <path>]
                       [--decline <reason>]             Approve (or decline) an agent-drafted
                                                        tombstone — interactive terminal only
  stenographer verify [state-path] [--json]             Check the truth ledger: hash chain, links,
                                                        and every status re-derived from links
                                                        (exit 0 intact, 1 integrity failure,
                                                        2 could not run)
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
      --profile <name>     agent | operator  (default: agent)
                           agent:    read tools + propose_tombstone, assert_uv,
                                     resolve_uv (no minting); writes carry the
                                     agent identity, never a caller-named one
                           operator: sign/dismiss/override/rule/strike, direct
                                     TBs, wiki import/export, backfill — for a
                                     notary UI or CLI a person drives, never
                                     an agent
      --agent-identity <id>
                           who agent-profile writes are attributed to
                           (default: agent:<MCP client name>)
      --allow-agent-assert single-user opt-out: the agent profile may assert
                           TBs, signed by the agent identity (off: agents
                           draft and a person notarizes; REST notary routes
                           use STENOGRAPHER_NOTARY_SECRET)
      --signer-registry <path>
                           JSON allowlist of signers and roles
                           ({"signers": [{"id", "role": "human"|"agent"}]});
                           operator paths accept only listed identities
      --skip-verify        serve even if the truth ledger fails its integrity
                           check (by default start refuses; see
                           'stenographer verify')

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
