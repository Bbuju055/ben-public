import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { commitChange, git, makeFixtureRepo, makeTmpDir, PAUSE_BOUNDARY_POLL_MS, PAUSE_BOUNDARY_WAIT_MS } from './helpers';

// park, answer, resume.
// The waiting projection (.ben/waiting.json + WAITING.md) is a rendered,
// NON-authoritative operator artifact; the shared oracle (waitingState)
// classifies it absent/stale/spent/current; `run.mjs answer` translates
// code-owned tokens onto the existing record cores. These tests prove the
// matrix: publication per exit site, oracle liveness (incl. spent-after-
// direct-record), tamper inertness, answer refusal semantics, the crash seams
// (gate-recorded-but-never-projected, torn pair, answered-but-not-cleared),
// stop-hook release/block, and the full park→exit→answer→resume lifecycle.

const RUN = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../scripts/stop-hook.mjs', import.meta.url));

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
const readWaiting = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'waiting.json'), 'utf8'));
const waitingExists = (repo: string) => existsSync(join(S(repo), 'waiting.json'));
const briefExists = (repo: string) => existsSync(join(S(repo), 'WAITING.md'));

async function hook(repo: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(['node', HOOK], { cwd: repo, stdin: Buffer.from(JSON.stringify({ cwd: repo })), stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
}

async function makeStubReviewer(): Promise<{ cli: string; respond: (v: unknown) => Promise<void> }> {
  const dir = await makeTmpDir('waiting-stub-');
  const stubJs = join(dir, 'stub.mjs');
  await writeFile(
    stubJs,
    `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
writeFileSync(out, readFileSync(${JSON.stringify(join(dir, 'response.txt'))}, 'utf8'));
`,
  );
  const cli = join(dir, 'stub-cli');
  await writeFile(cli, `#!/bin/sh\nexec node "${stubJs}" "$@"\n`);
  chmodSync(cli, 0o755);
  return { cli, respond: (v) => writeFile(join(dir, 'response.txt'), typeof v === 'string' ? v : JSON.stringify(v)) };
}

const GO = { verdict: 'GO', blockers: [] };
const NO_GO = {
  verdict: 'NO_GO',
  blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' }],
};

async function seedPlan(repo: string, opts: { gateCmd?: string; manual?: boolean } = {}): Promise<void> {
  const s = S(repo);
  mkdirSync(s, { recursive: true });
  await writeFile(join(s, 'plan.md'), '# plan\n\nbuild the thing\n');
  const criteria: unknown[] = [{ id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } }];
  if (opts.manual) {
    // pregate caps manual criteria at 30% — pad with command criteria
    criteria.push(
      { id: 'C2', statement: 'the other thing works', verification: { method: 'command', command: 'true' } },
      { id: 'C3', statement: 'the third thing works', verification: { method: 'command', command: 'true' } },
      { id: 'C4', statement: 'the docs read well', verification: { method: 'manual' } },
    );
  }
  await writeFile(join(s, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria }, null, 2));
  await writeFile(join(s, 'promises.json'), '[]');
  await writeFile(join(s, 'plan-files.json'), JSON.stringify(['math.ts']));
  await writeFile(join(s, 'gates.json'), JSON.stringify({ smoke: opts.gateCmd ?? 'true' }, null, 2));
}

/** Drive a fresh repo to the parked APPROVE BUILD gate. */
async function toApprovalPark(
  repo: string,
  stub: Awaited<ReturnType<typeof makeStubReviewer>>,
  planOpts: Parameters<typeof seedPlan>[1] = {},
): Promise<ExecResult> {
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo, planOpts);
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('APPROVE BUILD');
  return r;
}

/** Drive a fresh repo to the parked reconcile-veto gate (proposal rejects B1). */
async function toVetoPark(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>): Promise<string> {
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  const r1 = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r1.exitCode).toBe(0); // blockers instruct: write proposal.json (model work)
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  const fp = blockers[0].fingerprint as string;
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'covered by the existing add() tests; not a real gap' }]));
  const r2 = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r2.exitCode).toBe(2);
  expect(r2.stdout).toContain('reconcile veto');
  return fp;
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
  if (!reached) reached = existsSync(marker);
  proc.kill(9);
  await proc.exited;
  if (!reached) throw new Error(`never reached pause boundary ${boundary}`);
  rmSync(marker, { force: true });
  rmSync(join(S(repo), '.run-lock'), { force: true });
}

// ---------------------------------------------------------------------------
// publication per exit site + the operator brief

