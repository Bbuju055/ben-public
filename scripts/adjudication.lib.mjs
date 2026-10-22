// adjudication.lib — shared manual-criterion records, identities and rendering.
// Zero dependencies. Node only.
//
// This module owns: the record validator, the TOTAL identity comparator,
// the governing selection, the record digest and adjudicationsSha,
// the approval-relevant ledger digest, the canonical PR-body
// comparison and the pure in-memory PR-body renderer, and the one
// repo-context derivation. Every consumer (run.mjs, ledger.mjs,
// verify.mjs, pr.mjs) imports these functions — never a re-implementation.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HEX64 = /^[0-9a-f]{64}$/;
const INERT_KINDS = ['adjudication', 'publication'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Failed transport output is evidence, never a verdict (including legacy raw files). */
export function readReviewOutput(path) {
  const abstainPath = path.endsWith('.json') ? path.slice(0, -5) + '.abstain.txt' : path + '.abstain.txt';
  if (existsSync(abstainPath)) throw new Error('reviewer abstained');
  const raw = readFileSync(path, 'utf8');
  if (JSON.parse(raw)?.type === 'reviewer-abstain') throw new Error('reviewer abstained');
  return raw;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isBlank(v) {
  return typeof v !== 'string' || v.trim().length === 0;
}

/** Canonical deep serialization: sorted object keys, undefined members skipped. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// the record, the TOTAL identity model, and the governing selection

/** The pinned criterion-identity formula. */
export function criterionShaOf(criterion) {
  return sha256(JSON.stringify(['ben-adjudication-v1', criterion]));
}

const RECORD_FIELDS = ['type', 'criterionId', 'criterionSha', 'criterion', 'approvalActSha', 'headSha', 'decision', 'ruling', 'residual', 'basis', 'basisEntry', 'by', 'at'];
const BASIS_FIELDS = ['kind', 'round', 'fingerprint', 'action'];

/** Exact-shape validator — anything not this shape is rejected before comparison. */
export function validateAdjudicationRecord(r) {
  const issues = [];
  if (!isObj(r)) return ['record: expected an object'];
  for (const k of Object.keys(r)) {
    if (!RECORD_FIELDS.includes(k)) issues.push(`unknown field "${k}"`);
  }
  if (r.type !== 'adjudication') issues.push('type: must be the literal "adjudication"');
  if (isBlank(r.criterionId)) issues.push('criterionId: expected a non-empty string');
  if (typeof r.criterionSha !== 'string' || !HEX64.test(r.criterionSha)) issues.push('criterionSha: expected 64 hex chars');
  if (!isObj(r.criterion)) issues.push('criterion: expected the complete criterion object, verbatim');
  else if (typeof r.criterionSha === 'string' && HEX64.test(r.criterionSha) && criterionShaOf(r.criterion) !== r.criterionSha) {
    issues.push('criterionSha does not recompute from the embedded criterion — tampering, fail closed');
  }
  if (isObj(r.criterion) && !isBlank(r.criterionId) && r.criterion.id !== r.criterionId) issues.push('criterionId does not match the embedded criterion id');
  if (typeof r.approvalActSha !== 'string' || !HEX64.test(r.approvalActSha)) issues.push('approvalActSha: expected 64 hex chars');
  if (isBlank(r.headSha)) issues.push('headSha: expected a non-empty string');
  if (r.decision !== 'satisfied' && r.decision !== 'accepted') issues.push('decision: expected "satisfied" or "accepted"');
  if (isBlank(r.ruling)) issues.push('ruling: expected the operator\'s words, non-blank');
  if (r.decision === 'accepted' && isBlank(r.residual)) issues.push('residual: required non-blank for an accepted decision');
  if (r.decision === 'satisfied' && r.residual !== undefined) issues.push('residual: forbidden for a satisfied decision');
  if (r.basis !== undefined) {
    if (!isObj(r.basis)) issues.push('basis: expected an object');
    else {
      for (const k of Object.keys(r.basis)) if (!BASIS_FIELDS.includes(k)) issues.push(`basis: unknown field "${k}"`);
      if (r.basis.kind !== 'plan' && r.basis.kind !== 'diff') issues.push('basis.kind: expected "plan" or "diff"');
      if (!Number.isInteger(r.basis.round) || r.basis.round < 0) issues.push('basis.round: expected a non-negative integer');
      if (isBlank(r.basis.fingerprint)) issues.push('basis.fingerprint: expected a non-empty string');
      if (isBlank(r.basis.action)) issues.push('basis.action: expected a non-empty string');
    }
    if (!isObj(r.basisEntry)) issues.push('basisEntry: required verbatim ledger entry when basis is present');
    else if (isObj(r.basis)) {
      for (const k of BASIS_FIELDS) {
        if (r.basisEntry[k] !== r.basis[k]) issues.push(`basisEntry.${k} does not match basis.${k} — the embedded entry must be the cited one`);
      }
    }
  } else if (r.basisEntry !== undefined) {
    issues.push('basisEntry: forbidden without basis');
  }
  if (isBlank(r.by)) issues.push('by: expected a non-empty string');
  if (!isValidTimestamp(r.at)) issues.push('at: expected a valid ISO-8601 timestamp string');
  return issues;
}

// the strict timestamp shape: date-time with optional fractional seconds and an
// explicit zone (Z or offset) — what toISOString produces, nothing looser
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Exact frozen-format + REAL-calendar validity: Date.parse alone normalizes
 * impossible dates (2026-02-30 becomes March 2nd), so every field is
 * range-checked and the day is checked against the actual month length.
 */
export function isValidTimestamp(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_TIMESTAMP_RE.exec(s);
  if (m === null) return false;
  const [, y, mo, d, h, mi, se, , zone] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > new Date(Date.UTC(Number(y), month, 0)).getUTCDate()) return false; // real month length
  if (Number(h) > 23 || Number(mi) > 59 || Number(se) > 59) return false;
  if (zone !== 'Z') {
    const zm = /^[+-](\d{2}):(\d{2})$/.exec(zone);
    if (zm === null || Number(zm[1]) > 23 || Number(zm[2]) > 59) return false;
  }
  return !Number.isNaN(Date.parse(s));
}

/** binding = decision, criterionSha, approvalActSha, + headSha iff satisfied. */
export function recordBindingKey(r) {
  return stableStringify([r.decision, r.criterionSha, r.approvalActSha, r.decision === 'satisfied' ? r.headSha : null]);
}

/** content = ruling, residual, basis + basisEntry, criterion, by. */
export function recordContentKey(r) {
  return stableStringify([r.ruling, r.residual ?? null, r.basis ?? null, r.basisEntry ?? null, r.criterion, r.by]);
}

/**
 * The trivially total comparator: every pair of valid records falls in exactly
 * one of replay | conflict | coexistence. Context (`at`, accepted's headSha)
 * never participates.
 */
export function classifyRecords(a, b) {
  if (recordBindingKey(a) !== recordBindingKey(b)) return 'coexistence';
  return recordContentKey(a) === recordContentKey(b) ? 'replay' : 'conflict';
}

/**
 * The record digest — the intent key, the ledger audit fingerprint, and the
 * adjudicationsSha input. Binding + content ONLY: replicas share one digest.
 */
export function recordDigest(r) {
  return sha256(stableStringify(['ben-adjudication-digest-v1', recordBindingKey(r), recordContentKey(r)]));
}

/**
 * ACTIVE/governing — a pure computation over the register (≤1 per criterion).
 * Throws on tampered/conflicting records (fail-closed at read). `getHeadSha`
 * is invoked only when a satisfied record needs eligibility checking.
 */
/** The ONE conflict detector over a record set: same binding + different content throws. */
export function assertNoRegisterConflicts(records) {
  const byBinding = new Map();
  for (const r of records) {
    const bk = recordBindingKey(r);
    const prior = byBinding.get(bk);
    if (prior !== undefined && recordContentKey(prior) !== recordContentKey(r)) {
      throw new Error(`conflicting adjudication records for ${r.criterionId}: same binding identity, different content — a changed decision needs new bytes under a new binding`);
    }
    if (prior === undefined) byBinding.set(bk, r);
  }
}

export function governingSelection(records, { criteriaDoc, approvalBytes, getHeadSha }) {
  for (const r of records) {
    const issues = validateAdjudicationRecord(r);
    if (issues.length > 0) throw new Error(`invalid adjudication record (${r?.criterionId ?? '?'}): ${issues.join('; ')}`);
  }
  // conflicts fail closed before any selection
  assertNoRegisterConflicts(records);
  const approvalActSha = approvalBytes === undefined ? undefined : sha256(approvalBytes);
  const criteriaById = new Map();
  if (isObj(criteriaDoc) && Array.isArray(criteriaDoc.criteria)) {
    for (const c of criteriaDoc.criteria) if (isObj(c) && typeof c.id === 'string') criteriaById.set(c.id, c);
  }
  // replicas collapse to one act per digest; representative = earliest `at`, ties by array order
  const byDigest = new Map();
  for (const r of records) {
    const d = recordDigest(r);
    const prior = byDigest.get(d);
    // earliest `at` (numeric, offset-safe); equal `at` keeps array order
    if (prior === undefined || Date.parse(r.at) < Date.parse(prior.at)) byDigest.set(d, r);
  }
  let headNow;
  const headSha = () => {
    if (headNow === undefined) headNow = getHeadSha();
    return headNow;
  };
  const governing = new Map();
  for (const r of byDigest.values()) {
    if (approvalActSha === undefined || r.approvalActSha !== approvalActSha) continue; // absent approval → nothing governs
    const current = criteriaById.get(r.criterionId);
    if (current === undefined || criterionShaOf(current) !== r.criterionSha) continue; // criterion revised → historical
    if (r.decision === 'satisfied' && r.headSha !== headSha()) continue; // satisfied binds the checked HEAD
    const held = governing.get(r.criterionId);
    if (held === undefined || (held.decision === 'accepted' && r.decision === 'satisfied')) governing.set(r.criterionId, r);
  }
  return governing;
}

/** sha256 of the canonical governing set (sorted by criterionId, digests only); 'NONE' when empty. */
export function adjudicationsShaOf(governing) {
  const entries = [...governing.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, r]) => [id, recordDigest(r)]);
  if (entries.length === 0) return 'NONE';
  return sha256(JSON.stringify(entries));
}

