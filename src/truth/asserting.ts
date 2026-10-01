/**
 * Stenographer — what a tool call asserts (§12)
 *
 * An objection cites what an agent *asserted*, so only the fields that
 * carry new content are read: the content of a Write, the new side of an
 * Edit, MultiEdit or NotebookEdit, and the parts of a shell command that
 * write something. Searches (Grep, Glob, `grep`, `rg`, `git log -S`), reads,
 * commit messages and the old side of an edit assert nothing: an agent
 * cleaning up a dead value has to be able to look for it and say it's gone.
 *
 * Shell commands are read heuristically (no full parser): the command is
 * split into simple commands at `&&`, `||`, `;`, `|` and newlines, with
 * quotes, `$(…)` and heredocs kept together, and each simple command is
 * classified by its name:
 *   - searches and viewers (grep, rg, find, cat without a redirect, …),
 *     git and gh: nothing, except environment assignments in front of them,
 *     and what a find/fd `-exec` runs (read like a command of its own);
 *   - jq, yq, sort, uniq, cut, head, tail: the whole command when its
 *     output goes into a file (redirected, `yq -i`, `sort -o`, piped into
 *     tee or sponge);
 *   - echo/printf/cat: only when redirected or piped onward;
 *   - sed/perl: only in place (-i), redirected or piped, and only the
 *     replacement side of each s///;
 *   - `bash -c '…'` and friends: the script, read the same way;
 *   - anything else (interpreters, package scripts, heredocs into files):
 *     the whole simple command, with its heredoc bodies.
 *
 * Tools this module doesn't know (an MCP tool, another harness's editor)
 * are read through the field names that carry new content in common tool
 * schemas (content, new_string, new_str, file_text, code, …; diffs and
 * patches by their added lines), never through keys naming the old side.
 */