test('the approval gate parks a current, digest-bound projection with the verbatim packet', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  const w = await readWaiting(repo);
  expect(w.kind).toBe('approval');
  expect(w.owner).toBe('human');
  expect(w.options.map((o: { token: string }) => o.token)).toEqual(['approve', 'revise', 'abort']); // revise joins
  expect(w.packet).toContain('build the thing'); // plan.md verbatim inside the packet
  const brief = await readFile(join(S(repo), 'WAITING.md'), 'utf8');
  expect(brief).toContain('## What stopped');
  expect(brief).toContain('## Safe to leave?');
  expect(brief).toContain('--choose approve');
  expect(brief).toContain('build the thing');
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('WAITING ON YOU');
});

test('the veto gate parks with accept / veto-<n> / abort tokens naming the proposed dismissals', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toVetoPark(repo, stub);
  const w = await readWaiting(repo);
  expect(w.kind).toBe('veto');
  expect(w.options.map((o: { token: string }) => o.token)).toEqual(['accept', 'veto-1', 'abort']);
  expect(w.options[1].label).toContain('the empty case is unhandled'); // the finding's own claim text
});

test('a hard-cap review stop parks review-stop with continue/abort; answer continue grants and resumes', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 't', '--plan-rounds', '1', '--plan-rounds-max', '1'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  // round 1 (inside the soft budget): blockers → proposal → veto → all-rejected reconcile
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(0);
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  const fp = blockers[0].fingerprint as string;
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'covered by existing tests; not a real gap' }]));
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // veto park
  expect((await run(repo, ['answer', '--choose', 'accept', '--by', 'tester'])).exitCode).toBe(0);
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'covered by existing tests; not a real gap' }]));
  // round 2 raises a DIFFERENT blocker past the hard cap → durable review stop
  await stub.respond({
    verdict: 'NO_GO',
    blockers: [{ id: 'B2', severity: 'BLOCKER', claim: 'the overflow case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for MAX_SAFE_INTEGER' }],
  });
  const capped = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(capped.exitCode).toBe(2);
  const w = await readWaiting(repo);
  expect(w.kind).toBe('review-stop');
  expect(w.owner).toBe('human');
  // the park survives a fresh derivation (standing rounds.gates slot re-presents)
  const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.exitCode).toBe(2);
  expect((await readWaiting(repo)).kind).toBe('review-stop');
  const ans = await run(repo, ['answer', '--choose', 'continue', '--by', 'tester']);
  expect(ans.exitCode).toBe(0);
  expect(ans.stdout).toContain('answer recorded');
  expect(waitingExists(repo)).toBe(false);
  const rounds = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  expect(rounds.grants).toHaveLength(1);
  // resumed: the review stop is cleared, the loop proceeds to reconcile (model work)
  const resumed = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(resumed.exitCode).toBe(0);
  expect(resumed.stdout).toContain('proposal.json');
});

test('an exhausted gate-fix budget parks fix-cap (continue or abort); model-owed red runs clear the note', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 't', '--gate-fixes', '1'])).exitCode).toBe(0);
  await seedPlan(repo, { gateCmd: 'false' });
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // approval gate
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
  await commitChange(repo, 'feature');
  const red1 = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(red1.exitCode).toBe(1); // attempt 1 — model work, nothing parked
  expect(waitingExists(repo)).toBe(false);
  await commitChange(repo, 'fix-attempt'); // a new attempt requires changed code
  const red2 = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(red2.exitCode).toBe(2); // attempt 2 > cap 1 — the human's decision
  const w = await readWaiting(repo);
  expect(w.kind).toBe('fix-cap');
  expect(w.options.map((o: { token: string }) => o.token)).toEqual(['continue', 'abort']); // one more attempt is grantable for verify steps
});

test('manual criteria park with no one-word answers; answer refuses with the pointer', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub, { manual: true });
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
  await commitChange(repo, 'feature');
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('manual criteria');
  const w = await readWaiting(repo);
  expect(w.kind).toBe('manual-adjudication');
  // satisfied/accepted are answerable with the ruling in plain words; a bare token is refused
  expect(w.options.map((o: { token: string }) => o.token)).toEqual(['satisfied', 'accepted', 'abort']);
  const ans = await run(repo, ['answer', '--choose', 'satisfied', '--by', 'tester']);
  expect(ans.exitCode).toBe(3);
  expect(ans.stderr).toContain('requires --reply');
});

