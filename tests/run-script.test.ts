import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { commitChange, git, makeFixtureRepo, makeTmpDir, PAUSE_BOUNDARY_POLL_MS, PAUSE_BOUNDARY_WAIT_MS } from './helpers';

// scripts/run.mjs — the ben sequencer.
// Code owns sequencing; the referees own truth. These tests prove the
// transition table, idempotency at every completed boundary, the proposal-before-
// proposal/veto ordering, tally-bound verify intents, the PR
// intent/retry protocol, crash/kill recovery (pause seam),
// concurrency, torn records, adoption, and seam inertness.

const RUN = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));

/** A fixture repo with .ben/ gitignored (references/start.md) BEFORE the baseline. */
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
const readRounds = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'rounds.json'), 'utf8'));

/** A stand-in reviewer CLI whose verdict is whatever response.txt holds. */
async function makeStubReviewer(repo: string): Promise<{ cli: string; respond: (v: unknown) => Promise<void>; calls: () => Promise<number> }> {
  const dir = await makeTmpDir('run-stub-');
  const stubJs = join(dir, 'stub.mjs');
  await writeFile(
    stubJs,
    `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, 'call\\n');
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
  };
}

const GO = { verdict: 'GO', blockers: [] };
const NO_GO = {
  verdict: 'NO_GO',
  blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' }],
};

/** Admissible plan artifacts (gates/criteria commands are instant no-ops). */
async function seedPlan(repo: string, opts: { criteriaCmd?: string; gateCmd?: string } = {}): Promise<void> {
  const s = S(repo);
  mkdirSync(s, { recursive: true });
  await writeFile(join(s, 'plan.md'), '# plan\n\nbuild the thing\n');
  await writeFile(
    join(s, 'criteria.json'),
    JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 'the thing works', verification: { method: 'command', command: opts.criteriaCmd ?? 'true' } }] }, null, 2),
  );
  await writeFile(join(s, 'promises.json'), '[]');
  await writeFile(join(s, 'plan-files.json'), JSON.stringify(['math.ts']));
  await writeFile(join(s, 'gates.json'), JSON.stringify({ smoke: opts.gateCmd ?? 'true' }, null, 2));
}

/** Drive a fresh repo to the APPROVE BUILD gate with a GO-scripted reviewer. */
async function toApprovalGate(
  repo: string,
  stub: Awaited<ReturnType<typeof makeStubReviewer>>,
  planOpts: Parameters<typeof seedPlan>[1] = {},
): Promise<ExecResult> {
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo, planOpts);
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.stdout).toContain('APPROVE BUILD');
  expect(r.exitCode).toBe(2);
  return r;
}

async function approve(repo: string): Promise<void> {
  const r = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(r.exitCode).toBe(0);
}

/** Drive an approved repo through implement + verify + diff GO to the PR intent. */
async function toPrIntent(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>): Promise<ExecResult> {
  await commitChange(repo, 'feature');
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.stdout).toContain('gh pr create');
  expect(r.stdout).toContain("--title 'test task'"); // data is single-quoted, never shell syntax
  expect(r.exitCode).toBe(0);
  return r;
}

/** The operator's recorded remote observation: body defaults to the generated pr-body.md. */
async function makeObservation(repo: string, url: string, head: string, body?: string): Promise<string> {
  const b = body ?? (await readFile(join(S(repo), 'pr-body.md'), 'utf8'));
  const path = join(repo, 'remote-observation.json');
  await writeFile(path, JSON.stringify({ url, body: b, headRefOid: head, updatedAt: '2026-08-24T00:00:00Z' }));
  return path;
}

/** Regenerate pr-body.md from the current state (the operator's pre-record step on migration paths). */
async function regenBody(repo: string, title = 'test task'): Promise<void> {
  const PR = fileURLToPath(new URL('../scripts/pr.mjs', import.meta.url));
  const r = await execArgv(['node', PR, S(repo), '--repo', repo, '--title', title], { cwd: repo, timeoutMs: 30_000 });
  expect(r.exitCode).toBe(0);
}

/** Spawn run.mjs paused at a named boundary, SIGKILL it there, clean the lock (the playbook's human act). */
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
  rmSync(join(S(repo), '.run-lock'), { force: true }); // SIGKILL cannot release the lock; a human deletes it per the playbook
}

// ---------------------------------------------------------------------------
// init / identity / terminal states

test('init records base+repo identity; re-init and stale non-empty dirs are refused', async () => {
  const repo = await makeRepo();
  const r = await run(repo, ['init', '--title', 't']);
  expect(r.exitCode).toBe(0);
  const task = await readTask(repo);
  expect(task.base).toHaveLength(40);
  expect(task.repo.rootCommit).toHaveLength(40);
  expect(task.sequencerVersion).toBe(1);

  const again = await run(repo, ['init']);
  expect(again.exitCode).toBe(2);
  expect(again.stdout).toContain('task.json already exists');

  const repo2 = await makeRepo();
  mkdirSync(S(repo2), { recursive: true });
  await writeFile(join(S(repo2), 'plan.md'), 'leftover\n');
  const refused = await run(repo2, ['init']);
  expect(refused.exitCode).toBe(2);
  expect(refused.stdout).toContain('adopt');
});

test('next without a task points to init; with pre-sequencer state it STOPs toward adopt', async () => {
  const repo = await makeRepo();
  const fresh = await run(repo, ['next']);
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('run.mjs init');

  await writeFile(join(S(repo), 'plan.md'), 'pre-sequencer\n');
  const stale = await run(repo, ['next']);
  expect(stale.exitCode).toBe(2);
  expect(stale.stdout).toContain('adopt');
});

test('ABANDON.md is terminal; a foreign repo identity STOPs', async () => {
  const repo = await makeRepo();
  await run(repo, ['init']);
  await writeFile(join(S(repo), 'ABANDON.md'), 'out of scope after all\n');
  const r = await run(repo, ['next']);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('ABANDONED');
  expect(r.stdout).toContain('out of scope after all');
  rmSync(join(S(repo), 'ABANDON.md'));

  const task = await readTask(repo);
  task.repo.rootCommit = 'f'.repeat(40);
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));
  const foreign = await run(repo, ['next']);
  expect(foreign.exitCode).toBe(2);
  expect(foreign.stdout).toContain('not the one the task is bound to');
});

test('malformed task.json and a torn ledger line both STOP, naming the file', async () => {
  const repo = await makeRepo();
  await run(repo, ['init']);
  await writeFile(join(S(repo), 'task.json'), '{ torn');
  const r = await run(repo, ['next']);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('task.json');

  const repo2 = await makeRepo();
  await run(repo2, ['init']);
  await seedPlan(repo2);
  await appendFile(join(S(repo2), 'ledger.jsonl'), '{"kind":"plan","round":1,"acti\n');
  const torn = await run(repo2, ['next']);
  expect(torn.exitCode).toBe(2);
  expect(torn.stdout).toContain('ledger.jsonl');
});

// ---------------------------------------------------------------------------
// plan phase: artifacts → pregate → snapshot → review → approval

test('the plan chain: missing artifacts instruct, blank plan.md is rejected, GO review lands at the approval gate', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init', '--title', 'test task']);

  const noPlan = await run(repo, ['next']);
  expect(noPlan.exitCode).toBe(0);
  expect(noPlan.stdout).toContain('Write the plan artifacts');

  await seedPlan(repo);
  await writeFile(join(S(repo), 'plan.md'), '   \n');
  const blank = await run(repo, ['next']);
  expect(blank.exitCode).toBe(0);
  expect(blank.stdout).toContain('Write the plan artifacts');

  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the thing\n');
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  // the packet is the complete artifact, verbatim, before options
  expect(r.stdout).toContain('APPROVE BUILD');
  expect(r.stdout).toContain('build the thing');
  expect(r.stdout).toContain('the thing works');
  // snapshots were taken mechanically
  expect(existsSync(join(S(repo), 'plan.reviewed.md'))).toBe(true);
  expect(await stub.calls()).toBe(1);

  // idempotency: a second next at this boundary re-presents without re-reviewing
  const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.exitCode).toBe(2);
  expect(again.stdout).toContain('APPROVE BUILD');
  expect(await stub.calls()).toBe(1); // verdict exists — the reviewer is never re-invoked
});

test('a task without gates.json cannot reach APPROVE BUILD — it is instructed at the plan step', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init', '--title', 'test task']);
  await seedPlan(repo);
  rmSync(join(S(repo), 'gates.json'));
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('Write the plan artifacts');
  expect(r.stdout).toContain('gates.json');
  expect(r.stdout).not.toContain('APPROVE BUILD');
  expect(await stub.calls()).toBe(0); // review never ran, let alone approval
});

test('an inadmissible plan relays pregate verbatim and does not reach review', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await writeFile(join(S(repo), 'promises.json'), JSON.stringify([{ promise: 'unpinned', criterionRef: 'C9' }]));
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('Pregate failed');
  expect(await stub.calls()).toBe(0);
});

test('approval binds all five artifact hashes plus the canonical config member; duplicates no-op; a post-approval edit re-presents the gate', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  const approval = JSON.parse(await readFile(join(S(repo), 'approval.json'), 'utf8'));
  expect(Object.keys(approval.sha256).sort()).toEqual(['config', 'criteria.json', 'gates.json', 'plan-files.json', 'plan.md', 'promises.json']);

  const dupe = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(dupe.exitCode).toBe(0);
  expect(dupe.stdout).toContain('no-op');

  // implementation is now instructed (no commits yet) — the referee's words, verbatim
  const impl = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(impl.exitCode).toBe(1);
  expect(impl.stdout).toContain('No commits');

  // an edited plan silently voids the approval: the gate re-presents, nothing advances
  await appendFile(join(S(repo), 'plan.md'), 'sneaky edit\n');
  const represent = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(represent.exitCode).toBe(2);
  expect(represent.stdout).toContain('APPROVE BUILD');
});

test('RECONCILE at the approval gate: the revision supersedes the GO verdict (quarantined, never deleted) and re-reviews', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  const rec = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'RECONCILE']);
  expect(rec.exitCode).toBe(0);
  await appendFile(join(S(repo), 'plan.md'), '\nrevised after reconcile\n');
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('verdict quarantined');
  expect(r.stdout).toContain('APPROVE BUILD'); // fresh GO on the revised bytes
  expect(readdirSync(join(S(repo), 'reviews', 'superseded'))).toHaveLength(1);
  expect(await stub.calls()).toBe(2);
});

test('C9 row: snapshots already equal and no verdict resumes straight into the reviewer', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  // crash-constructed state: snapshots copied, reviewer never ran
  for (const [src, snap] of [
    ['plan.md', 'plan.reviewed.md'],
    ['criteria.json', 'criteria.reviewed.json'],
    ['promises.json', 'promises.reviewed.json'],
  ] as const) {
    await writeFile(join(S(repo), snap), await readFile(join(S(repo), src), 'utf8'));
  }
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('APPROVE BUILD');
  expect(await stub.calls()).toBe(1);
});

test('an all-abstain round is a recorded human gate, not corruption — and re-running next does not re-adjudicate it', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await stub.respond('I refuse to emit JSON today.');
  const first = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(first.exitCode).toBe(2);
  expect(first.stdout).toContain('abstained');

  const resume = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(resume.exitCode).toBe(2);
  expect(resume.stdout).toContain('abstained');
  const ledger = (await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean);
  expect(ledger).toHaveLength(1); // recorded exactly once — reading the referee's record, never re-appending
});

// ---------------------------------------------------------------------------
// reconcile: proposal before veto before resolutions before referees

test('premature resolutions are refused: a premature resolutions.json advances nothing until proposal + recorded veto exist and match', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  const r1 = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r1.exitCode).toBe(0);
  expect(r1.stdout).toContain('proposal.json');
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  const fp = blockers[0].fingerprint;

  // the near-miss: a schema-valid placeholder resolutions file written early
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'placeholder' }]));
  const premature = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(premature.exitCode).toBe(0); // still instructs the proposal — nothing consumed the placeholder
  expect(premature.stdout).toContain('proposal.json');
  expect(existsSync(join(S(repo), 'blockers.json'))).toBe(true); // blockers still open

  // invalid proposal: blank detail is a placeholder, structurally rejected
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: '   ' }]));
  const blankDetail = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(blankDetail.exitCode).toBe(1);
  expect(blankDetail.stdout).toContain('detail');

  // valid proposal with a rejection → the veto gate presents it
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'rejected', detail: 'C1 already proves this via the zero-operand test' }]));
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('HUMAN GATE — reconcile veto');
  expect(gate.stdout).toContain('Proposed REJECTIONS');
  expect(gate.stdout).toContain(fp);

  // the human vetoes the rejection
  await writeFile(join(repo, 'response.json'), JSON.stringify({ vetoes: [fp] }));
  const veto = await run(repo, ['record-veto', '--response', join(repo, 'response.json')]);
  expect(veto.exitCode).toBe(0);

  // duplicate veto: no-op; conflicting veto for the same bytes: STOP
  const dupe = await run(repo, ['record-veto', '--response', join(repo, 'response.json')]);
  expect(dupe.stdout).toContain('no-op');
  await writeFile(join(repo, 'confirm.json'), JSON.stringify({ decision: 'confirm' }));
  const conflict = await run(repo, ['record-veto', '--response', join(repo, 'confirm.json')]);
  expect(conflict.exitCode).toBe(2);
  expect(conflict.stdout).toContain('different veto decision');

  // the stale placeholder still rejects the vetoed fingerprint → structurally refused
  const mismatch = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(mismatch.exitCode).toBe(1);
  expect(mismatch.stdout).toContain('vetoed');

  // honest resolution: resolve it, change the plan, honesty accepts, chain re-reviews → GO → approval gate
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'resolved', detail: 'added the zero-operand criterion command' }]));
  await appendFile(join(S(repo), 'plan.md'), '\nhandle the empty case explicitly\n');
  await stub.respond(GO);
  const done = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(done.exitCode).toBe(2);
  expect(done.stdout).toContain('APPROVE BUILD');
  expect(existsSync(join(S(repo), 'blockers.json'))).toBe(false);
  expect(existsSync(join(S(repo), 'resolutions.json'))).toBe(false); // spent alongside the proposal
  const ledger = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  expect(ledger).toContain('"resolved"');
});

test('empty-veto policy: a zero-rejection, unflagged proposal skips the veto gate with a recorded policy decision; a proposed rejection still interrupts', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: blockers[0].fingerprint, action: 'resolved', detail: 'will add the missing test' }]));
  const skipped = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(skipped.exitCode).toBe(0);
  expect(skipped.stdout).toContain('skipped by the D3 policy');
  const decisions = (await readFile(join(S(repo), 'veto.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  expect(decisions.find((d) => d.type === 'decision')).toMatchObject({ response: { decision: 'confirm' }, by: 'ben-policy:empty-veto' });
  // a proposal that REJECTS keeps the human gate (a dismissal requires a human decision)
  const repo2 = await makeRepo();
  const stub2 = await makeStubReviewer(repo2);
  await run(repo2, ['init']);
  await seedPlan(repo2);
  await stub2.respond(NO_GO);
  await run(repo2, ['next'], { BEN_REVIEWER_CLI: stub2.cli });
  const b2 = JSON.parse(await readFile(join(S(repo2), 'blockers.json'), 'utf8'));
  await writeFile(join(S(repo2), 'proposal.json'), JSON.stringify([{ fingerprint: b2[0].fingerprint, action: 'rejected', detail: 'covered elsewhere' }]));
  const gate = await run(repo2, ['next'], { BEN_REVIEWER_CLI: stub2.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('Proposed REJECTIONS');
});

test('record-veto refuses free text, empty responses, and vetoes of never-proposed rejections', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: blockers[0].fingerprint, action: 'resolved', detail: 'fix it' }]));

  await writeFile(join(repo, 'freetext.json'), JSON.stringify('sounds good, proceed'));
  expect((await run(repo, ['record-veto', '--response', join(repo, 'freetext.json')])).exitCode).toBe(3);
  await writeFile(join(repo, 'empty.json'), JSON.stringify({}));
  expect((await run(repo, ['record-veto', '--response', join(repo, 'empty.json')])).exitCode).toBe(3);
  await writeFile(join(repo, 'phantom.json'), JSON.stringify({ vetoes: ['not-a-proposed-rejection'] }));
  const phantom = await run(repo, ['record-veto', '--response', join(repo, 'phantom.json')]);
  expect(phantom.exitCode).toBe(3);
  expect(phantom.stderr).toContain('does not propose rejecting');
});

// ---------------------------------------------------------------------------
// implement + verify: tally-bound intents

test('a failed gate consumes exactly one attempt across replays; a real change makes a new attempt ', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  // the gate is red until ok.txt is committed — red/green flips via CODE, never
  // by editing an approval-bound artifact
  await toApprovalGate(repo, stub, { gateCmd: 'test -f ok.txt' });
  await approve(repo);
  await commitChange(repo, 'feature');
  const red = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(red.exitCode).toBe(1);
  expect(red.stdout).toContain('Gates failed');
  expect((await readRounds(repo)).gateFix).toBe(1);

  // identical state replayed: the landed failure is re-presented, never re-billed
  const replay = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(replay.exitCode).toBe(1);
  expect(replay.stdout).toContain('already failed');
  expect((await readRounds(repo)).gateFix).toBe(1);

  // fixing the code is a new identity → a fresh invocation, which passes
  await commitChange(repo, 'ok'); // commits ok.md — not enough for the gate
  await writeFile(join(repo, 'ok.txt'), 'green\n');
  await git(repo, 'add', 'ok.txt');
  await git(repo, 'commit', '-m', 'fix: gate satisfied');
  await stub.respond(GO);
  const green = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(green.stdout).toContain('gh pr create');
  expect((await readRounds(repo)).gateFix).toBe(1);
});

for (const [step, boundary, planOpts] of [
  ['commits', 'after-verify:commits', {}],
  ['gates', 'after-verify:gates', { gateCmd: 'test -f ok.txt' }],
  ['criteria', 'after-verify:criteria', { criteriaCmd: 'test -f ok.txt' }],
] as const) {
  test(`literal SIGKILL between a failed verify ${step} referee and continuation never double-bumps the tally`, async () => {
    const repo = await makeRepo();
    const stub = await makeStubReviewer(repo);
    await toApprovalGate(repo, stub, planOpts as Parameters<typeof seedPlan>[1]);
    await approve(repo);
    if (step !== 'commits') await commitChange(repo, 'feature');

    await killAt(repo, ['next'], boundary, { BEN_REVIEWER_CLI: stub.cli });
    const key = { commits: 'implement', gates: 'gateFix', criteria: 'verifyFix' }[step];
    expect((await readRounds(repo))[key]).toBe(1); // the referee's failure landed before the kill

    const resume = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
    expect(resume.exitCode).toBe(1);
    expect((await readRounds(repo))[key]).toBe(1); // the landed attempt is never billed twice
  });
}

test('a SIGKILL before the referee ran leaves the intent behind artifacts; resume legally re-invokes', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  // killed right after the intent write, before verify commits ran
  await killAt(repo, ['next'], 'after-verify-intent:commits', { BEN_REVIEWER_CLI: stub.cli });
  expect((await readTask(repo)).verifyIntents.commits).toBeDefined();
  expect((await readRounds(repo)).implement ?? 0).toBe(0); // nothing landed
  const resume = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(resume.exitCode).toBe(1); // referee now runs and says: no commits
  expect(resume.stdout).toContain('No commits');
});

test('a dirty worktree STOPs before verification-for-review — uncommitted code cannot dodge the diff reviewer', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await commitChange(repo, 'feature');
  await writeFile(join(repo, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n');
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('worktree is dirty');
});

test('HEAD moving after the diff verdict quarantines it and returns to gates', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await commitChange(repo, 'feature');
  await stub.respond(GO);
  // kill right after the diff reviewer wrote its verdict, before adjudication
  await killAt(repo, ['next'], 'after-reviewer', { BEN_REVIEWER_CLI: stub.cli });
  expect(existsSync(join(S(repo), 'reviews', 'diff-round-1-codex.json'))).toBe(true);

  await commitChange(repo, 'sneaky-followup'); // HEAD moves past the reviewed baseline
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  // the stale verdict is quarantined (kept), then the same chain legally
  // re-verifies at the new HEAD and re-reviews fresh — never adjudicating stale bytes
  expect(r.stdout).toContain('quarantined');
  expect(r.stdout).toContain('gh pr create');
  expect(readdirSync(join(S(repo), 'reviews', 'superseded'))).toHaveLength(1);
  expect((await readTask(repo)).reviewBase.sha).toBe((await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })).stdout.trim());
});

// ---------------------------------------------------------------------------
// PR intent / retry protocol

test('the create instruction is emitted exactly once; resume never re-emits; record-pr is terminal and idempotent', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await toPrIntent(repo, stub);
  const task = await readTask(repo);
  expect(task.prIntent.attempt).toBe(1);
  expect(task.pr).toBeUndefined();
  expect(task.prIntent.headSha).toBe(task.reviewBase.sha); // the intent head IS the reviewed head

  // the crash window: remote create may or may not have happened — never re-emit
  for (let i = 0; i < 2; i++) {
    const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
    expect(again.exitCode).toBe(2);
    expect(again.stdout).toContain('will NOT emit another');
    expect(again.stdout).not.toContain('gh pr create --title');
  }

  // operator found the PR remotely: recording it (with the validated remote
  // observation) completes the transition
  const obs = await makeObservation(repo, 'https://github.com/x/y/pull/7', task.prIntent.headSha);
  const rec = await run(repo, ['record-pr', '--url', 'https://github.com/x/y/pull/7', '--remote-observation', obs]);
  expect(rec.exitCode).toBe(0);
  expect((await readTask(repo)).pr.publication.bodySha).toHaveLength(64); // the publication stamp landed
  const done = await run(repo, ['next']);
  expect(done.exitCode).toBe(0);
  expect(done.stdout).toContain('done — PR https://github.com/x/y/pull/7');

  const dupe = await run(repo, ['record-pr', '--url', 'https://github.com/x/y/pull/7']);
  expect(dupe.stdout).toContain('no-op');
  const conflict = await run(repo, ['record-pr', '--url', 'https://github.com/x/y/pull/8']);
  expect(conflict.exitCode).toBe(2);
  expect(conflict.stdout).toContain('different PR is already recorded');
});

test('confirmed-no-PR requires a recorded retry; the retry is single-use and yields exactly one fresh create instruction', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await toPrIntent(repo, stub);

  // no retry recorded → no create, ever
  expect((await run(repo, ['next'])).stdout).toContain('will NOT emit another');

  const retry = await run(repo, ['record-pr-retry', '--by', 'tester']);
  expect(retry.exitCode).toBe(0);
  const dupe = await run(repo, ['record-pr-retry', '--by', 'tester']);
  expect(dupe.stdout).toContain('no-op');

  // exactly one fresh create opportunity, with a new attempt identity
  const fresh = await run(repo, ['next']);
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('gh pr create');
  const task = await readTask(repo);
  expect(task.prIntent.attempt).toBe(2);
  expect(task.prRetries[0].consumedByAttempt).toBe(2); // consumed in the same atomic write

  // the consumed retry cannot be reused
  const again = await run(repo, ['next']);
  expect(again.exitCode).toBe(2);
  expect(again.stdout).toContain('will NOT emit another');
});

test('a PR record whose head does not match the reviewed intent STOPs', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await toPrIntent(repo, stub);
  await commitChange(repo, 'post-review-drift');
  const r = await run(repo, ['record-pr', '--url', 'https://github.com/x/y/pull/9']);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('HEAD no longer matches');
});

// ---------------------------------------------------------------------------
// grants: intent-keyed, crash-safe, replay-proof

test('record-grant lands once: duplicates no-op, a kill before the referee resumes cleanly, half-applied state STOPs', async () => {
  const repo = await makeRepo();
  await run(repo, ['init']);
  await seedPlan(repo);

  const first = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(first.exitCode).toBe(0);
  expect((await readRounds(repo)).grants).toHaveLength(1);

  const dupe = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(dupe.stdout).toContain('no-op');
  expect((await readRounds(repo)).grants).toHaveLength(1);
  expect((await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).match(/"granted"/g)).toHaveLength(1);

  // killed after the intent write, before ledger.mjs grant ran → resume completes it once
  const repo2 = await makeRepo();
  await run(repo2, ['init']);
  await seedPlan(repo2);
  await killAt(repo2, ['record-grant', '--kind', 'plan', '--rounds', '3', '--by', 'tester'], 'after-grant-intent');
  expect((await readRounds(repo2)).grants ?? []).toHaveLength(0); // referee never ran
  const resume = await run(repo2, ['record-grant', '--kind', 'plan', '--rounds', '3', '--by', 'tester']);
  expect(resume.exitCode).toBe(0);
  expect((await readRounds(repo2)).grants).toHaveLength(1);

  // half-applied referee state (grant in rounds.json, no ledger audit) STOPs
  const repo3 = await makeRepo();
  await run(repo3, ['init']);
  await seedPlan(repo3);
  await killAt(repo3, ['record-grant', '--kind', 'plan', '--rounds', '4', '--by', 'tester'], 'after-grant-intent');
  await writeFile(join(S(repo3), 'rounds.json'), JSON.stringify({ plan: 0, grants: [{ kind: 'plan', rounds: 4, by: 'tester', at: 'x' }] }));
  const half = await run(repo3, ['record-grant', '--kind', 'plan', '--rounds', '4', '--by', 'tester']);
  expect(half.exitCode).toBe(2);
  expect(half.stdout).toContain('ledger audit entry is missing');
});

test('a consumed grant intent is bookkeeping, not proof — rolled-back durable state STOPs; genuine landed state replays idempotently', async () => {
  const repo = await makeRepo();
  await run(repo, ['init']);
  await seedPlan(repo);
  expect((await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester'])).exitCode).toBe(0);

  // genuine replay: the grant is in rounds.json AND the ledger → proof-checked no-op
  const dupe = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(dupe.exitCode).toBe(0);
  expect(dupe.stdout).toContain('no-op');
  expect((await readRounds(repo)).grants).toHaveLength(1);

  // roll the act out of BOTH durable stores — the consumed flag alone must not fake success
  const rounds = await readRounds(repo);
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify({ ...rounds, grants: [] }));
  const ledgerText = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  const stripped = ledgerText
    .split('\n')
    .filter((l) => l !== '' && !l.includes('"granted"'))
    .map((l) => `${l}\n`)
    .join('');
  await writeFile(join(S(repo), 'ledger.jsonl'), stripped);
  const fabricated = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(fabricated.exitCode).toBe(2);
  expect(fabricated.stdout).toContain('marked consumed but the recorded grant is absent');
  expect((await readRounds(repo)).grants ?? []).toHaveLength(0); // the refused attempt wrote nothing
  expect(await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).toBe(stripped);
});

// ---------------------------------------------------------------------------
// concurrency: single-writer lock

test('the O_EXCL lock stops concurrent mutation; parallel identical grants land exactly once', async () => {
  const repo = await makeRepo();
  await run(repo, ['init']);
  await seedPlan(repo);

  await writeFile(join(S(repo), '.run-lock'), '99999');
  const blocked = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '1', '--by', 'tester']);
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stdout).toContain('holds the lock');
  rmSync(join(S(repo), '.run-lock'));

  const [a, b] = await Promise.all([
    run(repo, ['record-grant', '--kind', 'plan', '--rounds', '1', '--by', 'tester']),
    run(repo, ['record-grant', '--kind', 'plan', '--rounds', '1', '--by', 'tester']),
  ]);
  const outcomes = [a, b].map((r) => (r.exitCode === 0 ? (r.stdout.includes('no-op') ? 'noop' : 'granted') : 'locked'));
  expect(outcomes).toContain('granted');
  expect((await readRounds(repo)).grants).toHaveLength(1);
  expect((await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).match(/"granted"/g)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// adoption and legacy state

test('adopt is deliberate: dry-run summarizes, --confirm records the human facts, legacy approvals are re-presented', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  const base = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();
  // a legacy pre-sequencer dir: artifacts + a ledger whose early rounds have
  // no review files (the orphaned partial-seed history) + a legacy two-hash approval
  await seedPlan(repo);
  await appendFile(
    join(S(repo), 'ledger.jsonl'),
    `${JSON.stringify({ ts: 't', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: 'aaa', action: 'raised', detail: 'old finding' })}\n` +
      `${JSON.stringify({ ts: 't', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: 'aaa', action: 'resolved', detail: 'old fix' })}\n`,
  );
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify({ plan: 1 }));
  await writeFile(join(S(repo), 'approval.json'), JSON.stringify({ approvedBy: 'operator', at: 'then', sha256: { 'plan.md': 'x', 'criteria.json': 'y' } }));

  const dry = await run(repo, ['adopt', '--base', base, '--by', 'tester']);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain('Dry run');
  expect(dry.stdout).toContain('orphaned history');
  expect(dry.stdout).toContain('LEGACY format');
  expect(existsSync(join(S(repo), 'task.json'))).toBe(false);

  const confirmed = await run(repo, ['adopt', '--base', base, '--by', 'tester', '--confirm']);
  expect(confirmed.exitCode).toBe(0);
  const task = await readTask(repo);
  expect(task.adoption.by).toBe('tester');
  expect(task.base).toBe(base);
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false); // never silently grandfathered

  // the adopted task continues under the sequencer: review round 2 → fresh approval gate
  await stub.respond(GO);
  const next = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(next.exitCode).toBe(2);
  expect(next.stdout).toContain('APPROVE BUILD');
});

test('status is read-only, reports legacy gaps, and never claims a clean done over missing evidence', async () => {
  const repo = await makeRepo();
  await seedPlan(repo);
  await appendFile(join(S(repo), 'ledger.jsonl'), `${JSON.stringify({ ts: 't', kind: 'plan', round: 3, reviewer: 'codex', blockerId: '', fingerprint: '', action: 'raised', detail: 'x' })}\n`);
  const before = readdirSync(S(repo)).sort().join(',');
  const r = await run(repo, ['status']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('plan round 3');
  expect(r.stdout).toContain('orphaned history');
  expect(readdirSync(S(repo)).sort().join(',')).toBe(before); // nothing written, not even a lock
});

// ---------------------------------------------------------------------------
// correction pass: gate-presentation binding, partial-ledger STOPs, schema STOPs

test('record-approval refuses an approval whose packet was never presented (no human-gate bypass)', async () => {
  const repo = await makeRepo();
  await run(repo, ['init', '--title', 'test task']);
  await seedPlan(repo);
  // artifacts exist, no blockers — but no pregate, no review, no presented packet
  const r = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('no APPROVE BUILD packet has been presented');
  const next = await run(repo, ['next'], { BEN_REVIEWER_CLI: (await makeStubReviewer(repo)).cli });
  expect(next.stdout).not.toContain('No commits'); // never entered implementation
});

test('record-veto refuses a decision for a gate that was never presented', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli }); // blockers land; proposal instructed
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  // proposal written but the veto gate was never presented (no second next)
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: blockers[0].fingerprint, action: 'resolved', detail: 'fix' }]));
  await writeFile(join(repo, 'confirm.json'), JSON.stringify({ decision: 'confirm' }));
  const r = await run(repo, ['record-veto', '--response', join(repo, 'confirm.json')]);
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('never presented');
});

test('a crashed ledger round (tally advanced, blockers.json lost) STOPs instead of skipping the raised round', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli }); // round 1 raised, tally 1, blockers written
  rmSync(join(S(repo), 'blockers.json')); // the crash: blockers.json never landed / was lost
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('raised blockers for plan round 1 with no resolutions');
});

test('landed resolutions with blockers.json still present STOP instead of re-appending ledger history', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init']);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  const fp = blockers[0].fingerprint;
  // the crash inside ledger.mjs resolve: resolution entries appended, blockers.json not deleted
  await appendFile(
    join(S(repo), 'ledger.jsonl'),
    `${JSON.stringify({ ts: 't', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: fp, action: 'resolved', detail: 'landed' })}\n`,
  );
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'resolved', detail: 'fix it' }]));
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli }); // presents the veto gate
  await writeFile(join(repo, 'confirm.json'), JSON.stringify({ decision: 'confirm' }));
  await run(repo, ['record-veto', '--response', join(repo, 'confirm.json')]);
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'resolved', detail: 'fix it' }]));
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('already holds 1 resolution(s) for plan round 1');
});

test('malformed optional task fields STOP: a truthy empty pr record is never read as done', async () => {
  const repo = await makeRepo();
  await run(repo, ['init']);
  const task = await readTask(repo);
  task.pr = {};
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));
  const r = await run(repo, ['next']);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('task.json does not match the sequencer schema');
});

test('a stale approval blocks the pending-PR path: no retry, no record, no terminal act', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await toPrIntent(repo, stub);
  await appendFile(join(S(repo), 'plan.md'), 'post-hoc edit\n'); // voids the approval mid-PR
  const next = await run(repo, ['next']);
  expect(next.exitCode).toBe(2);
  expect(next.stdout).toContain('approval no longer matches');
  const retry = await run(repo, ['record-pr-retry', '--by', 'tester']);
  expect(retry.exitCode).toBe(2);
  const rec = await run(repo, ['record-pr', '--url', 'https://github.com/x/y/pull/1']);
  expect(rec.exitCode).toBe(2);
});

test('a green gate command that dirties the worktree STOPs before review', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub, { gateCmd: 'echo dirty >> math.ts' }); // exits 0, mutates tracked code
  await approve(repo);
  await commitChange(repo, 'feature');
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('dirtied the worktree during verification');
});

test('the commits second strike escalates (exit 2) even when re-presented from the recorded intent', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  const first = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(first.exitCode).toBe(1); // strike 1
  await writeFile(join(repo, 'wip.txt'), 'uncommitted work\n'); // identity changes, still no commit
  const second = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(second.exitCode).toBe(2); // the referee's own second-strike escalation
  const replay = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(replay.exitCode).toBe(2); // re-presented, never downgraded, never re-billed
  expect((await readRounds(repo)).implement).toBe(2);
});

// ---------------------------------------------------------------------------
// the pause seam is inert when unset or unmatched

test('a seeded task in a different clone rebinds via adopt --rebind and continues', async () => {
  const repo = await makeRepo();
  await run(repo, ['init', '--title', 'seeded task']);
  const task = await readTask(repo);
  task.repo.rootCommit = 'e'.repeat(40); // simulate: state seeded from another clone
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));

  const stopped = await run(repo, ['next']);
  expect(stopped.exitCode).toBe(2);
  expect(stopped.stdout).toContain('--rebind');

  const dry = await run(repo, ['adopt', '--rebind', '--by', 'tester']);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain('dry run');
  const bound = await run(repo, ['adopt', '--rebind', '--by', 'tester', '--confirm']);
  expect(bound.exitCode).toBe(0);
  expect((await readTask(repo)).adoption.rebind).toBe(true);
  const next = await run(repo, ['next']);
  expect(next.exitCode).toBe(0);
  expect(next.stdout).toContain('Write the plan artifacts');
});

test('the pause seam has zero behavioral effect unless its exact boundary is named', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await run(repo, ['init', '--title', 'test task'], { BEN_RUN_PAUSE_AT: 'no-such-boundary' });
  await seedPlan(repo);
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli, BEN_RUN_PAUSE_AT: 'no-such-boundary' });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('APPROVE BUILD');
  expect(readdirSync(S(repo)).filter((f) => f.startsWith('.paused-'))).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// referee hardening: scope wiring + chain consistency boundaries

test('the approval packet displays the canonical config; a post-approval config change re-presents the gate (config binding)', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  const gateOut = await toApprovalGate(repo, stub);
  expect(gateOut.stdout).toContain('=== config (canonical, verdict-relevant');
  expect(gateOut.stdout).toContain('{"e2ePaths":"","greenfield":false,"planRoundsMax":9,"diffRoundsMax":9}');
  await approve(repo);

  // simulate an out-of-band config change (the test harness may edit state; the model never does)
  const task = await readTask(repo);
  task.config.e2ePaths = 'src/ui/**';
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('APPROVE BUILD'); // approval voided by the config member — re-presented
});

test('C24 wiring: an actual UI-touching diff with no e2e criterion fails scope red; the fix voids the approval and re-presents the plan phase', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task', '--e2e-paths', 'src/ui/**'])).exitCode).toBe(0);
  await seedPlan(repo); // plan-files declares only math.ts — the declaration-side net stays silent
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // APPROVE gate
  await approve(repo);

  await Bun.write(join(repo, 'src/ui/App.tsx'), 'ui\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'feat: touch ui undeclared');

  const red = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(red.exitCode).toBe(1);
  expect(red.stdout).toContain('Scope failed — the actual diff touches e2e paths but the criteria carry no e2e criterion');
  expect(red.stdout).toContain('src/ui/App.tsx');
  expect((await readRounds(repo)).scopeFix).toBe(1);

  // identical replay: recorded intent, no double-billing
  const replay = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(replay.exitCode).toBe(1);
  expect(replay.stdout).toContain('verify scope already failed for this exact state');
  expect((await readRounds(repo)).scopeFix).toBe(1);

  // the legal fix: an e2e criterion (+ declared path) — plan artifacts change, approval voids, plan phase re-presents
  await writeFile(
    join(S(repo), 'criteria.json'),
    JSON.stringify(
      {
        taskId: 'T1',
        criteria: [
          { id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } },
          { id: 'C2', statement: 'the ui flow works end to end', verification: { method: 'e2e', command: 'true' } },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(join(S(repo), 'plan-files.json'), JSON.stringify(['math.ts', 'src/ui/App.tsx']));
  const represent = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(represent.exitCode).toBe(2);
  expect(represent.stdout).toContain('APPROVE BUILD');
  await approve(repo);
  const green = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(green.exitCode).toBe(0);
  expect(green.stdout).toContain('gh pr create'); // scope green at the new criteria → full chain → diff GO → PR intent
});

test('a SIGKILL after the scope intent never double-bills the identical failing scope attempt', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task', '--e2e-paths', 'src/ui/**'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  await approve(repo);
  await Bun.write(join(repo, 'src/ui/App.tsx'), 'ui\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'feat: ui');

  await killAt(repo, ['next'], 'after-verify:scope', { BEN_REVIEWER_CLI: stub.cli });
  expect((await readRounds(repo)).scopeFix).toBe(1); // the referee's failure landed durably

  const resume = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(resume.exitCode).toBe(1);
  expect(resume.stdout).toContain('verify scope already failed for this exact state');
  expect((await readRounds(repo)).scopeFix).toBe(1); // re-presented, never re-billed
});

test('boundary 1: a green gate that rewrites an approval-bound artifact STOPs before criteria execute — rewritten bytes are never consumed', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub, { gateCmd: 'echo sneaky >> .ben/plan.md' });
  await approve(repo);
  await commitChange(repo, 'feature');

  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('the approval no longer matches the on-disk artifacts (after gates, before criteria)');
  // the rewritten criteria/plan were consumed by NOTHING: criteria never ran
  expect(readdirSync(join(S(repo), 'evidence')).filter((f) => f.startsWith('criteria-'))).toHaveLength(0);
  expect((await readTask(repo)).reviewBase).toBeUndefined();

  // fail-closed, never blessed: record-approval refuses the mutated bytes without a fresh packet
  const sneak = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(sneak.exitCode).toBe(3);
  expect(sneak.stderr).toContain('no APPROVE BUILD packet has been presented');
});

test('boundary 2: a green criterion that rewrites plan-files.json STOPs before the review baseline — the diff reviewer is never invoked on stale bytes', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub, { criteriaCmd: `printf '["math.ts","sneaky.ts"]' > .ben/plan-files.json` });
  await approve(repo);
  await commitChange(repo, 'feature');
  const callsBefore = await stub.calls();

  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('the approval no longer matches the on-disk artifacts (after criteria, before the review baseline)');
  expect((await readTask(repo)).reviewBase).toBeUndefined();
  expect(await stub.calls()).toBe(callsBefore); // no diff review over unapproved bytes
});

test('mixed-HEAD chain: a gate that commits STOPs (no laundering); the next run re-earns the whole chain at the new HEAD', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  const idempotentCommitGate =
    'test -f gate-side-effect.txt || (echo x > gate-side-effect.txt && git add gate-side-effect.txt && git -c user.email=g@t -c user.name=g commit -qm "chore: gate commit")';
  await toApprovalGate(repo, stub, { gateCmd: idempotentCommitGate });
  await approve(repo);
  await commitChange(repo, 'feature');

  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('a verification command moved HEAD during the chain');
  expect((await readTask(repo)).reviewBase).toBeUndefined(); // reviewBase never laundered the moved HEAD

  // second run: the gate is now a no-op — the chain re-runs fully at the new HEAD and proceeds
  const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.exitCode).toBe(0);
  expect(again.stdout).toContain('gh pr create');
  expect((await readTask(repo)).reviewBase.sha).toHaveLength(40);
});

test('boundary 3: an artifact mutated while the diff reviewer runs quarantines the verdict — approval currency is part of the reviewed baseline', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await commitChange(repo, 'feature');

  // a hostile stand-in reviewer that mutates an approval-bound artifact mid-review, then says GO
  const dir = await makeTmpDir('run-hostile-');
  const hostileJs = join(dir, 'hostile.mjs');
  await writeFile(
    hostileJs,
    `import { writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(S(repo), 'plan.md'))}, 'mutated mid-review\\n');
