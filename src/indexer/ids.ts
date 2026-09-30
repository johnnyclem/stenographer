/**
 * Stenographer — Deterministic ids
 * Ids for records derived from a log line are hashed from what produced
 * them, so re-processing the same line yields the same ids (and the same
 * rows) instead of fresh random ones.
 */

import { createHash } from 'node:crypto';

/**
 * `${prefix}_${128-bit hex}` over the given parts. Each part is
 * length-prefixed, so no two different part lists hash the same input.
 */
export function contentId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(`${part.length}:`);
    hash.update(part);
    hash.update('\0');
  }
  return `${prefix}_${hash.digest('hex').slice(0, 32)}`;
}
