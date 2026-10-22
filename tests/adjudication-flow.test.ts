import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { commitChange, git, makeFixtureRepo, makeTmpDir, PAUSE_BOUNDARY_POLL_MS, PAUSE_BOUNDARY_WAIT_MS } from './helpers';
import { canonicalBody, EMPTY_SHA256, ledgerAdjudicationRecords, sha256 } from '../scripts/adjudication.lib.mjs';

// run.mjs flow matrix: the
// record-adjudication lifecycle and crash seams, approval-act identity and
// the approval-relevant digest, sequencing, conformance
// and terminal publication. The watermark/migration battery lives in
// adjudication-watermark.test.ts.

const RUN = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
const PRSCRIPT = fileURLToPath(new URL('../scripts/pr.mjs', import.meta.url));

async function makeRepo(): Promise<string> {
  const repo = await makeFixtureRepo();
  await writeFile(join(repo, '.gitignore'), '.ben/\n');
  await git(repo, 'add', '.gitignore');
  await git(repo, 'commit', '-m', 'chore: ignore .ben');
  return repo;
}

function run(repo: string, args: string[], env: Record<string, string> = {}): Promise<ExecResult> {
  return execArgv(['node', RUN, ...args, '--repo', repo], { cwd: repo, timeoutMs: 60_000, env });
}

const S = (repo: string) => join(repo, '.ben');
const readTask = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'task.json'), 'utf8'));
const readLedgerLines = async (repo: string) =>
  existsSync(join(S(repo), 'ledger.jsonl')) ? (await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean) : [];
const readRegister = async (repo: string) =>
  existsSync(join(S(repo), 'adjudications.json')) ? JSON.parse(await readFile(join(S(repo), 'adjudications.json'), 'utf8')) : [];
const headOf = async (repo: string) => (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();

/** Stub reviewer that also captures every prompt it was handed. */
async function makeStubReviewer(repo: string): Promise<{ cli: string; respond: (v: unknown) => Promise<void>; calls: () => Promise<number>; prompts: () => Promise<string> }> {
  const dir = await makeTmpDir('adjflow-stub-');
  const stubJs = join(dir, 'stub.mjs');
  await writeFile(
    stubJs,
    `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, 'call\\n');
appendFileSync(${JSON.stringify(join(dir, 'prompts.log'))}, args[args.length - 1] + '\\n===PROMPT-END===\\n');
const out = args[args.indexOf('-o') + 1];
writeFileSync(out, readFileSync(${JSON.stringify(join(dir, 'response.txt'))}, 'utf8'));
`,
  );
  const cli = join(dir, 'stub-cli');
  await writeFile(cli, `#!/bin/sh\nexec node "${stubJs}" "$@"\n`);
  chmodSync(cli, 0o755);
  return {
    cli,
    respond: (v) => writeFile(join(dir, 'response.txt'), typeof v === 'string' ? v : JSON.stringify(v)),
    calls: async () => (existsSync(join(dir, 'calls.log')) ? (await readFile(join(dir, 'calls.log'), 'utf8')).split('\n').filter(Boolean).length : 0),
    prompts: async () => (existsSync(join(dir, 'prompts.log')) ? await readFile(join(dir, 'prompts.log'), 'utf8') : ''),
  };
}

const GO = { verdict: 'GO', blockers: [] };

/** Admissible plan artifacts with ONE manual criterion (C7) among four. */
async function seedPlanManual(repo: string, opts: { extraManual?: boolean } = {}): Promise<void> {
  const s = S(repo);
  mkdirSync(s, { recursive: true });
  await writeFile(join(s, 'plan.md'), '# plan\n\nbuild the thing\n');
  const criteria = [
    { id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } },
    { id: 'C2', statement: 'more of the thing works', verification: { method: 'command', command: 'true' } },
    { id: 'C3', statement: 'the rest of the thing works', verification: { method: 'command', command: 'true' } },
    { id: 'C4', statement: 'the thing still works', verification: { method: 'command', command: 'true' } },
    { id: 'C7', statement: 'a human eyeballs the output once', verification: { method: 'manual' } },
    ...(opts.extraManual
      ? [
          { id: 'C5', statement: 'the thing keeps working', verification: { method: 'command', command: 'true' } },
          { id: 'C6', statement: 'the thing definitely works', verification: { method: 'command', command: 'true' } },
          { id: 'C8', statement: 'a human eyeballs the logs once', verification: { method: 'manual' } },
        ]
      : []),
  ];
  await writeFile(join(s, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria }, null, 2));
  await writeFile(join(s, 'promises.json'), '[]');
  await writeFile(join(s, 'plan-files.json'), JSON.stringify(['math.ts']));
  await writeFile(join(s, 'gates.json'), JSON.stringify({ smoke: 'true' }, null, 2));
}

async function approve(repo: string): Promise<void> {
  const r = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(r.exitCode).toBe(0);
}

/** init → plan GO → approve → commit → next lands at the manual gate. */
async function toManualGate(
  repo: string,
  stub: Awaited<ReturnType<typeof makeStubReviewer>>,
  opts: Parameters<typeof seedPlanManual>[1] = {},
): Promise<ExecResult> {
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlanManual(repo, opts);
  await stub.respond(GO);
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.stdout).toContain('APPROVE BUILD');
  await approve(repo);
  await commitChange(repo, 'feature');
  const manual = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(manual.exitCode).toBe(2);
  expect(manual.stdout).toContain('HUMAN GATE — manual criteria need a recorded adjudication');
  return manual;
}

const SAT = { decision: 'satisfied', ruling: 'checked the output by hand, it is right' };
const ACC = { decision: 'accepted', ruling: 'the synthetic rendering gap is accepted', residual: 'large-file rendering untested' };

/** Scratch dir OUTSIDE the repo — helper files must never dirty the worktree. */
function aux(repo: string): string {
  const dir = `${repo}-aux`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function adjudicate(repo: string, id: string, response: unknown, extra: string[] = []): Promise<ExecResult> {
  const file = join(aux(repo), `response-${id}.json`);
  await writeFile(file, JSON.stringify(response));
  return run(repo, ['record-adjudication', '--criterion', id, '--response', file, '--by', 'operator', '--confirm', ...extra]);
}

/** The operator's recorded remote observation; body defaults to pr-body.md. */
async function makeObservation(repo: string, url: string, head: string, body?: string): Promise<string> {
  const b = body ?? (await readFile(join(S(repo), 'pr-body.md'), 'utf8'));
  const path = join(aux(repo), 'remote-observation.json');
  await writeFile(path, JSON.stringify({ url, body: b, headRefOid: head, updatedAt: '2026-08-24T00:00:00Z' }));
  return path;
}

async function regenBody(repo: string, title = 'test task'): Promise<void> {
  const r = await execArgv(['node', PRSCRIPT, S(repo), '--repo', repo, '--title', title], { cwd: repo, timeoutMs: 30_000 });
  expect(r.exitCode).toBe(0);
}

/** Spawn run.mjs paused at a named boundary, SIGKILL it, clean the lock. */
async function killAt(repo: string, args: string[], boundary: string, env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(['node', RUN, ...args, '--repo', repo], {
    cwd: repo,
    env: { ...process.env, ...env, BEN_RUN_PAUSE_AT: boundary },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const marker = join(S(repo), `.paused-${boundary.replaceAll(':', '_')}`);
  let reached = false;
  for (let i = 0; i < PAUSE_BOUNDARY_WAIT_MS / PAUSE_BOUNDARY_POLL_MS; i++) {
    if (existsSync(marker)) {
      reached = true;
      break;
    }
    await Bun.sleep(PAUSE_BOUNDARY_POLL_MS);
  }
  // one final check: a marker landing during the last sleep is never falsely
  // reported as "never reached"
  if (!reached) reached = existsSync(marker);
  proc.kill(9);
  await proc.exited;
  if (!reached) throw new Error(`never reached pause boundary ${boundary}`);
  rmSync(marker, { force: true });
  rmSync(join(S(repo), '.run-lock'), { force: true });
}

// ---------------------------------------------------------------------------
// the gate, the dry run, the dual write, replay, conflict

test('the manual gate fires BEFORE any chain referee, byte-stable; dry run writes nothing; --confirm dual-writes; replay no-ops; conflict STOPs', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  const gateOut = await toManualGate(repo, stub);
  // BEFORE any chain referee: no evidence was produced, no scope/gates ran
  expect(existsSync(join(S(repo), 'evidence'))).toBe(false);
  expect(gateOut.stdout).toContain('a human eyeballs the output once');
  expect(gateOut.stdout).toContain('record-adjudication --criterion <id> --response <file> --by <you>');
  // byte-stable across derivations
  const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.stdout).toBe(gateOut.stdout);

  // dry run: identity + warning + no writes
  const respFile = join(aux(repo), 'resp.json');
  await writeFile(respFile, JSON.stringify(ACC));
  const dry = await run(repo, ['record-adjudication', '--criterion', 'C7', '--response', respFile, '--by', 'operator']);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain('DRY RUN — nothing written');
  expect(dry.stdout).toContain('a human eyeballs the output once');
  expect(dry.stdout).toContain('binding identity');
  expect(dry.stdout).toContain('record digest:');
  expect(dry.stdout).toContain('WARNING — accepted is a HEAD-independent policy acceptance');
  expect(existsSync(join(S(repo), 'adjudications.json'))).toBe(false);
  expect(await readLedgerLines(repo)).toHaveLength(0);

  // --confirm lands the state record AND the ledger audit entry with the embedded record
  const confirm = await adjudicate(repo, 'C7', ACC);
  expect(confirm.exitCode).toBe(0);
  const register = await readRegister(repo);
  expect(register).toHaveLength(1);
  expect(register[0].decision).toBe('accepted');
  expect(register[0].residual).toBe(ACC.residual);
  const rows = (await readLedgerLines(repo)).map((l) => JSON.parse(l));
  const audit = rows.filter((r) => r.kind === 'adjudication');
  expect(audit).toHaveLength(1);
  expect(audit[0].round).toBe(0);
  expect(audit[0].action).toBe('adjudicated');
  expect(audit[0].blockerId).toBe('C7');
  expect(audit[0].record).toEqual(register[0]); // the complete record, verbatim

  // replay → no-op, nothing appended
  const replay = await adjudicate(repo, 'C7', ACC);
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('no-op');
  expect(await readRegister(repo)).toHaveLength(1);
  expect((await readLedgerLines(repo)).filter((l) => l.includes('"adjudication"'))).toHaveLength(1);

  // conflict → STOP, nothing written
  const conflict = await adjudicate(repo, 'C7', { ...ACC, ruling: 'entirely different words' });
  expect(conflict.exitCode).toBe(2);
  expect(conflict.stdout).toContain('conflicting adjudication record');
  expect(await readRegister(repo)).toHaveLength(1);

  // the gate is now satisfied: next proceeds into the chain and the diff review; no pending-criterion loop
  await stub.respond(GO);
  const done = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(done.exitCode).toBe(0);
  expect(done.stdout).toContain('gh pr create');
  // the matrix carries `adjudicated` and the diff prompt carried the record as evidence
  const matrix = JSON.parse(await readFile(join(S(repo), 'evidence', 'criteria-matrix.json'), 'utf8'));
  expect(matrix.C7.status).toBe('adjudicated');
  expect(await stub.prompts()).toContain('the synthetic rendering gap is accepted'); // the ruling reached the diff reviewer
  expect((await readTask(repo)).reviewBase.adjudicationsSha).toHaveLength(64);
});

test('partial adjudication: with two manual criteria the gate lists only the pending one', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub, { extraManual: true });
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('=== C8 ===');
  expect(gate.stdout).not.toContain('=== C7 ===');
});

