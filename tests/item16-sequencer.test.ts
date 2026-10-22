import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { waitingState } from '../scripts/adjudication.lib.mjs';
import { commitChange, git, makeFixtureRepo, makeTmpDir } from './helpers';

// Sequencer result contract, model-stop binding, PR retry, supervisor-stop, limit,
// gate binding, answer surface, D3, contention, status --json.

const RUN = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../scripts/stop-hook.mjs', import.meta.url));
const S = (repo: string) => join(repo, '.ben');

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

async function hook(repo: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(['node', HOOK], { cwd: repo, stdin: Buffer.from(JSON.stringify({ cwd: repo })), stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
}

async function makeStubReviewer(): Promise<{ cli: string; respond: (v: unknown) => Promise<void> }> {
  const dir = await makeTmpDir('item16-stub-');
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

async function seedPlan(repo: string): Promise<void> {
  const s = S(repo);
  await writeFile(join(s, 'plan.md'), '# plan\n\nbuild the thing\n');
  await writeFile(join(s, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } }] }, null, 2));
  await writeFile(join(s, 'promises.json'), '[]');
  await writeFile(join(s, 'plan-files.json'), JSON.stringify(['math.ts']));
  await writeFile(join(s, 'gates.json'), JSON.stringify({ smoke: 'true' }, null, 2));
}

/** init → plan → GO → approve: returns after the approval is recorded. */
async function toApproved(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>): Promise<void> {
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  const r = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('APPROVE BUILD');
  const a = await run(repo, ['record-approval', '--by', 'operator', '--decision', 'APPROVE']);
  expect(a.exitCode).toBe(0);
}

// ---------------------------------------------------------------------------
// a dirty-worktree model-stop park is CURRENT and the hook blocks

test('F-07: the dirty-worktree stop parks a CURRENT model-owned note; the Stop hook blocks; a clean tree makes it stale', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  await toApproved(repo, stub);
  await commitChange(repo, 'impl'); // commits exist → verification chain is next
  await writeFile(join(repo, 'dirty.txt'), 'uncommitted\n'); // a dirty tree
  const r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect((await readResult(repo)).guidance).toBe('verification');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('the worktree is dirty');
  const w = JSON.parse(await readFile(join(S(repo), 'waiting.json'), 'utf8'));
  expect(w.kind).toBe('model-stop');
  expect(w.owner).toBe('model');
  expect(typeof w.inputsDigest).toBe('string');
  expect(typeof w.binding.headSha).toBe('string');
  const ws = waitingState(S(repo), repo);
  expect(ws.state).toBe('current');
  // the hook BLOCKS a current model-owned park (ben still owes the tidy-up)
  const h = await hook(repo);
  expect(h.exitCode).toBe(0);
  expect(JSON.parse(h.stdout.trim().split('\n').pop() ?? '{}').decision).toBe('block');
  // status classifies it as ben's follow-up, not the operator's
  const st = await run(repo, ['status']);
  expect(st.stdout).toContain('ben HAS FOLLOW-UP WORK PARKED');
  // tidying the tree changes the git identity → the note is stale, next re-derives
  await git(repo, 'add', 'dirty.txt');
  await git(repo, 'commit', '-m', 'chore: tidy');
  expect(waitingState(S(repo), repo).state).toBe('stale');
  expect(existsSync(join(S(repo), 'WAITING.md'))).toBe(true);
});

// ---------------------------------------------------------------------------
// helpers for the matrix

const readTask = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'task.json'), 'utf8'));
const readResult = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'last-next.json'), 'utf8'));
const readWaiting = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'waiting.json'), 'utf8'));
const NO_GO = {
  verdict: 'NO_GO',
  blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' }],
};

async function writeAssignment(repo: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const p = join(repo, 'assignment.json');
  const base = {
    publication: { repo: 'owner/repo', remote: 'origin', base: 'main', baseSha: 'deadbeef', branch: 'ben/thing', mode: 'create' },
    limits: { usd: 25, hours: 8, stretches: 40 },
    allowDomains: [],
    researchDomains: [],
    allowNetworkGates: false,
    operator: 'operator',
    ...overrides,
  };
  await writeFile(p, JSON.stringify(base));
  return p;
}

/** Drive to a pending PR intent under --json: returns the publish result. */
async function toPublish(repo: string, stub: Awaited<ReturnType<typeof makeStubReviewer>>): Promise<Record<string, unknown>> {
  await toApproved(repo, stub);
  await commitChange(repo, 'impl');
  await stub.respond(GO);
  const r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('Create the PR');
  const res = await readResult(repo);
  expect(res.outcome).toBe('publish');
  return res;
}

// ---------------------------------------------------------------------------
// the result contract: every exit site maps to one outcome

