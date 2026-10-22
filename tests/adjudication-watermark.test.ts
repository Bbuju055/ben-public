import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { commitChange, git, makeFixtureRepo, makeTmpDir, PAUSE_BOUNDARY_POLL_MS, PAUSE_BOUNDARY_WAIT_MS } from './helpers';

// Recorded-
// round replay bound to the surviving verdict, supersession watermarks with
// unscoped integrity guards, post-GO recovery through the record-pr-remote
// migration, and the governing-fallback sequence.

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
const headOf = async (repo: string) => (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();

async function makeStubReviewer(repo: string): Promise<{ cli: string; respond: (v: unknown) => Promise<void>; calls: () => Promise<number>; prompts: () => Promise<string> }> {
  const dir = await makeTmpDir('adjwm-stub-');
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
// a GO whose only finding is auto-dropped (no falsifier) — the round records
// ledger rows without advancing the tally
const GO_DROPPED = {
  verdict: 'GO',
  blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'unfalsifiable worry', evidence: 'math.ts', falsifier: '' }],
};

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
  expect((await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE'])).exitCode).toBe(0);
}

async function toManualGate(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>, opts: { extraManual?: boolean } = {}): Promise<void> {
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlanManual(repo, opts);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repo);
  await commitChange(repo, 'feature');
  const manual = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(manual.exitCode).toBe(2);
  expect(manual.stdout).toContain('HUMAN GATE — manual criteria');
}

const SAT = { decision: 'satisfied', ruling: 'checked the output by hand, it is right' };
const ACC = { decision: 'accepted', ruling: 'the synthetic rendering gap is accepted', residual: 'large-file rendering untested' };

function aux(repo: string): string {
  const dir = `${repo}-aux`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function adjudicate(repo: string, id: string, response: unknown): Promise<ExecResult> {
  const file = join(aux(repo), `response-${id}.json`);
  await writeFile(file, JSON.stringify(response));
  return run(repo, ['record-adjudication', '--criterion', id, '--response', file, '--by', 'operator', '--confirm']);
}

async function makeObservation(repo: string, url: string, head: string, body?: string): Promise<string> {
  const b = body ?? (await readFile(join(S(repo), 'pr-body.md'), 'utf8'));
  const path = join(aux(repo), 'remote-observation.json');
  await writeFile(path, JSON.stringify({ url, body: b, headRefOid: head, updatedAt: '2026-08-24T00:00:00Z' }));
  return path;
}

async function regenBody(repo: string): Promise<void> {
  const r = await execArgv(['node', PRSCRIPT, S(repo), '--repo', repo, '--title', 'test task'], { cwd: repo, timeoutMs: 30_000 });
  expect(r.exitCode).toBe(0);
}

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

/** Drive an adjudicated (accepted) task to the pending PR intent. */
async function toIntentWithAccepted(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>): Promise<string> {
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.stdout).toContain('gh pr create');
  return (await readTask(repo)).prIntent.headSha;
}

// ---------------------------------------------------------------------------
// post-GO adjudication → stale earned authority → migration