export interface AssertedField {
  /** Which input field the text came from, e.g. `content`, `edits[1].new_string`, `command`. */
  field: string;
  text: string;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const field = (value: unknown, name: string): AssertedField[] =>
  typeof value === 'string' && value.length > 0 ? [{ field: name, text: value }] : [];

/** The added lines of a unified diff or an apply_patch envelope. */
export function addedLines(patch: string): string {
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
}

/** Words joined back into one command line, quoted where the shell would need it. */
const joinWords = (words: string[]): string =>
  words.map((v) => (/[\s'"\\$`;&|<>]/.test(v) ? `'${v.replace(/'/g, `'\\''`)}'` : v)).join(' ');

const commandText = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? joinWords(value as string[])
      : null;

const shellFields = (value: unknown, name: string): AssertedField[] => {
  const command = commandText(value);
  return command ? shellAssertingText(command).map((text) => ({ field: name, text })) : [];
};

type Extractor = (input: Record<string, unknown>) => AssertedField[];

/** Tools whose asserting fields are known exactly. */
const KNOWN_TOOLS: Record<string, Extractor> = {
  // Claude Code
  Write: (input) => field(input.content, 'content'),
  Edit: (input) => field(input.new_string, 'new_string'),
  MultiEdit: (input) =>
    (Array.isArray(input.edits) ? input.edits : []).flatMap((edit, i) =>
      field(asRecord(edit)?.new_string, `edits[${i}].new_string`)
    ),
  NotebookEdit: (input) => field(input.new_source, 'new_source'),
  Bash: (input) => shellFields(input.command, 'command'),
  // Codex-style shells and patches
  shell: (input) => shellFields(input.command, 'command'),
  local_shell: (input) => shellFields(input.command, 'command'),
  exec_command: (input) => shellFields(input.cmd ?? input.command, 'command'),
  apply_patch: (input) => {
    const patch = typeof input.input === 'string' ? input.input : input.patch;
    return typeof patch === 'string' ? field(addedLines(patch), 'patch') : [];
  },
};

/** Tools that read, search or keep notes: they assert nothing. */
const NON_ASSERTING_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'Agent',
  'BashOutput',
  'KillShell',
  'KillBash',
  'NotebookRead',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** Field names that carry new content in common tool schemas. */
const CONTENT_KEY =
  /^(?:content|contents|new_?string|new_?str|new_?source|new_?content|new_?text|new_?code|file_?text|code|code_?edit|replacement)$/i;
const PATCH_KEY = /^(?:patch|diff)$/i;
/** Keys naming the old side of an edit. */
const OLD_KEY = /^old/i;

function genericFields(input: unknown, path: string, depth: number, out: AssertedField[]): void {
  if (depth > 4) return;
  if (Array.isArray(input)) {
    input.forEach((v, i) => genericFields(v, `${path}[${i}]`, depth + 1, out));
    return;
  }
  const record = asRecord(input);
  if (!record) return;
  for (const [key, value] of Object.entries(record)) {
    if (OLD_KEY.test(key)) continue;
    const name = path ? `${path}.${key}` : key;
    if (typeof value === 'string') {
      if (CONTENT_KEY.test(key)) out.push(...field(value, name));
      else if (PATCH_KEY.test(key)) out.push(...field(addedLines(value), name));
    } else {
      genericFields(value, name, depth + 1, out);
    }
  }
}

/** The texts a tool call asserts, field by field. */
export function assertingFields(toolName: string, input: unknown): AssertedField[] {
  if (NON_ASSERTING_TOOLS.has(toolName)) return [];
  const record = asRecord(input);
  if (!record) return [];
  const known = KNOWN_TOOLS[toolName];
  if (known) return known(record);
  const out: AssertedField[] = [];
  genericFields(record, '', 0, out);
  return out;
}

// ─────────────────────────────────────────────────────────────
// Shell commands
// ─────────────────────────────────────────────────────────────

interface SimpleCommand {
  /** The command as written (quotes kept). */
  raw: string;
  /** Its words, quotes removed. */
  words: string[];
  /** Output goes to a file (not /dev/null or another descriptor). */
  redirected: boolean;
  /** Output is piped into the next command. */
  pipedOut: boolean;
  heredocs: string[];
}

/** Reads and inspects only: their arguments are patterns and paths. */
const SEARCH_COMMANDS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ack-grep', 'ugrep', 'git-grep',
  'find', 'fd', 'fdfind', 'locate', 'which', 'whereis', 'type', 'man',
  'ls', 'tree', 'stat', 'file', 'wc', 'du', 'head', 'tail', 'less', 'more',
  'sort', 'uniq', 'cut', 'diff', 'cmp', 'jq', 'yq',
]);
/**
 * Of those, the ones that print what they are given, or a transformation of
 * it (a jq/yq filter, a here-string): they assert it when it goes into a
 * file — redirected, in place (`yq -i`, `sort -o`), or piped into a writer.
 */
const TRANSFORMERS = new Set(['jq', 'yq', 'sort', 'uniq', 'cut', 'head', 'tail']);
/** Write what is piped into them to a file. */
const PIPE_WRITERS = new Set(['tee', 'sponge']);
/** Options that run a command per result: find's up to `;` or `+`, fd's up to `;` or the end. */
const EXEC_OPTIONS: Record<string, Set<string>> = {
  find: new Set(['-exec', '-execdir', '-ok', '-okdir']),
  fd: new Set(['-x', '--exec', '-X', '--exec-batch']),
  fdfind: new Set(['-x', '--exec', '-X', '--exec-batch']),
};
/** Write only to stdout: they assert something only when it goes somewhere. */
const STDOUT_COMMANDS = new Set(['echo', 'printf', 'cat']);
/** Edit with a script whose s/// pattern is the old side. */
const STREAM_EDITORS = new Set(['sed', 'gsed', 'perl']);
/** Shells that run a script given with -c. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Prefixes that run the command after them. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'exec', 'command', 'builtin', 'xargs', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', '{', '(']);

/** Splits a shell command into simple commands. Not a full shell parser; see the module comment. */
function parseShell(command: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const fresh = (): SimpleCommand => ({ raw: '', words: [], redirected: false, pipedOut: false, heredocs: [] });
  let cur = fresh();
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let pending: Array<{ owner: SimpleCommand; delimiter: string; stripTabs: boolean }> = [];

  const endWord = () => {
    if (inWord) cur.words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (pipedOut = false) => {
    endWord();
    cur.pipedOut = pipedOut;
    if (cur.raw.trim()) commands.push(cur);
    cur = fresh();
  };
  /** Reads one word starting at `i` (quotes removed); returns it and where it ends. */
  const readWord = (i: number): { value: string; end: number } => {
    while (command[i] === ' ' || command[i] === '\t') i++;
    let value = '';
    let q: string | null = null;
    for (; i < command.length; i++) {
      const ch = command[i];
      if (q) {
        if (ch === q) q = null;
        else value += ch;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (/[\s;&|<>()]/.test(ch)) break;
      else value += ch;
    }
    return { value, end: i };
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        word += command[i + 1];
        cur.raw += ch + command[i + 1];
        i += 2;
        continue;
      } else word += ch;
      cur.raw += ch;
      i++;
      continue;
    }
    if (ch === '\\' && command[i + 1] === '\n') {
      i += 2; // line continuation
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      word += command[i + 1];
      inWord = true;
      cur.raw += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      cur.raw += ch;
      i++;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      depth++;
      word += '$(';
      inWord = true;
      cur.raw += '$(';
      i += 2;
      continue;
    }
    if (depth > 0) {
      if (ch === ')') depth--;
      word += ch;
      cur.raw += ch;
      i++;
      continue;
    }
    if (ch === '\n') {
      endCommand();
      i++;
      // Heredoc bodies follow the line that opened them
      for (const doc of pending) {
        const body: string[] = [];
        while (i < command.length) {
          const nl = command.indexOf('\n', i);
          const lineEnd = nl === -1 ? command.length : nl;
          const line = command.slice(i, lineEnd);
          i = nl === -1 ? command.length : nl + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
          body.push(line);
        }
        doc.owner.heredocs.push(body.join('\n'));
      }
      pending = [];
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      endCommand();
      i += 2;
      continue;
    }
    if (ch === '|') {
      if (command[i + 1] === '|') {
        endCommand();
        i += 2;
      } else {
        endCommand(true);
        i += command[i + 1] === '&' ? 2 : 1;
      }
      continue;
    }
    if (ch === ';' || (ch === '&' && command[i + 1] !== '>')) {
      endCommand();
      i += command[i + 1] === ';' ? 2 : 1;
      continue;
    }
    if (ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      // A redirect: `2>` drops the descriptor number already read as a word
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      let j = i + 1;
      if (command[j] === '>' || command[j] === '|') j++;
      if (command[j] === '&') {
        // >&2: to another descriptor
        cur.raw += command.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const target = readWord(j);
      if (target.value && target.value !== '/dev/null') cur.redirected = true;
      cur.raw += command.slice(i, target.end);
      i = target.end;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') {
      endWord();
      if (command[i + 2] === '<') {
        // A here-string: its word stays part of the command
        cur.raw += '<<<';
        i += 3;
        continue;
      }
      let j = i + 2;
      const stripTabs = command[j] === '-';
      if (stripTabs) j++;
      const delimiter = readWord(j);
      if (delimiter.value) pending.push({ owner: cur, delimiter: delimiter.value, stripTabs });
      cur.raw += command.slice(i, delimiter.end);
      i = delimiter.end;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      cur.raw += ch;
      i++;
      continue;
    }
    word += ch;
    inWord = true;
    cur.raw += ch;
    i++;
  }
  endCommand();
  return commands;
}

/** The replacement sides of the s/// commands in a sed or perl script, or null if it has none. */
function substitutionReplacements(script: string): string[] | null {
  const out: string[] = [];
  const re = /(?:^|[;\s{}])s([^\w\s\\])((?:\\.|(?!\1)[^\\])*)\1((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of script.matchAll(re)) out.push(m[3]);
  return out.length > 0 ? out : null;
}

const basename = (s: string): string => s.slice(s.lastIndexOf('/') + 1);

const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** Index of the command's name: past environment assignments and wrappers. */
function nameIndex(words: string[]): number {
  let k = 0;
  while (k < words.length && (isAssignment(words[k]) || WRAPPERS.has(words[k]))) k++;
  return k;
}

/** Whether a transformer writes its output to a file itself. */
function writesInPlace(name: string, args: string[]): boolean {
  if (name === 'yq') return args.some((a) => /^-[A-Za-z]*i[A-Za-z]*$/.test(a) || a === '--inplace' || a.startsWith('--inplace='));
  if (name === 'sort') return args.some((a) => /^-[A-Za-z]*o/.test(a) || a.startsWith('--output'));
  return false;
}

/** What the commands a find/fd `-exec` runs per result assert, read like commands of their own. */
function execAsserts(name: string, args: string[], depth: number): string[] {
  const options = EXEC_OPTIONS[name];
  if (!options || depth >= 3) return [];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!options.has(args[i])) continue;
    let end = i + 1;
    while (end < args.length && args[end] !== ';' && !(name === 'find' && args[end] === '+')) end++;
    const words = args.slice(i + 1, end);
    if (words.length > 0) {
      const run: SimpleCommand = { raw: joinWords(words), words, redirected: false, pipedOut: false, heredocs: [] };
      out.push(...commandAsserts(run, depth + 1));
    }
    i = end;
  }
  return out;
}

/** What one simple command asserts; `next` is the command it pipes into, if any. */
function commandAsserts(cmd: SimpleCommand, depth: number, next?: SimpleCommand): string[] {
  const k = nameIndex(cmd.words);
  // An environment assignment sets a value
  const out = cmd.words.slice(0, k).filter(isAssignment);
  if (k >= cmd.words.length) return out;
  const name = basename(cmd.words[k]);
  const args = cmd.words.slice(k + 1);
  const pipedToFile =
    cmd.pipedOut && next !== undefined && PIPE_WRITERS.has(basename(next.words[nameIndex(next.words)] ?? ''));
  const writes = cmd.redirected || cmd.pipedOut;

  if (SEARCH_COMMANDS.has(name)) {
    if (TRANSFORMERS.has(name) && (cmd.redirected || pipedToFile || writesInPlace(name, args))) {
      return [cmd.raw, ...cmd.heredocs];
    }
    return [...out, ...execAsserts(name, args, depth)];
  }
  if (name === 'git') {
    const sub = args.find((a, i) => !a.startsWith('-') && !['-C', '-c'].includes(args[i - 1] ?? ''));
    if (sub === 'apply' || sub === 'am') out.push(...cmd.heredocs.map(addedLines));
    return out;
  }
  if (name === 'gh') return out;
  if (STDOUT_COMMANDS.has(name)) return writes ? [cmd.raw, ...cmd.heredocs] : out;
  if (STREAM_EDITORS.has(name)) {
    const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'));
    if (!inPlace && !writes) return out;
    for (const arg of args.filter((a) => !a.startsWith('-'))) {
      out.push(...(substitutionReplacements(arg) ?? [arg]));
    }
    return [...out, ...cmd.heredocs];
  }
  if (SHELLS.has(name) && depth < 3) {
    const flag = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (flag !== -1 && args[flag + 1] !== undefined) return [...out, ...shellTexts(args[flag + 1], depth + 1)];
  }
  return [cmd.raw, ...cmd.heredocs];
}

function shellTexts(command: string, depth: number): string[] {
  const commands = parseShell(command);
  return commands
    .flatMap((cmd, i) => commandAsserts(cmd, depth, commands[i + 1]))
    .filter((text) => text.length > 0);
}

/** The parts of a shell command that write something (see the module comment). */
export function shellAssertingText(command: string): string[] {
  return shellTexts(command, 0);
}