test('result contract: instruction, park (with gate id), reenter, publish, terminal, contention, usage-error land in last-next.json bound to the invocation', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  // instruction (write the plan)
  let r = await run(repo, ['next', '--json'], { BEN_NEXT_INVOCATION: 'inv-1' });
  expect(r.exitCode).toBe(0);
  let res = await readResult(repo);
  expect(res.outcome).toBe('instruction');
  expect(res.invocation).toBe('inv-1');
  expect(res.exit).toBe(0);
  expect(res.instruction).toContain('Write the plan artifacts');
  expect(res.guidance).toBe('plan');
  expect(r.stdout).toContain('references/plan.md');
  // park (approval gate) with a gate id equal to the authoritative task.gate
  await seedPlan(repo);
  await stub.respond(GO);
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli, BEN_NEXT_INVOCATION: 'inv-2' });
  expect(r.exitCode).toBe(2);
  res = await readResult(repo);
  expect(res.outcome).toBe('park');
  expect(res.kind).toBe('approval');
  expect(res.owner).toBe('human');
  expect(res.projection).toBe('ok');
  const task = await readTask(repo);
  expect(task.gate.id).toBe(res.gateId);
  expect(task.gate.kind).toBe('approval');
  expect(task.gate.seq).toBe(1);
  expect(typeof task.assignmentId).toBe('string');
  const w = await readWaiting(repo);
  expect(w.gateId).toBe(task.gate.id);
  expect(w.options[0].command).toContain(`--expect-gate ${task.gate.id}`);
  // only `next --json` writes the handoff file: a record command with --json leaves it untouched
  r = await run(repo, ['record-approval', '--json', '--by', 'operator'], { BEN_NEXT_INVOCATION: 'inv-3' });
  expect(r.exitCode).toBe(3);
  expect((await readResult(repo)).invocation).toBe('inv-2');
  // usage-error: a `next --json` whose invocation itself is wrong (git unusable) → exit 3, outcome usage-error
  const headRef = await readFile(join(repo, '.git', 'HEAD'), 'utf8');
  await writeFile(join(repo, '.git', 'HEAD'), 'garbage\n');
  r = await run(repo, ['next', '--json'], { BEN_NEXT_INVOCATION: 'inv-3' });
  expect(r.exitCode).toBe(3);
  res = await readResult(repo);
  expect(res.outcome).toBe('usage-error');
  expect(res.invocation).toBe('inv-3');
  await writeFile(join(repo, '.git', 'HEAD'), headRef);
  rmSyncSafe(join(S(repo), '.run-lock'));
  // no --json → the file is not rewritten (stale one still names inv-3)
  await run(repo, ['status']);
  expect((await readResult(repo)).invocation).toBe('inv-3');
  // contention: a live foreign runner lock
  await writeFile(join(S(repo), 'runner.lock'), String(process.pid));
  r = await run(repo, ['next', '--json'], { BEN_NEXT_INVOCATION: 'inv-4' });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('owns this task');
  res = await readResult(repo);
  expect(res.outcome).toBe('contention');
  expect(res.holder).toBe('runner');
  // the same lock with BEN_RUNNER_PID matching is not contention
  r = await run(repo, ['next', '--json'], { BEN_NEXT_INVOCATION: 'inv-5', BEN_RUNNER_PID: String(process.pid) });
  expect(r.exitCode).toBe(2);
  expect((await readResult(repo)).outcome).toBe('park');
  await writeFile(join(S(repo), 'runner.lock'), '999999'); // dead pid: never contention
  r = await run(repo, ['next', '--json'], { BEN_NEXT_INVOCATION: 'inv-6' });
  expect((await readResult(repo)).outcome).toBe('park');
  rmSyncSafe(join(S(repo), 'runner.lock'));
  // publish + terminal
  const a = await run(repo, ['record-approval', '--by', 'operator', '--decision', 'APPROVE']);
  expect(a.exitCode).toBe(0);
  await commitChange(repo, 'impl');
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli, BEN_NEXT_INVOCATION: 'inv-7' });
  expect(r.exitCode).toBe(0);
  res = await readResult(repo);
  expect(res.outcome).toBe('publish');
  expect(res.publication.mode).toBe('create');
  expect(res.publication.attempt).toBe(1);
  expect(res.publication.headSha).toBe((await readTask(repo)).prIntent.headSha);
  // reenter: a HEAD move after the reviewBase is recorded → "changed code returns to gates"
  const t2 = await readTask(repo);
  await commitChange(repo, 'late');
  // the pending intent governs first (pr-pending, model) — a park
  r = await run(repo, ['next', '--json'], { BEN_NEXT_INVOCATION: 'inv-8' });
  expect(r.exitCode).toBe(2);
  res = await readResult(repo);
  expect(res.outcome).toBe('park');
  expect(res.kind).toBe('pr-pending');
  expect(res.owner).toBe('model');
  expect(t2.prIntent.attempt).toBe(1);
});

function rmSyncSafe(p: string): void {
  try {
    (require('node:fs') as typeof import('node:fs')).rmSync(p, { force: true });
  } catch {
    /* absent */
  }
}

test('result contract: a "re-run next" exit is a reenter outcome', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  await toApproved(repo, stub);
  await commitChange(repo, 'impl');
  // the diff reviewer sees a NO_GO but HEAD moves while it runs → quarantine → reenter
  // simulate: stub responds GO, but we move HEAD between chain and review by a gate command? Simpler:
  // record a reviewBase, then commit, then next → the pending verdict path is absent; use the
  // "approval changed after GO" reenter instead: approve, GO, then edit an artifact before next.
  await stub.respond(GO);
  const r1 = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r1.exitCode).toBe(0);
  expect((await readResult(repo)).outcome).toBe('publish');
  // a commit after the intent: pending intent governs (park), not reenter — so instead test the
  // quarantine reenter through a mid-review artifact change on the PLAN side
  const repo2 = await makeRepo();
  expect((await run(repo2, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo2);
  // a stub that edits plan.md while "reviewing" → artifacts changed mid-review → reenter
  const dir = await makeTmpDir('item16-editstub-');
  const cli = join(dir, 'cli');
  await writeFile(cli, `#!/bin/sh\necho '# plan\\n\\nedited mid-review' > "${join(S(repo2), 'plan.md')}"\nout=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\nprintf '%s' '${JSON.stringify(GO)}' > "$out"\n`);
  chmodSync(cli, 0o755);
  const r2 = await run(repo2, ['next', '--json'], { BEN_REVIEWER_CLI: cli });
  expect(r2.exitCode).toBe(0);
  expect(r2.stdout).toContain('quarantined');
  expect((await readResult(repo2)).outcome).toBe('reenter');
});

