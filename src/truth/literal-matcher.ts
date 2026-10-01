/**
 * Stenographer — the tombstoned-literal matcher (§12)
 *
 * One matcher for the live objection engine (objections.ts) and anything
 * else that has to agree with it on what asserts a dead literal.
 *
 * All active literals compile into one Aho-Corasick automaton over their
 * dead values: a text is read once, however many literals there are, and
 * only the places a dead value actually occurs are examined further (token
 * boundaries, the subject next to it, the clause around it). Cost is linear
 * in the text plus the number of dead-value occurrences.
 *
 * Precision over recall, as before: an occurrence asserts the literal only
 * when
 *   - it is a whole token ("30" is not in "300" or "1.30"),
 *   - its subject, if it has one, sits next to it in the same clause
 *     (`LOG_BUDGET = 30`, "the log budget to 30", "30 as the log budget"),
 *   - the replacement isn't named in that same clause ("bumped LOG_BUDGET
 *     from 30 to 100" discusses the change; `LOG_BUDGET = 30; MAX = 100`
 *     doesn't), and
 *   - no negation or past-tense cue governs it ("do not set LOG_BUDGET to
 *     30", "we removed legacyRateLimiter", "LOG_BUDGET was 30").
 *
 * A clause ends at a statement separator (`;`, `&&`, `||`), a line comment
 * (`//`, ` #`), or where another assignment begins (`MAX = `, `maxRetries:`,
 * `retries=`). Not covered: paraphrases, values split across lines, and
 * anything past the first MAX_SCANNED_CHARS of a text.
 */

import type { TombstonedLiteral } from './types.js';

/** How far after a subject a dead value may appear (`LOG_BUDGET = 30`, "log budget to 30"). */
const AFTER_SUBJECT_WINDOW = 40;
/** How far before a subject (`30 as the log budget`). */
const BEFORE_SUBJECT_WINDOW = 20;
/** How far before the asserted pair a negation cue still governs it ("do not set …"). */
const NEGATION_WINDOW = 24;
/** Longest transcript line an objection quotes. */
const MAX_LINE_LENGTH = 500;
/** Each text is scanned up to here; the rest of a huge input is not read. */
export const MAX_SCANNED_CHARS = 1 << 20;
/** How often (in characters) a scan with a deadline checks the clock. */
const DEADLINE_STRIDE = 1 << 14;

export class MatchDeadlineError extends Error {
  constructor() {
    super('literal matching ran past its deadline');
  }
}

// ─────────────────────────────────────────────────────────────
// Aho-Corasick over dead values
// ─────────────────────────────────────────────────────────────

class AhoCorasick {
  private next: Array<Map<number, number>> = [new Map()];
  private fail: number[] = [0];
  /** Patterns ending at each state, including through its fail chain. */
  private out: number[][] = [[]];

  constructor(patterns: readonly string[]) {
    patterns.forEach((pattern, id) => {
      let state = 0;
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern.charCodeAt(i);
        let to = this.next[state].get(c);
        if (to === undefined) {
          to = this.next.length;
          this.next.push(new Map());
          this.fail.push(0);
          this.out.push([]);
          this.next[state].set(c, to);
        }
        state = to;
      }
      this.out[state].push(id);
    });

