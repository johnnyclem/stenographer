/**
 * Stenographer — the decision adviser
 *
 * The decision model's verdicts, and how they are scored. Every verdict is
 * recorded here, beside the ledger and the objection log, as operational
 * state: it never enters the record. Two kinds:
 *
 * - **An objection's second opinion.** When the literal matcher raises an
 *   objection, the adviser asks the model whether the assistant asserted
 *   the dead value as current truth (state.ts objectionQuestions), with the
 *   tombstone, the ledger entries that bear on the line and the session's
 *   recent transcript in front of it. The verdict rides on the objection
 *   (`advice`) for whoever reads it. When a person rules — sustained or
 *   overruled — the verdict is graded against the ruling: a guess that
 *   matched is **rewarded**, one that did not is **corrected** with the
 *   ruling as the truth. The person's ruling is what it always was; the
 *   model's guess changes nothing about it.
 * - **A consult.** An agent asks before asserting (`consult_decision_model`)
 *   whether an assertion contradicts the ledger, and which entry. The
 *   verdict is recorded (ungraded) so the operator can see what agents ask
 *   and what the model says.
 *
 * Graded verdicts are the training signal: `export()` writes them as JSONL
 * rows (state, questions, the model's answers, the ruling's truth) for
 * fine-tuning a decision model on this team's corpus, and `stats()` says
 * how often the model agrees with the judge.
 */

import type Database from 'better-sqlite3';
import { ulid } from '../truth/types.js';
import { DecisionModelError, type DecisionModelClient, type DecisionQuestion, type DecisionResult } from './model.js';
import { buildDecisionState, objectionQuestions, type DecisionState, type TranscriptSource } from './state.js';
import type { Objection } from '../truth/objections.js';
import type { TbEntry, UvEntry } from '../truth/types.js';

export type AdviceKind = 'objection' | 'consult';
export type AdviceGrade = 'rewarded' | 'corrected';

/** One verdict the model gave. */
export interface DecisionAdvice {
  id: string;
  createdAt: string;
  kind: AdviceKind;
  /** The objection (kind objection) or a caller-chosen key (kind consult) it is about */
  subjectId: string;
  sessionId: string | null;
  /** The model's name and the model that answered */
  adviser: string;
  model: string;
  /** The adviser's answer, by question */
  answers: DecisionResult['answers'];
  /** For an objection: P(the dead value is asserted as current truth) */
  reasserts: number | null;
  /** For a consult: P(contradicts) and the entry cited */
  contradicts: number | null;
  cites: string | null;
  elapsedMs: number;
  /** Set once a person ruled: how the verdict compared with the ruling */
  grade: AdviceGrade | null;
  /** The ruling the grade came from */
  rulingId: string | null;
  /** What the person said (`sustained`/`overruled`) */
  truth: string | null;
  gradedAt: string | null;
  /** Set when the model gave no usable answer: the error code */
  error: string | null;
}

export interface AdviceStats {
  /** Verdicts recorded, by kind */
  objections: number;
  consults: number;
  /** Objection verdicts a person has ruled on */
  graded: number;
  rewarded: number;
  corrected: number;
  /** rewarded / graded; null until something is graded */
  accuracy: number | null;
  /** Requests that got no usable answer */
  errors: number;
}

/** One line of the training export. */
export interface AdviceExportRow {
  id: string;
  kind: AdviceKind;
  createdAt: string;
  adviser: string;
  model: string;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  answers: DecisionResult['answers'];
  grade: AdviceGrade | null;
  /** The expected answers, from the ruling: `reasserts` true when sustained */
  truth: Record<string, unknown> | null;
}

/** The threshold at which a `reasserts` probability reads as "yes". */
export const ADVICE_YES = 0.5;