// ---------------------------------------------------------------------------
// register ⇄ ledger cross-check (the ledger is the history authority)

/** Ledger rows that carry adjudication acts, with their embedded records. */
export function ledgerAdjudicationRecords(ledgerEntries) {
  return ledgerEntries.filter((e) => isObj(e) && e.kind === 'adjudication').map((e) => e.record);
}

/**
 * State/ledger divergence — in EITHER direction — throws. A replica is
 * legitimate only when its complete record (context included) also exists in
 * ledger history.
 */
export function checkRegisterAgainstLedger(records, ledgerEntries) {
  const ledgerSet = new Set(ledgerAdjudicationRecords(ledgerEntries).map((r) => stableStringify(r)));
  const registerSet = new Set(records.map((r) => stableStringify(r)));
  for (const r of records) {
    if (!ledgerSet.has(stableStringify(r))) {
      throw new Error(`adjudications.json holds a record for ${r?.criterionId ?? '?'} whose complete record is absent from ledger history — state/ledger divergence`);
    }
  }
  for (const key of ledgerSet) {
    if (!registerSet.has(key)) {
      throw new Error('the ledger holds an adjudication act absent from adjudications.json — state/ledger divergence (half-applied dual write)');
    }
  }
}

/**
 * One-stop derivation for consumers: reads adjudications.json, validates,
 * cross-checks against the ledger, selects governing, digests. Throws on any
 * malformed/tampered/conflicting/divergent state.
 */
export function deriveAdjudication({ stateDir, ledgerEntries, criteriaDoc, approvalBytes, getHeadSha }) {
  const path = join(stateDir, 'adjudications.json');
  let records = [];
  if (existsSync(path)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`adjudications.json is unreadable JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(parsed)) throw new Error('adjudications.json must be a JSON array of adjudication records');
    records = parsed;
  }
  for (const r of records) {
    const issues = validateAdjudicationRecord(r);
    if (issues.length > 0) throw new Error(`invalid adjudication record (${isObj(r) ? (r.criterionId ?? '?') : '?'}): ${issues.join('; ')}`);
  }
  // the shared consumption boundary: no audit row contributes authority until
  // its complete wrapper validates
  assertInertAuditRows(ledgerEntries);
  checkRegisterAgainstLedger(records, ledgerEntries);
  // read-time provenance: every cited basis must be the exact historical
  // entry, present and unique in ledger history
  assertBasisProvenance(records, ledgerEntries);
  const governing = governingSelection(records, { criteriaDoc, approvalBytes, getHeadSha });
  return { records, governing, digest: adjudicationsShaOf(governing) };
}

// ---------------------------------------------------------------------------
// the approval-relevant ledger digest

const AUDIT_ENTRY_FIELDS = ['ts', 'kind', 'round', 'reviewer', 'blockerId', 'fingerprint', 'action', 'detail', 'record', 'publication'];
const PUBLICATION_FIELDS = ['url', 'headRefOid', 'bodySha', 'remoteUpdatedAt', 'observedAt', 'by'];

/** The canonical one-line summaries — the ONLY legal detail for audit rows; a wrapper can never contradict its payload. */
export function adjudicationDetail(record) {
  return `${record.by} adjudicated ${record.criterionId} ${record.decision}: ${record.ruling}`;
}
export function publicationDetail(p) {
  return `publication attested: ${p.url} @ ${p.headRefOid} body ${p.bodySha} remote-updated ${p.remoteUpdatedAt} observed ${p.observedAt} by ${p.by}`;
}

/**
 * Exact-shape check for the inert audit kinds — the COMPLETE wrapper, not just
 * the embedded payload: unknown fields, cross-field identity (fingerprint =
 * digest, blockerId = criterionId, reviewer = actor) all bind. A failing inert
 * row is a STOP wherever it is consumed, never a silent exclusion.
 */
export function validateAuditEntry(e) {
  const issues = [];
  if (!isObj(e)) return ['entry: expected an object'];
  for (const k of Object.keys(e)) {
    if (!AUDIT_ENTRY_FIELDS.includes(k)) issues.push(`unknown field "${k}"`);
  }
  if (e.round !== 0) issues.push('round: audit entries carry round 0');
  if (isBlank(e.reviewer)) issues.push('reviewer: expected a non-empty string');
  if (typeof e.fingerprint !== 'string' || !HEX64.test(e.fingerprint)) issues.push('fingerprint: expected 64 hex chars');
  if (typeof e.detail !== 'string') issues.push('detail: expected a string');
  if (!isValidTimestamp(e.ts)) issues.push('ts: expected a valid ISO-8601 timestamp string');
  if (e.kind === 'adjudication') {
    if (e.action !== 'adjudicated') issues.push('action: adjudication entries carry action "adjudicated"');
    if (isBlank(e.blockerId)) issues.push('blockerId: expected the criterion id');
    if (e.publication !== undefined) issues.push('publication: forbidden on an adjudication entry');
    const recIssues = validateAdjudicationRecord(e.record);
    if (recIssues.length > 0) issues.push(`record: ${recIssues.join('; ')}`);
    else {
      if (recordDigest(e.record) !== e.fingerprint) issues.push('fingerprint does not equal the embedded record\'s digest');
      if (e.record.criterionId !== e.blockerId) issues.push('blockerId does not match the embedded record\'s criterionId');
      if (e.record.by !== e.reviewer) issues.push('reviewer does not match the embedded record\'s actor (by)');
      // the wrapper may never contradict its payload: only the canonical summary is legal
      if (typeof e.detail === 'string' && e.detail !== adjudicationDetail(e.record)) {
        issues.push('detail does not equal the canonical summary of the embedded record — a wrapper cannot contradict its payload');
      }
    }
  } else if (e.kind === 'publication') {
    if (e.action !== 'attested') issues.push('action: publication entries carry action "attested"');
    if (e.record !== undefined) issues.push('record: forbidden on a publication entry');
    if (e.blockerId !== '') issues.push('blockerId: publication entries carry an empty blockerId');
    const p = e.publication;
    if (!isObj(p)) issues.push('publication: expected the structured observation object');
    else {
      for (const k of Object.keys(p)) {
        if (!PUBLICATION_FIELDS.includes(k)) issues.push(`publication: unknown field "${k}"`);
      }
      for (const k of PUBLICATION_FIELDS) {
        if (isBlank(p[k])) issues.push(`publication.${k}: expected a non-empty string`);
      }
      if (!isValidTimestamp(p.observedAt)) issues.push('publication.observedAt: expected a valid ISO-8601 timestamp string');
      if (typeof p.bodySha === 'string' && p.bodySha !== e.fingerprint) issues.push('fingerprint does not equal publication.bodySha');
      if (!isBlank(p.by) && p.by !== e.reviewer) issues.push('reviewer does not match publication.by');
      if (PUBLICATION_FIELDS.every((k) => !isBlank(p[k])) && typeof e.detail === 'string' && e.detail !== publicationDetail(p)) {
        issues.push('detail does not equal the canonical summary of the publication — a wrapper cannot contradict its payload');
      }
    }
  } else {
    issues.push(`kind "${e.kind}" is not an inert audit kind`);
  }
  return issues;
}

/**
 * The one shared consumption boundary for audit rows: every parsed ledger
 * entry whose kind is inert must pass the complete wrapper validation before
 * ANY consumer lets it contribute authority. Throws on the first failure.
 */
export function assertInertAuditRows(ledgerEntries) {
  for (const e of ledgerEntries) {
    if (!isObj(e) || !INERT_KINDS.includes(e.kind)) continue;
    const issues = validateAuditEntry(e);
    if (issues.length > 0) {
      throw new Error(`a ${e.kind} ledger row fails the audit-record schema (fail closed, never silently excluded): ${issues.join('; ')}`);
    }
  }
}

/**
 * read-time provenance: every record citing a basis must resolve to the
 * EXACT historical ledger entry it claims to cite — located by the frozen
 * kind/round/fingerprint/action tuple, required unique, and canonically equal
 * to the embedded basisEntry. Missing, ambiguous, or mismatching → throws.
 * Never re-interpreted, never rebound to a "closest" entry.
 */
export function assertBasisProvenance(records, ledgerEntries) {
  for (const r of records) {
    if (!isObj(r) || r.basis === undefined) continue;
    const b = r.basis;
    const matches = ledgerEntries.filter((e) => isObj(e) && e.kind === b.kind && e.round === b.round && e.fingerprint === b.fingerprint && e.action === b.action);
    if (matches.length === 0) {
      throw new Error(`adjudication ${r.criterionId} cites a basis (${b.kind} round ${b.round} ${b.action} ${b.fingerprint}) with no matching ledger entry — the cited historical authority is missing`);
    }
    if (matches.length > 1) {
      throw new Error(`adjudication ${r.criterionId} cites a basis (${b.kind} round ${b.round} ${b.action} ${b.fingerprint}) matching ${matches.length} ledger entries — the citation is ambiguous where exactly one is required`);
    }
    if (stableStringify(matches[0]) !== stableStringify(r.basisEntry)) {
      throw new Error(`adjudication ${r.criterionId}'s embedded basisEntry does not equal the cited ledger entry byte-for-byte — the citation must preserve exactly what was cited`);
    }
  }
}

/**
 * approvalRelevantLedgerSha — sha256 over the raw line bytes (each including
 * its terminating LF) of every ledger row whose kind is NOT inert; the literal
 * 'ABSENT' when the relevant set is empty (file absent, zero-byte, or every
 * row inert). Buffer-level framing: a CR byte, a blank line, or a final
 * unterminated record throws (STOP fail-closed before any approval decision).
 */
/**
 * Strict framing, byte-level — the ONE scanner every authoritative
 * ledger read shares: LF-terminated records only, no CR bytes, no blank
 * lines, a terminated final record, every record valid JSON. Anything else
 * throws — illegal bytes are never silently normalized into legal history.
 * Returns [{ raw, entry }] with `raw` the exact line bytes including the LF.
 */
