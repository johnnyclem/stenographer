/**
 * Stenographer — Identities and the signer registry
 *
 * Who a write is attributed to is decided by the server, not the caller:
 * - Agent-profile MCP writes carry the identity the server was started
 *   with (`--agent-identity`, default `agent:<MCP client name>`). Tool
 *   arguments cannot name anyone.
 * - Operator paths (the operator MCP profile, REST notary routes, the
 *   terminal notary) take the signer's name from the caller — they are
 *   the person's own tools — and check it here: canonicalized, never
 *   anonymous or reserved, and, when the operator configures a signer
 *   registry, listed in it with a role that may perform the act.
 *
 * The registry is an allowlist of names and roles, not a credential
 * store: it stops typos, impersonation of unlisted people, and agents
 * signing as humans on paths that check roles. It does not authenticate
 * anyone — whoever can reach an operator path can use any listed human's
 * name (see the README's threat model).
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { TruthWriteError } from './ledger.js';
import { hasAgentPrefix, type AgentClassifier } from './quorum.js';
import {
  canonicalIdentity,
  identityKey,
  isAnonymousIdentity,
  isReservedIdentity,
  hasControlCharacters,
  MIGRATION_AUTHOR,
  DETECTOR_PREFIX,
} from './types.js';

export type SignerRole = 'human' | 'agent' | 'detector';

/** An identity failed validation: anonymous, reserved, unregistered, or the wrong role. */
export class IdentityError extends TruthWriteError {}

/**
 * A signer's public key. Reserved for key signing in 1.x: 1.0 checks the
 * shape and otherwise ignores it, so a registry that lists keys loads on a
 * 1.0 install. Nothing else goes in it: a registry never holds a private key.
 */
export const SignerKeySchema = z
  .object({
    /** The signature algorithm, e.g. `ed25519`. */
    alg: z.string().min(1),
    /** Names this key among the signer's keys, so a signature can say which one it used. */
    id: z.string().min(1),
    publicKey: z.string().min(1),
  })
  .strict();

export const SignerRegistryFileSchema = z
  .object({
    signers: z.array(
      z
        .object({
          /** The canonical handle. A trailing `*` (e.g. `agent:*`) matches any identity with that prefix. */
          id: z.string().min(1),
          role: z.enum(['human', 'agent', 'detector']),
          /** Other spellings that resolve to `id` (e.g. a short handle). */
          aliases: z.array(z.string().min(1)).optional(),
          /** Public keys for 1.x key signing: accepted and ignored in 1.0. */
          keys: z.array(SignerKeySchema).optional(),
        })
        .strict()
    ),
  })
  .strict();
export type SignerRegistryFile = z.infer<typeof SignerRegistryFileSchema>;

interface RegisteredSigner {
  id: string;
  role: SignerRole;
}

export class SignerRegistry {
  private exact = new Map<string, RegisteredSigner>();
  private prefixes: Array<{ prefix: string; role: SignerRole }> = [];

  constructor(file: SignerRegistryFile) {
    const result = SignerRegistryFileSchema.safeParse(file);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new Error(`invalid signer registry — ${issues}`);
    }
    for (const signer of result.data.signers) {
      const id = canonicalIdentity(signer.id);
      if (id.endsWith('*')) {
        this.prefixes.push({ prefix: identityKey(id.slice(0, -1)), role: signer.role });
        continue;
      }
      for (const name of [id, ...(signer.aliases ?? [])]) {
        const key = identityKey(name);
        const prior = this.exact.get(key);
        if (prior && prior.id !== id) {
          throw new Error(`signer registry: '${name}' names both '${prior.id}' and '${id}'`);
        }
        this.exact.set(key, { id, role: signer.role });
      }
    }
    // Longest prefix wins, so `agent:ci:*` can narrow `agent:*`
    this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /** Reads a registry file (JSON: `{"signers": [{"id", "role", "aliases?", "keys?"}]}`). */
  static load(source: string | SignerRegistryFile): SignerRegistry {
    if (typeof source !== 'string') return new SignerRegistry(source);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(source, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read signer registry ${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return new SignerRegistry(raw as SignerRegistryFile);
  }

  /** The registered signer an identity resolves to, or null when it isn't listed. */
  lookup(identity: string): RegisteredSigner | null {
    const key = identityKey(identity);
    const exact = this.exact.get(key);
    if (exact) return exact;
    const match = this.prefixes.find((p) => key.startsWith(p.prefix) && key.length > p.prefix.length);
    return match ? { id: canonicalIdentity(identity), role: match.role } : null;
  }
}

/**
 * Validates an identity for an act that `roles` may perform and returns
 * its canonical form (the registry's spelling when registered). `what`
 * names the identity in error messages ("signer", "the agent identity").
 */
export function resolveIdentity(
  raw: string,
  roles: SignerRole[],
  what: string,
  registry?: SignerRegistry | null
): string {
  if (typeof raw !== 'string' || isAnonymousIdentity(raw)) {
    throw new IdentityError(
      `${what} '${raw}' is not an accountable identity — anonymous or generic identities are rejected`
    );
  }
  if (hasControlCharacters(raw)) {
    throw new IdentityError(`${what} contains control characters`);
  }
  if (isReservedIdentity(raw)) {
    throw new IdentityError(
      `${what} '${raw}' is reserved: '${MIGRATION_AUTHOR}' and '${DETECTOR_PREFIX}*' belong to the backfill and detector paths`
    );
  }
  const identity = canonicalIdentity(raw);
  if (!registry) return identity;

  const signer = registry.lookup(identity);
  if (!signer) {
    throw new IdentityError(`${what} '${identity}' is not in the signer registry`);
  }
  if (!roles.includes(signer.role)) {
    throw new IdentityError(
      `${what} '${signer.id}' is registered as ${withArticle(signer.role)}; this needs ${roles.map(withArticle).join(' or ')}`
    );
  }
  return signer.id;
}

function withArticle(role: SignerRole): string {
  return role === 'agent' ? 'an agent' : `a ${role}`;
}

/**
 * Who is an agent, for the agent quorum (spec/truth-format, "Agent quorum"):
 * the role a signer registry lists, and, for an identity it doesn't list or
 * without one, the `agent:` prefix. `agentIdentities` are agents whatever
 * their spelling: the identity a server binds its agent-profile writes to,
 * which `--agent-identity` may set to a name without the prefix.
 */
export function agentClassifier(registry: SignerRegistry | null, agentIdentities: Array<string | undefined> = []): AgentClassifier {
  const own = new Set(agentIdentities.filter((id): id is string => typeof id === 'string').map(identityKey));
  return (identity) => {
    if (own.has(identityKey(identity))) return true;
    const listed = registry?.lookup(identity);
    return listed ? listed.role === 'agent' : hasAgentPrefix(identity);
  };
}
