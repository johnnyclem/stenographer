#!/usr/bin/env node
/**
 * `npm run test:openappa`: checks the OpenAPPA battery with the appa CLI.
 *
 * For each root under policy-tests/, `appa describe --check` must load the
 * composed config and find a rule for every tool the built server serves
 * (both profiles, passed as --session-tools in Claude Code's spelling), and
 * `appa replay` must get every expected decision. Skips, exit 0, when no
 * appa binary is found: APPA_BIN names one off PATH. With APPA_REQUIRED set
 * (CI sets it, after installing the pinned release), a missing binary
 * fails instead. The battery is written against OpenAPPA 0.30.0; another
 * version gets a warning, not a skip.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED = '0.30.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ROOTS = ['notary', 'plugin-default'];

function findAppa() {
  if (process.env.APPA_BIN) return process.env.APPA_BIN;
  const names = process.platform === 'win32' ? ['appa.exe', 'appa.cmd'] : ['appa'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Every tool the built server serves, in any profile, as Claude Code spells it. */
async function servedTools() {
  const entry = join(ROOT, 'dist', 'mcp', 'server.js');
  if (!existsSync(entry)) return null;
  const { StenographerServer } = await import(pathToFileURL(entry).href);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const dir = mkdtempSync(join(tmpdir(), 'steno-openappa-'));
  const names = new Set();
  try {
    writeFileSync(join(dir, 'log.jsonl'), '');
    for (const config of [{}, { profile: 'operator' }]) {
      const server = new StenographerServer({
        logPath: join(dir, 'log.jsonl'),
        statePath: ':memory:',
        mode: 'catchup',
        embeddingModel: 'hashed',
        agentIdentity: 'agent:openappa-check',
        ...config,
      });
      try {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: 'openappa-check', version: '1.0.0' });
        await client.connect(clientSide);
        for (const tool of (await client.listTools()).tools) names.add(`mcp__stenographer__${tool.name}`);
        await client.close();
      } finally {
        server.stop();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return [...names].sort();
}

function run(appa, args) {
  return spawnSync(appa, args, { cwd: HERE, encoding: 'utf8' });
}

async function main() {
  const appa = findAppa();
  if (!appa) {
    if (process.env.APPA_REQUIRED) {
      console.error(`test:openappa: no appa binary on PATH or in APPA_BIN, and APPA_REQUIRED is set (OpenAPPA ${PINNED})`);
      return 1;
    }
    console.log(`test:openappa: skipped — no appa binary on PATH (OpenAPPA ${PINNED}; APPA_BIN names one elsewhere)`);
    return 0;
  }
  const version = run(appa, ['--version']);
  if (version.error) {
    console.error(`test:openappa: cannot run ${appa}: ${version.error.message}`);
    return 1;
  }
  const found = version.stdout.trim().split(/\s+/).pop();
  if (found !== PINNED) {
    console.warn(`test:openappa: ${appa} is ${found}; the battery is written against OpenAPPA ${PINNED}`);
  }

  const tools = await servedTools();
  if (!tools) console.warn('test:openappa: dist/ not built — run `npm run build` to check the served tool inventory');

  let failed = false;
  for (const root of ROOTS) {
    const config = join('policy-tests', root, 'appa.toml');
    const describe = run(appa, [
      'describe',
      '--config',
      config,
      '--check',
      ...(tools ? ['--session-tools', tools.join(',')] : []),
    ]);
    const coverage = /^Session tools: (\d+) with a rule, (\d+) annotated call by call, (\d+) refused$/m.exec(describe.stdout);
    const uncovered = tools && (!coverage || Number(coverage[1]) !== tools.length);
    if (describe.status !== 0 || uncovered) {
      failed = true;
      console.error(`FAIL  appa describe --check --config ${config}`);
      if (uncovered) console.error(`      ${tools.length} served tools, not all with a rule:`);
      process.stderr.write(describe.stdout + describe.stderr);
    } else {
      console.log(`ok    appa describe --check --config ${config}${tools ? ` (${tools.length} served tools, each with a rule)` : ''}`);
    }

    const replay = run(appa, ['replay', '--config', config, join('policy-tests', root)]);
    process.stdout.write(replay.stdout);
    process.stderr.write(replay.stderr);
    if (replay.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