test('a post-GO adjudication makes the pending intent stale; direct record-pr refuses; record-pr-remote (absent) migrates through a fresh chain + review to an attested terminal', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  const head = await toIntentWithAccepted(repo, stub);
  const earned = (await readTask(repo)).reviewBase.adjudicationsSha;
  const callsAfterGo = await stub.calls();

  // the operator performs the check after all — satisfied flips the governing set
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);

  // the pending-intent gate STOPs with the migration commands and the exact hash
  const stopOut = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(stopOut.exitCode).toBe(2);
  expect(stopOut.stdout).toContain('the adjudication state changed after its earned diff review');
  const hash = stopOut.stdout.match(/--intent-hash ([0-9a-f]{64})/)?.[1] ?? '';
  expect(hash).toHaveLength(64);

  // a refreshed MATCHING body does not help — direct record-pr refuses on the digest
  await regenBody(repo);
  const obs = await makeObservation(repo, 'https://x.test/pr/1', head);
  const direct = await run(repo, ['record-pr', '--url', 'https://x.test/pr/1', '--remote-observation', obs]);
  expect(direct.exitCode).toBe(2);
  expect(direct.stdout).toContain('stale review basis');
  expect((await readTask(repo)).pr).toBeUndefined();

  // the relaxation — record-pr-remote accepts under a CURRENT approval with a stale digest
  const absent = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', hash, '--by', 'tester']);
  expect(absent.exitCode).toBe(0);
  expect((await readTask(repo)).prIntent).toBeUndefined();

  // migration: fresh chain + FRESH diff review (reviewer invoked, digest re-bound) → exactly one new intent
  const fresh = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(callsAfterGo + 1);
  const task = await readTask(repo);
  expect(task.prIntent.attempt).toBe(2);
  expect(task.reviewBase.adjudicationsSha).not.toBe(earned); // re-bound to the satisfied governing set
  expect(readdirSync(join(S(repo), 'reviews', 'superseded')).length).toBeGreaterThan(0);

  // attested terminality
  await regenBody(repo);
  const obs2 = await makeObservation(repo, 'https://x.test/pr/2', task.prIntent.headSha);
  const rec = await run(repo, ['record-pr', '--url', 'https://x.test/pr/2', '--remote-observation', obs2]);
  expect(rec.exitCode).toBe(0);
  expect((await readTask(repo)).pr.publication.bodySha).toHaveLength(64);
});

test(
  'G.49/G.63: the exists path — observedPr re-earns a fresh GO at the matching head, the observation matrix is enforced, terminal with zero creates; a head mismatch routes through record-pr-unusable',
  async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  const head = await toIntentWithAccepted(repo, stub);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  const stopOut = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const hash = stopOut.stdout.match(/--intent-hash ([0-9a-f]{64})/)?.[1] ?? '';
  const url = 'https://example.test/pr/7';
  expect((await run(repo, ['record-pr-remote', '--status', 'exists', '--url', url, '--intent-hash', hash, '--by', 'tester'])).exitCode).toBe(0);

  // fresh GO at the matching head → the requalified gate names the validated record-pr protocol
  const requal = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(requal.exitCode).toBe(2);
  expect(requal.stdout).toContain('freshly reviewed HEAD matches its head');
  expect(requal.stdout).toContain('--remote-observation');
  expect(requal.stdout).not.toContain('gh pr create');

  // the full wrong-URL/head/body matrix on the observedPr record-pr path
  await regenBody(repo);
  const wrongUrlObs = await makeObservation(repo, 'https://example.test/pr/999', head);
  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', wrongUrlObs])).exitCode).toBe(3);
  const wrongHeadObs = await makeObservation(repo, url, 'f'.repeat(40));
  expect((await run(repo, ['record-pr', '--url', url, '--remote-observation', wrongHeadObs])).exitCode).toBe(3);
  const wrongBodyObs = await makeObservation(repo, url, head, 'a body the projection never generated\n');
  const bodyRefusal = await run(repo, ['record-pr', '--url', url, '--remote-observation', wrongBodyObs]);
  expect(bodyRefusal.exitCode).toBe(3);
  expect(bodyRefusal.stderr).toContain('generated body sha256');
  const good = await makeObservation(repo, url, head);
  const terminal = await run(repo, ['record-pr', '--url', url, '--remote-observation', good]);
  expect(terminal.exitCode).toBe(0);
  expect(terminal.stdout).toContain('no create emitted');
  expect((await readTask(repo)).pr.publication.headRefOid).toBe(head);

  // head-mismatch variant: a second repo where HEAD moves past the observed head
  const repoB = await makeRepo();
  const stubB = await makeStubReviewer(repoB);
  await toIntentWithAccepted(repoB, stubB);
  expect((await adjudicate(repoB, 'C7', SAT)).exitCode).toBe(0);
  const stopB = await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli });
  const hashB = stopB.stdout.match(/--intent-hash ([0-9a-f]{64})/)?.[1] ?? '';
  expect((await run(repoB, ['record-pr-remote', '--status', 'exists', '--url', 'https://example.test/pr/8', '--intent-hash', hashB, '--by', 'tester'])).exitCode).toBe(0);
  await commitChange(repoB, 'drift');
  // the satisfied record is stale at the new HEAD; accepted governs — the gate passes, the chain re-earns
  const mismatch = await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli });
  expect(mismatch.exitCode).toBe(2);
  expect(mismatch.stdout).toContain('observed remote PR head mismatch');
  const intentHash = (await readTask(repoB)).observedPr.intentHash;
  expect((await run(repoB, ['record-pr-unusable', '--intent-hash', intentHash, '--by', 'tester'])).exitCode).toBe(0);
  const freshB = await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli });
  expect(freshB.exitCode).toBe(0);
  expect(freshB.stdout).toContain('gh pr create');
  expect((await readTask(repoB)).prIntent.attempt).toBe(2);
  // the fresh intent after the disposition terminalizes with the full attestation
  const headB2 = (await readTask(repoB)).prIntent.headSha;
  const obsB = await makeObservation(repoB, 'https://example.test/pr/80', headB2);
  const recB = await run(repoB, ['record-pr', '--url', 'https://example.test/pr/80', '--remote-observation', obsB]);
  expect(recB.exitCode).toBe(0);
  expect((await readTask(repoB)).pr.publication.bodySha).toHaveLength(64);
  },
  { timeout: 120_000 },
);

