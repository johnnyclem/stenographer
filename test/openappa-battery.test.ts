/**
 * The OpenAPPA battery (integrations/openappa/stenographer) against the
 * tools this server really exposes. A tool the battery doesn't name is
 * refused by APPA (or left to the deployment's wildcard annotator), and a
 * rule for a tool that no longer exists is dead policy, so the battery and
 * the server's tool lists must not drift. `npm run test:openappa` checks the
 * same files with the appa CLI; this test needs no appa binary.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StenographerServer } from '../src/mcp/server.js';
import type { StenographerConfig } from '../src/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATION = join(ROOT, 'integrations', 'openappa');
const BATTERY = join(INTEGRATION, 'stenographer');
const NAMESPACE = 'mcp/stenographer/';

/** Acts a person performs under their own name: each needs fresh human attention. */
const PERSON_ACTS = [
  'sign_proposal',
  'dismiss_proposal',
  'override_tombstone',
  'file_ruling',
  'rule_on_objection',
  // Only the operator profile serves it, and always with a person's signedBy: no agent signs a TB alone
  'assert_tombstone',
  // A wiki file applies overrides, strikes and rulings in its writers' names (STENO-REV-05)
  'import_wiki_entries',
];

interface Rule {
  name: string;
  tool: string;
  selector: string | null;
  delta?: { audience?: string[]; trust?: string };
  requires?: { trust?: string; attention?: string[]; audience?: unknown; effects?: unknown };
  effects?: string[];
  annotator?: string;
}

/**
 * Reads the `[[policy.tool]]` entries of the battery. A minimal reader for
 * the subset the battery is written in — bare keys, strings, arrays and
 * inline tables — not a TOML parser.
 */
function readRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let current: Record<string, unknown> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      current = line === '[[policy.tool]]' ? {} : null;
      if (current) rules.push(current as unknown as Rule);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    current[key] = parseValue(value);
  }
  for (const rule of rules) {
    const match = /^([^()]+)(?:\((.*)\))?$/.exec(rule.name);
    if (!match) throw new Error(`unreadable rule name ${rule.name}`);
    rule.tool = match[1];
    rule.selector = match[2] ?? null;
  }
  return rules;
}

function parseValue(value: string): unknown {
  if (value.startsWith("'")) return value.slice(1, -1);
  // Inline tables and arrays of strings: quote the bare keys and read it as JSON
  return JSON.parse(value.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*=/g, '$1"$2":'));
}

const batteryText = () => readFileSync(join(BATTERY, 'appa.toml'), 'utf8');

let dir: string | null = null;
let servers: StenographerServer[] = [];

afterEach(() => {
  for (const s of servers) s.engine.stop();
  servers = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** The tools (with their MCP annotations) one server configuration advertises. */
async function advertised(overrides: Partial<StenographerConfig>) {
  dir ??= mkdtempSync(join(tmpdir(), 'steno-openappa-'));
  writeFileSync(join(dir, 'log.jsonl'), '');
  const server = new StenographerServer({
    logPath: join(dir, 'log.jsonl'),
    statePath: ':memory:',
    mode: 'catchup',
    embeddingModel: 'hashed',
    agentIdentity: 'agent:battery-test',
    ...overrides,
  });
  servers.push(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'battery-test', version: '1.0.0' });
  await client.connect(clientSide);
  return (await client.listTools()).tools;
}

/** Every tool any profile serves, with whether every profile marks it read-only. */
async function allTools(): Promise<Map<string, boolean>> {
  const tools = new Map<string, boolean>();
  for (const config of [{}, { profile: 'operator' as const }]) {
    for (const t of await advertised(config)) {
      const readOnly = t.annotations?.readOnlyHint === true;
      tools.set(t.name, (tools.get(t.name) ?? readOnly) && readOnly);
    }
  }
  return tools;
}

/** Every `.appa` trace under a directory, recursively. */
function traces(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if (statSync(full).isDirectory()) return traces(full);
    return name.endsWith('.appa') ? [readFileSync(full, 'utf8')] : [];
  });
}

describe('OpenAPPA battery: coverage of the served tools', () => {
  it('names every tool of every profile under mcp/stenographer, with an unconditional rule', async () => {
    const tools = await allTools();
    const rules = readRules(batteryText());
    for (const name of tools.keys()) {
      const own = rules.filter((r) => r.tool === `${NAMESPACE}${name}`);
      expect(own.length, `no rule for ${name}`).toBeGreaterThan(0);
      // A selector-only tool would refuse every call whose arguments miss the pattern
      expect(
        own.some((r) => r.selector === null),
        `${name} has no rule without an argument selector`
      ).toBe(true);
      // The unconditional rule must come last: rules match first to last
      expect(own[own.length - 1].selector, `${name}: the unconditional rule is not the last one`).toBeNull();
    }
  });

  it('names no tool the server does not serve, and only canonical ids', async () => {
    const tools = await allTools();
    for (const rule of readRules(batteryText())) {
      expect(rule.tool.startsWith(NAMESPACE), rule.name).toBe(true);
      expect(tools.has(rule.tool.slice(NAMESPACE.length)), `stale rule ${rule.name}`).toBe(true);
      expect(rule.annotator, `${rule.name}: the battery is static rules only`).toBeUndefined();
    }
  });

  it('binds the stenographer namespace in its package manifest', () => {
    const manifest = readFileSync(join(BATTERY, 'appa-package.toml'), 'utf8');
    expect(manifest).toMatch(/^name = "stenographer"$/m);
    expect(manifest).toMatch(/^policy = "appa.toml"$/m);
    expect(manifest).toMatch(/^namespaces = \["stenographer"\]$/m);
    expect(manifest).toMatch(/^hosts = \[[^\]]*"claude-code"[^\]]*\]$/m);
  });
});