// fatal: malformed sequences throw; ignoreBOM: a leading BOM is NEVER
// silently stripped (the explicit byte check below refuses it first)
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function scanLedger(buf) {
  if (buf.includes(0x0d)) throw new Error('ledger.jsonl contains a CR byte — the only legal framing is LF-terminated records');
  if (buf[buf.length - 1] !== 0x0a) throw new Error('ledger.jsonl ends in an unterminated record — torn write, fail closed');
  const records = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    if (i === start) throw new Error('ledger.jsonl contains a blank line — not a producible framing, fail closed');
    const raw = buf.subarray(start, i + 1); // raw bytes including the LF
    // no record begins with a UTF-8 BOM — the producer never writes one, so
    // it is an illegal byte prefix: refused, never normalized into legal history
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
      throw new Error('ledger.jsonl contains a UTF-8 BOM — not a producible byte sequence, fail closed');
    }
    // fatal decode: malformed byte sequences are NEVER replaced into legal
    // characters — invalid UTF-8 is not authoritative history, fail closed
    let text;
    try {
      text = UTF8_FATAL.decode(raw);
    } catch {
      throw new Error('ledger.jsonl contains invalid UTF-8 bytes — not authoritative history, fail closed');
    }
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      throw new Error(`ledger.jsonl has a malformed line: ${text.slice(0, 200)}`);
    }
    records.push({ raw, entry });
    start = i + 1;
  }
  return records;
}

/**
 * The strict authoritative reader: strict framing + inert-row validation.
 * Missing or empty file → []; any framing/parse/schema violation throws.
 */
export function readLedgerStrict(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  const buf = readFileSync(ledgerPath);
  if (buf.length === 0) return [];
  const entries = scanLedger(buf).map((r) => r.entry);
  assertInertAuditRows(entries);
  return entries;
}

export function approvalRelevantLedgerSha(ledgerPath) {
  if (!existsSync(ledgerPath)) return 'ABSENT';
  const buf = readFileSync(ledgerPath);
  if (buf.length === 0) return 'ABSENT';
  const relevant = [];
  for (const { raw, entry } of scanLedger(buf)) {
    if (isObj(entry) && INERT_KINDS.includes(entry.kind)) {
      const issues = validateAuditEntry(entry);
      if (issues.length > 0) throw new Error(`an inert-kind ledger row fails the audit-record schema (never silently excluded): ${issues.join('; ')}`);
      continue;
    }
    relevant.push(raw);
  }
  if (relevant.length === 0) return 'ABSENT';
  const h = createHash('sha256');
  for (const line of relevant) h.update(line);
  return h.digest('hex');
}

/** A stored stamp matches the empty relevant set iff 'ABSENT' or sha256 of zero bytes (the two canonical legacy shapes). */
export function ledgerStampMatches(stored, current) {
  if (current === 'ABSENT') return stored === 'ABSENT' || stored === EMPTY_SHA256;
  return stored === current;
}

// ---------------------------------------------------------------------------
// canonical body comparison

/** Canonical PR-body form: \r\n → \n, trailing newlines stripped. */
export function canonicalBody(text) {
  return String(text).replaceAll('\r\n', '\n').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// one repo context

/**
 * Repo derivation for a state dir: explicit repo wins, BUT when the state dir
 * is named `.ben` and its parent contains `.git`, an explicit repo must
 * realpath-equal that parent (mismatch throws). With no explicit repo the
 * `.ben`-parent rule applies; otherwise returns undefined (the caller fails
 * closed where a repo is required). cwd is never consulted.
 */
export function resolveRepoForState(stateDir, explicitRepo) {
  const dir = resolvePath(stateDir);
  const parent = dirname(dir);
  const benLayout = basename(dir) === '.ben' && existsSync(join(parent, '.git'));
  if (typeof explicitRepo === 'string' && explicitRepo.trim() !== '') {
    const repo = resolvePath(explicitRepo);
    if (benLayout && realpathSync(repo) !== realpathSync(parent)) {
      throw new Error(`--repo ${repo} is not the repository this state dir belongs to (${parent}) — one state dir, one repo`);
    }
    return repo;
  }
  return benLayout ? parent : undefined;
}

// ---------------------------------------------------------------------------
// approval-act identity — the ONE implementation of the approval binding
// (moved from run.mjs so the standalone referees enforce identical semantics)

export const APPROVAL_FILES = ['plan.md', 'criteria.json', 'promises.json', 'plan-files.json', 'gates.json'];

// canonical verdict-relevant config identity — MUST byte-match reviewer.mjs's
// canonicalConfigFromTask (same keys, same order). The hard review caps join
// the identity omit-if-absent: legacy tasks (fields absent) keep their exact
// historical bytes, while any mid-task change to a bound cap changes the
// bytes and voids the approval/review binding — the operator's safety
// boundary is only movable through a fresh recorded approval.
export function canonicalConfig(task) {
  const cfg = isObj(task?.config) ? task.config : {};
  const boundCap = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : undefined);
  return JSON.stringify({
    e2ePaths: typeof cfg.e2ePaths === 'string' ? cfg.e2ePaths : '',
    greenfield: cfg.greenfield === true,
    ...(boundCap(cfg.planRoundsMax) !== undefined ? { planRoundsMax: cfg.planRoundsMax } : {}),
    ...(boundCap(cfg.diffRoundsMax) !== undefined ? { diffRoundsMax: cfg.diffRoundsMax } : {}),
  });
}

// durable review-gate slots (rounds.gates): one per kind, written by ledger.mjs
// round on a policy exit 2, cleared only by that kind's recorded grant (or the
// human playbook). The exact contracted shape is enforced by EVERY reader and
// writer through this ONE validator — a record that fails it is illegal durable
// state for the playbook, never something to present, consume, or clear.
export function roundsGatesIssues(rounds) {
  const g = isObj(rounds) ? rounds.gates : undefined;
  if (g === undefined) return [];
  if (!isObj(g)) return ['rounds.gates is not an object'];
  const issues = [];
  for (const [k, v] of Object.entries(g)) {
    if (k !== 'plan' && k !== 'diff') {
      issues.push(`unknown gate kind "${k}"`);
      continue;
    }
    if (!isObj(v) || Object.keys(v).length !== 2 || !Number.isSafeInteger(v.round) || v.round < 1 || typeof v.reason !== 'string' || v.reason.trim() === '') {
      issues.push(`gate for ${k} does not match the contracted {round, reason} shape: ${JSON.stringify(v)}`);
      continue;
    }
    const tally = Number.isInteger(rounds[k]) ? rounds[k] : 0;
    if (v.round !== tally) issues.push(`gate for ${k} is recorded at round ${v.round} but the ${k} tally is ${tally}`);
  }
  return issues;
}

export function approvalHashesFor(stateDir, task) {
  const hashes = {};
  for (const name of APPROVAL_FILES) {
    const p = join(stateDir, name);
    if (name === 'gates.json' && !existsSync(p)) continue; // optional member
    if (!existsSync(p)) return undefined; // required artifact missing — no valid binding possible
    hashes[name] = sha256(readFileSync(p));
  }
  // the canonical verdict-relevant config joins the binding as a
  // virtual member — a post-approval config change voids the approval
  hashes.config = sha256(canonicalConfig(task));
  return hashes;
}

/** Valid, current approval = every bound hash matches the on-disk bytes now. Throws on unreadable approval.json. */
export function approvalStateFor(stateDir, task) {
  const path = join(stateDir, 'approval.json');
  if (!existsSync(path)) return { present: false };
  let approval;
  try {
    approval = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`approval.json is unreadable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const current = approvalHashesFor(stateDir, task);
  const bound = isObj(approval.sha256) ? approval.sha256 : {};
  const boundNames = Object.keys(bound);
  const complete = current !== undefined && Object.keys(current ?? {}).every((n) => boundNames.includes(n));
  const matches = complete && boundNames.every((n) => current[n] === bound[n]) && Object.keys(current).length === boundNames.length;
  return { present: true, approval, matches, complete };
}

// ---------------------------------------------------------------------------
// the adjudication act preconditions — ONE implementation shared by run.mjs's human-act
// commands and the standalone ledger.mjs referees, so no entry point is weaker

function gitOut(repoDir, args) {
  const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repoDir}: ${(r.stderr ?? '').trim()}`);
  return (r.stdout ?? '').trim();
}

/**
 * task-level preconditions for recording an adjudication act — enforced
 * identically at every mutation entry point (run.mjs record-adjudication AND
 * ledger.mjs adjudicate). Throws on any violation; nothing may be written.
 */
export const SEQUENCER_VERSION = 1;

/**
 * The ONE semantic sequencer-task definition — run.mjs (loadTask/status) and
 * the standalone adjudication referees (ledger.mjs adjudicate/attest) all consume it:
 * no entry point may mint durable authority for a task the sequencer rejects.
 */