export function ensureAdviceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_advice (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      session_id TEXT,
      adviser TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL,
      questions TEXT NOT NULL,
      answers TEXT NOT NULL,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      grade TEXT,
      ruling_id TEXT,
      truth TEXT,
      graded_at TEXT,
      UNIQUE(kind, subject_id)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_advice_subject ON decision_advice(subject_id);
  `);
}

/** How a `reasserts` probability compares with a ruling. */
export function gradeReassertion(reasserts: number | null, outcome: 'sustained' | 'overruled'): AdviceGrade | null {
  if (reasserts === null) return null;
  const said = reasserts >= ADVICE_YES;
  return said === (outcome === 'sustained') ? 'rewarded' : 'corrected';
}

export class DecisionAdviser {
  readonly client: DecisionModelClient;
  private db: Database.Database;

  constructor(db: Database.Database, client: DecisionModelClient) {
    this.db = db;
    this.client = client;
    ensureAdviceSchema(db);
  }

  /**
   * Ask the model about an objection and record its verdict (once per
   * objection; asking again returns what was recorded). An error from the
   * model is recorded too, with no verdict, so the objection stands as the
   * matcher raised it.
   */
  async adviseObjection(input: {
    objection: Objection;
    entries: Array<TbEntry | UvEntry>;
    messages: TranscriptSource[];
    signal?: AbortSignal;
  }): Promise<DecisionAdvice> {
    const existing = this.forSubject('objection', input.objection.id);
    if (existing) return existing;
    const o = input.objection;
    const state = buildDecisionState({
      assertion: o.transcriptLine,
      source: o.source,
      session: o.sessionId,
      entries: input.entries,
      messages: input.messages,
      about: o.tbId,
    });
    return this.ask('objection', o.id, o.sessionId, state, objectionQuestions(), input.signal);
  }

  /** Ask the model a consult question set and record the verdict under `subjectId`. */
  async consult(input: {
    subjectId: string;
    sessionId: string | null;
    state: DecisionState;
    questions: Record<string, DecisionQuestion>;
    signal?: AbortSignal;
  }): Promise<DecisionAdvice> {
    return this.ask('consult', input.subjectId, input.sessionId, input.state, input.questions, input.signal);
  }

  private async ask(
    kind: AdviceKind,
    subjectId: string,
    sessionId: string | null,
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal?: AbortSignal
  ): Promise<DecisionAdvice> {
    const id = ulid();
    const createdAt = new Date().toISOString();
    let result: DecisionResult | null = null;
    let error: string | null = null;
    try {
      result = await this.client.decide(state, questions, signal);
    } catch (err) {
      error = err instanceof DecisionModelError ? err.code : 'NETWORK';
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO decision_advice
           (id, created_at, kind, subject_id, session_id, adviser, model, state, questions, answers, elapsed_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        kind,
        subjectId,
        sessionId,
        this.client.name,
        result?.model ?? this.client.model,
        JSON.stringify(state),
        JSON.stringify(questions),
        JSON.stringify(result?.answers ?? {}),
        result?.elapsedMs ?? 0,
        error
      );
    return this.forSubject(kind, subjectId)!;
  }

  /** The verdict recorded for an objection or a consult key, or null. */
  forSubject(kind: AdviceKind, subjectId: string): DecisionAdvice | null {
    const row = this.db.prepare('SELECT * FROM decision_advice WHERE kind = ? AND subject_id = ?').get(kind, subjectId) as any;
    return row ? rowToAdvice(row) : null;
  }

  /** The verdicts recorded for these objections, by objection id. */
  forObjections(ids: string[]): Map<string, DecisionAdvice> {
    const out = new Map<string, DecisionAdvice>();
    if (ids.length === 0) return out;
    const stmt = this.db.prepare('SELECT * FROM decision_advice WHERE kind = ? AND subject_id = ?');
    for (const id of ids) {
      const row = stmt.get('objection', id) as any;
      if (row) out.set(id, rowToAdvice(row));
    }
    return out;
  }

  /**
   * A person ruled on an objection: grade the verdict against the ruling.
   * Returns the graded verdict, or null when none was recorded (the model
   * was never asked, or gave no answer: nothing to grade).
   */
  grade(objectionId: string, outcome: 'sustained' | 'overruled', rulingId: string): DecisionAdvice | null {
    const advice = this.forSubject('objection', objectionId);
    if (!advice || advice.grade !== null) return advice;
    const grade = gradeReassertion(advice.reasserts, outcome);
    if (grade === null) return advice;
    this.db
      .prepare('UPDATE decision_advice SET grade = ?, ruling_id = ?, truth = ?, graded_at = ? WHERE id = ?')
      .run(grade, rulingId, outcome, new Date().toISOString(), advice.id);
    return this.forSubject('objection', objectionId);
  }

  list(options: { kind?: AdviceKind; graded?: boolean; limit?: number; since?: string } = {}): DecisionAdvice[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.kind) {
      where.push('kind = ?');
      params.push(options.kind);
    }
    if (options.graded === true) where.push('grade IS NOT NULL');
    if (options.graded === false) where.push('grade IS NULL');
    if (options.since) {
      where.push('id > ?');
      params.push(options.since);
    }
    params.push(options.limit ?? 100);
    return (this.db.prepare(`SELECT * FROM decision_advice ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`).all(...params) as any[]).map(rowToAdvice);
  }

  stats(): AdviceStats {
    const rows = this.db.prepare('SELECT kind, grade, error IS NOT NULL AS failed, COUNT(*) c FROM decision_advice GROUP BY kind, grade, failed').all() as Array<{
      kind: AdviceKind;
      grade: AdviceGrade | null;
      failed: number;
      c: number;
    }>;
    const stats: AdviceStats = { objections: 0, consults: 0, graded: 0, rewarded: 0, corrected: 0, accuracy: null, errors: 0 };
    for (const r of rows) {
      if (r.kind === 'objection') stats.objections += r.c;
      else stats.consults += r.c;
      if (r.failed) stats.errors += r.c;
      if (r.grade === 'rewarded') stats.rewarded += r.c;
      if (r.grade === 'corrected') stats.corrected += r.c;
    }
    stats.graded = stats.rewarded + stats.corrected;
    stats.accuracy = stats.graded > 0 ? stats.rewarded / stats.graded : null;
    return stats;
  }

  /** Verdicts as training rows: graded objections by default, everything with `all`. */
  export(options: { all?: boolean } = {}): AdviceExportRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM decision_advice WHERE error IS NULL ${options.all ? '' : "AND grade IS NOT NULL"} ORDER BY id ASC`)
      .all() as any[];
    return rows.map((row) => {
      const advice = rowToAdvice(row);
      return {
        id: advice.id,
        kind: advice.kind,
        createdAt: advice.createdAt,
        adviser: advice.adviser,
        model: advice.model,
        state: JSON.parse(row.state),
        questions: JSON.parse(row.questions),
        answers: advice.answers,
        grade: advice.grade,
        truth: advice.truth === null ? null : { reasserts: advice.truth === 'sustained' },
      };
    });
  }
}

function rowToAdvice(row: any): DecisionAdvice {
  const answers = JSON.parse(row.answers) as DecisionResult['answers'];
  const reasserts = answers.reasserts?.type === 'noul' ? answers.reasserts.noul : null;
  const contradicts = answers.contradicts?.type === 'noul' ? answers.contradicts.noul : null;
  const cites = answers.cites?.type === 'choice' ? answers.cites.choice : null;
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    subjectId: row.subject_id,
    sessionId: row.session_id ?? null,
    adviser: row.adviser,
    model: row.model,
    answers,
    reasserts,
    contradicts,
    cites: cites === '__none__' ? null : cites,
    elapsedMs: row.elapsed_ms,
    grade: row.grade ?? null,
    rulingId: row.ruling_id ?? null,
    truth: row.truth ?? null,
    gradedAt: row.graded_at ?? null,
    error: row.error ?? null,
  };
}