const out = args[args.indexOf('-o') + 1];
writeFileSync(out, JSON.stringify({ verdict: 'GO', blockers: [] }));
`,
  );
  const hostile = join(dir, 'hostile-cli');
  await writeFile(hostile, `#!/bin/sh\nexec node "${hostileJs}" "$@"\n`);
  chmodSync(hostile, 0o755);

  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: hostile });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('verdict quarantined');
  expect((await readTask(repo)).reviewBase).toBeUndefined();
  expect(existsSync(join(S(repo), 'reviews', 'superseded'))).toBe(true);
  expect((await readTask(repo)).prIntent).toBeUndefined(); // nothing terminal consumed the GO
});

// ---------------------------------------------------------------------------
// referee hardening: legacy review authority + migration state machine

const LEGACY_SNAPSHOTS = ['plan-files.reviewed.json', 'gates.reviewed.json', 'config.reviewed.json'];

test('a legacy GO (incomplete review context) is historical only: one fresh complete-context round is earned; ledger history intact; repeat next does not re-review', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub); // writes the six-member snapshot set
  const callsAfterGo = await stub.calls();
  const ledgerPath = join(S(repo), 'ledger.jsonl');
  const ledgerBefore = existsSync(ledgerPath) ? await readFile(ledgerPath, 'utf8') : '(absent)';

  // simulate the pre-upgrade state: the recorded GO never reviewed the three new members
  for (const f of LEGACY_SNAPSHOTS) rmSync(join(S(repo), f), { force: true });

  const migrate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(migrate.exitCode).toBe(2);
  expect(migrate.stdout).toContain('recorded review judged an incomplete authority set'); // quarantined, named
  expect(migrate.stdout).toContain('APPROVE BUILD'); // fresh GO reached the gate in the same derivation
  expect(await stub.calls()).toBe(callsAfterGo + 1); // exactly ONE fresh complete-context round
  expect(readdirSync(join(S(repo), 'reviews', 'superseded')).length).toBeGreaterThan(0); // old GO kept as history
  const ledgerAfter = existsSync(ledgerPath) ? await readFile(ledgerPath, 'utf8') : '(absent)';
  expect(ledgerAfter).toBe(ledgerBefore); // append-only history untouched by migration

  const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.exitCode).toBe(2);
  expect(again.stdout).toContain('APPROVE BUILD');
  expect(await stub.calls()).toBe(callsAfterGo + 1); // no second fresh round

  await approve(repo); // the fresh complete-context GO permits the normal approval path
  expect(JSON.parse(await readFile(join(S(repo), 'approval.json'), 'utf8')).sha256.config).toHaveLength(64);
});