// ---------------------------------------------------------------------------
// structural refusals

test('unknown/non-manual/duplicate criterion, residual coupling, approval, dirty worktree, malformed responses — all exit 3, nothing written', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);

  expect((await adjudicate(repo, 'C99', SAT)).exitCode).toBe(3); // unknown id
  expect((await adjudicate(repo, 'C1', SAT)).exitCode).toBe(3); // non-manual
  expect((await adjudicate(repo, 'C7', { decision: 'accepted', ruling: 'r' })).exitCode).toBe(3); // accepted without residual
  expect((await adjudicate(repo, 'C7', { decision: 'satisfied', ruling: 'r', residual: 'x' })).exitCode).toBe(3); // satisfied with residual
  expect((await adjudicate(repo, 'C7', { decision: 'satisfied', ruling: 'r', sneaky: true })).exitCode).toBe(3); // unknown field
  expect((await adjudicate(repo, 'C7', { decision: 'deferred', ruling: 'later' })).exitCode).toBe(3); // deferred is not adjudicated
  const rawFile = join(aux(repo), 'raw.json');
  await writeFile(rawFile, '{ torn');
  expect((await run(repo, ['record-adjudication', '--criterion', 'C7', '--response', rawFile, '--by', 'operator', '--confirm'])).exitCode).toBe(3);

  // duplicate criterion id (hand-corrupted criteria) → refused by name before any approval question
  const doc = JSON.parse(await readFile(join(S(repo), 'criteria.json'), 'utf8'));
  const saved = JSON.stringify(doc, null, 2);
  doc.criteria.push(structuredClone(doc.criteria.find((c: { id: string }) => c.id === 'C7')));
  await writeFile(join(S(repo), 'criteria.json'), JSON.stringify(doc, null, 2));
  const dupe = await adjudicate(repo, 'C7', SAT);
  expect(dupe.exitCode).toBe(3);
  expect(dupe.stderr).toContain('duplicated');
  await writeFile(join(S(repo), 'criteria.json'), saved);

  // dirty worktree blocks satisfied (not accepted)
  await writeFile(join(repo, 'dirty.txt'), 'x\n');
  const dirty = await adjudicate(repo, 'C7', SAT);
  expect(dirty.exitCode).toBe(3);
  expect(dirty.stderr).toContain('clean worktree');
  rmSync(join(repo, 'dirty.txt'));

  // voided approval → exit 3
  await appendFile(join(S(repo), 'plan.md'), 'sneaky edit\n');
  const voided = await adjudicate(repo, 'C7', SAT);
  expect(voided.exitCode).toBe(3);
  expect(voided.stderr).toContain('no current matching approval');

  expect(await readRegister(repo)).toHaveLength(0); // nothing ever landed
  expect(await readLedgerLines(repo)).toHaveLength(0);

  // no task.json at all
  const bare = await makeRepo();
  const resp = join(aux(bare), 'r.json');
  await writeFile(resp, JSON.stringify(SAT));
  expect((await run(bare, ['record-adjudication', '--criterion', 'C7', '--response', resp, '--by', 'operator', '--confirm'])).exitCode).toBe(3);
});

// ---------------------------------------------------------------------------
// crash seams both sides; half-applied dual write STOPs

test('SIGKILL before the referee re-invokes cleanly; SIGKILL after the referee no-ops; half-applied dual write STOPs; the next derivation is identical', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  const respFile = join(aux(repo), 'resp.json');
  await writeFile(respFile, JSON.stringify(ACC));

  // killed after the intent write, before ledger.mjs adjudicate ran
  await killAt(repo, ['record-adjudication', '--criterion', 'C7', '--response', respFile, '--by', 'operator', '--confirm'], 'after-adjudication-intent');
  expect(await readRegister(repo)).toHaveLength(0);
  expect((await readTask(repo)).adjudicationIntents).toHaveLength(1);
  const resume = await adjudicate(repo, 'C7', ACC);
  expect(resume.exitCode).toBe(0);
  expect(await readRegister(repo)).toHaveLength(1);
  expect((await readLedgerLines(repo)).filter((l) => l.includes('"adjudicated"'))).toHaveLength(1);
  expect((await readTask(repo)).adjudicationIntents[0].consumed).toBe(true);

  // killed after the referee, before the consumed mark — replay marks consumed, appends nothing
  const repo2 = await makeRepo();
  const stub2 = await makeStubReviewer(repo2);
  await toManualGate(repo2, stub2);
  const respFile2 = join(aux(repo2), 'resp.json');
  await writeFile(respFile2, JSON.stringify(ACC));
  await killAt(repo2, ['record-adjudication', '--criterion', 'C7', '--response', respFile2, '--by', 'operator', '--confirm'], 'after-adjudicate-referee');
  expect(await readRegister(repo2)).toHaveLength(1); // both landed
  expect((await readTask(repo2)).adjudicationIntents[0].consumed).toBe(false);
  const replay = await adjudicate(repo2, 'C7', ACC);
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('no-op');
  expect(await readRegister(repo2)).toHaveLength(1);
  expect((await readLedgerLines(repo2)).filter((l) => l.includes('"adjudicated"'))).toHaveLength(1);
  // the both-landed recovery reaches the exact contracted consumed state
  expect((await readTask(repo2)).adjudicationIntents[0].consumed).toBe(true);

  // SIGKILL between record and next changes nothing — the derivation is
  // identical, and the full mini-loop closes with observation + record-pr
  await stub2.respond(GO);
  const n1 = await run(repo2, ['next'], { BEN_REVIEWER_CLI: stub2.cli });
  expect(n1.stdout).toContain('gh pr create');
  const head46 = (await readTask(repo2)).prIntent.headSha;
  const obs46 = await makeObservation(repo2, 'https://x.test/pr/46', head46);
  expect((await run(repo2, ['record-pr', '--url', 'https://x.test/pr/46', '--remote-observation', obs46])).exitCode).toBe(0);
  const done46 = await run(repo2, ['next'], { BEN_REVIEWER_CLI: stub2.cli });
  expect(done46.exitCode).toBe(0);
  expect(done46.stdout).toContain('done — PR https://x.test/pr/46');

  // half-applied dual write (register landed, ledger row missing) → STOP for the playbook
  const repo3 = await makeRepo();
  const stub3 = await makeStubReviewer(repo3);
  await toManualGate(repo3, stub3);
  expect((await adjudicate(repo3, 'C7', ACC)).exitCode).toBe(0);
  const lines = await readLedgerLines(repo3);
  await writeFile(join(S(repo3), 'ledger.jsonl'), lines.filter((l) => !l.includes('"adjudicated"')).map((l) => `${l}\n`).join(''));
  const half = await run(repo3, ['next'], { BEN_REVIEWER_CLI: stub3.cli });
  expect(half.exitCode).toBe(2);
  expect(half.stdout).toContain('absent from ledger history');
}, 60_000); // kill-seam waits: the default 5 s budget is marginal under full-suite load