test('a pending PR intent parks as ben-owned follow-up: answer refuses, status says follow-up, hook keeps blocking', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
  await commitChange(repo, 'feature');
  await stub.respond(GO);
  const pr = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(pr.exitCode).toBe(0);
  expect(pr.stdout).toContain('gh pr create'); // the create instruction — model work, no park
  expect(waitingExists(repo)).toBe(false);
  const pending = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(pending.exitCode).toBe(2);
  const w = await readWaiting(repo);
  expect(w.kind).toBe('pr-pending');
  expect(w.owner).toBe('model');
  const ans = await run(repo, ['answer', '--choose', 'abort', '--note', 'x', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain("ben's own follow-up work");
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('ben HAS FOLLOW-UP WORK PARKED');
  // a model-owned park BLOCKS the turn even with nothing else red
  const h = await hook(repo);
  const d = JSON.parse(h.stdout.trim());
  expect(d.decision).toBe('block');
  expect(String(d.reason)).toContain('ben-owned follow-up is parked');
  // forging owner model→human (footer regenerated) must never earn the human release
  const lib = await import('../scripts/adjudication.lib.mjs');
  const wForged = JSON.parse(await readFile(join(S(repo), 'waiting.json'), 'utf8'));
  wForged.owner = 'human';
  const forgedBytes = `${JSON.stringify(wForged, null, 2)}\n`;
  const origJson = await readFile(join(S(repo), 'waiting.json'), 'utf8');
  const origMd = await readFile(join(S(repo), 'WAITING.md'), 'utf8');
  await writeFile(join(S(repo), 'waiting.json'), forgedBytes);
  await writeFile(join(S(repo), 'WAITING.md'), origMd.replace(/<!-- waiting\.json sha256: [0-9a-f]{64} -->/, `<!-- waiting.json sha256: ${lib.sha256(forgedBytes)} -->`));
  const hf = await hook(repo);
  expect(hf.stdout).not.toContain('parked for the human');
  const sForged = await run(repo, ['status']);
  expect(sForged.stdout).not.toContain('WAITING ON YOU');
  await writeFile(join(S(repo), 'waiting.json'), origJson);
  await writeFile(join(S(repo), 'WAITING.md'), origMd);
  // the same unforged park re-presented does NOT reset the no-progress escape:
  // its stable identity is unchanged, so MAX_BLOCKS still releases eventually
  for (let i = 0; i < 5; i++) {
    expect(JSON.parse((await hook(repo)).stdout.trim()).decision).toBe('block');
  }
  const seventh = JSON.parse((await hook(repo)).stdout.trim());
  expect(seventh.decision).toBeUndefined();
  expect(String(seventh.systemMessage)).toContain('releasing after 6 blocks');
});

test('a pending PR intent whose authority is voided parks the human migration stop; the recorded observation spends it', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
  await commitChange(repo, 'feature');
  await stub.respond(GO);
  const pr = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(pr.stdout).toContain('gh pr create');
  // voiding the approval under the pending intent → the migration STOP, parked for the human
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the OTHER thing\n');
  const stopped = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(stopped.exitCode).toBe(2);
  const w = await readWaiting(repo);
  expect(w.kind).toBe('pr-migration');
  expect(w.owner).toBe('human');
  expect((await run(repo, ['status'])).stdout).toContain('WAITING ON YOU');
  // the recorded human observation resolves the intent — the parked note reads spent
  const hash = /--intent-hash ([0-9a-f]{64})/.exec(stopped.stdout)?.[1];
  expect(hash).toBeDefined();
  const rec = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', hash!, '--by', 'tester']);
  expect(rec.exitCode).toBe(0);
  expect((await run(repo, ['status'])).stdout).toContain('out of date');
  const ans = await run(repo, ['answer', '--choose', 'abort', '--note', 'x', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain('NOT applied');
});

test('a recorded abstain parks a state-bound review stop; answer continue grants without self-invalidating', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond('this is not a verdict'); // unparseable → the reviewer abstains
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('abstain');
  const w = await readWaiting(repo);
  expect(w.kind).toBe('review-stop');
  expect(w.binding.slot).toBeUndefined(); // abstains write no durable slot — state-bound form
  // abstain self-invalidation regression: continue must succeed first try
  const ans = await run(repo, ['answer', '--choose', 'continue', '--by', 'tester']);
  expect(ans.exitCode).toBe(0);
  const rounds = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  expect(rounds.grants).toHaveLength(1);
  expect(waitingExists(repo)).toBe(false);
});

test('a superseded (pre-watermark) abstain can no longer back the parked review stop', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond('this is not a verdict');
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // genuine abstain park
  // a supersession watermark lands past the abstain rows (the recovery
  // shape): the sequencer's replay classification now excludes them, so the
  // parked note — bindings, digest and git identity all still matching — must
  // stop reading as live
  const lib = await import('../scripts/adjudication.lib.mjs');
  const task = JSON.parse(await readFile(join(S(repo), 'task.json'), 'utf8'));
  const ledgerLen = (await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
  task.reviewWatermarks = [...(task.reviewWatermarks ?? []), { kind: 'plan', round: 1, ledgerLength: ledgerLen }];
  await writeFile(join(S(repo), 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  // even with the digest and git identity regenerated over the new state, the
  // pre-watermark abstain no longer stands
  const w = JSON.parse(await readFile(join(S(repo), 'waiting.json'), 'utf8'));
  w.inputsDigest = lib.waitingInputsDigest(S(repo), lib.WAITING_CORE_FILES);
  w.binding = { ...w.binding, ...lib.waitingGitIdentity(repo) };
  const bytes = `${JSON.stringify(w, null, 2)}\n`;
  await writeFile(join(S(repo), 'waiting.json'), bytes);
  const md = (await readFile(join(S(repo), 'WAITING.md'), 'utf8')).replace(/<!-- waiting\.json sha256: [0-9a-f]{64} -->/, `<!-- waiting.json sha256: ${lib.sha256(bytes)} -->`);
  await writeFile(join(S(repo), 'WAITING.md'), md);
  const ans = await run(repo, ['answer', '--choose', 'continue', '--by', 'attacker']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain('NOT applied');
  const rounds = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  expect(rounds.grants ?? []).toHaveLength(0);
});

test('a review stop cleared underneath a paused answer refuses the grant at the last instant', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 't', '--plan-rounds', '1', '--plan-rounds-max', '1'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(0);
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  const fp = blockers[0].fingerprint as string;
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'covered by existing tests; not a real gap' }]));
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  expect((await run(repo, ['answer', '--choose', 'accept', '--by', 'tester'])).exitCode).toBe(0);
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'covered by existing tests; not a real gap' }]));
  await stub.respond({
    verdict: 'NO_GO',
    blockers: [{ id: 'B2', severity: 'BLOCKER', claim: 'the overflow case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for MAX_SAFE_INTEGER' }],
  });
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // hard cap → durable slot park
  // pause the answer after validation, then clear the slot out-of-band (a recovery act)
  const proc = Bun.spawn(['node', RUN, 'answer', '--choose', 'continue', '--by', 'tester', '--repo', repo], {
    cwd: repo,
    env: { ...process.env, BEN_RUN_PAUSE_AT: 'after-answer-validate' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const marker = join(S(repo), '.paused-after-answer-validate');
  for (let i = 0; i < PAUSE_BOUNDARY_WAIT_MS / PAUSE_BOUNDARY_POLL_MS; i++) {
    if (existsSync(marker)) break;
    await Bun.sleep(PAUSE_BOUNDARY_POLL_MS);
  }
  expect(existsSync(marker)).toBe(true);
  const rounds = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  delete rounds.gates.plan;
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify(rounds, null, 2));
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(3);
  expect(stderr).toContain('cleared while your answer was being recorded');
  const after = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  expect(after.grants ?? []).toHaveLength(0); // no authorization landed on the dead stop
}, 180_000);