test('an old approved task cannot bypass the fresh review by re-approval: the legacy packet is refused, migration re-reviews first', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  const callsAfterGo = await stub.calls();

  // simulate the pre-upgrade approved task: approval and presented packet lack
  // the config member; the new snapshot members were never written
  for (const f of LEGACY_SNAPSHOTS) rmSync(join(S(repo), f), { force: true });
  const approval = JSON.parse(await readFile(join(S(repo), 'approval.json'), 'utf8'));
  delete approval.sha256.config;
  await writeFile(join(S(repo), 'approval.json'), JSON.stringify(approval, null, 2));
  const task = await readTask(repo);
  delete task.approvalGate.hashes.config;
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));

  // re-approval alone is refused: no packet has been presented for the current (six-member) hashes
  const bypass = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(bypass.exitCode).toBe(3);
  expect(bypass.stderr).toContain('no APPROVE BUILD packet has been presented');

  // the legal route: next → fresh complete-context round → re-presented packet → approval
  const migrate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(migrate.exitCode).toBe(2);
  expect(migrate.stdout).toContain('APPROVE BUILD');
  expect(await stub.calls()).toBe(callsAfterGo + 1);
  await approve(repo);
});

test('a pre-upgrade reviewBase (no approvalHashes) with a pending diff verdict is quarantined and re-earned — never consumed', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await commitChange(repo, 'feature');
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-review-base', { BEN_REVIEWER_CLI: stub.cli });

  // pending verdict on disk, reviewBase recorded — now strip the approval binding (pre-upgrade shape)
  mkdirSync(join(S(repo), 'reviews'), { recursive: true });
  await writeFile(join(S(repo), 'reviews', 'diff-round-1-codex.json'), JSON.stringify(GO, null, 2));
  const task = await readTask(repo);
  expect(task.reviewBase.sha).toHaveLength(40);
  delete task.reviewBase.approvalHashes;
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));

  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.stdout).toContain('verdict quarantined');
  expect(r.stdout).toContain('gh pr create'); // re-earned: fresh verify chain + fresh review in the same derivation
  expect(r.exitCode).toBe(0);
  expect(readdirSync(join(S(repo), 'reviews', 'superseded')).length).toBeGreaterThan(0);
});