// ---------------------------------------------------------------------------
// gate binding: --expect-gate compares to the AUTHORITATIVE record

test('gate binding: a superseded gate id is refused with zero writes and the new question shown; a forged projection id cannot satisfy the check', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  const first = (await readTask(repo)).gate.id;
  // the plan changes → the packet is re-presented under a NEW occurrence
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the thing, differently\n');
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  const second = (await readTask(repo)).gate;
  expect(second.id).not.toBe(first);
  expect(second.seq).toBe(2);
  const before = await readFile(join(S(repo), 'task.json'), 'utf8');
  const stale = await run(repo, ['answer', '--expect-gate', first, '--choose', 'approve', '--by', 'operator']);
  expect(stale.exitCode).toBe(1);
  expect(stale.stdout).toContain('the question changed since it was shown to you');
  expect(stale.stdout).toContain(second.id);
  expect(await readFile(join(S(repo), 'task.json'), 'utf8')).toBe(before);
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false);
  // forging the projection's gateId to the old value does not help: the oracle compares to task.gate
  const w = await readWaiting(repo);
  w.gateId = first;
  await writeFile(join(S(repo), 'waiting.json'), JSON.stringify(w));
  const forged = await run(repo, ['answer', '--expect-gate', first, '--choose', 'approve', '--by', 'operator']);
  expect(forged.exitCode).toBe(1);
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false);
  // the current id lands exactly once
  await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli }); // republish a clean projection
  const cur = (await readTask(repo)).gate.id;
  const ok = await run(repo, ['answer', '--expect-gate', cur, '--choose', 'approve', '--by', 'operator']);
  expect(ok.exitCode).toBe(0);
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(true);
  const late = await run(repo, ['answer', '--expect-gate', cur, '--choose', 'approve', '--by', 'operator']);
  expect(late.exitCode).toBe(1);
  expect(late.stdout).toContain('already answered');
  expect(late.stdout).toContain('approved by operator');
});

// ---------------------------------------------------------------------------
// inspection → ordered transition table → human retry gate

test('F-08: inspection "nothing pushed, no PR" parks pr-retry (human); retry lands once, replays refuse, and exactly one fresh publish follows', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  await toPublish(repo, stub);
  const t = await readTask(repo);
  const intentHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(t.prIntent)).digest('hex');
  // the model-owned pending park (no inspection yet)
  let r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(2);
  expect((await readResult(repo)).kind).toBe('pr-pending');
  // a wrong intent hash is refused
  const bad = await run(repo, ['record-pr-inspection', '--branch', 'absent', '--pr', 'absent', '--intent-hash', 'f'.repeat(64), '--by', 'ben-runner']);
  expect(bad.exitCode).toBe(2);
  // the observation act
  const insp = await run(repo, ['record-pr-inspection', '--branch', 'absent', '--pr', 'absent', '--intent-hash', intentHash, '--by', 'ben-runner']);
  expect(insp.exitCode).toBe(0);
  r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(2);
  const res = await readResult(repo);
  expect(res.kind).toBe('pr-retry');
  expect(res.owner).toBe('human');
  expect(waitingState(S(repo), repo).state).toBe('current');
  const w = await readWaiting(repo);
  expect(w.options.map((o: { token: string }) => o.token)).toEqual(['retry', 'abort']);
  const gateId = (await readTask(repo)).gate.id;
  const ans = await run(repo, ['answer', '--expect-gate', gateId, '--choose', 'retry', '--by', 'operator']);
  expect(ans.exitCode).toBe(0);
  const t2 = await readTask(repo);
  expect(t2.prRetries).toHaveLength(1);
  expect(t2.prRetries[0].inspectionSha).toMatch(/^[0-9a-f]{64}$/);
  // replay refused (spent)
  const again = await run(repo, ['answer', '--expect-gate', gateId, '--choose', 'retry', '--by', 'operator']);
  expect(again.exitCode).toBe(1);
  expect(again.stdout).toContain('retry authorized by operator');
  // exactly one fresh publish, attempt 2, then the pending gate again (no second consumption)
  r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(0);
  const pub = await readResult(repo);
  expect(pub.outcome).toBe('publish');
  expect(pub.publication.attempt).toBe(2);
  const t3 = await readTask(repo);
  expect(t3.prIntent.attempt).toBe(2);
  expect(t3.prAttempts).toHaveLength(1);
  expect(t3.prRetries[0].consumedByAttempt).toBe(2);
  r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(2);
  expect((await readResult(repo)).kind).toBe('pr-pending'); // a new intent: no inspection yet
});

