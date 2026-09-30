/**
 * Stenographer — Importance Detector
 * Three-signal model for scoring message importance
 */

import type { ConversationMessage, ImportanceScore } from '../types.js';

// ─────────────────────────────────────────────────────────────
// Pattern-based extraction (Tier 0)
//
// Heuristic, and tuned for precision: patterns are anchored and applied one
// sentence at a time, to the prose of user and assistant turns only, and
// "X instead of Y" records X. test/fixtures/extraction-corpus.json holds
// the labeled turns its precision and recall floors are measured on.
// ─────────────────────────────────────────────────────────────

const APOS = "['\u2019]";

/** Choosing verbs a decision names, kept in the capture ("use postgres for …"). */
const CHOICE = '(?:use|go with|switch to|stick with|move to|migrate to|keep|implement)';

const DECISION_PATTERNS = [
  /\bwe(?:['\u2019]ve| have)? (?:decided|agreed|settled) (?:on|to|that) (.+)/i,
  new RegExp(`\\blet${APOS}?s (${CHOICE} .+)`, 'i'),
  new RegExp(`\\bi(?:${APOS}ll| will) (${CHOICE} .+)`, 'i'),
  /\b(?:the|our) (?:plan|decision) is (?:to )?(.+)/i,
];

/** Lead-ins that restate something as corrected: the capture is the current version. */
const CORRECTION_PATTERNS = [
  /^(?:(?:no|oh|ah|hmm|sorry|wait)[,.!]?\s+)*actually[,:]?\s+(.+)/i,
  /^(?:(?:no|oh)[,.!]?\s+)?i mean[,:]?\s+(.+)/i,
  /^correction[:,]?\s+(.+)/i,
  /^no[,.!]?\s+wait[,.!:\u2014\u2013-]*\s+(.+)/i,
  /^instead[,:]?\s+(.+)/i,
];

/** "no, wait" and "that's wrong" change state even when they carry nothing to record. */
const CORRECTION_SIGNALS = new RegExp(`^(?:no[,.!]?\\s+)?(?:wait\\b|that${APOS}?s (?:wrong|not right))`, 'i');

/** "not X but Y" — not "not only X but also Y". */
const NOT_BUT = /\bnot\s+(?!only\b|just\b|merely\b|even\b)(.+?),?\s+but\s+(?:rather\s+)?(.+)/i;

/** "X instead of Y", "X rather than Y": X is the choice. */
const INSTEAD_OF = /^(.+?),?\s+(?:instead of|rather than)\s+(.+)$/i;
/** "X, not Y". */
const COMMA_NOT = /^(.+?),\s+(?:and\s+)?not\s+(.+)$/i;

/**
 * First-person narration of tool use ("I'll use the Read tool to …",
 * "I'll use Grep to find …") — what the agent is about to do, not a choice
 * anyone made.
 */
const TOOL_NARRATION = [
  /^(?:use|go with) (?:the )?`?[\w.-]+`? (?:tool|command)\b/i,
  /^(?:use|go with) (?:the )?`?(?:read|grep|glob|bash|edit|multiedit|write|webfetch|websearch|task|todowrite|notebookedit|ls)`? to\b/i,
];

const MAX_ASSERTION_LENGTH = 200;
const MAX_ENTITY_LENGTH = 48;
const MAX_ENTITY_WORDS = 4;

/** Harness blocks inside a turn's text, which nobody in the conversation wrote. */
const HARNESS_BLOCK = /<(system-reminder|command-[a-z]+|local-command-[a-z]+)>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * The part of a message that can assert a decision or a correction: the
 * prose of a user or assistant turn, without fenced code, quoted lines or
 * harness blocks. Tool output, tagged records (harness bookkeeping,
 * subagent transcripts, compaction summaries) and system prompts assert
 * nothing: they return ''.
 */
export function assertableProse(message: ConversationMessage): string {
  if ((message.role !== 'user' && message.role !== 'assistant') || (message.tags?.length ?? 0) > 0) {
    return '';
  }
  return message.content
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(HARNESS_BLOCK, '\n')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

/** Sentences of prose, list markers and headings removed. */
function sentences(prose: string): string[] {
  const out: string[] = [];
  for (const line of prose.split(/\n+/)) {
    const body = line.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, '');
    for (const sentence of body.split(/(?<=[.!?])\s+(?=\S)/)) {
      const trimmed = sentence.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function clean(text: string): string {
  const trimmed = text.trim().replace(/[\s.!;:,]+$/, '');
  return trimmed.length > MAX_ASSERTION_LENGTH ? trimmed.slice(0, MAX_ASSERTION_LENGTH).trimEnd() : trimmed;
}

/** Splits "X instead of Y" / "X rather than Y" / "X, not Y" into the choice and what it rejects. */
function splitPolarity(text: string): { chosen: string; rejected: string } {
  const match = text.match(INSTEAD_OF) ?? text.match(COMMA_NOT);
  return match ? { chosen: clean(match[1]), rejected: clean(match[2]) } : { chosen: clean(text), rejected: '' };
}

function isAssertion(text: string): boolean {
  return /[a-z0-9]/i.test(text) && text.length >= 2;
}

export function extractEntities(content: string): string[] {
  const entities: string[] = [];
  for (const sentence of sentences(content)) {
    for (const pattern of ENTITY_PATTERNS) {
      const match = sentence.match(pattern);
      const name = match?.[1] ? entityName(match[1]) : null;
      if (name && !entities.includes(name)) entities.push(name);
    }
  }
  return entities;
}

const ENTITY_PATTERNS = [
  new RegExp(`\\bwe${APOS}?re using (.+?) (?:for|as)\\b`, 'i'),
  /^the (.+?) (?:is|are)\b/i,
  /\bset up (.+?) with\b/i,
  /\bconnected to (.+)/i,
];

/** Words that head a "the X is …" sentence without naming anything. */
const GENERIC_NOUNS = new Set([
  'problem', 'issue', 'fix', 'thing', 'question', 'idea', 'reason', 'goal', 'point', 'plan', 'decision',
  'answer', 'result', 'change', 'difference', 'catch', 'best way', 'only way', 'easiest way', 'good news',
  'bad news', 'rest', 'same', 'other', 'first', 'second', 'last', 'next step', 'main thing',
]);

/** A short entity name from a capture, or null: capped at a few words, cut at the first clause. */
function entityName(raw: string): string | null {
  const name = raw
    .split(/[,;:(]|\s(?:at|on|in|with|for|and|to|from|via|which|that|so|but)\s/i)[0]
    .replace(/^(?:the|a|an|our|my|your)\s+/i, '')
    .replace(/[\s.!?]+$/, '')
    .trim();
  if (!name || !/[a-z0-9]/i.test(name) || GENERIC_NOUNS.has(name.toLowerCase())) return null;
  if (name.length > MAX_ENTITY_LENGTH || name.split(/\s+/).length > MAX_ENTITY_WORDS) return null;
  return name;
}

export class ImportanceDetector {
  private weights = {
    stateDelta: 0.45,
    referenceFrequency: 0.25,
    trajectoryDiscontinuity: 0.30,
  };

  score(
    message: ConversationMessage,
    conversationHistory: ConversationMessage[]
  ): ImportanceScore {
    const stateDelta = this.computeStateDelta(message);
    const referenceFrequency = this.computeReferenceFrequency(message, conversationHistory);
    const trajectoryDiscontinuity = this.computeTrajectoryDiscontinuity(message, conversationHistory);

    const total =
      stateDelta * this.weights.stateDelta +
      referenceFrequency * this.weights.referenceFrequency +
      trajectoryDiscontinuity * this.weights.trajectoryDiscontinuity;

    return {
      total: Math.min(1, total),
      stateDelta,
      referenceFrequency,
      trajectoryDiscontinuity,
    };
  }

  private computeStateDelta(message: ConversationMessage): number {
    let score = 0;
    const extracted = extractStructure(message);

    // Decisions increase state delta
    if (extracted.decisions.length > 0) score += 0.5;

    // Corrections definitely change state
    if (
      extracted.corrections.length > 0 ||
      sentences(assertableProse(message)).some((s) => CORRECTION_SIGNALS.test(s))
    ) {
      score += 0.7;
    }

    // Tool calls indicate action
    if (message.toolCall || (message.toolCalls && message.toolCalls.length > 0)) {
      score += 0.3;
    }

    return Math.min(1, score);
  }

  private computeReferenceFrequency(
    message: ConversationMessage,
    history: ConversationMessage[]
  ): number {
    if (history.length === 0) return 0;

    // Extract entities from current message
    const entities = extractEntities(assertableProse(message));
    if (entities.length === 0) return 0;

    // Count references to these entities in prior messages
    let refCount = 0;
    const recentHistory = history.slice(-20); // Check last 20 messages

    for (const priorMsg of recentHistory) {
      for (const entity of entities) {
        if (priorMsg.content.toLowerCase().includes(entity.toLowerCase())) {
          refCount++;
        }
      }
    }

    // Normalize to 0-1
    return Math.min(1, refCount / 5);
  }

  private computeTrajectoryDiscontinuity(
    message: ConversationMessage,
    history: ConversationMessage[]
  ): number {
    if (history.length < 3) return 0;

    // Simple heuristic: topic shift indicators
    const shiftIndicators = [
      /\bmoving on\b/i,
      /\bby the way\b/i,
      /\bon a different note\b/i,
      /\bswitching topics\b/i,
      /^also,? /im,
      /\bnew question\b/i,
    ];

    const prose = assertableProse(message);
    for (const pattern of shiftIndicators) {
      if (pattern.test(prose)) {
        return 0.8;
      }
    }

    // Check message length vs rolling average (significant deviation can indicate direction change)
    const avgLength =
      history.slice(-5).reduce((sum, m) => sum + m.content.length, 0) / 5;
    const lengthRatio = message.content.length / avgLength;

    if (lengthRatio > 2 || lengthRatio < 0.3) {
      return 0.5;
    }

    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// Structured Extraction (for high-importance messages)
// ─────────────────────────────────────────────────────────────

export interface ExtractedStructure {
  entities: Array<{ name: string; type: string; value: string }>;
  decisions: string[];
  /**
   * `to` is the corrected, current statement; `from` what it replaces when
   * the sentence names it ("use X instead of Y", "X, not Y"), else ''.
   */
  corrections: Array<{ from: string; to: string; reason?: string }>;
}

/**
 * Tier 0 extraction. Each sentence of a turn's assertable prose yields at
 * most one assertion: a decision if a decision pattern matches (narration
 * of tool use excepted), otherwise a correction. Questions assert nothing.
 */
export function extractStructure(message: ConversationMessage): ExtractedStructure {
  const result: ExtractedStructure = {
    entities: [],
    decisions: [],
    corrections: [],
  };
  const prose = assertableProse(message);
  if (!prose.trim()) return result;

  for (const sentence of sentences(prose)) {
    if (sentence.endsWith('?')) continue;

    const decision = matchFirst(DECISION_PATTERNS, sentence);
    if (decision !== null) {
      const { chosen } = splitPolarity(decision);
      if (TOOL_NARRATION.some((re) => re.test(chosen))) continue;
      if (isAssertion(chosen) && !result.decisions.includes(chosen)) result.decisions.push(chosen);
      continue;
    }

    const correction = correctionOf(sentence);
    if (correction && isAssertion(correction.to) && !result.corrections.some((c) => c.to === correction.to)) {
      result.corrections.push(correction);
    }
  }

  result.entities = extractEntities(prose).map((e) => ({
    name: e,
    type: 'extracted',
    value: e,
  }));

  return result;
}

function matchFirst(patterns: RegExp[], sentence: string): string | null {
  for (const pattern of patterns) {
    const match = sentence.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function correctionOf(sentence: string): { from: string; to: string } | null {
  const led = matchFirst(CORRECTION_PATTERNS, sentence);
  if (led !== null) {
    const { chosen, rejected } = splitPolarity(led);
    return { from: rejected, to: chosen };
  }

  const notBut = sentence.match(NOT_BUT);
  if (notBut) {
    // "The budget is not 30 but 100" → "The budget is 100", replacing "The budget is 30"
    const prefix = sentence.slice(0, notBut.index);
    return { from: clean(prefix + notBut[1]), to: clean(prefix + notBut[2]) };
  }

  const insteadOf = sentence.match(INSTEAD_OF);
  if (insteadOf) return { from: clean(insteadOf[2]), to: clean(insteadOf[1]) };
  return null;
}