test('terminal recorded PR is never reopened by migration — legacy-looking snapshots change nothing', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await toPrIntent(repo, stub);
  const headNow = (await readTask(repo)).prIntent.headSha;
  const obsTerm = await makeObservation(repo, 'https://example.test/pr/1', headNow);
  expect((await run(repo, ['record-pr', '--url', 'https://example.test/pr/1', '--remote-observation', obsTerm])).exitCode).toBe(0);

  for (const f of LEGACY_SNAPSHOTS) rmSync(join(S(repo), f), { force: true });
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('done — PR https://example.test/pr/1');
  expect((await readTask(repo)).pr.headSha).toBe(headNow);
  expect(existsSync(join(S(repo), 'reviews', 'superseded'))).toBe(false); // nothing quarantined
});

// ---------------------------------------------------------------------------
// referee hardening: pending-PR migration protocol

/** Drive to a pending PR intent, then void the approval (the legacy migration entry state). */
async function toVoidedPrIntent(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>): Promise<void> {
  await toApprovalGate(repo, stub);
  await approve(repo);
  await toPrIntent(repo, stub);
  await appendFile(join(S(repo), 'plan.md'), 'post-approval edit\n'); // voids the approval mid-PR
}

/** the human gate prints the exact replay-safe commands — extract the durable identity from ITS output, never by precomputing. */
async function gateIntentHash(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>): Promise<{ hash: string; stopOut: string }> {
  const stop = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(stop.exitCode).toBe(2);
  const hash = stop.stdout.match(/--intent-hash ([0-9a-f]{64})/)?.[1] ?? '';
  expect(hash).toHaveLength(64);
  return { hash, stopOut: stop.stdout };
}