// ---------------------------------------------------------------------------
// command level: accepted replay across HEADs; `by` and basis mutations

test('an accepted replay at a NEW HEAD is a no-op (one act); a `by` mutation conflicts; every basis-field mutation is refused', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  // ground a real ledger entry to cite
  const cited = { ts: '2026-08-20T10:00:00.000Z', kind: 'diff', round: 2, reviewer: 'codex', blockerId: 'B1', fingerprint: 'c'.repeat(64), action: 'rejected', detail: 'ruling' };
  await appendFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(cited)}\n`);
  const basis = { kind: 'diff', round: 2, fingerprint: 'c'.repeat(64), action: 'rejected' };
  expect((await adjudicate(repo, 'C7', { ...ACC, basis })).exitCode).toBe(0);

  // HEAD moves; the identical accepted act replays as a no-op — one act, one record
  await commitChange(repo, 'moves-head');
  const replay = await adjudicate(repo, 'C7', { ...ACC, basis });
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('no-op');
  expect(await readRegister(repo)).toHaveLength(1);

  // a different actor submitting the same content is a CONFLICT (content includes `by`)
  const byFile = join(aux(repo), 'by-mutation.json');
  await writeFile(byFile, JSON.stringify({ ...ACC, basis }));
  const byMutation = await run(repo, ['record-adjudication', '--criterion', 'C7', '--response', byFile, '--by', 'other-operator', '--confirm']);
  expect(byMutation.exitCode).toBe(2);
  expect(byMutation.stdout).toContain('conflicting adjudication record');

  // every basis-field mutation is refused (no matching ledger entry)
  for (const mutated of [
    { ...basis, kind: 'plan' as const },
    { ...basis, round: 3 },
    { ...basis, fingerprint: 'd'.repeat(64) },
    { ...basis, action: 'resolved' },
  ]) {
    const r = await adjudicate(repo, 'C7', { ...ACC, basis: mutated });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('exactly one ledger entry');
  }
  // an unknown nested basis field is refused, never silently trimmed
  const extra = await adjudicate(repo, 'C7', { ...ACC, basis: { ...basis, sneaky: true } });
  expect(extra.exitCode).toBe(3);
  expect(extra.stderr).toContain('unknown field "sneaky"');
  expect(await readRegister(repo)).toHaveLength(1); // nothing else ever landed
});

// ---------------------------------------------------------------------------
// superset history + ledger-only reconstruction

test('re-records only ever grow the register; exactly the current record governs; the register reconstructs byte-identically from the ledger alone', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);

  // HEAD moves → satisfied is stale → the gate pends again; re-record at the new HEAD
  await commitChange(repo, 'more-work');
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('=== C7 ===');
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await commitChange(repo, 'yet-more-work');
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);

  const register = await readRegister(repo);
  expect(register).toHaveLength(3); // A→B→C: history only grows, never a conflict
  expect(new Set(register.map((r: { headSha: string }) => r.headSha)).size).toBe(3);
  expect(register[2].headSha).toBe(await headOf(repo));

  // reconstruction from the ledger ALONE is byte-identical
  const ledgerRecords = ledgerAdjudicationRecords((await readLedgerLines(repo)).map((l) => JSON.parse(l)));
  const reconstructed = `${JSON.stringify(ledgerRecords, null, 2)}\n`;
  expect(reconstructed).toBe(await readFile(join(S(repo), 'adjudications.json'), 'utf8'));

  // and the loop completes at the current HEAD
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('gh pr create');
});

// ---------------------------------------------------------------------------
// ledger-only reconstruction across TWO criterion revisions

test('records under two criterion revisions reconstruct byte-identically from the ledger alone', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // criterion v1

  // revision 1: the criterion statement changes → approval voids → fresh review + approval
  const doc = JSON.parse(await readFile(join(S(repo), 'criteria.json'), 'utf8'));
  doc.criteria.find((c: { id: string }) => c.id === 'C7').statement = 'a human eyeballs the output twice';
  await writeFile(join(S(repo), 'criteria.json'), JSON.stringify(doc, null, 2));
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repo);
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('=== C7 ==='); // the v1 record is historical under the revised criterion
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // criterion v2

  const register = await readRegister(repo);
  expect(register).toHaveLength(2);
  expect(new Set(register.map((r: { criterionSha: string }) => r.criterionSha)).size).toBe(2); // two criterion revisions embedded
  const ledgerRecords = ledgerAdjudicationRecords((await readLedgerLines(repo)).map((l) => JSON.parse(l)));
  expect(`${JSON.stringify(ledgerRecords, null, 2)}\n`).toBe(await readFile(join(S(repo), 'adjudications.json'), 'utf8'));
});

// ---------------------------------------------------------------------------
// approval-act identity and the approval-relevant digest

test('a–d: inert audit rows never break an identical approval replay; any approval-relevant row still does', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  const approvalBytesBefore = await readFile(join(S(repo), 'approval.json'), 'utf8');

  // a/b: one, then several, adjudication audit rows → structural no-op, zero writes
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  const replay1 = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(replay1.exitCode).toBe(0);
  expect(replay1.stdout).toContain('already approved — no-op');
  expect(await readFile(join(S(repo), 'approval.json'), 'utf8')).toBe(approvalBytesBefore);
  await commitChange(repo, 'w2');
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // a second inert row (satisfied at the new HEAD)
  const ledgerCount = (await readLedgerLines(repo)).length;
  const replay2 = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(replay2.stdout).toContain('no-op');
  expect((await readLedgerLines(repo)).length).toBe(ledgerCount);
  expect(await readFile(join(S(repo), 'approval.json'), 'utf8')).toBe(approvalBytesBefore);

  // c/d: an approval-relevant row (granted) lands among the inert ones → replay refused, today's message
  expect((await run(repo, ['record-grant', '--kind', 'diff', '--rounds', '1', '--by', 'tester'])).exitCode).toBe(0);
  const refused = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(refused.exitCode).toBe(3);
  expect(refused.stderr).toContain('the ledger changed after the packet was presented');
});

test('e/f: a legacy full-file stamp equals the filtered digest; an ABSENT stamp survives the first inert append and dies on the first relevant row', async () => {
  // f: the clean-GO path never creates a ledger file — the stamp is 'ABSENT'
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect(existsSync(join(S(repo), 'ledger.jsonl'))).toBe(false);
  expect((await readTask(repo)).approvalGate.ledgerSha).toBe('ABSENT');
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0); // first inert append CREATES the file
  const replay = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(replay.stdout).toContain('no-op');
  expect((await run(repo, ['record-grant', '--kind', 'diff', '--rounds', '1', '--by', 'tester'])).exitCode).toBe(0);
  expect((await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE'])).exitCode).toBe(3);

  // e: a pre-feature stamp over a ledger with zero inert rows IS the filtered digest byte-for-byte
  const repoB = await makeRepo();
  const stubB = await makeStubReviewer(repoB);
  expect((await run(repoB, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlanManual(repoB);
  await stubB.respond({
    verdict: 'GO',
    blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'unfalsifiable worry', evidence: 'math.ts', falsifier: '' }], // auto-dropped → a plan-kind ledger row exists
  });
  expect((await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli })).stdout).toContain('APPROVE BUILD');
  const legacyFullFile = sha256(await readFile(join(S(repoB), 'ledger.jsonl')));
  expect((await readTask(repoB)).approvalGate.ledgerSha).toBe(legacyFullFile); // filtered = full-file, by construction
  await approve(repoB);
  await commitChange(repoB, 'feature');
  expect((await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli })).exitCode).toBe(2); // manual gate
  expect((await adjudicate(repoB, 'C7', ACC)).exitCode).toBe(0); // inert append after the legacy-shaped stamp
  const replayB = await run(repoB, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(replayB.stdout).toContain('no-op');
});

test('h/i: a zero-byte-ledger sha256(empty) legacy stamp replays as a no-op across inert appends; a relevant stamp over a now-empty ledger mismatches', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  // legacy shape: a zero-byte ledger file was stamped as sha256 of empty bytes
  await writeFile(join(S(repo), 'ledger.jsonl'), '');
  const task = await readTask(repo);
  task.approvalGate.ledgerSha = EMPTY_SHA256;
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));
  expect((await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE'])).stdout).toContain('no-op');
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0); // inert append
  expect((await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE'])).stdout).toContain('no-op');
  expect((await run(repo, ['record-grant', '--kind', 'diff', '--rounds', '1', '--by', 'tester'])).exitCode).toBe(0);
  const refused = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(refused.exitCode).toBe(3);

  // i: branch selection is on the CURRENT relevant set — a relevant stamp with the ledger deleted mismatches
  const task2 = await readTask(repo);
  task2.approvalGate.ledgerSha = 'd'.repeat(64);
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task2, null, 2));
  rmSync(join(S(repo), 'ledger.jsonl'));
  const mismatch = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(mismatch.exitCode).toBe(3);
  expect(mismatch.stderr).toContain('the ledger changed');
});

test('actId makes approval acts byte-unique — an A→B→A content resurrection stays dead; a pure revert without a new act reactivates', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  const act1 = JSON.parse(await readFile(join(S(repo), 'approval.json'), 'utf8'));
  expect(act1.actId).toHaveLength(36); // every act carries a UUID
  const planBytes = await readFile(join(S(repo), 'plan.md'), 'utf8');
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);

  // voiding edit + byte-exact revert WITHOUT a new act → the record is active again
  await appendFile(join(S(repo), 'plan.md'), 'temporary edit\n');
  await writeFile(join(S(repo), 'plan.md'), planBytes);
  await stub.respond(GO);
  const proceeds = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(proceeds.stdout).not.toContain('HUMAN GATE — manual criteria'); // record still governs
  expect(proceeds.stdout).toContain('gh pr create');

  // A→B→A THROUGH re-approval acts — the record bound to act-1 stays inactive
  const repoB = await makeRepo();
  const stubB = await makeStubReviewer(repoB);
  await toManualGate(repoB, stubB);
  const planB = await readFile(join(S(repoB), 'plan.md'), 'utf8');
  const actA = JSON.parse(await readFile(join(S(repoB), 'approval.json'), 'utf8'));
  expect((await adjudicate(repoB, 'C7', ACC)).exitCode).toBe(0);
  await appendFile(join(S(repoB), 'plan.md'), 'revision B\n');
  await stubB.respond(GO);
  expect((await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repoB); // act 2 (content B)
  await writeFile(join(S(repoB), 'plan.md'), planB); // back to content A
  expect((await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repoB); // act 3 — SAME hashes as act 1, different actId
  const act3 = JSON.parse(await readFile(join(S(repoB), 'approval.json'), 'utf8'));
  expect(JSON.stringify(act3.sha256)).toBe(JSON.stringify(actA.sha256));
  expect(act3.actId).not.toBe(actA.actId); // identical content, different act bytes
  const gateAgain = await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli });
  expect(gateAgain.exitCode).toBe(2);
  expect(gateAgain.stdout).toContain('HUMAN GATE — manual criteria'); // act-1 record is INACTIVE under act 3
});

// ---------------------------------------------------------------------------
// record-pr observation validation, terminal stamp

test('record-pr refuses missing/mismatched observations with digests, accepts CRLF-canonical bodies, stamps publication; publication rows are approval-inert (g)', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('gh pr create');
  const head = (await readTask(repo)).prIntent.headSha;
  const url = 'https://example.test/pr/42';

  // missing observation → usage refusal naming the fetch
  const missing = await run(repo, ['record-pr', '--url', url]);
  expect(missing.exitCode).toBe(3);
  expect(missing.stderr).toContain('--remote-observation <file> is required');

  // url / head / body mismatches → refusals; body mismatch prints BOTH digests
  const wrongUrl = await makeObservation(repo, 'https://example.test/pr/999', head);
  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', wrongUrl])).exitCode).toBe(3);
  const wrongHead = await makeObservation(repo, url, 'f'.repeat(40));
  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', wrongHead])).exitCode).toBe(3);
  const body = await readFile(join(S(repo), 'pr-body.md'), 'utf8');
  const wrongBody = await makeObservation(repo, url, head, `${body}\nsneaky remote edit\n`);
  const bodyRefusal = await run(repo, ['record-pr', '--url', url, '--remote-observation', wrongBody]);
  expect(bodyRefusal.exitCode).toBe(3);
  expect(bodyRefusal.stderr).toContain('observed body sha256');
  expect(bodyRefusal.stderr).toContain('generated body sha256');
  expect((await readTask(repo)).pr).toBeUndefined();

  // a CRLF/trailing-newline variant of the same body is canonical-equal — and
  // internal validation is the WHOLE guarantee (this observation was never near a remote)
  const crlf = await makeObservation(repo, url, head, `${body.replaceAll('\n', '\r\n')}\n\n`);
  const rec = await run(repo, ['record-pr', '--url', url, '--remote-observation', crlf]);
  expect(rec.exitCode).toBe(0);
  const task = await readTask(repo);
  expect(task.pr.publication.bodySha).toHaveLength(64);
  expect(task.pr.publication.headRefOid).toBe(head);
  expect(task.pr.publication.remoteUpdatedAt).toBe('2026-08-24T00:00:00Z');
  expect(task.pr.publication.observedAt).not.toBe('');

  // g: record-publication appends a publication row; the approval replay still no-ops
  const obs = await makeObservation(repo, url, head);
  expect((await run(repo, ['record-publication', '--remote-observation', obs, '--by', 'operator'])).exitCode).toBe(0);
  const replay = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(replay.stdout).toContain('no-op');
});

// ---------------------------------------------------------------------------
// terminal binding for check-pr-body / record-publication

test('check-pr-body and record-publication bind the exact task.pr url+head and the CURRENT body; the attestation entry carries the exact fields; non-terminal exits 3 naming record-pr', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const head = (await readTask(repo)).prIntent.headSha;
  const url = 'https://example.test/pr/50';

  // non-terminal: both commands exit 3 pointing at record-pr
  const early = await makeObservation(repo, url, head);
  const cpbEarly = await run(repo, ['check-pr-body', '--remote-observation', early]);
  expect(cpbEarly.exitCode).toBe(3);
  expect(cpbEarly.stderr).toContain('record-pr');
  const rpEarly = await run(repo, ['record-publication', '--remote-observation', early, '--by', 'operator']);
  expect(rpEarly.exitCode).toBe(3);
  expect(rpEarly.stderr).toContain('record-pr');

  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', early])).exitCode).toBe(0);

  // wrong url / wrong head with a coincidentally matching body → both refuse
  const wrongUrl = await makeObservation(repo, 'https://example.test/pr/51', head);
  expect((await run(repo, ['check-pr-body', '--remote-observation', wrongUrl])).exitCode).toBe(1);
  expect((await run(repo, ['record-publication', '--remote-observation', wrongUrl, '--by', 'operator'])).exitCode).toBe(3);
  const wrongHead = await makeObservation(repo, url, 'e'.repeat(40));
  expect((await run(repo, ['check-pr-body', '--remote-observation', wrongHead])).exitCode).toBe(1);
  expect((await run(repo, ['record-publication', '--remote-observation', wrongHead, '--by', 'operator'])).exitCode).toBe(3);

  // exact url + head + matching body → accept; the audit entry carries the exact fields
  const good = await makeObservation(repo, url, head);
  expect((await run(repo, ['check-pr-body', '--remote-observation', good])).exitCode).toBe(0);
  const taskBefore = JSON.stringify((await readTask(repo)).pr);
  const attest = await run(repo, ['record-publication', '--remote-observation', good, '--by', 'operator']);
  expect(attest.exitCode).toBe(0);
  const pubRows = (await readLedgerLines(repo)).map((l) => JSON.parse(l)).filter((e) => e.kind === 'publication');
  expect(pubRows).toHaveLength(1);
  expect(pubRows[0].action).toBe('attested');
  expect(pubRows[0].round).toBe(0);
  expect(pubRows[0].publication.url).toBe(url);
  expect(pubRows[0].publication.headRefOid).toBe(head);
  expect(pubRows[0].publication.bodySha).toBe(pubRows[0].fingerprint);
  expect(pubRows[0].publication.remoteUpdatedAt).toBe('2026-08-24T00:00:00Z');
  expect(pubRows[0].publication.observedAt).not.toBe('');
  expect(pubRows[0].publication.by).toBe('operator');
  expect(JSON.stringify((await readTask(repo)).pr)).toBe(taskBefore); // task.pr untouched

  // replay of the identical attestation → no-op, one row
  const replay = await run(repo, ['record-publication', '--remote-observation', good, '--by', 'operator']);
  expect(replay.stdout).toContain('no-op');
  expect((await readLedgerLines(repo)).map((l) => JSON.parse(l)).filter((e) => e.kind === 'publication')).toHaveLength(1);

  // BLOCKER fix: a tampered publication WRAPPER can never fake a replay no-op —
  // the shared boundary STOPs before any replay classification
  const lines = await readLedgerLines(repo);
  const tamperedLedger = lines
    .map((l) => {
      const e = JSON.parse(l);
      if (e.kind === 'publication') e.fingerprint = 'f'.repeat(64); // wrapper no longer equals publication.bodySha
      return JSON.stringify(e);
    })
    .map((l) => `${l}\n`)
    .join('');
  await writeFile(join(S(repo), 'ledger.jsonl'), tamperedLedger);
  const stopped = await run(repo, ['record-publication', '--remote-observation', good, '--by', 'operator']);
  expect(stopped.exitCode).toBe(3); // fail-closed at the shared boundary (inside the projection derivation)
  expect(stopped.stderr).toContain('audit-record schema');
  expect((await readLedgerLines(repo)).map((l) => JSON.parse(l)).filter((e) => e.kind === 'publication')).toHaveLength(1); // nothing appended
  await writeFile(join(S(repo), 'ledger.jsonl'), lines.map((l) => `${l}\n`).join('')); // restore for the tail below

  // honest boundary: the projection changes after the observation was captured →
  // the stale observation is refused on body mismatch; a fresh check against the new
  // body catches the divergence (re-running the check IS the detection)
  await writeFile(join(S(repo), 'summary.md'), 'a different story\n');
  const stale = await run(repo, ['check-pr-body', '--remote-observation', good]);
  expect(stale.exitCode).toBe(1);
  expect(stale.stdout).toContain('observed body sha256');
});

// ---------------------------------------------------------------------------
// publication stamp deep validation; legacy pr stays valid

test('malformed task.pr.publication STOPs, never terminal-by-garbage; a legacy pr without publication stays valid', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await stub.respond(GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const head = (await readTask(repo)).prIntent.headSha;
  const obs = await makeObservation(repo, 'https://x.test/pr/1', head);
  expect((await run(repo, ['record-pr', '--url', 'https://x.test/pr/1', '--remote-observation', obs])).exitCode).toBe(0);
  const good = await readTask(repo);

  const badStamps = [
    {},
    { bodySha: '', headRefOid: 'h', remoteUpdatedAt: 't', observedAt: 't' },
    { bodySha: 'nothex', headRefOid: 'h', remoteUpdatedAt: 't', observedAt: 't' },
    { bodySha: 'b'.repeat(64), headRefOid: '', remoteUpdatedAt: 't', observedAt: 't' },
    { bodySha: 'b'.repeat(64), headRefOid: 'h', remoteUpdatedAt: 't' },
    // "extra" variant: an unauthorized member is never terminal-by-garbage
    { bodySha: 'b'.repeat(64), headRefOid: 'h', remoteUpdatedAt: 't', observedAt: 't', extra: 'x' },
  ];
  for (const publication of badStamps) {
    const mutated = structuredClone(good);
    mutated.pr.publication = publication;
    await writeFile(join(S(repo), 'task.json'), JSON.stringify(mutated, null, 2));
    const r = await run(repo, ['next']);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('task.json does not match the sequencer schema');
    // status surfaces the invalid state — it never cosmetically
    // renders a malformed publication stamp as a legitimate terminal fact
    const st = await run(repo, ['status']);
    expect(st.stdout).toContain('task.json: INVALID');
    expect(st.stdout).not.toContain('publication stamped');
  }
  // legacy: no publication member at all → explicitly valid, still terminal
  const legacy = structuredClone(good);
  delete legacy.pr.publication;
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(legacy, null, 2));
  const done = await run(repo, ['next']);
  expect(done.exitCode).toBe(0);
  expect(done.stdout).toContain('done — PR');
});

// ---------------------------------------------------------------------------
// check-pr-body is truly read-only

test('check-pr-body leaves every byte, mtime and directory listing of $S unchanged — on match AND mismatch', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await stub.respond(GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const head = (await readTask(repo)).prIntent.headSha;
  const obs = await makeObservation(repo, 'https://x.test/pr/9', head);
  expect((await run(repo, ['record-pr', '--url', 'https://x.test/pr/9', '--remote-observation', obs])).exitCode).toBe(0);

  const fingerprint = async () => {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const name of (await import('node:fs')).readdirSync(dir).sort()) {
        const p = join(dir, name);
        const st = (await import('node:fs')).statSync(p);
        if (st.isDirectory()) {
          out.push(`dir ${p}`);
          await walk(p);
        } else {
          out.push(`${p} ${st.mtimeMs} ${sha256(await readFile(p))}`);
        }
      }
    };
    await walk(S(repo));
    return out.join('\n');
  };

  const before = await fingerprint();
  const match = await run(repo, ['check-pr-body', '--remote-observation', obs]);
  expect(match.exitCode).toBe(0);
  expect(await fingerprint()).toBe(before);

  const bad = await makeObservation(repo, 'https://x.test/pr/9', head, 'entirely different body\n');
  const badObsAside = join(aux(repo), 'bad-obs.json'); // keep the mismatching observation OUTSIDE $S
  await writeFile(badObsAside, await readFile(bad, 'utf8'));
  const mismatch = await run(repo, ['check-pr-body', '--remote-observation', badObsAside]);
  expect(mismatch.exitCode).toBe(1);
  expect(await fingerprint()).toBe(before);
});

// ---------------------------------------------------------------------------
// a pending manual criterion blocks record-pr by name (legacy escape hatch closed)

test('record-pr refuses while a manual criterion is unadjudicated — even when a legacy reviewBase carries no digest', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  // a NO-manual task driven to the PR intent (legacy shape), then a manual
  // criterion appears with hand-matched approval bytes (the hostile/legacy case)
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  const s = S(repo);
  mkdirSync(s, { recursive: true });
  await writeFile(join(s, 'plan.md'), '# plan\n\nbuild the thing\n');
  await writeFile(
    join(s, 'criteria.json'),
    JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } }] }, null, 2),
  );
  await writeFile(join(s, 'promises.json'), '[]');
  await writeFile(join(s, 'plan-files.json'), JSON.stringify(['math.ts']));
  await writeFile(join(s, 'gates.json'), JSON.stringify({ smoke: 'true' }, null, 2));
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repo);
  await commitChange(repo, 'feature');
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('gh pr create');

  // the manual criterion lands; approval + gate hashes are hand-matched; the
  // legacy reviewBase digest reads 'NONE' and the current digest is 'NONE' too —
  // ONLY the pending-manual check can refuse here
  const doc = JSON.parse(await readFile(join(s, 'criteria.json'), 'utf8'));
  doc.criteria.push({ id: 'C9', statement: 'a human checks the rollout plan', verification: { method: 'manual' } });
  await writeFile(join(s, 'criteria.json'), JSON.stringify(doc, null, 2));
  const criteriaSha = sha256(await readFile(join(s, 'criteria.json')));
  const approval = JSON.parse(await readFile(join(s, 'approval.json'), 'utf8'));
  approval.sha256['criteria.json'] = criteriaSha;
  await writeFile(join(s, 'approval.json'), JSON.stringify(approval, null, 2));
  const task = await readTask(repo);
  task.approvalGate.hashes['criteria.json'] = criteriaSha;
  delete task.reviewBase.adjudicationsSha; // the legacy shape
  await writeFile(join(s, 'task.json'), JSON.stringify(task, null, 2));

  const head = (await readTask(repo)).prIntent.headSha;
  const obs = await makeObservation(repo, 'https://x.test/pr/3', head);
  const refused = await run(repo, ['record-pr', '--url', 'https://x.test/pr/3', '--remote-observation', obs]);
  expect(refused.exitCode).toBe(3);
  expect(refused.stderr).toContain('manual criteria are not adjudicated: C9');
  expect(refused.stderr).toContain('record-adjudication');
  expect((await readTask(repo)).pr).toBeUndefined();
});

// ---------------------------------------------------------------------------
// terminal adjudication needs a basis; synthetic historical-entry basis

test('terminal recording requires a validated basis (a synthetic rejected-entry basis); check-pr-body green; record-publication closes; task.pr byte-identical', async () => {
  // Synthetic scenario: a legacy terminal task whose manual criterion was never
  // adjudicated (pre-feature) — the retrofit records the accepted decision now.
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  const s = S(repo);
  mkdirSync(s, { recursive: true });
  await writeFile(join(s, 'plan.md'), '# plan\n\nbuild the thing\n');
  await writeFile(
    join(s, 'criteria.json'),
    JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } }] }, null, 2),
  );
  await writeFile(join(s, 'promises.json'), '[]');
  await writeFile(join(s, 'plan-files.json'), JSON.stringify(['math.ts']));
  await writeFile(join(s, 'gates.json'), JSON.stringify({ smoke: 'true' }, null, 2));
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repo);
  await commitChange(repo, 'feature');
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('gh pr create');
  const head = (await readTask(repo)).prIntent.headSha;
  const url = 'https://example.test/inventory/pull/3';
  const obs0 = await makeObservation(repo, url, head);
  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', obs0])).exitCode).toBe(0);
  const prBytesBefore = JSON.stringify((await readTask(repo)).pr);

  // the history shape: a round-4 diff rejection whose free-text detail carried the ruling
  const syntheticEntry = {
    ts: '2026-08-20T10:00:00.000Z',
    kind: 'diff',
    round: 4,
    reviewer: 'codex',
    blockerId: 'B2',
    fingerprint: `a1b2c3d4${'0'.repeat(56)}`,
    action: 'rejected',
    detail: 'synthetic decision: large-file rendering remains untested',
  };
  await appendFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify(syntheticEntry)}\n`);

  // Reconstruct a legacy terminal state: criteria, approval binding and matrix
  // carry C7 manual without a recorded adjudication.
  const doc = JSON.parse(await readFile(join(s, 'criteria.json'), 'utf8'));
  doc.criteria.push({ id: 'C7', statement: 'a human eyeballs the output once', verification: { method: 'manual' } });
  await writeFile(join(s, 'criteria.json'), JSON.stringify(doc, null, 2));
  const criteriaSha = sha256(await readFile(join(s, 'criteria.json')));
  const approval = JSON.parse(await readFile(join(s, 'approval.json'), 'utf8'));
  approval.sha256['criteria.json'] = criteriaSha;
  await writeFile(join(s, 'approval.json'), JSON.stringify(approval, null, 2));
  const matrix = JSON.parse(await readFile(join(s, 'evidence', 'criteria-matrix.json'), 'utf8'));
  matrix.C7 = { status: 'manual', evidencePath: 'x' };
  await writeFile(join(s, 'evidence', 'criteria-matrix.json'), JSON.stringify(matrix, null, 2));

  // a terminal adjudication without a basis is refused
  const noBasis = await adjudicate(repo, 'C7', ACC);
  expect(noBasis.exitCode).toBe(3);
  expect(noBasis.stderr).toContain('basis');

  // malformed/unmatched basis → refusal, nothing written
  const unmatched = await adjudicate(repo, 'C7', { ...ACC, basis: { kind: 'diff', round: 9, fingerprint: syntheticEntry.fingerprint, action: 'rejected' } });
  expect(unmatched.exitCode).toBe(3);
  expect(unmatched.stderr).toContain('exactly one ledger entry');
  const malformed = await adjudicate(repo, 'C7', { ...ACC, basis: { kind: 'nope', round: 4, fingerprint: 'x', action: 'rejected' } });
  expect(malformed.exitCode).toBe(3);
  expect((await readRegister(repo)).filter((r: { decision: string }) => r.decision === 'accepted')).toHaveLength(0);

  // the dry run presents the referenced entry verbatim; --confirm records it
  const basis = { kind: 'diff', round: 4, fingerprint: syntheticEntry.fingerprint, action: 'rejected' };
  const respFile = join(aux(repo), 'terminal-resp.json');
  await writeFile(respFile, JSON.stringify({ ...ACC, basis }));
  const dry = await run(repo, ['record-adjudication', '--criterion', 'C7', '--response', respFile, '--by', 'operator']);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain('referenced ledger entry (basis, verbatim)');
  expect(dry.stdout).toContain('synthetic decision: large-file rendering remains untested');
  const recorded = await adjudicate(repo, 'C7', { ...ACC, basis });
  expect(recorded.exitCode).toBe(0);
  const acceptedRec = (await readRegister(repo)).find((r: { decision: string }) => r.decision === 'accepted');
  expect(acceptedRec.basisEntry).toEqual(syntheticEntry); // the cited entry embedded verbatim
  expect(acceptedRec.at > syntheticEntry.ts).toBe(true); // timeline: original ruling vs encoding act, mechanically distinct
  expect(JSON.stringify((await readTask(repo)).pr)).toBe(prBytesBefore); // task.pr byte-identical

  // regenerate the body (it now carries the adjudication), validate, attest
  await regenBody(repo);
  const body = await readFile(join(S(repo), 'pr-body.md'), 'utf8');
  expect(body).toContain('**ADJUDICATED accepted** by operator — unproven: large-file rendering untested');
  const obs = await makeObservation(repo, url, head);
  expect((await run(repo, ['check-pr-body', '--remote-observation', obs])).exitCode).toBe(0);
  const attest = await run(repo, ['record-publication', '--remote-observation', obs, '--by', 'operator']);
  expect(attest.exitCode).toBe(0);
  expect((await readLedgerLines(repo)).map((l) => JSON.parse(l)).filter((e) => e.kind === 'publication')).toHaveLength(1);
  expect(JSON.stringify((await readTask(repo)).pr)).toBe(prBytesBefore); // still untouched
});

