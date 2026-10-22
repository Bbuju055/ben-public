import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runTask, type PrResult } from '../src/orchestrator/machine';
import { approvePlan, evidenceDir, loadState, planArtifactsSha, requestAbort, taskDir } from '../src/orchestrator/state';
import {
  approveGate,
  commitChange,
  FakeAdapter,
  git,
  makeEmptyRepo,
  makeFixtureRepo,
  planParsed,
  startTask,
  testConfig,
  useTmpHome,
} from './helpers';

const C_TEST = {
  id: 'C1',
  statement: 'unit tests pass',
  verification: { method: 'test', command: 'bun test math.test.ts', expect: 'exit 0' },
};
const C_CMD = {
  id: 'C2',
  statement: 'math.ts exists',
  verification: { method: 'command', command: 'test -f math.ts', expect: 'exit 0' },
};

function prSpy() {
  const calls: PrResult[] = [];
  return {
    calls,
    createPr: async (): Promise<PrResult> => {
      const pr = { number: 1, url: 'https://example.test/pr/1', headSha: 'deadbeef' };
      calls.push(pr);
      return pr;
    },
  };
}

function workingImplementer() {
  let committed = false;
  return async (input: { cwd: string }) => {
    if (!committed) {
      await commitChange(input.cwd, 'impl');
      committed = true;
    }
    return {};
  };
}

beforeEach(async () => {
  await useTmpHome();
});

test('happy path: two-criterion task reaches DONE with an accurate matrix', async () => {
  const repo = await makeFixtureRepo();
  await startTask('happy', repo);
  const fake = new FakeAdapter(() => ({ parsed: planParsed('happy', [C_TEST, C_CMD]) }), workingImplementer());
  const pr = prSpy();

  const gated = await runTask('happy', testConfig(), { adapters: { fake }, createPr: pr.createPr });
  expect(gated.phase).toBe('AWAIT_PLAN_APPROVAL'); // the gate is unavoidable even with no panel
  await approveGate('happy');
  const final = await runTask('happy', testConfig(), { adapters: { fake }, createPr: pr.createPr });

  expect(final.phase).toBe('DONE');
  expect(final.planApproval?.approvedBy).toBe('test-human');
  expect(pr.calls.length).toBe(1);
  expect(fake.planCalls).toBe(1);
  const matrix = JSON.parse(await readFile(join(evidenceDir('happy'), 'criteria-matrix.json'), 'utf8'));
  expect(matrix.C1.status).toBe('pass');
  expect(matrix.C2.status).toBe('pass');
});

test('a deliberately failing test never reaches PR', async () => {
  const repo = await makeFixtureRepo({ failingTest: true });
  await startTask('redtask', repo);
  const fake = new FakeAdapter(() => ({ parsed: planParsed('redtask', [C_TEST, C_CMD]) }), workingImplementer());
  const pr = prSpy();

  await runTask('redtask', testConfig(), { adapters: { fake }, createPr: pr.createPr });
  await approveGate('redtask');
  const final = await runTask('redtask', testConfig(), { adapters: { fake }, createPr: pr.createPr });

  expect(final.phase).toBe('ESCALATED');
  expect(pr.calls.length).toBe(0);
  expect(final.rounds.gateFix).toBe(3); // 2 fix attempts + the exhausted third
  expect(existsSync(final.worktreePath)).toBe(true); // worktree kept for inspection
  // every round's evidence survives — a retry must never overwrite the failure that caused it
  expect(existsSync(join(evidenceDir('redtask'), 'gate-test-r1.txt'))).toBe(true);
  expect(existsSync(join(evidenceDir('redtask'), 'gate-test-r2.txt'))).toBe(true);
  expect(existsSync(join(evidenceDir('redtask'), 'gate-test-r3.txt'))).toBe(true);
});

