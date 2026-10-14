/**
 * @stenographer/core/truth-format — the truth format without the ledger
 *
 * Everything a reader of truth streams needs and nothing that touches a
 * state file: the wiki codec and chain check, the status and standing
 * folds, the content hash a derivation pins premises by, the quorum rules,
 * the identity rules and signer registry, the literal matcher, the markers,
 * the consumption rules and JCS. Nothing in this module's import graph
 * loads better-sqlite3 (test/truth-format-subpath.test.ts holds it to
 * that), so a hosted app imports this subpath where the package root would
 * drag the SQLite driver in.
 */

export * from './truth/types.js';
export { TruthWriteError, ContemptError, NotarizationRequiredError } from './truth/errors.js';
export { canonicalize, sha256Hex, CanonicalizationError } from './truth/jcs.js';
export {
  deriveStatus,
  deriveStruck,
  deriveAll,
  recordedStatus,
  deriveStanding,
  premiseFailure,
  standingOf,
  type InboundLink,
  type DerivedState,
  type StandingNode,
  type DerivedStanding,
} from './truth/status.js';
export {
  contentHash,
  contentRecord,
  lineContentHash,
  premisesOf,
  premisesOfLine,
  pinnedPremises,
  citedPremises,
  type PremiseRef,
} from './truth/derivation.js';
export { LINE_ENVELOPE_FIELDS, LINE_BODY_FIELDS, OUTBOUND_LINKS, INBOUND_LINKS, MARKERS, displayStatus, markerFor } from './truth/format.js';
export {
  QUORUM_WINDOW_MS,
  QUORUM_MIN_MEMBERS,
  AGENT_PREFIX,
  checkQuorum,
  chooseQuorum,
  evidenceKey,
  evidenceRefKey,
  sameEvidence,
  trimWhiteSpace,
  quorumTime,
  hasAgentPrefix,
  literalSetKey,
  quorumEvidence,
  type AgentClassifier,
  type QuorumCandidate,
  type QuorumMember,
  type QuorumProgress,
  type QuorumSubject,
  type QuorumVerdict,
} from './truth/quorum.js';
export {
  SignerRegistry,
  SignerRegistryFileSchema,
  SignerKeySchema,
  IdentityError,
  resolveIdentity,
  agentClassifier,
  type SignerRegistryFile,
  type SignerRole,
} from './truth/identity.js';
export {
  LiteralMatcher,
  findLiteralHits,
  MatchDeadlineError,
  MAX_SCANNED_CHARS,
  type LiteralHit,
  type MatchOptions,
} from './truth/literal-matcher.js';
export { displayText } from './truth/display.js';
export {
  decodeWikiLine,
  checkWikiChain,
  wikiLineHash,
  wikiLineTexts,
  WikiLineError,
  WIKI_SCHEMA_VERSION,
  WIKI_STATUSES,
  CAUSE_KINDS,
  type CauseKind,
  type WikiLine,
  type DecodedWikiLine,
} from './truth/wiki-codec.js';
