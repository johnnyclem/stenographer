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
  gate: async (args) => {
    // Runs on every tool call: load only the gate, not the indexer and models
    const { runGateCLI } = await import('../dist/truth/gate.js');
    process.exitCode = await runGateCLI(args);
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
  stenographer gate [--state <path> | --wiki <file>] [--mode shadow|enforce]
                    [--timeout-ms <n>] [--on-error allow|deny]
                    [--tools <list>] [--log <file>]
                                                        Claude Code PreToolUse hook: reads the
                                                        hook JSON on stdin and checks what the
                                                        call asserts against active TB literals
                                                        (enforce: deny on a hit; shadow, the
                                                        default: record and allow). See README,
                                                        "Pre-dispatch gate"
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
                           objections in batches (repeatable; Standard
                           Webhooks signing key from
                           STENOGRAPHER_WEBHOOK_SECRET, at least 24 bytes)
      --objection-batch-size <n>
                           batch size for --objection-webhook (default: 3)
      --no-mcp-channel     don't push objections to the attached MCP client
                           as Claude Code channel events
      --profile <name>     agent | operator  (default: agent)
                           agent:    read tools + propose_tombstone, assert_uv,
                                     resolve_uv; one agent only drafts and
                                     attests, a claim settles when 2+ agent
                                     sessions agree from different angles
                                     within 15 minutes, or a person signs;
                                     writes carry the agent identity, never a
                                     caller-named one
                           operator: sign/dismiss/override/rule/strike, direct
                                     TBs, wiki import/export, backfill — for a
                                     notary UI or CLI a person drives, never
                                     an agent
      --agent-identity <id>
                           who agent-profile writes are attributed to
                           (default: agent:<MCP client name>); people
                           notarize drafts over REST with the secret in
                           STENOGRAPHER_NOTARY_SECRET
      --signer-registry <path>
                           JSON allowlist of signers and roles
                           ({"signers": [{"id", "role": "human"|"agent"}]});
                           operator paths accept only listed identities, and
                           wiki import takes TBs only from listed signers
      --wiki-dir <dir>     directory wiki import/export read and write
                           (default: wiki/ next to the state file); files
                           are named relative to it, nothing outside it
      --skip-verify        serve even if the truth ledger fails its integrity
                           check (by default start refuses; see
                           'stenographer verify')

Options (gate):
      --state <path>       state file to read TBs from (read-only) and file
                           objections in (default: ./stenographer.db)
      --wiki <file>        read TBs from a wiki JSONL file instead (nowhere
                           to file objections or read rulings)
      --mode <mode>        shadow | enforce  (default: shadow)
      --timeout-ms <n>     budget after startup, below the hook timeout
                           (default: 2000; at most 59999)
      --on-error <what>    allow | deny when the gate can't decide in budget
                           or fails (default: allow in shadow, deny in enforce)
      --tools <list>       comma-separated tool names to read, or *
                           (default: Write,Edit,MultiEdit,NotebookEdit,Bash)
      --log <file>         append a JSON line per hit or error

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