// ---------------------------------------------------------------------------
// conformance — foreign cwd with a decoy git repo changes nothing

test('run.mjs, verify.mjs, pr.mjs and check-pr-body behave identically from a foreign cwd holding a decoy git repo', async () => {
  const repo = await makeRepo();
  const decoy = await makeRepo(); // a different repo, used only as cwd
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await stub.respond(GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const head = (await readTask(repo)).prIntent.headSha;
  const obs = await makeObservation(repo, 'https://x.test/pr/5', head);
  expect((await run(repo, ['record-pr', '--url', 'https://x.test/pr/5', '--remote-observation', obs])).exitCode).toBe(0);

  const fromDecoy = (argv: string[]) => execArgv(argv, { cwd: decoy, timeoutMs: 60_000 });
  const VERIFY = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));

  const status = await fromDecoy(['node', RUN, 'status', '--repo', repo]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain('manual C7: ADJUDICATED satisfied by operator');
  const next = await fromDecoy(['node', RUN, 'next', '--repo', repo]);
  expect(next.stdout).toContain('done — PR');
  const verify = await fromDecoy(['node', VERIFY, 'criteria', S(repo), '--repo', repo]);
  expect(verify.exitCode).toBe(0);
  expect(verify.stdout).toContain('1 adjudicated');
  const pr = await fromDecoy(['node', PRSCRIPT, S(repo), '--repo', repo, '--title', 'test task']);
  expect(pr.exitCode).toBe(0);
  expect(pr.stdout).toContain('**ADJUDICATED satisfied** by operator');
  const cpb = await fromDecoy(['node', RUN, 'check-pr-body', '--repo', repo, '--remote-observation', obs]);
  expect(cpb.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// the standalone ledger.mjs referees enforce the same adjudication
// invariants as run.mjs — replay/conflict, corrupt-register masking, and the
// full task-level precondition guards

test('direct ledger.mjs adjudicate: replay no-ops, conflicts refuse at write, a pre-corrupt register can never be masked, and every task-level guard holds', async () => {
  const LEDGER = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0); // the real recorded act
  const register = await readRegister(repo);
  const recFile = join(aux(repo), 'direct-record.json');
  const exec = (argv: string[]) => execArgv(argv, { cwd: repo, timeoutMs: 30_000 });
  const direct = () => exec(['node', LEDGER, 'adjudicate', S(repo), '--repo', repo, '--record', recFile]);

  // replay of the exact recorded act → no-op, nothing appended
  await writeFile(recFile, JSON.stringify(register[0]));
  const replay = await direct();
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('no-op');
  // a context replica (different `at`) is the same act — still a no-op, never a tooling-minted replica
  await writeFile(recFile, JSON.stringify({ ...register[0], at: '2026-08-25T12:00:00.000Z' }));
  expect((await direct()).stdout).toContain('no-op');
  // same binding, different content → refused at write
  await writeFile(recFile, JSON.stringify({ ...register[0], ruling: 'entirely different words' }));
  const conflict = await direct();
  expect(conflict.exitCode).toBe(3);
  expect(conflict.stderr).toContain('Refused at write');
  expect(await readRegister(repo)).toHaveLength(1);

  // task-level guards: a hash-correct record for a NON-manual criterion is refused
  const criteriaDoc = JSON.parse(await readFile(join(S(repo), 'criteria.json'), 'utf8'));
  const c1 = criteriaDoc.criteria.find((c: { id: string }) => c.id === 'C1');
  const approvalBytes = await readFile(join(S(repo), 'approval.json'));
  const { criterionShaOf, recordDigest: digestOf } = await import('../scripts/adjudication.lib.mjs');
  const nonManual = {
    type: 'adjudication',
    criterionId: 'C1',
    criterionSha: criterionShaOf(c1),
    criterion: c1,
    approvalActSha: sha256(approvalBytes),
    headSha: await headOf(repo),
    decision: 'satisfied',
    ruling: 'sneaky non-manual adjudication',
    by: 'operator',
    at: '2026-08-24T00:00:00.000Z',
  };
  await writeFile(recFile, JSON.stringify(nonManual));
  const refusedNonManual = await direct();
  expect(refusedNonManual.exitCode).toBe(3);
  expect(refusedNonManual.stderr).toContain('manual criteria only');

  // satisfied on a dirty worktree is refused — even through the referee
  const c7 = criteriaDoc.criteria.find((c: { id: string }) => c.id === 'C7');
  const satisfied = { ...nonManual, criterionId: 'C7', criterionSha: criterionShaOf(c7), criterion: c7, ruling: 'checked by hand' };
  await writeFile(join(repo, 'dirty.txt'), 'x\n');
  await writeFile(recFile, JSON.stringify(satisfied));
  const dirty = await direct();
  expect(dirty.exitCode).toBe(3);
  expect(dirty.stderr).toContain('clean worktree');
  rmSync(join(repo, 'dirty.txt'));

  // a voided approval is refused — approval currency is enforced at this entry point too
  await appendFile(join(S(repo), 'plan.md'), 'voiding edit\n');
  const voided = await direct();
  expect(voided.exitCode).toBe(3);
  expect(voided.stderr).toContain('no current matching approval');
  expect(await readRegister(repo)).toHaveLength(1); // nothing ever landed

  // an ALREADY-conflicting register fails closed even when the submission
  // replays one half — corruption is never masked by a replay
  const repoB = await makeRepo();
  const stubB = await makeStubReviewer(repoB);
  await toManualGate(repoB, stubB);
  expect((await adjudicate(repoB, 'C7', ACC)).exitCode).toBe(0);
  const regB = await readRegister(repoB);
  const conflicting = { ...regB[0], ruling: 'a fabricated second ruling' };
  const rows = await readLedgerLines(repoB);
  const conflictRow = JSON.parse(rows.find((l) => l.includes('"adjudicated"')) as string);
  conflictRow.record = conflicting;
  conflictRow.fingerprint = digestOf(conflicting);
  conflictRow.detail = `${conflicting.by} adjudicated ${conflicting.criterionId} ${conflicting.decision}: ${conflicting.ruling}`;
  await appendFile(join(S(repoB), 'ledger.jsonl'), `${JSON.stringify(conflictRow)}\n`);
  await writeFile(join(S(repoB), 'adjudications.json'), `${JSON.stringify([...regB, conflicting], null, 2)}\n`);
  const recFileB = join(aux(repoB), 'record.json');
  await writeFile(recFileB, JSON.stringify(regB[0])); // replay one half of the corrupt pair
  const masked = await execArgv(['node', LEDGER, 'adjudicate', S(repoB), '--repo', repoB, '--record', recFileB], { cwd: repoB, timeoutMs: 30_000 });
  expect(masked.exitCode).toBe(3);
  expect(masked.stderr).toContain('conflicting adjudication records');
});

test('direct ledger.mjs attest: publication authority requires the exact terminal url, head, and CURRENT body digest', async () => {
  const LEDGER = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await stub.respond(GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const head = (await readTask(repo)).prIntent.headSha;
  const url = 'https://x.test/pr/70';
  const obs = await makeObservation(repo, url, head);
  const exec = (argv: string[]) => execArgv(argv, { cwd: repo, timeoutMs: 30_000 });
  const attest = (u: string, h: string, bodySha: string) =>
    exec(['node', LEDGER, 'attest', S(repo), '--repo', repo, '--url', u, '--head-ref', h, '--body-sha', bodySha, '--remote-updated-at', 't1', '--observed-at', '2026-08-24T01:00:00.000Z', '--by', 'operator']);
  const bodySha = sha256(canonicalBody(await readFile(join(S(repo), 'pr-body.md'), 'utf8')));

  // non-terminal task → refused
  const early = await attest(url, head, bodySha);
  expect(early.exitCode).toBe(3);
  expect(early.stderr).toContain('not terminal');

  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', obs])).exitCode).toBe(0);
  // wrong url / wrong head / wrong body digest → all refused
  expect((await attest('https://x.test/pr/71', head, bodySha)).exitCode).toBe(3);
  expect((await attest(url, 'f'.repeat(40), bodySha)).exitCode).toBe(3);
  const wrongBody = await attest(url, head, 'd'.repeat(64));
  expect(wrongBody.exitCode).toBe(3);
  expect(wrongBody.stderr).toContain('does not equal the digest of the CURRENT generated body');
  expect((await readLedgerLines(repo)).filter((l) => l.includes('"publication"'))).toHaveLength(0);
  // the exact terminal binding → the attestation appends
  const good = await attest(url, head, bodySha);
  expect(good.exitCode).toBe(0);
  expect((await readLedgerLines(repo)).filter((l) => l.includes('"attested"'))).toHaveLength(1);

  // the writer consumes the readers' schema — a locally supplied
  // non-ISO observedAt is refused UNWRITTEN on this same terminal task
  const badTime = await exec([
    'node', LEDGER, 'attest', S(repo), '--repo', repo, '--url', url, '--head-ref', head, '--body-sha', bodySha,
    '--remote-updated-at', 't1', '--observed-at', 'not-a-time', '--by', 'operator',
  ]);
  expect(badTime.exitCode).toBe(3);
  expect(badTime.stderr).toContain('refusing to append an audit row its consumers would reject');
  expect((await readLedgerLines(repo)).filter((l) => l.includes('"attested"'))).toHaveLength(1); // only the good one

  // on this terminal task, a direct adjudicate WITHOUT a basis is
  // refused by the same shared guard run.mjs uses (terminal-basis rule)
  const { criterionShaOf } = await import('../scripts/adjudication.lib.mjs');
  const criteriaDoc = JSON.parse(await readFile(join(S(repo), 'criteria.json'), 'utf8'));
  const c7 = criteriaDoc.criteria.find((c: { id: string }) => c.id === 'C7');
  const noBasisRecord = {
    type: 'adjudication',
    criterionId: 'C7',
    criterionSha: criterionShaOf(c7),
    criterion: c7,
    approvalActSha: sha256(await readFile(join(S(repo), 'approval.json'))),
    headSha: head,
    decision: 'accepted',
    ruling: 'terminal re-adjudication without a basis',
    residual: 'r',
    by: 'operator',
    at: '2026-08-24T02:00:00.000Z',
  };
  const recFile = join(aux(repo), 'no-basis.json');
  await writeFile(recFile, JSON.stringify(noBasisRecord));
  const refused = await exec(['node', LEDGER, 'adjudicate', S(repo), '--repo', repo, '--record', recFile]);
  expect(refused.exitCode).toBe(3);
  expect(refused.stderr).toContain('basis');
}, 60_000); // referee child processes: the default 5 s budget is marginal under full-suite load

// ---------------------------------------------------------------------------
// malformed adjudicationIntents fail closed before any control flow

test('malformed adjudicationIntents STOP the task — a string consumed flag or negative counters can never fake a successful no-op', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  const good = await readTask(repo);
  const digest = good.adjudicationIntents[0].key;
  const bads = [
    [{ key: digest, consumed: 'false', recordsBefore: 0, ledgerBefore: 0 }], // string, not boolean
    [{ key: digest, consumed: false, recordsBefore: -1, ledgerBefore: 0 }],
    [{ key: digest, consumed: false, recordsBefore: 0, ledgerBefore: -2 }],
    [{ key: 'not-a-digest', consumed: false, recordsBefore: 0, ledgerBefore: 0 }],
    [{ key: digest, consumed: false, recordsBefore: 0, ledgerBefore: 0, sneaky: true }],
    [{ key: digest, recordsBefore: 0, ledgerBefore: 0 }], // consumed missing
  ];
  for (const adjudicationIntents of bads) {
    await writeFile(join(S(repo), 'task.json'), JSON.stringify({ ...good, adjudicationIntents }, null, 2));
    // next STOPs on the schema...
    const next = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
    expect(next.exitCode).toBe(2);
    expect(next.stdout).toContain('task.json does not match the sequencer schema');
    // ...and so does record-adjudication — the malformed intent can never
    // convert a required recording into a successful no-op
    const rec = await adjudicate(repo, 'C7', { ...ACC, ruling: 'a new ruling that must not silently vanish' });
    expect(rec.exitCode).toBe(2);
    expect(rec.stdout).toContain('task.json does not match the sequencer schema');
  }
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(good, null, 2));
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(0); // restored state proceeds
});

// ---------------------------------------------------------------------------
// (run.mjs consumer): an audit row appended after an open raised row never
// confuses the open-blockers kind derivation

test('an adjudication recorded while diff blockers are open leaves openBlockersKind and the reconcile route unchanged', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await stub.respond({
    verdict: 'NO_GO',
    blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' }],
  });
  const noGo = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(noGo.exitCode).toBe(0);
  expect(noGo.stdout).toContain('proposal.json'); // diff blockers open, reconcile instructed

  // the ledger tail is now an AUDIT row, not the raised row — a new coexisting act
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.exitCode).toBe(0);
  expect(again.stdout).toContain('proposal.json'); // still routed to the diff reconcile — never a kind STOP
  expect(again.stdout).not.toContain('STOP');
});

