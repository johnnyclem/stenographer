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

  // F13: CI ran test:openappa with no appa on the runner, so it printed a
  // skip and the battery's replay traces never ran.
  it('CI installs the pinned OpenAPPA and requires it for test:openappa', () => {
    const ci = read('.github/workflows/ci.yml');
    const pinned = /const PINNED = '([^']+)'/.exec(read('integrations/openappa/run-checks.mjs'))?.[1];
    expect(pinned).toBeTruthy();
    expect(ci).toContain(`APPA_VERSION: v${pinned}`);
    expect(ci).toMatch(/releases\/download\/v\$\{APPA_VERSION#v\}\/appa-install\.sh|releases\/download\/\$\{APPA_VERSION\}\/appa-install\.sh/);
    expect(ci).toMatch(/APPA_REQUIRED:\s*'?1'?/);
    expect(ci.indexOf('appa-install.sh')).toBeLessThan(ci.indexOf('npm run test:openappa'));
  });

  // better-sqlite3 11 on Node 24: vitest's fork workers abort at teardown,
  // "Assertion failed: (env) != nullptr" from Statement::~Statement() in
  // node::RemoveEnvironmentCleanupHook. 13.0.3 (Node-API, prebuilt) fixes it.
  it('locks a SQLite driver that runs on every CI Node major', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string; engines?: { node?: string } }>;
    };
    const driver = lock.packages['node_modules/better-sqlite3'];
    const [major, minor, patch] = (driver?.version ?? '0.0.0').split('.').map(Number);
    expect(major * 1e6 + minor * 1e3 + patch, `better-sqlite3 ${driver?.version}`).toBeGreaterThanOrEqual(13_000_003);
    expect(driver.engines?.node).toBe(pkg.engines.node);
  });

  // npm 11 (Node 24) `npm ci` refuses a lockfile that leaves out another
  // platform's optional packages; npm 10 installs from it without them, so a
  // Mac got no sqlite-vec binary and fell back to the slow vector path.
  it('the lockfile lists every optional platform package, so npm ci works on npm 10 and 11', () => {
    const { packages } = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { optionalDependencies?: Record<string, string> }>;
    };
    // npm resolves a dependency in the nearest node_modules up the tree
    const resolves = (from: string, name: string) => {
      for (let dir = from; ; dir = dir.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, '')) {
        if (packages[`${dir ? `${dir}/` : ''}node_modules/${name}`]) return true;
        if (!dir) return false;
      }
    };
    const missing = Object.entries(packages).flatMap(([path, entry]) =>
      Object.keys(entry.optionalDependencies ?? {})
        .filter((name) => !resolves(path, name))
        .map((name) => `${path || '(root)'} -> ${name}`)
    );
    expect(missing).toEqual([]);
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
