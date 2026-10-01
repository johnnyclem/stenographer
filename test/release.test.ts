/**
 * Release metadata agrees with itself: the version the MCP server reports,
 * the README badges, the CHANGELOG heading, the Node floor and CI, and the
 * suite's package naming in docs (release plan, Addendum B). The server's
 * version is a constant that has to be bumped by hand, and through 0.x the
 * README's quick start and `stenographer init` ran an unscoped
 * `npx stenographer`, which is not this package (STENO-T-25, STENO-IDX-29).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StenographerServer } from '../src/mcp/server.js';

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  engines: { node: string };
};
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Markdown and source files a user reads commands from. */
function docFiles(): string[] {
  const files = ['README.md', 'MIGRATION.md', 'CHANGELOG.md', 'cli/index.ts'];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.md')) files.push(rel);
    }
  };
  for (const dir of ['docs', 'spec', 'integrations']) walk(dir);
  return files;
}

describe('release metadata', () => {
  it('the MCP server reports the package version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'steno-release-'));
    writeFileSync(join(dir, 'log.jsonl'), '');
    const server = new StenographerServer({
      logPath: join(dir, 'log.jsonl'),
      statePath: ':memory:',
      mode: 'catchup',
      embeddingModel: 'hashed',
    });
    try {
      await server.engine.start();
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'release-check', version: '1.0.0' });
      await client.connect(clientSide);
      expect(client.getServerVersion()?.version).toBe(pkg.version);
      const status = (await client.callTool({ name: 'get_status', arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(status.content[0].text).version).toBe(pkg.version);
      await client.close();
    } finally {
      server.engine.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires Node 22 or newer, and CI runs the supported majors', () => {
    expect(pkg.engines.node).toBe('>=22');
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/node-version:\s*\[\s*22\s*,\s*24\s*\]/);
    for (const step of ['npm run lint', 'npm test', 'npm run build']) expect(ci).toContain(step);
  });

  it('the README badges and requirements match package.json', () => {
    const readme = read('README.md');
    // shields.io escapes a dash in a badge value as --
    expect(readme).toContain(`badge/version-${pkg.version.replace(/-/g, '--')}-`);
    const floor = pkg.engines.node.replace('>=', '');
    expect(readme).toContain(`badge/node-%3E%3D${floor}-`);
    expect(readme).toContain(`Node.js >= ${floor}`);
  });

  it('the CHANGELOG opens with this version, Keep a Changelog style', () => {
    const first = read('CHANGELOG.md').match(/^## .*$/m)?.[0];
    expect(first).toMatch(new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - (Unreleased|\\d{4}-\\d{2}-\\d{2})$`));
  });

  it('docs run the scoped package, never an unscoped npx name', () => {
    const offenders: string[] = [];
    for (const file of docFiles()) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/\bnpx\s+(-y\s+)?(stenographer|smallchat)\s+\w/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