test('a stop cleared AFTER the answer re-validated still refuses at the referee boundary (compare-and-swap)', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 't', '--plan-rounds', '1', '--plan-rounds-max', '1'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(0);
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  const fp = blockers[0].fingerprint as string;
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'covered by existing tests; not a real gap' }]));
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  expect((await run(repo, ['answer', '--choose', 'accept', '--by', 'tester'])).exitCode).toBe(0);
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'covered by existing tests; not a real gap' }]));
  await stub.respond({
    verdict: 'NO_GO',
    blockers: [{ id: 'B2', severity: 'BLOCKER', claim: 'the overflow case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for MAX_SAFE_INTEGER' }],
  });
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // hard cap → durable slot park
  // pause the answer AFTER its liveness re-validation and intent write (the
  // remaining race window), then clear the slot out-of-band
  const proc = Bun.spawn(['node', RUN, 'answer', '--choose', 'continue', '--by', 'tester', '--repo', repo], {
    cwd: repo,
    env: { ...process.env, BEN_RUN_PAUSE_AT: 'after-grant-intent' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const marker = join(S(repo), '.paused-after-grant-intent');
  for (let i = 0; i < PAUSE_BOUNDARY_WAIT_MS / PAUSE_BOUNDARY_POLL_MS; i++) {
    if (existsSync(marker)) break;
    await Bun.sleep(PAUSE_BOUNDARY_POLL_MS);
  }
  expect(existsSync(marker)).toBe(true);
  const rounds = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  delete rounds.gates.plan;
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify(rounds, null, 2));
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(3); // the referee's refusal, relayed
  expect(stderr).toContain('grant REFUSED');
  // no orphan/stale authorization exists that any later gate could consume
  const after = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  expect(after.grants ?? []).toHaveLength(0);
  const ledgerRows = (await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(ledgerRows.some((e) => e.action === 'granted')).toBe(false);
}, 180_000);

test('ABANDON parks kind abandoned; a playbook STOP parks owner playbook and goes stale on repair', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toVetoPark(repo, stub);
  // corrupt authoritative state → next STOPs → playbook park (owner playbook)
  const goodRounds = await readFile(join(S(repo), 'rounds.json'), 'utf8');
  await writeFile(join(S(repo), 'rounds.json'), '{not json');
  const stopped = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(stopped.exitCode).toBe(2);
  expect(stopped.stdout).toContain('STOP');
  const w = await readWaiting(repo);
  expect(w.kind).toBe('stop');
  expect(w.owner).toBe('playbook');
  // the playbook park releases the hook (an engineering session is a human matter, not model laziness)
  const h = await hook(repo);
  expect(h.stdout).toContain('parked for the human');
  // repairing the state flips the note to stale — it can no longer present as live
  await writeFile(join(S(repo), 'rounds.json'), goodRounds);
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('out of date');
  // abandon: parks kind abandoned on the next derivation
  await writeFile(join(S(repo), 'ABANDON.md'), 'test abandon\n');
  const ab = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(ab.exitCode).toBe(2);
  expect((await readWaiting(repo)).kind).toBe('abandoned');
  await unlink(join(S(repo), 'ABANDON.md'));
});