test('a legacy pending prIntent under a voided approval never deadlocks: the STOP names record-pr-remote, and the absent path migrates to exactly one fresh create', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toVoidedPrIntent(repo, stub);

  const { hash, stopOut } = await gateIntentHash(repo, stub);
  expect(stopOut).toContain(`record-pr-remote --status absent --intent-hash ${hash}`);
  expect(stopOut).toContain(`record-pr-remote --status exists --url <its url> --intent-hash ${hash}`);

  // the exact instructed command (with the printed identity) — already replay-safe
  const absent = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', hash, '--by', 'tester']);
  expect(absent.exitCode).toBe(0);
  const task = await readTask(repo);
  expect(task.prIntent).toBeUndefined();
  expect(task.prAttempts).toHaveLength(1); // archived, never deleted
  expect(task.prResolutions).toEqual([
    expect.objectContaining({ type: 'observation', status: 'absent', by: 'tester', intentHash: hash }),
  ]);

  // replay of the exact instructed command after the landed write: idempotent no-op
  const replay = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', hash, '--by', 'tester']);
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('already recorded — no-op');
  expect((await readTask(repo)).prResolutions).toHaveLength(1);

  // without the durable identity the target is never inferred — refused with guidance
  const blind = await run(repo, ['record-pr-remote', '--status', 'absent', '--by', 'tester']);
  expect(blind.exitCode).toBe(3);
  expect(blind.stderr).toContain('--intent-hash <hash> is required');

  // migration: fresh complete-context plan review, then re-approval — NO create instruction anywhere
  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.exitCode).toBe(2);
  expect(gate.stdout).toContain('APPROVE BUILD');
  expect(gate.stdout).not.toContain('gh pr create');
  await approve(repo);

  // full requalification → exactly one fresh create intent, monotonically numbered
  const fresh = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('gh pr create');
  expect((await readTask(repo)).prIntent.attempt).toBe(2);
});

test('record-pr-remote refuses under a current approval — ordinary pending-intent behavior is untouched', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await toPrIntent(repo, stub); // approval still current
  const r = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', 'a'.repeat(64), '--by', 'tester']);
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('the approval is current — the ordinary protocol governs');
  expect((await readTask(repo)).prIntent.attempt).toBe(1); // untouched
});

test('exists path: the observed PR is non-terminal, cannot be recorded before requalification, and records terminally at a matching head with zero creates', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toVoidedPrIntent(repo, stub);
  const oldHead = (await readTask(repo)).prIntent.headSha;

  const { hash } = await gateIntentHash(repo, stub);
  const exists = await run(repo, ['record-pr-remote', '--status', 'exists', '--url', 'https://example.test/pr/7', '--intent-hash', hash, '--by', 'tester']);
  expect(exists.exitCode).toBe(0);
  let task = await readTask(repo);
  expect(task.pr).toBeUndefined(); // NON-terminal — terminality before fresh review is the grandfathering this forbids
  expect(task.observedPr).toEqual(expect.objectContaining({ url: 'https://example.test/pr/7', headSha: oldHead }));

  // premature terminality refused at BOTH pre-GO points: under the voided
  // approval (fail-closed STOP), and after re-approval but before the fresh
  // diff GO (no requalified stamp — HEAD still equals the old intent head here,
  // so this is exactly the window a head check alone would miss)
  const earlyVoided = await run(repo, ['record-pr', '--url', 'https://example.test/pr/7']);
  expect(earlyVoided.exitCode).toBe(2);
  expect(earlyVoided.stdout).toContain('approval no longer matches');

  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.stdout).toContain('APPROVE BUILD');
  await approve(repo);

  const earlyUnqualified = await run(repo, ['record-pr', '--url', 'https://example.test/pr/7']);
  expect(earlyUnqualified.exitCode).toBe(3);
  expect(earlyUnqualified.stderr).toContain('has not been requalified at the current HEAD');
  const requal = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(requal.exitCode).toBe(2);
  expect(requal.stdout).toContain('freshly reviewed HEAD matches its head');
  expect(requal.stdout).toContain('record-pr --url https://example.test/pr/7');
  expect(requal.stdout).not.toContain('gh pr create'); // zero create instructions on the observedPr path

  const wrongUrl = await run(repo, ['record-pr', '--url', 'https://example.test/pr/999']);
  expect(wrongUrl.exitCode).toBe(3);
  expect(wrongUrl.stderr).toContain('must be the observed PR url');

  // the migration changed plan.md, so the operator regenerates the body,
  // updates the remote, and records the validated observation
  await regenBody(repo);
  const obsExists = await makeObservation(repo, 'https://example.test/pr/7', oldHead);
  const terminal = await run(repo, ['record-pr', '--url', 'https://example.test/pr/7', '--remote-observation', obsExists]);
  expect(terminal.exitCode).toBe(0);
  expect(terminal.stdout).toContain('pre-existing remote PR, no create emitted');
  task = await readTask(repo);
  expect(task.pr).toEqual(expect.objectContaining({ url: 'https://example.test/pr/7', headSha: oldHead }));
  expect(task.pr.publication.headRefOid).toBe(oldHead);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('done — PR');
});

test('mismatched observedPr head: durable gate with the exact intentHash; disposition survives a pre-write kill, replays as a no-op, and yields exactly one fresh create', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toVoidedPrIntent(repo, stub);
  const { hash: gateHash } = await gateIntentHash(repo, stub);
  expect((await run(repo, ['record-pr-remote', '--status', 'exists', '--url', 'https://example.test/pr/9', '--intent-hash', gateHash, '--by', 'tester'])).exitCode).toBe(0);
  await commitChange(repo, 'drift'); // the reviewed head will not match the observed head

  const gate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gate.stdout).toContain('APPROVE BUILD');
  await approve(repo);
  const mismatch = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(mismatch.exitCode).toBe(2);
  expect(mismatch.stdout).toContain('observed remote PR head mismatch');
  const intentHash = (await readTask(repo)).observedPr.intentHash;
  expect(mismatch.stdout).toContain(`record-pr-unusable --intent-hash ${intentHash}`); // the gate prints the exact hash
  expect((await readTask(repo)).observedPr.mismatch.reviewBaseSha).toHaveLength(40); // durable presentation

  // wrong target: STOP, nothing written
  const wrong = await run(repo, ['record-pr-unusable', '--intent-hash', 'f'.repeat(64), '--by', 'tester']);
  expect(wrong.exitCode).toBe(2);
  expect(wrong.stdout).toContain('does not match the active observedPr');
  expect((await readTask(repo)).observedPr).toBeDefined();

  // crash BEFORE the atomic write: nothing durable — the retry performs the disposition exactly once
  await killAt(repo, ['record-pr-unusable', '--intent-hash', intentHash, '--by', 'tester'], 'before-unusable-write');
  let task = await readTask(repo);
  expect(task.observedPr).toBeDefined();
  expect((task.prResolutions ?? []).filter((r: { type: string }) => r.type === 'disposition')).toHaveLength(0);

  const dispose = await run(repo, ['record-pr-unusable', '--intent-hash', intentHash, '--by', 'tester']);
  expect(dispose.exitCode).toBe(0);
  task = await readTask(repo);
  expect(task.observedPr).toBeUndefined(); // cleared from active routing
  const dispositions = task.prResolutions.filter((r: { type: string }) => r.type === 'disposition');
  expect(dispositions).toHaveLength(1);
  expect(dispositions[0].observedPr.url).toBe('https://example.test/pr/9'); // full observed fact embedded
  expect(task.prResolutions.filter((r: { type: string }) => r.type === 'observation')).toHaveLength(1); // initial exists observation intact

  // crash-after-write equivalence: the exact replay is a successful no-op — no second disposition
  const replay = await run(repo, ['record-pr-unusable', '--intent-hash', intentHash, '--by', 'tester']);
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('already dispositioned unusable — no-op');
  expect((await readTask(repo)).prResolutions.filter((r: { type: string }) => r.type === 'disposition')).toHaveLength(1);

  // an unrelated historical hash is never a false no-op target
  const unrelated = await run(repo, ['record-pr-unusable', '--intent-hash', 'a'.repeat(64), '--by', 'tester']);
  expect(unrelated.exitCode).toBe(3);
  expect(unrelated.stderr).toContain('no active observedPr and no disposition recorded');

  // no re-plan/re-review solely from the disposition: the earned diff GO stands and one fresh create intent is emitted
  const callsBefore = await stub.calls();
  const fresh = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(fresh.exitCode).toBe(0);
  expect(fresh.stdout).toContain('gh pr create');
  expect(await stub.calls()).toBe(callsBefore); // neither pregate-review nor diff review re-ran
  expect((await readTask(repo)).prIntent.attempt).toBe(2);
});