// ---------------------------------------------------------------------------
// the accepted fallback sequence, end to end

test('satisfied governs at HEAD A; at HEAD B the accepted record governs again automatically — the digest flips, the pending verdict quarantines, and the fresh review sees the ruling + residual', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // coexistence; satisfied governs at A
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-reviewer', { BEN_REVIEWER_CLI: stub.cli }); // pending diff verdict at A
  const digestAtA = (await readTask(repo)).reviewBase.adjudicationsSha;
  expect(existsSync(join(S(repo), 'reviews', 'diff-round-1-codex.json'))).toBe(true);

  await commitChange(repo, 'moves-to-head-b');
  const promptsBefore = (await stub.prompts()).length;
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('gh pr create'); // fresh chain + review at B completed
  const task = await readTask(repo);
  expect(task.reviewBase.adjudicationsSha).not.toBe(digestAtA); // the governing set flipped to accepted
  expect(readdirSync(join(S(repo), 'reviews', 'superseded')).length).toBeGreaterThan(0); // the A verdict quarantined
  // the fresh HEAD-B review's evidence carries the accepted ruling AND its residual
  const freshPrompts = (await stub.prompts()).slice(promptsBefore);
  expect(freshPrompts).toContain('the synthetic rendering gap is accepted');
  expect(freshPrompts).toContain('large-file rendering untested');
  // and the generated PR truth distinguishes the accepted state with its residual
  const body = await readFile(join(S(repo), 'pr-body.md'), 'utf8');
  expect(body).toContain('**ADJUDICATED accepted** by operator — unproven: large-file rendering untested');
});

// ---------------------------------------------------------------------------
// recorded-round replay bound to the surviving verdict

test('the legitimate crash-replay window is intact — verdict present + recorded dropped rows → GO replay, no fresh reviewer', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO_DROPPED);
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // rows recorded, GO never consumed
  const ledger = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  expect(ledger).toContain('auto-dropped');
  const calls = await stub.calls();

  const resume = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(resume.exitCode).toBe(0);
  expect(resume.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(calls); // the recorded round replayed — never re-reviewed
});