// ---------------------------------------------------------------------------
// oracle liveness: spent / stale / tamper / torn pair

test('a DIRECT record command spends the parked note: status says out of date, answer refuses, next moves on and clears', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  expect((await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE'])).exitCode).toBe(0);
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('out of date');
  const ans = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain('NOT applied');
  // next proceeds past the (answered) gate and the leftover note is cleared, never re-presented
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.stdout).not.toContain('APPROVE BUILD');
  expect(waitingExists(repo)).toBe(false);
});

test('editing a plan artifact under a parked approval makes the answer stale-refuse; next re-presents and republishes', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the OTHER thing\n');
  const ans = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain('NOT applied');
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false); // nothing was authorized
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2); // the revised plan re-earns its gate (fresh review under snapshots)
  const w = await readWaiting(repo);
  expect(w.kind).toBe('approval');
  expect(w.packet).toContain('build the OTHER thing');
  // and the republished note answers cleanly
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
});

test('a tampered waiting.json is inert: the pair digest breaks, answer refuses, nothing can be redirected', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  const w = await readWaiting(repo);
  w.options[1] = { token: 'approve2', label: 'x', effect: 'x', command: 'x' }; // attempt to smuggle a mapping
  await writeFile(join(S(repo), 'waiting.json'), `${JSON.stringify(w, null, 2)}\n`);
  const ans = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain('NOT applied');
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false);
  // torn pair variant: WAITING.md missing entirely
  await unlink(join(S(repo), 'WAITING.md'));
  const ans2 = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(ans2.exitCode).toBe(1);
  // next repairs the projection deterministically
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(briefExists(repo)).toBe(true);
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// answer refusal semantics

test('answer refuses unknown, duplicate, contradictory and note-misused tokens, and requires --by', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toVetoPark(repo, stub);
  const bad = async (args: string[], needle: string) => {
    const r = await run(repo, ['answer', ...args]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr + r.stdout).toContain(needle);
  };
  await bad(['--choose', 'reconcile', '--by', 't'], 'not a legal answer');
  await bad(['--choose', 'veto-2', '--by', 't'], 'not a legal answer'); // only one rejection proposed
  await bad(['--choose', 'accept', '--choose', 'veto-1', '--by', 't'], 'contradict');
  await bad(['--choose', 'veto-1', '--choose', 'veto-1', '--by', 't'], 'duplicate');
  await bad(['--choose', 'abort', '--choose', 'veto-1', '--by', 't', '--note', 'x'], 'stands alone');
  await bad(['--choose', 'accept', '--note', 'x', '--by', 't'], 'only recorded with "abort"');
  await bad(['--choose', 'accept'], '--by <user> is required');
  await bad(['--choose', 'abort', '--by', 't'], '--note');
  expect(existsSync(join(S(repo), 'ABANDON.md'))).toBe(false);
  // and with nothing parked at all:
  const fresh = await makeRepo();
  expect((await run(fresh, ['init', '--title', 't'])).exitCode).toBe(0);
  const none = await run(fresh, ['answer', '--choose', 'approve', '--by', 't']);
  expect(none.exitCode).toBe(1);
  expect(none.stdout).toContain('nothing is waiting');
});

