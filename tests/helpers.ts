import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execArgv } from '../src/lib/exec';
import type { AgentAdapter, AgentRunInput, AgentRunResult } from '../src/agents/types';
import type { BenConfig } from '../src/config';
import { approvePlan, loadState, newTaskState, planArtifactsSha, reviewContextSha, saveState } from '../src/orchestrator/state';

export function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// The production pause seam (scripts/run.mjs pauseAt) blocks for up to 60s
// once reached. The kill helpers must wait AT LEAST that long for the marker —
// a shorter wait kills a merely-slow child under full-suite contention and
// throws "never reached pause boundary" (the intermittent-failure class).
// One shared constant so the two contracts cannot silently drift apart.
export const PAUSE_BOUNDARY_WAIT_MS = 60_000;
export const PAUSE_BOUNDARY_POLL_MS = 25;

/** Point BEN_HOME at a fresh temp dir so tests never touch ~/.ben. */
export async function useTmpHome(): Promise<string> {
  const home = await makeTmpDir('ben-home-');
  process.env.BEN_HOME = home;
  return home;
}

export async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await execArgv(['git', ...args], { cwd, timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** A tiny bun project in a fresh git repo: math.ts + one test (passing or deliberately failing). */
export async function makeFixtureRepo(opts: { failingTest?: boolean } = {}): Promise<string> {
  const dir = await makeTmpDir('ben-fixture-');
  const expected = opts.failingTest ? 4 : 3;
  await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }, null, 2));
  await Bun.write(join(dir, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  await Bun.write(
    join(dir, 'math.test.ts'),
    `import { expect, test } from 'bun:test';\nimport { add } from './math';\n\ntest('add', () => {\n  expect(add(1, 2)).toBe(${expected});\n});\n`,
  );
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'chore: fixture init');
  return dir;
}

export function testConfig(overrides: Partial<BenConfig> = {}): BenConfig {
  return {
    planner: 'fake',
    implementer: 'fake',
    panel: { plan: [], diff: [], tieBreak: 'unanimous-go' }, // no panel skips review; review tests override
    caps: { planRounds: 3, diffRounds: 3, gateFixes: 2, verifyFixes: 2, humanRounds: 5 },
    budgetUsd: 25,
    maxCriteria: 12,
    gates: { test: 'bun test' },
    e2e: {
      serverCommand: 'false',
      readyUrl: 'http://127.0.0.1:1',
      video: 'on',
      requiredForPaths: ['src/ui/**'],
    },
    timeoutMinutes: 90,
    agentTimeoutMs: 60_000,
    gateTimeoutMs: 120_000,
    ...overrides,
  };
}

export type FakeHandler = (input: AgentRunInput) => Promise<Partial<AgentRunResult>> | Partial<AgentRunResult>;

/** Scripted agent: one handler for plan calls (readOnly), one for implement calls. */
export class FakeAdapter implements AgentAdapter {
  name = 'fake';
  capabilities: Array<'plan' | 'implement' | 'review'> = ['plan', 'implement'];
  planCalls = 0;
  implementCalls = 0;

  constructor(
    private planHandler: FakeHandler,
    private implementHandler: FakeHandler,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const handler = input.readOnly
      ? (this.planCalls++, this.planHandler)
      : (this.implementCalls++, this.implementHandler);
    const partial = await handler(input);
    return { ok: true, raw: '', costUsd: 0.01, costIsEstimate: false, exitCode: 0, ...partial };
  }
}

/** Scripted reviewer: returns the queued results in order; repeats the last one when the queue runs dry. */
export class FakeReviewer implements AgentAdapter {
  capabilities: Array<'plan' | 'implement' | 'review'> = ['review'];
  calls: AgentRunInput[] = [];

  constructor(
    public name: string,
    private script: Array<Partial<AgentRunResult>>,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    const partial = this.script.length > 1 ? this.script.shift()! : (this.script[0] ?? {});
    return { ok: true, raw: '', costUsd: 0.01, costIsEstimate: false, exitCode: 0, ...partial };
  }
}

export function verdictParsed(verdict: 'GO' | 'NO_GO', blockers: unknown[] = []): { parsed: unknown } {
  return { parsed: { verdict, blockers, notes: '' } };
}

export function blockerOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'B1',
    severity: 'BLOCKER',
    claim: 'the plan does not handle the empty case',
    evidence: 'math.ts — add() has no test for zero operands',
    falsifier: 'a criterion whose command exercises add(0, 0)',
    criterionRef: 'C1',
    respondsTo: '',
    ...overrides,
  };
}

export function planParsed(taskId: string, criteria: unknown[], files: string[] = ['math.ts']): unknown {
  return {
    title: `Do the thing for ${taskId}`,
    summary: 'Does the thing so the thing is done. Needed because the thing was missing.',
    plan: '# plan\n\ndo the thing',
    files,
    criteria: { taskId, criteria, outOfScope: [] },
  };
}

/** Fake implementer's "work": write a file and commit it in the worktree. */
export async function commitChange(worktree: string, name: string): Promise<void> {
  await Bun.write(join(worktree, `${name}.md`), `${name}\n`);
  await git(worktree, 'add', '.');
  await git(worktree, 'commit', '-m', `chore: ${name}`);
}

export async function startTask(taskId: string, repoPath: string, opts: { greenfield?: boolean } = {}): Promise<void> {
  const state = newTaskState({
    taskId,
    title: `test task ${taskId}`,
    repoPath,
    ceilingUsd: 25,
    greenfield: opts.greenfield,
  });
  await saveState(state);
}

/** Pass the unavoidable human gate in tests: read the current artifacts (the
 * "display"), then approve bound to exactly that sha — the real CLI flow. */
export async function approveGate(taskId: string): Promise<void> {
  const s = await loadState(taskId);
  const displayed = await planArtifactsSha(taskId, s.gates);
  const context = await reviewContextSha(taskId);
  await approvePlan(taskId, 'test-human', displayed, context);
}

/** An empty git repo with only a root commit — the greenfield starting point. */
export async function makeEmptyRepo(): Promise<string> {
  const dir = await makeTmpDir('ben-empty-');
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'commit', '--allow-empty', '-m', 'chore: init');
  return dir;
}
