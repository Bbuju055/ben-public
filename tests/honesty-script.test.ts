import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { git, makeTmpDir } from './helpers';

// scripts/honesty.mjs — reconcile evidence, ported from machine.ts
// reconcilePlan()/reconcileDiff()/unresolved()/reconcileRetry().
// One fixture per rule; each red fixture trips only its own rule.

const SCRIPT = fileURLToPath(new URL('../scripts/honesty.mjs', import.meta.url));

async function workspace(files: Record<string, unknown>): Promise<string> {
  const dir = await makeTmpDir('honesty-');
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function honesty(dir: string, ...args: string[]): Promise<ExecResult> {
  return execArgv(['node', SCRIPT, ...args, dir], { cwd: dir, timeoutMs: 30_000 });
}

const blocker = (fingerprint: string) => ({ fingerprint, reviewer: 'codex', id: 'B1' });
const res = (fingerprint: string, action = 'resolved') => ({ fingerprint, action, detail: 'because reasons' });

/** Plan-mode workspace: one open blocker, the five plan artifacts plus their reviewed snapshots. */
function planWorkspace(opts: { changed: boolean; action?: string; planFilesChanged?: boolean; gatesChanged?: boolean; legacySnapshots?: boolean }): Promise<string> {
  const reviewedPlan = '# plan\n\ndo the thing\n';
  const reviewedCriteria = JSON.stringify({ taskId: 'T1', criteria: [] }, null, 2);
  const reviewedPlanFiles = JSON.stringify(['src/x.ts'], null, 2);
  const reviewedGates = JSON.stringify({ test: 'bun test' }, null, 2);
  return workspace({
    'blockers.json': [blocker('fp1')],
    'resolutions.json': [res('fp1', opts.action ?? 'resolved')],
    'plan.reviewed.md': reviewedPlan,
    'criteria.reviewed.json': reviewedCriteria,
    // legacySnapshots: a pre-upgrade round that never reviewed the two new members
    ...(opts.legacySnapshots ? {} : { 'plan-files.reviewed.json': reviewedPlanFiles, 'gates.reviewed.json': reviewedGates }),
    'plan.md': opts.changed ? `${reviewedPlan}\nnow with the empty case handled\n` : reviewedPlan,
    'criteria.json': reviewedCriteria,
    'plan-files.json': opts.planFilesChanged ? JSON.stringify(['src/x.ts', 'src/y.ts'], null, 2) : reviewedPlanFiles,
    'gates.json': opts.gatesChanged ? JSON.stringify({ test: 'bun test', typecheck: 'tsc --noEmit' }, null, 2) : reviewedGates,
  });
}

/** Diff-mode workspace inside a one-commit git repo; returns the dir and its HEAD sha. */
async function diffWorkspace(resolutions: unknown[]): Promise<{ dir: string; before: string }> {
  const dir = await workspace({ 'blockers.json': [blocker('fp1')], 'resolutions.json': resolutions });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'chore: fixture init');
  const r = await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 });
  return { dir, before: r.stdout.trim() };
}

test('plan reconcile with a changed plan is accepted and resets the retry tally', async () => {
  const dir = await planWorkspace({ changed: true });
  await Bun.write(join(dir, 'rounds.json'), JSON.stringify({ plan: 2, reconcile: 1 }, null, 2));
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('reconcile (plan) accepted');
  // reset on acceptance, and the pregate key survives untouched
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'))).toEqual({ plan: 2, reconcile: 0 });
});

test('plan reconcile marked resolved over artifacts identical to the reviewed version is rejected', async () => {
  const dir = await planWorkspace({ changed: false });
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain(
    'blocker(s) marked "resolved" but the plan and criteria are identical to the reviewed version — change the artifact or reject with reasoning',
  );
});

test('a manifest-only change is a real change: pinning a promise to an existing criterion is accepted', async () => {
  const dir = await planWorkspace({ changed: false });
  await Bun.write(join(dir, 'promises.reviewed.json'), JSON.stringify([], null, 2));
  await Bun.write(join(dir, 'promises.json'), JSON.stringify([{ promise: 'retries are bounded', criterionRef: 'C1' }], null, 2));
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('reconcile (plan) accepted');
});

test('plan, criteria and manifest all identical to the reviewed version is rejected', async () => {
  const dir = await planWorkspace({ changed: false });
  const manifest = JSON.stringify([{ promise: 'retries are bounded', criterionRef: 'C1' }], null, 2);
  await Bun.write(join(dir, 'promises.json'), manifest);
  await Bun.write(join(dir, 'promises.reviewed.json'), manifest);
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain(
    'blocker(s) marked "resolved" but the plan, criteria, promises, plan-files and gates are identical to the reviewed version — change the artifact or reject with reasoning',
  );
});