export function validSequencerTask(t) {
  if (
    !isObj(t) ||
    t.sequencerVersion !== SEQUENCER_VERSION ||
    isBlank(t.base) ||
    !isObj(t.repo) ||
    isBlank(t.repo.rootCommit) ||
    !isObj(t.config)
  ) {
    return false;
  }
  // every optional transition field must be well-formed or absent — a truthy
  // malformed record (e.g. "pr": {}) must STOP, never read as completion.
  // the exact task.pr shape (incl. deep publication validation and
  // no-extra-members rule) is taskPrShapeIssues below — the same
  // definition the standalone referee guards enforce.
  if (taskPrShapeIssues(t.pr).length > 0) return false;
  if (
    t.prIntent !== undefined &&
    (!isObj(t.prIntent) || !Number.isInteger(t.prIntent.attempt) || t.prIntent.attempt < 1 || isBlank(t.prIntent.branch) || isBlank(t.prIntent.headSha))
  ) {
    return false;
  }
  if (t.prRetries !== undefined && (!Array.isArray(t.prRetries) || t.prRetries.some((r) => !isObj(r) || isBlank(r.intentHash) || isBlank(r.by)))) return false;
  // migration state (deep-validated): a malformed record —
  // including a malformed INNER stamp or embedded observation — STOPs, never
  // reads as progress or as a presented human gate
  const validObservedPr = (o) => {
    if (!isObj(o) || isBlank(o.url) || isBlank(o.headSha) || isBlank(o.intentHash)) return false;
    if (o.mismatch !== undefined && (!isObj(o.mismatch) || isBlank(o.mismatch.reviewBaseSha))) return false;
    if (o.requalified !== undefined && (!isObj(o.requalified) || isBlank(o.requalified.reviewBaseSha) || !isObj(o.requalified.approvalHashes))) return false;
    return true;
  };
  if (t.observedPr !== undefined && !validObservedPr(t.observedPr)) return false;
  if (
    t.prResolutions !== undefined &&
    (!Array.isArray(t.prResolutions) ||
      t.prResolutions.some(
        (r) =>
          !isObj(r) ||
          isBlank(r.intentHash) ||
          isBlank(r.by) ||
          (r.type === 'observation'
            ? !['absent', 'exists'].includes(r.status) || (r.status === 'exists' && isBlank(r.url))
            : r.type === 'disposition'
              ? r.disposition !== 'unusable' || !validObservedPr(r.observedPr)
              : true),
      ))
  ) {
    return false;
  }
  if (
    t.reviewBase !== undefined &&
    (!isObj(t.reviewBase) ||
      isBlank(t.reviewBase.sha) ||
      (t.reviewBase.approvalHashes !== undefined && !isObj(t.reviewBase.approvalHashes)) ||
      (t.reviewBase.adjudicationsSha !== undefined && isBlank(t.reviewBase.adjudicationsSha)))
  ) {
    return false;
  }
  if (t.verifyIntents !== undefined && (!isObj(t.verifyIntents) || Object.values(t.verifyIntents).some((i) => !isObj(i) || !Number.isInteger(i.tallyBefore)))) return false;
  // grant intents carry the EXACT crash-intent schema — a malformed shape
  // (string consumed, negative counters, unknown fields) must STOP before it
  // can turn a required grant into a no-op (same rule as adjudicationIntents)
  if (
    t.grantIntents !== undefined &&
    (!Array.isArray(t.grantIntents) ||
      t.grantIntents.some(
        (g) =>
          !isObj(g) ||
          isBlank(g.key) ||
          typeof g.consumed !== 'boolean' ||
          !Number.isInteger(g.grantsBefore) ||
          g.grantsBefore < 0 ||
          !Number.isInteger(g.ledgerBefore) ||
          g.ledgerBefore < 0 ||
          (g.slot !== undefined && (!isObj(g.slot) || !Number.isSafeInteger(g.slot.round) || isBlank(g.slot.reason) || Object.keys(g.slot).some((k) => !['round', 'reason'].includes(k)))) ||
          Object.keys(g).some((k) => !['key', 'consumed', 'grantsBefore', 'ledgerBefore', 'slot'].includes(k)),
      ))
  ) {
    return false;
  }
  // adjudication crash intents mirror grantIntents — EXACT schema: a
  // malformed intent (string "false" consumed, negative counters, unknown
  // fields) must STOP before it can turn a required recording into a no-op
  if (
    t.adjudicationIntents !== undefined &&
    (!Array.isArray(t.adjudicationIntents) ||
      t.adjudicationIntents.some(
        (a) =>
          !isObj(a) ||
          typeof a.key !== 'string' ||
          !/^[0-9a-f]{64}$/.test(a.key) ||
          typeof a.consumed !== 'boolean' ||
          !Number.isInteger(a.recordsBefore) ||
          a.recordsBefore < 0 ||
          !Number.isInteger(a.ledgerBefore) ||
          a.ledgerBefore < 0 ||
          Object.keys(a).some((k) => !['key', 'consumed', 'recordsBefore', 'ledgerBefore'].includes(k)),
      ))
  ) {
    return false;
  }
  // supersession watermarks — malformed shapes STOP, never read as scoping
  if (
    t.reviewWatermarks !== undefined &&
    (!Array.isArray(t.reviewWatermarks) ||
      t.reviewWatermarks.some((w) => !isObj(w) || (w.kind !== 'plan' && w.kind !== 'diff') || !Number.isInteger(w.round) || w.round < 1 || !Number.isInteger(w.ledgerLength) || w.ledgerLength < 0))
  ) {
    return false;
  }
  if (t.honestyIntent !== undefined && (!isObj(t.honestyIntent) || !Number.isInteger(t.honestyIntent.reconcileBefore))) return false;
  if (t.approvalGate !== undefined && (!isObj(t.approvalGate) || !isObj(t.approvalGate.hashes))) return false;
  return item16TaskIssues(t).length === 0;
}

// ---------------------------------------------------------------------------
// the runner-era task
// fields. EXACT shapes: a malformed record STOPs, never reads as absent.

// HEX64 is declared above
const isTs = (v) => typeof v === 'string' && isValidTimestamp(v);
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const optArr = (v, each) => v === undefined || (Array.isArray(v) && v.every(each));

export const PUBLICATION_MODES = ['create', 'update'];
export const LIMIT_KINDS = ['usd', 'time', 'stretches'];
export const INSPECTION_BRANCH = ['absent', 'at-sha', 'at-previous', 'other'];
export const INSPECTION_PR = ['absent', 'exists'];
export const FIX_GRANT_STEPS = ['gates', 'criteria', 'scope', 'commits', 'reconcile'];
// an inspection may carry the publication failure it
// follows (scrubbed and bounded by the runner; the sequencer only validates)
export const PR_INSPECTION_FAILURE_MAX = 600;
// GitHub refuses PR titles over 256 characters; the
// task title (the operator's whole outcome text) is unbounded. The title GitHub
// receives is the first non-blank line, whitespace-collapsed, cut at a word
// boundary with headroom under the limit; the full text stays in the PR body
// (renderPrBody quotes the task title under "What"/"Why").
export const PR_TITLE_MAX = 200;

export function prTitleFor(title, max = PR_TITLE_MAX) {
  const first = String(title ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const flat = first.replace(/\s+/g, ' ');
  if (flat === '') return 'ben task';
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space >= Math.floor(max / 2)) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

export function assignmentIssues(a) {
  const issues = [];
  if (!isObj(a)) return ['assignment must be an object'];
  if (!onlyKeys(a, ['publication', 'limits', 'allowDomains', 'researchDomains', 'allowNetworkGates', 'operator'])) issues.push('assignment carries an unknown field');
  const p = a.publication;
  if (!isObj(p) || isBlank(p.repo) || !/^[^/\s]+\/[^/\s]+$/.test(p.repo) || isBlank(p.remote) || isBlank(p.base) || isBlank(p.baseSha) || isBlank(p.branch) || !PUBLICATION_MODES.includes(p.mode)) {
    issues.push('assignment.publication must carry repo (owner/name), remote, base, baseSha, branch and mode create|update');
  } else {
    if (!/^ben\//.test(p.branch)) issues.push('assignment.publication.branch must match ^ben/');
    if (p.branch === p.base) issues.push('assignment.publication.branch must differ from base');
    if (!onlyKeys(p, ['repo', 'remote', 'remoteUrl', 'base', 'baseSha', 'branch', 'mode', 'pr'])) issues.push('assignment.publication carries an unknown field');
    if (p.remoteUrl !== undefined && isBlank(p.remoteUrl)) issues.push('assignment.publication.remoteUrl must be a non-blank URL when present');
    if (p.mode === 'update') {
      if (!isObj(p.pr) || !Number.isSafeInteger(p.pr.number) || p.pr.number < 1 || isBlank(p.pr.url) || isBlank(p.pr.headAtAssign) || !onlyKeys(p.pr, ['number', 'url', 'headAtAssign'])) {
        issues.push('assignment.publication.pr must carry number, url and headAtAssign in update mode');
      }
    } else if (p.pr !== undefined) issues.push('assignment.publication.pr is only legal in update mode');
  }
  const l = a.limits;
  if (!isObj(l) || !onlyKeys(l, ['usd', 'hours', 'stretches']) || ![l.usd, l.hours].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) || !Number.isSafeInteger(l.stretches) || l.stretches < 1) {
    issues.push('assignment.limits must carry positive usd, hours and an integer stretches');
  }
  const domains = (v) => Array.isArray(v) && v.every((d) => typeof d === 'string' && /^[A-Za-z0-9.*-]+$/.test(d));
  if (!domains(a.allowDomains)) issues.push('assignment.allowDomains must be an array of domain strings');
  if (!domains(a.researchDomains)) issues.push('assignment.researchDomains must be an array of domain strings');
  if (typeof a.allowNetworkGates !== 'boolean') issues.push('assignment.allowNetworkGates must be a boolean');
  if (isBlank(a.operator)) issues.push('assignment.operator must be a non-blank actor');
  return issues;
}

export function item16TaskIssues(t) {
  const issues = [];
  if (t.assignmentId !== undefined && (typeof t.assignmentId !== 'string' || !/^[0-9a-f-]{36}$/.test(t.assignmentId))) issues.push('assignmentId must be a UUID');
  if (t.assignment !== undefined) issues.push(...assignmentIssues(t.assignment));
  if (
    t.gate !== undefined &&
    (!isObj(t.gate) || !Number.isSafeInteger(t.gate.seq) || t.gate.seq < 1 || typeof t.gate.id !== 'string' || !/^[0-9a-f]{12}$/.test(t.gate.id) || isBlank(t.gate.kind) || !isObj(t.gate.binding) || !isTs(t.gate.at) || !onlyKeys(t.gate, ['seq', 'id', 'kind', 'binding', 'at']))
  ) {
    issues.push('gate must be {seq, id (12 hex), kind, binding, at}');
  }
  if (!optArr(t.prInspections, (i) => isObj(i) && HEX64.test(i.intentHash ?? '') && INSPECTION_BRANCH.includes(i.branch) && INSPECTION_PR.includes(i.pr) && (i.pr === 'absent' ? i.url === undefined && i.prHead === undefined : !isBlank(i.url) && !isBlank(i.prHead)) && (i.failure === undefined || (typeof i.failure === 'string' && i.failure.trim() !== '' && i.failure.length <= PR_INSPECTION_FAILURE_MAX)) && !isBlank(i.by) && isTs(i.at) && onlyKeys(i, ['intentHash', 'branch', 'pr', 'url', 'prHead', 'failure', 'by', 'at']))) {
    issues.push('prInspections rows must be {intentHash, branch, pr, url?, prHead?, failure?, by, at}');
  }
  if (t.prRetries !== undefined && Array.isArray(t.prRetries) && t.prRetries.some((r) => isObj(r) && r.inspectionSha !== undefined && !HEX64.test(r.inspectionSha))) issues.push('prRetries.inspectionSha must be 64 hex when present');
  const pubOk = (pub) => isObj(pub) && PUBLICATION_MODES.includes(pub.mode) && (pub.mode === 'update' ? !isBlank(pub.prUrl) && onlyKeys(pub, ['mode', 'prUrl']) : pub.prUrl === undefined && onlyKeys(pub, ['mode']));
  if (isObj(t.prIntent) && t.prIntent.publication !== undefined && !pubOk(t.prIntent.publication)) issues.push('prIntent.publication must be {mode:"create"} or {mode:"update", prUrl}');
  for (const a of Array.isArray(t.prAttempts) ? t.prAttempts : []) if (isObj(a) && a.publication !== undefined && !pubOk(a.publication)) issues.push('prAttempts[].publication must be {mode:"create"} or {mode:"update", prUrl}');
  if (!optArr(t.supervisorStops, (x) => isObj(x) && HEX64.test(x.id ?? '') && !isBlank(x.reason) && !isBlank(x.by) && isTs(x.at) && (x.resolution === undefined || (isObj(x.resolution) && x.resolution.decision === 'continue' && !isBlank(x.resolution.by) && isTs(x.resolution.at) && (x.resolution.note === undefined || typeof x.resolution.note === 'string') && onlyKeys(x.resolution, ['decision', 'by', 'at', 'note']))) && onlyKeys(x, ['id', 'reason', 'by', 'at', 'resolution']))) {
    issues.push('supervisorStops rows must be {id, reason, by, at, resolution?}');
  }
  if (!optArr(t.limitEvents, (e) => isObj(e) && HEX64.test(e.id ?? '') && LIMIT_KINDS.includes(e.kind) && typeof e.value === 'number' && Number.isFinite(e.value) && !isBlank(e.by) && isTs(e.at) && onlyKeys(e, ['id', 'kind', 'value', 'by', 'at']))) {
    issues.push('limitEvents rows must be {id, kind, value, by, at}');
  }
  if (!optArr(t.limitExtensions, (e) => isObj(e) && HEX64.test(e.eventId ?? '') && LIMIT_KINDS.includes(e.kind) && typeof e.amount === 'number' && Number.isFinite(e.amount) && e.amount > 0 && !isBlank(e.by) && isTs(e.at) && (e.note === undefined || typeof e.note === 'string') && onlyKeys(e, ['eventId', 'kind', 'amount', 'by', 'at', 'note']))) {
    issues.push('limitExtensions rows must be {eventId, kind, amount, by, at, note?}');
  }
  if (!optArr(t.fixGrants, (g) => isObj(g) && FIX_GRANT_STEPS.includes(g.step) && Number.isSafeInteger(g.tallyAt) && g.tallyAt >= 0 && !isBlank(g.by) && isTs(g.at) && onlyKeys(g, ['step', 'tallyAt', 'by', 'at']))) {
    issues.push('fixGrants rows must be {step, tallyAt, by, at}');
  }
  if (!optArr(t.revisions, (r) => isObj(r) && HEX64.test(r.id ?? '') && isObj(r.hashes) && typeof r.notes === 'string' && r.notes.trim() !== '' && !isBlank(r.by) && isTs(r.at) && (r.presentedAt === undefined || isTs(r.presentedAt)) && (r.supersededApproval === undefined || typeof r.supersededApproval === 'string') && onlyKeys(r, ['id', 'hashes', 'notes', 'by', 'at', 'presentedAt', 'supersededApproval']))) {
    issues.push('revisions rows must be {id, hashes, notes, by, at, presentedAt?, supersededApproval?}');
  }
  if (!optArr(t.clarifications, (c) => isObj(c) && HEX64.test(c.questionsSha ?? '') && typeof c.answers === 'string' && c.answers.trim() !== '' && !isBlank(c.by) && isTs(c.at) && onlyKeys(c, ['questionsSha', 'answers', 'by', 'at']))) {
    issues.push('clarifications rows must be {questionsSha, answers, by, at}');
  }
  return issues;
}

/** The gate id: 12 hex over the assignment, the occurrence, the kind and the canonical binding. */
export function gateIdFor(assignmentId, seq, kind, binding) {
  return sha256(`${assignmentId}|${seq}|${kind}|${stableStringify(binding)}`).slice(0, 12);
}

/** The newest unresolved supervisor stop, if any. */
export function openSupervisorStop(task) {
  const stops = Array.isArray(task?.supervisorStops) ? task.supervisorStops : [];
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i].resolution === undefined) return stops[i];
  return undefined;
}