// ---------------------------------------------------------------------------
// Recovery and state-binding regressions

test('a requalified stamp earned under a superseded approval is unusable — terminality requires a fresh diff GO under the current approval', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toVoidedPrIntent(repo, stub);
  const { hash: r2hash } = await gateIntentHash(repo, stub);
  expect((await run(repo, ['record-pr-remote', '--status', 'exists', '--url', 'https://example.test/pr/11', '--intent-hash', r2hash, '--by', 'tester'])).exitCode).toBe(0);
  const oldHead = (await readTask(repo)).observedPr.headSha;

  // migration → approval A' → fresh diff GO at matching head → stamp under A'
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repo);
  const requal = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(requal.stdout).toContain('freshly reviewed HEAD matches its head');
  const stamped = (await readTask(repo)).observedPr.requalified;
  expect(stamped.reviewBaseSha).toBe(oldHead);
  expect(stamped.approvalHashes.config).toHaveLength(64); // the stamp records the approval authority it was earned under

  // the approval changes again (HEAD unchanged) — the old stamp must NOT permit record-pr
  await appendFile(join(S(repo), 'plan.md'), 'second post-approval edit\n');
  const staleAttempt = await run(repo, ['record-pr', '--url', 'https://example.test/pr/11']);
  expect(staleAttempt.exitCode).toBe(2); // voided approval: fail-closed STOP
  expect((await readTask(repo)).pr).toBeUndefined();

  // re-approve under B — the stamp still names A's authority, so record-pr refuses BEFORE a fresh GO under B
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repo);
  const staleStamp = await run(repo, ['record-pr', '--url', 'https://example.test/pr/11']);
  expect(staleStamp.exitCode).toBe(3);
  expect(staleStamp.stderr).toContain('not been requalified at the current HEAD under the current approval');
  expect((await readTask(repo)).pr).toBeUndefined();

  // one more derivation earns the fresh diff GO under B and re-stamps; then terminality is legal, zero creates
  const requal2 = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(requal2.stdout).toContain('freshly reviewed HEAD matches its head');
  expect(requal2.stdout).not.toContain('gh pr create');
  const restamped = (await readTask(repo)).observedPr.requalified;
  expect(JSON.stringify(restamped.approvalHashes)).not.toBe(JSON.stringify(stamped.approvalHashes)); // new authority, new stamp
  await regenBody(repo);
  const obsR2 = await makeObservation(repo, 'https://example.test/pr/11', oldHead);
  const terminal = await run(repo, ['record-pr', '--url', 'https://example.test/pr/11', '--remote-observation', obsR2]);
  expect(terminal.exitCode).toBe(0);
  expect(terminal.stdout).toContain('no create emitted');
});

test('reviewBase names the HEAD the chain proved; a commit landing after the baseline is re-earned, never laundered', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await commitChange(repo, 'feature');
  const chainHead = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 30_000 })).stdout.trim();
  await stub.respond(GO);
  await killAt(repo, ['next'], 'after-review-base', { BEN_REVIEWER_CLI: stub.cli });
  expect((await readTask(repo)).reviewBase.sha).toBe(chainHead); // the persisted baseline is the PROVED chain head

  // a racer's commit lands after the baseline write — from durable state this is
  // exactly the boundary-race window; the guards must force a full re-earn
  await commitChange(repo, 'racer');
  const newHead = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 30_000 })).stdout.trim();
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('gh pr create');
  const task = await readTask(repo);
  expect(task.reviewBase.sha).toBe(newHead); // re-earned at the new HEAD…
  expect(await stub.calls()).toBe(2); // …with its own review (1 plan round + 1 diff round at the new HEAD only)
});

test('record-pr-remote crash/replay — kill before the write performs once on retry; --intent-hash replay after the write is an idempotent no-op; contradictions STOP', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toVoidedPrIntent(repo, stub);
  // the identity comes from the human gate's printed command — the exact
  // operator workflow — never precomputed from task.json
  const { hash: intentHash } = await gateIntentHash(repo, stub);

  // wrong explicit target while the intent is pending: STOP, nothing written
  const wrong = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', 'f'.repeat(64), '--by', 'tester']);
  expect(wrong.exitCode).toBe(2);
  expect(wrong.stdout).toContain('does not match the pending intent');
  expect((await readTask(repo)).prIntent).toBeDefined();

  // crash BEFORE the atomic write: nothing durable; the exact retry performs the observation once
  await killAt(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', intentHash, '--by', 'tester'], 'before-pr-remote-write');
  expect((await readTask(repo)).prIntent).toBeDefined();
  expect((await readTask(repo)).prResolutions).toBeUndefined();
  const landed = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', intentHash, '--by', 'tester']);
  expect(landed.exitCode).toBe(0);
  expect((await readTask(repo)).prResolutions).toHaveLength(1);

  // replay of the exact instructed command after the write: successful no-op, nothing appended
  const replay = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', intentHash, '--by', 'tester']);
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).toContain('already recorded — no-op');
  expect((await readTask(repo)).prResolutions).toHaveLength(1);
  expect((await readTask(repo)).prAttempts).toHaveLength(1);

  // a contradictory replay for the same target STOPs with both facts
  const conflict = await run(repo, ['record-pr-remote', '--status', 'exists', '--url', 'https://x.test/1', '--intent-hash', intentHash, '--by', 'tester']);
  expect(conflict.exitCode).toBe(2);
  expect(conflict.stdout).toContain('a different remote observation is already recorded');

  // without the explicit identity the target is never inferred — refused with guidance
  const blind = await run(repo, ['record-pr-remote', '--status', 'absent', '--by', 'tester']);
  expect(blind.exitCode).toBe(3);
  expect(blind.stderr).toContain('--intent-hash <hash> is required');
});

test('a crash AFTER the atomic write but BEFORE the success output — the exact gate-printed command replays as a no-op', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toVoidedPrIntent(repo, stub);
  const { hash } = await gateIntentHash(repo, stub); // the operator's actual command source

  // the write lands durably; the process dies before any success output reaches the operator
  await killAt(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', hash, '--by', 'tester'], 'after-pr-remote-write');
  let task = await readTask(repo);
  expect(task.prIntent).toBeUndefined(); // the atomic write landed
  expect(task.prResolutions).toHaveLength(1);
  expect(task.prAttempts).toHaveLength(1);

  // the operator, having seen no output, repeats the exact instructed command
  const retry = await run(repo, ['record-pr-remote', '--status', 'absent', '--intent-hash', hash, '--by', 'tester']);
  expect(retry.exitCode).toBe(0);
  expect(retry.stdout).toContain('already recorded — no-op');
  task = await readTask(repo);
  expect(task.prResolutions).toHaveLength(1); // exactly one observation
  expect(task.prAttempts).toHaveLength(1); // exactly one archived attempt
});

