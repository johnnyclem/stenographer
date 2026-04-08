/**
 * Stenographer — Importance Detector
 * Three-signal model for scoring message importance
 */

import type { ConversationMessage, ImportanceScore } from '../types.js';

// ─────────────────────────────────────────────────────────────
// Pattern-based extraction (Tier 0)
// ─────────────────────────────────────────────────────────────

const DECISION_PATTERNS = [
  /we (?:decided|agreed|settled) (?:on|to|that) (.+)/i,
  /let'?s (?:use|go with) (.+)/i,
  /i'?ll (?:use|implement) (.+)/i,
  /the (?:plan|decision) is (.+)/i,
];

const CORRECTION_PATTERNS = [
  /actually,? (.+)/i,
  /no,? (?:wait|that'?s wrong)/i,
  /i mean (.+)/i,
  /instead,? (.+)/i,
  /not (.+),? (?:but|rather) (.+)/i,
  /correction:? (.+)/i,
];

const ENTITY_PATTERNS = [
  /we'?re using (.+?) (?:for|as)/i,
  /the (.+?) is (.+)/i,
  /set up (.+?) with/i,
  /connected to (.+)/i,
];

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

    // Decisions increase state delta
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.test(message.content)) {
        score += 0.5;
        break;
      }
    }

    // Corrections definitely change state
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(message.content)) {
        score += 0.7;
        break;
      }
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
    const entities = this.extractEntities(message.content);
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
      /moving on/i,
      /by the way/i,
      /on a different note/i,
      /switching topics/i,
      /also,? (.+)/i,
      /new question/i,
    ];

    for (const pattern of shiftIndicators) {
      if (pattern.test(message.content)) {
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

  private extractEntities(content: string): string[] {
    const entities: string[] = [];

    for (const pattern of ENTITY_PATTERNS) {
      const match = content.match(pattern);
      if (match && match[1]) {
        entities.push(match[1].trim());
      }
    }

    return entities;
  }
}

// ─────────────────────────────────────────────────────────────
// Structured Extraction (for high-importance messages)
// ─────────────────────────────────────────────────────────────

export interface ExtractedStructure {
  entities: Array<{ name: string; type: string; value: string }>;
  decisions: string[];
  corrections: Array<{ from: string; to: string; reason?: string }>;
}

export function extractStructure(message: ConversationMessage): ExtractedStructure {
  const result: ExtractedStructure = {
    entities: [],
    decisions: [],
    corrections: [],
  };

  // Extract decisions
  for (const pattern of DECISION_PATTERNS) {
    const match = message.content.match(pattern);
    if (match && match[1]) {
      result.decisions.push(match[1].trim());
    }
  }

  // Extract corrections
  for (const pattern of CORRECTION_PATTERNS) {
    const match = message.content.match(pattern);
    if (match && match[1]) {
      result.corrections.push({ from: match[1].trim(), to: '' });
    }
  }

  // Extract entities
  result.entities = this.extractEntities(message.content).map((e) => ({
    name: e,
    type: 'extracted',
    value: e,
  }));

  return result;
}