test('F-08: a newer inspection supersedes an unconsumed retry; "PR exists at the reviewed head" routes to pr-record (model); another head → pr-head-mismatch; branch at other sha → pr-branch-conflict', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  await toPublish(repo, stub);
  const t = await readTask(repo);
  const intentHash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(t.prIntent)).digest('hex');
  const head = t.prIntent.headSha as string;
  // branch pushed, no PR → pr-retry; human authorizes
  expect((await run(repo, ['record-pr-inspection', '--branch', 'at-sha', '--pr', 'absent', '--intent-hash', intentHash, '--by', 'ben-runner'])).exitCode).toBe(0);
  expect((await run(repo, ['next', '--json'])).exitCode).toBe(2);
  expect((await readResult(repo)).kind).toBe('pr-retry');
  expect((await run(repo, ['answer', '--expect-gate', (await readTask(repo)).gate.id, '--choose', 'retry', '--by', 'operator'])).exitCode).toBe(0);
  // BEFORE the retry is consumed, a re-inspection finds the PR at the reviewed head: the fact governs, the retry stays unconsumed
  expect((await run(repo, ['record-pr-inspection', '--branch', 'at-sha', '--pr', 'exists', '--url', 'https://github.com/o/r/pull/7', '--pr-head', head, '--intent-hash', intentHash, '--by', 'ben-runner'])).exitCode).toBe(0);
  let r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(2);
  let res = await readResult(repo);
  expect(res.kind).toBe('pr-record');
  expect(res.owner).toBe('model');
  expect((await readTask(repo)).prIntent.attempt).toBe(1); // NOT consumed
  expect((await readTask(repo)).prRetries[0].consumedByAttempt).toBeUndefined();
  // answer refuses a model-owned park
  const refused = await run(repo, ['answer', '--choose', 'retry', '--by', 'operator']);
  expect(refused.exitCode).toBe(1);
  // the PR moves to another head → human mismatch gate with retry/abort
  expect((await run(repo, ['record-pr-inspection', '--branch', 'other', '--pr', 'exists', '--url', 'https://github.com/o/r/pull/7', '--pr-head', 'a'.repeat(40), '--intent-hash', intentHash, '--by', 'ben-runner'])).exitCode).toBe(0);
  r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(2);
  res = await readResult(repo);
  expect(res.kind).toBe('pr-head-mismatch');
  expect(res.owner).toBe('human');
  expect(waitingState(S(repo), repo).state).toBe('current');
  // the old retry (bound to the at-sha inspection) is inert here: answer retry now records a NEW authorization bound to this inspection
  expect((await run(repo, ['answer', '--expect-gate', (await readTask(repo)).gate.id, '--choose', 'retry', '--by', 'operator'])).exitCode).toBe(0);
  expect((await readTask(repo)).prRetries).toHaveLength(2);
  r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(0);
  res = await readResult(repo);
  expect(res.outcome).toBe('publish');
  expect(res.publication.mode).toBe('update'); // an existing PR at another head is UPDATED, never a second PR
  expect(res.publication.prUrl).toBe('https://github.com/o/r/pull/7');
  const t2 = await readTask(repo);
  expect(t2.prIntent.attempt).toBe(2);
  expect(t2.prRetries.filter((x: { consumedByAttempt?: number }) => x.consumedByAttempt === 2)).toHaveLength(1);
  // branch conflict: someone else's commit, no PR
  const intent2 = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(t2.prIntent)).digest('hex');
  expect((await run(repo, ['record-pr-inspection', '--branch', 'other', '--pr', 'absent', '--intent-hash', intent2, '--by', 'ben-runner'])).exitCode).toBe(0);
  r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(2);
  res = await readResult(repo);
  expect(res.kind).toBe('pr-branch-conflict');
  expect(res.owner).toBe('human');
  const conflictTokens = (await readWaiting(repo)).options.map((o: { token: string }) => o.token);
  expect(conflictTokens).toEqual(['reinspect', 'abort']);
  const notAnswer = await run(repo, ['answer', '--expect-gate', (await readTask(repo)).gate.id, '--choose', 'reinspect', '--by', 'operator']);
  expect(notAnswer.exitCode).toBe(3); // reinspect is the runner's observation act, never an answer
});

// ---------------------------------------------------------------------------
// supervisor stop and limit gates rank above the plan phase