test('a plan-files-only change is a real change: a blocker resolved solely by widening the declared scope is accepted', async () => {
  const dir = await planWorkspace({ changed: false, planFilesChanged: true });
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('reconcile (plan) accepted');
});

test('a gates-only change is a real change: a blocker resolved solely by strengthening the toolchain is accepted', async () => {
  const dir = await planWorkspace({ changed: false, gatesChanged: true });
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('reconcile (plan) accepted');
});

test('legacy round (no new-member snapshots): plan-files/gates are excluded with a printed notice and confer no change credit', async () => {
  // the round under reconcile never reviewed plan-files/gates — a change to them
  // cannot count as "the reviewed artifact changed"; the honest basis is the
  // three members the round actually judged. Review qualification is unaffected
  // (run.mjs forces a fresh complete-context round after this reconcile).
  const dir = await planWorkspace({ changed: false, planFilesChanged: true, gatesChanged: true, legacySnapshots: true });
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('plan-files.json: no reviewed snapshot (legacy round) — excluded from the identity comparison');
  expect(r.stdout).toContain('gates.json: no reviewed snapshot (legacy round) — excluded from the identity comparison');
  expect(r.stdout).toContain('blocker(s) marked "resolved"');
});

test('a manifest without its reviewed snapshot fails closed — the identity check cannot run', async () => {
  const dir = await planWorkspace({ changed: false });
  await Bun.write(join(dir, 'promises.json'), JSON.stringify([], null, 2));
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('must both exist (snapshot the manifest before every review round) or both be absent');
});

test('plan reconcile with identical artifacts but every blocker rejected passes — honesty gates only "resolved"', async () => {
  const dir = await planWorkspace({ changed: false, action: 'rejected' });
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(0);
});

test('resolutions that do not match the reconcile schema are rejected', async () => {
  const dir = await planWorkspace({ changed: true });
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify([{ fingerprint: 'fp1', action: 'resolved' }], null, 2));
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('output did not match the reconcile schema:');
  expect(r.stdout).toContain('resolutions[0].detail');
});

test('a blocker fingerprint without a resolution is rejected as incomplete', async () => {
  const dir = await planWorkspace({ changed: true });
  await Bun.write(join(dir, 'blockers.json'), JSON.stringify([blocker('fp1'), blocker('fp2')], null, 2));
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('resolutions missing for blocker fingerprint(s): fp2');
});

test('two resolutions for one blocker fingerprint are rejected as ambiguous', async () => {
  const dir = await planWorkspace({ changed: true });
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify([res('fp1'), res('fp1', 'rejected')], null, 2));
  const r = await honesty(dir, 'plan');
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('duplicate resolutions for blocker fingerprint(s): fp1');
});

test('diff reconcile marked resolved while nothing was committed is rejected', async () => {
  const { dir, before } = await diffWorkspace([res('fp1')]);
  const r = await honesty(dir, 'diff', '--before', before);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain(
    'blocker(s) marked "resolved" but nothing was committed — commit the fix or reject with reasoning',
  );
});

test('diff reconcile with a real commit is accepted and routed back through gates', async () => {
  const { dir, before } = await diffWorkspace([res('fp1')]);
  await Bun.write(join(dir, 'fix.md'), 'the fix\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'fix: address fp1');
  const r = await honesty(dir, 'diff', '--before', before);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('HEAD moved, changed code must pass gates before review');
});

test('diff reconcile with HEAD unchanged and every blocker rejected is accepted, back to review', async () => {
  const { dir, before } = await diffWorkspace([res('fp1', 'rejected')]);
  const r = await honesty(dir, 'diff', '--before', before);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('HEAD unchanged');
});

test('a second consecutive rejected reconcile escalates: failed twice', async () => {
  const dir = await planWorkspace({ changed: false });
  const first = await honesty(dir, 'plan');
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toStartWith('Reconcile retry');

  const second = await honesty(dir, 'plan');
  expect(second.exitCode).toBe(2);
  expect(second.stdout).toStartWith('reconcile (plan) failed twice:');
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'))).toEqual({ reconcile: 2 });

  // an accepted reconcile clears the streak
  await Bun.write(join(dir, 'plan.md'), '# plan\n\ndo the thing\n\nnow fixed\n');
  const third = await honesty(dir, 'plan');
  expect(third.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'))).toEqual({ reconcile: 0 });
});