    const queue = [...this.next[0].values()];
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head];
      for (const [c, child] of this.next[state]) {
        queue.push(child);
        let f = this.fail[state];
        while (f !== 0 && !this.next[f].has(c)) f = this.fail[f];
        this.fail[child] = this.next[f].get(c) ?? 0;
        const inherited = this.out[this.fail[child]];
        if (inherited.length > 0) this.out[child] = [...this.out[child], ...inherited];
      }
    }
  }

  /** Calls `onMatch(patternId, end)` for every occurrence ending before `end` (exclusive) in text[0, limit). */
  scan(text: string, limit: number, onMatch: (id: number, end: number) => void, deadline?: () => void): void {
    let state = 0;
    for (let i = 0; i < limit; i++) {
      if (deadline && (i & (DEADLINE_STRIDE - 1)) === 0) deadline();
      const c = text.charCodeAt(i);
      let to = this.next[state].get(c);
      while (to === undefined && state !== 0) {
        state = this.fail[state];
        to = this.next[state].get(c);
      }
      state = to ?? 0;
      const ids = this.out[state];
      for (let k = 0; k < ids.length; k++) onMatch(ids[k], i + 1);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Tokens, subjects, clauses
// ─────────────────────────────────────────────────────────────

const isWordCode = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isDigitCode = (c: number): boolean => c >= 48 && c <= 57;

/**
 * Whether text[start, end) is a whole token: "30" not in "300", "1.30" or
 * "30.5", "legacyRateLimiter" not in "legacyRateLimiterV2". An identifier
 * may follow a `.` (member access); a number may not (a decimal).
 */
function isToken(text: string, start: number, end: number): boolean {
  const first = text.charCodeAt(start);
  const last = text.charCodeAt(end - 1);
  if (start > 0 && isWordCode(first)) {
    const before = text.charCodeAt(start - 1);
    if (isWordCode(before) || (isDigitCode(first) && before === 46)) return false;
  }
  if (end < text.length && isWordCode(last)) {
    const after = text.charCodeAt(end);
    if (isWordCode(after)) return false;
    if (after === 46 && end + 1 < text.length && isDigitCode(text.charCodeAt(end + 1))) return false;
  }
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Subject pattern that tolerates naming-convention drift: "logBudget",
 * "LOG_BUDGET", "log-budget", and "log budget" all match subject
 * "logBudget", and "MAX_HTTP_RETRIES" matches "maxHTTPRetries" (acronyms
 * split before their last capital). Word-bounded, so "maxLogBudget" and
 * "LOG_BUDGET_MAX" don't. Never crosses a line.
 */
function subjectRegExp(subject: string): RegExp {
  const words = subject
    .split(/[\s_\-.]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean)
    .map(escapeRegExp);
  return new RegExp(`(?<![A-Za-z0-9_])${words.join('(?:[^\\S\\n]|[_\\-.])*')}(?![A-Za-z0-9_])`, 'gi');
}

/** Hard clause breaks: statement separators and line comments. */
const SEPARATOR = /;|&&|\|\||\/\/|(?<=^|\s)#(?=\s|$)/g;
/** Softer breaks that end a negation's reach: conjunctions and sentence ends. */
const SOFT_SEPARATOR = /;|&&|\|\||\/\/|,|\.(?=\s)|\b(?:and|then|but|so)\b/gi;
/**
 * Where another assignment begins: an identifier (dotted or kebab paths,
 * a closing quote) followed by `=`, `:=` or `:`, but not `==`, `=>`, `::`,
 * `://`. An identifier after a `:` is a type annotation (`x: number = 30`),
 * not a new target.
 */
const ASSIGNMENT_TARGET = /(?<![\w$.\-])[A-Za-z_$][\w$.\-]*["'\]]?[^\S\n]*(?::=|=(?![=>~])|:(?![:/]))/g;
/** Cues that the clause is about not using, or no longer using, a value. */
const NEGATION =
  /\b(?:not|never|no longer|(?:do|does|did|is|are|was|were|should|would|could|wo|ca)n['’]?t|cannot|avoid(?:s|ed|ing)?|instead of|rather than|stop(?:ped)? using|remov(?:e|es|ed|ing)|drop(?:s|ped|ping)?|delet(?:e|es|ed|ing)|deprecat(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|was|were|used to|formerly|previously|old)\b/i;

interface Span {
  start: number;
  end: number;
}

/** Positions in text[from, to) where a clause breaks, as [start, end) spans (assignment targets are zero-width). */
function clauseBreaks(text: string, from: number, to: number): Span[] {
  const region = text.slice(from, to);
  const breaks: Span[] = [];
  for (const m of region.matchAll(SEPARATOR)) breaks.push({ start: from + m.index!, end: from + m.index! + m[0].length });
  for (const m of region.matchAll(ASSIGNMENT_TARGET)) {
    const at = from + m.index!;
    // A type annotation (`x: number = 30`) is not a new target
    let k = at - 1;
    while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
    if (k >= 0 && text[k] === ':') continue;
    breaks.push({ start: at, end: at });
  }
  return breaks;
}

/** Whether `needle` occurs as a whole token in text[from, to). */
function hasToken(text: string, needle: string, from: number, to: number): boolean {
  let at = text.indexOf(needle, Math.max(0, from));
  while (at !== -1 && at + needle.length <= to) {
    if (isToken(text, at, at + needle.length)) return true;
    at = text.indexOf(needle, at + 1);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// The matcher
// ─────────────────────────────────────────────────────────────

interface Compiled<K> {
  key: K;
  literal: TombstonedLiteral;
  subject: RegExp | null;
  /** Generous bound on how long a subject match can be. */
  subjectSpan: number;
}

export interface LiteralHit<K> {
  key: K;
  literal: TombstonedLiteral;
  /** The line asserting it (trimmed; an excerpt around the value when the line is long). */
  line: string;
  /** Offset of the dead value in the text. */
  offset: number;
}

export interface MatchOptions<K> {
  /** Entries to leave out of this scan (e.g. already settled). */
  skip?: (key: K) => boolean;
  /** Every asserting line per entry, not only the first. */
  allLines?: boolean;
  /** Epoch ms past which matching throws MatchDeadlineError. */
  deadline?: number;
  now?: () => number;
}

/**
 * Every active literal, compiled once (per ledger generation) and run over
 * any number of texts.
 */
export class LiteralMatcher<K = number> {
  private entries: Array<Compiled<K>>;
  private automaton: AhoCorasick;
  /** Per distinct dead value: the entries carrying it. */
  private byDead: number[][];
  private deads: string[];

  constructor(entries: ReadonlyArray<{ key: K; literal: TombstonedLiteral }>) {
    this.entries = entries.map(({ key, literal }) => ({
      key,
      literal,
      subject: literal.subject ? subjectRegExp(literal.subject) : null,
      subjectSpan: literal.subject ? literal.subject.length * 3 + 8 : 0,
    }));
    const index = new Map<string, number>();
    this.deads = [];
    this.byDead = [];
    this.entries.forEach((entry, i) => {
      let id = index.get(entry.literal.dead);
      if (id === undefined) {
        id = this.deads.length;
        index.set(entry.literal.dead, id);
        this.deads.push(entry.literal.dead);
        this.byDead.push([]);
      }
      this.byDead[id].push(i);
    });
    this.automaton = new AhoCorasick(this.deads);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * The entries `text` asserts, in the order their first asserting
   * occurrence appears, each with the line asserting it.
   */
  match(text: string, options: MatchOptions<K> = {}): Array<LiteralHit<K>> {
    if (this.entries.length === 0 || text.length === 0) return [];
    const now = options.now ?? Date.now;
    const deadline =
      options.deadline !== undefined
        ? () => {
            if (now() > options.deadline!) throw new MatchDeadlineError();
          }
        : undefined;
    const limit = Math.min(text.length, MAX_SCANNED_CHARS);
    const skipped = this.entries.map((e) => options.skip?.(e.key) ?? false);
    const found = new Set<number>();
    const hits: Array<LiteralHit<K>> = [];
    const seenLines = new Map<number, Set<number>>();

    this.automaton.scan(
      text,
      limit,
      (deadId, end) => {
        const start = end - this.deads[deadId].length;
        if (!isToken(text, start, end)) return;
        let line: Span | null = null;
        for (const i of this.byDead[deadId]) {
          if (skipped[i] || (!options.allLines && found.has(i))) continue;
          line ??= lineAround(text, start, end);
          if (!this.asserts(this.entries[i], text, { start, end }, line)) continue;
          if (options.allLines) {
            const lines = seenLines.get(i) ?? new Set<number>();
            if (lines.has(line.start)) continue;
            lines.add(line.start);
            seenLines.set(i, lines);
          }
          found.add(i);
          const entry = this.entries[i];
          hits.push({ key: entry.key, literal: entry.literal, line: quoteLine(text, line, start), offset: start });
        }
      },
      deadline
    );
    return hits;
  }

  /** Whether the dead-value occurrence `dead` asserts this entry's literal. */
  private asserts(entry: Compiled<K>, text: string, dead: Span, line: Span): boolean {
    if (!entry.subject) return this.pairAsserts(entry, text, dead, dead, line);

    // Subjects that end shortly before the value, or start shortly after it
    const from = Math.max(line.start, dead.start - AFTER_SUBJECT_WINDOW - entry.subjectSpan - 1);
    const to = Math.min(line.end, dead.end + BEFORE_SUBJECT_WINDOW + entry.subjectSpan + 1);
    const window = text.slice(from, to);
    for (const m of window.matchAll(entry.subject)) {
      const start = from + m.index!;
      const end = start + m[0].length;
      // The slice's edges hide a character of context
      if ((m.index === 0 && from > line.start) || (end === to && to < line.end)) continue;
      const near =
        (dead.start >= end && dead.start - end <= AFTER_SUBJECT_WINDOW) ||
        (dead.end <= start && start - dead.end <= BEFORE_SUBJECT_WINDOW);
      if (near && this.pairAsserts(entry, text, { start, end }, dead, line)) return true;
    }
    return false;
  }

  /**
   * Whether a subject (or, for subject-less literals, the value itself) and
   * a dead value make one asserting clause: nothing breaks the clause between
   * them, the replacement isn't named in it, and no negation governs it.
   */
  private pairAsserts(entry: Compiled<K>, text: string, subject: Span, dead: Span, line: Span): boolean {
    const a = Math.min(subject.start, dead.start);
    const b = Math.max(subject.end, dead.end);
    const regionStart = Math.max(line.start, a - Math.max(NEGATION_WINDOW, BEFORE_SUBJECT_WINDOW) - 2);
    const regionEnd = Math.min(line.end, b + AFTER_SUBJECT_WINDOW + 2);
    const breaks = clauseBreaks(text, regionStart, regionEnd);

    if (breaks.some((br) => br.start > a && br.start < b)) return false;
    let clauseStart = regionStart;
    let clauseEnd = regionEnd;
    for (const br of breaks) {
      if (br.end <= a && br.end > clauseStart) clauseStart = br.end;
      if (br.start >= b && br.start < clauseEnd) clauseEnd = br.start;
    }

    // "bumped LOG_BUDGET from 30 to 100": the change, discussed
    const current = entry.literal.current;
    if (
      current &&
      hasToken(text, current, Math.max(clauseStart, a - BEFORE_SUBJECT_WINDOW), Math.min(clauseEnd, b + AFTER_SUBJECT_WINDOW))
    ) {
      return false;
    }

    // "do not set LOG_BUDGET to 30", "LOG_BUDGET was 30"
    let scopeStart = Math.max(line.start, a - NEGATION_WINDOW);
    while (scopeStart > line.start && isWordCode(text.charCodeAt(scopeStart - 1))) scopeStart--;
    let negationStart = scopeStart;
    for (const m of text.slice(scopeStart, dead.start).matchAll(SOFT_SEPARATOR)) {
      const end = scopeStart + m.index! + m[0].length;
      if (end <= a) negationStart = Math.max(negationStart, end);
    }
    return !NEGATION.test(text.slice(negationStart, dead.start));
  }
}

function lineAround(text: string, start: number, end: number): Span {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  return { start: lineStart, end: newline === -1 ? text.length : newline };
}

/** The line, trimmed; for a long line, an excerpt around the value. */
function quoteLine(text: string, line: Span, at: number): string {
  const whole = text.slice(line.start, line.end).trim();
  if (whole.length <= MAX_LINE_LENGTH) return whole;
  const half = Math.floor(MAX_LINE_LENGTH / 2);
  const from = Math.max(line.start, at - half);
  const to = Math.min(line.end, from + MAX_LINE_LENGTH);
  return `${from > line.start ? '…' : ''}${text.slice(from, to).trim()}${to < line.end ? '…' : ''}`;
}

/**
 * Returns the lines of `text` that assert a tombstoned literal (one per
 * line). A one-off convenience over LiteralMatcher; scanning many literals
 * should compile one matcher.
 */
export function findLiteralHits(text: string, literal: TombstonedLiteral): string[] {
  return new LiteralMatcher([{ key: 0, literal }]).match(text, { allLines: true }).map((h) => h.line);
}