test('supervisor-stop and limit: recorded by the runner, parked for the human above every plan gate, resolved exactly once; a continue without an amount is refused', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2); // approval gate parked
  // a supervisor stop arrives: the approval note goes stale (precedence)
  expect((await run(repo, ['record-supervisor-stop', '--reason', 'ben tried "write the plan" 3 times without progress', '--by', 'ben-runner'])).exitCode).toBe(0);
  expect(waitingState(S(repo), repo).state).toBe('stale');
  let r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  let res = await readResult(repo);
  expect(res.kind).toBe('supervisor-stop');
  expect(res.owner).toBe('playbook');
  // the Stop hook releases a playbook park
  expect((await hook(repo)).stdout).toContain('parked for the human');
  // a second stop while one is open is a no-op
  expect((await run(repo, ['record-supervisor-stop', '--reason', 'again', '--by', 'ben-runner'])).stdout).toContain('already open');
  expect((await readTask(repo)).supervisorStops).toHaveLength(1);
  const g1 = (await readTask(repo)).gate.id;
  const cont = await run(repo, ['answer', '--expect-gate', g1, '--choose', 'continue', '--note', 'try reading the brief first', '--by', 'operator']);
  expect(cont.exitCode).toBe(0);
  expect((await readTask(repo)).supervisorStops[0].resolution.note).toBe('try reading the brief first');
  expect((await run(repo, ['answer', '--expect-gate', g1, '--choose', 'continue', '--by', 'operator'])).stdout).toContain('already answered');
  // limit event
  expect((await run(repo, ['record-limit', '--kind', 'usd', '--value', '25.4', '--by', 'ben-runner'])).exitCode).toBe(0);
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  res = await readResult(repo);
  expect(res.kind).toBe('limit');
  expect(res.owner).toBe('human');
  expect(res.question).toContain('$25.4');
  const g2 = (await readTask(repo)).gate.id;
  const noAmount = await run(repo, ['answer', '--expect-gate', g2, '--choose', 'continue', '--by', 'operator']);
  expect(noAmount.exitCode).toBe(3);
  expect(noAmount.stderr).toContain('--usd N');
  const wrongFlag = await run(repo, ['answer', '--expect-gate', g2, '--choose', 'continue', '--hours', '2', '--by', 'operator']);
  expect(wrongFlag.exitCode).toBe(3);
  const ext = await run(repo, ['answer', '--expect-gate', g2, '--choose', 'continue', '--usd', '10', '--by', 'operator']);
  expect(ext.exitCode).toBe(0);
  const t = await readTask(repo);
  expect(t.limitExtensions[0]).toMatchObject({ kind: 'usd', amount: 10, by: 'operator', eventId: t.limitEvents[0].id });
  // back to the approval gate
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect((await readResult(repo)).kind).toBe('approval');
  // status --json exposes the actors
  const st = await run(repo, ['status', '--json']);
  const j = JSON.parse(st.stdout);
  expect(j.actors.map((a: { kind: string; by: string }) => `${a.kind}:${a.by}`)).toEqual(expect.arrayContaining(['supervisor-stop:ben-runner', 'supervisor-stop-resolution:operator', 'limit-event:ben-runner', 'limit-extension:operator']));
  expect(j.waiting.state).toBe('current');
  expect(j.waiting.kind).toBe('approval');
});

// ---------------------------------------------------------------------------
// revise, fix-cap continue, manual adjudication, clarify

test('approval revise: notes recorded, a standing approval superseded (A→B→A cannot resurrect), the driver instructed, the packet carries the notes and stamps them presented', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  // approve A
  await toApproved(repo, stub);
  const approvalA = await readFile(join(S(repo), 'approval.json'), 'utf8');
  // change to B → the gate re-presents
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nplan B\n');
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  const gB = (await readTask(repo)).gate.id;
  const noNotes = await run(repo, ['answer', '--expect-gate', gB, '--choose', 'revise', '--by', 'operator']);
  expect(noNotes.exitCode).toBe(3);
  const rev = await run(repo, ['answer', '--expect-gate', gB, '--choose', 'revise', '--reply', 'keep it read-only; no CLI flags yet', '--by', 'operator']);
  expect(rev.exitCode).toBe(0);
  const t = await readTask(repo);
  expect(t.revisions).toHaveLength(1);
  expect(t.revisions[0].notes).toBe('keep it read-only; no CLI flags yet');
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false); // A's approval superseded (moved, not deleted)
  expect(existsSync(join(S(repo), t.revisions[0].supersededApproval))).toBe(true);
  expect(await readFile(join(S(repo), t.revisions[0].supersededApproval), 'utf8')).toBe(approvalA);
  // unchanged B bytes → the driver is instructed with the notes verbatim
  let r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('asked for changes');
  expect(r.stdout).toContain('keep it read-only; no CLI flags yet');
  // restore A: implementation must NOT start — the plan phase governs again, the packet
  // carries the notes (a different-hash packet presents them and stamps presentedAt)
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the thing\n');
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect((await readResult(repo)).kind).toBe('approval');
  expect(r.stdout).not.toContain('No commits');
  expect(r.stdout).toContain('revision requests answered by this packet');
  expect(r.stdout).toContain('keep it read-only; no CLI flags yet');
  expect((await readTask(repo)).revisions[0].presentedAt).toBeDefined();
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false);
});