test('the laundering replay is dead — after quarantine the recorded dropped rows are historical and the round re-earns a fresh reviewer before any GO; duplicate round-N history stays consistent', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO_DROPPED);
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // dropped rows + verdict, GO unconsumed
  const calls = await stub.calls();

  // the adjudication flips the governing set — the earned context is superseded
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(calls + 1); // a FRESH reviewer invocation was required before any GO
  const task = await readTask(repo);
  expect((task.reviewWatermarks ?? []).filter((w: { kind: string; round: number }) => w.kind === 'diff' && w.round === 1).length).toBeGreaterThan(0);
  // two passes of round-1 rows are truthful append-only history
  const rows = (await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(rows.filter((e) => e.kind === 'diff' && e.round === 1 && e.action === 'auto-dropped')).toHaveLength(2);
  // ...that never rewrote the round counting (dropped rounds consume no tally)...
  expect(JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8')).diff ?? 0).toBe(0);
  // ...and the renderers show the historical pass to the fresh reviewer (renderLedger over both sets)
  expect(await stub.prompts()).toContain('[diff round 1] auto-dropped');
  // no raised rows exist, so the raised-without-resolution integrity guards stayed silent — the flow completed
});

test('quarantine → fresh CLEAN GO → SIGKILL after adjudication → the replay still reaches GO through the verdict-present path without re-invoking the reviewer', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // clean GO (zero rows), unconsumed
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // supersede → quarantine on the next derivation

  // the re-earn run: quarantine + fresh CLEAN GO — killed again right after its adjudication
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli });
  const calls = await stub.calls();
  const replay = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(calls); // idempotent re-adjudication of the surviving verdict — no new reviewer
});

test('a historical abstain cannot poison the re-earned round — post-quarantine it is structurally invisible and no gate fires', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond('I refuse to emit JSON today.');
  const abstain = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(abstain.exitCode).toBe(2); // abstain recorded, escalated
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('abstained'); // the recorded abstain gates while its pass is current

  // the adjudication supersedes the pass; the fresh round must NOT see the old abstain
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0);
  await stub.respond(GO);
  const fresh = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('gh pr create');
  expect(fresh.stdout).not.toContain('abstained');
  const ledger = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  expect(ledger).toContain('"abstain"'); // history never deleted — just invisible to replay
});

test('worktree-only invalidation after a recorded dropped-only GO forces quarantine + a fresh review', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO_DROPPED);
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli });

  await writeFile(join(repo, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n');
  const dirtyGo = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(dirtyGo.exitCode).toBe(0);
  expect(dirtyGo.stdout).toContain('changed after diff GO'); // the GO replay is refused terminal consumption
  expect((await readTask(repo)).reviewBase).toBeUndefined();

  await git(repo, 'checkout', '--', 'math.ts'); // the operator discards the stray edit
  const calls = await stub.calls();
  const fresh = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(calls + 1); // the round re-earned a fresh reviewer
});

test('a plan-kind dropped-only GO followed by an artifact revision keeps the existing STOP — no plan-side shortcut', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlanManual(repo);
  await stub.respond(GO_DROPPED);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD'); // dropped rows recorded, GO
  await appendFile(join(S(repo), 'plan.md'), 'revision after the recorded round\n');
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('plan artifacts were revised after plan round 1 was recorded in the ledger');
});

test('a REAL partial adjudication (raised row, no resolutions, no blockers.json) STOPs even pre-watermark — the integrity guards are unscoped, zero fresh reviewers', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-reviewer', { BEN_REVIEWER_CLI: stub.cli }); // pending verdict, nothing adjudicated
  // the audit's falsifier verbatim: ledger.mjs crashed after appending the raised
  // row, before the tally advance and blockers.json
  await appendFile(
    join(S(repo), 'ledger.jsonl'),
    `${JSON.stringify({ ts: 't', kind: 'diff', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: 'a'.repeat(64), action: 'raised', detail: 'partial write' })}\n`,
  );
  await commitChange(repo, 'head-moves'); // the quarantine path puts the raised row pre-watermark
  const calls = await stub.calls();
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('raised blockers for diff round 1');
  expect(r.stdout).toContain('partial ledger write');
  expect(await stub.calls()).toBe(calls); // NEVER a fresh reviewer over crash evidence
  expect((await readTask(repo)).reviewWatermarks?.length ?? 0).toBeGreaterThan(0); // the quarantine DID land first
});