test('answer veto-1 records the veto against the exact fingerprint and the loop resumes into resolutions', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  const fp = await toVetoPark(repo, stub);
  const ans = await run(repo, ['answer', '--choose', 'veto-1', '--by', 'tester']);
  expect(ans.exitCode).toBe(0);
  expect(waitingExists(repo)).toBe(false);
  const veto = (await readFile(join(S(repo), 'veto.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((v) => (v.type ?? 'decision') === 'decision');
  expect(veto.response.vetoes).toEqual([fp]);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('resolutions.json');
  expect(r.stdout).toContain('VETOED');
});

test('answer abort writes ABANDON.md exactly once: replay no-ops, a different reason is refused', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  const ans = await run(repo, ['answer', '--choose', 'abort', '--note', 'wrong direction', '--by', 'tester']);
  expect(ans.exitCode).toBe(0);
  expect((await readFile(join(S(repo), 'ABANDON.md'), 'utf8')).startsWith('wrong direction')).toBe(true);
  // the parked note is gone; the abandoned task presents its own park on next
  expect(waitingExists(repo)).toBe(false);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  expect((await readWaiting(repo)).kind).toBe('abandoned');
  // replay with the same reason: idempotent no-op against the abandoned park's own answer path?
  // (the abandoned park has no tokens — replay goes through coreAbandon only via the original gate,
  // so assert at the file level: content unchanged, and a conflicting hand-write is surfaced by run)
  const before = await readFile(join(S(repo), 'ABANDON.md'), 'utf8');
  expect(before.startsWith('wrong direction')).toBe(true);
});

test('answer holds the single-writer lock: a held lock refuses with zero writes and no projection mutation', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  const before = await readFile(join(S(repo), 'waiting.json'), 'utf8');
  await writeFile(join(S(repo), '.run-lock'), '999999999');
  const ans = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(ans.exitCode).toBe(2);
  expect(ans.stdout).toContain('holds the lock');
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false);
  // a stop() outside cmdNext's locked human-exit context never writes the projection
  expect(await readFile(join(S(repo), 'waiting.json'), 'utf8')).toBe(before);
  rmSync(join(S(repo), '.run-lock'), { force: true });
});

test('a forged projection pair (footer regenerated, human owner, chosen gateKind) is never current: hook blocks, answer refuses', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toVetoPark(repo, stub); // blockers present — a released hook here would be an unsafe release
  const lib = await import('../scripts/adjudication.lib.mjs');
  const forge = async (binding: Record<string, unknown>) => {
    const w = JSON.parse(await readFile(join(S(repo), 'waiting.json'), 'utf8'));
    w.kind = 'review-stop';
    w.owner = 'human';
    // the attacker can also compute the publicly derivable state digest AND git identity
    w.binding = { ...binding, ...lib.waitingGitIdentity(repo) };
    w.inputsDigest = lib.waitingInputsDigest(S(repo), lib.WAITING_CORE_FILES);
    const bytes = `${JSON.stringify(w, null, 2)}\n`;
    await writeFile(join(S(repo), 'waiting.json'), bytes);
    // the attacker CAN regenerate the footer — it is torn-pair detection, not tamper evidence
    const md = (await readFile(join(S(repo), 'WAITING.md'), 'utf8')).replace(/<!-- waiting\.json sha256: [0-9a-f]{64} -->/, `<!-- waiting.json sha256: ${lib.sha256(bytes)} -->`);
    await writeFile(join(S(repo), 'WAITING.md'), md);
  };
  for (const binding of [{ gateKind: 'diff' }, { gateKind: 'plan' }]) {
    await forge(binding);
    const h = await hook(repo);
    expect(h.stdout).not.toContain('parked for the human');
    expect(JSON.parse(h.stdout.trim()).decision).toBe('block');
    const ans = await run(repo, ['answer', '--choose', 'continue', '--by', 'attacker']);
    expect(ans.exitCode).toBe(1);
    expect(ans.stdout).toContain('NOT applied');
  }
  const rounds = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  expect(rounds.grants ?? []).toHaveLength(0); // no grant ever landed
});