/** The newest limit event with no later extension of its kind, if any. */
export function openLimitEvent(task) {
  const events = Array.isArray(task?.limitEvents) ? task.limitEvents : [];
  const ext = Array.isArray(task?.limitExtensions) ? task.limitExtensions : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!ext.some((x) => x.eventId === e.id)) return e;
  }
  return undefined;
}

/**
 * precedence: a supervisor stop or a limit event
 * governs before every plan/implement-phase gate. Returns a reason string when
 * one stands, else undefined. PR-family and terminal states are handled by the
 * callers' own precedence (they rank above these two).
 */
export function higherPrecedenceIssue(task) {
  if (openSupervisorStop(task) !== undefined) return 'a recorded supervisor stop governs before this question';
  if (openLimitEvent(task) !== undefined) return 'a recorded limit stop governs before this question';
  return undefined;
}

/** True when .ben/questions.json exists and no clarification row answers its exact bytes. */
export function pendingClarification(stateDir, task) {
  const p = join(stateDir, 'questions.json');
  if (!existsSync(p)) return false;
  const qSha = sha256(readFileSync(p));
  return !(Array.isArray(task?.clarifications) ? task.clarifications : []).some((c) => c.questionsSha === qSha);
}

/** The latest inspection recorded for a pending intent hash, if any. */
export function latestInspection(task, intentHash) {
  const rows = (Array.isArray(task?.prInspections) ? task.prInspections : []).filter((i) => i.intentHash === intentHash);
  return rows.length > 0 ? rows[rows.length - 1] : undefined;
}

export function inspectionSha(inspection) {
  return sha256(stableStringify(inspection));
}

/**
 * exact task.pr shape — the ONE definition. validSequencerTask and the
 * shared guards below all consume it: a malformed task.pr is never read as
 * "no terminal PR basis" (it would silently relax the terminal-basis rule).
 */
export function taskPrShapeIssues(pr) {
  if (pr === undefined) return [];
  if (!isObj(pr) || isBlank(pr.url) || isBlank(pr.headSha)) {
    return ['task.pr must be an object carrying non-blank url and headSha'];
  }
  if (pr.publication !== undefined) {
    const p = pr.publication;
    if (!isObj(p) || typeof p.bodySha !== 'string' || !/^[0-9a-f]{64}$/.test(p.bodySha) || isBlank(p.headRefOid) || isBlank(p.remoteUpdatedAt) || isBlank(p.observedAt)) {
      return ['task.pr.publication must carry a 64-hex bodySha and non-blank headRefOid, remoteUpdatedAt, observedAt'];
    }
    if (Object.keys(p).some((k) => !['bodySha', 'headRefOid', 'remoteUpdatedAt', 'observedAt'].includes(k))) {
      return ['task.pr.publication carries an unknown field'];
    }
  }
  return [];
}

function assertTaskPrShape(task) {
  const issues = taskPrShapeIssues(task?.pr);
  if (issues.length > 0) {
    throw new Error(`task.pr is malformed — ${issues.join('; ')} — a malformed record is corruption to reconcile, never a non-terminal basis`);
  }
}