// ---------------------------------------------------------------------------
// the approval packet names the command; the ledger render carries audit rows

test('the approval packet names record-adjudication for manual criteria and renders adjudication audit entries in the ledger section', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  // void the approval → the gate re-presents with the audit row in its rendered ledger
  await appendFile(join(S(repo), 'plan.md'), 'revision\n');
  await stub.respond(GO);
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('APPROVE BUILD');
  expect(gate.stdout).toContain('run.mjs record-adjudication --criterion <id> --response <file> --by <you>');
  expect(gate.stdout).toContain('[adjudication round 0] adjudicated'); // renderLedger over the audit entry
  // and the reviewer prompt's LEDGER section carried it too
  expect(await stub.prompts()).toContain('[adjudication round 0] adjudicated');
});

// ---------------------------------------------------------------------------
// corrections

test('a consumed adjudication intent is bookkeeping, not proof — rolled-back durable state STOPs; genuine landed state replays idempotently', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);

  // genuine replay: the act is present in the register AND the ledger → no-op, byte-identical state
  const registerBytes = await readFile(join(S(repo), 'adjudications.json'), 'utf8');
  const ledgerBytes = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  const replay = await adjudicate(repo, 'C7', ACC);
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('no-op');
  expect(await readFile(join(S(repo), 'adjudications.json'), 'utf8')).toBe(registerBytes);
  expect(await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).toBe(ledgerBytes);

  // roll the act out of BOTH durable stores — the consumed flag alone must not fake success
  rmSync(join(S(repo), 'adjudications.json'));
  const stripped = ledgerBytes
    .split('\n')
    .filter((l) => l !== '' && !l.includes('"adjudicated"'))
    .map((l) => `${l}\n`)
    .join('');
  await writeFile(join(S(repo), 'ledger.jsonl'), stripped);
  const fabricated = await adjudicate(repo, 'C7', ACC);
  expect(fabricated.exitCode).toBe(2);
  expect(fabricated.stdout).toContain('marked consumed but the recorded act is absent');
  expect(existsSync(join(S(repo), 'adjudications.json'))).toBe(false); // the refused attempt wrote nothing
  expect(await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).toBe(stripped);
});

