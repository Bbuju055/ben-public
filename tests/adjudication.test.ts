import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { git, makeFixtureRepo, makeTmpDir } from './helpers';
import {
  adjudicationDetail,
  adjudicationsShaOf,
  approvalRelevantLedgerSha,
  canonicalBody,
  checkRegisterAgainstLedger,
  classifyRecords,
  criterionShaOf,
  EMPTY_SHA256,
  governingSelection,
  isValidTimestamp,
  ledgerStampMatches,
  publicationDetail,
  recordDigest,
  sha256,
  validateAdjudicationRecord,
  validateAuditEntry,
  type AdjudicationRecord,
} from '../scripts/adjudication.lib.mjs';

// lib- and referee-level matrix:
// the TOTAL identity model, the approval-relevant ledger digest
// register/ledger divergence, verify.mjs `adjudicated`
// pr.mjs rendering, the repo-context rule, and
// pregate duplicate-id rejection.

const VERIFY = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));
const PR = fileURLToPath(new URL('../scripts/pr.mjs', import.meta.url));
const PREGATE = fileURLToPath(new URL('../scripts/pregate.mjs', import.meta.url));

const S = (repo: string) => join(repo, '.ben');
const headOf = async (repo: string) => (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();

const MANUAL_CRITERION = { id: 'C7', statement: 'a human eyeballs the output once', verification: { method: 'manual' } };
const CMD_CRITERION = { id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } };
const criteriaDoc = () => ({ taskId: 'T1', criteria: [structuredClone(CMD_CRITERION), structuredClone(MANUAL_CRITERION)] });

const APPROVAL_BYTES = Buffer.from(JSON.stringify({ approvedBy: 'operator', at: 't', actId: 'act-1', decision: 'APPROVE', sha256: {} }, null, 2) + '\n');

function makeRecord(overrides: Partial<AdjudicationRecord> = {}, criterion: Record<string, unknown> = structuredClone(MANUAL_CRITERION)): AdjudicationRecord {
  const base: AdjudicationRecord = {
    type: 'adjudication',
    criterionId: String(criterion.id),
    criterionSha: criterionShaOf(criterion),
    criterion,
    approvalActSha: sha256(APPROVAL_BYTES),
    headSha: 'a'.repeat(40),
    decision: 'satisfied',
    ruling: 'checked it by hand, output is right',
    by: 'operator',
    at: '2026-08-24T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function auditRow(r: AdjudicationRecord): Record<string, unknown> {
  return {
    ts: r.at,
    kind: 'adjudication',
    round: 0,
    reviewer: r.by,
    blockerId: r.criterionId,
    fingerprint: recordDigest(r),
    action: 'adjudicated',
    detail: adjudicationDetail(r),
    record: r,
  };
}

/** Seed a state dir with criteria + approval + a hand-consistent register/ledger pair. */
async function seedAdjState(dir: string, records: AdjudicationRecord[], opts: { criteria?: unknown; approvalBytes?: Buffer } = {}): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, 'criteria.json'), JSON.stringify(opts.criteria ?? criteriaDoc(), null, 2));
  await writeFile(join(dir, 'approval.json'), opts.approvalBytes ?? APPROVAL_BYTES);
  await writeFile(join(dir, 'adjudications.json'), `${JSON.stringify(records, null, 2)}\n`);
  for (const r of records) await appendFile(join(dir, 'ledger.jsonl'), `${JSON.stringify(auditRow(r))}\n`);
}

// ---------------------------------------------------------------------------
// the TOTAL comparator, the digest, replicas

test('the comparator is total: replay/conflict/coexistence cover every pair; context never participates', () => {
  const a = makeRecord();
  // replay: different `at` (context) — same act, same digest
  expect(classifyRecords(a, makeRecord({ at: '2026-08-25T09:00:00.000Z' }))).toBe('replay');
  expect(recordDigest(a)).toBe(recordDigest(makeRecord({ at: '2026-08-25T09:00:00.000Z' })));
  // conflict: same binding, different content — ruling or `by`
  expect(classifyRecords(a, makeRecord({ ruling: 'different words' }))).toBe('conflict');
  expect(classifyRecords(a, makeRecord({ by: 'other-operator' }))).toBe('conflict');
  // coexistence: any binding member differs — decision, headSha (satisfied), approval act
  const accepted = makeRecord({ decision: 'accepted', residual: 'large-file rendering untested' });
  expect(classifyRecords(a, accepted)).toBe('coexistence');
  expect(classifyRecords(a, makeRecord({ headSha: 'b'.repeat(40) }))).toBe('coexistence');
  expect(classifyRecords(a, makeRecord({ approvalActSha: sha256('other approval bytes') }))).toBe('coexistence');
  // accepted context headSha is CONTEXT: replay across HEADs, one digest
  const acceptedAtB = makeRecord({ decision: 'accepted', residual: 'large-file rendering untested', headSha: 'b'.repeat(40) });
  expect(classifyRecords(accepted, acceptedAtB)).toBe('replay');
  expect(recordDigest(accepted)).toBe(recordDigest(acceptedAtB));
});

test('the validator enforces the exact shape: unknown fields, residual coupling, tamper, basis pairing', () => {
  expect(validateAdjudicationRecord(makeRecord())).toEqual([]);
  expect(validateAdjudicationRecord({ ...makeRecord(), extra: 'x' }).join(' ')).toContain('unknown field');
  expect(validateAdjudicationRecord(makeRecord({ decision: 'accepted' })).join(' ')).toContain('residual');
  expect(validateAdjudicationRecord(makeRecord({ residual: 'r' })).join(' ')).toContain('forbidden');
  expect(validateAdjudicationRecord(makeRecord({ criterionSha: sha256('tampered') })).join(' ')).toContain('tampering');
  expect(validateAdjudicationRecord(makeRecord({ basisEntry: { kind: 'diff' } })).join(' ')).toContain('forbidden without basis');
  const withBasis = makeRecord({
    basis: { kind: 'diff', round: 4, fingerprint: 'f'.repeat(64), action: 'rejected' },
    basisEntry: { kind: 'diff', round: 4, fingerprint: 'f'.repeat(64), action: 'rejected', detail: 'the ruling' },
  });
  expect(validateAdjudicationRecord(withBasis)).toEqual([]);
  const mismatched = structuredClone(withBasis);
  (mismatched.basisEntry as Record<string, unknown>).round = 3;
  expect(validateAdjudicationRecord(mismatched).join(' ')).toContain('basisEntry.round');
  // deferred does not exist: only satisfied | accepted validate
  expect(validateAdjudicationRecord({ ...makeRecord(), decision: 'deferred' }).join(' ')).toContain('decision');
});

test('governing selection: satisfied over accepted in BOTH insertion orders; stale satisfied falls back to accepted; digests are order-independent (core)', () => {
  const satisfied = makeRecord();
  const accepted = makeRecord({ decision: 'accepted', residual: 'large-file rendering untested' });
  const opts = { criteriaDoc: criteriaDoc(), approvalBytes: APPROVAL_BYTES, getHeadSha: () => 'a'.repeat(40) };
  const g1 = governingSelection([satisfied, accepted], opts);
  const g2 = governingSelection([accepted, satisfied], opts);
  expect(g1.get('C7')?.decision).toBe('satisfied');
  expect(g2.get('C7')?.decision).toBe('satisfied');
  expect(adjudicationsShaOf(g1)).toBe(adjudicationsShaOf(g2));
  // HEAD moves: satisfied loses eligibility, the HEAD-independent accepted governs again — automatically
  const atB = governingSelection([satisfied, accepted], { ...opts, getHeadSha: () => 'b'.repeat(40) });
  expect(atB.get('C7')?.decision).toBe('accepted');
  expect(adjudicationsShaOf(atB)).not.toBe(adjudicationsShaOf(g1)); // the digest flips with the governing set
  // replicas (hand-restoration): one act, one digest, earliest-at representative
  const replica = makeRecord({ decision: 'accepted', residual: 'large-file rendering untested', headSha: 'c'.repeat(40), at: '2026-08-23T00:00:00.000Z' });
  const gr = governingSelection([accepted, replica], { ...opts, getHeadSha: () => 'z'.repeat(40) });
  expect(gr.get('C7')?.at).toBe('2026-08-23T00:00:00.000Z');
  expect(adjudicationsShaOf(gr)).toBe(adjudicationsShaOf(governingSelection([replica, accepted], { ...opts, getHeadSha: () => 'z'.repeat(40) })));
});

