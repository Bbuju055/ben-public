#!/usr/bin/env node
// ledger — review-round adjudication.
// Behaviour ported from reviewPanel()/appendResolutions() in src/orchestrator/machine.ts
// and src/ledger/ledger.ts (legacy implementation).
// Zero dependencies. Node only.
//
// Usage:
//   node scripts/ledger.mjs round <dir> --kind plan|diff --verdict name=path [--verdict name=path ...] [--cap N] [--cap-max N]
//   node scripts/ledger.mjs resolve <dir> --kind plan|diff [--resolutions f]
//   node scripts/ledger.mjs grant <dir> --kind plan|diff --rounds N --by <who>
//   node scripts/ledger.mjs adjudicate <dir> --record <file>
//   node scripts/ledger.mjs attest <dir> --url u --head-ref h --body-sha s --remote-updated-at t --observed-at o --by <who>
//
// `adjudicate`: the grant-precedent dual
// write for one manual-criterion adjudication act — validates the complete
// record via the shared lib, appends it to the adjudications.json ACT REGISTER
// (superset-only: existing records are never removed), then appends the ledger
// audit entry (kind "adjudication", round 0, action "adjudicated", fingerprint
// = record digest, the complete record embedded verbatim). run.mjs owns the
// crash-intent machinery around this referee.
//
// `attest`: appends the durable publication attestation (kind
// "publication", round 0, action "attested", fingerprint = bodySha, the
// structured observation embedded). Append-only; task.pr is never touched.
//
// `round` adjudicates one review round from the reviewers' verdict files:
//   - only severity BLOCKER gates; MAJOR/NIT stay in the verdict files and never block
//   - a blocker without evidence or falsifier is auto-dropped
//   - a fingerprint rejected in an earlier round, re-raised byte-identically without an
//     exact respondsTo naming it, is dropped (Tier 1); reworded or legacy re-raises are
//     never dropped — they surface flagged with their prior rejection(s) as context
//   - byte-identical blockers merge into one thread; contest handles (respondsTo)
//     aggregate onto the thread instead of being discarded
//   - an unparseable verdict counts as an abstain; an absent verdict is never a pass
// Effects: appends to ledger.jsonl (append-only), writes blockers.json when blockers
// survive, and increments the round tally in rounds.json (the plan tally is the same
// budget pregate bounces consume).
//
// `resolve` runs after honesty.mjs accepts a reconcile: it appends one ledger entry per
// resolution (resolved/rejected/deferred) and deletes blockers.json. Rejected entries are
// what re-raise suppression reads in later rounds. When the cumulative ledger shows only
// capitulation (>= 5 resolved, zero rejected, across rounds and kinds) it warns — a
// script cannot judge severity, but it can smell a treadmill.
//
// `grant` records a human budget extension as a first-class operation: who/when/how many
// land in rounds.json and the ledger. A grant raises that kind's round cap by N in the
// `round` exhaustion check — never a hand-edit of the tally — and lifts that kind's
// durable rounds.gate record (the recorded human act is the only policy-side clear).
//
// Convergence window (--cap-max, the operator's hard boundary): past the soft cap a
// blocker-bearing round auto-continues to reconcile ONLY while the review is converging
// (strictly fewer surviving blockers than the previous consumed round, or the same count
// composed purely of the previous round's exact fingerprints), from unambiguous durable
// records (rounds.survivors bookkeeping + matching raised rows + agreeing grant records),
// and strictly inside the hard cap. Everything else exits 2 with the governing reason and
// a durable rounds.gate record, so the owed human gate survives any crash.
//
// Exit codes (round): 0 unanimous GO · 1 blockers survive, reconcile them · 2 escalated,
// human decision (all abstained; abstain with zero blockers; rounds exhausted; not
// converging; hard cap; ambiguous records; standing rounds.gate) · 3 usage/IO.
// Exit codes (resolve): 0 recorded · 3 usage/IO. Exit codes (grant): 0
// recorded · 1 conditional grant refused (--expect-rounds-sha mismatch, zero
// writes) · 3 usage/IO.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import {
  adjudicationDetail,
  assertAdjudicationActAllowed,
  assertAttestationAllowed,
  assertBasisProvenance,
  assertNoRegisterConflicts,
  checkRegisterAgainstLedger,
  classifyRecords,
  publicationDetail,
  readLedgerStrict,
  readReviewOutput,
  recordDigest,
  resolveRepoForState,
  roundsGatesIssues,
  validateAdjudicationRecord,
  validateAuditEntry,
  validSequencerTask,
} from './adjudication.lib.mjs';