export function assertAdjudicationActAllowed({ stateDir, repoDir, task, record }) {
  assertTaskPrShape(task);
  let criteriaDoc;
  try {
    criteriaDoc = JSON.parse(readFileSync(join(stateDir, 'criteria.json'), 'utf8'));
  } catch (err) {
    throw new Error(`criteria.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObj(criteriaDoc) || !Array.isArray(criteriaDoc.criteria)) throw new Error('criteria.json is not a criteria doc');
  const matching = criteriaDoc.criteria.filter((c) => isObj(c) && c.id === record.criterionId);
  if (matching.length === 0) throw new Error(`criterion ${record.criterionId} does not exist in criteria.json`);
  if (matching.length > 1) throw new Error(`criterion id ${record.criterionId} is duplicated in criteria.json — one id, one criterion`);
  if (matching[0]?.verification?.method !== 'manual') {
    throw new Error(`criterion ${record.criterionId} is not a manual criterion — adjudication applies to manual criteria only`);
  }
  if (criterionShaOf(matching[0]) !== record.criterionSha) {
    throw new Error(`the record does not bind the CURRENT criterion bytes for ${record.criterionId} — an act stands only for the criterion it judged`);
  }
  const apr = approvalStateFor(stateDir, task);
  if (!apr.present || !apr.matches) {
    throw new Error('no current matching approval — an adjudication binds the exact approval act');
  }
  if (sha256(readFileSync(join(stateDir, 'approval.json'))) !== record.approvalActSha) {
    throw new Error('approvalActSha does not bind the current approval act bytes');
  }
  if (record.decision === 'satisfied') {
    if (repoDir === undefined) throw new Error('a repo context is required to record a satisfied adjudication (it binds the checked HEAD)');
    if (gitOut(repoDir, ['status', '--porcelain']) !== '') {
      throw new Error('a satisfied adjudication binds the checked HEAD and needs a clean worktree — commit or discard first');
    }
    if (gitOut(repoDir, ['rev-parse', 'HEAD']) !== record.headSha) {
      throw new Error('a satisfied adjudication must bind the CURRENT HEAD — the recorded headSha does not match');
    }
  }
  if (isObj(task?.pr) && record.basis === undefined) {
    throw new Error('the task is terminal — a basis citing the ledger entry that carried the original ruling is required');
  }
}

/**
 * terminal publication binding — enforced identically by run.mjs
 * record-publication and ledger.mjs attest: the exact task.pr.url, the exact
 * task.pr.headSha, and the digest of the CURRENT generated body.
 */
export function assertAttestationAllowed({ stateDir, repoDir, task, publication }) {
  assertTaskPrShape(task);
  if (task?.pr === undefined) {
    throw new Error('the task is not terminal — a publication attestation binds a recorded PR (task.pr)');
  }
  if (publication.url !== task.pr.url) throw new Error(`publication.url is ${publication.url} — expected the terminal ${task.pr.url}`);
  if (publication.headRefOid !== task.pr.headSha) throw new Error(`publication.headRefOid is ${publication.headRefOid} — expected the terminal ${task.pr.headSha}`);
  const projection = renderPrBody(stateDir, { title: task.title ?? task.taskId ?? 'ben task', repoDir });
  const projSha = sha256(canonicalBody(projection));
  if (publication.bodySha !== projSha) {
    throw new Error(`publication.bodySha ${publication.bodySha} does not equal the digest of the CURRENT generated body (${projSha})`);
  }
}

// ---------------------------------------------------------------------------
// The pure in-memory PR-body renderer (ported from pr.mjs; the
// legacy rendering is byte-identical when no adjudication state exists)

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

// consumes the entries the strict boundary already validated — this helper
// never re-reads the file, so no lenient parse can resurrect here
function lastRevisedRounds(ledgerEntries) {
  const last = { plan: 0, diff: 0 };
  for (const entry of ledgerEntries) {
    if (!isObj(entry) || entry.action !== 'resolved') continue;
    if ((entry.kind === 'plan' || entry.kind === 'diff') && Number.isInteger(entry.round) && entry.round > last[entry.kind]) {
      last[entry.kind] = entry.round;
    }
  }
  return last;
}

function reviewNotes(dir, ledgerEntries) {
  const reviewsDir = join(dir, 'reviews');
  if (!existsSync(reviewsDir)) return '';
  const chronoKey = (f) => f.replace(/^plan-round-(\d+)/, '0-$1').replace(/^diff-round-(\d+)/, '1-$1');
  const files = readdirSync(reviewsDir)
    .filter((f) => /^(plan|diff)-round-\d+-.+\.json$/.test(f))
    .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));
  const lastRevised = lastRevisedRounds(ledgerEntries);
  const seen = new Set();
  const notes = [];
  for (const file of files) {
    const m = file.match(/^(plan|diff)-round-(\d+)-(.+)\.json$/);
    let verdict;
    try {
      verdict = JSON.parse(readFileSync(join(reviewsDir, file), 'utf8'));
    } catch {
      continue; // abstain raw saved at a .json path — not a verdict, not a note
    }
    if (!Array.isArray(verdict?.blockers)) continue;
    for (const b of verdict.blockers) {
      if (b.severity === 'BLOCKER') continue; // gating findings live in the ledger, not here
      const key = `${b.severity}|${b.claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const evidence = typeof b.evidence === 'string' && b.evidence.trim() ? ` — ${b.evidence.trim()}` : '';
      const stale = Number(m[2]) < lastRevised[m[1]] ? ` _(recorded round ${m[2]} — artifact revised since)_` : '';
      notes.push(`- **${b.severity}** (${m[3]}, ${m[1]} review round ${m[2]}): ${b.claim}${evidence}${stale}`);
    }
  }
  if (notes.length === 0) return '';
  return ['## Review notes — non-blocking', 'The review panel recorded these; none of them gate the merge.', ...notes].join('\n');
}

/**
 * The pure PR-body renderer: reads state, writes NOTHING, returns the body
 * string (no trailing newline). Throws on malformed inputs, tampered or
 * conflicting adjudication state, or a missing repo context while
 * adjudication state exists.
 */
export function renderPrBody(stateDir, { title, repoDir }) {
  const dir = resolvePath(stateDir);
  if (isBlank(title)) throw new Error('a non-empty title is required');

  const summary = readIfExists(join(dir, 'summary.md')).trim();
  const plan = readIfExists(join(dir, 'plan.md')).trim();

  // the strict framing/parse boundary: the renderer never renders a
  // surviving subset of a torn or malformed ledger, and every inert audit row
  // is validated regardless of adjudication state (publication-only included)
  const ledgerEntries = readLedgerStrict(join(dir, 'ledger.jsonl'));
  const hasAdjState = existsSync(join(dir, 'adjudications.json')) || ledgerEntries.some((e) => isObj(e) && e.kind === 'adjudication');
  let governing = new Map();
  if (hasAdjState) {
    const approvalPath = join(dir, 'approval.json');
    const derived = deriveAdjudication({
      stateDir: dir,
      ledgerEntries,
      criteriaDoc: existsSync(join(dir, 'criteria.json')) ? JSON.parse(readFileSync(join(dir, 'criteria.json'), 'utf8')) : undefined,
      approvalBytes: existsSync(approvalPath) ? readFileSync(approvalPath) : undefined,
      getHeadSha: () => {
        if (repoDir === undefined) throw new Error('a repo context is required to render adjudicated criteria (satisfied binds HEAD) — pass --repo or use a .ben state dir inside the repository');
        const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git rev-parse HEAD failed in ${repoDir}: ${(r.stderr ?? '').trim()}`);
        return r.stdout.trim();
      },
    });
    governing = derived.governing;
  }

  let proof = '_no criteria matrix found_';
  const matrixPath = join(dir, 'evidence', 'criteria-matrix.json');
  const criteriaPath = join(dir, 'criteria.json');
  if (existsSync(matrixPath) && existsSync(criteriaPath)) {
    let matrix;
    let doc;
    try {
      matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
      doc = JSON.parse(readFileSync(criteriaPath, 'utf8'));
    } catch (err) {
      throw new Error(`matrix or criteria unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(doc.criteria)) throw new Error('criteria.json does not look like a criteria doc');
    proof = doc.criteria
      .map((c) => {
        // the approval-bound criterion method — never the (corruptible) matrix
        // status — decides whether a criterion is manual; the governing
        // computation is the truth for its state: pending, satisfied, accepted
        if (c?.verification?.method === 'manual') {
          const g = governing.get(c.id);
          if (g === undefined) return `- 👤 ${c.statement} — **needs a human check before merge**`;
          if (g.decision === 'satisfied') return `- ✅ ${c.statement} — **ADJUDICATED satisfied** by ${g.by}`;
          return `- 👤 ${c.statement} — **ADJUDICATED accepted** by ${g.by} — unproven: ${g.residual}`;
        }
        const icon = matrix[c.id]?.status === 'pass' ? '✅' : '❌';
        return `- ${icon} ${c.statement}`;
      })
      .join('\n');
  }

  let adjudicationsSection = '';
  if (governing.size > 0) {
    const lines = ['## Adjudications — recorded human decisions on manual criteria'];
    for (const [id, g] of [...governing.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      lines.push(`- **${id} — ${g.decision}** by ${g.by} at ${g.at}: ${g.ruling}`);
      if (g.decision === 'accepted') lines.push(`  - unproven residual: ${g.residual}`);
      if (g.basis !== undefined) {
        lines.push(`  - basis: ${g.basis.kind} round ${g.basis.round} — ${g.basis.action} ${g.basis.fingerprint} (cited ledger entry embedded verbatim in the adjudication record)`);
      }
    }
    adjudicationsSection = lines.join('\n');
  }

  const notes = reviewNotes(dir, ledgerEntries);

  return [
    '## What',
    summary || title,
    '',
    '## Why',
    `Requested task: ${title}`,
    '',
    '## How',
    '<details><summary>Implementation plan</summary>',
    '',
    plan || '_no plan recorded_',
    '',
    '</details>',
    '',
    '## Proof — every criterion ran, verdicts below',
    proof,
    '',
    ...(adjudicationsSection ? [adjudicationsSection, ''] : []),
    ...(notes ? [notes, ''] : []),
    '🤖 opened by ben — the human merges.',
  ].join('\n');
}


// ---------------------------------------------------------------------------
// The waiting-projection oracle. The projection
// (.ben/waiting.json + WAITING.md) is a rendered, NON-authoritative operator
// artifact; this is the ONE liveness classifier every consumer (run.mjs
// answer/status, the Stop hook, tests) uses.
//
// Soundness contract: 'current' implies the gate is genuinely still owed —
// including PHASE PRECEDENCE (a parked gate that a fresh derivation would no
// longer reach reads stale/spent, never current). Projection fields are
// CLAIMS validated against authoritative state: input manifests are
// CODE-OWNED per kind (a projection-supplied list is never digested), the
// grant target (gateKind) is DERIVED from authoritative state and merely
// compared to the claim, and the pair digest is torn-pair detection only —
// never tamper evidence. Every approximation errs toward stale/spent (which
// block and point at `run.mjs next`), never toward presenting a dead
// question as live.

export const WAITING_JSON = 'waiting.json';
export const WAITING_MD = 'WAITING.md';
const WAITING_KINDS = [
  'approval',
  'veto',
  'review-stop',
  'fix-cap',
  'manual-adjudication',
  'pr-pending',
  'pr-observed',
  'pr-migration',
  'abandoned',
  'stop',
  'model-stop',
//
  'pr-record',
  'pr-retry',
  'pr-head-mismatch',
  'pr-branch-conflict',
  'supervisor-stop',
  'limit',
  'clarify',
];
// the CODE-OWNED owner per kind — a projected owner is a claim, never authority
// (pr-observed derives its owner from state inside its own case)
const WAITING_OWNER_FOR_KIND = {
  approval: 'human',
  veto: 'human',
  'review-stop': 'human',
  'fix-cap': 'human',
  'manual-adjudication': 'human',
  'pr-pending': 'model',
  'pr-migration': 'human',
  abandoned: 'human',
  stop: 'playbook',
  'model-stop': 'model',
  'pr-record': 'model',
  'pr-retry': 'human',
  'pr-head-mismatch': 'human',
  'pr-branch-conflict': 'human',
  'supervisor-stop': 'playbook',
  limit: 'human',
  clarify: 'human',
};
const WAITING_OWNERS = ['human', 'model', 'playbook'];

// the ONE code-owned state manifest for inputs-bound kinds (fix-cap, stop,
// non-slot review-stop): the authoritative core plus every approval-bound
// artifact — any repair, fix, grant, revision or record flips the note stale
export const WAITING_CORE_FILES = [
  'task.json',
  'rounds.json',
  'ledger.jsonl',
  'blockers.json',
  'approval.json',
  'adjudications.json',
  'veto.jsonl',
  'proposal.json',
  'resolutions.json',
  ...APPROVAL_FILES,
];

/** Digest over the named state files' CURRENT bytes (absent files marked). */
export function waitingInputsDigest(stateDir, inputs) {
  const parts = inputs.map((name) => {
    let content;
    try {
      content = readFileSync(join(stateDir, name));
    } catch {
      return `${name}:ABSENT`;
    }
    return `${name}:${sha256(content)}`;
  });
  return sha256(parts.join('|'));
}

/** The repo identity the git-sensitive bindings capture; throws on git failure. */
export function waitingGitIdentity(repoDir) {
  const status = gitOut(repoDir, ['status', '--porcelain']);
  const diff = gitOut(repoDir, ['diff', 'HEAD']);
  return { headSha: gitOut(repoDir, ['rev-parse', 'HEAD']), worktreeHash: sha256(`${status}\n${diff}`) };
}

/**
 * Classify the waiting projection against authoritative state.
 * Returns {state:'absent'} | {state:'stale'|'spent', reason} |
 * {state:'current', waiting, derived} — never throws. `repoDir` enables the
 * git-sensitive checks; without it, git-sensitive kinds read stale.
 */
export function waitingState(stateDir, repoDir = undefined) {
  let raw;
  try {
    raw = readFileSync(join(stateDir, WAITING_JSON));
  } catch {
    return { state: 'absent' };
  }
  const stale = (reason) => ({ state: 'stale', reason });
  let w;
  try {
    w = JSON.parse(raw.toString('utf8'));
  } catch {
    return stale('waiting.json is unreadable');
  }
  if (
    !isObj(w) ||
    !WAITING_KINDS.includes(w.kind) ||
    !WAITING_OWNERS.includes(w.owner) ||
    isBlank(w.question) ||
    typeof w.packet !== 'string' ||
    !isObj(w.binding) ||
    !Array.isArray(w.options)
  ) {
    return stale('waiting.json does not match the projection shape');
  }
  let md;
  try {
    md = readFileSync(join(stateDir, WAITING_MD), 'utf8');
  } catch {
    return stale('WAITING.md is missing (torn projection pair)');
  }
  if (!md.includes(sha256(raw))) return stale('WAITING.md does not match waiting.json (torn projection pair)');
  try {
    return classifyWaiting(stateDir, repoDir, w);
  } catch {
    return stale('the waiting note could not be verified against authoritative state');
  }
}

function classifyWaiting(stateDir, repoDir, w) {
  const stale = (reason) => ({ state: 'stale', reason });
  const spent = (reason) => ({ state: 'spent', reason });
  const current = (derived = {}) => ({ state: 'current', waiting: w, derived });
  const readIf = (name) => (existsSync(join(stateDir, name)) ? readFileSync(join(stateDir, name)) : undefined);
  const shaOf = (name) => {
    const b = readIf(name);
    return b === undefined ? undefined : sha256(b);
  };
  const readJsonIf = (name) => {
    const b = readIf(name);
    if (b === undefined) return undefined;
    return JSON.parse(b.toString('utf8')); // parse failure → outer catch → stale
  };
  const gitId = () => {
    if (isBlank(repoDir)) return undefined; // git-sensitive kinds need the repo
    return waitingGitIdentity(repoDir); // git failure → outer catch → stale
  };

  // the owner is code-owned per kind — a forged owner can re-route the
  // Stop hook, so a mismatched claim is never current (pr-observed derives)
  if (w.kind !== 'pr-observed' && w.owner !== WAITING_OWNER_FOR_KIND[w.kind]) return stale('the parked note misstates who the stop belongs to');

  // superseded by an abandon that arrived after the park
  if (w.kind !== 'abandoned' && existsSync(join(stateDir, 'ABANDON.md'))) return spent('the task was abandoned');

  const task = readJsonIf('task.json');
  if (task === undefined || !validSequencerTask(task)) return stale('task.json is missing or invalid — nothing can be verified against it');
  // one task, one repo: a projection from another clone is never current here
  if (!isBlank(repoDir) && gitOut(repoDir, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0] !== task.repo.rootCommit) {
    return stale('this repository is not the one the task is bound to');
  }
  // a terminal task has no live question of these kinds ('stop' inconsistency
  // parks stay state-bound: a broken terminal state is still the same question)
  if (task.pr && w.kind !== 'stop') return spent('the task is terminal (PR recorded)');
  // precedence: a supervisor stop / limit event ranks above every
  // plan- and implement-phase gate (the PR family ranks above them in turn)
  if (!['stop', 'abandoned', 'supervisor-stop', 'limit', 'pr-pending', 'pr-migration', 'pr-observed', 'pr-record', 'pr-retry', 'pr-head-mismatch', 'pr-branch-conflict'].includes(w.kind)) {
    const hp = higherPrecedenceIssue(task);
    if (hp !== undefined) return stale(hp);
  }
  // the authoritative gate record must name this exact presentation — id,
  // kind AND the canonical binding (a projection rewritten to target another
  // question while keeping an old id is never current); a runner-assigned
  // task never presents without an id
  if (w.gateId !== undefined) {
    if (!isObj(task.gate) || task.gate.id !== w.gateId || task.gate.kind !== w.kind) return stale('the presented gate on record no longer matches this note');
    if (stableStringify(task.gate.binding) !== stableStringify(w.binding)) return stale('the parked question no longer matches the presented gate on record');
  } else if (isObj(task.assignment)) {
    return stale('this task presents every question with a gate id — the note carries none');
  }
  // unanswered clarification questions govern the whole plan phase
  if (['approval', 'veto', 'review-stop', 'fix-cap'].includes(w.kind) && pendingClarification(stateDir, task)) {
    return stale('unanswered clarification questions govern before this question');
  }

  const b = w.binding;
  const ledger = () => readLedgerStrict(join(stateDir, 'ledger.jsonl')); // throws → stale
  const apr = () => {
    const s = approvalStateFor(stateDir, task); // throws → stale
    return s.present === true && s.matches === true;
  };
  /** The blocker kind the ledger tail names — the one authority for gate kind. */
  const tailKind = () => {
    const entries = ledger();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].action === 'raised' || entries[i].action === 'abstain') return entries[i].kind;
    }
    return undefined;
  };
  const roundsTallyOf = (rounds, kind2) => (Number.isInteger(rounds[kind2]) ? rounds[kind2] : 0);
  /** Inputs-bound liveness: the CODE-OWNED manifest plus the git identity. */
  const coreBound = () => {
    if (typeof w.inputsDigest !== 'string') return stale('the parked note carries no state digest');
    if (waitingInputsDigest(stateDir, WAITING_CORE_FILES) !== w.inputsDigest) return stale('the underlying state changed since this note was parked');
    const id = gitId();
    if (id === undefined) return stale('the repository is needed to verify this note');
    if (b.headSha !== id.headSha || b.worktreeHash !== id.worktreeHash) return stale('the code or worktree changed since this note was parked');
    return undefined; // live so far — caller applies kind-specific checks
  };

  switch (w.kind) {
    case 'approval': {
      if (!isObj(b.hashes) || isBlank(b.ledgerSha)) return stale('the parked approval binding is incomplete');
      // phase precedence: a pending/observed PR intercepts before any approval gate
      if (isObj(task.prIntent) || isObj(task.observedPr)) return stale('a pull-request step is pending — it governs before any approval gate');
      const hashesNow = approvalHashesFor(stateDir, task);
      if (hashesNow === undefined || JSON.stringify(hashesNow) !== JSON.stringify(b.hashes)) return stale('the plan artifacts or config changed since the packet was presented');
      let ledgerNow;
      try {
        ledgerNow = approvalRelevantLedgerSha(join(stateDir, 'ledger.jsonl'));
      } catch {
        return stale('the ledger cannot be digested');
      }
      if (!ledgerStampMatches(b.ledgerSha, ledgerNow)) return stale('the ledger changed since the packet was presented');
      const approval = readJsonIf('approval.json');
      if (approval !== undefined && isObj(approval.sha256) && JSON.stringify(approval.sha256) === JSON.stringify(b.hashes)) {
        return spent('this exact packet is already approved');
      }
      if (!isObj(task.approvalGate) || JSON.stringify(task.approvalGate.hashes) !== JSON.stringify(b.hashes) || !ledgerStampMatches(task.approvalGate.ledgerSha, b.ledgerSha)) {
        return stale('the presented packet on record no longer matches this note');
      }
      if (existsSync(join(stateDir, 'blockers.json'))) return stale('open blockers exist — the approval gate cannot stand');
      // a recorded revision request for these exact hashes governs first
      if ((task.revisions ?? []).some((r) => JSON.stringify(r.hashes) === JSON.stringify(b.hashes) && r.presentedAt === undefined)) {
        return spent('a revision was requested for this packet');
      }
      return current();
    }
    case 'supervisor-stop': {
      if (isBlank(b.stopId)) return stale('the parked supervisor-stop binding is incomplete');
      const open = openSupervisorStop(task);
      if (open === undefined) return spent('the supervisor stop was resolved by a recorded act');
      if (open.id !== b.stopId) return stale('a newer supervisor stop governs');
      return current({ stopId: open.id });
    }
    case 'limit': {
      if (isBlank(b.eventId)) return stale('the parked limit binding is incomplete');
      if (openSupervisorStop(task) !== undefined) return stale('a recorded supervisor stop governs before this question');
      const open = openLimitEvent(task);
      if (open === undefined) return spent('the limit was extended (or the task aborted) by a recorded act');
      if (open.id !== b.eventId) return stale('a newer limit event governs');
      return current({ eventId: open.id, limitKind: open.kind });
    }
    case 'clarify': {
      if (isBlank(b.questionsSha)) return stale('the parked clarify binding is incomplete');
      if (isObj(task.prIntent) || isObj(task.observedPr)) return stale('a pull-request step is pending — it governs before any clarification');
      if (apr()) return stale('the plan is approved — clarification belongs to the plan phase');
      if (shaOf('questions.json') !== b.questionsSha) return stale('the questions changed since this note was parked');
      if ((task.clarifications ?? []).some((c) => c.questionsSha === b.questionsSha)) return spent('these questions are already answered');
      return current({ questionsSha: b.questionsSha });
    }
    case 'pr-record':
    case 'pr-retry':
    case 'pr-head-mismatch':
    case 'pr-branch-conflict': {
      if (isBlank(b.intentHash) || isBlank(b.inspectionSha)) return stale('the parked PR binding is incomplete');
      if (!isObj(task.prIntent) || sha256(JSON.stringify(task.prIntent)) !== b.intentHash) return spent('the pending PR intent was resolved or superseded');
      const insp = latestInspection(task, b.intentHash);
      if (insp === undefined || inspectionSha(insp) !== b.inspectionSha) return stale('a newer GitHub inspection governs — run next to re-present');
      if (w.kind === 'pr-retry' && (task.prRetries ?? []).some((r) => r.intentHash === b.intentHash && r.inspectionSha === b.inspectionSha)) {
        return spent('the retry for this inspection is already recorded');
      }
      if (w.kind === 'pr-head-mismatch' && (task.prRetries ?? []).some((r) => r.intentHash === b.intentHash && r.inspectionSha === b.inspectionSha)) {
        return spent('the update for this inspection is already authorized');
      }
      return current({ intentHash: b.intentHash, inspectionSha: b.inspectionSha });
    }
    case 'veto': {
      if ((b.gateKind !== 'plan' && b.gateKind !== 'diff') || !Number.isInteger(b.round) || isBlank(b.blockersSha) || isBlank(b.proposalSha)) {
        return stale('the parked veto binding is incomplete');
      }
      if (isObj(task.prIntent) || isObj(task.observedPr)) return stale('a pull-request step is pending — it governs before any reconcile gate');
      if (shaOf('blockers.json') !== b.blockersSha) return stale('the open blockers changed since the question was parked');
      if (shaOf('proposal.json') !== b.proposalSha) return stale('the proposal changed since the question was parked');
      // the gate kind is DERIVED from the ledger tail, never trusted from the note
      if (tailKind() !== b.gateKind) return stale('the open blockers no longer belong to the parked review kind');
      // phase precedence: plan reconciliation runs only without a current
      // approval; diff reconciliation only under one (else next STOPs instead)
      if (b.gateKind === 'plan' ? apr() : !apr()) return stale('the approval state moved — this reconcile gate is no longer the next step');
      const rounds = readJsonIf('rounds.json') ?? {};
      const roundsTally = Number.isInteger(rounds[b.gateKind]) ? rounds[b.gateKind] : 0;
      if (roundsTally !== b.round) return stale('the review round moved since the question was parked');
      const vetoRaw = readIf('veto.jsonl');
      const entries = vetoRaw === undefined ? [] : vetoRaw.toString('utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
      const match = (v, type) => (v.type ?? 'decision') === type && v.kind === b.gateKind && v.round === b.round && v.blockersSha === b.blockersSha && v.proposalSha === b.proposalSha;
      if (entries.some((v) => match(v, 'decision'))) return spent('your decision on this exact proposal is already recorded');
      if (!entries.some((v) => match(v, 'presented'))) return stale('no presentation record exists for this exact proposal');
      return current({ gateKind: b.gateKind, blockersSha: b.blockersSha, proposalSha: b.proposalSha });
    }
    case 'review-stop': {
      if (b.gateKind !== 'plan' && b.gateKind !== 'diff') return stale('the parked review-stop binding is incomplete');
      if (isObj(task.prIntent) || isObj(task.observedPr)) return stale('a pull-request step is pending — it governs before any review gate');
      // phase precedence, matching the derivation's routing for this kind
      if (b.gateKind === 'plan' ? apr() : !apr()) return stale('the approval state moved — this review stop is no longer the next step');
      const rounds = readJsonIf('rounds.json') ?? {};
      if (roundsGatesIssues(rounds).length > 0) return stale('rounds.gates is malformed — a human reconciles per the playbook');
      const slot = isObj(rounds.gates) ? rounds.gates[b.gateKind] : undefined;
      if (isObj(b.slot)) {
        // slot-bound: the durable rounds.gates stop for this kind
        if (b.slot.gateKind !== b.gateKind) return stale('the parked review-stop binding is inconsistent');
        if (slot === undefined) return spent('the review stop was cleared by a recorded act');
        if (slot.round !== b.slot.round || slot.reason !== b.slot.reason) return stale('the recorded review stop changed since this note was parked');
        return current({ gateKind: b.gateKind });
      }
      // inputs-bound: ONLY a recorded abstain round parks without a slot (the
      // in-line escalation park is slot-bound; pregate escalations park as
      // fix-cap). A standing slot supersedes, open blockers route to the veto
      // gate instead, and the abstain rows must exist for the derived round.
      if (slot !== undefined) return stale('a durable review stop was recorded — run next to re-present it');
      if (existsSync(join(stateDir, 'blockers.json'))) return stale('open blockers exist — reconciliation governs, not a review stop');
      if (tailKind() !== b.gateKind) return stale('the review history no longer names the parked review kind');
      const abstainRound = roundsTallyOf(rounds, b.gateKind) + 1;
      // the abstain row must be POST-WATERMARK — the sequencer's replay
      // classification excludes superseded rows, and a historical
      // abstain that next would not present must never read as live
      const cutoff = Math.max(0, ...(task.reviewWatermarks ?? []).filter((m) => isObj(m) && m.kind === b.gateKind && m.round === abstainRound).map((m) => m.ledgerLength));
      if (!ledger().some((e, i) => i >= cutoff && e.kind === b.gateKind && e.round === abstainRound && e.action === 'abstain')) {
        return stale('no recorded abstain stands for the parked review kind');
      }
      const dead = coreBound();
      if (dead !== undefined) return dead;
      return current({ gateKind: b.gateKind });
    }
    case 'fix-cap':
    case 'stop':
    case 'model-stop': {
      const dead = coreBound();
      if (dead !== undefined) return dead;
      return current();
    }
    case 'manual-adjudication': {
      if (!Array.isArray(b.criterionIds) || b.criterionIds.length === 0 || isBlank(b.criteriaSha) || isBlank(b.approvalSha)) {
        return stale('the parked adjudication binding is incomplete');
      }
      if (isObj(task.prIntent) || isObj(task.observedPr)) return stale('a pull-request step is pending — it governs before the adjudication gate');
      if (shaOf('criteria.json') !== b.criteriaSha) return stale('criteria.json changed since the question was parked');
      if (shaOf('approval.json') !== b.approvalSha) return stale('the approval changed since the question was parked');
      if (!apr()) return stale('the approval no longer matches the artifacts — the plan phase governs again');
      if (existsSync(join(stateDir, 'blockers.json'))) return stale('open blockers exist — reconciliation precedes the adjudication gate');
      const id = gitId();
      if (id === undefined) return stale('the repository is needed to verify this note');
      if (isBlank(b.headSha) || b.headSha !== id.headSha) return stale('the code moved since this note was parked');
      const { governing } = deriveAdjudication({
        stateDir, ledgerEntries: ledger(), criteriaDoc: readJsonIf('criteria.json'),
        approvalBytes: readIf('approval.json'), getHeadSha: () => id.headSha,
      });
      const pendingStill = b.criterionIds.some((id2) => !governing.has(id2));
      return pendingStill ? current() : spent('every listed criterion now has a recorded adjudication');
    }
    case 'pr-pending':
    case 'pr-migration': {
      if (isBlank(b.intentHash)) return stale('the parked PR binding is incomplete');
      if ((task.prResolutions ?? []).some((r) => isObj(r) && r.type === 'observation' && r.intentHash === b.intentHash)) {
        return spent('the pending PR intent was resolved by a recorded observation');
      }
      if (!isObj(task.prIntent) || sha256(JSON.stringify(task.prIntent)) !== b.intentHash) return spent('the pending PR intent was resolved or superseded');
      // which of the two PR-phase gates governs is an authority question:
      // stale earned authority → the migration STOP; current → the pending gate
      const authorityCurrent = (() => {
        if (!apr()) return false;
        const id = gitId();
        if (id === undefined) throw new Error('repo required');
        const criteriaDoc = readJsonIf('criteria.json');
        const { digest } = deriveAdjudication({
          stateDir,
          ledgerEntries: ledger(),
          criteriaDoc,
          approvalBytes: readIf('approval.json'),
          getHeadSha: () => id.headSha,
        });
        return digest === (task.reviewBase?.adjudicationsSha ?? 'NONE');
      })();
      if (w.kind === 'pr-migration' ? authorityCurrent : !authorityCurrent) {
        return stale('the earned PR authority moved — run next to re-present the governing PR step');
      }
      return current();
    }
    case 'pr-observed': {
      if (isBlank(b.intentHash) || isBlank(b.reviewBaseSha)) return stale('the parked PR binding is incomplete');
      if ((task.prResolutions ?? []).some((r) => isObj(r) && r.type === 'disposition' && r.intentHash === b.intentHash)) {
        return spent('the observed PR was dispositioned by a recorded act');
      }
      if (!isObj(task.observedPr) || task.observedPr.intentHash !== b.intentHash) return spent('the observed PR record was resolved or superseded');
      if (task.reviewBase?.sha !== b.reviewBaseSha) return stale('the reviewed baseline moved since this note was parked');
      const id = gitId();
      if (id === undefined) return stale('the repository is needed to verify this note');
      if (id.headSha !== b.reviewBaseSha) return stale('the code moved since this note was parked');
      // these gates present only under the CURRENT earned authority — a
      // voided approval or a moved adjudication digest re-routes to the plan
      // phase / migration instead
      const aprState = approvalStateFor(stateDir, task);
      if (aprState.present !== true || aprState.matches !== true) return stale('the approval no longer matches the artifacts — the plan phase governs again');
      if (JSON.stringify(task.reviewBase?.approvalHashes) !== JSON.stringify(aprState.approval.sha256)) {
        return stale('the reviewed baseline was earned under a different approval');
      }
      const criteriaDoc2 = readJsonIf('criteria.json');
      const { digest: digest2 } = deriveAdjudication({
        stateDir,
        ledgerEntries: ledger(),
        criteriaDoc: criteriaDoc2,
        approvalBytes: readIf('approval.json'),
        getHeadSha: () => id.headSha,
      });
      if (digest2 !== (task.reviewBase?.adjudicationsSha ?? 'NONE')) return stale('the adjudication state moved past the earned review');
      // the head-match form is ben's follow-up; the mismatch form is the human's —
      // derived from state, and the note's claimed owner must corroborate
      const derivedOwner = task.observedPr.headSha === b.reviewBaseSha ? 'model' : 'human';
      if (w.owner !== derivedOwner) return stale('the parked note no longer matches the governing PR step');
      return current();
    }
    case 'abandoned': {
      const sha = shaOf('ABANDON.md');
      if (sha === undefined) return spent('ABANDON.md was deleted — the task reopened');
      if (sha !== b.abandonSha) return stale('ABANDON.md changed since this note was parked');
      return current();
    }
    default:
      return stale('this note kind carries no verifiable binding');
  }
}