test('greenfield: a plan without gates is rejected, declared gates are used over config', async () => {
  const repo = await makeEmptyRepo();
  await startTask('green', repo, { greenfield: true });
  let planRound = 0;
  const fake = new FakeAdapter(
    () => {
      planRound += 1;
      const base = planParsed('green', [C_TEST]) as Record<string, unknown>;
      // round 1: no gates declared → pregate must bounce it back
      if (planRound === 1) return { parsed: base };
      return { parsed: { ...base, gates: { test: 'bun test math.test.ts' } } };
    },
    async (input) => {
      await Bun.write(join(input.cwd, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
      await Bun.write(
        join(input.cwd, 'math.test.ts'),
        "import { expect, test } from 'bun:test';\nimport { add } from './math';\n\ntest('add', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
      );
      await git(input.cwd, 'add', '.');
      await git(input.cwd, 'commit', '-m', 'feat: math');
      return {};
    },
  );
  const pr = prSpy();
  // config gates would always fail ("false") — DONE proves the declared gates replaced them
  const cfg = testConfig({ gates: { boom: 'false' } });

  await runTask('green', cfg, { adapters: { fake }, createPr: pr.createPr });
  await approveGate('green');
  const final = await runTask('green', cfg, { adapters: { fake }, createPr: pr.createPr });

  expect(final.phase).toBe('DONE');
  expect(fake.planCalls).toBe(2); // rejected once, accepted once
  expect(final.rounds.plan).toBe(1);
  expect(final.gates).toEqual({ test: 'bun test math.test.ts' });
  expect(pr.calls.length).toBe(1);
});

test('a failing criterion is recorded accurately in the matrix and blocks PR', async () => {
  const repo = await makeFixtureRepo();
  await startTask('mixed', repo);
  const badCmd = {
    id: 'C2',
    statement: 'a file that will not exist',
    verification: { method: 'command', command: 'test -f does-not-exist.txt', expect: 'exit 0' },
  };
  const fake = new FakeAdapter(() => ({ parsed: planParsed('mixed', [C_TEST, badCmd]) }), workingImplementer());
  const pr = prSpy();

  await runTask('mixed', testConfig(), { adapters: { fake }, createPr: pr.createPr });
  await approveGate('mixed');
  const final = await runTask('mixed', testConfig(), { adapters: { fake }, createPr: pr.createPr });

  expect(final.phase).toBe('ESCALATED');
  expect(pr.calls.length).toBe(0);
  const matrix = JSON.parse(await readFile(join(evidenceDir('mixed'), 'criteria-matrix.json'), 'utf8'));
  expect(matrix.C1.status).toBe('pass');
  expect(matrix.C2.status).toBe('fail');
});

test('crash mid-run resumes from state.json without re-planning', async () => {
  const repo = await makeFixtureRepo();
  await startTask('resumable', repo);
  const fake1 = new FakeAdapter(() => ({ parsed: planParsed('resumable', [C_TEST, C_CMD]) }), workingImplementer());
  const pr = prSpy();

  // "crash": stop after INTAKE→PLAN→PREGATE, state saved at the approval gate, no cleanup
  const crashed = await runTask(
    'resumable',
    testConfig(),
    { adapters: { fake: fake1 }, createPr: pr.createPr },
    { maxTransitions: 3 },
  );
  expect(crashed.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(pr.calls.length).toBe(0);

  // approval survives the crash boundary; resume with a planner that must never be called
  await approveGate('resumable');
  const fake2 = new FakeAdapter(
    () => {
      throw new Error('planner must not run on resume');
    },
    workingImplementer(),
  );
  const final = await runTask('resumable', testConfig(), { adapters: { fake: fake2 }, createPr: pr.createPr });

  expect(final.phase).toBe('DONE');
  expect(fake2.planCalls).toBe(0);
  expect(pr.calls.length).toBe(1);
});

test('approval gate: pauses unconditionally, resume without approval stays paused, stale approval is voided', async () => {
  const repo = await makeFixtureRepo();
  await startTask('reviewed', repo);
  const fake = new FakeAdapter(() => ({ parsed: planParsed('reviewed', [C_TEST, C_CMD]) }), workingImplementer());
  const pr = prSpy();
  const deps = { adapters: { fake }, createPr: pr.createPr };

  const paused = await runTask('reviewed', testConfig(), deps);
  expect(paused.phase).toBe('AWAIT_PLAN_APPROVAL'); // saved and waiting — nothing built
  expect(fake.planCalls).toBe(1);
  expect(fake.implementCalls).toBe(0);
  expect(pr.calls.length).toBe(0);

  // a driver resuming without approval gets nowhere
  const still = await runTask('reviewed', testConfig(), deps);
  expect(still.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(fake.implementCalls).toBe(0);

  // an approval bound to a plan that has since changed is voided, not honored
  await approveGate('reviewed');
  const { taskDir } = await import('../src/orchestrator/state');
  await Bun.write(join(taskDir('reviewed'), 'plan.md'), '# plan\n\nsilently swapped after approval');
  const voided = await runTask('reviewed', testConfig(), deps);
  expect(voided.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(voided.planApproval).toBeUndefined(); // stale approval dropped for re-presentation
  expect(fake.implementCalls).toBe(0);

  // a fresh approval of the current plan builds
  await approveGate('reviewed');
  const final = await runTask('reviewed', testConfig(), deps);
  expect(final.phase).toBe('DONE');
  expect(fake.planCalls).toBe(1); // never re-planned
  expect(pr.calls.length).toBe(1);
});

test('blank gate commands are rejected at the schema boundary — vacuous green is impossible', async () => {
  const repo = await makeEmptyRepo();
  await startTask('blankgates', repo, { greenfield: true });
  let planRound = 0;
  const fake = new FakeAdapter(() => {
    planRound += 1;
    const base = planParsed('blankgates', [C_TEST]) as Record<string, unknown>;
    // round 1: whitespace-only commands — must be bounced, never run as vacuous truth
    if (planRound === 1) return { parsed: { ...base, gates: { typecheck: '   ', test: '' } } };
    return { parsed: { ...base, gates: { test: 'bun test math.test.ts' } } };
  }, workingImplementer());
  const pr = prSpy();

  const gated = await runTask('blankgates', testConfig(), { adapters: { fake }, createPr: pr.createPr });

  expect(gated.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(fake.planCalls).toBe(2); // blank-gate plan rejected, real plan accepted
  expect(gated.gates).toEqual({ test: 'bun test math.test.ts' });
});

test('abort works AT the approval gate — the advertised exit is real', async () => {
  const repo = await makeFixtureRepo();
  await startTask('gateabort', repo);
  const fake = new FakeAdapter(() => ({ parsed: planParsed('gateabort', [C_TEST]) }), workingImplementer());
  const pr = prSpy();
  const deps = { adapters: { fake }, createPr: pr.createPr };

  const gated = await runTask('gateabort', testConfig(), deps);
  expect(gated.phase).toBe('AWAIT_PLAN_APPROVAL');
  await requestAbort('gateabort');

  const final = await runTask('gateabort', testConfig(), deps);
  expect(final.phase).toBe('ESCALATED');
  expect(final.lastError).toBe('aborted by user');
  expect(fake.implementCalls).toBe(0);
});

test('an approval bound to the displayed sha is refused when artifacts change in between', async () => {
  const repo = await makeFixtureRepo();
  await startTask('gatetoctou', repo);
  const fake = new FakeAdapter(() => ({ parsed: planParsed('gatetoctou', [C_TEST]) }), workingImplementer());
  const pr = prSpy();
  await runTask('gatetoctou', testConfig(), { adapters: { fake }, createPr: pr.createPr });

  const s = await loadState('gatetoctou');
  const displayedSha = await planArtifactsSha('gatetoctou', s.gates);
  await Bun.write(join(taskDir('gatetoctou'), 'plan.md'), '# plan\n\nedited between display and approve');

  const context = await (await import('../src/orchestrator/state')).reviewContextSha('gatetoctou');
  expect(approvePlan('gatetoctou', 'human', displayedSha, context)).rejects.toThrow('changed after they were presented');
});

test('existing-repo gates are pinned into state at pregate and are approval-bound', async () => {
  const repo = await makeFixtureRepo();
  await startTask('gatepin', repo);
  const fake = new FakeAdapter(() => ({ parsed: planParsed('gatepin', [C_TEST]) }), workingImplementer());
  const pr = prSpy();
  const cfgA = testConfig(); // gates: { test: 'bun test' }

  const gated = await runTask('gatepin', cfgA, { adapters: { fake }, createPr: pr.createPr });
  expect(gated.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(gated.gates).toEqual(cfgA.gates); // pinned at pregate, hashed by approval
  await approveGate('gatepin');

  // an operator swapping config gates AFTER approval cannot change what runs:
  // the pinned state.gates win at execution, and the approval stays coherent
  const cfgB = testConfig({ gates: { test: 'false # swapped-in failure' } });
  const final = await runTask('gatepin', cfgB, { adapters: { fake }, createPr: pr.createPr });
  expect(final.phase).toBe('DONE'); // pinned 'bun test' ran, not the swapped 'false'
  expect(pr.calls.length).toBe(1);
});

test('a gate-command change voids an existing approval (sha covers executables)', async () => {
  const repo = await makeFixtureRepo();
  await startTask('gategates', repo, { greenfield: false });
  const fake = new FakeAdapter(() => ({ parsed: planParsed('gategates', [C_TEST]) }), workingImplementer());
  const pr = prSpy();
  const deps = { adapters: { fake }, createPr: pr.createPr };
  await runTask('gategates', testConfig(), deps);
  await approveGate('gategates');

  // simulate a gate swap landing in state (greenfield-style) after approval
  const s = await loadState('gategates');
  s.gates = { test: 'true # swapped' };
  const { saveState } = await import('../src/orchestrator/state');
  await saveState(s);

  const voided = await runTask('gategates', testConfig(), deps);
  expect(voided.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(voided.planApproval).toBeUndefined();
  expect(fake.implementCalls).toBe(0);
});

test('abort flag stops the run at the next phase boundary', async () => {
  const repo = await makeFixtureRepo();
  await startTask('aborted', repo);
  await requestAbort('aborted');
  const fake = new FakeAdapter(() => ({ parsed: planParsed('aborted', [C_TEST]) }), workingImplementer());
  const pr = prSpy();

  const final = await runTask('aborted', testConfig(), { adapters: { fake }, createPr: pr.createPr });

  expect(final.phase).toBe('ESCALATED');
  expect(final.lastError).toBe('aborted by user');
  expect(fake.planCalls).toBe(0);
});