test('governing selection fails closed: criterion revision, new approval act, conflicts', () => {
  const satisfied = makeRecord();
  const opts = { criteriaDoc: criteriaDoc(), approvalBytes: APPROVAL_BYTES, getHeadSha: () => 'a'.repeat(40) };
  // criterion revised → historical (nothing governs); byte-exact revert → governs again
  const revised = criteriaDoc();
  (revised.criteria[1] as { statement: string }).statement = 'a human eyeballs the output twice';
  expect(governingSelection([satisfied], { ...opts, criteriaDoc: revised }).size).toBe(0);
  expect(governingSelection([satisfied], opts).get('C7')?.decision).toBe('satisfied');
  // a new approval act deactivates every prior record
  expect(governingSelection([satisfied], { ...opts, approvalBytes: Buffer.from('{"new":"act"}') }).size).toBe(0);
  // absent approval → nothing governs
  expect(governingSelection([satisfied], { ...opts, approvalBytes: undefined }).size).toBe(0);
  // conflict → fail-closed at read
  expect(() => governingSelection([satisfied, makeRecord({ ruling: 'other words' })], opts)).toThrow('conflicting');
});

// ---------------------------------------------------------------------------
// register ⇄ ledger

test('a register-only record is DIVERGENCE; matching replica rows in both files are legitimate', () => {
  const r = makeRecord();
  expect(() => checkRegisterAgainstLedger([r], [])).toThrow('absent from ledger history');
  expect(() => checkRegisterAgainstLedger([], [auditRow(r)])).toThrow('divergence');
  expect(() => checkRegisterAgainstLedger([r], [auditRow(r)])).not.toThrow();
  // a replica whose complete record also exists in ledger history is legitimate
  expect(() => checkRegisterAgainstLedger([r, structuredClone(r)], [auditRow(r)])).not.toThrow();
  // a replica with DIFFERENT bytes (context included) needs its own ledger row
  const replica = makeRecord({ at: '2026-08-25T00:00:00.000Z' });
  expect(() => checkRegisterAgainstLedger([r, replica], [auditRow(r)])).toThrow('absent from ledger history');
  expect(() => checkRegisterAgainstLedger([r, replica], [auditRow(r), auditRow(replica)])).not.toThrow();
});

// ---------------------------------------------------------------------------
// the approval-relevant ledger digest

test('approvalRelevantLedgerSha: ABSENT for empty relevant sets, byte-exact digest over relevant lines only, pinned values', async () => {
  const dir = await makeTmpDir('adj-ledger-');
  const path = join(dir, 'ledger.jsonl');
  // file absent and zero-byte both digest to the literal 'ABSENT'
  expect(approvalRelevantLedgerSha(path)).toBe('ABSENT');
  await writeFile(path, '');
  expect(approvalRelevantLedgerSha(path)).toBe('ABSENT');
  // only inert rows → still 'ABSENT'
  const adj = auditRow(makeRecord());
  await writeFile(path, `${JSON.stringify(adj)}\n`);
  expect(approvalRelevantLedgerSha(path)).toBe('ABSENT');
  // one relevant row → sha256 of exactly that raw line including its LF (pinned independently)
  const raised = { ts: 't', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: 'f'.repeat(64), action: 'raised', detail: 'x' };
  const raisedLine = `${JSON.stringify(raised)}\n`;
  await writeFile(path, `${JSON.stringify(adj)}\n${raisedLine}${JSON.stringify(adj)}\n`);
  expect(approvalRelevantLedgerSha(path)).toBe(sha256(raisedLine));
  // with zero inert rows the filtered digest IS the full-file digest (legacy compatibility by construction)
  await writeFile(path, raisedLine);
  expect(approvalRelevantLedgerSha(path)).toBe(sha256(raisedLine));
});

test('framing fails closed: unterminated final record, blank line, CR byte, invalid inert row ', async () => {
  const dir = await makeTmpDir('adj-framing-');
  const path = join(dir, 'ledger.jsonl');
  const row = JSON.stringify({ ts: 't', kind: 'plan', round: 1, reviewer: 'codex', blockerId: '', fingerprint: '', action: 'raised', detail: 'x' });
  await writeFile(path, row); // no trailing LF
  expect(() => approvalRelevantLedgerSha(path)).toThrow('unterminated');
  await writeFile(path, `${row}\n\n${row}\n`);
  expect(() => approvalRelevantLedgerSha(path)).toThrow('blank line');
  await writeFile(path, `${row}\r\n`);
  expect(() => approvalRelevantLedgerSha(path)).toThrow('CR byte');
  // an inert-kind row failing the audit schema is a STOP, never a silent exclusion
  await writeFile(path, `${JSON.stringify({ kind: 'adjudication', round: 1, action: 'adjudicated' })}\n`);
  expect(() => approvalRelevantLedgerSha(path)).toThrow('audit-record schema');
});

test('ledgerStampMatches: the two canonical legacy empty shapes match the empty set; nothing else does (round-5 C1)', () => {
  expect(ledgerStampMatches('ABSENT', 'ABSENT')).toBe(true);
  expect(ledgerStampMatches(EMPTY_SHA256, 'ABSENT')).toBe(true);
  expect(ledgerStampMatches('d'.repeat(64), 'ABSENT')).toBe(false); // i: relevant stamp vs now-empty set
  expect(ledgerStampMatches('ABSENT', 'd'.repeat(64))).toBe(false);
  expect(ledgerStampMatches(EMPTY_SHA256, 'd'.repeat(64))).toBe(false);
  expect(ledgerStampMatches('d'.repeat(64), 'd'.repeat(64))).toBe(true);
});

test('pins: the approval-relevant digest values are the frozen literals — ABSENT, sha256(empty), and the exact raised-line digest', async () => {
  const dir = await makeTmpDir('adj-pin-');
  const path = join(dir, 'ledger.jsonl');
  expect(EMPTY_SHA256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); // the pinned legacy empty shape
  expect(approvalRelevantLedgerSha(path)).toBe('ABSENT');
  const raised = { ts: 't', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: 'f'.repeat(64), action: 'raised', detail: 'x' };
  await writeFile(path, `${JSON.stringify(raised)}\n`);
  // pinned literal, computed independently of the shared implementation
  expect(approvalRelevantLedgerSha(path)).toBe('a216c69a063cda4ce6f27e82738a6a10cc2f922e7649daa18c8b4f950366a878');
  const adj = auditRow(makeRecord());
  await writeFile(path, `${JSON.stringify(adj)}\n${JSON.stringify(raised)}\n${JSON.stringify(adj)}\n`);
  expect(approvalRelevantLedgerSha(path)).toBe('a216c69a063cda4ce6f27e82738a6a10cc2f922e7649daa18c8b4f950366a878'); // inert rows never shift the pin
});