const SEVERITIES = ['BLOCKER', 'MAJOR', 'NIT'];
const ACTIONS = ['resolved', 'rejected', 'deferred'];
// capitulation smell: this many cumulative resolved with zero rejected trips the warning
const CAPITULATION_THRESHOLD = 5;

function fail(msg) {
  console.error(`ledger: ${msg}`);
  process.exit(3);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function optionalString(v) {
  return v === undefined || typeof v === 'string';
}

const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|css|html|py|rs|go|sql|toml|yaml|yml|sh)$/i;

// LOSSY CONTEXT LINK ONLY — the retired v1 fingerprint algorithm, byte-for-byte
// (including the `?? []` degenerate zero-token key: preserving
// historical links beats nulling them). Its sole use is attaching priorRejections
// context to re-raises of historically rejected findings. It NEVER participates in
// identity: never dedupes, never suppresses, never gates.
function contextKeyOf(b) {
  const tokens = (b.evidence ?? '').match(/[\w.@/-]+/g) ?? [];
  const paths = [...new Set(tokens.filter((t) => t.includes('/') || CODE_EXT_RE.test(t)))].sort();
  const basis =
    paths.length > 0
      ? `${b.criterionRef ?? ''}|${paths.join('|')}`
      : `${b.criterionRef ?? ''}|${(b.claim.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ')}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

// v2 fingerprint — EXACT defect identity and nothing else: criterionRef, sorted
// extracted evidence paths, claim and evidence, all byte-exact (zero normalization —
// no trim, no case folding, no location rewriting), injectively encoded as a
// JSON.stringify tuple (delimiter and JSON characters in any field are inert), full
// 64-hex SHA-256. Reviewer identity and respondsTo are excluded. Byte-identical
// tuples are the only merge; a 12-hex legacy fp can never equal a 64-hex v2 fp.
function fingerprintBlocker(b) {
  const tokens = (b.evidence ?? '').match(/[\w.@/-]+/g) ?? [];
  const paths = [...new Set(tokens.filter((t) => t.includes('/') || CODE_EXT_RE.test(t)))].sort();
  return createHash('sha256')
    .update(JSON.stringify(['v2', b.criterionRef ?? '', paths, b.claim, b.evidence]))
    .digest('hex');
}

function ledgerEntry(kind, round, reviewer, blockerId, fingerprint, action, detail) {
  return { ts: new Date().toISOString(), kind, round, reviewer, blockerId, fingerprint, action, detail };
}

// append-only — ledger.jsonl is never rewritten
function appendLedger(path, entries) {
  if (entries.length === 0) return;
  appendFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

function renderLedger(entries) {
  if (entries.length === 0) return '(empty)';
  return entries
    .map(
      (e) =>
        `[${e.kind} round ${e.round}] ${e.action} ${e.fingerprint || '-'} (${e.reviewer}${e.blockerId ? `/${e.blockerId}` : ''}): ${e.detail}`,
    )
    .join('\n');
}

function rejectedFingerprints(entries, kind) {
  return new Set(entries.filter((e) => e.kind === kind && e.action === 'rejected').map((e) => e.fingerprint));
}

// same shape as verdictSchema in src/schemas.ts, hand-rolled (zero deps)
function parseVerdict(raw) {
  const v = JSON.parse(raw);
  if (!isObj(v) || !['GO', 'NO_GO'].includes(v.verdict)) throw new Error('bad verdict');
  const blockers = v.blockers ?? [];
  if (!Array.isArray(blockers)) throw new Error('bad blockers');
  for (const b of blockers) {
    if (
      !isObj(b) ||
      typeof b.id !== 'string' ||
      b.id.length === 0 ||
      !SEVERITIES.includes(b.severity) ||
      typeof b.claim !== 'string' ||
      b.claim.length === 0 ||
      !optionalString(b.evidence) ||
      !optionalString(b.falsifier) ||
      !optionalString(b.criterionRef) ||
      !optionalString(b.respondsTo)
    ) {
      throw new Error('bad blocker');
    }
  }
  return { verdict: v.verdict, blockers };
}

function readRounds(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObj(parsed)) throw new Error('expected an object');
  return parsed;
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: 'string' },
      verdict: { type: 'string', multiple: true, default: [] },
      cap: { type: 'string', default: '3' },
      'cap-max': { type: 'string' },
      resolutions: { type: 'string', default: 'resolutions.json' },
      rounds: { type: 'string' },
      by: { type: 'string' },
      'expect-rounds-sha': { type: 'string' },
      record: { type: 'string' },
      repo: { type: 'string' },
      url: { type: 'string' },
      'head-ref': { type: 'string' },
      'body-sha': { type: 'string' },
      'remote-updated-at': { type: 'string' },
      'observed-at': { type: 'string' },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;

const command = positionals[0];
if (!['round', 'resolve', 'grant', 'adjudicate', 'attest'].includes(command)) {
  fail('first argument must be "round", "resolve", "grant", "adjudicate" or "attest"');
}
const dir = resolvePath(positionals[1] ?? '.');
// --kind and --cap are round/resolve/grant arguments; the audit commands carry their own kinds
const kind = values.kind;
if (['round', 'resolve', 'grant'].includes(command) && kind !== 'plan' && kind !== 'diff') fail('--kind must be "plan" or "diff"');
const cap = Number(values.cap);
if (!Number.isInteger(cap) || cap < 1) fail(`--cap must be a positive integer, got "${values.cap}"`);
// the operator's hard review boundary: optional; when present it must dominate
// the soft cap — a present-but-invalid value is a usage failure, never ignored
let capMax;
if (values['cap-max'] !== undefined) {
  capMax = Number(values['cap-max']);
  if (!Number.isSafeInteger(capMax) || capMax < cap) fail(`--cap-max must be an integer >= --cap (${cap}), got "${values['cap-max']}"`);
}

const ledgerFile = join(dir, 'ledger.jsonl');
const blockersFile = join(dir, 'blockers.json');
const roundsPath = join(dir, 'rounds.json');

// every ledger read in this referee goes through the ONE shared strict
// boundary: strict framing (LF only, no blank lines, terminated final
// record, valid JSON) plus complete inert-row validation — illegal bytes are
// never silently normalized into legal history
function readLedgerValidated(path) {
  try {
    return readLedgerStrict(path);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// preflight — shared by EVERY mutation command before any write: the
// strict ledger boundary above AND register/ledger agreement. Divergence in
// either direction, an invalid register record, or illegal framing STOPs
// with zero mutation.
function preflightAuthoritativeState() {
  const entries = readLedgerValidated(ledgerFile);
  const registerPath = join(dir, 'adjudications.json');
  let register = [];
  if (existsSync(registerPath)) {
    try {
      register = JSON.parse(readFileSync(registerPath, 'utf8'));
    } catch (err) {
      fail(`adjudications.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(register)) fail('adjudications.json must be a JSON array — the act register');
    for (const r of register) {
      const rIssues = validateAdjudicationRecord(r);
      if (rIssues.length > 0) fail(`invalid record in adjudications.json (${r?.criterionId ?? '?'}): ${rIssues.join('; ')}`);
    }
  }
  try {
    checkRegisterAgainstLedger(register, entries);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  return { entries, register };
}

