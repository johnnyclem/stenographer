/**
 * Stenographer — wiki files, confined to the wiki directory
 *
 * Wiki import and export read and write JSONL files only inside one
 * configured directory (`--wiki-dir`, default `<state dir>/wiki`). A file
 * is named relative to it; an absolute path, a `..` segment, a name that
 * isn't `*.jsonl`, a symlink that resolves outside the directory, anything
 * that isn't a regular file, and the ledger's own state file are refused.
 * The final open doesn't follow symlinks, so the checked path is the one
 * opened.
 *
 * One writer per file. A file holds one ledger's line stream: export
 * appends, in one O_APPEND write, the lines of its stream the file doesn't
 * hold yet, and refuses a file that holds anything else (a teammate's
 * lines, an edited line). It never truncates or rewrites a line.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Larger wiki files are refused rather than read into memory. */
export const MAX_WIKI_FILE_BYTES = 64 * 1024 * 1024;

export class WikiPathError extends Error {}

export interface WikiFileTarget {
  /** The wiki directory. */
  dir: string;
  /** A `.jsonl` file name inside it, relative to it (subdirectories allowed). */
  file: string;
  /** The ledger's state file, which is never read or written as a wiki file. */
  statePath?: string;
}

/** `<state dir>/wiki`: next to the ledger. */
export function defaultWikiDir(statePath: string): string {
  return join(dirname(resolve(statePath)), 'wiki');
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(dir: string, path: string): boolean {
  return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Resolves `target.file` inside `target.dir`, or throws WikiPathError.
 * `create` makes the wiki directory itself if it doesn't exist (export);
 * the file may then not exist yet.
 */
export function resolveWikiFile(target: WikiFileTarget, opts: { create?: boolean } = {}): string {
  const { file } = target;
  if (typeof file !== 'string' || file.length === 0) throw new WikiPathError('name a .jsonl file inside the wiki directory');
  if (file.includes('\0')) throw new WikiPathError('a wiki file name cannot contain NUL');
  if (isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.startsWith('\\')) {
    throw new WikiPathError(`'${file}' is absolute: name the file relative to the wiki directory`);
  }
  const segments = file.split(/[\\/]+/);
  if (segments.includes('..')) throw new WikiPathError(`'${file}' leaves the wiki directory ('..' is refused)`);
  if (!file.endsWith('.jsonl')) throw new WikiPathError(`'${file}' is not a .jsonl file`);

  if (opts.create) mkdirSync(target.dir, { recursive: true });
  const dir = realpathOrNull(target.dir);
  if (!dir) throw new WikiPathError(`the wiki directory ${target.dir} does not exist`);

  const path = resolve(dir, file);
  if (!inside(dir, path)) throw new WikiPathError(`'${file}' is outside the wiki directory`);
  const parent = realpathOrNull(dirname(path));
  if (!parent || (parent !== dir && !inside(dir, parent))) {
    throw new WikiPathError(`'${file}' is outside the wiki directory, or its directory does not exist`);
  }

  // A symlink is fine only if it lands inside the directory, on a regular file
  let real = join(parent, basename(path));
  if (existsSync(real) || isDanglingLink(real)) {
    const resolved = realpathOrNull(real);
    if (!resolved || !inside(dir, resolved)) throw new WikiPathError(`'${file}' resolves outside the wiki directory`);
    real = resolved;
  }

  const state = target.statePath ? realpathOrNull(target.statePath) : null;
  if (state && ([state, `${state}-journal`, `${state}-wal`, `${state}-shm`].includes(real) || sameFile(state, real))) {
    throw new WikiPathError(`'${file}' is the ledger's state file`);
  }
  return real;
}

/** Two paths to one file (a hard link, too). */
function sameFile(a: string, b: string): boolean {
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Opens a resolved wiki path without following a symlink, and checks it's a regular file of sane size. */
function openRegular(path: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(path, flags | constants.O_NOFOLLOW, 0o644);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new WikiPathError('the wiki file is a symlink');
    if (code === 'ENOENT') throw new WikiPathError('no such wiki file');
    throw err;
  }
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new WikiPathError('the wiki file is not a regular file');
  }
  if (stat.size > MAX_WIKI_FILE_BYTES) {
    closeSync(fd);
    throw new WikiPathError(`the wiki file is larger than ${MAX_WIKI_FILE_BYTES} bytes`);
  }
  return fd;
}

/** Reads a wiki file's lines (blank ones included, so line numbers match the file). */
export function readWikiFile(target: WikiFileTarget): string[] {
  const path = resolveWikiFile(target);
  const fd = openRegular(path, constants.O_RDONLY);
  try {
    return readFileSync(fd, 'utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

export interface WikiAppendResult {
  /** The resolved file written to. */
  path: string;
  /** Lines written. */
  appended: number;
  /** Lines of the stream the file already held. */
  present: number;
  lines: string[];
}

/**
 * Appends to a wiki file the lines of `stream` (one ledger's lines, in seq
 * order) that come after what the file holds, in one O_APPEND write after a
 * newline if the file doesn't end with one. Creates the file, and the wiki
 * directory, if missing. The file must hold a run of this same stream and
 * nothing else, and the append must continue it without a gap; otherwise
 * the file is left untouched and this throws.
 */
export function appendWikiFile(target: WikiFileTarget, stream: string[]): WikiAppendResult {
  const path = resolveWikiFile(target, { create: true });
  const fd = openRegular(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT);
  try {
    const existing = readFileSync(fd, 'utf8');
    // (A checkout that turned LF into CRLF doesn't make a line someone else's)
    const held = existing.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0);
    const bySeq = new Map(stream.map((l) => [seqOf(l), l]));
    const notOurs = (i: number) =>
      new WikiPathError(
        `'${target.file}' holds line ${i + 1}, which is not this ledger's — one writer per wiki file: ` +
          'export to a file of your own (teammates import it from there)'
      );

    // The file must be a contiguous run of this stream: its lines, in order, unedited. Lines
    // before the part of the stream we were given (an incremental export) can't be compared.
    const from = seqOf(stream[0] ?? '') ?? 1;
    let last: number | null = null;
    for (const [i, text] of held.entries()) {
      const seq = seqOf(text);
      if (seq === null || (last !== null && seq !== last + 1)) throw notOurs(i);
      if (seq >= from && bySeq.get(seq) !== text) throw notOurs(i);
      last = seq;
    }
    const fresh = stream.filter((l) => last === null || (seqOf(l) ?? 0) > last);
    const first = fresh.length > 0 ? seqOf(fresh[0]) : null;
    if (last !== null && first !== null && first !== last + 1) {
      throw new WikiPathError(`'${target.file}' ends at seq ${last}; appending from seq ${first} would leave a gap`);
    }
    if (fresh.length > 0) {
      const lead = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      writeSync(fd, lead + fresh.map((l) => l + '\n').join(''));
      fsyncSync(fd);
    }
    return { path, appended: fresh.length, present: held.length, lines: fresh };
  } finally {
    closeSync(fd);
  }
}

function seqOf(text: string): number | null {
  try {
    const seq = (JSON.parse(text) as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isInteger(seq) && seq > 0 ? seq : null;
  } catch {
    return null;
  }
}