test('tie-break: equal-`at` replicas with different accepted context keep ARRAY order; the invalid `at` shape is refused', () => {
  const first = makeRecord({ decision: 'accepted', residual: 'r', headSha: 'a'.repeat(40), at: '2026-08-24T00:00:00.000Z' });
  const second = makeRecord({ decision: 'accepted', residual: 'r', headSha: 'b'.repeat(40), at: '2026-08-24T00:00:00.000Z' });
  const opts = { criteriaDoc: criteriaDoc(), approvalBytes: APPROVAL_BYTES, getHeadSha: () => 'z'.repeat(40) };
  expect(governingSelection([first, second], opts).get('C7')?.headSha).toBe('a'.repeat(40));
  expect(governingSelection([second, first], opts).get('C7')?.headSha).toBe('b'.repeat(40));
  expect(adjudicationsShaOf(governingSelection([first, second], opts))).toBe(adjudicationsShaOf(governingSelection([second, first], opts)));
  // `at` must be a real ISO-8601 timestamp — never lexical free text
  expect(validateAdjudicationRecord(makeRecord({ at: 'not-an-ISO-timestamp' })).join(' ')).toContain('ISO-8601');
  expect(validateAdjudicationRecord(makeRecord({ at: '2026-08-24' })).join(' ')).toContain('ISO-8601');
  expect(validateAdjudicationRecord(makeRecord({ at: '2026-08-24T00:00:00Z' }))).toEqual([]);
  expect(validateAdjudicationRecord(makeRecord({ at: '2026-08-24T00:00:00.123+02:00' }))).toEqual([]);
});

test('BLOCKER fix: a tampered audit WRAPPER (valid embedded record) fails closed in every consumer — verify, pr, status, next', async () => {
  const repo = await makeVerifyRepo();
  const RUN = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
  const rec = makeRecord({ headSha: await headOf(repo) });
  await seedAdjState(S(repo), [rec]);
  expect((await verifyCriteria(repo)).stdout).toContain('1 adjudicated'); // baseline: valid wrapper accepted

  // tamper ONLY the wrapper: fingerprint no longer equals the record digest
  const row = { ...auditRow(rec), fingerprint: 'f'.repeat(64) };
  await writeFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(row)}\n`);
  const v = await verifyCriteria(repo);
  expect(v.exitCode).toBe(3);
  expect(v.stderr).toContain('audit-record schema');
  await writeFile(join(S(repo), 'plan.md'), 'p\n');
  expect((await execArgv(['node', PR, S(repo), '--repo', repo, '--title', 't'], { cwd: repo, timeoutMs: 30_000 })).exitCode).toBe(3);
  // status fails closed too — invalid audit rows are surfaced, never rendered as fact
  const status = await execArgv(['node', RUN, 'status', '--repo', repo], { cwd: repo, timeoutMs: 30_000 });
  expect(status.exitCode).toBe(2);
  expect(status.stdout).toContain('invalid audit row');

  // other wrapper tampers: reviewer/actor mismatch, wrong round, unknown wrapper
  // field, a CONTRADICTORY detail (wrapper says accepted, record says satisfied),
  // and a non-ISO wrapper timestamp
  for (const tampered of [
    { ...auditRow(rec), reviewer: 'somebody-else' },
    { ...auditRow(rec), round: 1 },
    { ...auditRow(rec), sneaky: true },
    { ...auditRow(rec), detail: `operator adjudicated C7 accepted: live behavior remains unproven` },
    { ...auditRow(rec), ts: 'not-a-timestamp' },
  ]) {
    await writeFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(tampered)}\n`);
    expect((await verifyCriteria(repo)).exitCode).toBe(3);
  }
});

test('impossible calendar dates and out-of-range fields are refused even though Date.parse normalizes them', () => {
  expect(isValidTimestamp('2026-02-30T00:00:00Z')).toBe(false); // Feb 30 does not exist
  expect(isValidTimestamp('2026-04-31T00:00:00.000Z')).toBe(false);
  expect(isValidTimestamp('2026-13-01T00:00:00Z')).toBe(false);
  expect(isValidTimestamp('2026-08-24T24:00:00Z')).toBe(false);
  expect(isValidTimestamp('2026-08-24T00:60:00Z')).toBe(false);
  expect(isValidTimestamp('2026-08-24T00:00:00+25:00')).toBe(false);
  expect(isValidTimestamp('2026-02-28T23:59:59.999Z')).toBe(true);
  expect(isValidTimestamp('2024-02-29T00:00:00Z')).toBe(true); // real leap day
  expect(isValidTimestamp('2026-02-29T00:00:00Z')).toBe(false); // not a leap year
  expect(validateAdjudicationRecord(makeRecord({ at: '2026-02-30T00:00:00Z' })).join(' ')).toContain('ISO-8601');
});

test('renderer level: hand-restored replicas render as ONE act with the earliest-`at` representative', async () => {
  const repo = await makeFixtureRepo();
  const sdir = join(repo, '.ben');
  mkdirSync(sdir, { recursive: true });
  await writeFile(join(sdir, 'plan.md'), 'p\n');
  await writeFile(join(sdir, 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(sdir, 'approval.json'), APPROVAL_BYTES);
  mkdirSync(join(sdir, 'evidence'), { recursive: true });
  await writeFile(join(sdir, 'evidence', 'criteria-matrix.json'), JSON.stringify({ C1: { status: 'pass', evidencePath: 'x' }, C7: { status: 'manual', evidencePath: 'y' } }));
  // two replicas of one accepted act — different context (`at`, headSha), same digest
  const later = makeRecord({ decision: 'accepted', residual: 'r', headSha: 'b'.repeat(40), at: '2026-08-25T00:00:00.000Z' });
  const earlier = makeRecord({ decision: 'accepted', residual: 'r', headSha: 'c'.repeat(40), at: '2026-08-23T00:00:00.000Z' });
  await seedAdjState(sdir, [later, earlier]);
  const r = await execArgv(['node', PR, sdir, '--repo', repo, '--title', 'test task'], { cwd: repo, timeoutMs: 30_000 });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.split('- **C7 — accepted**').length - 1).toBe(1); // ONE act rendered, never duplicated
  expect(r.stdout).toContain('- **C7 — accepted** by operator at 2026-08-23T00:00:00.000Z'); // the earliest-`at` representative
});

test('referee level: rejected-fingerprint suppression still holds over duplicated round-N history', async () => {
  const LEDGER = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));
  const repo = await makeFixtureRepo();
  const sdir = join(repo, '.ben');
  mkdirSync(join(sdir, 'reviews'), { recursive: true });
  await writeFile(join(sdir, 'rounds.json'), JSON.stringify({ plan: 0 }));
  const exec = (argv: string[]) => execArgv(argv, { cwd: repo, timeoutMs: 30_000 });
  const blocker = { id: 'B1', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' };
  await writeFile(join(sdir, 'reviews', 'plan-round-1-codex.json'), JSON.stringify({ verdict: 'NO_GO', blockers: [blocker] }));
  expect((await exec(['node', LEDGER, 'round', sdir, '--kind', 'plan', '--verdict', 'codex=reviews/plan-round-1-codex.json'])).exitCode).toBe(1);
  const blockers = JSON.parse(await readFile(join(sdir, 'blockers.json'), 'utf8'));
  await writeFile(join(sdir, 'resolutions.json'), JSON.stringify([{ fingerprint: blockers[0].fingerprint, action: 'rejected', detail: 'already proven' }]));
  expect((await exec(['node', LEDGER, 'resolve', sdir, '--kind', 'plan'])).exitCode).toBe(0);
  // Duplicated history: a second pass of round-1 dropped rows
  await appendFile(
    join(sdir, 'ledger.jsonl'),
    `${JSON.stringify({ ts: '2026-08-24T00:00:03.000Z', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: blockers[0].fingerprint, action: 'auto-dropped', detail: 'second pass' })}\n` +
      `${JSON.stringify({ ts: '2026-08-24T00:00:04.000Z', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: blockers[0].fingerprint, action: 'auto-dropped', detail: 'second pass again' })}\n`,
  );
  // the byte-identical re-raise stays mechanically dropped despite the duplicates
  await writeFile(join(sdir, 'reviews', 'plan-round-2-codex.json'), JSON.stringify({ verdict: 'NO_GO', blockers: [blocker] }));
  const round2 = await exec(['node', LEDGER, 'round', sdir, '--kind', 'plan', '--verdict', 'codex=reviews/plan-round-2-codex.json']);
  expect(round2.exitCode).toBe(0);
  expect(await readFile(join(sdir, 'ledger.jsonl'), 'utf8')).toContain('re-raise-dropped');
  expect(JSON.parse(await readFile(join(sdir, 'rounds.json'), 'utf8')).plan).toBe(1); // duplicated history never advances the tally
});