test('fix-cap continue: one more attempt for a verify step is recorded and honoured by the replay branch and the referee cap; the commits strike gets a sequencer-owned one-more-attempt grant', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task', '--gate-fixes', '1'])).exitCode).toBe(0);
  await seedPlan(repo);
  await writeFile(join(S(repo), 'gates.json'), JSON.stringify({ red: 'test -f ok.txt' }));
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  expect((await run(repo, ['record-approval', '--by', 'operator', '--decision', 'APPROVE'])).exitCode).toBe(0);
  await commitChange(repo, 'impl');
  // attempt 1 red (exit 1), attempt 2 exceeds cap 1 → fix-cap park with continue/abort
  let r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(1);
  await commitChange(repo, 'try-again');
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  let res = await readResult(repo);
  expect(res.kind).toBe('fix-cap');
  expect((await readWaiting(repo)).options.map((o: { token: string }) => o.token)).toEqual(['continue', 'abort']);
  const g = (await readTask(repo)).gate.id;
  expect((await run(repo, ['answer', '--expect-gate', g, '--choose', 'continue', '--by', 'operator'])).exitCode).toBe(0);
  expect((await readTask(repo)).fixGrants).toEqual([expect.objectContaining({ step: 'gates', tallyAt: 2, by: 'operator' })]);
  // same state: the replay branch now says "fix and re-run" (exit 1) instead of parking
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(1);
  expect((await readResult(repo)).outcome).toBe('instruction');
  // the fix lands: the referee runs with the raised cap and goes green
  await writeFile(join(repo, 'ok.txt'), 'ok\n');
  await git(repo, 'add', 'ok.txt');
  await git(repo, 'commit', '-m', 'fix: add ok');
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect((await readResult(repo)).outcome).toBe('publish');
  // commits strike cap: continue is a sequencer-owned one-more-attempt grant; the referee's verdict and tally stand
  const repo2 = await makeRepo();
  await toApproved(repo2, stub);
  expect((await run(repo2, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(1); // No commits (strike 1)
  await writeFile(join(repo2, 'wip.txt'), 'uncommitted\n'); // a state change without a commit → the referee runs again (strike 2 escalates)
  const r2 = await run(repo2, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r2.exitCode).toBe(2);
  expect((await readWaiting(repo2)).options.map((o: { token: string }) => o.token)).toEqual(['continue', 'abort']);
  const g2 = (await readTask(repo2)).gate.id;
  expect((await run(repo2, ['answer', '--expect-gate', g2, '--choose', 'continue', '--by', 'operator'])).exitCode).toBe(0);
  expect((await readTask(repo2)).fixGrants).toEqual([expect.objectContaining({ step: 'commits', tallyAt: 2 })]);
  const rounds2 = JSON.parse(await readFile(join(S(repo2), 'rounds.json'), 'utf8'));
  expect(rounds2.implement).toBe(2); // the referee's tally is untouched
  // same state: the replay says fix (and names the commit requirement)
  const again = await run(repo2, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(again.exitCode).toBe(1);
  expect(again.stdout).toContain('COMMIT your changes');
  // the driver commits → the chain proceeds to publish
  await git(repo2, 'add', 'wip.txt');
  await git(repo2, 'commit', '-m', 'feat: wip');
  const pub = await run(repo2, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(pub.exitCode).toBe(0);
  expect((await readResult(repo2)).outcome).toBe('publish');
}, { timeout: 30_000 });

test('manual adjudication via answer: satisfied/accepted with the ruling in plain words; accepted requires a residual; multiple pending need --criterion', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await writeFile(
    join(S(repo), 'criteria.json'),
    JSON.stringify({
      taskId: 'T1',
      criteria: [
        { id: 'C1', statement: 'the thing works', verification: { method: 'command', command: 'true' } },
        { id: 'C2', statement: 'the other thing works', verification: { method: 'command', command: 'true' } },
        { id: 'C3', statement: 'the third thing works', verification: { method: 'command', command: 'true' } },
        { id: 'C4', statement: 'the docs read well', verification: { method: 'manual' } },
      ],
    }),
  );
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  expect((await run(repo, ['record-approval', '--by', 'operator', '--decision', 'APPROVE'])).exitCode).toBe(0);
  await commitChange(repo, 'impl');
  let r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect((await readResult(repo)).kind).toBe('manual-adjudication');
  const g = (await readTask(repo)).gate.id;
  expect((await run(repo, ['answer', '--expect-gate', g, '--choose', 'satisfied', '--by', 'operator'])).exitCode).toBe(3); // no reply
  expect((await run(repo, ['answer', '--expect-gate', g, '--choose', 'accepted', '--reply', 'fine', '--by', 'operator'])).exitCode).toBe(3); // no residual
  const ok = await run(repo, ['answer', '--expect-gate', g, '--choose', 'satisfied', '--reply', 'I read the docs, they read fine', '--by', 'operator']);
  expect(ok.exitCode).toBe(0);
  const register = JSON.parse(await readFile(join(S(repo), 'adjudications.json'), 'utf8'));
  expect(register).toHaveLength(1);
  expect(register[0]).toMatchObject({ criterionId: 'C4', decision: 'satisfied', ruling: 'I read the docs, they read fine', by: 'operator' });
  r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0);
  expect((await readResult(repo)).outcome).toBe('publish');
});

test('clarify: questions park a human gate before planning; the reply is recorded once and the driver is instructed to fold it in', async () => {
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await writeFile(join(S(repo), 'questions.json'), JSON.stringify([{ id: 'Q1', question: 'file path, stdin, or both?' }, { id: 'Q2', question: 'plain CLI ok?' }]));
  let r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(2);
  let res = await readResult(repo);
  expect(res.kind).toBe('clarify');
  expect(res.owner).toBe('human');
  expect(res.question).toContain('file path, stdin, or both?');
  const g = (await readTask(repo)).gate.id;
  expect((await run(repo, ['answer', '--expect-gate', g, '--choose', 'reply', '--by', 'operator'])).exitCode).toBe(3);
  const f = join(repo, 'answers.txt');
  await writeFile(f, '1: file path. 2: plain CLI is fine.\n');
  expect((await run(repo, ['answer', '--expect-gate', g, '--choose', 'reply', '--reply-file', f, '--by', 'operator'])).exitCode).toBe(0);
  expect((await readTask(repo)).clarifications).toHaveLength(1);
  r = await run(repo, ['next', '--json']);
  expect(r.exitCode).toBe(0);
  res = await readResult(repo);
  expect(res.outcome).toBe('instruction');
  expect(res.instruction).toContain('Fold the answers');
  expect(res.instruction).toContain('1: file path. 2: plain CLI is fine.');
  // the driver deletes questions.json → normal planning resumes
  rmSyncSafe(join(S(repo), 'questions.json'));
  r = await run(repo, ['next', '--json']);
  expect((await readResult(repo)).instruction).toContain('Write the plan artifacts');
});

// ---------------------------------------------------------------------------
// D3 — the empty veto is skipped ONLY when all six checks hold

test('D3: an all-resolved, unflagged proposal skips the veto gate with a policy decision row; a rejection, a flagged blocker, an abstain or a standing stop keep the human gate', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 'test task'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(NO_GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(0);
  const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
  const fp = blockers[0].fingerprint as string;
  await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'resolved', detail: 'add the add(0,0) test' }]));
  const r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(0); // no gate: straight to "write resolutions.json"
  expect(r.stdout).toContain('skipped by the D3 policy');
  expect((await readResult(repo)).instruction).toContain('resolutions.json');
  const veto = (await readFile(join(S(repo), 'veto.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const decision = veto.find((v) => v.type === 'decision');
  expect(decision).toMatchObject({ kind: 'plan', round: 1, response: { decision: 'confirm' }, by: 'ben-policy:empty-veto', basis: { rule: 'D3-empty-veto' } });
  expect(veto.some((v) => v.type === 'presented')).toBe(true);
  // the packet later renders the decision
  await writeFile(join(S(repo), 'resolutions.json'), JSON.stringify([{ fingerprint: fp, action: 'resolved', detail: 'add the add(0,0) test' }]));
  await writeFile(join(S(repo), 'plan.md'), '# plan\n\nbuild the thing and test add(0,0)\n');
  await git(repo, 'commit', '--allow-empty', '-m', 'chore: nothing');
  await stub.respond(GO); // the revised plan's fresh review round returns GO
  const gateRun = await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli }); // honesty + resolve → pregate → review → approval gate
  expect(gateRun.exitCode).toBe(2);
  expect(gateRun.stdout).toContain('reconcile decisions (veto.jsonl, verbatim)');
  expect(gateRun.stdout).toContain('ben-policy:empty-veto');

  // a REJECTION keeps the human gate
  const repo2 = await makeRepo();
  expect((await run(repo2, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo2);
  await stub.respond(NO_GO);
  await run(repo2, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const b2 = JSON.parse(await readFile(join(S(repo2), 'blockers.json'), 'utf8'));
  await writeFile(join(S(repo2), 'proposal.json'), JSON.stringify([{ fingerprint: b2[0].fingerprint, action: 'rejected', detail: 'not a real gap' }]));
  const g2 = await run(repo2, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(g2.exitCode).toBe(2);
  expect((await readResult(repo2)).kind).toBe('veto');

  // a FLAGGED blocker (prior rejection) keeps the human gate even when all-resolved
  const repo3 = await makeRepo();
  expect((await run(repo3, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo3);
  await stub.respond(NO_GO);
  await run(repo3, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const b3 = JSON.parse(await readFile(join(S(repo3), 'blockers.json'), 'utf8'));
  b3[0].priorRejections = ['deadbeef'];
  await writeFile(join(S(repo3), 'blockers.json'), JSON.stringify(b3, null, 2));
  await writeFile(join(S(repo3), 'proposal.json'), JSON.stringify([{ fingerprint: b3[0].fingerprint, action: 'resolved', detail: 'fix' }]));
  const g3 = await run(repo3, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(g3.exitCode).toBe(2);
  expect((await readResult(repo3)).kind).toBe('veto');

  // an ABSTAIN row for the round keeps the human gate
  const repo4 = await makeRepo();
  expect((await run(repo4, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo4);
  await stub.respond(NO_GO);
  await run(repo4, ['next'], { BEN_REVIEWER_CLI: stub.cli });
  const b4 = JSON.parse(await readFile(join(S(repo4), 'blockers.json'), 'utf8'));
  await (await import('node:fs/promises')).appendFile(
    join(S(repo4), 'ledger.jsonl'),
    `${JSON.stringify({ ts: new Date().toISOString(), kind: 'plan', round: 1, reviewer: 'other', blockerId: '', fingerprint: 'a'.repeat(64), action: 'abstain', detail: 'unparseable' })}\n`,
  );
  await writeFile(join(S(repo4), 'proposal.json'), JSON.stringify([{ fingerprint: b4[0].fingerprint, action: 'resolved', detail: 'fix' }]));
  const g4 = await run(repo4, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(g4.exitCode).toBe(2);
  expect((await readResult(repo4)).kind).toBe('veto');
});

// ---------------------------------------------------------------------------
// init --assignment

test('init --assignment records a strict assignment and refuses malformed ones or a wrong branch; a follow-up dir with only history/ + lineage.json is accepted', async () => {
  const repo = await makeRepo();
  const bad = await writeAssignment(repo, { limits: { usd: -1, hours: 8, stretches: 40 } });
  const r1 = await run(repo, ['init', '--title', 't', '--assignment', bad]);
  expect(r1.exitCode).toBe(3);
  expect(r1.stderr).toContain('assignment.limits');
  const wrongBranch = await writeAssignment(repo);
  const r2 = await run(repo, ['init', '--title', 't', '--assignment', wrongBranch]);
  expect(r2.exitCode).toBe(3);
  expect(r2.stderr).toContain('ben/thing');
  await git(repo, 'checkout', '-b', 'ben/thing');
  mkdirSync(join(S(repo), 'history', '1-old'), { recursive: true });
  await writeFile(join(S(repo), 'lineage.json'), JSON.stringify([{ n: 1 }]));
  const ok = await run(repo, ['init', '--title', 't', '--assignment', wrongBranch]);
  expect(ok.exitCode).toBe(0);
  const t = await readTask(repo);
  expect(t.assignment.publication.branch).toBe('ben/thing');
  expect(t.assignment.operator).toBe('operator');
  // the option commands print the runner surface with the gate id
  expect((await run(repo, ['next'])).exitCode).toBe(0);
  await seedPlan(repo);
  const stub = await makeStubReviewer();
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  const w = await readWaiting(repo);
  expect(w.options[0].command).toContain('runner.mjs');
  expect(w.options[0].command).toContain(`--gate ${(await readTask(repo)).gate.id}`);
  expect(w.options[0].command).not.toContain('{{GATE}}');
  const dirty = await makeRepo();
  mkdirSync(S(dirty), { recursive: true });
  await writeFile(join(S(dirty), 'stray.txt'), 'x');
  const r3 = await run(dirty, ['init', '--title', 't']);
  expect(r3.exitCode).toBe(2);
});

// ---------------------------------------------------------------------------
// corrections — binding, precedence, D3 strictness, handoff hygiene, schema

test('gate binding: a projection rewritten to another question while keeping the presented id is stale; a runner task never presents without an id', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  await git(repo, 'checkout', '-b', 'ben/thing');
  const a = await writeAssignment(repo);
  expect((await run(repo, ['init', '--title', 't', '--assignment', a])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  expect(waitingState(S(repo), repo).state).toBe('current');
  const w = await readWaiting(repo);
  // keep the id, retarget the binding
  await writeFile(join(S(repo), 'waiting.json'), JSON.stringify({ ...w, binding: { ...w.binding, ledgerSha: 'ABSENT' } }));
  expect(waitingState(S(repo), repo).state).toBe('stale');
  // drop the id entirely on a runner-assigned task
  const { gateId, ...noId } = w;
  await writeFile(join(S(repo), 'waiting.json'), JSON.stringify(noId));
  expect(waitingState(S(repo), repo).state).toBe('stale');
  expect(gateId).toBeDefined();
});

test('clarify precedence: questions arriving after an approval park make the approval note stale; answering approve is refused until the questions are answered', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  expect((await run(repo, ['init', '--title', 't'])).exitCode).toBe(0);
  await seedPlan(repo);
  await stub.respond(GO);
  expect((await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli })).exitCode).toBe(2);
  const g = (await readTask(repo)).gate.id;
  await writeFile(join(S(repo), 'questions.json'), JSON.stringify([{ id: 'Q1', question: 'which flavour?' }]));
  expect(waitingState(S(repo), repo).state).toBe('stale');
  const ans = await run(repo, ['answer', '--expect-gate', g, '--choose', 'approve', '--by', 'operator']);
  expect(ans.exitCode).toBe(1);
  expect(existsSync(join(S(repo), 'approval.json'))).toBe(false);
  const r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
  expect(r.exitCode).toBe(2);
  expect((await readResult(repo)).kind).toBe('clarify');
});

test('D3 strictness: malformed flag metadata or a raised row carrying flags keeps the human veto gate', async () => {
  const stub = await makeStubReviewer();
  for (const variant of ['string-respondsTo', 'raised-row-flag'] as const) {
    const repo = await makeRepo();
    expect((await run(repo, ['init', '--title', 't'])).exitCode).toBe(0);
    await seedPlan(repo);
    await stub.respond(NO_GO);
    await run(repo, ['next'], { BEN_REVIEWER_CLI: stub.cli });
    const blockers = JSON.parse(await readFile(join(S(repo), 'blockers.json'), 'utf8'));
    const fp = blockers[0].fingerprint as string;
    if (variant === 'string-respondsTo') {
      blockers[0].respondsTo = 'not-an-array';
      await writeFile(join(S(repo), 'blockers.json'), JSON.stringify(blockers, null, 2));
    } else {
      const lines = (await readFile(join(S(repo), 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      const idx = lines.findIndex((e) => e.action === 'raised' && e.fingerprint === fp);
      lines[idx].priorRejections = ['deadbeef'];
      await writeFile(join(S(repo), 'ledger.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    }
    await writeFile(join(S(repo), 'proposal.json'), JSON.stringify([{ fingerprint: fp, action: 'resolved', detail: 'fix' }]));
    const r = await run(repo, ['next', '--json'], { BEN_REVIEWER_CLI: stub.cli });
    expect(r.exitCode).toBe(2);
    expect((await readResult(repo)).kind).toBe('veto');
  }
});

test('status --json never writes the sequencer handoff file; prIntent.publication is schema-validated', async () => {
  const stub = await makeStubReviewer();
  const repo = await makeRepo();
  await toPublish(repo, stub);
  const before = await readFile(join(S(repo), 'last-next.json'), 'utf8');
  expect((await run(repo, ['status', '--json'])).exitCode).toBe(0);
  expect(await readFile(join(S(repo), 'last-next.json'), 'utf8')).toBe(before);
  const t = await readTask(repo);
  t.prIntent.publication = { mode: 'garbage', prUrl: 7, unexpected: true };
  await writeFile(join(S(repo), 'task.json'), JSON.stringify(t, null, 2));
  const r = await run(repo, ['next']);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('does not match the sequencer schema');
});