test('SIGKILL between watermark and rename re-quarantines idempotently; an inert audit row appended between watermark and re-earn leaves the cutoff sound', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub, { extraManual: true });
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  expect((await adjudicate(repo, 'C8', ACC)).exitCode).toBe(0);
  await stub.respond(GO_DROPPED);
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // recorded dropped rows + verdict
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // supersede the earned digest

  // the quarantine crashes between the watermark write and the verdict rename
  await killAt(repo, ['next'], 'after-watermark', { BEN_REVIEWER_CLI: stub.cli });
  let task = await readTask(repo);
  expect(task.reviewWatermarks.filter((w: { kind: string; round: number }) => w.kind === 'diff' && w.round === 1)).toHaveLength(1);
  expect(existsSync(join(S(repo), 'reviews', 'diff-round-1-codex.json'))).toBe(true); // rename never happened

  // an inert audit row lands AFTER the watermark, before the re-earn
  expect((await adjudicate(repo, 'C8', SAT)).exitCode).toBe(0);

  const calls = await stub.calls();
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(calls + 1); // one fresh reviewer — the historical dropped rows stayed invisible
  task = await readTask(repo);
  expect(task.reviewWatermarks.filter((w: { kind: string; round: number }) => w.kind === 'diff' && w.round === 1)).toHaveLength(2); // a later watermark superseded
  expect(readdirSync(join(S(repo), 'reviews', 'superseded')).length).toBeGreaterThan(0);
});

test('malformed reviewWatermarks shapes STOP; the absent member stays legacy-valid', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  const good = await readTask(repo);
  const bads = [
    'not-an-array',
    [{ kind: 'nope', round: 1, ledgerLength: 0 }],
    [{ kind: 'diff', round: 0, ledgerLength: 0 }],
    [{ kind: 'diff', round: 1, ledgerLength: -1 }],
    [{}],
  ];
  for (const reviewWatermarks of bads) {
    await writeFile(join(S(repo), 'task.json'), JSON.stringify({ ...good, reviewWatermarks }, null, 2));
    const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('task.json does not match the sequencer schema');
  }
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(good, null, 2));
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // back at the manual gate — legacy shape valid
});

test('A→B→A revert after a completed HEAD-B review — governance flips back and every round re-earns; no stale round qualifies', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // satisfied governs at A
  const headA = await headOf(repo);
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // completed GO verdict at A, unconsumed
  const digestA = (await readTask(repo)).reviewBase.adjudicationsSha;

  await commitChange(repo, 'to-head-b');
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // completed HEAD-B review (accepted governs)
  const digestB = (await readTask(repo)).reviewBase.adjudicationsSha;
  expect(digestB).not.toBe(digestA);

  await git(repo, 'reset', '--hard', headA); // A→B→A: HEAD is byte- and sha-identical to A again
  const calls = await stub.calls();
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(calls + 1); // the B verdict never qualified at A — a fresh round was earned
  const task = await readTask(repo);
  expect(task.reviewBase.sha).toBe(headA);
  expect(task.reviewBase.adjudicationsSha).toBe(digestA); // satisfied governs again — the digest flipped back
});

// ---------------------------------------------------------------------------
// correction: proven literally,
// together, over one synthetic re-earn duplicate-history scenario