test('changing the applicability config is a NEW scope identity — a landed failure under old globs is never replayed against new config', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task', '--e2e-paths', 'src/ui/**'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  await approve(repo);
  await Bun.write(join(repo, 'src/ui/App.tsx'), 'ui\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'feat: ui');
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('Scope failed');
  expect((await readRounds(repo)).scopeFix).toBe(1);

  // the human disables the applicability config (harness edit; the approval voids on the config member)
  const task = await readTask(repo);
  task.config.e2ePaths = '';
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(task, null, 2));
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).stdout).toContain('APPROVE BUILD');
  await approve(repo);

  // scope must run FRESH under the new identity (inert), never replay the stale failure
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.stdout).not.toContain('already failed for this exact state');
  expect(r.stdout).toContain('gh pr create'); // inert scope → full chain green → PR intent
  expect((await readRounds(repo)).scopeFix).toBe(1); // the old failure was never re-billed either
});

test('malformed inner PR-state shapes STOP as schema violations and are never read as progress or a presented gate', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  const good = await readTask(repo);

  const cases: Record<string, unknown> = {
    'empty mismatch stamp': { ...good, observedPr: { url: 'u', headSha: 'h', intentHash: 'i', mismatch: {} } },
    'empty requalified stamp': { ...good, observedPr: { url: 'u', headSha: 'h', intentHash: 'i', requalified: {} } },
    'requalified without approval authority': { ...good, observedPr: { url: 'u', headSha: 'h', intentHash: 'i', requalified: { reviewBaseSha: 'x'.repeat(40) } } },
    'disposition with empty embedded observation': {
      ...good,
      prResolutions: [{ type: 'disposition', disposition: 'unusable', intentHash: 'i', by: 'tester', at: 'now', observedPr: {} }],
    },
    'non-object reviewBase.approvalHashes': { ...good, reviewBase: { sha: 'x'.repeat(40), approvalHashes: 'not-an-object' } },
  };
  for (const [name, mutated] of Object.entries(cases)) {
    await writeFile(join(S(repo), 'task.json'), JSON.stringify(mutated, null, 2));
    const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('task.json does not match the sequencer schema');
    // fail-closed: the malformed durable state is preserved, never repaired or consumed
    expect(JSON.parse(await readFile(join(S(repo), 'task.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(mutated)));
    void name;
  }
  // record-pr-unusable equally refuses to treat malformed state as a presented gate
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(cases['empty mismatch stamp'], null, 2));
  const cmd = await run(repo, ['record-pr-unusable', '--intent-hash', 'i', '--by', 'tester']);
  expect(cmd.exitCode).toBe(2);
  expect(cmd.stdout).toContain('task.json does not match the sequencer schema');
});

test('legacy dropped-entry GO + fresh complete-context ABSTAIN never qualifies — the mixed round gates on every derivation until a valid fresh GO exists', async () => {
  // repo A: the pre-upgrade qualifying round produced only an auto-dropped
  // finding (ledger entries present, verdict GO, tally not advanced)
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond({
    verdict: 'GO',
    blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'unfalsifiable worry', evidence: 'math.ts', falsifier: '' }], // no falsifier → auto-dropped
  });
  const firstGate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(firstGate.exitCode).toBe(2);
  expect(firstGate.stdout).toContain('APPROVE BUILD');
  const ledgerPath = join(S(repo), 'ledger.jsonl');
  const ledgerBefore = await readFile(ledgerPath, 'utf8');
  expect(ledgerBefore).toContain('auto-dropped');

  // pre-upgrade state: the recorded round never reviewed the three new members
  for (const f of LEGACY_SNAPSHOTS) rmSync(join(S(repo), f), { force: true });

  // the mandatory fresh complete-context reviewer ABSTAINS (unparseable)
  await stub.respond('I refuse to emit JSON today.');
  const migrate = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(migrate.exitCode).toBe(2);
  expect(migrate.stdout).not.toContain('APPROVE BUILD'); // first derivation escalates

  // second and subsequent derivations: the round now holds MIXED entries
  // (old auto-dropped + fresh abstain) — it must keep gating, never read as GO
  for (let i = 0; i < 2; i++) {
    const again = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
    expect(again.exitCode).toBe(2);
    expect(again.stdout).toContain('abstained');
    expect(again.stdout).not.toContain('APPROVE BUILD');
  }
  // record-approval stays unavailable (the ledger changed after the only presented packet)
  const bypass = await run(repo, ['record-approval', '--by', 'tester', '--decision', 'APPROVE']);
  expect(bypass.exitCode).toBe(3);
  // append-only history intact: the old entries are a byte-prefix of the current ledger
  expect((await readFile(ledgerPath, 'utf8')).startsWith(ledgerBefore)).toBe(true);

  // repo B: identical legacy state, but the fresh complete-context reviewer
  // returns a VALID GO — the normal approval path opens
  const repoB = await makeRepo();
  const stubB = await makeStubReviewer(repoB);
  expect((await run(repoB, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repoB);
  await stubB.respond({
    verdict: 'GO',
    blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'unfalsifiable worry', evidence: 'math.ts', falsifier: '' }],
  });
  expect((await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli })).stdout).toContain('APPROVE BUILD');
  for (const f of LEGACY_SNAPSHOTS) rmSync(join(S(repoB), f), { force: true });
  await stubB.respond(GO);
  const fresh = await run(repoB, ['next'], { BEN_REVIEWER_CLI: stubB.cli });
  expect(fresh.exitCode).toBe(2);
  expect(fresh.stdout).toContain('APPROVE BUILD');
  await approve(repoB);
});

test('reviewBase persists the PROVED chainHead — a reverted headSha() re-read launders a post-boundary HEAD, the real script does not (discriminating git shim)', async () => {
  const realGit = (await execArgv(['sh', '-c', 'command -v git'], { cwd: '/tmp', timeoutMs: 10_000 })).stdout.trim();

  /** PATH shim: after FLAG exists, the 2nd+ `git rev-parse HEAD` reports ALT. */
  const makeShim = async (): Promise<{ dir: string; flag: string; altFile: string }> => {
    const dir = await makeTmpDir('git-shim-');
    const flag = join(dir, 'flag');
    const altFile = join(dir, 'alt');
    const count = join(dir, 'count');
    await writeFile(
      join(dir, 'git'),
      `#!/bin/sh
if [ -f "${flag}" ] && [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  c=$(cat "${count}" 2>/dev/null || echo 0); c=$((c+1)); printf %s "$c" > "${count}"
  if [ "$c" -ge 2 ]; then cat "${altFile}"; exit 0; fi
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(join(dir, 'git'), 0o755);
    return { dir, flag, altFile };
  };

  const driveChain = async (runScript: string, shim: Awaited<ReturnType<typeof makeShim>>) => {
    const repo = await makeRepo();
    const stub = await makeStubReviewer(repo);
    const env = { BEN_REVIEWER_CLI: stub.cli, PATH: `${shim.dir}:${process.env.PATH ?? ''}` };
    const runVariant = (args: string[]) => execArgv(['node', runScript, ...args, '--repo', repo], { cwd: repo, timeoutMs: 60_000, env });
    expect((await runVariant(['init', '--title', 'test task'])).exitCode).toBe(0);
    await seedPlan(repo, { criteriaCmd: `touch '${shim.flag}'` }); // the LAST chain referee arms the shim
    await writeFile(shim.altFile, `${(await readTask(repo)).base}\n`); // ALT = the (real) base commit
    await stub.respond(GO);
    expect((await runVariant(['next'])).exitCode).toBe(2); // APPROVE gate
    expect((await runVariant(['record-approval', '--by', 'tester', '--decision', 'APPROVE'])).exitCode).toBe(0);
    await commitChange(repo, 'feature');
    const chainHead = (await execArgv([realGit, 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 30_000 })).stdout.trim();
    const r = await runVariant(['next']);
    return { repo, chainHead, alt: (await readTask(repo)).base, out: r, task: await readTask(repo) };
  };

  // the REVERTED implementation (sha: headSha() re-read) — run from a byte-copy
  // of the scripts tree so the real referee scripts are never modified
  const copyRoot = await makeTmpDir('run-reverted-');
  await execArgv(['cp', '-R', fileURLToPath(new URL('../scripts', import.meta.url)), join(copyRoot, 'scripts')], { cwd: '/tmp', timeoutMs: 30_000 });
  await execArgv(['cp', '-R', fileURLToPath(new URL('../prompts', import.meta.url)), join(copyRoot, 'prompts')], { cwd: '/tmp', timeoutMs: 30_000 });
  await execArgv(['cp', '-R', fileURLToPath(new URL('../schemas', import.meta.url)), join(copyRoot, 'schemas')], { cwd: '/tmp', timeoutMs: 30_000 });
  await execArgv(['cp', '-R', fileURLToPath(new URL('../references', import.meta.url)), join(copyRoot, 'references')], { cwd: '/tmp', timeoutMs: 30_000 });
  const revertedRun = join(copyRoot, 'scripts', 'run.mjs');
  const src = await readFile(revertedRun, 'utf8');
  const reverted = src.replace('sha: chainHead,', 'sha: headSha(),');
  expect(reverted).not.toBe(src); // the revert actually applied
  await writeFile(revertedRun, reverted);

  const bad = await driveChain(revertedRun, await makeShim());
  // the historical bug reproduces: the post-boundary observation is laundered all
  // the way to a PR intent at a HEAD the chain never judged
  expect(bad.task.reviewBase?.sha).toBe(bad.alt);
  expect(bad.task.prIntent?.headSha).toBe(bad.alt);
  expect(bad.out.stdout).toContain('gh pr create');

  // the real script: reviewBase is the proved chainHead; the divergent observation
  // is detected downstream and quarantined — nothing is laundered
  const good = await driveChain(RUN, await makeShim());
  expect(good.out.exitCode).toBe(0);
  expect(good.out.stdout).toContain('quarantined');
  expect(good.task.reviewBase).toBeUndefined();
  expect(good.task.prIntent).toBeUndefined();
});

test('grant replay binds the exact canonical identity — no look-alike proof, normalized actor, zero-write refusal', async () => {
  // an old grant at tally 0 can never prove a fabricated consumed intent at tally 1
  const repo = await makeRepo();
  await run(repo, ['init']);
  await seedPlan(repo);
  expect((await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester'])).exitCode).toBe(0);
  const rounds0 = await readRounds(repo);
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify({ ...rounds0, plan: 1 })); // the tally advances past the old grant
  const task = await readTask(repo);
  await writeFile(
    join(S(repo), 'task.json'),
    JSON.stringify({ ...task, grantIntents: [...task.grantIntents, { key: 'tester|plan|2|tally1', consumed: true, grantsBefore: 0, ledgerBefore: 0 }] }, null, 2),
  );
  const ledgerBefore = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  const fabricated = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(fabricated.exitCode).toBe(2);
  expect(fabricated.stdout).toContain('marked consumed but the recorded grant is absent');
  expect((await readRounds(repo)).grants).toHaveLength(1); // only the old grant — nothing new landed
  expect(await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);

  // actor whitespace normalizes identically at key, referee, durable write,
  // and replay — the genuine grant replays idempotently under either spelling
  const repo2 = await makeRepo();
  await run(repo2, ['init']);
  await seedPlan(repo2);
  expect((await run(repo2, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', '  tester  '])).exitCode).toBe(0);
  expect((await readRounds(repo2)).grants[0].by).toBe('tester'); // durably normalized
  const bytesRounds = await readFile(join(S(repo2), 'rounds.json'), 'utf8');
  const bytesLedger = await readFile(join(S(repo2), 'ledger.jsonl'), 'utf8');
  for (const by of ['tester', '  tester  ']) {
    const replay = await run(repo2, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', by]);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain('no-op');
    expect(await readFile(join(S(repo2), 'rounds.json'), 'utf8')).toBe(bytesRounds); // byte-identical
    expect(await readFile(join(S(repo2), 'ledger.jsonl'), 'utf8')).toBe(bytesLedger);
  }
});

test('legacy whitespace-keyed grant intents replay by normalized identity — never a second authorization; ambiguity STOPs', async () => {
  // legacy consumed intent + exact landed grant → byte-identical idempotent no-op
  const repo = await makeRepo();
  await run(repo, ['init']);
  await seedPlan(repo);
  expect((await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester'])).exitCode).toBe(0);
  const task = await readTask(repo);
  expect(task.grantIntents[0].key).toBe('tester|plan|2|tally0'); // (5) new intents are canonical
  const legacy = { ...task.grantIntents[0], key: '  tester  |plan|2|tally0' }; // pre-normalization shape
  await writeFile(join(S(repo), 'task.json'), JSON.stringify({ ...task, grantIntents: [legacy] }, null, 2));
  const bytesTask = await readFile(join(S(repo), 'task.json'), 'utf8');
  const bytesRounds = await readFile(join(S(repo), 'rounds.json'), 'utf8');
  const bytesLedger = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  for (const by of ['tester', '  tester  ']) {
    const replay = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', by]);
    expect(replay.exitCode).toBe(0);
    expect(replay.stdout).toContain('no-op');
    expect(await readFile(join(S(repo), 'task.json'), 'utf8')).toBe(bytesTask); // no new intent, no rewrite
    expect(await readFile(join(S(repo), 'rounds.json'), 'utf8')).toBe(bytesRounds); // never a second grant
    expect(await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).toBe(bytesLedger);
  }

  // the same legacy intent with the durable act rolled back → STOP, zero writes
  const rounds = await readRounds(repo);
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify({ ...rounds, grants: [] }));
  await writeFile(join(S(repo), 'ledger.jsonl'), bytesLedger.split('\n').filter((l) => l !== '' && !l.includes('"granted"')).map((l) => `${l}\n`).join(''));
  const rolledBack = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(rolledBack.exitCode).toBe(2);
  expect(rolledBack.stdout).toContain('marked consumed but the recorded grant is absent');
  expect((await readRounds(repo)).grants ?? []).toHaveLength(0);

  // two intents normalizing to the same identity → ambiguous → STOP, no grant issued
  const repo2 = await makeRepo();
  await run(repo2, ['init']);
  await seedPlan(repo2);
  expect((await run(repo2, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester'])).exitCode).toBe(0);
  const task2 = await readTask(repo2);
  const grantsBefore2 = await readFile(join(S(repo2), 'rounds.json'), 'utf8');
  await writeFile(
    join(S(repo2), 'task.json'),
    JSON.stringify({ ...task2, grantIntents: [{ ...task2.grantIntents[0], key: ' tester |plan|2|tally0' }, { ...task2.grantIntents[0], key: 'tester |plan|2|tally0' }] }, null, 2),
  );
  const ambiguous = await run(repo2, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(ambiguous.exitCode).toBe(2);
  expect(ambiguous.stdout).toContain('ambiguous grant intents');
  expect(await readFile(join(S(repo2), 'rounds.json'), 'utf8')).toBe(grantsBefore2); // no duplicate authorization
});

test('record-grant preflights BEFORE any mutation — invalid or divergent adjudication state leaves task.json byte-identical', async () => {
  const { criterionShaOf, sha256: libSha256 } = await import('../scripts/adjudication.lib.mjs');
  const repo = await makeRepo();
  await run(repo, ['init']);
  await seedPlan(repo);
  const bytesTask = await readFile(join(S(repo), 'task.json'), 'utf8');

  // register-only divergence: a fully valid record that never landed in the ledger
  const criterion = { id: 'C9', statement: 'a human eyeballs it', verification: { method: 'manual' } };
  const record = {
    type: 'adjudication',
    criterionId: 'C9',
    criterionSha: criterionShaOf(criterion),
    criterion,
    approvalActSha: libSha256('some approval bytes'),
    headSha: 'a'.repeat(40),
    decision: 'satisfied',
    ruling: 'checked it by hand',
    by: 'operator',
    at: '2026-08-24T00:00:00.000Z',
  };
  await writeFile(join(S(repo), 'adjudications.json'), `${JSON.stringify([record], null, 2)}\n`);
  const diverged = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(diverged.exitCode).toBe(2);
  expect(diverged.stdout).toContain('the adjudication state is invalid');
  expect(await readFile(join(S(repo), 'task.json'), 'utf8')).toBe(bytesTask); // zero writes — no intent persisted
  expect(existsSync(join(S(repo), 'ledger.jsonl'))).toBe(false);

  // malformed register: same STOP, same zero writes
  await writeFile(join(S(repo), 'adjudications.json'), '{ torn');
  const malformed = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(malformed.exitCode).toBe(2);
  expect(malformed.stdout).toContain('the adjudication state is invalid');
  expect(await readFile(join(S(repo), 'task.json'), 'utf8')).toBe(bytesTask);
});

test('the grant crash matrix is four-armed — a ledger-only half STOPs and never issues a second authorization; both-landed stays idempotent', async () => {
  const repo = await makeRepo();
  await run(repo, ['init']);
  await seedPlan(repo);
  expect((await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester'])).exitCode).toBe(0);
  const task = await readTask(repo);

  // both halves landed, intent hand-reset to unconsumed → idempotent consume, no new grant
  await writeFile(join(S(repo), 'task.json'), JSON.stringify({ ...task, grantIntents: [{ ...task.grantIntents[0], consumed: false }] }, null, 2));
  const bothLanded = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(bothLanded.exitCode).toBe(0);
  expect(bothLanded.stdout).toContain('intent marked consumed, no-op');
  expect((await readRounds(repo)).grants).toHaveLength(1);
  expect((await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).match(/"granted"/g)).toHaveLength(1);

  // LEDGER-ONLY half: rounds.json rolled back, audit act present, intent unconsumed
  const roundsNow = await readRounds(repo);
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify({ ...roundsNow, grants: [] }, null, 2));
  const withIntent = await readTask(repo);
  await writeFile(join(S(repo), 'task.json'), JSON.stringify({ ...withIntent, grantIntents: [{ ...withIntent.grantIntents[0], consumed: false }] }, null, 2));
  const bytesTask = await readFile(join(S(repo), 'task.json'), 'utf8');
  const bytesRounds = await readFile(join(S(repo), 'rounds.json'), 'utf8');
  const bytesLedger = await readFile(join(S(repo), 'ledger.jsonl'), 'utf8');
  const ledgerOnly = await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '2', '--by', 'tester']);
  expect(ledgerOnly.exitCode).toBe(2);
  expect(ledgerOnly.stdout).toContain('rounds.json half is missing');
  // zero writes and, above all, NO second authorization anywhere
  expect(await readFile(join(S(repo), 'task.json'), 'utf8')).toBe(bytesTask);
  expect(await readFile(join(S(repo), 'rounds.json'), 'utf8')).toBe(bytesRounds);
  expect(await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).toBe(bytesLedger);
  expect((await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).match(/"granted"/g)).toHaveLength(1);
});

// --- convergence window: hard caps at the sequencer boundary ---

test('init records the hard review caps: 3× defaults echoed, explicit values honored, a max below its soft budget refused', async () => {
  const repo = await makeRepo();
  const r = await run(repo, ['init', '--title', 'test task']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('plan 3 round(s), hard cap 9; diff 3 round(s), hard cap 9');
  const cfg = (await readTask(repo)).config;
  expect(cfg.planRoundsMax).toBe(9);
  expect(cfg.diffRoundsMax).toBe(9);

  const repo2 = await makeRepo();
  const explicit = await run(repo2, ['init', '--plan-rounds', '2', '--plan-rounds-max', '4', '--diff-rounds-max', '12']);
  expect(explicit.exitCode).toBe(0);
  const cfg2 = (await readTask(repo2)).config;
  expect(cfg2.planRoundsMax).toBe(4);
  expect(cfg2.diffRoundsMax).toBe(12);

  const repo3 = await makeRepo();
  const bad = await run(repo3, ['init', '--plan-rounds-max', '2']);
  expect(bad.exitCode).toBe(3);
  expect(bad.stderr).toContain('--plan-rounds-max must be >= --plan-rounds (3)');
});

test('a durable review gate (rounds.gate) re-presents on resume before any reconcile; only the recorded grant clears it', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  const first = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(first.stdout).toContain('proposal.json'); // round 1 blockers → reconcile instruction

  // crash aftermath: ledger.mjs recorded an exit-2 disposition, run.mjs never presented it
  const rounds = await readRounds(repo);
  rounds.gates = { plan: { round: 1, reason: 'plan review is not converging past the soft budget (blockers rose 1 → 2) — continuing needs a recorded human grant' } };
  await writeFile(join(S(repo), 'rounds.json'), `${JSON.stringify(rounds, null, 2)}\n`);

  const gated = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gated.exitCode).toBe(2);
  expect(gated.stdout).toContain('HUMAN GATE — plan review stopped (recorded at round 1)');
  expect(gated.stdout).toContain('blockers rose 1 → 2');
  // replaying derivation re-presents the same gate — never reconciliation
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);

  expect((await run(repo, ['record-grant', '--kind', 'plan', '--rounds', '1', '--by', 'tester'])).exitCode).toBe(0);
  expect((await readRounds(repo)).gates).toBeUndefined();
  const resumed = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(resumed.stdout).toContain('proposal.json'); // the reconcile flow is reachable again
});

test('a present-but-invalid config hard cap STOPs the review boundary instead of being silently dropped', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  const task = await readTask(repo);
  task.config.planRoundsMax = '9'; // stringly-typed tamper
  await writeFile(join(S(repo), 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  await seedPlan(repo);
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('config.planRoundsMax is present but invalid');
});

test('adopt takes the hard-cap flags: explicit honored + echoed, defaults 3×, below-soft refused', async () => {
  const repo = await makeRepo();
  const base = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();
  await seedPlan(repo);
  const bad = await run(repo, ['adopt', '--base', base, '--by', 'tester', '--confirm', '--plan-rounds-max', '1']);
  expect(bad.exitCode).toBe(3);
  expect(bad.stderr).toContain('--plan-rounds-max must be >= --plan-rounds (3)');

  const ok = await run(repo, ['adopt', '--base', base, '--by', 'tester', '--confirm', '--plan-rounds', '2', '--plan-rounds-max', '5']);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain('plan 2 round(s), hard cap 5; diff 3 round(s), hard cap 9');
  const cfg = (await readTask(repo)).config;
  expect(cfg.planRoundsMax).toBe(5);
  expect(cfg.diffRoundsMax).toBe(9); // 3× default
});

test('unsafe hard-cap integers are refused at creation: explicit unsafe values and overflowing 3× defaults', async () => {
  const repo = await makeRepo();
  const unsafe = await run(repo, ['init', '--plan-rounds-max', '9007199254740993']);
  expect(unsafe.exitCode).toBe(3);
  expect(unsafe.stderr).toContain('--plan-rounds-max must be a positive integer');

  const overflow = await run(repo, ['init', '--plan-rounds', '4503599627370496']);
  expect(overflow.exitCode).toBe(3);
  expect(overflow.stderr).toContain('too large to default --plan-rounds-max');
});

test('a durable diff review gate re-presents before diff reconciliation and clears only by the diff grant', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  await commitChange(repo, 'feature');
  await stub.respond(NO_GO);
  const first = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(first.stdout).toContain('proposal.json'); // diff round 1 blockers → reconcile instruction

  const rounds = await readRounds(repo);
  rounds.gates = { diff: { round: 1, reason: 'diff review is not converging past the soft budget MARKER-D' } };
  await writeFile(join(S(repo), 'rounds.json'), `${JSON.stringify(rounds, null, 2)}\n`);

  const gated = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(gated.exitCode).toBe(2);
  expect(gated.stdout).toContain('HUMAN GATE — diff review stopped (recorded at round 1)');
  expect(gated.stdout).toContain('MARKER-D');

  expect((await run(repo, ['record-grant', '--kind', 'diff', '--rounds', '1', '--by', 'tester'])).exitCode).toBe(0);
  expect((await readRounds(repo)).gates).toBeUndefined();
  const resumed = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(resumed.stdout).toContain('proposal.json');
});

test('a legacy task (no hard caps in config) never auto-continues; a modern task forwards --cap-max to the referee', async () => {
  // legacy: caps deliberately absent → the pre-convergence exhausted gate, verbatim
  const legacy = await makeRepo();
  const stubL = await makeStubReviewer(legacy);
  expect((await run(legacy, ['init', '--plan-rounds', '1'])).exitCode).toBe(0);
  const task = await readTask(legacy);
  delete task.config.planRoundsMax;
  delete task.config.diffRoundsMax;
  await writeFile(join(S(legacy), 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  await seedPlan(legacy);
  await writeFile(join(S(legacy), 'rounds.json'), JSON.stringify({ plan: 1 })); // one consumed unit (bounce shape)
  await stubL.respond(NO_GO);
  const l = await run(legacy, ['next'], { BEN_REVIEWER_CLI: stubL.cli });
  expect(l.exitCode).toBe(2);
  expect(l.stdout).toContain('plan rounds exhausted');
  expect(l.stdout).not.toContain('convergence policy');

  // modern: same shape, caps present → the referee received --cap-max and ran the policy (fail-closed on the unknowable bounce)
  const modern = await makeRepo();
  const stubM = await makeStubReviewer(modern);
  expect((await run(modern, ['init', '--plan-rounds', '1'])).exitCode).toBe(0);
  await seedPlan(modern);
  await writeFile(join(S(modern), 'rounds.json'), JSON.stringify({ plan: 1 }));
  await stubM.respond(NO_GO);
  const m = await run(modern, ['next'], { BEN_REVIEWER_CLI: stubM.cli });
  expect(m.exitCode).toBe(2);
  expect(m.stdout).toContain("round 1's surviving-blocker record is missing or invalid");
});

test('raising a hard cap after approval voids it: the changed boundary re-presents the plan gate', async () => {
  const repo = await makeRepo();
  const stub = await makeStubReviewer(repo);
  await toApprovalGate(repo, stub);
  await approve(repo);
  const task = await readTask(repo);
  task.config.planRoundsMax = 12; // the operator's boundary moved — no silent adoption
  await writeFile(join(S(repo), 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('APPROVE BUILD'); // fresh review + fresh approval, never the old binding
  expect(r.stdout).toContain('"planRoundsMax":12');
});

test('status names a standing review gate and calls out a malformed one as illegal state', async () => {
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify({ plan: 1, gates: { plan: { round: 1, reason: 'stop MARKER-S' } } }));
  const standing = await run(repo, ['status']);
  expect(standing.exitCode).toBe(0);
  expect(standing.stdout).toContain('review gate standing (plan): recorded at round 1 — stop MARKER-S');

  await writeFile(join(S(repo), 'rounds.json'), JSON.stringify({ plan: 1, gates: { plan: { round: 1, reason: '' } } }));
  const malformed = await run(repo, ['status']);
  expect(malformed.exitCode).toBe(0); // status stays read-only and honest — never a crash, never a cosmetic pass
  expect(malformed.stdout).toContain('rounds.gates: MALFORMED');
});