describe('OpenAPPA battery: contracts', () => {
  it('labels every read self and never blocks one', async () => {
    const tools = await allTools();
    const rules = readRules(batteryText());
    for (const [name, readOnly] of tools) {
      if (!readOnly) continue;
      for (const rule of rules.filter((r) => r.tool === `${NAMESPACE}${name}`)) {
        expect(rule.delta?.audience, rule.name).toEqual(['self']);
        expect(rule.requires, `${rule.name}: a read has no requirement`).toBeUndefined();
      }
    }
  });

  it('labels transcript and ledger text suspicious; only get_status keeps the session trust', async () => {
    const tools = await allTools();
    const rules = readRules(batteryText());
    for (const [name, readOnly] of tools) {
      if (!readOnly) continue;
      const expected = name === 'get_status' ? undefined : 'suspicious';
      for (const rule of rules.filter((r) => r.tool === `${NAMESPACE}${name}`)) {
        expect(rule.delta?.trust, rule.name).toBe(expected);
      }
    }
  });

  it('requires a trusted trajectory for every truth write', async () => {
    const tools = await allTools();
    const rules = readRules(batteryText());
    for (const [name, readOnly] of tools) {
      if (readOnly) continue;
      for (const rule of rules.filter((r) => r.tool === `${NAMESPACE}${name}`)) {
        // export_wiki_entries without a file is an inline read of the ledger
        if (name === 'export_wiki_entries' && rule.selector === null) {
          expect(rule.delta, rule.name).toEqual({ audience: ['self'], trust: 'suspicious' });
          expect(rule.requires, rule.name).toBeUndefined();
          continue;
        }
        expect(rule.requires?.trust, rule.name).toBe('trusted');
        expect(rule.effects?.length ?? 0, `${rule.name} records no effect`).toBeGreaterThan(0);
      }
    }
  });

  it('requires fresh human attention for overrides, rulings and every act signed with a person\'s name', () => {
    const rules = readRules(batteryText());
    const hitl = (r: Rule) => r.requires?.attention?.includes('hitl') ?? false;
    for (const name of PERSON_ACTS) {
      const own = rules.filter((r) => r.tool === `${NAMESPACE}${name}`);
      expect(own.length, name).toBeGreaterThan(0);
      for (const rule of own) expect(hitl(rule), rule.name).toBe(true);
    }
    // An operator resolution that names a signer mints truth under a person's name
    const signed = rules.find((r) => r.name === `${NAMESPACE}resolve_uv(signedBy:*)`);
    expect(signed && hitl(signed), 'resolve_uv(signedBy:*)').toBe(true);
    // ...while the spelling without one (an agent's attestation, or a person's plain resolution) needs trust only
    const bare = rules.find((r) => r.name === `${NAMESPACE}resolve_uv`);
    expect(bare && hitl(bare), 'resolve_uv').toBe(false);
  });

  it('declares no write it could never allow: a rule that requires trusted keeps the trust', () => {
    // OpenAPPA checks requirements against the label the call's own result
    // leaves, so `requires trusted` with a suspicious result is unsatisfiable
    // without an authority that lifts trust
    for (const rule of readRules(batteryText())) {
      if (rule.requires?.trust === 'trusted') expect(rule.delta?.trust, rule.name).toBeUndefined();
    }
  });

  it('gates propose_tombstone as a truth write: a draft that completes an agent quorum mints a TB', () => {
    const rules = readRules(batteryText()).filter((r) => r.tool === `${NAMESPACE}propose_tombstone`);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.requires?.trust, rule.name).toBe('trusted');
      expect(rule.effects, rule.name).toEqual(['stenographer.proposed', 'stenographer.changed']);
    }
  });

  it('serves no tool an agent could sign a TB with alone', async () => {
    const agentTools = (await advertised({})).map((t) => t.name);
    expect(agentTools).not.toContain('assert_tombstone');
    expect(batteryText()).not.toMatch(/allow-agent-assert/);
  });
});

describe('OpenAPPA battery: replay traces', () => {
  it('exercise every tool the server serves', async () => {
    const tools = await allTools();
    const steps = traces(join(INTEGRATION, 'policy-tests', 'notary')).join('\n');
    for (const name of tools.keys()) {
      expect(steps, `no replay step calls ${name}`).toMatch(new RegExp(`^${NAMESPACE}${name} \\{`, 'm'));
    }
  });
});