test('combined: over one re-earn duplicate round-N history — renderers, rejectedFingerprints, round counting, and the raised-without-resolution guards all behave', async () => {
  const LEDGER = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toManualGate(repo, stub);
  expect((await adjudicate(repo, 'C7', ACC)).exitCode).toBe(0);
  await stub.respond(GO_DROPPED);
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // pass 1: dropped rows + verdict, GO unconsumed
  const passOneCalls = await stub.calls();
  expect((await adjudicate(repo, 'C7', SAT)).exitCode).toBe(0); // supersede →  re-earn
  await killAt(repo, ['next'], 'after-adjudicate', { BEN_REVIEWER_CLI: stub.cli }); // pass 2 of round 1: the duplicate history
  const calls = await stub.calls();
  expect(calls).toBe(passOneCalls + 1); // the re-earn required a fresh reviewer

  // the history is the strict shape: two passes of round-1 rows, watermarked
  const rows = (await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(rows.filter((e) => e.kind === 'diff' && e.round === 1 && e.action === 'auto-dropped')).toHaveLength(2);
  expect(((await readTask(repo)).reviewWatermarks ?? []).filter((w: { kind: string; round: number }) => w.kind === 'diff' && w.round === 1).length).toBeGreaterThan(0);

  // 1. RENDERERS — literally AFTER the duplicates exist: a HEAD move
  // supersedes the earned context, and the re-earned reviewer is invoked over
  // the duplicated history — its ONE post-duplicate prompt renders BOTH
  // round-1 passes. pr.mjs renders the same history cleanly.
  await commitChange(repo, 'head-b');
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-reviewer', { BEN_REVIEWER_CLI: stub.cli }); // reviewer ran; nothing adjudicated
  const callsAfterRender = await stub.calls();
  expect(callsAfterRender).toBe(calls + 1); // a fresh reviewer WAS invoked post-duplicates
  const lastPrompt = (await stub.prompts()).split('===PROMPT-END===').filter((p) => p.trim() !== '').at(-1) ?? '';
  expect(lastPrompt.split('[diff round 1] auto-dropped').length - 1).toBe(2); // both duplicate rows in the SAME prompt
  const pr = await execArgv(['node', PRSCRIPT, S(repo), '--repo', repo, '--title', 'test task'], { cwd: repo, timeoutMs: 30_000 });
  expect(pr.exitCode).toBe(0);
  expect(pr.stdout).toContain('**ADJUDICATED accepted** by operator'); // satisfied is stale at HEAD B — accepted governs
  expect(pr.stdout.split('- **C7 — accepted**').length - 1).toBe(1); // never duplicated by the double pass

  // 2. ROUND COUNTING: two recorded passes of round 1 consumed zero tally
  expect(JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8')).diff ?? 0).toBe(0);

  // 3. rejectedFingerprints: on this same history, raised → rejected → byte-identical
  // re-raise still suppresses mechanically at the referee level
  const blocker = { id: 'B9', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' };
  const exec = (argv: string[]) => execArgv(argv, { cwd: repo, timeoutMs: 30_000 });
  await writeFile(join(S(repo), 'reviews', 'diff-extra-codex.json'), JSON.stringify({ verdict: 'NO_GO', blockers: [blocker] }));
  expect((await exec(['node', LEDGER, 'round', S(repo), '--kind', 'diff', '--verdict', 'codex=reviews/diff-extra-codex.json'])).exitCode).toBe(1);
  const open = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: open[0].fingerprint, action: 'rejected', detail: 'already proven' }]));
  expect((await exec(['node', LEDGER, 'resolve', S(repo), '--kind', 'diff'])).exitCode).toBe(0);
  await writeFile(join(S(repo), 'reviews', 'diff-extra2-codex.json'), JSON.stringify({ verdict: 'NO_GO', blockers: [blocker] }));
  expect((await exec(['node', LEDGER, 'round', S(repo), '--kind', 'diff', '--verdict', 'codex=reviews/diff-extra2-codex.json'])).exitCode).toBe(0); // suppressed → GO
  expect(await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).toContain('re-raise-dropped');
  expect(JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8')).diff).toBe(1); // exactly the one blocker-bearing round

  // 4. RAISED-WITHOUT-RESOLUTION GUARDS: a raised row with no resolution and no
  // blockers.json inside this duplicated history STOPs the sequencer — full
  // unscoped ledger, zero fresh reviewers
  await appendFile(
    join(S(repo), 'ledger.jsonl'),
    `${JSON.stringify({ ts: 't', kind: 'diff', round: 2, reviewer: 'codex', blockerId: 'B1', fingerprint: 'e'.repeat(64), action: 'raised', detail: 'partial write' })}\n`,
  );
  const guarded = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(guarded.exitCode).toBe(2);
  expect(guarded.stdout).toContain('partial ledger write');
  expect(await stub.calls()).toBe(callsAfterRender); // never a fresh reviewer over crash evidence
});