test('read-time provenance: a basisEntry tampered in BOTH files, or citing a missing/ambiguous entry, fails closed', async () => {
  const repo = await makeVerifyRepo();
  const cited = { kind: 'diff', round: 4, fingerprint: 'c'.repeat(64), action: 'rejected', detail: 'the original ruling' };
  const rec = makeRecord({
    headSha: await headOf(repo),
    basis: { kind: 'diff', round: 4, fingerprint: 'c'.repeat(64), action: 'rejected' },
    basisEntry: cited,
  });
  await appendFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(cited)}\n`);
  await seedAdjState(S(repo), [rec]);
  expect((await verifyCriteria(repo)).stdout).toContain('1 adjudicated'); // exact citation resolves

  // tamper the embedded citation in BOTH copies (register + ledger record) — the
  // cited historical row no longer equals it → fail closed
  const tampered = structuredClone(rec);
  (tampered.basisEntry as { detail: string }).detail = 'a fabricated ruling';
  await writeFile(join(S(repo), 'adjudications.json'), `${JSON.stringify([tampered], null, 2)}\n`);
  await writeFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(cited)}\n${JSON.stringify(auditRow(tampered))}\n`);
  const t = await verifyCriteria(repo);
  expect(t.exitCode).toBe(3);
  expect(t.stderr).toContain('does not equal the cited ledger entry');

  // the cited entry missing from history entirely → fail closed
  await writeFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(auditRow(rec))}\n`);
  await writeFile(join(S(repo), 'adjudications.json'), `${JSON.stringify([rec], null, 2)}\n`);
  const missing = await verifyCriteria(repo);
  expect(missing.exitCode).toBe(3);
  expect(missing.stderr).toContain('cited historical authority is missing');

  // two matching locator rows → ambiguous where exactly one is required → fail closed
  await writeFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(cited)}\n${JSON.stringify(cited)}\n${JSON.stringify(auditRow(rec))}\n`);
  const ambiguous = await verifyCriteria(repo);
  expect(ambiguous.exitCode).toBe(3);
  expect(ambiguous.stderr).toContain('ambiguous');
});

// (direct ledger.mjs adjudicate replay/conflict/guard behavior) lives in
// adjudication-flow.test.ts — it needs a complete sequencer-built task state.

test('validateAuditEntry: adjudication and publication rows are schema-checked, digests bound', () => {
  const good = auditRow(makeRecord());
  expect(validateAuditEntry(good)).toEqual([]);
  expect(validateAuditEntry({ ...good, fingerprint: 'f'.repeat(64) }).join(' ')).toContain('digest');
  expect(validateAuditEntry({ ...good, round: 1 }).join(' ')).toContain('round');
  const pubPayload = { url: 'https://x/pr/1', headRefOid: 'a'.repeat(40), bodySha: 'b'.repeat(64), remoteUpdatedAt: 't1', observedAt: '2026-08-24T00:00:01.000Z', by: 'operator' };
  const pub = {
    ts: '2026-08-24T00:00:02.000Z',
    kind: 'publication',
    round: 0,
    reviewer: 'operator',
    blockerId: '',
    fingerprint: 'b'.repeat(64),
    action: 'attested',
    detail: publicationDetail(pubPayload),
    publication: pubPayload,
  };
  expect(validateAuditEntry(pub)).toEqual([]);
  expect(validateAuditEntry({ ...pub, publication: { ...pub.publication, bodySha: 'c'.repeat(64) } }).join(' ')).toContain('bodySha');
  expect(validateAuditEntry({ ...pub, publication: undefined }).join(' ')).toContain('publication');
  // The complete wrapper is exact — unknown fields, actor identity, cross-kind payloads
  expect(validateAuditEntry({ ...good, sneaky: 'x' }).join(' ')).toContain('unknown field');
  expect(validateAuditEntry({ ...good, reviewer: 'somebody-else' }).join(' ')).toContain('actor');
  expect(validateAuditEntry({ ...pub, reviewer: 'somebody-else' }).join(' ')).toContain('publication.by');
  expect(validateAuditEntry({ ...pub, publication: { ...pub.publication, extra: 'x' } }).join(' ')).toContain('unknown field');
  expect(validateAuditEntry({ ...good, publication: pub.publication }).join(' ')).toContain('forbidden on an adjudication entry');
});

test('canonicalBody: CRLF and trailing-newline variants are canonical-equal', () => {
  expect(canonicalBody('a\r\nb\n\n')).toBe('a\nb');
  expect(canonicalBody('a\nb')).toBe('a\nb');
  expect(sha256(canonicalBody('x\r\ny\n'))).toBe(sha256(canonicalBody('x\ny')));
});

// ---------------------------------------------------------------------------
// verify.mjs criteria: governing → `adjudicated`, else `manual`

async function verifyCriteria(repo: string, extraArgs: string[] = []): Promise<ExecResult> {
  return execArgv(['node', VERIFY, 'criteria', S(repo), '--repo', repo, ...extraArgs], { cwd: repo, timeoutMs: 30_000 });
}