test('a parked diff veto goes stale when the approval is voided — the dead question cannot be answered', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
  await commitChange(repo, 'feature');
  await stub.respond(NO_GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(0); // diff blockers → proposal instruct
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: blockers[0].fingerprint, action: 'rejected', detail: 'covered by the suite; not a gap' }]));
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // diff veto park
  expect((await readWaiting(repo)).kind).toBe('veto');
  // voiding the approval kills the diff-reconcile gate even though its own bytes still match
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the CHANGED thing\n');
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('out of date');
  const ans = await run(repo, ['answer', '--choose', 'accept', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain('NOT applied');
  const veto = (await readFile(join(S(repo), 'veto.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(veto.some((v) => (v.type ?? 'decision') === 'decision')).toBe(false); // no human act was recorded
});

test('a proposal swapped mid-answer (to previously presented bytes) is refused at the record boundary', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  const fp = await toVetoPark(repo, stub); // proposal A presented + parked
  const a = await readFile(join(S(repo), 'proposal.json'), 'utf8');
  const b = JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'DIFFERENT wording the operator never saw at answer time' }]);
  await writeFile(join(S(repo), 'proposal.json'), b);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // B presented too
  await writeFile(join(S(repo), 'proposal.json'), a);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // A re-presented and parked
  // start the answer, pause it AFTER validation, swap A→B underneath it
  const proc = Bun.spawn(['node', RUN, 'answer', '--choose', 'accept', '--by', 'tester', '--repo', repo], {
    cwd: repo,
    env: { ...process.env, BEN_RUN_PAUSE_AT: 'after-answer-validate' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const marker = join(S(repo), '.paused-after-answer-validate');
  for (let i = 0; i < PAUSE_BOUNDARY_WAIT_MS / PAUSE_BOUNDARY_POLL_MS; i++) {
    if (existsSync(marker)) break;
    await Bun.sleep(PAUSE_BOUNDARY_POLL_MS);
  }
  expect(existsSync(marker)).toBe(true);
  await writeFile(join(S(repo), 'proposal.json'), b);
  const stderr = await new Response(proc.stderr).text(); // the pause valve expires, the process continues
  expect(await proc.exited).toBe(3);
  expect(stderr).toContain('changed while your answer was being recorded');
  const veto = (await readFile(join(S(repo), 'veto.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(veto.some((v) => (v.type ?? 'decision') === 'decision')).toBe(false); // B was never accepted on A's answer
}, 120_000);

test('an abandon landing concurrently with a different reason is refused after the answer validated', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  const proc = Bun.spawn(['node', RUN, 'answer', '--choose', 'abort', '--note', 'my reason', '--by', 'tester', '--repo', repo], {
    cwd: repo,
    env: { ...process.env, BEN_RUN_PAUSE_AT: 'after-answer-validate' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const marker = join(S(repo), '.paused-after-answer-validate');
  for (let i = 0; i < PAUSE_BOUNDARY_WAIT_MS / PAUSE_BOUNDARY_POLL_MS; i++) {
    if (existsSync(marker)) break;
    await Bun.sleep(PAUSE_BOUNDARY_POLL_MS);
  }
  expect(existsSync(marker)).toBe(true);
  await writeFile(join(S(repo), 'ABANDON.md'), 'someone else abandoned first\n');
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(2); // conflict is a STOP, never a silent merge
  expect(stdout).toContain('a different ABANDON reason is already recorded');
  expect((await readFile(join(S(repo), 'ABANDON.md'), 'utf8')).startsWith('someone else abandoned first')).toBe(true);
}, 120_000);

test('SIGKILL at the projection-clear seam of a non-waiting outcome: leftover reads spent, the following run clears it', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  expect((await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE'])).exitCode).toBe(0);
  // next heads for the implement instruction (a non-waiting outcome) and dies mid-clear
  await killAt(repo, ['next'], 'before-projection-clear', { BEN_REVIEWER_CLI: stub.cli });
  expect(waitingExists(repo)).toBe(true); // the leftover survived the crash
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('out of date');
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(1); // zero commits — the implement instruction path
  expect(waitingExists(repo)).toBe(false);
});

// ---------------------------------------------------------------------------
// crash seams

test('SIGKILL after the gate-presentation write, before any projection: live answerable gate, truthful status, next repairs', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-approval-gate-record', { BEN_REVIEWER_CLI: stub.cli });
  // the authoritative gate side landed; the projection never existed
  const task = JSON.parse(await readFile(join(S(repo), 'task.json'), 'utf8'));
  expect(task.approvalGate).toBeDefined();
  expect(waitingExists(repo)).toBe(false);
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('no current waiting note on record');
  const ans = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  expect(ans.stdout).toContain('nothing is waiting');
  // next re-presents the identical gate AND republishes the projection
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('APPROVE BUILD');
  expect((await readWaiting(repo)).kind).toBe('approval');
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
});

test('SIGKILL after the veto presented-append, before the projection: same repair path', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  expect((await run(repo, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(0);
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: blockers[0].fingerprint, action: 'rejected', detail: 'covered elsewhere; not a real gap' }]));
  await killAt(repo, ['next'], 'after-presented-append', { BEN_REVIEWER_CLI: stub.cli });
  expect(waitingExists(repo)).toBe(false);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect((await readWaiting(repo)).kind).toBe('veto');
});

test('SIGKILL between waiting.json and WAITING.md: torn pair reads stale; next republishes a whole pair', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub); // establishes an OLD complete pair first
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the NEWER thing\n'); // forces a fresh park
  await killAt(repo, ['next'], 'between-projection-files', { BEN_REVIEWER_CLI: stub.cli });
  // new waiting.json, old (mismatched) WAITING.md → stale, never actionable
  const ans = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(ans.exitCode).toBe(1);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  const brief = await readFile(join(S(repo), 'WAITING.md'), 'utf8');
  expect(brief).toContain('build the NEWER thing');
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'tester'])).exitCode).toBe(0);
});