test('a malformed task.pr is refused by the standalone guards — never read as a non-terminal basis', async () => {
  const LEDGER = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  const exec = (argv: string[]) => execArgv(argv, { cwd: repo, timeoutMs: 30_000 });
  const { criterionShaOf } = await import('../scripts/adjudication.lib.mjs');
  const criteriaDoc = JSON.parse(await readFile(join(S(repo), 'criteria.json'), 'utf8'));
  const c7 = criteriaDoc.criteria.find((c: { id: string }) => c.id === 'C7');
  // a basis-free accepted record — legal on a non-terminal task, refused on a terminal one
  const record = {
    type: 'adjudication',
    criterionId: 'C7',
    criterionSha: criterionShaOf(c7),
    criterion: c7,
    approvalActSha: sha256(await readFile(join(S(repo), 'approval.json'))),
    headSha: await headOf(repo),
    decision: 'accepted',
    ruling: 'synthetic rendering gap accepted',
    residual: 'large-file rendering untested',
    by: 'operator',
    at: '2026-08-24T00:00:00.000Z',
  };
  const recFile = join(aux(repo), 'malformed-pr-record.json');
  await writeFile(recFile, JSON.stringify(record));

  const good = await readTask(repo);
  // beyond task.pr: the FULL sequencer schema is enforced at the standalone
  // entry points — version and config corruption refuse identically
  for (const bad of [{ pr: 'yes' }, { pr: {} }, { pr: { url: 'https://x.test/pr/1' } }, { sequencerVersion: 99 }, { config: null }]) {
    await writeFile(join(S(repo), 'task.json'), JSON.stringify({ ...good, ...bad }, null, 2));
    // adjudicate: the malformed pr must not read as "non-terminal" and waive
    // the basis rule — the shared full-task schema refuses the task outright
    const adj = await exec(['node', LEDGER, 'adjudicate', S(repo), '--repo', repo, '--record', recFile]);
    expect(adj.exitCode).toBe(3);
    expect(adj.stderr).toContain('does not match the sequencer schema');
    expect(existsSync(join(S(repo), 'adjudications.json'))).toBe(false); // nothing landed
    // attest: same refusal class — malformed, never "not terminal → record-pr"
    const att = await exec([
      'node', LEDGER, 'attest', S(repo), '--repo', repo,
      '--url', 'https://x.test/pr/1', '--head-ref', 'a'.repeat(40), '--body-sha', 'b'.repeat(64),
      '--remote-updated-at', 't1', '--observed-at', '2026-08-24T01:00:00.000Z', '--by', 'operator',
    ]);
    expect(att.exitCode).toBe(3);
    expect(att.stderr).toContain('does not match the sequencer schema');
  }

  // restored healthy state: the same record lands (non-terminal, basis-free accepted is legal)
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(good, null, 2));
  const healthy = await exec(['node', LEDGER, 'adjudicate', S(repo), '--repo', repo, '--record', recFile]);
  expect(healthy.exitCode).toBe(0);
});