// no audit row leaves this writer unless the SAME shared schema its readers
// enforce accepts it — producer and consumer can never disagree
function assertAppendableAuditRow(entry) {
  const issues = validateAuditEntry(entry);
  if (issues.length > 0) fail(`refusing to append an audit row its consumers would reject: ${issues.join('; ')}`);
}

// the adjudication mutation commands are documented, supported entry points — they
// enforce the SAME task-level preconditions as run.mjs's human-act
// commands (shared lib guards; no weaker entry point exists)
function readTaskForGuards() {
  const taskPath = join(dir, 'task.json');
  if (!existsSync(taskPath)) fail('no task.json — the F9 audit commands need an initialized task');
  let task;
  try {
    task = JSON.parse(readFileSync(taskPath, 'utf8'));
  } catch (err) {
    fail(`task.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  // the SAME semantic task definition the sequencer enforces (shared lib) —
  // this referee never mints durable authority for a task run.mjs would reject
  if (!validSequencerTask(task)) {
    fail(`task.json does not match the sequencer schema — a human reconciles per the playbook before any durable act\ncontent: ${JSON.stringify(task)}`);
  }
  return task;
}

function repoForGuards() {
  try {
    return resolveRepoForState(dir, values.repo);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

if (command === 'adjudicate') {
  if (typeof values.record !== 'string' || values.record.trim() === '') fail('--record <file> is required — the complete canonical adjudication record');
  let record;
  try {
    record = JSON.parse(readFileSync(resolvePath(dir, values.record), 'utf8'));
  } catch (err) {
    fail(`record file unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const issues = validateAdjudicationRecord(record);
  if (issues.length > 0) fail(`record does not match the adjudication schema: ${issues.join('; ')}`);
  const digest = recordDigest(record);
  const registerPath = join(dir, 'adjudications.json');
  // the referee is independently runnable, so it enforces the SAME invariants
  // as the sequencer before any mutation: the task-level preconditions,
  // valid current state, register/ledger agreement (shared preflight),
  // exact basis provenance, register conflict-freedom, and the total
  // comparator — the tooling itself can never mint a replica, mask a corrupt
  // register, or write a conflict
  const task = readTaskForGuards();
  const { entries: priorLedgerEntries, register } = preflightAuthoritativeState();
  try {
    assertAdjudicationActAllowed({ stateDir: dir, repoDir: repoForGuards(), task, record });
    // an ALREADY-conflicting register fails closed BEFORE replay classification
    // a replay of one half can never mask existing corruption
    assertNoRegisterConflicts(register);
    assertBasisProvenance([...register, record], priorLedgerEntries);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  for (const existing of register) {
    const cls = classifyRecords(record, existing);
    if (cls === 'replay') {
      console.log(`ledger: this exact adjudication act is already recorded for ${record.criterionId} (digest ${digest}) — no-op, nothing written.`);
      process.exit(0);
    }
    if (cls === 'conflict') {
      fail(
        `a conflicting adjudication record exists for ${record.criterionId} — same binding identity, different content. Refused at write; nothing was written.\nrecorded: ${JSON.stringify(existing)}\nsubmitted: ${JSON.stringify(record)}`,
      );
    }
  }
  // superset-only: the register is history; a write only ever appends
  const auditRow = {
    ...ledgerEntry('adjudication', 0, record.by, record.criterionId, digest, 'adjudicated', adjudicationDetail(record)),
    record,
  };
  assertAppendableAuditRow(auditRow);
  const next = [...register, record];
  const tmp = `${registerPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, registerPath);
  appendLedger(ledgerFile, [auditRow]);
  console.log(`ledger: adjudication recorded — ${record.criterionId} ${record.decision} by ${record.by} (digest ${digest})`);
  process.exit(0);
}

if (command === 'attest') {
  const p = {
    url: values.url,
    headRefOid: values['head-ref'],
    bodySha: values['body-sha'],
    remoteUpdatedAt: values['remote-updated-at'],
    observedAt: values['observed-at'],
    by: values.by,
  };
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'string' || v.trim() === '') fail(`attest requires a non-blank ${k}`);
  }
  if (!/^[0-9a-f]{64}$/.test(p.bodySha)) fail('--body-sha must be 64 hex chars (the canonical body digest)');
  // terminal binding — the SAME shared guard as record-publication: the
  // exact task.pr.url, the exact task.pr.headSha, the CURRENT body's digest
  const task = readTaskForGuards();
  preflightAuthoritativeState(); // strict framing + register/ledger agreement before the append
  try {
    assertAttestationAllowed({ stateDir: dir, repoDir: repoForGuards(), task, publication: p });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // the writer consumes the readers' schema: a row every consumer would
  // reject (e.g. a non-ISO locally-supplied observedAt) is refused unwritten
  const attestRow = {
    ...ledgerEntry('publication', 0, p.by, '', p.bodySha, 'attested', publicationDetail(p)),
    publication: p,
  };
  assertAppendableAuditRow(attestRow);
  appendLedger(ledgerFile, [attestRow]);
  console.log(`ledger: publication attested — ${p.url} @ ${p.headRefOid} (body ${p.bodySha})`);
  process.exit(0);
}

let rounds;
try {
  rounds = readRounds(roundsPath);
} catch (err) {
  fail(`rounds.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
}
const roundTally = () => (Number.isInteger(rounds[kind === 'plan' ? 'plan' : 'diff']) ? rounds[kind === 'plan' ? 'plan' : 'diff'] : 0);
const grantedRounds = () =>
  (Array.isArray(rounds.grants) ? rounds.grants : [])
    .filter((g) => isObj(g) && g.kind === kind && Number.isInteger(g.rounds) && g.rounds > 0)
    .reduce((sum, g) => sum + g.rounds, 0);
// durable exit-2 dispositions, one slot per kind — the shared exact-shape
// validator runs before ANY read, write, or clear of rounds.gates
const validatedGates = () => {
  const issues = roundsGatesIssues(rounds);
  if (issues.length > 0) fail(`rounds.gates is malformed — a human reconciles per the playbook: ${issues.join('; ')}`);
  return isObj(rounds.gates) ? rounds.gates : {};
};

if (command === 'grant') {
  const granted = Number(values.rounds);
  if (!Number.isInteger(granted) || granted < 1) fail(`--rounds must be a positive integer, got "${values.rounds}"`);
  const by = values.by?.trim();
  if (!by) fail('--by is required — a grant is recorded with who made it');
  // pre-mutation boundary: illegal framing OR register/ledger divergence
  // causes zero writes — the rounds.json grant and its audit row land beside
  // authoritative history or not at all
  preflightAuthoritativeState();
  // conditional grant: when the caller
  // validated a live gate, the grant is a compare-and-swap on the EXACT
  // rounds.json bytes it validated — the check and the mutation share one
  // read, so a stop cleared (or any state moved) underneath the answer
  // refuses at this authoritative boundary with zero writes. The flag is
  // opt-in: the legacy unconditional record-grant semantics are untouched.
  if (values['expect-rounds-sha'] !== undefined) {
    const expected = values['expect-rounds-sha'];
    if (!/^[0-9a-f]{64}$/.test(expected)) fail('--expect-rounds-sha must be 64 hex chars (sha256 of the validated rounds.json bytes)');
    const raw = existsSync(roundsPath) ? readFileSync(roundsPath) : Buffer.alloc(0);
    if (createHash('sha256').update(raw).digest('hex') !== expected) {
      console.log('ledger: grant REFUSED — rounds.json no longer matches the state the answer validated (--expect-rounds-sha mismatch). Nothing was written; no budget was granted and no gate was cleared. Re-derive with run.mjs next.');
      process.exit(1);
    }
    // the mutation basis is re-bound to the verified bytes themselves
    const reparsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    if (!isObj(reparsed)) fail('rounds.json is not an object');
    rounds = reparsed;
  }
  const grant = { kind, rounds: granted, by, at: new Date().toISOString() };
  rounds.grants = Array.isArray(rounds.grants) ? [...rounds.grants, grant] : [grant];
  // a durable exit-2 disposition (rounds.gates) is lifted ONLY here — by the
  // recorded human act, in the same write that lands the grant, and only for
  // the grant's own kind; the other kind's owed gate is untouched
  if (validatedGates()[kind] !== undefined) {
    delete rounds.gates[kind];
    if (Object.keys(rounds.gates).length === 0) delete rounds.gates;
  }
  writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
  appendLedger(ledgerFile, [
    ledgerEntry(kind, roundTally(), by, '', '', 'granted', `human granted ${granted} more ${kind} round(s)`),
  ]);
  console.log(`ledger: ${by} granted ${granted} more ${kind} round(s) — recorded in rounds.json and the ledger`);
  process.exit(0);
}

if (command === 'resolve') {
  if (!existsSync(blockersFile)) fail('blockers.json not found — nothing to resolve');
  // pre-mutation boundary: illegal framing OR register/ledger divergence
  // causes zero appends and zero deletions
  preflightAuthoritativeState();
  const blockers = JSON.parse(readFileSync(blockersFile, 'utf8'));
  const resolutions = JSON.parse(readFileSync(join(dir, values.resolutions), 'utf8'));
  if (!Array.isArray(blockers) || !Array.isArray(resolutions)) fail('blockers.json and resolutions must be arrays');
  for (const r of resolutions) {
    if (!isObj(r) || typeof r.fingerprint !== 'string' || !ACTIONS.includes(r.action) || typeof r.detail !== 'string') {
      fail('resolutions do not match the reconcile schema — run honesty.mjs first');
    }
  }
  const byFp = new Map(blockers.map((b) => [b.fingerprint, b]));
  const entries = resolutions
    .filter((r) => byFp.has(r.fingerprint))
    .map((r) => {
      const b = byFp.get(r.fingerprint);
      return ledgerEntry(kind, roundTally(), b.reviewer, b.id, r.fingerprint, r.action, r.detail);
    });
  appendLedger(ledgerFile, entries);
  rmSync(blockersFile, { force: true });
  console.log(`ledger: recorded ${entries.length} resolution(s) for ${kind} round ${roundTally()}, blockers.json closed`);
  // capitulation smell — cumulative, across rounds and kinds: all-resolved past the
  // threshold is a treadmill signature, not a diligence record
  const cumulative = readLedgerValidated(ledgerFile);
  const resolvedCount = cumulative.filter((e) => e.action === 'resolved').length;
  const rejectedCount = cumulative.filter((e) => e.action === 'rejected').length;
  if (resolvedCount >= CAPITULATION_THRESHOLD && rejectedCount === 0) {
    console.log(
      `ledger: WARNING — zero rejections across ${resolvedCount} resolutions — check for severity inflation; capitulating to an unsatisfiable demand is a failure, not diligence`,
    );
  }
  process.exit(0);
}

// --- round ---
// a durable exit-2 disposition for this kind outlives any crash between
// adjudication and the sequencer's gate presentation: re-present it verbatim,
// write nothing — only a recorded human act (grant / playbook / ABANDON)
// clears its kind's slot in rounds.gates (per-kind slots: one kind's owed
// gate is never erased or blocked by the other kind's activity)
{
  const standingGate = validatedGates()[kind];
  if (standingGate !== undefined) {
    console.log(`${standingGate.reason}\n\nLedger:\n${renderLedger(readLedgerValidated(ledgerFile))}`);
    process.exit(2);
  }
}
const verdictArgs = values.verdict.map((v) => {
  const eq = v.indexOf('=');
  if (eq < 1) fail(`--verdict must be name=path, got "${v}"`);
  return { name: v.slice(0, eq), path: v.slice(eq + 1) };
});
if (verdictArgs.length === 0) fail('round requires at least one --verdict name=path');

const { entries: priorLedger } = preflightAuthoritativeState();
const priorRejected = rejectedFingerprints(priorLedger, kind);
// contextKey → every rejected fingerprint it links to (kind-scoped). Sources: (a) the
// stored contextKey of raised entries whose fingerprint was later rejected; (b) every
// rejected fingerprint as its own key — historical pre-v2 fps ARE old-algorithm outputs
// (64-hex v2 fps are inert as keys: contextKeyOf never emits 64 hex). Context only —
// this map attaches priorRejections flags and can affect nothing else.
const rejectedContextKeys = new Map();
const linkRejected = (key, fp) => {
  if (!rejectedContextKeys.has(key)) rejectedContextKeys.set(key, new Set());
  rejectedContextKeys.get(key).add(fp);
};
for (const e of priorLedger) {
  if (e.kind === kind && e.action === 'raised' && typeof e.contextKey === 'string' && priorRejected.has(e.fingerprint)) {
    linkRejected(e.contextKey, e.fingerprint);
  }
}
for (const fp of priorRejected) linkRejected(fp, fp);
const round = roundTally() + 1;

const entries = []; // drops and abstains in encounter order; raised entries appended in phase 2
const surviving = []; // in-memory threads, creation order — the single write happens after all verdicts
let abstains = 0;

for (const { name, path } of verdictArgs) {
  const verdictPath = resolvePath(dir, path);
  let verdict;
  try {
    verdict = parseVerdict(readReviewOutput(verdictPath));
  } catch {
    // an absent or unparseable verdict is an abstain, never a pass
    abstains += 1;
    entries.push(ledgerEntry(kind, round, name, '', '', 'abstain', `output unparseable — raw at ${verdictPath}`));
    continue;
  }

  for (const b of verdict.blockers) {
    if (b.severity !== 'BLOCKER') continue; // only BLOCKER gates
    const fp = fingerprintBlocker(b);
    if (!b.evidence?.trim() || !b.falsifier?.trim()) {
      // a blocker that cannot be falsified does not gate
      entries.push(
        ledgerEntry(kind, round, name, b.id, fp, 'auto-dropped', `missing ${b.evidence?.trim() ? 'falsifier' : 'evidence'}: ${b.claim}`),
      );
      continue;
    }
    // Tier 1 — exact identity suppression: a byte-identical re-raise of a rejected
    // fingerprint is dropped unless respondsTo names that fingerprint BYTE-EXACTLY
    // (no trim — a stray-whitespace handle does not escape; the message cites the
    // live handle). contextKey plays no part here.
    if (priorRejected.has(fp) && b.respondsTo !== fp) {
      entries.push(
        ledgerEntry(
          kind,
          round,
          name,
          b.id,
          fp,
          're-raise-dropped',
          `fingerprint ${fp} was rejected in an earlier round and re-raised without exact respondsTo ${fp}: ${b.claim}`,
        ),
      );
      continue;
    }
    // thread merge — same-round dedupe on the exact v2 fingerprint only: the first
    // encounter opens the thread (first-raiser attribution); duplicates merge their
    // contest handles into it instead of being discarded
    let thread = surviving.find((s) => s.fingerprint === fp);
    if (!thread) {
      thread = {
        fingerprint: fp,
        reviewer: name,
        id: b.id,
        claim: b.claim,
        evidence: b.evidence,
        falsifier: b.falsifier,
        criterionRef: b.criterionRef?.trim() ? b.criterionRef : undefined,
        contextKey: contextKeyOf(b),
        respondsTo: new Set(),
        priorRejections: new Set(),
      };
      surviving.push(thread);
    }
    if (b.respondsTo) thread.respondsTo.add(b.respondsTo); // exact bytes; '' is the only no-contest sentinel
    // context linking — flag only, never disposition
    for (const rfp of rejectedContextKeys.get(thread.contextKey) ?? []) thread.priorRejections.add(rfp);
  }
}

// phase 2 — exactly one final raised entry per surviving thread, after ALL verdicts:
// contest and context metadata are aggregated sorted-unique (order-independent) and
// land durably in both the raised detail and blockers.json
const finalBlockers = [];
for (const t of surviving) {
  const priorRejections = [...t.priorRejections].sort();
  const respondsTo = [...t.respondsTo].sort();
  let detail = t.claim;
  if (priorRejections.length > 0) detail += ` [prior rejection(s): ${priorRejections.join(' ')}]`;
  if (respondsTo.length > 0) detail += ` [contests: ${respondsTo.join(' ')}]`;
  entries.push({
    ...ledgerEntry(kind, round, t.reviewer, t.id, t.fingerprint, 'raised', detail),
    contextKey: t.contextKey,
    ...(priorRejections.length > 0 ? { priorRejections } : {}),
    ...(respondsTo.length > 0 ? { respondsTo } : {}),
  });
  finalBlockers.push({
    fingerprint: t.fingerprint,
    reviewer: t.reviewer,
    id: t.id,
    claim: t.claim,
    evidence: t.evidence,
    falsifier: t.falsifier,
    criterionRef: t.criterionRef,
    contextKey: t.contextKey,
    ...(priorRejections.length > 0 ? { priorRejections } : {}),
    ...(respondsTo.length > 0 ? { respondsTo } : {}),
  });
}

appendLedger(ledgerFile, entries);

if (abstains === verdictArgs.length) {
  console.log(`every ${kind} reviewer abstained in round ${round}\n\nLedger:\n${renderLedger(readLedgerValidated(ledgerFile))}`);
  process.exit(2);
}
if (surviving.length > 0) {
  // blockers consume a budget unit; the plan tally is shared with pregate bounces.
  // full-round semantics: a round within budget (count <= cap) gets its reconcile;
  // the cap bites only when a further budget-consuming round would exceed it.
  // The exit-1/exit-2 disposition is decided BEFORE the durable write: an exit-2
  // lands in rounds.gates in the SAME write that advances the tally, so a crash
  // between this adjudication and the sequencer's gate presentation re-presents
  // the identical gate from durable state — it never resumes past it.
  const consumed = roundTally() + 1;
  let gateReason;
  let policyNote;
  if (capMax === undefined) {
    // no hard cap configured: today's arithmetic and gate, unchanged semantics
    const effectiveCap = cap + grantedRounds(); // recorded grants raise the cap, never the tally
    if (consumed > effectiveCap) {
      gateReason = `${kind} rounds exhausted (${consumed - 1}/${effectiveCap} consumed; another blocker-bearing round would exceed the cap)`;
    }
  } else {
    // With a hard cap in play, ONLY fully producible grant records — the exact
    // {kind, rounds, by, at} shape the grant writer emits — raise any window:
    // a malformed same-kind record must never inflate the budget past the
    // validation it would fail. Every window here uses the strict sum.
    const producibleGrant = (g) =>
      isObj(g) &&
      (g.kind === 'plan' || g.kind === 'diff') &&
      Number.isSafeInteger(g.rounds) &&
      g.rounds >= 1 &&
      typeof g.by === 'string' &&
      g.by.trim() !== '' &&
      typeof g.at === 'string' &&
      g.at.trim() !== '';
    const grantsRaw = rounds.grants === undefined ? [] : rounds.grants;
    const grantsArrayOk = Array.isArray(grantsRaw) && grantsRaw.every((g) => isObj(g));
    const sameKindGrants = grantsArrayOk ? grantsRaw.filter((g) => g.kind === kind) : [];
    const validGrants = sameKindGrants.filter(producibleGrant);
    const grantsShapeOk = grantsArrayOk && sameKindGrants.length === validGrants.length;
    const grantedStrict = validGrants.reduce((s, g) => s + g.rounds, 0);
    const effectiveCap = cap + grantedStrict;
    if (consumed > effectiveCap) {
      // convergence window (soft budget → hard cap): the review continues
      // without a human grant ONLY on strict improvement, or on equal count
      // that is pure continuation/contest of the previous round's exact
      // fingerprints (equality with any new defect fingerprint is churn, not
      // convergence). Every ambiguity gates. Gate reasons follow fixed
      // precedence: hard cap → grant records malformed → grant records
      // disagree → previous round unknowable → not converging.
      //
      // The rows this decision consumes are ordinary plan/diff rows the
      // inert-audit validator deliberately skips — each one must carry the
      // complete producible review-record shape before policy may count it;
      // anything less is ambiguity, and ambiguity gates.
      const producibleRow = (e) =>
        isObj(e) &&
        typeof e.ts === 'string' &&
        e.ts.trim() !== '' &&
        (e.kind === 'plan' || e.kind === 'diff') &&
        Number.isSafeInteger(e.round) &&
        e.round >= 0 &&
        typeof e.reviewer === 'string' &&
        e.reviewer.trim() !== '' &&
        typeof e.blockerId === 'string' &&
        typeof e.fingerprint === 'string' &&
        typeof e.action === 'string' &&
        typeof e.detail === 'string';
      const hardCap = capMax + grantedStrict;
      const grantAuditRows = priorLedger.filter((e) => isObj(e) && e.kind === kind && e.action === 'granted');
      const grantAuditsOk = grantAuditRows.every(producibleRow);
      const prevRaised = priorLedger.filter((e) => isObj(e) && e.kind === kind && e.round === consumed - 1 && e.action === 'raised');
      const prevRaisedOk = prevRaised.length > 0 && prevRaised.every((e) => producibleRow(e) && /^[0-9a-f]{64}$/.test(e.fingerprint));
      const survivorsMap = isObj(rounds.survivors) ? rounds.survivors : {};
      const prevKey = `${kind}-${consumed - 1}`;
      const prev = Object.prototype.hasOwnProperty.call(survivorsMap, prevKey) ? survivorsMap[prevKey] : undefined;
      const prevValid = Number.isSafeInteger(prev) && prev >= 1 && prevRaisedOk;
      if (consumed > hardCap) {
        gateReason = `${kind} review reached the hard round cap (${consumed - 1}/${hardCap} consumed) — the operator's safety boundary; continuing needs a recorded human grant`;
      } else if (!grantsShapeOk || !grantAuditsOk) {
        gateReason = `${kind} grant records are malformed — a human reconciles per the playbook before policy can continue the review`;
      } else if (validGrants.length !== grantAuditRows.length) {
        gateReason = `${kind} grant records disagree (rounds.json holds ${validGrants.length} grant(s), the ledger holds ${grantAuditRows.length} audit row(s)) — a half-applied grant is reconciled by a human per the playbook, never consumed by policy`;
      } else if (!prevValid) {
        gateReason = `${kind} round ${consumed - 1}'s surviving-blocker record is missing or invalid (pregate bounce, legacy task, or corrupted bookkeeping) — convergence cannot be established, so continuing needs a recorded human grant`;
      } else {
        const prevFps = new Set(prevRaised.map((e) => e.fingerprint));
        const converging = surviving.length < prev || (surviving.length === prev && surviving.every((t) => prevFps.has(t.fingerprint)));
        if (converging) {
          policyNote = `ledger: convergence policy — blockers ${prev} → ${surviving.length}, round ${consumed} of hard cap ${hardCap}; review continues without an operator grant`;
        } else {
          gateReason =
            surviving.length > prev
              ? `${kind} review is not converging past the soft budget (blockers rose ${prev} → ${surviving.length}) — continuing needs a recorded human grant`
              : `${kind} review is not converging past the soft budget (blockers held at ${surviving.length} with new defect fingerprints) — continuing needs a recorded human grant`;
        }
      }
    }
  }
  const otherGates = validatedGates(); // per-kind slots: the other kind's owed gate survives this write verbatim
  rounds[kind === 'plan' ? 'plan' : 'diff'] = consumed;
  rounds.survivors = { ...(isObj(rounds.survivors) ? rounds.survivors : {}), [`${kind}-${consumed}`]: surviving.length };
  if (gateReason !== undefined) rounds.gates = { ...otherGates, [kind]: { round: consumed, reason: gateReason } };
  writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
  writeFileSync(blockersFile, `${JSON.stringify(finalBlockers, null, 2)}\n`);
  if (gateReason !== undefined) {
    // the human may grant another review round or abort; disputed findings use reconciliation — this is NOT a GO
    console.log(`${gateReason}\n\nLedger:\n${renderLedger(readLedgerValidated(ledgerFile))}`);
    process.exit(2);
  }
  if (policyNote !== undefined) console.log(policyNote);
  console.log(`ledger: ${surviving.length} blocker(s) survive ${kind} round ${round} — reconcile them (blockers.json written)`);
  process.exit(1);
}
if (abstains > 0) {
  // unanimous-go: a missing verdict with no blockers is never a pass
  console.log(`unanimous-go violated in ${kind} round ${round}: ${abstains} reviewer(s) abstained with no blockers`);
  process.exit(2);
}
console.log(`ledger: unanimous GO in ${kind} round ${round}`);
process.exit(0);