async function makeVerifyRepo(): Promise<string> {
  const repo = await makeFixtureRepo();
  mkdirSync(S(repo), { recursive: true });
  await writeFile(join(S(repo), 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(S(repo), 'approval.json'), APPROVAL_BYTES);
  return repo;
}

test('verify.mjs criteria: no record → manual; governing → adjudicated with the record verbatim as evidence; never red', async () => {
  const repo = await makeVerifyRepo();
  const before = await verifyCriteria(repo);
  expect(before.exitCode).toBe(0);
  expect(before.stdout).toContain('1 manual');
  let matrix = JSON.parse(await readFile(join(S(repo), 'evidence', 'criteria-matrix.json'), 'utf8'));
  expect(matrix.C7.status).toBe('manual');

  const head = await headOf(repo);
  const rec = makeRecord({ headSha: head });
  await seedAdjState(S(repo), [rec]);
  const after = await verifyCriteria(repo);
  expect(after.exitCode).toBe(0);
  expect(after.stdout).toContain('1 adjudicated (recorded human decision: C7)');
  matrix = JSON.parse(await readFile(join(S(repo), 'evidence', 'criteria-matrix.json'), 'utf8'));
  expect(matrix.C7.status).toBe('adjudicated');
  // evidence = the record verbatim
  expect(JSON.parse(await readFile(matrix.C7.evidencePath, 'utf8'))).toEqual(JSON.parse(JSON.stringify(rec)));

  // HEAD moves → the satisfied record is stale → back to manual
  await writeFile(join(repo, 'drift.md'), 'x\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'chore: drift');
  const stale = await verifyCriteria(repo);
  expect(stale.exitCode).toBe(0);
  expect(stale.stdout).toContain('1 manual');

  // re-record at the new HEAD (superset: the old record stays) → adjudicated again
  const rec2 = makeRecord({ headSha: await headOf(repo), at: '2026-08-24T01:00:00.000Z' });
  await rm(join(S(repo), 'adjudications.json'));
  await rm(join(S(repo), 'ledger.jsonl'));
  await seedAdjState(S(repo), [rec, rec2]);
  const fresh = await verifyCriteria(repo);
  expect(fresh.stdout).toContain('1 adjudicated');
  const register = JSON.parse(await readFile(join(S(repo), 'adjudications.json'), 'utf8'));
  expect(register).toHaveLength(2); // history is never shrunk
});

test('verify.mjs criteria: a new approval act deactivates records; tamper/conflict/divergence → exit 3', async () => {
  const repo = await makeVerifyRepo();
  const rec = makeRecord({ headSha: await headOf(repo) });
  await seedAdjState(S(repo), [rec]);
  expect((await verifyCriteria(repo)).stdout).toContain('1 adjudicated');

  // new approval bytes → record inactive → manual
  await writeFile(join(S(repo), 'approval.json'), JSON.stringify({ approvedBy: 'operator', actId: 'act-2', sha256: {} }));
  expect((await verifyCriteria(repo)).stdout).toContain('1 manual');
  await writeFile(join(S(repo), 'approval.json'), APPROVAL_BYTES); // byte-exact restore → active again
  expect((await verifyCriteria(repo)).stdout).toContain('1 adjudicated');

  // tampered embedded criterion → exit 3
  const tampered = structuredClone(rec);
  (tampered.criterion as { statement: string }).statement = 'sneakily different';
  await writeFile(join(S(repo), 'adjudications.json'), JSON.stringify([tampered], null, 2));
  const t = await verifyCriteria(repo);
  expect(t.exitCode).toBe(3);
  expect(t.stderr).toContain('adjudication state invalid');

  // conflicting pair → exit 3
  const conflicting = makeRecord({ headSha: rec.headSha, ruling: 'other words entirely' });
  await writeFile(join(S(repo), 'adjudications.json'), JSON.stringify([rec, conflicting], null, 2));
  await appendFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(auditRow(conflicting))}\n`);
  expect((await verifyCriteria(repo)).exitCode).toBe(3);

  // register-only record (absent from ledger) → divergence → exit 3
  const orphan = makeRecord({ ruling: 'never landed in the ledger', headSha: 'e'.repeat(40) });
  await writeFile(join(S(repo), 'adjudications.json'), JSON.stringify([rec, orphan], null, 2));
  const d = await verifyCriteria(repo);
  expect(d.exitCode).toBe(3);
  expect(d.stderr).toContain('divergence');

  // malformed register → exit 3
  await writeFile(join(S(repo), 'adjudications.json'), '{ torn');
  expect((await verifyCriteria(repo)).exitCode).toBe(3);
});

// ---------------------------------------------------------------------------
// pr.mjs rendering and repo context

async function prRender(dir: string, args: string[] = [], cwd?: string): Promise<ExecResult> {
  return execArgv(['node', PR, dir, '--title', 'test task', ...args], { cwd: cwd ?? dir, timeoutMs: 30_000 });
}

test('pr.mjs: pending manual is byte-identical legacy; satisfied ✅ ADJUDICATED; accepted 👤 with unproven residual; stale → needs-a-human-check; adjudications section carries basis', async () => {
  const repo = await makeFixtureRepo();
  const sdir = S(repo);
  mkdirSync(sdir, { recursive: true });
  await writeFile(join(sdir, 'plan.md'), '# plan\n\np\n');
  await writeFile(join(sdir, 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(sdir, 'approval.json'), APPROVAL_BYTES);
  mkdirSync(join(sdir, 'evidence'), { recursive: true });
  await writeFile(
    join(sdir, 'evidence', 'criteria-matrix.json'),
    JSON.stringify({ C1: { status: 'pass', evidencePath: 'x' }, C7: { status: 'manual', evidencePath: 'y' } }),
  );

  // no adjudication state at all → the legacy line, byte-identical
  const pending = await prRender(sdir, ['--repo', repo]);
  expect(pending.exitCode).toBe(0);
  expect(pending.stdout).toContain('- 👤 a human eyeballs the output once — **needs a human check before merge**');
  expect(pending.stdout).not.toContain('## Adjudications');

  // governing satisfied → ✅ ADJUDICATED line + section. The cited basis entry
  // must exist in ledger history — read-time provenance is enforced.
  const head = await headOf(repo);
  const citedEntry = { kind: 'diff', round: 4, fingerprint: 'a1b2c3d4'.padEnd(64, '0'), action: 'rejected', detail: 'the operator ruling, verbatim' };
  const rec = makeRecord({
    headSha: head,
    basis: { kind: 'diff', round: 4, fingerprint: 'a1b2c3d4'.padEnd(64, '0'), action: 'rejected' },
    basisEntry: citedEntry,
  });
  await appendFile(join(sdir, 'ledger.jsonl'), `${JSON.stringify(citedEntry)}\n`);
  await seedAdjState(sdir, [rec]);
  const satisfied = await prRender(sdir, ['--repo', repo]);
  expect(satisfied.stdout).toContain('- ✅ a human eyeballs the output once — **ADJUDICATED satisfied** by operator');
  expect(satisfied.stdout).toContain('## Adjudications — recorded human decisions on manual criteria');
  expect(satisfied.stdout).toContain('- **C7 — satisfied** by operator at 2026-08-24T00:00:00.000Z: checked it by hand, output is right');
  expect(satisfied.stdout).toContain('basis: diff round 4 — rejected a1b2c3d4');

  // governing accepted → 👤 ADJUDICATED with the unproven residual, published
  const accepted = makeRecord({ decision: 'accepted', residual: 'large-file rendering untested', ruling: 'synthetic rendering gap accepted', headSha: 'f'.repeat(40), at: '2026-08-24T02:00:00.000Z' });
  await rm(join(sdir, 'adjudications.json'));
  await rm(join(sdir, 'ledger.jsonl'));
  await seedAdjState(sdir, [accepted]);
  const acc = await prRender(sdir, ['--repo', repo]);
  expect(acc.stdout).toContain('- 👤 a human eyeballs the output once — **ADJUDICATED accepted** by operator — unproven: large-file rendering untested');
  expect(acc.stdout).toContain('unproven residual: large-file rendering untested');

  // stale satisfied (bound to another HEAD) → back to the needs-a-human-check line
  const staleRec = makeRecord({ headSha: '1'.repeat(40) });
  await rm(join(sdir, 'adjudications.json'));
  await rm(join(sdir, 'ledger.jsonl'));
  await seedAdjState(sdir, [staleRec]);
  const stale = await prRender(sdir, ['--repo', repo]);
  expect(stale.stdout).toContain('- 👤 a human eyeballs the output once — **needs a human check before merge**');

  // malformed adjudication state → exit 3
  await writeFile(join(sdir, 'adjudications.json'), '{ torn');
  expect((await prRender(sdir, ['--repo', repo])).exitCode).toBe(3);
});

test('repo context: explicit --repo must be the .ben state dir\'s own repo; without --repo the .ben parent rule applies; satisfied state without any repo context fails closed', async () => {
  const repo = await makeFixtureRepo();
  const decoy = await makeFixtureRepo();
  const sdir = S(repo);
  mkdirSync(sdir, { recursive: true });
  await writeFile(join(sdir, 'plan.md'), 'p\n');
  await writeFile(join(sdir, 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(sdir, 'approval.json'), APPROVAL_BYTES);
  await seedAdjState(sdir, [makeRecord({ headSha: await headOf(repo) })]);

  // foreign --repo for a .ben state dir → exit 3
  const foreign = await prRender(sdir, ['--repo', decoy]);
  expect(foreign.exitCode).toBe(3);
  expect(foreign.stderr).toContain('one state dir, one repo');
  // matching --repo → OK; no --repo (parent rule) → OK, even from a decoy cwd (cwd never consulted)
  expect((await prRender(sdir, ['--repo', repo])).exitCode).toBe(0);
  expect((await prRender(sdir, [], decoy)).exitCode).toBe(0);

  // a non-.ben layout with satisfied adjudication state and no --repo cannot derive HEAD → fail closed
  const flat = await makeTmpDir('adj-flat-');
  await writeFile(join(flat, 'plan.md'), 'p\n');
  await writeFile(join(flat, 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(flat, 'approval.json'), APPROVAL_BYTES);
  await seedAdjState(flat, [makeRecord({ headSha: 'a'.repeat(40) })]);
  const noRepo = await prRender(flat);
  expect(noRepo.exitCode).toBe(3);
  expect(noRepo.stderr).toContain('repo context');
  // non-.ben keeps explicit --repo
  expect((await prRender(flat, ['--repo', repo])).exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// pregate rejects duplicate criterion ids

// ---------------------------------------------------------------------------
// audit rows interleaved with review history leave every reader unchanged

test('adjudication/publication rows interleaved around raised/rejected/granted — re-raise suppression, round counting, status warnings and pr.mjs stale-stamping all behave', async () => {
  const LEDGER = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));
  const RUN = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
  const repo = await makeFixtureRepo();
  const sdir = join(repo, '.ben');
  mkdirSync(join(sdir, 'reviews'), { recursive: true });
  await writeFile(join(sdir, 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(sdir, 'approval.json'), APPROVAL_BYTES);
  await writeFile(join(sdir, 'rounds.json'), JSON.stringify({ plan: 0 }));
  const exec = (argv: string[]) => execArgv(argv, { cwd: repo, timeoutMs: 30_000 });

  const blocker = { id: 'B1', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' };
  const major = { id: 'B2', severity: 'MAJOR', claim: 'stale plan note from round one' };
  await writeFile(join(sdir, 'reviews', 'plan-round-1-codex.json'), JSON.stringify({ verdict: 'NO_GO', blockers: [blocker, major] }));
  expect((await exec(['node', LEDGER, 'round', sdir, '--kind', 'plan', '--verdict', 'codex=reviews/plan-round-1-codex.json'])).exitCode).toBe(1);

  // interleave: a (valid, hand-restored) adjudication audit row lands between
  // the raised row and its resolution — the register carries its record too
  const adjRecord = makeRecord();
  await appendFile(join(sdir, 'ledger.jsonl'), `${JSON.stringify(auditRow(adjRecord))}\n`);
  await writeFile(join(sdir, 'adjudications.json'), `${JSON.stringify([adjRecord], null, 2)}\n`);

  const blockers = JSON.parse(await readFile(join(sdir, 'blockers.json'), 'utf8'));
  await writeFile(join(sdir, 'resolutions.json'), JSON.stringify([{ fingerprint: blockers[0].fingerprint, action: 'rejected', detail: 'already proven elsewhere' }]));
  expect((await exec(['node', LEDGER, 'resolve', sdir, '--kind', 'plan'])).exitCode).toBe(0);

  // interleave: a publication audit row and a grant
  const pubRow = {
    ts: '2026-08-24T00:00:05.000Z',
    kind: 'publication',
    round: 0,
    reviewer: 'operator',
    blockerId: '',
    fingerprint: 'b'.repeat(64),
    action: 'attested',
    detail: '',
    publication: { url: 'https://x.test/pr/1', headRefOid: 'a'.repeat(40), bodySha: 'b'.repeat(64), remoteUpdatedAt: 't1', observedAt: '2026-08-24T00:00:05.000Z', by: 'operator' },
  };
  pubRow.detail = publicationDetail(pubRow.publication);
  await appendFile(join(sdir, 'ledger.jsonl'), `${JSON.stringify(pubRow)}\n`);
  expect((await exec(['node', LEDGER, 'grant', sdir, '--kind', 'plan', '--rounds', '1', '--by', 'operator'])).exitCode).toBe(0);

  // a byte-identical re-raise of the rejected finding is still mechanically dropped (rejectedFingerprints unchanged)
  await writeFile(join(sdir, 'reviews', 'plan-round-2-codex.json'), JSON.stringify({ verdict: 'NO_GO', blockers: [blocker] }));
  const round2 = await exec(['node', LEDGER, 'round', sdir, '--kind', 'plan', '--verdict', 'codex=reviews/plan-round-2-codex.json']);
  expect(round2.exitCode).toBe(0); // the only blocker dropped → unanimous GO
  const ledgerText = await readFile(join(sdir, 'ledger.jsonl'), 'utf8');
  expect(ledgerText).toContain('re-raise-dropped');
  // round counting untouched by round-0 audit rows: the tally consumed exactly one blocker-bearing round
  expect(JSON.parse(await readFile(join(sdir, 'rounds.json'), 'utf8')).plan).toBe(1);

  // legacyWarnings: round-0 audit rows are never orphaned history; status renders clean
  const status = await exec(['node', RUN, 'status', '--repo', repo]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).not.toContain('orphaned history');
  expect(status.stdout).toContain('manual C7: PENDING adjudication'); // the satisfied record is stale at this repo's HEAD

  // pr.mjs revision inference: only `resolved` plan|diff rows move the stale marker — audit rows never do
  await appendFile(
    join(sdir, 'ledger.jsonl'),
    `${JSON.stringify({ ts: 't', kind: 'plan', round: 2, reviewer: 'codex', blockerId: 'B9', fingerprint: 'f9', action: 'resolved', detail: 'revised' })}\n`,
  );
  const pr = await execArgv(['node', PR, sdir, '--repo', repo, '--title', 't'], { cwd: repo, timeoutMs: 30_000 });
  expect(pr.exitCode).toBe(0);
  expect(pr.stdout).toContain('stale plan note from round one _(recorded round 1 — artifact revised since)_');
});

test('pregate rejects duplicate criterion ids by name', async () => {
  const dir = await makeTmpDir('adj-pregate-');
  await writeFile(
    join(dir, 'criteria.json'),
    JSON.stringify({
      taskId: 'T1',
      criteria: [
        { id: 'C1', statement: 'a', verification: { method: 'command', command: 'true' } },
        { id: 'C1', statement: 'b', verification: { method: 'command', command: 'true' } },
      ],
    }),
  );
  await writeFile(join(dir, 'promises.json'), '[]');
  await writeFile(join(dir, 'plan-files.json'), JSON.stringify(['x.ts']));
  await writeFile(join(dir, 'gates.json'), JSON.stringify({ t: 'true' }));
  const r = await execArgv(['node', PREGATE, dir], { cwd: dir, timeoutMs: 30_000 });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('duplicate id "C1"');
});

// ---------------------------------------------------------------------------
// corrections

test('publication-only history is validated by the renderer — a malformed publication row fails closed with NO adjudication state present', async () => {
  const repo = await makeFixtureRepo();
  const sdir = S(repo);
  mkdirSync(join(sdir, 'evidence'), { recursive: true });
  await writeFile(join(sdir, 'plan.md'), 'p\n');
  await writeFile(join(sdir, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [structuredClone(CMD_CRITERION)] }, null, 2));
  await writeFile(join(sdir, 'evidence', 'criteria-matrix.json'), JSON.stringify({ C1: { status: 'pass', evidencePath: 'x' } }));
  const pub = {
    ts: '2026-08-24T00:00:05.000Z',
    kind: 'publication',
    round: 0,
    reviewer: 'operator',
    blockerId: '',
    fingerprint: 'b'.repeat(64),
    action: 'attested',
    detail: '',
    publication: { url: 'https://x.test/pr/1', headRefOid: 'a'.repeat(40), bodySha: 'b'.repeat(64), remoteUpdatedAt: 't1', observedAt: '2026-08-24T00:00:05.000Z', by: 'operator' },
  };
  pub.detail = publicationDetail(pub.publication);
  // a valid publication-only row renders
  await writeFile(join(sdir, 'ledger.jsonl'), `${JSON.stringify(pub)}\n`);
  expect((await prRender(sdir, ['--repo', repo])).exitCode).toBe(0);
  // corrupt ONLY the wrapper (fingerprint no longer equals bodySha) — still no
  // adjudication state anywhere, and the renderer must fail closed regardless
  await writeFile(join(sdir, 'ledger.jsonl'), `${JSON.stringify({ ...pub, fingerprint: 'c'.repeat(64) })}\n`);
  const bad = await prRender(sdir, ['--repo', repo]);
  expect(bad.exitCode).toBe(3);
  expect(bad.stderr).toContain('audit-record schema');

  // invalid framing never disappears into a rendered subset: a torn
  // line, a blank line, CRLF, and a valid final record missing its LF all
  // fail closed — even with the only history being publication rows
  const row = JSON.stringify(pub);
  const illegalFramings: Array<[string, string]> = [
    [`${row}\n{ torn publication row\n`, 'malformed line'],
    [`${row}\n\n`, 'blank line'],
    [`${row}\r\n`, 'CR byte'],
    [row, 'unterminated record'],
  ];
  for (const [framing, expected] of illegalFramings) {
    await writeFile(join(sdir, 'ledger.jsonl'), framing);
    const r = await prRender(sdir, ['--repo', repo]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain(expected);
  }

  // invalid UTF-8 bytes are never replacement-normalized into legal history —
  // the fatal decoder refuses them before any parse or render
  await writeFile(join(sdir, 'ledger.jsonl'), Buffer.concat([Buffer.from(`${row.slice(0, -2)}`), Buffer.from([0xff]), Buffer.from('"}\n')]));
  const invalidUtf8 = await prRender(sdir, ['--repo', repo]);
  expect(invalidUtf8.exitCode).toBe(3);
  expect(invalidUtf8.stderr).toContain('invalid UTF-8');

  // a UTF-8 BOM before an otherwise-valid row is an illegal byte prefix —
  // refused, never silently stripped into legal history
  await writeFile(join(sdir, 'ledger.jsonl'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${row}\n`)]));
  const bom = await prRender(sdir, ['--repo', repo]);
  expect(bom.exitCode).toBe(3);
  expect(bom.stderr).toContain('UTF-8 BOM');
});