test('terminal next never reports done over invalid adjudication state — divergence STOPs before any success line', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('gh pr create');
  const head = (await readTask(repo)).prIntent.headSha;
  const url = 'https://x.test/pr/91';
  const obs = await makeObservation(repo, url, head);
  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', obs])).exitCode).toBe(0);

  // terminal baseline: done is reported over VALID adjudication truth
  const done = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(done.exitCode).toBe(0);
  expect(done.stdout).toContain('run: done — PR');

  // healthy terminal record-pr replay: idempotent no-op, nothing rewritten
  const taskBytes = await readFile(join(S(repo), 'task.json'), 'utf8');
  const healthyReplay = await run(repo, ['record-pr', '--url', url, '--remote-observation', obs]);
  expect(healthyReplay.exitCode).toBe(0);
  expect(healthyReplay.stdout).toContain('already recorded — no-op');
  expect(await readFile(join(S(repo), 'task.json'), 'utf8')).toBe(taskBytes);

  // corrupt the adjudication state: an orphan register record (register/ledger
  // divergence) — the terminal path must STOP, never print done
  const register = await readRegister(repo);
  const orphan = { ...register[0], ruling: 'never landed in the ledger', at: '2026-08-25T00:00:00.000Z' };
  await writeFile(join(S(repo), 'adjudications.json'), `${JSON.stringify([...register, orphan], null, 2)}\n`);
  const blocked = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stdout).toContain('the adjudication state is invalid');
  expect(blocked.stdout).not.toContain('run: done');

  // the record-pr REPLAY over the same divergence must STOP too — no success
  // surface survives invalid adjudication state, and the refusal writes nothing
  const divergedTask = await readFile(join(S(repo), 'task.json'), 'utf8');
  const divergedReplay = await run(repo, ['record-pr', '--url', url, '--remote-observation', obs]);
  expect(divergedReplay.exitCode).toBe(2);
  expect(divergedReplay.stdout).toContain('the adjudication state is invalid');
  expect(divergedReplay.stdout).not.toContain('no-op');
  expect(await readFile(join(S(repo), 'task.json'), 'utf8')).toBe(divergedTask);

  // malformed adjudication history: same STOP, same zero writes
  await writeFile(join(S(repo), 'adjudications.json'), '{ torn');
  const malformedReplay = await run(repo, ['record-pr', '--url', url, '--remote-observation', obs]);
  expect(malformedReplay.exitCode).toBe(2);
  expect(malformedReplay.stdout).toContain('the adjudication state is invalid');
  expect(await readFile(join(S(repo), 'adjudications.json'), 'utf8')).toBe('{ torn');
});