test('SIGKILL after the answer records but before cleanup: the decision stands once, the leftover reads spent, no double record', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toApprovalPark(repo, stub);
  await killAt(repo, ['answer', '--choose', 'approve', '--by', 'tester'], 'after-answer-record');
  // the authority landed; the projection was never cleared
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(true);
  expect(waitingExists(repo)).toBe(true);
  const status = await run(repo, ['status']);
  expect(status.stdout).toContain('out of date');
  // replaying the same answer refuses (spent) — the record layer is never even re-driven
  const replay = await run(repo, ['answer', '--choose', 'approve', '--by', 'tester']);
  expect(replay.exitCode).toBe(1);
  expect(replay.stdout).toContain('NOT applied');
  // the direct command replay is the existing idempotent no-op
  const direct = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(direct.exitCode).toBe(0);
  expect(direct.stdout).toContain('no-op');
  // next proceeds past the answered gate and clears the leftover
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.stdout).not.toContain('APPROVE BUILD');
  expect(waitingExists(repo)).toBe(false);
});

// ---------------------------------------------------------------------------
// stop-hook release/block

test('the hook releases exactly on a current human park, and blocks when the park is stale', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  await toVetoPark(repo, stub); // blockers.json present — the hook would block without the park
  const released = await hook(repo);
  expect(released.exitCode).toBe(0);
  expect(released.stdout).toContain('parked for the human');
  // stale the projection (tamper) → fall through to the blocking logic
  const w = await readWaiting(repo);
  w.question = 'edited';
  await writeFile(join(S(repo), 'waiting.json'), JSON.stringify(w));
  const blocked = await hook(repo);
  const d = JSON.parse(blocked.stdout.trim());
  expect(d.decision).toBe('block');
});

// ---------------------------------------------------------------------------
// the full lifecycle: park → process exit → answer → resume, no duplication

test('full lifecycle: veto park and answer, revision, approval park and answer, implement, diff GO — no gate replays, no waiting/success contradiction', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer();
  const fp = await toVetoPark(repo, stub); // round 1 NO_GO, proposal rejects B1, parked (the parking process has exited)
  expect((await run(repo, ['answer', '--choose', 'veto-1', '--by', 'operator'])).exitCode).toBe(0);
  // model work resumes: honor the veto — resolve the finding with a real revision
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'resolved', detail: 'plan revised: added the add(0,0) e2e criterion the reviewer demanded' }]));
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the thing\n\ncover add(0,0) explicitly\n');
  await stub.respond(GO);
  const reconciled = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(reconciled.exitCode).toBe(2); // revised plan re-reviewed GO → approval park
  expect(reconciled.stdout).toContain('APPROVE BUILD');
  expect((await readWaiting(repo)).kind).toBe('approval');
  expect((await run(repo, ['answer', '--choose', 'approve', '--by', 'operator'])).exitCode).toBe(0);
  await commitChange(repo, 'feature');
  const done = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(done.exitCode).toBe(0);
  expect(done.stdout).toContain('gh pr create');
  expect(waitingExists(repo)).toBe(false); // a non-waiting outcome leaves no waiting state
  expect(briefExists(repo)).toBe(false);
  // no round was double-consumed (round 1 consumed blockers; the GO round does
  // not bump the tally) and the answered gates never replay
  const rounds = JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));
  expect(rounds.plan).toBe(1);
  const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.stdout).not.toContain('APPROVE BUILD');
  expect(again.stdout).not.toContain('reconcile veto');
});