test('approvalRelevantLedgerSha refuses invalid UTF-8 bytes and BOM prefixes — never a misleading valid/ABSENT digest', async () => {
  const dir = await makeTmpDir('adj-utf8-');
  const row = JSON.stringify({ ts: 't', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: 'a'.repeat(64), action: 'resolved', detail: 'x' });
  await writeFile(join(dir, 'ledger.jsonl'), Buffer.concat([Buffer.from(row.slice(0, -2)), Buffer.from([0xff]), Buffer.from('"}\n')]));
  expect(() => approvalRelevantLedgerSha(join(dir, 'ledger.jsonl'))).toThrow(/invalid UTF-8/);
  // BOM-prefixed valid PUBLICATION row: previously stripped AND skipped from
  // the digest (returning ABSENT) — now it throws, never a plausible result
  const pub = {
    ts: '2026-08-24T00:00:05.000Z',
    kind: 'publication',
    round: 0,
    reviewer: 'operator',
    blockerId: '',
    fingerprint: 'b'.repeat(64),
    action: 'attested',
    detail: '',
    publication: { url: 'https://x.test/pr/1', headRefOid: 'a'.repeat(40), bodySha: 'b'.repeat(64), remoteUpdatedAt: 't1', observedAt: '2026-08-24T00:00:05.000Z', by: 'operator' },
  };
  pub.detail = publicationDetail(pub.publication);
  await writeFile(join(dir, 'ledger.jsonl'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${JSON.stringify(pub)}\n`)]));
  expect(() => approvalRelevantLedgerSha(join(dir, 'ledger.jsonl'))).toThrow(/UTF-8 BOM/);
});

test('an orphan .ben state dir fails closed in verify and reviewer — .ben itself is never the repository; flat fixtures stay accepted', async () => {
  const REVIEWER = fileURLToPath(new URL('../scripts/reviewer.mjs', import.meta.url));
  const base = await makeTmpDir('adj-orphan-');
  const orphan = join(base, '.ben');
  mkdirSync(orphan, { recursive: true });
  await writeFile(join(orphan, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [structuredClone(CMD_CRITERION)] }, null, 2));
  await writeFile(join(orphan, 'approval.json'), APPROVAL_BYTES);
  await writeFile(join(orphan, 'plan.md'), 'p\n');
  await writeFile(join(orphan, 'promises.json'), '[]');
  await writeFile(join(orphan, 'plan-files.json'), JSON.stringify(['x.ts']));
  await writeFile(join(orphan, 'gates.json'), JSON.stringify({ t: 'true' }));
  await writeFile(join(orphan, 'task.json'), JSON.stringify({ sequencerVersion: 1, base: 'main', repo: { rootCommit: 'r' }, config: {} }, null, 2));

  const v = await execArgv(['node', VERIFY, 'criteria', orphan], { cwd: base, timeoutMs: 30_000 });
  expect(v.exitCode).toBe(3);
  expect(v.stderr).toContain('refusing to treat .ben itself as the repo');
  const rev = await execArgv(['node', REVIEWER, 'plan', orphan, '--round', '1', '--cli', '/nonexistent-cli'], { cwd: base, timeoutMs: 30_000 });
  expect(rev.exitCode).toBe(3);
  expect(rev.stderr).toContain('refusing to treat .ben itself as the repo');

  // a genuine flat fixture layout (not named .ben) remains accepted
  const flat = await makeTmpDir('adj-flatok-');
  await writeFile(join(flat, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [structuredClone(CMD_CRITERION)] }, null, 2));
  await writeFile(join(flat, 'approval.json'), APPROVAL_BYTES);
  expect((await execArgv(['node', VERIFY, 'criteria', flat], { cwd: flat, timeoutMs: 30_000 })).exitCode).toBe(0);
  // a valid .ben under a real repo remains accepted (the everyday layout)
  const repo = await makeFixtureRepo();
  mkdirSync(S(repo), { recursive: true });
  await writeFile(join(S(repo), 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [structuredClone(CMD_CRITERION)] }, null, 2));
  await writeFile(join(S(repo), 'approval.json'), APPROVAL_BYTES);
  expect((await execArgv(['node', VERIFY, 'criteria', S(repo)], { cwd: repo, timeoutMs: 30_000 })).exitCode).toBe(0);
});

test('the criterion method — never a corrupted matrix status — decides manual rendering; an accepted act can never demote to a plain PASS', async () => {
  const repo = await makeFixtureRepo();
  const sdir = S(repo);
  mkdirSync(join(sdir, 'evidence'), { recursive: true });
  await writeFile(join(sdir, 'plan.md'), 'p\n');
  await writeFile(join(sdir, 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(sdir, 'approval.json'), APPROVAL_BYTES);
  // hand-corrupted matrix: the manual criterion claims an ordinary automated 'pass'
  await writeFile(join(sdir, 'evidence', 'criteria-matrix.json'), JSON.stringify({ C1: { status: 'pass', evidencePath: 'x' }, C7: { status: 'pass', evidencePath: 'y' } }));
  const accepted = makeRecord({ decision: 'accepted', residual: 'large-file rendering untested', ruling: 'gap accepted', headSha: 'f'.repeat(40) });
  await seedAdjState(sdir, [accepted]);
  const r = await prRender(sdir, ['--repo', repo]);
  expect(r.exitCode).toBe(0);
  const c7Lines = r.stdout.split('\n').filter((l) => l.includes('a human eyeballs the output once'));
  expect(c7Lines).toHaveLength(1);
  expect(c7Lines[0]).toContain('👤');
  expect(c7Lines[0]).toContain('**ADJUDICATED accepted** by operator — unproven: large-file rendering untested');
  // adjacent case: the matrix entry for the manual criterion is missing/corrupt
  // with no governing act — still the manual path, never a plain ✅/❌ line
  await rm(join(sdir, 'adjudications.json'));
  await rm(join(sdir, 'ledger.jsonl'));
  await writeFile(join(sdir, 'evidence', 'criteria-matrix.json'), JSON.stringify({ C1: { status: 'pass', evidencePath: 'x' } }));
  const missing = await prRender(sdir, ['--repo', repo]);
  expect(missing.exitCode).toBe(0);
  const c7Missing = missing.stdout.split('\n').filter((l) => l.includes('a human eyeballs the output once'));
  expect(c7Missing).toHaveLength(1);
  expect(c7Missing[0]).toContain('👤');
  expect(c7Missing[0]).toContain('**needs a human check before merge**');
});

test('verify.mjs criteria derives adjudication integrity with ZERO manual criteria — corrupt state is exit 3, never skipped', async () => {
  const repo = await makeFixtureRepo();
  mkdirSync(S(repo), { recursive: true });
  await writeFile(join(S(repo), 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [structuredClone(CMD_CRITERION)] }, null, 2));
  await writeFile(join(S(repo), 'approval.json'), APPROVAL_BYTES);
  expect((await verifyCriteria(repo)).exitCode).toBe(0); // clean state, no manual criteria
  // register-only record (absent from the ledger) → divergence → exit 3 even
  // though the current criterion set contains no manual criterion
  await writeFile(join(S(repo), 'adjudications.json'), JSON.stringify([makeRecord()], null, 2));
  const r = await verifyCriteria(repo);
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('adjudication state invalid');
});

test('status derives adjudication integrity unconditionally — INVALID dominates the overall status and demotes the terminal fact', async () => {
  const repo = await makeFixtureRepo();
  const RUN = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
  mkdirSync(S(repo), { recursive: true });
  await writeFile(join(S(repo), 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [structuredClone(CMD_CRITERION)] }, null, 2));
  await writeFile(join(S(repo), 'approval.json'), APPROVAL_BYTES);
  await writeFile(
    join(S(repo), 'task.json'),
    JSON.stringify({ sequencerVersion: 1, base: 'main', repo: { rootCommit: 'r' }, config: {}, pr: { url: 'https://x.test/pr/1', headSha: 'a'.repeat(40) } }, null, 2),
  );
  // corrupt adjudication state (register-only divergence) beside a terminal task.pr
  await writeFile(join(S(repo), 'adjudications.json'), JSON.stringify([makeRecord()], null, 2));
  const r = await execArgv(['node', RUN, 'status', '--repo', repo], { cwd: repo, timeoutMs: 30_000 });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('OVERALL: INVALID');
  expect(r.stdout).toContain('adjudications: INVALID');
  expect(r.stdout).toContain('NOT presentable as terminal');
  expect(r.stdout).not.toContain('— terminal'); // never an equally green terminal fact beside INVALID
});

// ---------------------------------------------------------------------------
// correction: reviewer authority derives criterion
// representation from the criterion METHOD + validated adjudication state

test('a corrupted manual matrix status can never reach the reviewer as an automated PASS; accepted residual stays visible; pending stays manual', async () => {
  const REVIEWER = fileURLToPath(new URL('../scripts/reviewer.mjs', import.meta.url));
  const repo = await makeFixtureRepo();
  const sdir = S(repo);
  mkdirSync(join(sdir, 'evidence'), { recursive: true });
  await writeFile(join(sdir, 'plan.md'), '# plan\n\np\n');
  await writeFile(join(sdir, 'plan-files.json'), JSON.stringify(['math.ts']));
  await writeFile(join(sdir, 'task.json'), JSON.stringify({ sequencerVersion: 1, base: 'main', repo: { rootCommit: 'r' }, config: {} }, null, 2));
  await writeFile(join(sdir, 'criteria.json'), JSON.stringify(criteriaDoc(), null, 2));
  await writeFile(join(sdir, 'approval.json'), APPROVAL_BYTES);
  await writeFile(join(sdir, 'evidence', 'c1.txt'), 'command evidence\n');
  // hand-corrupted matrix: the manual criterion claims an automated 'pass'
  await writeFile(
    join(sdir, 'evidence', 'criteria-matrix.json'),
    JSON.stringify({ C1: { status: 'pass', evidencePath: join(sdir, 'evidence', 'c1.txt') }, C7: { status: 'pass', evidencePath: join(sdir, 'evidence', 'c1.txt') } }),
  );
  const accepted = makeRecord({ decision: 'accepted', residual: 'large-file rendering untested', ruling: 'gap accepted', headSha: 'f'.repeat(40) });
  await seedAdjState(sdir, [accepted]);

  const stubDir = await makeTmpDir('adj-rev-stub-');
  await writeFile(
    join(stubDir, 'stub.mjs'),
    `import { writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(stubDir, 'prompts.log'))}, args[args.length - 1] + '\\n===PROMPT-END===\\n');
writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ verdict: 'GO', blockers: [] }));
`,
  );
  const cli = join(stubDir, 'stub-cli');
  await writeFile(cli, `#!/bin/sh\nexec node "${join(stubDir, 'stub.mjs')}" "$@"\n`);
  const { chmodSync } = await import('node:fs');
  chmodSync(cli, 0o755);
  const head = await headOf(repo);
  const invoke = () => execArgv(['node', REVIEWER, 'diff', sdir, '--round', '1', '--base', head, '--repo', repo, '--cli', cli], { cwd: repo, timeoutMs: 30_000 });

  // a FOREIGN --repo is refused before any governing selection,
  // prompt, or verdict work — one state dir, one repo
  const decoy = await makeFixtureRepo();
  const foreign = await execArgv(['node', REVIEWER, 'diff', sdir, '--round', '1', '--base', head, '--repo', decoy, '--cli', cli], { cwd: repo, timeoutMs: 30_000 });
  expect(foreign.exitCode).toBe(3);
  expect(foreign.stderr).toContain('one state dir, one repo');
  const { existsSync: fsExists } = await import('node:fs');
  expect(fsExists(join(sdir, 'reviews'))).toBe(false); // no verdict was minted

  // accepted adjudication: represented as adjudicated with the residual visible — never (pass)
  expect((await invoke()).exitCode).toBe(0);
  let prompts = await readFile(join(stubDir, 'prompts.log'), 'utf8');
  expect(prompts).toContain('### criterion C7 (adjudicated)');
  expect(prompts).toContain('large-file rendering untested');
  expect(prompts).not.toContain('### criterion C7 (pass)');
  expect(prompts).toContain('### criterion C1 (pass)');
  expect(prompts).toContain('"C7"');
  expect(prompts).not.toMatch(/"C7": \{\s*"status": "pass"/);

  // no adjudication state at all: the corrupt 'pass' still cannot classify the
  // manual criterion — it stays manual
  await rm(join(sdir, 'adjudications.json'));
  await rm(join(sdir, 'ledger.jsonl'));
  await rm(join(stubDir, 'prompts.log'));
  expect((await invoke()).exitCode).toBe(0);
  prompts = await readFile(join(stubDir, 'prompts.log'), 'utf8');
  expect(prompts).toContain('### criterion C7 (manual)');
  expect(prompts).not.toContain('### criterion C7 (pass)');
});
