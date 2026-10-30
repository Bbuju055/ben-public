import { readGuidance, validateGuidance, withWorkGuidance } from '../scripts/guidance.mjs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { failureKind, researchFiles, accountTotals, BEN_DIR, judgeProbe, progressIdentity, reachedLimit, effectiveLimits, configurationProblems, renderDriverSettings, renderGateProfile, planDependenciesSection, scrubForOperator, sleepGapMs } from '../scripts/runner.lib.mjs';
import { inspectionSha, PR_TITLE_MAX, prTitleFor } from '../scripts/adjudication.lib.mjs';
import { git, makeTmpDir, PAUSE_BOUNDARY_POLL_MS, PAUSE_BOUNDARY_WAIT_MS } from './helpers';

// The runner through its seams: a stub driver that speaks the
// stream-json protocol, a stub gh over a local bare remote, the stub reviewer.
// Every outcome branch, the durable launch accounting, the progress guard, the
// publication drills (kill before push / after push / after create), the actor
// audit, the configuration refusals, the stretch modes.

const RUNNER = fileURLToPath(new URL('../scripts/runner.mjs', import.meta.url));
const STUBS = fileURLToPath(new URL('./runner-stubs/', import.meta.url));
const S = (repo: string) => join(repo, '.ben');

interface World {
  repo: string;
  remote: string;
  home: string;
  store: string;
  driverLog: string;
  handler: string;
  env: Record<string, string>;
  reviewer: { cli: string; respond: (v: unknown) => Promise<void> };
}

async function stubReviewer(): Promise<World['reviewer']> {
  const dir = await makeTmpDir('runner-rev-');
  const js = join(dir, 'stub.mjs');
  await writeFile(js, `import { readFileSync, writeFileSync } from 'node:fs';\nconst a = process.argv.slice(2); const out = a[a.indexOf('-o') + 1];\nwriteFileSync(out, readFileSync(${JSON.stringify(join(dir, 'response.txt'))}, 'utf8'));\n`);
  const cli = join(dir, 'cli');
  await writeFile(cli, `#!/bin/sh\nexec node "${js}" "$@"\n`);
  chmodSync(cli, 0o755);
  return { cli, respond: (v) => writeFile(join(dir, 'response.txt'), typeof v === 'string' ? v : JSON.stringify(v)) };
}

const GO = { verdict: 'GO', blockers: [] };

/** A bin dir with `gh` and `codex` shims pointing at the stubs. */
async function stubBin(env: Record<string, string>): Promise<string> {
  const bin = await makeTmpDir('runner-bin-');
  for (const name of ['gh', 'codex']) {
    const p = join(bin, name);
    await writeFile(p, `#!/bin/sh\nexec node "${join(STUBS, `${name}.mjs`)}" "$@"\n`);
    chmodSync(p, 0o755);
  }
  const drv = join(bin, 'driver');
  await writeFile(drv, `#!/bin/sh\nexec node "${join(STUBS, 'driver.mjs')}" "$@"\n`);
  chmodSync(drv, 0o755);
  env.BEN_GH_CLI = join(bin, 'gh');
  env.BEN_CODEX_CLI = join(bin, 'codex');
  env.BEN_DRIVER_CLI = drv;
  return bin;
}

/** The default handler: plan stretch writes the artifacts; implementation commits; tidy commits; else no-op. */
const DEFAULT_HANDLER = `
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
export async function handle(instruction, ctx) {
  const S = join(ctx.cwd, '.ben');
  const sh = (c) => execSync(c, { cwd: ctx.cwd, stdio: 'pipe' }).toString();
  if (/Write the plan artifacts/.test(instruction)) {
    writeFileSync(join(S, 'plan.md'), '# plan\\n\\nAdd subtract() per brief.md.\\n');
    writeFileSync(join(S, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 'subtract works', verification: { method: 'command', command: 'bun test' } }] }));
    writeFileSync(join(S, 'promises.json'), '[]');
    writeFileSync(join(S, 'plan-files.json'), JSON.stringify(['math.ts']));
    writeFileSync(join(S, 'gates.json'), JSON.stringify({ test: 'bun test' }));
    return { cost: 0.11, text: 'plan written' };
  }
  if (/Implement the plan and commit|No commits|You finished without committing/.test(instruction) || /verify commits/.test(instruction)) {
    writeFileSync(join(ctx.cwd, 'math.ts'), 'export function add(a: number, b: number): number {\\n  return a + b;\\n}\\nexport function subtract(a: number, b: number): number {\\n  return a - b;\\n}\\n');
    sh('git add -A && git commit -q -m "feat: subtract"');
    return { cost: 0.2, text: 'implemented' };
  }
  if (/tidy|worktree is dirty/.test(instruction)) {
    sh('git add -A && git commit -q -m "chore: tidy"');
    return { cost: 0.05 };
  }
  return { cost: 0.02, text: 'nothing to do' };
}
`;

async function world(opts: { handler?: string; noProbe?: boolean } = {}): Promise<World> {
  const home = realpathSync(await makeTmpDir('runner-home-'));
  const remote = realpathSync(await makeTmpDir('runner-remote-'));
  await git(remote, 'init', '--bare', '-q', '-b', 'main');
  const repo = realpathSync(await makeTmpDir('runner-repo-'));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'operator@test.local');
  await git(repo, 'config', 'user.name', 'operator');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
  await writeFile(join(repo, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  await writeFile(join(repo, 'math.test.ts'), "import { expect, test } from 'bun:test';\nimport { add } from './math';\ntest('add', () => {\n  expect(add(1, 2)).toBe(3);\n});\n");
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'chore: init');
  await git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  // every git process (repo and mirror) resolves the GitHub URL to the local bare remote
  const gitcfg = join(home, 'test-gitconfig');
  await writeFile(gitcfg, `[url "${remote}"]\n\tinsteadOf = https://github.com/o/r.git\n`);
  await writeFile(join(home, 'gitconfig'), `[url "${remote}"]\n\tinsteadOf = https://github.com/o/r.git\n`);
  const push = await execArgv(['git', 'push', '-q', 'origin', 'main'], { cwd: repo, timeoutMs: 30_000, env: { GIT_CONFIG_GLOBAL: gitcfg } });
  if (push.exitCode !== 0) throw new Error(`fixture push failed: ${push.stderr}`);
  const store = join(home, 'gh-store.json');
  const driverLog = join(home, 'driver.log');
  const handler = join(home, 'handler.mjs');
  await writeFile(handler, opts.handler ?? DEFAULT_HANDLER);
  const reviewer = await stubReviewer();
  await reviewer.respond(GO);
  const env: Record<string, string> = {
    BEN_RUNNER_HOME: home,
    BEN_STUB_GH_STORE: store,
    BEN_STUB_REMOTE: remote,
    BEN_STUB_DRIVER_LOG: driverLog,
    BEN_STUB_DRIVER_HANDLER: handler,
    BEN_REVIEWER_CLI_REAL: reviewer.cli,
    GIT_CONFIG_GLOBAL: gitcfg,
    BEN_RUNNER_NO_PROBE: opts.noProbe === false ? '0' : '1',
    BEN_RUNNER_SKIP_PREFLIGHT_MODEL: '0',
  };
  await stubBin(env);
  return { repo, remote, home, store, driverLog, handler, env, reviewer };
}

function ben(w: World, args: string[], extra: Record<string, string> = {}, timeoutMs = 240_000): Promise<ExecResult> {
  return execArgv(['node', RUNNER, ...args], { cwd: w.repo, timeoutMs, env: { ...w.env, ...extra } });
}

const readTask = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'task.json'), 'utf8'));
const readWaiting = async (repo: string) => JSON.parse(await readFile(join(S(repo), 'waiting.json'), 'utf8'));
const driverRows = async (w: World) => (existsSync(w.driverLog) ? (await readFile(w.driverLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)) : []);
const stretchRows = async (repo: string) => (await readFile(join(S(repo), 'runner', 'stretches.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------
// unit: lib

test('lib: accounting charges launched-without-completion at cap, counts reviewer launches as estimates, subtracts sleep gaps, charges unreported children at their timeout', () => {
  const rows = [
    { type: 'launched', id: 'a', capUsd: 3 },
    { type: 'completed', id: 'a', costUsd: 0.5 },
    { type: 'launched', id: 'b', capUsd: 3 }, // crashed before completion
    { type: 'launched', id: 'c', capUsd: 3 },
    { type: 'completed', id: 'c', unreported: true },
    { type: 'reviewer-launch' },
    { type: 'reviewer-launch' },
    { type: 'started', id: 's1', kind: 'stretch', timeoutMs: 1000 },
    { type: 'ended', id: 's1', ms: 400 },
    { type: 'started', id: 's2', kind: 'next' }, // never ended
    { type: 'sleep-gap', ms: 100 },
  ];
  const t = accountTotals(rows, { nextTimeoutMs: 700 });
  expect(t.exactUsd).toBe(0.5);
  expect(t.cappedUsd).toBe(6);
  expect(t.reviewerCalls).toBe(2);
  expect(t.reviewerUsd).toBe(1);
  expect(t.usd).toBe(7.5);
  expect(t.stretches).toBe(3);
  expect(t.unreportedStretches).toBe(2);
  expect(t.activeMs).toBe(400 + 700 - 100);
  expect(reachedLimit(t, { usd: 7.5, hours: 8, stretches: 40 })).toEqual({ kind: 'usd', value: 7.5 });
  expect(reachedLimit(t, { usd: 25, hours: 8, stretches: 3 })).toEqual({ kind: 'stretches', value: 3 });
  expect(reachedLimit(t, { usd: 25, hours: 8, stretches: 40 })).toBeUndefined();
  expect(effectiveLimits({ assignment: { limits: { usd: 25, hours: 8, stretches: 40 } }, limitExtensions: [{ kind: 'usd', amount: 10 }, { kind: 'time', amount: 2 }] })).toEqual({ usd: 35, hours: 10, stretches: 40 });
}, 240_000);

test('lib: the probe judge needs correlated tool calls per canary and refuses model prose, a wrong tool set, a changed canary, a leaked secret, a listener hit, or a missing refusal', () => {
  const init = { type: 'system', subtype: 'init', tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], mcp_servers: [] };
  const result = { type: 'result', result: 'deny network-outbound Operation not permitted (this is only prose)' };
  const canaries = { writePath: '/rh/canary.txt', readPath: '/home/u/.ssh/.ben-probe', listener: '127.0.0.1:38765', network: 'https://example.com' };
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id: string, content: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const full = [
    init,
    use('1', 'Bash', { command: 'printf modified > /rh/canary.txt; echo EXIT=$?' }),
    res('1', 'zsh: operation not permitted: /rh/canary.txt\nEXIT=1'),
    use('2', 'Bash', { command: 'cat /home/u/.ssh/.ben-probe; echo EXIT=$?' }),
    res('2', 'cat: /home/u/.ssh/.ben-probe: Operation not permitted\nEXIT=1'),
    use('3', 'Bash', { command: 'curl -sS -m 5 http://127.0.0.1:38765/probe; echo EXIT=$?' }),
    res('3', "curl: (7) Failed to connect to 127.0.0.1 port 38765\nEXIT=7"),
    use('4', 'Bash', { command: 'curl -sS -m 5 https://example.com; echo EXIT=$?' }),
    res('4', 'curl: (56) CONNECT tunnel failed, response 403\nEXIT=56\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>'),
    use('5', 'Read', { file_path: '/home/u/.ssh/.ben-probe' }),
    res('5', 'File is in a directory that is denied by your permission settings.'),
    result,
  ];
  expect(judgeProbe({ transcript: full, canaryBefore: 'a', canaryAfter: 'a', secret: 'zzz', listenerHits: 0, canaries })).toEqual({ ok: true, problems: [] });
  // prose only, no tool calls → every canary missing
  const proseOnly = judgeProbe({ transcript: [init, result], canaryBefore: 'a', canaryAfter: 'a', listenerHits: 0, canaries });
  expect(proseOnly.ok).toBe(false);
  expect(proseOnly.problems.filter((p) => p.startsWith('no Bash tool call')).length).toBe(4);
  // a canary that RAN successfully is a failure
  const leaky = judgeProbe({ transcript: full.map((l) => (l.type === 'user' && (l as { message: { content: Array<{ tool_use_id: string }> } }).message.content[0]?.tool_use_id === '1' ? res('1', 'EXIT=0') : l)), canaryBefore: 'a', canaryAfter: 'a', listenerHits: 0, canaries });
  expect(leaky.problems[0]).toContain('protected-write canary was not refused');
  expect(judgeProbe({ transcript: [{ ...init, tools: [...init.tools, 'WebFetch'] }, ...full.slice(1)], canaryBefore: 'a', canaryAfter: 'a', listenerHits: 0, canaries }).problems[0]).toContain('tool set');
  expect(judgeProbe({ transcript: full, canaryBefore: 'a', canaryAfter: 'b', listenerHits: 0, canaries }).problems).toContain('the canary file on a denied path changed');
  expect(judgeProbe({ transcript: [...full.slice(0, -1), res('2', 'zzz'), result], canaryBefore: 'a', canaryAfter: 'a', secret: 'zzz', listenerHits: 0, canaries }).problems.some((p) => p.includes('secret'))).toBe(true);
  expect(judgeProbe({ transcript: full, canaryBefore: 'a', canaryAfter: 'a', listenerHits: 1, canaries }).problems[0]).toContain('listener');
});

test('lib: configuration problems name every offending item; the allowlist admits ordinary keys', () => {
  const clean = configurationProblems({ gitConfigList: 'core.repositoryformatversion=0\ncore.filemode=true\nremote.origin.url=https://github.com/o/r.git\nremote.origin.fetch=+refs/heads/*:refs/remotes/origin/*\nbranch.main.remote=origin\nbranch.main.merge=refs/heads/main', expectedRemoteUrl: 'https://github.com/o/r.git', hookEntries: [], claudeEntries: [], hasMcpJson: false });
  expect(clean).toEqual([]);
  const dirty = configurationProblems({ gitConfigList: 'core.hooksPath=.githooks\nremote.origin.url=https://github.com/o/r.git\ncredential.helper=store', expectedRemoteUrl: 'https://github.com/x/y.git', hookEntries: ['pre-commit'], claudeEntries: ['settings.local.json'], hasMcpJson: true, managedSettingsText: '{"hooks":{}}' });
  expect(dirty.join('\n')).toContain('.claude/settings.local.json');
  expect(dirty.join('\n')).toContain('.mcp.json');
  expect(dirty.join('\n')).toContain('pre-commit');
  expect(dirty.join('\n')).toContain('core.hooksPath');
  expect(dirty.join('\n')).toContain('credential.helper');
  expect(dirty.join('\n')).toContain('remote.origin.url is https://github.com/o/r.git');
  expect(dirty.join('\n')).toContain('managed settings define hooks');
  // harness bookkeeping dotfiles under .claude/ (e.g. .cc-writes) are filtered by the runner before this check
  expect(configurationProblems({ gitConfigList: '', hookEntries: [], claudeEntries: [], hasMcpJson: false })).toEqual([]);
}, 240_000);

test('lib: driver settings deny every authoritative .ben path, .claude, .git internals, the runtime and runner home; modes differ in domains/writes', () => {
  const repo = '/tmp/x/repo';
  const w = renderDriverSettings({ repo, runtimeDir: '/rt', runnerHome: '/rh', home: '/home/u', mode: 'work', allowedDomains: [] }) as Record<string, any>;
  const dw: string[] = w.sandbox.filesystem.denyWrite;
  for (const p of ['/.ben/task.json', '/.ben/approval.json', '/.ben/ledger.jsonl', '/.ben/rounds.json', '/.ben/evidence', '/.ben/reviews', '/.ben/runner', '/.claude', '/.git/config', '/.git/hooks']) expect(dw.some((d) => d.endsWith(p))).toBe(true);
  expect(dw).toContain('/rt');
  expect(dw).toContain('/rh');
  expect(dw).toContain('/home/u/.claude');
  expect(w.sandbox.network.allowedDomains).toEqual([]);
  expect(w.permissions.deny).toContain('Bash(node * run.mjs record*)');
  expect(w.permissions.deny).toContain('Bash(git push*)');
  expect(w.permissions.deny.some((d: string) => d.startsWith('Read(~/.config/gh'))).toBe(true);
  // an Edit(.git/**) deny is mirrored into the OS sandbox and blocks every commit
  expect(w.permissions.deny).not.toContain('Edit(.git/**)');
  expect(w.permissions.deny).toContain('Edit(.git/config)');
  const i = renderDriverSettings({ repo, runtimeDir: '/rt', runnerHome: '/rh', home: '/home/u', mode: 'install' }) as Record<string, any>;
  expect(i.sandbox.network.allowedDomains).toContain('registry.npmjs.org');
  expect(i.sandbox.filesystem.allowWrite.some((p: string) => p.endsWith('.bun/install/cache'))).toBe(true);
  const r = renderDriverSettings({ repo, runtimeDir: '/rt', runnerHome: '/rh', home: '/home/u', mode: 'research', allowedDomains: ['docs.example.com'] }) as Record<string, any>;
  expect(r.sandbox.network.allowedDomains).toEqual(['docs.example.com']);
});

test('lib: a gate profile for ben-on-ben leaves the checkout writable and protects the pinned runtime; sleep gaps come from clock drift only; the Dependencies section parses to EOF or the next heading', () => {
  const p = renderGateProfile({ repo: '/tmp/x/ben', benDir: '/tmp/x/ben', runtimeDir: '/rh/runtime/abc', runnerHome: '/rh', home: '/home/u' });
  expect(p).not.toContain('(deny file-write* (subpath "/tmp/x/ben"))');
  expect(p).toContain('(subpath "/rh/runtime/abc")');
  expect(p).toContain('(allow file-write* (subpath "/tmp/x/ben"))');
  const q = renderGateProfile({ repo: '/tmp/x/other', benDir: '/tmp/x/ben', runnerHome: '/rh', home: '/home/u' });
  expect(q).toContain('(subpath "/tmp/x/ben")'); // an install OUTSIDE the repo stays protected
  // blocking work (wall and mono advance together) is never sleep; suspension (wall jumps, mono does not) is
  expect(sleepGapMs({ wallStart: 0, monoStartMs: 0, wallNow: 600_000, monoNowMs: 600_000 })).toBe(0);
  expect(sleepGapMs({ wallStart: 0, monoStartMs: 0, wallNow: 600_000, monoNowMs: 100_000 })).toBe(500_000);
  expect(sleepGapMs({ wallStart: 0, monoStartMs: 0, wallNow: 600_000, monoNowMs: 100_000, previouslyCounted: 500_000 })).toBe(0);
  expect(planDependenciesSection('# plan\n\n## Dependencies\n- left-pad\n- zod\n')).toContain('left-pad');
  expect(planDependenciesSection('# plan\n\n## Dependencies\n- left-pad\n\n## How\nstuff')).not.toContain('stuff');
  expect(planDependenciesSection('# plan\n\n## How\nstuff')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// integration: assign → plan → park → resume → build → verify → publish → READY FOR REVIEW

test('assign refuses repo-shipped configuration without touching it, and a dirty worktree', async () => {
  const w = await world();
  mkdirSync(join(w.repo, '.claude'), { recursive: true });
  await writeFile(join(w.repo, '.claude', 'settings.local.json'), '{"hooks":{}}');
  await writeFile(join(w.repo, '.gitignore'), '.claude/\n');
  await git(w.repo, 'add', '.gitignore');
  await git(w.repo, 'commit', '-q', '-m', 'chore: ignore .claude');
  const r = await ben(w, ['assign', '--repo', w.repo, 'do the thing']);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('NEEDS YOU');
  expect(r.stdout).toContain('.claude/settings.local.json');
  expect(existsSync(join(w.repo, '.claude', 'settings.local.json'))).toBe(true); // untouched
  expect(existsSync(join(S(w.repo), 'task.json'))).toBe(false);
  rmSync(join(w.repo, '.claude'), { recursive: true });
  await writeFile(join(w.repo, 'dirty.txt'), 'x');
  const d = await ben(w, ['assign', '--repo', w.repo, 'do the thing']);
  expect(d.exitCode).toBe(1);
  expect(d.stderr).toContain('dirty');
}, 240_000);

for (const scenario of [
  { name: 'final cumulative cost enforces the budget without double-counting', final: { total_cost_usd: 0.47, num_turns: 1, result: 'background task finished' }, usd: '0.48', error: false },
  { name: 'missing final cost is unreported rather than a stale partial total', final: { result: 'final result without usage' }, usd: '0.48', error: false },
]) {
  test(`multiple result events: ${scenario.name}`, async () => {
    const handler = DEFAULT_HANDLER.replace("return { cost: 0.11, text: 'plan written' };", `return { cost: 0.45, text: 'plan written', extraResults: [${JSON.stringify(scenario.final)}] };`);
    const w = await world({ handler });
    const run = await ben(w, ['assign', '--repo', w.repo, '--inline', '--usd', scenario.usd, 'Plan subtract']);
    const rows = await stretchRows(w.repo);
    const launch = rows.find(r => r.type === 'launched' && r.kind === 'stretch');
    expect(launch).toBeDefined();
    const completions = rows.filter(r => r.type === 'completed' && r.id === launch.id);
    expect(completions).toHaveLength(1);
    const final = completions[0];
    expect(final.isError).toBe(scenario.error);
    if (typeof scenario.final.total_cost_usd === 'number') {
      expect(final.costUsd).toBe(scenario.final.total_cost_usd);
      expect(accountTotals(rows).exactUsd).toBeCloseTo(0.02 + scenario.final.total_cost_usd, 8);
    } else {
      expect(final.costUsd).toBeUndefined();
      expect(final.unreported).toBe(true);
      expect(accountTotals(rows).cappedUsd).toBe(launch.capUsd);
    }
    expect(rows.some(r => r.type === 'reviewer-launch')).toBe(false);
    expect(run.stdout).not.toContain('WAITING ON YOU (approval)');
    expect((await readTask(w.repo)).gate.kind).toBe('limit');
  }, 60000);
}

test('multiple result events: a late preflight error cannot be hidden by earlier success', async () => {
  const handler = `export async function handle() { return { cost: 0.1, extraResults: [{ is_error: true, subtype: 'error', total_cost_usd: 0.2, result: 'late preflight failure' }] }; }`;
  const w = await world({ handler });
  const run = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Plan subtract']);
  expect(run.exitCode).toBe(1);
  expect(run.stdout).toContain('late preflight failure');
  expect(existsSync(join(S(w.repo), 'task.json'))).toBe(false);
  const rows = (await readFile(join(w.home, 'launches.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  expect(rows.find(r => r.type === 'completed')).toMatchObject({ isError: true, costUsd: 0.2 });
}, 60000);

test('full lifecycle through the runner: assign → plan stretch → approval park (exit) → resume approve → build → gates → diff GO → publication from the mirror → READY FOR REVIEW; every stretch reserved before launch; the driver saw the isolation shape', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  if (a.exitCode !== 0) console.log(`assign failed:\n${a.stdout}\n${a.stderr}`);
  expect(a.exitCode).toBe(0);
  expect(a.stdout).toContain('created on branch ben/add-a-subtract-function');
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const t = await readTask(w.repo);
  expect(t.assignment.publication).toMatchObject({ repo: 'o/r', base: 'main', branch: 'ben/add-a-subtract-function', mode: 'create' });
  expect(t.assignment.operator).toBe('operator');
  expect(await readFile(join(S(w.repo), 'brief.md'), 'utf8')).toContain('Add a subtract function');
  expect((await readFile(join(w.repo, '.gitignore'), 'utf8')).includes('.ben/')).toBe(true);
  // the plan stretch: reserved before launch, completed with the exact cost, the driver launched with the isolation shape
  const rows1 = await stretchRows(w.repo);
  const launched = rows1.filter((r) => r.type === 'launched');
  const completed = rows1.filter((r) => r.type === 'completed');
  expect(launched.length).toBeGreaterThanOrEqual(2); // preflight no-op + plan stretch
  expect(completed.length).toBe(launched.length);
  expect(completed.some((c) => c.costUsd === 0.11)).toBe(true);
  const dr = await driverRows(w);
  const plan = dr.find((r) => /Write the plan artifacts/.test(r.instruction));
  expect(plan.sources).toBe('');
  expect(plan.tools).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  expect(plan.env.GH_TOKEN).toBeNull();
  expect(plan.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  expect(plan.resumed).toBe(false);
  expect(plan.instruction).toContain(readGuidance(BEN_DIR, 'plan').text);
  expect(plan.instruction).not.toContain('# Publication reference');
  expect(plan.instruction).not.toContain('record-veto --response');
  // status: WAITING ON YOU with the printed resume line carrying the gate id
  const st = await ben(w, ['status', '--repo', w.repo]);
  expect(st.stdout).toContain('WAITING ON YOU');
  const wt = await readWaiting(w.repo);
  const gate = (await readTask(w.repo)).gate.id;
  expect(wt.options[0].command).toContain(`--gate ${gate}`);
  // a noninteractive answer without --gate is refused
  const noGate = await ben(w, ['resume', '--repo', w.repo, '--choose', 'approve', '--inline']);
  expect(noGate.exitCode).toBe(1);
  expect(noGate.stderr).toContain('--gate');
  expect(existsSync(join(S(w.repo), 'approval.json'))).toBe(false);
  // resume with the printed line: approval recorded, the loop runs to READY FOR REVIEW
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('approval recorded');
  expect(r.stdout).toContain('READY FOR REVIEW (not merged, not deployed)');
  const t2 = await readTask(w.repo);
  expect(t2.pr.url).toBe('https://github.com/o/r/pull/1');
  // the remote holds the branch at the reviewed head; the PR body equals the generated body
  const remoteSha = (await execArgv(['git', '-C', w.remote, 'rev-parse', 'refs/heads/ben/add-a-subtract-function'], { cwd: w.remote, timeoutMs: 10_000 })).stdout.trim();
  expect(remoteSha).toBe(t2.pr.headSha);
  const store = JSON.parse(await readFile(w.store, 'utf8'));
  expect(store.prs).toHaveLength(1);
  expect(store.prs[0].body.replace(/\n+$/, '')).toBe((await readFile(join(S(w.repo), 'pr-body.md'), 'utf8')).replace(/\n+$/, ''));
  // main on the remote is untouched; only ben/* moved
  const remoteMain = (await execArgv(['git', '-C', w.remote, 'rev-parse', 'refs/heads/main'], { cwd: w.remote, timeoutMs: 10_000 })).stdout.trim();
  expect(remoteMain).toBe(t2.assignment.publication.baseSha);
  // the implementation stretch resumed the same session
  const dr2 = await driverRows(w);
  expect(dr2.filter((x) => x.resumed).length).toBeGreaterThanOrEqual(1);
  expect(dr2.some(x => x.instruction.includes(readGuidance(BEN_DIR, 'verification').text))).toBe(true);
  expect(new Set(dr2.filter((x) => !/Reply with exactly/.test(x.instruction)).map((x) => x.sessionId)).size).toBe(1);
  // status now READY FOR REVIEW; resume on a terminal task does nothing
  const st2 = await ben(w, ['status', '--repo', w.repo]);
  expect(st2.stdout).toContain('READY FOR REVIEW');
  expect((await ben(w, ['resume', '--repo', w.repo, '--inline'])).stdout).toContain('READY FOR REVIEW');
  // actors: every human-kind act is the operator's or the runner's
  const sj = JSON.parse((await ben(w, ['status', '--repo', w.repo, '--json'])).stdout);
  for (const a2 of sj.sequencer.actors) expect(['operator', 'ben-runner', 'ben-policy:empty-veto']).toContain(a2.by);
}, 240_000);

test('CI status: explicit refresh saves exact-SHA evidence; cached reads stay offline and failed/stale observations cannot reuse success', async () => {
  const w = await world();
  await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add subtract']);
  const gate = (await readTask(w.repo)).gate.id;
  expect((await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline'])).stdout).toContain('READY FOR REVIEW');
  const taskBefore = await readFile(join(S(w.repo), 'task.json'), 'utf8');
  const ledgerPath = join(S(w.repo), 'ledger.jsonl');
  const ledgerBefore = existsSync(ledgerPath) ? await readFile(ledgerPath, 'utf8') : null;
  const storeBefore = await readFile(w.store, 'utf8');
  const driversBefore = await driverRows(w);
  const task = await readTask(w.repo);
  const sha = task.pr.headSha;
  const fixture = JSON.parse(await readFile(join(import.meta.dir, 'fixtures', 'ci.json'), 'utf8').then(s => s.replaceAll('a'.repeat(40), sha).replaceAll('/pull/7', '/pull/1')));
  const path = join(w.home, 'ci-fixture.json');
  const log = join(w.home, 'ci-api.log');
  const prPath = 'repos/o/r/pulls/1';
  const checkPath = `repos/o/r/commits/${sha}/check-runs?filter=all&per_page=100&page=1`;
  const responses = { [prPath]: fixture.pr, [checkPath]: fixture.checks, [`repos/o/r/commits/${sha}/status?per_page=100&page=1`]: fixture.statuses };
  await writeFile(path, JSON.stringify(responses));
  const env = { BEN_STUB_CI_FIXTURE: path, BEN_STUB_GH_LOG: log };
  const status = async (refresh = false) => {
    const result = await ben(w, ['status', '--repo', w.repo, '--json', ...(refresh ? ['--refresh-ci'] : [])], env);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect((await status()).ci.state).toBe('unknown');
  expect(existsSync(log)).toBe(false);
  expect((await status(true))).toMatchObject({ state: 'READY FOR REVIEW', ci: { state: 'passed', reviewedSha: sha, observedHeadSha: sha } });
  const calls = await readFile(log, 'utf8');
  expect(calls.trim().split('\n')).toHaveLength(4);
  expect(calls.trim().split('\n').every(line => line.startsWith('api --method GET '))).toBe(true);
  expect((await status()).ci.state).toBe('passed');
  expect(await readFile(log, 'utf8')).toBe(calls);
  const rendered = await ben(w, ['status', '--repo', w.repo, '--detail'], env);
  expect(rendered.stdout).toContain('CI (informational snapshot): passed');
  expect(rendered.stdout).toContain('https://ci.example.com/build/200');
  responses[checkPath] = { error: 'HTTP 403 Bearer SECRET_FIXTURE_TOKEN' };
  await writeFile(path, JSON.stringify(responses));
  const unavailable = await status(true);
  expect(unavailable.state).toBe('READY FOR REVIEW');
  expect(unavailable.ci.state).toBe('unknown');
  expect(JSON.stringify(unavailable)).not.toContain('SECRET_FIXTURE_TOKEN');
  expect((await status()).ci.state).toBe('unknown');
  responses[checkPath] = fixture.checks;
  responses[prPath] = { ...fixture.pr, head: { sha: 'b'.repeat(40) } };
  await writeFile(path, JSON.stringify(responses));
  expect((await status(true)).ci.state).toBe('unknown');
  const historyPath = join(S(w.repo), 'runner', 'ci-observations.jsonl');
  const history = (await readFile(historyPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  expect(history.map(row => row.state)).toEqual(['passed', 'unknown', 'unknown']);
  expect(history[2].observedHeadSha).toBe('b'.repeat(40));
  await appendFile(historyPath, '{"state":');
  expect((await status()).ci.state).toBe('unknown');
  responses[prPath] = fixture.pr;
  await writeFile(path, JSON.stringify(responses));
  expect((await status(true)).ci.state).toBe('passed');
  expect((await status()).ci.state).toBe('passed');
  expect(await readFile(historyPath, 'utf8')).toContain('{"state":\n');
  expect(await readFile(join(S(w.repo), 'task.json'), 'utf8')).toBe(taskBefore);
  expect(existsSync(ledgerPath) ? await readFile(ledgerPath, 'utf8') : null).toBe(ledgerBefore);
  expect(await readFile(w.store, 'utf8')).toBe(storeBefore);
  expect(await driverRows(w)).toEqual(driversBefore);
}, 240_000);

test('no progress: three attempts and two fresh-session recoveries record a supervisor stop and park NEEDS YOU; continue gives one more try; a late/wrong answer is refused', async () => {
  const w = await world({ handler: `export async function handle() { return { cost: 0.01, text: 'did nothing' }; }` });
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'do nothing useful']);
  expect(a.exitCode).toBe(0);
  expect(a.stdout).toContain('WAITING ON YOU (supervisor-stop)');
  const t = await readTask(w.repo);
  expect(t.supervisorStops).toHaveLength(1);
  expect(t.supervisorStops[0].reason).toContain('5 times');
  const st = await ben(w, ['status', '--repo', w.repo]);
  expect(st.stdout).toContain('NEEDS YOU');
  const rows = await stretchRows(w.repo);
  expect(rows.filter((r) => r.type === 'launched' && r.kind === 'stretch')).toHaveLength(5);
  const gate = t.gate.id;
  const bad = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(bad.exitCode).toBe(1);
  expect(bad.stdout).toContain('not a legal answer');
  // continue → exactly one more attempt, then it parks again with a NEW stop
  const c = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'continue', '--note', 'read the brief', '--inline']);
  expect(c.exitCode).toBe(0);
  expect(c.stdout).toContain('WAITING ON YOU (supervisor-stop)');
  const t2 = await readTask(w.repo);
  expect(t2.supervisorStops).toHaveLength(2);
  expect(t2.supervisorStops[0].resolution.note).toBe('read the brief');
  // exactly ONE more stretch ran between the two stops
  expect((await stretchRows(w.repo)).filter((r) => r.type === 'launched' && r.kind === 'stretch')).toHaveLength(6);
  const dr = await driverRows(w);
  expect(dr.filter((x) => /operator note\] read the brief/.test(x.instruction) || x.instruction.includes('read the brief')).length).toBeGreaterThanOrEqual(0);
  // the stale first gate id is refused with the new question
  const late = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'continue', '--inline']);
  expect(late.exitCode).toBe(1);
  expect(late.stdout).toMatch(/already answered|question changed/);
}, 240_000);

test('limits: a launched stretch without completion is charged at cap; when the accounted total reaches the budget the runner records a limit and parks LIMIT REACHED; continue --usd extends and work resumes', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', '--usd', '0.5', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  // a crashed stretch: launched, never completed → charged at its cap ($3) → over the $0.5 budget
  await appendFile(join(S(w.repo), 'runner', 'stretches.jsonl'), `${JSON.stringify({ type: 'launched', id: 'crashed-1', kind: 'stretch', capUsd: 3, at: new Date().toISOString() })}\n`);
  const gate = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('WAITING ON YOU (limit)');
  const st = await ben(w, ['status', '--repo', w.repo]);
  expect(st.stdout).toContain('LIMIT REACHED');
  expect(st.stdout).toContain('unreported, charged at cap');
  const t = await readTask(w.repo);
  expect(t.limitEvents[0].kind).toBe('usd');
  const g2 = t.gate.id;
  const noAmount = await ben(w, ['resume', '--repo', w.repo, '--gate', g2, '--choose', 'continue', '--inline']);
  expect(noAmount.exitCode).toBe(1);
  const ok = await ben(w, ['resume', '--repo', w.repo, '--gate', g2, '--choose', 'continue', '--usd', '10', '--inline']);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain('READY FOR REVIEW');
}, 240_000);

test('actor audit: a human-kind record by an actor outside the allowlist stops the runner before anything leaves the machine', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  // a forged approval by an unknown actor (the driver could never write this; a harness regression could)
  const gate = (await readTask(w.repo)).gate.id;
  // an approval attributed to the RUNNER's own identity is just as forged as a stranger's: actors are validated per act kind
  const apr = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'record-approval', '--by', 'ben-runner', '--decision', 'APPROVE', '--repo', w.repo], { cwd: w.repo, timeoutMs: 30_000 });
  expect(apr.exitCode).toBe(0);
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('NEEDS YOU');
  expect(r.stdout).toContain('approval by ben-runner');
  expect(JSON.parse(await readFile(w.store, 'utf8').catch(() => '{"prs":[]}')).prs ?? []).toHaveLength(0);
  expect(gate).toBeDefined();
}, 240_000);

test('publication is refused while .git/config carries a disallowed key; nothing is pushed', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  await git(w.repo, 'config', 'core.hooksPath', '.githooks');
  const gate = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('NEEDS YOU');
  expect(r.stdout).toMatch(/core\.hookspath/i); // git lowercases keys in --list
  const ls = await execArgv(['git', '-C', w.remote, 'rev-parse', '--verify', '-q', 'refs/heads/ben/add-a-subtract-function'], { cwd: w.remote, timeoutMs: 10_000 });
  expect(ls.exitCode).not.toBe(0); // nothing pushed
  expect((await readTask(w.repo)).prIntent).toBeDefined(); // the intent stays pending for the next derivation
});

// ---------------------------------------------------------------------------
// publication drills — kill from a cold process at each boundary

async function killAt(w: World, args: string[], boundary: string): Promise<void> {
  const proc = Bun.spawn(['node', RUNNER, ...args], { cwd: w.repo, env: { ...process.env, ...w.env, BEN_RUNNER_PAUSE_AT: boundary }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const marker = join(S(w.repo), `.runner-paused-${boundary.replaceAll(':', '_')}`);
  let reached = false;
  for (let i = 0; i < PAUSE_BOUNDARY_WAIT_MS / PAUSE_BOUNDARY_POLL_MS; i++) {
    if (existsSync(marker)) {
      reached = true;
      break;
    }
    await Bun.sleep(PAUSE_BOUNDARY_POLL_MS);
  }
  proc.kill(9);
  await proc.exited;
  if (!reached) throw new Error(`never reached ${boundary}`);
  rmSync(marker, { force: true });
  rmSync(join(S(w.repo), 'runner.lock'), { force: true });
  rmSync(join(S(w.repo), '.run-lock'), { force: true });
}

async function toApprovedIntent(w: World): Promise<string> {
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const gate = (await readTask(w.repo)).gate.id;
  const ans = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'answer', '--expect-gate', gate, '--choose', 'approve', '--by', 'operator', '--repo', w.repo], { cwd: w.repo, timeoutMs: 30_000 });
  expect(ans.exitCode).toBe(0);
  return gate;
}

test('kill after intent, before push: reconciliation finds nothing pushed / no PR → pr-retry (human) → retry → exactly one PR', async () => {
  const w = await world();
  await toApprovedIntent(w);
  await killAt(w, ['run', '--repo', w.repo], 'publish:before-push');
  expect((await readTask(w.repo)).prIntent).toBeDefined();
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('WAITING ON YOU (pr-retry)');
  const t = await readTask(w.repo);
  expect(t.prInspections.at(-1)).toMatchObject({ branch: 'absent', pr: 'absent', by: 'ben-runner' });
  const gate = t.gate.id;
  const retry = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'retry', '--inline']);
  expect(retry.exitCode).toBe(0);
  expect(retry.stdout).toContain('READY FOR REVIEW');
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
  expect((await readTask(w.repo)).prIntent.attempt).toBe(2);
}, 240_000);

test('kill after push, before PR creation: branch at sha, no PR → pr-retry → retry creates the PR without a second push', async () => {
  const w = await world();
  await toApprovedIntent(w);
  await killAt(w, ['run', '--repo', w.repo], 'publish:after-push');
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r.stdout).toContain('WAITING ON YOU (pr-retry)');
  const t = await readTask(w.repo);
  expect(t.prInspections.at(-1)).toMatchObject({ branch: 'at-sha', pr: 'absent' });
  const gate = t.gate.id;
  const retry = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'retry', '--inline']);
  expect(retry.stdout).toContain('READY FOR REVIEW');
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).toContain('push skipped');
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
}, 240_000);

test('kill after PR creation, before record-pr: the PR is found at the reviewed head → observation → record-pr, no second PR', async () => {
  const w = await world();
  await toApprovedIntent(w);
  await killAt(w, ['run', '--repo', w.repo], 'publish:after-create');
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('READY FOR REVIEW');
  const t = await readTask(w.repo);
  expect(t.prInspections.at(-1)).toMatchObject({ branch: 'at-sha', pr: 'exists' });
  expect(t.prRetries ?? []).toHaveLength(0);
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
  expect(t.pr.url).toBe('https://github.com/o/r/pull/1');
}, 240_000);

test('a stale publish result never authorizes publication: the runner publishes from the durable intent only', async () => {
  const w = await world();
  await toApprovedIntent(w);
  // forge a stale publish result for attempt 9 before the runner starts
  await writeFile(join(S(w.repo), 'last-next.json'), JSON.stringify({ outcome: 'publish', publication: { attempt: 9, headSha: 'f'.repeat(40) }, exit: 0, invocation: 'stale' }));
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('READY FOR REVIEW');
  const t = await readTask(w.repo);
  expect(t.pr.headSha).not.toBe('f'.repeat(40));
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// stretch modes and interactive exclusion

test('stretch modes: an install request is refused before approval and without a plan Dependencies section; research needs granted domains; the refusal reason reaches the driver', async () => {
  const handler = `
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
let n = 0;
export async function handle(instruction, ctx) {
  const S = join(ctx.cwd, '.ben');
  if (/Write the plan artifacts/.test(instruction) && !existsSync(join(S, '.requested'))) {
    writeFileSync(join(S, '.requested'), '1');
    writeFileSync(join(S, 'stretch-request.json'), JSON.stringify({ mode: 'install', packages: ['left-pad'] }));
    return { cost: 0.01, text: 'requesting install' };
  }
  if (/Write the plan artifacts/.test(instruction)) {
    writeFileSync(join(S, 'plan.md'), '# plan\\n\\nx\\n');
    writeFileSync(join(S, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 's', verification: { method: 'command', command: 'true' } }] }));
    writeFileSync(join(S, 'promises.json'), '[]'); writeFileSync(join(S, 'plan-files.json'), '["math.ts"]'); writeFileSync(join(S, 'gates.json'), '{"t":"true"}');
    return { cost: 0.01 };
  }
  return { cost: 0.01 };
}`;
  const w = await world({ handler });
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'thing']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const dr = await driverRows(w);
  const refused = dr.find((x) => /stretch request .* was refused|was refused: install stretches run only after/.test(x.instruction));
  expect(refused).toBeDefined();
  expect(refused.domains).toEqual([]); // stayed in work mode
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).toContain('→ work (install stretches run only after the plan is approved)');
}, 240_000);

test('interactive exclusion: run.mjs next refuses while the runner is alive; a dead runner lock is replaced', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  await writeFile(join(S(w.repo), 'runner.lock'), String(process.pid)); // "alive" runner
  const r = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'next', '--repo', w.repo], { cwd: w.repo, timeoutMs: 30_000 });
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('owns this task');
  await writeFile(join(S(w.repo), 'runner.lock'), '999999');
  const gate = (await readTask(w.repo)).gate.id;
  const ok = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain('READY FOR REVIEW');
}, 240_000);

test('offline: a network-failed stretch pauses with backoff and resumes when the network returns', async () => {
  const offlineFile = join(await makeTmpDir('offline-'), 'OFFLINE');
  const handler = `
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
export async function handle(instruction, ctx) {
  const S = join(ctx.cwd, '.ben');
  if (existsSync(${JSON.stringify(offlineFile)})) return { isError: true, text: 'API Error: Connection error (fetch failed)' };
  if (/commit/i.test(instruction) && !/Write the plan artifacts/.test(instruction)) {
    writeFileSync(join(ctx.cwd, 'done.txt'), 'done\\n');
    execSync('git add -A && git commit -q -m "feat: done"', { cwd: ctx.cwd });
    return { cost: 0.02 };
  }
  if (/Write the plan artifacts/.test(instruction)) {
    writeFileSync(join(S, 'plan.md'), '# plan\\n\\nx\\n');
    writeFileSync(join(S, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 's', verification: { method: 'command', command: 'true' } }] }));
    writeFileSync(join(S, 'promises.json'), '[]'); writeFileSync(join(S, 'plan-files.json'), '["math.ts"]'); writeFileSync(join(S, 'gates.json'), '{"t":"true"}');
  }
  return { cost: 0.01 };
}`;
  const w = await world({ handler });
  // The gh stub counts down offline observations; the driver fails while the marker exists.
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'thing'], { BEN_STUB_OFFLINE_FILE: offlineFile, BEN_RUNNER_BACKOFF_MS: '100' });
  // the assign preflight itself needs the network: write the marker AFTER preflight would be racy; instead start, then drive resume offline
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  await writeFile(offlineFile, '2'); // two offline reports, then the network returns
  const gate = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline'], { BEN_STUB_OFFLINE_FILE: offlineFile, BEN_RUNNER_BACKOFF_MS: '100' });
  expect(r.exitCode).toBe(0);
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).toContain('offline — retry in');
  expect(r.stdout).toContain('READY FOR REVIEW');
  const work = (await driverRows(w)).filter(x => !/Reply with exactly/.test(x.instruction));
  const resumedFailure = work.findIndex(x => x.resumed && !/Write the plan artifacts/.test(x.instruction));
  expect(resumedFailure).toBeGreaterThanOrEqual(0);
  expect(work[resumedFailure + 1].sessionId).not.toBe(work[resumedFailure].sessionId);
  expect(work[resumedFailure + 1].resumed).toBe(false);
}, 240_000);

// ---------------------------------------------------------------------------
// follow-up: task history, PR reconciliation, update-mode publication

test('follow-up: the delivered task moves intact under .ben/history/, lineage links it, the brief carries the note + unresolved threads + comments, and delivery updates the SAME PR (fast-forward, body edit)', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const g = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', g, '--choose', 'approve', '--inline']);
  expect(r.stdout).toContain('READY FOR REVIEW');
  const delivered = (await readTask(w.repo)).pr.headSha as string;
  const firstEvidence = await readFile(join(S(w.repo), 'evidence', 'criteria-matrix.json'), 'utf8');
  // a follow-up handler: the plan asks to rename; implementation commits the rename
  await writeFile(
    w.handler,
    DEFAULT_HANDLER.replace("'# plan\\n\\nAdd subtract() per brief.md.\\n'", "'# plan\\n\\nRename per the follow-up note in brief.md.\\n'")
      .replace('feat: subtract', 'refactor: rename per review')
      .replace("export function subtract(a: number, b: number): number {\\n  return a - b;\\n}\\n", "export function subtract(a: number, b: number): number {\\n  return a - b;\\n}\\nexport const summaryStyle = \"bold\";\\n"),
  );
  const f = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', 'Rename the command to inventory list and make the summary line bold.']);
  if (f.exitCode !== 0) console.log(f.stdout, f.stderr);
  expect(f.exitCode).toBe(0);
  expect(f.stdout).toContain('checked PR #1: open');
  expect(f.stdout).toContain('unchanged since ben');
  expect(f.stdout).toContain('previous task kept under .ben/history/1-add-a-subtract-function/');
  expect(f.stdout).toContain('WAITING ON YOU (approval)');
  // history intact
  const hist = join(S(w.repo), 'history', '1-add-a-subtract-function');
  expect(await readFile(join(hist, 'evidence', 'criteria-matrix.json'), 'utf8')).toBe(firstEvidence);
  expect(existsSync(join(hist, 'task.json'))).toBe(true);
  expect(existsSync(join(hist, 'rounds.json'))).toBe(true);
  expect(existsSync(join(hist, 'reviews'))).toBe(true);
  expect(existsSync(join(hist, 'runner', 'stretches.jsonl'))).toBe(true);
  const lineage = JSON.parse(await readFile(join(S(w.repo), 'lineage.json'), 'utf8'));
  expect(lineage[0]).toMatchObject({ n: 1, status: 'done', pr: 1, deliveredHead: delivered });
  // the new task: update mode against PR #1 at the delivered head
  const t2 = await readTask(w.repo);
  expect(t2.assignment.publication).toMatchObject({ mode: 'update', pr: { number: 1, headAtAssign: delivered }, base: 'main' });
  expect(t2.assignment.publication.baseSha).toBe(delivered);
  const brief = await readFile(join(S(w.repo), 'brief.md'), 'utf8');
  expect(brief).toContain('Rename the command to inventory list');
  expect(brief).toContain('reviewer: rename this'); // the unresolved thread
  expect(brief).not.toContain('resolved one'); // the resolved thread is skipped
  expect(brief).toContain('looks good, one nit'); // the top-level comment
  // approve → build → verify → diff GO → publication in UPDATE mode: fast-forward push + body edit, no second PR
  const g2 = t2.gate.id;
  const r2 = await ben(w, ['resume', '--repo', w.repo, '--gate', g2, '--choose', 'approve', '--inline']);
  if (r2.exitCode !== 0) console.log(r2.stdout, r2.stderr);
  expect(r2.stdout).toContain('READY FOR REVIEW');
  const t3 = await readTask(w.repo);
  expect(t3.pr.url).toBe('https://github.com/o/r/pull/1');
  expect(t3.pr.headSha).not.toBe(delivered);
  const store = JSON.parse(await readFile(w.store, 'utf8'));
  expect(store.prs).toHaveLength(1);
  expect(store.prs[0].body.replace(/\n+$/, '')).toBe((await readFile(join(S(w.repo), 'pr-body.md'), 'utf8')).replace(/\n+$/, ''));
  const remoteSha = (await execArgv(['git', '-C', w.remote, 'rev-parse', 'refs/heads/ben/add-a-subtract-function'], { cwd: w.remote, timeoutMs: 10_000 })).stdout.trim();
  expect(remoteSha).toBe(t3.pr.headSha);
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).toContain('pr body updated');
  // status shows the lineage
  const st = await ben(w, ['status', '--repo', w.repo]);
  expect(st.stdout).toContain('READY FOR REVIEW');
}, 300_000);

test('follow-up refuses a merged PR and needs --reopen/--abandon for a closed one; an interrupted history move resumes without loss', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  const g = (await readTask(w.repo)).gate.id;
  expect((await ben(w, ['resume', '--repo', w.repo, '--gate', g, '--choose', 'approve', '--inline'])).stdout).toContain('READY FOR REVIEW');
  const store = JSON.parse(await readFile(w.store, 'utf8'));
  store.prs[0].state = 'MERGED';
  store.prs[0].mergedAt = new Date().toISOString();
  await writeFile(w.store, JSON.stringify(store));
  const merged = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', 'x']);
  expect(merged.exitCode).toBe(1);
  expect(merged.stderr).toContain('is merged');
  expect(existsSync(join(S(w.repo), 'history'))).toBe(false); // nothing moved
  store.prs[0].state = 'CLOSED';
  delete store.prs[0].mergedAt;
  await writeFile(w.store, JSON.stringify(store));
  const closed = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', 'x']);
  expect(closed.exitCode).toBe(1);
  expect(closed.stderr).toContain('--reopen');
  // interrupted move: kill while moving, then a second follow-up completes the SAME move (no duplicate, nothing lost)
  store.prs[0].state = 'OPEN';
  await writeFile(w.store, JSON.stringify(store));
  const before = await readFile(join(S(w.repo), 'task.json'), 'utf8'); // (a GO-only ride writes no ledger.jsonl)
  await killAt(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', 'x'], 'followup:moving');
  const lineage = JSON.parse(await readFile(join(S(w.repo), 'lineage.json'), 'utf8'));
  expect(lineage[0].status).toBe('moving');
  const again = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', 'x']);
  if (again.exitCode !== 0) console.log(again.stdout, again.stderr);
  expect(again.exitCode).toBe(0);
  const lineage2 = JSON.parse(await readFile(join(S(w.repo), 'lineage.json'), 'utf8'));
  expect(lineage2).toHaveLength(1);
  expect(lineage2[0].status).toBe('done');
  expect(await readFile(join(S(w.repo), lineage2[0].dest, 'task.json'), 'utf8')).toBe(before);
  expect(existsSync(join(S(w.repo), 'task.json'))).toBe(true); // the new task
  expect((await readTask(w.repo)).assignment.publication.mode).toBe('update');
}, 300_000);

test('diff audit: a PR merged or closed AFTER the follow-up started is never pushed to or edited — update-mode publication reads fresh state and parks NEEDS YOU', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  const g = (await readTask(w.repo)).gate.id;
  expect((await ben(w, ['resume', '--repo', w.repo, '--gate', g, '--choose', 'approve', '--inline'])).stdout).toContain('READY FOR REVIEW');
  const delivered = (await readTask(w.repo)).pr.headSha as string;
  await writeFile(w.handler, DEFAULT_HANDLER.replace('feat: subtract', 'refactor: rename per review').replace("export function subtract(a: number, b: number): number {\\n  return a - b;\\n}\\n", "export function subtract(a: number, b: number): number {\\n  return a - b;\\n}\\nexport const summaryStyle = \"bold\";\\n"));
  const f = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', 'Rename it.']);
  expect(f.stdout).toContain('WAITING ON YOU (approval)'); // the PR was OPEN when the follow-up started
  // the PR is merged while ben works
  const store = JSON.parse(await readFile(w.store, 'utf8'));
  store.prs[0].state = 'MERGED';
  store.prs[0].mergedAt = new Date().toISOString();
  const bodyBefore = store.prs[0].body;
  await writeFile(w.store, JSON.stringify(store));
  const g2 = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', g2, '--choose', 'approve', '--inline']);
  expect(r.stdout).toContain('NEEDS YOU');
  expect(r.stdout).toContain('is merged');
  expect(r.stdout).toContain('will not push to or modify a closed or merged PR');
  expect(r.stdout).not.toContain('READY FOR REVIEW');
  // nothing external moved: the remote branch is still at the delivered head, the body is untouched, still one PR
  const remoteSha = (await execArgv(['git', '-C', w.remote, 'rev-parse', 'refs/heads/ben/add-a-subtract-function'], { cwd: w.remote, timeoutMs: 10_000 })).stdout.trim();
  expect(remoteSha).toBe(delivered);
  const after = JSON.parse(await readFile(w.store, 'utf8'));
  expect(after.prs).toHaveLength(1);
  expect(after.prs[0].body).toBe(bodyBefore);
  expect((await readTask(w.repo)).pr).toBeUndefined();
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).not.toMatch(/Z push [0-9a-f]{12}:refs\/heads\//); // no push line (the NEEDS YOU line itself says "will not push")
  expect(log).not.toContain('pr body updated');
}, 300_000);


// ---------------------------------------------------------------------------
// corrections — recovery paths, ownership, binding

test('recovery: an empty or malformed runner lock is ambiguous ownership, never a dead owner to replace', async () => {
  const w = await world();
  await toApprovedIntent(w);
  const taskBefore = await readFile(join(S(w.repo), 'task.json'), 'utf8');
  const driversBefore = await driverRows(w);
  const lock = join(S(w.repo), 'runner.lock');
  for (const contents of ['', 'not-a-pid', '0', '-1', '1e3', '9007199254740993', '2147483648']) {
    await writeFile(lock, contents); // interrupted/malformed ownership record
    try {
      const result = await ben(w, ['run', '--repo', w.repo, '--once']);
      expect(result.exitCode).toBe(2);
      expect(await readFile(lock, 'utf8')).toBe(contents);
      expect(await readFile(join(S(w.repo), 'task.json'), 'utf8')).toBe(taskBefore);
      expect(await driverRows(w)).toEqual(driversBefore);
      expect(existsSync(w.store)).toBe(false);
    } finally {
      rmSync(lock, { force: true });
    }
  }
}, 240_000);

test('a dead .run-lock is a contention outcome the runner recovers from on its own', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  await writeFile(join(S(w.repo), '.run-lock'), '999999'); // a sequencer that died holding its lock
  const gate = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  // the answer itself refuses the stale lock (single-writer rule) — the runner then repairs and continues
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8').catch(() => '');
  expect(`${r.stdout}\n${log}`).toMatch(/stale \.run-lock|holds the lock/);
  rmSync(join(S(w.repo), '.run-lock'), { force: true });
  const r2 = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(r2.stdout).toContain('READY FOR REVIEW');
}, 240_000);

test('recovery: a second start cannot take a live runner lock or duplicate its driver, approval or PR', async () => {
  const w = await world();
  const entered = join(w.home, 'implementation-entered');
  const release = join(w.home, 'release-implementation');
  await writeFile(w.handler, DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (/Implement the plan and commit/.test(instruction)) {
    writeFileSync(${JSON.stringify(entered)}, 'entered');
    const deadline = Date.now() + ${PAUSE_BOUNDARY_WAIT_MS + 10000};
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw new Error('fixture release timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return baseHandle(instruction, ctx);
}`);
  await toApprovedIntent(w);
  const limitsBefore = (await readTask(w.repo)).assignment.limits;
  const first = ben(w, ['run', '--repo', w.repo]);
  try {
    const deadline = Date.now() + PAUSE_BOUNDARY_WAIT_MS;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(entered)).toBe(true);
    const lock = await readFile(join(S(w.repo), 'runner.lock'), 'utf8');
    const drivers = await driverRows(w);
    const second = await ben(w, ['run', '--repo', w.repo, '--once']);
    expect(second.exitCode).toBe(2);
    expect(await readFile(join(S(w.repo), 'runner.lock'), 'utf8')).toBe(lock);
    expect(await driverRows(w)).toEqual(drivers);
  } finally {
    await writeFile(release, 'release');
    await first;
  }
  expect((await first).stdout).toContain('READY FOR REVIEW');
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
  expect((await driverRows(w)).filter(row => /Implement the plan and commit/.test(row.instruction))).toHaveLength(1);
  expect((await readTask(w.repo)).assignment.limits).toEqual(limitsBefore);
  const status = JSON.parse((await ben(w, ['status', '--repo', w.repo, '--json'])).stdout);
  expect(status.sequencer.actors.filter((actor: { kind: string }) => actor.kind === 'approval')).toHaveLength(1);
  expect(existsSync(join(S(w.repo), 'runner.lock'))).toBe(false);
}, 240_000);

test('killing only the runner leaves a driver behind: the replacement runner terminates that process group before starting anything', async () => {
  const handler = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function handle(instruction, ctx) {
  const S = join(ctx.cwd, '.ben');
  if (/Write the plan artifacts/.test(instruction)) {
    writeFileSync(join(S, 'plan.md'), '# plan\\n\\nx\\n');
    writeFileSync(join(S, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 's', verification: { method: 'command', command: 'true' } }] }));
    writeFileSync(join(S, 'promises.json'), '[]'); writeFileSync(join(S, 'plan-files.json'), '["math.ts"]'); writeFileSync(join(S, 'gates.json'), '{"t":"true"}');
    return { cost: 0.01 };
  }
  if (/commit/i.test(instruction)) return { hang: true }; // the implementation stretch hangs; preflight/probe answer normally
  return { cost: 0.01 };
}`;
  const w = await world({ handler });
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'thing']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const gate = (await readTask(w.repo)).gate.id;
  const proc = Bun.spawn(['node', RUNNER, 'resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline'], { cwd: w.repo, env: { ...process.env, ...w.env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let pid: number | null = null;
  for (let i = 0; i < 400; i++) {
    const st = JSON.parse(await readFile(join(S(w.repo), 'runner', 'state.json'), 'utf8').catch(() => '{}'));
    if (st.currentStretchPid) {
      pid = st.currentStretchPid;
      break;
    }
    await Bun.sleep(50);
  }
  expect(pid).not.toBeNull();
  proc.kill(9); // the RUNNER only
  await proc.exited;
  const alive = () => {
    try {
      process.kill(pid as number, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive()).toBe(true); // the hanging driver survived the runner
  rmSync(join(S(w.repo), 'runner.lock'), { force: true });
  const proc2 = Bun.spawn(['node', RUNNER, 'run', '--repo', w.repo, '--once'], { cwd: w.repo, env: { ...process.env, ...w.env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  for (let i = 0; i < 200 && alive(); i++) await Bun.sleep(50);
  expect(alive()).toBe(false); // reaped before the new runner did anything
  proc2.kill(9);
  await proc2.exited;
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).toContain('orphaned driver process group');
}, 240_000);

test('corrupt task.json: the runner parks NEEDS YOU with a saved copy; resume --choose repair re-creates the record from its baseline', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const good = await readFile(join(S(w.repo), 'task.json'), 'utf8');
  await writeFile(join(S(w.repo), 'task.json'), good.slice(0, -25)); // a torn tail: unparseable, baseline still readable
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('task.json is corrupt');
  const st = JSON.parse(await readFile(join(S(w.repo), 'runner', 'state.json'), 'utf8'));
  expect(st.needsYou.kind).toBe('task-json-unreadable');
  expect(existsSync(st.needsYou.copy)).toBe(true);
  const status = await ben(w, ['status', '--repo', w.repo]);
  expect(status.stdout).toContain('NEEDS YOU');
  const fixed = await ben(w, ['resume', '--repo', w.repo, '--choose', 'repair', '--inline']);
  if (fixed.exitCode !== 0) console.log(fixed.stdout, fixed.stderr);
  expect(fixed.stdout).toContain('re-created from the saved copy');
  const t = await readTask(w.repo);
  expect(t.base).toBe(JSON.parse(good).base);
  expect(t.adoption.by).toBe('operator');
}, 240_000);

test('the exact same resume line after a landed answer resumes the pending work without recording a second decision', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const gate = (await readTask(w.repo)).gate.id;
  // the answer lands directly (as if the runner crashed right after recording it, before launching)
  const ans = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'answer', '--expect-gate', gate, '--choose', 'approve', '--by', 'operator', '--repo', w.repo], { cwd: w.repo, timeoutMs: 30_000 });
  expect(ans.exitCode).toBe(0);
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('already answered');
  expect(r.stdout).toContain('READY FOR REVIEW');
  const sj = JSON.parse((await ben(w, ['status', '--repo', w.repo, '--json'])).stdout);
  expect(sj.sequencer.actors.filter((x: { kind: string }) => x.kind === 'approval')).toHaveLength(1);
}, 240_000);

test('manual criteria are answerable through the runner: resume --choose satisfied --reply records the ruling and the task continues', async () => {
  const handler = DEFAULT_HANDLER.replace(
    "JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 'subtract works', verification: { method: 'command', command: 'bun test' } }] })",
    "JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 'subtract works', verification: { method: 'command', command: 'bun test' } }, { id: 'C2', statement: 'a', verification: { method: 'command', command: 'true' } }, { id: 'C3', statement: 'b', verification: { method: 'command', command: 'true' } }, { id: 'C4', statement: 'the output reads well', verification: { method: 'manual' } }] })",
  );
  const w = await world({ handler });
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const g1 = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', g1, '--choose', 'approve', '--inline']);
  expect(r.stdout).toContain('WAITING ON YOU (manual-adjudication)');
  const wt = await readWaiting(w.repo);
  expect(wt.options.map((o: { token: string }) => o.token)).toEqual(['satisfied', 'accepted', 'abort']);
  const g2 = (await readTask(w.repo)).gate.id;
  const r2 = await ben(w, ['resume', '--repo', w.repo, '--gate', g2, '--choose', 'satisfied', '--reply', 'I ran it, the output reads fine', '--inline']);
  expect(r2.stdout).toContain('adjudication recorded');
  expect(r2.stdout).toContain('READY FOR REVIEW');
}, 240_000);

test('follow-up interrupted after the move but before initialization resumes from its persisted request', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  const g = (await readTask(w.repo)).gate.id;
  expect((await ben(w, ['resume', '--repo', w.repo, '--gate', g, '--choose', 'approve', '--inline'])).stdout).toContain('READY FOR REVIEW');
  await killAt(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', 'x'], 'followup:moved');
  const lineage = JSON.parse(await readFile(join(S(w.repo), 'lineage.json'), 'utf8'));
  expect(lineage[0].status).toBe('moved');
  expect(existsSync(join(S(w.repo), 'task.json'))).toBe(false); // the window: no active task, history moved
  const again = await ben(w, ['follow-up', '--repo', w.repo, '--inline']); // no --pr, no note: the persisted request governs
  if (again.exitCode !== 0) console.log(again.stdout, again.stderr);
  expect(again.exitCode).toBe(0);
  expect(again.stdout).toContain('follow-up task 1 created');
  const lineage2 = JSON.parse(await readFile(join(S(w.repo), 'lineage.json'), 'utf8'));
  expect(lineage2).toHaveLength(1);
  expect(lineage2[0].status).toBe('done');
  expect((await readTask(w.repo)).assignment.publication.mode).toBe('update');
  expect(await readFile(join(S(w.repo), 'brief.md'), 'utf8')).toContain('x');
}, 300_000);

test('reinspect performs a real inspection: a resolved branch conflict routes to the retry gate; publication refuses a branch the assignment did not bind', async () => {
  const w = await world();
  await toApprovedIntent(w);
  await killAt(w, ['run', '--repo', w.repo], 'publish:before-push');
  // someone else pushes to the task branch
  const other = realpathSync(await makeTmpDir('other-'));
  await execArgv(['git', 'clone', '-q', w.remote, other], { cwd: other, timeoutMs: 30_000 });
  await execArgv(['git', '-C', other, 'checkout', '-q', '-b', 'ben/add-a-subtract-function'], { cwd: other, timeoutMs: 30_000 });
  await writeFile(join(other, 'intruder.txt'), 'x');
  await execArgv(['git', '-C', other, '-c', 'user.name=o', '-c', 'user.email=o@x', 'add', '-A'], { cwd: other, timeoutMs: 30_000 });
  await execArgv(['git', '-C', other, '-c', 'user.name=o', '-c', 'user.email=o@x', 'commit', '-q', '-m', 'intruder'], { cwd: other, timeoutMs: 30_000 });
  await execArgv(['git', '-C', other, 'push', '-q', 'origin', 'ben/add-a-subtract-function'], { cwd: other, timeoutMs: 30_000 });
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r.stdout).toContain('WAITING ON YOU (pr-branch-conflict)');
  // the intruder's branch is removed; `reinspect` records fresh facts and the sequencer routes to pr-retry
  await execArgv(['git', '-C', w.remote, 'update-ref', '-d', 'refs/heads/ben/add-a-subtract-function'], { cwd: w.remote, timeoutMs: 30_000 });
  const ri = await ben(w, ['resume', '--repo', w.repo, '--choose', 'reinspect', '--inline']);
  expect(ri.stdout).toContain('re-inspected GitHub — branch absent');
  expect(ri.stdout).toContain('WAITING ON YOU (pr-retry)');
  const t = await readTask(w.repo);
  expect(t.prInspections.at(-1)).toMatchObject({ branch: 'absent', pr: 'absent' });
  expect(t.prRetries ?? []).toHaveLength(0); // observation only — no decision recorded
}, 300_000);


// ---------------------------------------------------------------------------
// Offline convergence through the runner, with no authoritative-state edits.

const CONVERGENCE_HANDLER = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  const S = join(ctx.cwd, '.ben');
  if (/proposal\\.json/.test(instruction) && !existsSync(join(S, 'proposal.json'))) {
    const blockers = JSON.parse(readFileSync(join(S, 'blockers.json'), 'utf8'));
    writeFileSync(join(S, 'proposal.json'), JSON.stringify(blockers.map(b => ({ fingerprint: b.fingerprint, action: 'resolved', detail: 'Add the requested boundary example' }))));
    return { cost: 0.01 };
  }
  if (/resolutions\\.json/.test(instruction)) {
    const file = REVIEW_KIND === 'plan' ? join(S, 'plan.md') : join(ctx.cwd, 'math.ts');
    writeFileSync(file, readFileSync(file, 'utf8') + '\\n// Boundary example: add(0, 0) === 0\\n');
    if (REVIEW_KIND === 'diff') execSync('git add math.ts && git commit -q -m "test: boundary example"', { cwd: ctx.cwd });
    writeFileSync(join(S, 'resolutions.json'), readFileSync(join(S, 'proposal.json')));
    return { cost: 0.01 };
  }
  return baseHandle(instruction, ctx);
}
`;

for (const kind of ['plan', 'diff'] as const) {
  for (const stop of ['hard cap', 'churn'] as const) {
    test(`runner convergence: ${kind} reconciles beyond soft cap without a grant, then parks on ${stop}`, async () => {
      const w = await world({ handler: `const REVIEW_KIND = ${JSON.stringify(kind)};\n${CONVERGENCE_HANDLER}` });
      const blocker = (id: string) => ({ id, severity: 'BLOCKER', claim: `boundary example ${id} missing`, evidence: 'math.ts add()', falsifier: `add boundary example ${id}` });
      const noGo = (...ids: string[]) => ({ verdict: 'NO_GO', blockers: ids.map(blocker) });
      // Round 2 is blocker-bearing and strictly decreasing. Round 3 either
      // hits the hard cap or churns at equal count inside a larger hard cap.
      const responses = [...(kind === 'diff' ? [GO] : []), noGo('B1', 'B2'), noGo('B1'), noGo(stop === 'churn' ? 'B3' : 'B1')];
      const calls = join(w.home, 'review-calls.json');
      const script = join(w.home, 'sequence.mjs');
      await writeFile(script, `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const calls = ${JSON.stringify(calls)};
const n = existsSync(calls) ? JSON.parse(readFileSync(calls, 'utf8')) : 0;
const responses = ${JSON.stringify(responses)};
if (n >= responses.length) throw new Error('unexpected extra review');
const a = process.argv.slice(2);
writeFileSync(a[a.indexOf('-o') + 1], JSON.stringify(responses[n]));
writeFileSync(calls, JSON.stringify(n + 1));
`);
      const cli = join(w.home, 'sequence-cli');
      await writeFile(cli, `#!/bin/sh\nexec node "${script}" "$@"\n`);
      chmodSync(cli, 0o755);
      w.env.BEN_REVIEWER_CLI_REAL = cli;
      let result = await ben(w, ['assign', '--repo', w.repo, '--inline', `--${kind}-rounds`, '1', `--${kind}-rounds-max`, stop === 'hard cap' ? '2' : '4', 'Add subtract']);
      if (kind === 'diff') {
        expect(result.stdout).toContain('WAITING ON YOU (approval)');
        result = await ben(w, ['resume', '--repo', w.repo, '--inline', '--gate', (await readTask(w.repo)).gate.id, '--choose', 'approve']);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('WAITING ON YOU (review-stop)');
      const rounds = JSON.parse(await readFile(join(S(w.repo), 'rounds.json'), 'utf8'));
      expect(rounds[kind]).toBe(3);
      expect(rounds.survivors[`${kind}-1`]).toBe(2);
      expect(rounds.survivors[`${kind}-2`]).toBe(1);
      expect(rounds.gates[kind].reason).toContain(stop === 'hard cap' ? 'hard round cap (2/2 consumed)' : 'new defect fingerprints');
      expect(rounds.grants ?? []).toEqual([]);
      const ledgerPath = join(S(w.repo), 'ledger.jsonl');
      const ledgerBytes = await readFile(ledgerPath, 'utf8');
      const rows = ledgerBytes.trim().split('\n').map(line => JSON.parse(line));
      expect(rows.filter(row => row.action === 'granted')).toEqual([]);
      for (const [round, count] of [[1, 2], [2, 1], [3, 1]]) {
        expect(rows.filter(row => row.kind === kind && row.round === round && row.action === 'raised')).toHaveLength(count!);
        expect(rows.filter(row => row.kind === kind && row.round === round && row.action === 'resolved')).toHaveLength(round === 3 ? 0 : count!);
      }
      const drivers = await driverRows(w);
      expect(drivers.filter(row => row.instruction.includes(`Blockers survive ${kind} round 2.`))).toHaveLength(1);
      expect(drivers.some(row => row.instruction.includes(`Blockers survive ${kind} round 3.`))).toBe(false);
      expect(JSON.parse(await readFile(calls, 'utf8'))).toBe(responses.length);
      expect(existsSync(w.store)).toBe(false);
      // A plain noninteractive resume cannot answer the human gate.
      const resume = await ben(w, ['resume', '--repo', w.repo, '--inline']);
      expect(resume.exitCode).toBe(1);
      expect(resume.stderr).toContain('a noninteractive answer needs --gate');
      expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBytes);
      expect(await driverRows(w)).toHaveLength(drivers.length);
      expect(JSON.parse(await readFile(calls, 'utf8'))).toBe(responses.length);
    }, 300_000);
  }
}

// the half-applied grant (crash inside ledger.mjs grant between its two writes)

const RECONCILING_HANDLER = `
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export async function handle(instruction, ctx) {
  const S = join(ctx.cwd, '.ben');
  if (/Write the plan artifacts/.test(instruction)) {
    writeFileSync(join(S, 'plan.md'), '# plan\\n\\nx v1\\n');
    writeFileSync(join(S, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 's', verification: { method: 'command', command: 'true' } }] }));
    writeFileSync(join(S, 'promises.json'), '[]'); writeFileSync(join(S, 'plan-files.json'), '["math.ts"]'); writeFileSync(join(S, 'gates.json'), '{"t":"true"}');
    return { cost: 0.01 };
  }
  if (/proposal\\.json/.test(instruction) && !existsSync(join(S, 'proposal.json'))) {
    const b = JSON.parse(readFileSync(join(S, 'blockers.json'), 'utf8'));
    writeFileSync(join(S, 'proposal.json'), JSON.stringify(b.map((x) => ({ fingerprint: x.fingerprint, action: 'resolved', detail: 'will add the test' }))));
    return { cost: 0.01 };
  }
  if (/resolutions\\.json/.test(instruction)) {
    const p = JSON.parse(readFileSync(join(S, 'proposal.json'), 'utf8'));
    writeFileSync(join(S, 'resolutions.json'), JSON.stringify(p));
    writeFileSync(join(S, 'plan.md'), readFileSync(join(S, 'plan.md'), 'utf8') + '\\nrevised: adds the add(0,0) test\\n');
    return { cost: 0.01 };
  }
  return { cost: 0.01 };
}`;

test('half-applied grant: rounds.json holds the grant and the slot is gone, the ledger row never landed → the runner rolls it back, restores the slot, and the same question re-presents with "did not complete"; the next answer lands cleanly', async () => {
  const w = await world({ handler: RECONCILING_HANDLER });
  // a plan review that hits the hard cap on round 1: soft 1, max 1, real-shaped NO_GO
  await w.reviewer.respond({ verdict: 'NO_GO', blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'the empty case is unhandled', evidence: 'math.ts add()', falsifier: 'a test for add(0,0)' }] });
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', '--plan-rounds', '1', '--plan-rounds-max', '1', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (review-stop)');
  const rounds0 = JSON.parse(await readFile(join(S(w.repo), 'rounds.json'), 'utf8'));
  expect(rounds0.gates.plan).toBeDefined();
  const gate = (await readTask(w.repo)).gate.id;
  // the crash window: the referee writes rounds.json, then cannot append the ledger row
  const ledgerPath = join(S(w.repo), 'ledger.jsonl');
  const ledgerBefore = await readFile(ledgerPath, 'utf8');
  (await import('node:fs')).chmodSync(ledgerPath, 0o444);
  const ans = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'continue', '--inline']);
  (await import('node:fs')).chmodSync(ledgerPath, 0o644);
  expect(ans.exitCode).not.toBe(0);
  const rounds1 = JSON.parse(await readFile(join(S(w.repo), 'rounds.json'), 'utf8'));
  expect(rounds1.grants).toHaveLength(1); // the half that landed
  expect(rounds1.gates?.plan).toBeUndefined(); // the slot the referee lifted
  expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore); // the half that did not
  const t1 = await readTask(w.repo);
  expect(t1.grantIntents).toEqual([expect.objectContaining({ consumed: false })]);
  // status: the parked note is spent (the slot is gone) → the operator resumes (the same printed line)
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'continue', '--inline']);
  expect(r.stdout).toContain('half-applied grant rolled back');
  expect(r.stdout).toContain('WAITING ON YOU (review-stop)');
  expect(r.stdout).toContain('your earlier answer did not complete');
  const rounds2 = JSON.parse(await readFile(join(S(w.repo), 'rounds.json'), 'utf8'));
  expect(rounds2.grants).toBeUndefined();
  expect(rounds2.gates.plan).toEqual(rounds0.gates.plan); // the exact slot, restored from task.gate
  expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore); // the ledger was never touched
  // an interactive `next` in the crash window (before the runner runs) is a fail-closed STOP, never a silent continuation on the unaudited budget
  (await import('node:fs')).chmodSync(ledgerPath, 0o444);
  const gateR = (await readTask(w.repo)).gate.id;
  const ans2 = await ben(w, ['resume', '--repo', w.repo, '--gate', gateR, '--choose', 'continue', '--inline']);
  (await import('node:fs')).chmodSync(ledgerPath, 0o644);
  expect(ans2.exitCode).not.toBe(0);
  const interactive = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'next', '--repo', w.repo], { cwd: w.repo, timeoutMs: 60_000 });
  expect(interactive.exitCode).toBe(2);
  expect(interactive.stdout).toContain('ledger audit entry is missing');
  expect(JSON.parse(await readFile(join(S(w.repo), 'rounds.json'), 'utf8')).grants).toHaveLength(1); // the STOP changed nothing
  // repeated recovery after that STOP (task.gate now names the stop): a plain resume rolls the second half-grant back too —
  // the slot comes from the grant intent itself, still one intent, no duplicate budget, ledger untouched
  const r2 = await ben(w, ['resume', '--repo', w.repo, '--inline']);
  expect(r2.stdout).toContain('half-applied grant rolled back');
  expect(r2.stdout).toContain('WAITING ON YOU (review-stop)');
  expect(JSON.parse(await readFile(join(S(w.repo), 'rounds.json'), 'utf8')).grants).toBeUndefined();
  expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);
  expect((await readTask(w.repo)).grantIntents.filter((g: { consumed: boolean }) => !g.consumed)).toHaveLength(1);
  // the same question, a new presentation: answering it lands the grant cleanly (both halves), work continues
  const gate2 = (await readTask(w.repo)).gate.id;
  expect(gate2).not.toBe(gate);
  await w.reviewer.respond(GO);
  const ok = await ben(w, ['resume', '--repo', w.repo, '--gate', gate2, '--choose', 'continue', '--inline']);
  expect(ok.stdout).toContain('granted 1 more plan round'); // both halves landed this time
  expect(ok.stdout).not.toContain('WAITING ON YOU (review-stop)'); // the stop is cleared; the loop moved on
  const rounds3 = JSON.parse(await readFile(join(S(w.repo), 'rounds.json'), 'utf8'));
  expect(rounds3.grants).toHaveLength(1);
  expect((await readFile(ledgerPath, 'utf8')).split('\n').filter((l) => l.includes('"granted"'))).toHaveLength(1);
  expect((await readTask(w.repo)).grantIntents.every((g: { consumed: boolean }) => g.consumed)).toBe(true);
}, 300_000);

// ---------------------------------------------------------------------------
// Publication title and failure-reporting regressions

test('lib: the PR title is the first line, bounded at a word boundary under GitHub\'s limit; a publication failure is one scrubbed, bounded line', () => {
  expect(prTitleFor('Add subtract()')).toBe('Add subtract()');
  expect(prTitleFor('  first line \n\nsecond line')).toBe('first line');
  expect(prTitleFor('')).toBe('ben task');
  expect(prTitleFor(undefined)).toBe('ben task');
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const t = prTitleFor(long);
  expect(t.length).toBeLessThanOrEqual(PR_TITLE_MAX);
  expect(PR_TITLE_MAX).toBeLessThan(256);
  expect(t.endsWith('…')).toBe(true);
  expect(t.slice(0, -1).endsWith(' ')).toBe(false); // cut at a word boundary, trailing space removed
  expect(long.startsWith(t.slice(0, -1))).toBe(true); // a prefix of the original, never rewritten
  expect(prTitleFor('x'.repeat(400)).length).toBeLessThanOrEqual(PR_TITLE_MAX); // no word boundary: hard cut
  const s = scrubForOperator('  create failed:\n HTTP 502 (token ghp_STUBTOKEN00000000000000 rejected; Bearer ghs_STUBBEARER0000000000) at https://user:pass@api.github.com/x ');
  expect(s).toBe('create failed: HTTP 502 (token [redacted] rejected; Bearer [redacted]) at https://[redacted]@api.github.com/x');
  expect(scrubForOperator('y'.repeat(700)).length).toBe(600);
});

test('a long assignment outcome publishes with a bounded PR title while the body keeps the full text; the same path serves existing-PR recording', async () => {
  const w = await world();
  const outcome = `Fix a real misclassification in the inventory listing. ${'The rule I want is long and specific. '.repeat(40)}`.trim();
  expect(outcome.length).toBeGreaterThan(256);
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', outcome]);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const gate = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline']);
  expect(r.stdout).toContain('READY FOR REVIEW');
  const prs = JSON.parse(await readFile(w.store, 'utf8')).prs;
  expect(prs).toHaveLength(1);
  expect(prs[0].title).toBe(prTitleFor(outcome));
  expect(prs[0].title.length).toBeLessThanOrEqual(256);
  expect(prs[0].body).toContain(outcome); // the full assignment lives in the body (What / Why)
  expect((await readTask(w.repo)).title).toBe(outcome); // the task record keeps the operator's words unbounded
}, 240_000);

test('a failed PR creation reaches the retry request scrubbed — what failed, what GitHub showed and when, what retry does; retry then creates exactly one PR', async () => {
  const w = await world();
  await toApprovedIntent(w);
  const marker = join(w.home, 'fail-create-once');
  await writeFile(marker, '1');
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline'], { BEN_STUB_GH_FAIL_CREATE_FILE: marker });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('WAITING ON YOU (pr-retry)');
  expect(r.stdout).toContain('Publishing failed: gh pr create failed: pull request create failed: HTTP 502');
  expect(r.stdout).toContain('[redacted]');
  expect(r.stdout).not.toContain('STUBTOKEN');
  expect(r.stdout).not.toContain('STUBBEARER');
  const t = await readTask(w.repo);
  const insp = t.prInspections.at(-1);
  expect(insp).toMatchObject({ branch: 'at-sha', pr: 'absent', by: 'ben-runner' });
  expect(insp.failure).toContain('HTTP 502');
  expect(insp.failure).not.toContain('STUBTOKEN');
  const w1 = await readWaiting(w.repo);
  expect(w1.kind).toBe('pr-retry');
  expect(w1.question).toContain(`At ${insp.at} GitHub showed the branch pushed at the reviewed commit and no pull request.`);
  expect(w1.question).toContain('Retry will skip the push (the branch is already at the reviewed commit) and create the pull request — exactly once, never a second PR.');
  expect(w1.packet).toContain('The last publication attempt failed: gh pr create failed');
  expect(w1.packet).toContain(`GitHub as observed at ${insp.at}: branch ben/add-a-subtract-function pushed at the reviewed commit, no pull request for it.`);
  expect(w1.binding.inspectionSha).toBe(inspectionSha(insp)); // the retry authorization binds the inspection that carries the failure
  const status = await ben(w, ['status', '--repo', w.repo]);
  expect(status.stdout).toContain('WAITING ON YOU');
  expect(status.stdout).toContain('Publishing failed: gh pr create failed');
  expect(status.stdout).not.toContain('STUBTOKEN');
  const retry = await ben(w, ['resume', '--repo', w.repo, '--gate', t.gate.id, '--choose', 'retry', '--inline']);
  expect(retry.exitCode).toBe(0);
  expect(retry.stdout).toContain('READY FOR REVIEW');
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).toContain('push skipped');
  expect(log).not.toContain('STUBTOKEN'); // the runner log is scrubbed too
  const t2 = await readTask(w.repo);
  expect(t2.prRetries.at(-1).inspectionSha).toBe(inspectionSha(insp));
  const st = JSON.parse(await readFile(join(S(w.repo), 'runner', 'state.json'), 'utf8'));
  expect(st.lastPublicationFailure).toBeUndefined(); // consumed by the inspection, never carried to a later intent
}, 240_000);

test('recovery: the PR was created remotely but local recording failed → the inspection records the failure AND the existing PR at the reviewed head → recorded without a retry, exactly one PR', async () => {
  const w = await world();
  await toApprovedIntent(w);
  const marker = join(w.home, 'fail-view-once');
  await writeFile(marker, '1');
  const r = await ben(w, ['resume', '--repo', w.repo, '--inline'], { BEN_STUB_GH_FAIL_VIEW_FILE: marker });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('READY FOR REVIEW');
  const t = await readTask(w.repo);
  const insp = t.prInspections.at(-1);
  expect(insp).toMatchObject({ branch: 'at-sha', pr: 'exists', by: 'ben-runner' });
  expect(insp.failure).toContain('gh pr view failed');
  expect(t.prRetries ?? []).toHaveLength(0);
  expect(t.pr.url).toBe(insp.url);
  expect(JSON.parse(await readFile(w.store, 'utf8')).prs).toHaveLength(1);
  const log = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(log).toContain('publication error: gh pr view failed');
  expect(log).toContain('record-pr https://github.com/o/r/pull/1 → 0');
}, 240_000);

test('resume --repin re-pins from the INSTALL, not from the task\'s old pin (the re-exec is skipped for the operator act)', async () => {
  const w = await world();
  await toApprovedIntent(w); // a task with a pin (assign by operator) parked at approval → answered; the runner is not running
  const pinPath = (await import('node:fs')).readdirSync(join(w.home, 'tasks')).map((d) => join(w.home, 'tasks', d, 'runtime.json')).find((p) => existsSync(p))!;
  const before = JSON.parse(await readFile(pinPath, 'utf8'));
  expect(before.by).toContain('assign by');
  const r = await ben(w, ['resume', '--repo', w.repo, '--repin']);
  expect(r.stdout).toContain('runtime re-pinned');
  const after = JSON.parse(await readFile(pinPath, 'utf8'));
  expect(after.by).toBe('resume --repin by operator');
  expect(after.install).toBe(BEN_DIR); // the install, never the pin directory
  expect(after.dir.startsWith(join(w.home, 'runtime'))).toBe(true);
  expect(after.digest).toBe(before.digest); // the install has not changed in a test run: same content, same digest
}, 240_000);

test('(focused): ordinary task-bound commands run the task\'s EXISTING pin; resume --repin runs from the install and moves the task to the current runtime; later commands run the new pin; the old pin is untouched', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)'); // parked (unanswered) task, pin A from assign, no runner alive
  const pinPath = (await import('node:fs')).readdirSync(join(w.home, 'tasks')).map((d) => join(w.home, 'tasks', d, 'runtime.json')).find((p) => existsSync(p))!;
  const current = JSON.parse(await readFile(pinPath, 'utf8'));
  // an OLD runtime: a copy of the current one under another digest whose runner announces itself on every command
  const oldDir = join(w.home, 'runtime', 'oldpin0000000000');
  (await import('node:fs')).cpSync(current.dir, oldDir, { recursive: true });
  const oldRunner = join(oldDir, 'scripts', 'runner.mjs');
  await writeFile(oldRunner, (await readFile(oldRunner, 'utf8')).replace('switch (command) {', "console.log('OLD-PIN-MARKER ' + command);\nswitch (command) {"));
  await writeFile(pinPath, JSON.stringify({ ...current, dir: oldDir, digest: 'oldpin0000000000', by: 'test: older pin' }));
  // ordinary commands re-execute from the OLD pin and leave it in place
  const s1 = await ben(w, ['status', '--repo', w.repo]);
  expect(s1.stdout).toContain('OLD-PIN-MARKER status');
  const r1 = await ben(w, ['resume', '--repo', w.repo]); // a plain resume on a parked task (no answer, not a TTY)
  expect(r1.stdout).toContain('OLD-PIN-MARKER resume');
  expect(r1.exitCode).toBe(1);
  expect(JSON.parse(await readFile(pinPath, 'utf8')).dir).toBe(oldDir);
  const rp = await ben(w, ['repair', '--repo', w.repo]);
  expect(rp.stdout).toContain('OLD-PIN-MARKER repair');
  // resume --repin runs from the INSTALL (no marker) and re-pins to the install's runtime
  const r2 = await ben(w, ['resume', '--repo', w.repo, '--repin']);
  expect(r2.stdout).not.toContain('OLD-PIN-MARKER');
  expect(r2.stdout).toContain(`runtime re-pinned to ${current.dir}`);
  const after = JSON.parse(await readFile(pinPath, 'utf8'));
  expect(after.dir).toBe(current.dir);
  expect(after.digest).toBe(current.digest);
  expect(after.install).toBe(BEN_DIR);
  expect(after.by).toBe('resume --repin by operator');
  // later commands run the NEW pin; the old runtime directory is untouched
  const s2 = await ben(w, ['status', '--repo', w.repo]);
  expect(s2.stdout).not.toContain('OLD-PIN-MARKER');
  expect(s2.stdout).toContain('WAITING ON YOU');
  expect((await readFile(oldRunner, 'utf8')).includes('OLD-PIN-MARKER')).toBe(true);
  expect(existsSync(join(oldDir, '.complete'))).toBe(true);
  // the exemption changes nothing about answering: a repin combined with an answer still needs the gate id and records under the operator
  const gate = (await readTask(w.repo)).gate.id;
  const r3 = await ben(w, ['resume', '--repo', w.repo, '--repin', '--choose', 'approve']);
  expect(r3.exitCode).toBe(1);
  expect(r3.stdout + r3.stderr).toContain('needs --gate');
  expect(existsSync(join(S(w.repo), 'approval.json'))).toBe(false);
  const r4 = await ben(w, ['resume', '--repo', w.repo, '--repin', '--gate', gate, '--choose', 'approve', '--inline']);
  expect(r4.stdout).toContain('READY FOR REVIEW');
  expect(JSON.parse(await readFile(join(S(w.repo), 'approval.json'), 'utf8')).approvedBy).toBe('operator');
}, 240_000);

test('follow-up accepts the same caps/limits flags as assign (soft/hard plan caps, budget), persists them with the request, and the new task carries them', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const g = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', g, '--choose', 'approve', '--inline']);
  expect(r.stdout).toContain('READY FOR REVIEW');
  const f = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', '--plan-rounds', '1', '--plan-rounds-max', '3', '--usd', '19.6', 'Tighten the summary line.']);
  expect(f.exitCode).toBe(0);
  expect(f.stdout).toContain('WAITING ON YOU (approval)');
  const t = await readTask(w.repo);
  expect(t.config.planRounds).toBe(1);
  expect(t.config.planRoundsMax).toBe(3);
  expect(t.assignment.limits).toEqual({ usd: 19.6, hours: 8, stretches: 40 }); // only the named limit changes; the rest is inherited
  const lineage = JSON.parse(await readFile(join(S(w.repo), 'lineage.json'), 'utf8'));
  expect(lineage.at(-1).request.flags).toEqual({ 'plan-rounds': '1', 'plan-rounds-max': '3', usd: '19.6' });
  const status = await ben(w, ['status', '--repo', w.repo]);
  expect(status.stdout).toContain('of $19.6');
}, 240_000);

// ---------------------------------------------------------------------------
// runner recovery regressions

/** Fabricate a distinguishable runtime for a task: a copy of its current pin whose run.mjs/runner.mjs announce every invocation to BEN_TEST_PIN_LOG. */
async function fabricatePin(home: string, taskKeyPrefix: string, tag: string, from?: string): Promise<{ pinPath: string; dir: string }> {
  const fs = await import('node:fs');
  const pinPath = fs.readdirSync(join(home, 'tasks')).filter((d) => d.startsWith(taskKeyPrefix)).map((d) => join(home, 'tasks', d, 'runtime.json')).find((p) => existsSync(p))!;
  const current = JSON.parse(await readFile(pinPath, 'utf8'));
  const dir = join(home, 'runtime', `pin-${tag}`);
  fs.cpSync(from ?? current.dir, dir, { recursive: true });
  for (const f of ['run.mjs', 'runner.mjs']) {
    const p = join(dir, 'scripts', f);
    const src = await readFile(p, 'utf8');
    const [first = '', ...rest] = src.split('\n'); // keep the shebang first
    const probe = `import { appendFileSync as __benTestLog } from 'node:fs';\nif (process.env.BEN_TEST_PIN_LOG) __benTestLog(process.env.BEN_TEST_PIN_LOG, '${tag} ${f} ' + process.argv.slice(2, 4).join(' ') + '\\n');`;
    await writeFile(p, first.startsWith('#!') ? `${first}\n${probe}\n${rest.join('\n')}` : `${probe}\n${src}`);
  }
  await writeFile(pinPath, JSON.stringify({ ...current, dir, digest: `pin-${tag}`, by: 'test: fabricated' }));
  return { pinPath, dir };
}

test('service (HIGH): every per-task inspection and launch uses THAT task\'s pin — a parked task is skipped under its own runtime and the next runnable task is inspected and resumed under its own, never the previous task\'s memoized one', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)'); // task A: parked for the human — the service must skip it
  const w2 = await world();
  const b = await execArgv(['node', RUNNER, 'assign', '--repo', w2.repo, '--inline', 'Add a multiply helper with a test'], { cwd: w2.repo, timeoutMs: 240_000, env: { ...w2.env, BEN_RUNNER_HOME: w.home } });
  expect(b.stdout).toContain('WAITING ON YOU (approval)');
  const gateB = (await readTask(w2.repo)).gate.id;
  const ans = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'answer', '--expect-gate', gateB, '--choose', 'approve', '--by', 'operator', '--repo', w2.repo], { cwd: w2.repo, timeoutMs: 30_000 });
  expect(ans.exitCode).toBe(0); // task B: approved, no runner alive → runnable by the service
  const pinA = await fabricatePin(w.home, `${w.repo.split('/').pop()}-`, 'PIN-A'); // task keys are <repo basename>-<assignment id prefix>
  const pinB = await fabricatePin(w.home, `${w2.repo.split('/').pop()}-`, 'PIN-B');
  expect(pinA.dir).not.toBe(pinB.dir);
  await writeFile(join(w.home, 'registry.json'), JSON.stringify({ repos: [w.repo, w2.repo] }));
  const log = join(w.home, 'pin-log.txt');
  const s = await ben(w, ['serve'], { BEN_RUNNER_SERVE_ONCE: '1', BEN_TEST_PIN_LOG: log }, 240_000);
  if (s.exitCode !== 0) console.log(s.stdout, s.stderr);
  expect(s.exitCode).toBe(0);
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  const statusCalls = lines.filter((l) => / run\.mjs status /.test(l));
  expect(statusCalls[0]).toMatch(/^PIN-A run\.mjs status/); // task A inspected under A's runtime
  expect(statusCalls.slice(1).every((l) => /^PIN-B run\.mjs status/.test(l)), `status calls by pin: ${JSON.stringify(statusCalls)}`).toBe(true); // task B (and the loop it starts) under B's runtime only
  expect(lines.some((l) => /^PIN-B runner\.mjs run /.test(l))).toBe(true); // B's runner launched from B's pin
  expect(lines.some((l) => /^PIN-A runner\.mjs run /.test(l))).toBe(false);
  expect(lines.filter((l) => /^PIN-A /.test(l)).every((l) => / status /.test(l))).toBe(true); // A: inspected only, never launched
  expect(s.stdout).toContain(`serve: resuming ${w2.repo}`);
  expect(s.stdout).not.toContain(`serve: resuming ${w.repo}`);
  expect((await readTask(w2.repo)).pr).toBeDefined(); // B delivered
  expect((await readTask(w.repo)).pr).toBeUndefined(); // A still parked, untouched
  expect((await readWaiting(w.repo)).kind).toBe('approval');
}, 300_000);

test('follow-up (MEDIUM): an invalid caps/budget request is refused BEFORE any transition — the delivered task stays intact and a corrected command then works; valid requests still replay exactly', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  const g = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', g, '--choose', 'approve', '--inline']);
  expect(r.stdout).toContain('READY FOR REVIEW');
  const delivered = JSON.stringify(await readTask(w.repo));
  for (const bad of [['--usd', '-1'], ['--plan-rounds', '3', '--plan-rounds-max', '1'], ['--stretches', '2.5'], ['--hours', 'abc']]) {
    const f = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', ...bad, 'Tighten the summary line.']);
    expect(f.exitCode).not.toBe(0);
    expect(f.stdout + f.stderr).toMatch(/follow-up request refused/);
    expect(JSON.stringify(await readTask(w.repo))).toBe(delivered); // the delivered task is exactly as it was
    expect(existsSync(join(S(w.repo), 'history'))).toBe(false); // nothing moved
    expect(existsSync(join(S(w.repo), 'lineage.json'))).toBe(false); // nothing persisted
    expect(existsSync(join(S(w.repo), 'runner.lock'))).toBe(false); // the lock is released
  }
  const ok = await ben(w, ['follow-up', '--repo', w.repo, '--pr', '1', '--inline', '--usd', '5', '--plan-rounds', '1', '--plan-rounds-max', '3', 'Tighten the summary line.']);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain('WAITING ON YOU (approval)');
  const t = await readTask(w.repo);
  expect(t.assignment.limits.usd).toBe(5);
  expect(t.config.planRounds).toBe(1);
  expect(JSON.parse(await readFile(join(S(w.repo), 'lineage.json'), 'utf8')).at(-1).request.flags).toEqual({ usd: '5', 'plan-rounds': '1', 'plan-rounds-max': '3' });
}, 240_000);

test('resume --repin is a locked transition: refused while a runner owns the task, refused while a surviving driver owns the tree, allowed once the task is quiescent (lock taken for the replacement, then released)', async () => {
  const handler = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function handle(instruction, ctx) {
  const S = join(ctx.cwd, '.ben');
  if (/Write the plan artifacts/.test(instruction)) {
    writeFileSync(join(S, 'plan.md'), '# plan\\n\\nx\\n');
    writeFileSync(join(S, 'criteria.json'), JSON.stringify({ taskId: 'T1', criteria: [{ id: 'C1', statement: 's', verification: { method: 'command', command: 'true' } }] }));
    writeFileSync(join(S, 'promises.json'), '[]'); writeFileSync(join(S, 'plan-files.json'), '["math.ts"]'); writeFileSync(join(S, 'gates.json'), '{"t":"true"}');
    return { cost: 0.01 };
  }
  if (/commit/i.test(instruction)) return { hang: true };
  return { cost: 0.01 };
}`;
  const w = await world({ handler });
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'thing']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const gate = (await readTask(w.repo)).gate.id;
  const pinPath = (await import('node:fs')).readdirSync(join(w.home, 'tasks')).map((d) => join(w.home, 'tasks', d, 'runtime.json')).find((p) => existsSync(p))!;
  const before = await readFile(pinPath, 'utf8');
  const proc = Bun.spawn(['node', RUNNER, 'resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline'], { cwd: w.repo, env: { ...process.env, ...w.env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let pid: number | null = null;
  for (let i = 0; i < 400; i++) {
    const st = JSON.parse(await readFile(join(S(w.repo), 'runner', 'state.json'), 'utf8').catch(() => '{}'));
    if (st.currentStretchPid) {
      pid = st.currentStretchPid;
      break;
    }
    await Bun.sleep(50);
  }
  expect(pid).not.toBeNull();
  // 1. a runner owns the task → refused, pin unchanged
  const r1 = await ben(w, ['resume', '--repo', w.repo, '--repin']);
  expect(r1.exitCode).toBe(1);
  expect(r1.stdout + r1.stderr).toMatch(/a runner owns this task/);
  expect(await readFile(pinPath, 'utf8')).toBe(before);
  // kill the RUNNER only: under re-exec the runner is the pinned child whose pid the lock records, not the parent process
  const runnerPid = Number((await readFile(join(S(w.repo), 'runner.lock'), 'utf8')).trim());
  const isAlive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  process.kill(runnerPid, 'SIGKILL');
  proc.kill(9);
  await proc.exited;
  for (let i = 0; i < 100 && isAlive(runnerPid); i++) await Bun.sleep(50);
  expect(isAlive(runnerPid)).toBe(false);
  const alive = () => isAlive(pid as number);
  expect(alive()).toBe(true); // the hanging driver (its own process group) survived the runner
  // 2. the runner is dead but its driver still owns the working tree → refused, pin unchanged, the stale runner.lock is not left behind by the refusal
  const r2 = await ben(w, ['resume', '--repo', w.repo, '--repin']);
  expect(r2.exitCode).toBe(1);
  expect(r2.stdout + r2.stderr).toMatch(/driver process .* still owns/);
  expect(await readFile(pinPath, 'utf8')).toBe(before);
  try {
    process.kill(-(pid as number), 'SIGKILL');
  } catch {
    process.kill(pid as number, 'SIGKILL');
  }
  for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(50);
  expect(alive()).toBe(false);
  // 3. quiescent → the replacement happens under the runner lock and the lock is released afterwards
  const r3 = await ben(w, ['resume', '--repo', w.repo, '--repin']);
  expect(r3.stdout).toContain('runtime re-pinned');
  expect(JSON.parse(await readFile(pinPath, 'utf8')).by).toBe('resume --repin by operator');
  expect(existsSync(join(S(w.repo), 'runner.lock'))).toBe(false);
}, 300_000);

test('delayed launch after a repin: a launcher that resolved runtime A starts after the pin moved to B — it must never run A\'s runner code with B\'s trusted children; it hands off to the pinned runtime after taking ownership', async () => {
  const w = await world();
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'Add a subtract function with a test']);
  expect(a.stdout).toContain('WAITING ON YOU (approval)');
  const key = `${w.repo.split('/').pop()}-`;
  const fs = await import('node:fs');
  const pinPath = fs.readdirSync(join(w.home, 'tasks')).filter((d) => d.startsWith(key)).map((d) => join(w.home, 'tasks', d, 'runtime.json')).find((p) => existsSync(p))!;
  const original = JSON.parse(await readFile(pinPath, 'utf8')).dir;
  const pinA = await fabricatePin(w.home, key, 'PIN-A', original); // the task is pinned to A: any launcher resolves RUNNER_MJS(repo) = A
  const pinB = await fabricatePin(w.home, key, 'PIN-B', original); // the repin lands: the authoritative pin now says B (what resume --repin writes)
  expect(JSON.parse(await readFile(pinPath, 'utf8')).dir).toBe(pinB.dir);
  // the delayed launch: the launcher had already selected A's runner.mjs; it starts now, the lock is free
  const log = join(w.home, 'pin-log.txt');
  const r = await execArgv(['node', join(pinA.dir, 'scripts', 'runner.mjs'), 'run', '--repo', w.repo, '--once'], { cwd: w.repo, timeoutMs: 240_000, env: { ...w.env, BEN_RUNNER_NO_REEXEC: '1', BEN_TEST_PIN_LOG: log } });
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  expect(lines[0]).toMatch(/^PIN-A runner\.mjs run /); // A's runner code did start
  expect(lines.filter((l) => /^PIN-A run\.mjs /.test(l))).toHaveLength(0); // A never spawned a sequencer of its own
  expect(lines.filter((l) => /^PIN-B run\.mjs /.test(l)).length).toBeGreaterThan(0); // the work was done by B's sequencer …
  const mixed = lines.some((l) => /^PIN-B run\.mjs /.test(l)) && !lines.some((l) => /^PIN-B runner\.mjs run /.test(l));
  expect(mixed, `trace: ${JSON.stringify(lines)}`).toBe(false); // old runner code + new trusted children never happens
  expect(lines.some((l) => /^PIN-B runner\.mjs run /.test(l))).toBe(true); // … under B's runner, after the hand-off
  expect(r.exitCode).toBe(0); // the parked task was re-presented by the pinned runner and it exited at the park
  const rlogText = await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8');
  expect(rlogText).toContain('stale launcher');
  expect(JSON.parse(await readFile(pinPath, 'utf8')).dir).toBe(pinB.dir); // the pin is untouched
  expect(existsSync(join(S(w.repo), 'runner.lock'))).toBe(false); // ownership released cleanly
  expect((await readWaiting(w.repo)).kind).toBe('approval');
}, 240_000);


test('overnight: a lost resumed session is replaced and completes without a continue answer', async () => {
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  const marker = join(ctx.cwd, '.ben', 'lost-session-test');
  if (ctx.resumed && !existsSync(marker)) {
    writeFileSync(marker, ctx.sessionId);
    return { isError: true, text: 'No conversation found for session' };
  }
  if (existsSync(marker) && readFileSync(marker, 'utf8') === ctx.sessionId) return { isError: true, text: 'No conversation found for session' };
  return baseHandle(instruction, ctx);
}`;
  const w = await world({ handler });
  expect((await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract'])).stdout).toContain('WAITING ON YOU (approval)');
  const gate = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline'], { BEN_RUNNER_BACKOFF_MS: '1' });
  expect(r.stdout).toContain('READY FOR REVIEW');
  expect((await readTask(w.repo)).supervisorStops ?? []).toHaveLength(0);
  const work = (await driverRows(w)).filter(x => !/Reply with exactly/.test(x.instruction));
  expect(work.some((x, i) => i > 0 && !x.resumed && x.sessionId !== work[i - 1].sessionId)).toBe(true);
}, 240_000);

test('overnight: provider 429 while GitHub works retries automatically, but still reaches the approval gate', async () => {
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (/Write the plan artifacts/.test(instruction)) {
    const marker = join(ctx.cwd, '.ben', 'provider-retry-test');
    const n = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
    writeFileSync(marker, String(n + 1));
    if (n < 4) return { isError: true, text: 'HTTP 429 rate limit' };
  }
  return baseHandle(instruction, ctx);
}`;
  const w = await world({ handler });
  const r = await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract'], { BEN_RUNNER_BACKOFF_MS: '1' });
  expect(r.stdout).toContain('WAITING ON YOU (approval)');
  expect((await readTask(w.repo)).supervisorStops ?? []).toHaveLength(0);
  expect((await driverRows(w)).filter(x => /Write the plan artifacts/.test(x.instruction))).toHaveLength(5);
  expect((await readTask(w.repo)).pr).toBeUndefined();
}, 240_000);

test('overnight: bounded fresh-context recovery proceeds without a human continue', async () => {
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (/Write the plan artifacts/.test(instruction) && !instruction.includes('[runner recovery]')) return { text: 'no progress' };
  return baseHandle(instruction, ctx);
}`;
  const w = await world({ handler });
  const r = await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract']);
  expect(r.stdout).toContain('WAITING ON YOU (approval)');
  const work = (await driverRows(w)).filter(x => /Write the plan artifacts/.test(x.instruction));
  expect(work).toHaveLength(4);
  expect(work[3].resumed).toBe(false);
  expect(work[3].sessionId).not.toBe(work[2].sessionId);
  expect((await readTask(w.repo)).supervisorStops ?? []).toHaveLength(0);
}, 240_000);

test('overnight: progress tracks untracked contents and research, excluding symlinks', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = realpathSync(await makeTmpDir('progress-content-'));
  const file = join(dir, 'new.ts');
  const input = { stateDir: dir, headSha: 'head', worktreeStatus: '?? new.ts', worktreeDiff: '', ledgerLines: 0, extraFiles: [file] };
  await writeFile(file, 'first');
  const a = progressIdentity(input);
  await writeFile(file, 'second');
  expect(progressIdentity(input)).not.toBe(a);
  const external = realpathSync(await makeTmpDir('progress-external-'));
  await writeFile(join(external, 'secret'), 'a');
  symlinkSync(external, join(dir, 'link'));
  const linked = { ...input, extraFiles: [join(dir, 'link', 'secret')] };
  const before = progressIdentity(linked);
  await writeFile(join(external, 'secret'), 'b');
  expect(progressIdentity(linked)).toBe(before);
  expect(researchFiles(dir)).not.toContain(join(dir, 'link', 'secret'));
});

test('overnight: failure classification separates authentication, sessions and transient provider errors', () => {
  expect(failureKind('HTTP 429 rate limit')).toBe('transient');
  expect(failureKind('503 overloaded')).toBe('transient');
  expect(failureKind('401 unauthorized')).toBe('auth');
  expect(failureKind('No conversation found for session')).toBe('session');
  expect(failureKind('session log could not be written')).toBe('fatal');
});


test('overnight: retryable provider errors stay bounded and cannot extend the launch budget', async () => {
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (/Write the plan artifacts/.test(instruction)) return { isError: true, text: '503 overloaded' };
  return baseHandle(instruction, ctx);
}`;
  const w = await world({ handler });
  const r = await ben(w, ['assign', '--repo', w.repo, '--inline', '--stretches', '4', 'subtract'], { BEN_RUNNER_BACKOFF_MS: '1' });
  expect(r.stdout).toContain('WAITING ON YOU (limit)');
  const task = await readTask(w.repo);
  expect(task.limitExtensions ?? []).toHaveLength(0);
  expect(task.pr).toBeUndefined();
  expect((await driverRows(w)).filter(x => /Write the plan artifacts/.test(x.instruction)).length).toBeLessThan(7);
}, 240_000);

test('overnight: authentication failure parks immediately instead of burning recovery attempts', async () => {
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (/Write the plan artifacts/.test(instruction)) return { isError: true, text: '401 unauthorized' };
  return baseHandle(instruction, ctx);
}`;
  const w = await world({ handler });
  const r = await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract']);
  expect(r.stdout).toContain('Claude authentication needs renewal');
  expect((await driverRows(w)).filter(x => /Write the plan artifacts/.test(x.instruction))).toHaveLength(1);
}, 240_000);

test('overnight: service starts the second approved task while the first driver is still running', async () => {
  const w = await world();
  const w2 = await world();
  for (const [fixture, title] of [[w, 'first subtract'], [w2, 'second subtract']] as const) {
    const a = await ben(fixture, ['assign', '--repo', fixture.repo, '--inline', title], { BEN_RUNNER_HOME: w.home });
    expect(a.stdout).toContain('WAITING ON YOU (approval)');
    const gate = (await readTask(fixture.repo)).gate.id;
    const answer = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'answer', '--expect-gate', gate, '--choose', 'approve', '--by', 'operator', '--repo', fixture.repo], { cwd: fixture.repo, timeoutMs: 30_000 });
    expect(answer.exitCode).toBe(0);
  }
  const marker = join(w.home, 'second-started');
  const failed = join(w.home, 'first-starved');
  await writeFile(w.handler, DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (ctx.cwd === ${JSON.stringify(w2.repo)}) writeFileSync(${JSON.stringify(marker)}, 'started');
  if (ctx.cwd === ${JSON.stringify(w.repo)}) {
    const deadline = Date.now() + 15000;
    while (!existsSync(${JSON.stringify(marker)}) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    if (!existsSync(${JSON.stringify(marker)})) writeFileSync(${JSON.stringify(failed)}, 'starved');
  }
  return baseHandle(instruction, ctx);
}`);
  await writeFile(join(w.home, 'registry.json'), JSON.stringify({ repos: [w.repo, w2.repo] }));
  const r = await ben(w, ['serve'], { BEN_RUNNER_SERVE_ONCE: '1' });
  expect(r.exitCode).toBe(0);
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(failed)).toBe(false);
  expect(readdirSync(join(w.home, 'mirrors')).filter(n => n.startsWith('o-r-'))).toHaveLength(2);
}, 240_000);


test('overnight: transient PR inspection retries without authorizing another publication attempt', async () => {
  const w = await world();
  expect((await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract'])).stdout).toContain('WAITING ON YOU (approval)');
  const marker = join(w.home, 'inspection-failures');
  await writeFile(marker, '2');
  const gate = (await readTask(w.repo)).gate.id;
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline'], { BEN_RUNNER_BACKOFF_MS: '1', BEN_STUB_INSPECTION_FAILURE: marker });
  expect(r.stdout).toContain('WAITING ON YOU');
  expect(r.stdout).not.toContain('ben could not inspect GitHub');
  expect(await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8')).toContain('inspect: transient attempt 1/6');
  expect((await readTask(w.repo)).pr).toBeUndefined();
  expect(existsSync(w.store) ? JSON.parse(await readFile(w.store, 'utf8')).prs : []).toHaveLength(0);
}, 240_000);

test('overnight: live sequencer contention clears without manual resume', async () => {
  const w = await world();
  await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract']);
  const gate = (await readTask(w.repo)).gate.id;
  const answer = await execArgv(['node', fileURLToPath(new URL('../scripts/run.mjs', import.meta.url)), 'answer', '--expect-gate', gate, '--choose', 'approve', '--by', 'operator', '--repo', w.repo], { cwd: w.repo, timeoutMs: 30_000 });
  expect(answer.exitCode).toBe(0);
  const lock = join(S(w.repo), '.run-lock');
  await writeFile(lock, String(process.pid));
  const timer = setTimeout(() => rmSync(lock, { force: true }), 1200);
  try {
    const r = await ben(w, ['run', '--repo', w.repo], { BEN_RUNNER_BACKOFF_MS: '500' });
    expect(r.stdout).toContain('READY FOR REVIEW');
    expect(await readFile(join(S(w.repo), 'runner', 'runner.log'), 'utf8')).toContain('contention: transient attempt');
  } finally { clearTimeout(timer); rmSync(lock, { force: true }); }
}, 240_000);


test('overnight: readiness reports the human gate without answering it or launching a driver', async () => {
  const w = await world();
  await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract']);
  const before = (await driverRows(w)).length;
  const r = await ben(w, ['readiness', '--repo', w.repo]);
  expect(r.exitCode).toBe(0);
  const report = JSON.parse(r.stdout);
  expect(report.waiting.kind).toBe('approval');
  expect(report.keepAwake).toBe(false);
  expect(report.limits.stretches).toBe(40);
  expect((await driverRows(w)).length).toBe(before);
  expect((await readTask(w.repo)).pr).toBeUndefined();
}, 240_000);


test('overnight: service backoff is durable and releases its worker until retry is due', async () => {
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (/Write the plan artifacts/.test(instruction)) return { isError: true, text: '503 overloaded' };
  return baseHandle(instruction, ctx);
}`;
  const w = await world({ handler });
  const a = await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract'], { BEN_RUNNER_SERVICE_CHILD: '1', BEN_RUNNER_BACKOFF_MS: '60000' });
  expect(a.exitCode).toBe(0);
  const path = join(S(w.repo), 'runner', 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  expect(state.retries['driver-transient'].count).toBe(1);
  expect(state.sessionStarted).toBe(false);
  const before = (await driverRows(w)).length;
  const taskBefore = await readFile(join(S(w.repo), 'task.json'), 'utf8');
  await writeFile(join(w.home, 'registry.json'), JSON.stringify({ repos: [w.repo] }));
  // Separate service lifetimes must respect exactly the saved deadline and
  // retry count, including two service starts observing the same pending retry.
  const starts = await Promise.all([
    ben(w, ['serve'], { BEN_RUNNER_SERVE_ONCE: '1' }),
    ben(w, ['serve'], { BEN_RUNNER_SERVE_ONCE: '1' }),
  ]);
  expect(starts.every(result => result.exitCode === 0)).toBe(true);
  expect(JSON.parse(await readFile(path, 'utf8')).retries).toEqual(state.retries);
  expect(await readFile(join(S(w.repo), 'task.json'), 'utf8')).toBe(taskBefore);
  expect((await driverRows(w)).length).toBe(before);
  await writeFile(w.handler, DEFAULT_HANDLER);
  state.retries['driver-transient'].nextAt = Date.now() - 1;
  await writeFile(path, JSON.stringify(state));
  const b = await ben(w, ['serve'], { BEN_RUNNER_SERVE_ONCE: '1' });
  expect(b.stdout).toContain('WAITING ON YOU (approval)');
  expect((await driverRows(w)).length).toBe(before + 1);
  expect((await readTask(w.repo)).pr).toBeUndefined();
}, 240_000);


test('overnight: per-stretch turn and dollar caps continue under the unchanged task budget', async () => {
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  if (/Write the plan artifacts/.test(instruction)) {
    const marker = join(ctx.cwd, '.ben', 'stretch-limit-test');
    const n = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
    writeFileSync(marker, String(n + 1));
    if (n < 2) return { isError: true, subtype: n === 0 ? 'error_max_turns' : 'error_max_budget_usd', text: 'bounded stretch ended' };
  }
  return baseHandle(instruction, ctx);
}`;
  const w = await world({ handler });
  const r = await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract']);
  expect(r.stdout).toContain('WAITING ON YOU (approval)');
  const work = (await driverRows(w)).filter(x => /Write the plan artifacts/.test(x.instruction));
  expect(work).toHaveLength(3);
  expect(new Set(work.map(x => x.sessionId)).size).toBe(3);
  const task = await readTask(w.repo);
  expect(task.limitExtensions ?? []).toHaveLength(0);
  expect(task.supervisorStops ?? []).toHaveLength(0);
}, 240_000);


test('offline service: publication and pending inspection defer without remote actions', async () => {
  const marker = join(await makeTmpDir('offline-service-'), 'OFFLINE');
  const handler = DEFAULT_HANDLER.replace('export async function handle', 'async function baseHandle') + `
export async function handle(instruction, ctx) {
  const result = await baseHandle(instruction, ctx);
  if (/commit/i.test(instruction) && !/Write the plan artifacts/.test(instruction)) writeFileSync(${JSON.stringify(marker)}, '100');
  return result;
}`;
  const w = await world({ handler });
  expect((await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract'])).stdout).toContain('WAITING ON YOU (approval)');
  const gate = (await readTask(w.repo)).gate.id;
  const env = { BEN_RUNNER_SERVICE_CHILD: '1', BEN_RUNNER_BACKOFF_MS: '60000', BEN_STUB_OFFLINE_FILE: marker };
  const r = await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'approve', '--inline'], env);
  expect(r.exitCode).toBe(0);
  const path = join(S(w.repo), 'runner', 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  expect(state.paused.nextAt).toBeGreaterThan(Date.now());
  expect(state.lastPublicationFailure).toBeUndefined();
  const task = await readTask(w.repo);
  expect(task.prIntent).toBeDefined();
  expect(task.prInspections ?? []).toHaveLength(0);
  expect(task.pr).toBeUndefined();
  const remote = await execArgv(['git', '-C', w.remote, 'rev-parse', '--verify', task.assignment.publication.branch], { cwd: w.remote, timeoutMs: 10000 });
  expect(remote.exitCode).not.toBe(0);
  // A restart with a pending intent must defer its read-only inspection as well.
  delete state.paused;
  await writeFile(path, JSON.stringify(state));
  const log = join(w.home, 'offline-gh.log');
  expect((await ben(w, ['resume', '--repo', w.repo, '--inline'], { ...env, BEN_STUB_GH_LOG: log })).exitCode).toBe(0);
  expect(await readFile(log, 'utf8')).not.toContain('pr list');
  expect((await readTask(w.repo)).prInspections ?? []).toHaveLength(0);
  expect((await readTask(w.repo)).prIntent.attempt).toBe(1);
}, 240_000);


test('guidance: unknown/operator IDs, missing files and symlink references fail closed', async () => {
  const dir = await makeTmpDir('guidance-');
  const fs = await import('node:fs');
  fs.cpSync(join(BEN_DIR, 'references'), join(dir, 'references'), { recursive: true });
  expect(() => validateGuidance(dir)).not.toThrow();
  for (const id of ['../../private', '__proto__', 'constructor', undefined]) expect(() => readGuidance(dir, id)).toThrow();
  for (const id of ['publication', 'decisions', 'recovery', 'start', 'runner']) expect(() => withWorkGuidance(dir, id, 'work')).toThrow();
  fs.rmSync(join(dir, 'references/plan.md'));
  expect(() => withWorkGuidance(dir, 'plan', 'work')).toThrow('Required ben guidance unavailable');
  fs.symlinkSync(join(BEN_DIR, 'references/plan.md'), join(dir, 'references/plan.md'));
  expect(() => validateGuidance(dir)).toThrow('not a regular runtime file');
});

test('guidance: missing pinned reference refuses resume before any model launch', async () => {
  const w = await world();
  expect((await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract'])).stdout).toContain('WAITING ON YOU (approval)');
  const pinPath = readdirSync(join(w.home, 'tasks')).map(d => join(w.home, 'tasks', d, 'runtime.json')).find(p => existsSync(p))!;
  const pin = JSON.parse(await readFile(pinPath, 'utf8'));
  const before = (await driverRows(w)).length;
  rmSync(join(pin.dir, 'references/plan.md'));
  const result = await ben(w, ['run', '--repo', w.repo]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Required ben guidance unavailable');
  expect((await driverRows(w)).length).toBe(before);
  expect(existsSync(join(S(w.repo), 'approval.json'))).toBe(false);
}, 240_000);

test('guidance: reference edits change new runtime pins and preserve existing task pins', async () => {
  const w = await world();
  await ben(w, ['assign', '--repo', w.repo, '--inline', 'subtract']);
  const pinPath = readdirSync(join(w.home, 'tasks')).map(d => join(w.home, 'tasks', d, 'runtime.json')).find(p => existsSync(p))!;
  const original = JSON.parse(await readFile(pinPath, 'utf8'));
  validateGuidance(original.dir);
  const install = join(await makeTmpDir('guidance-install-'), 'ben');
  (await import('node:fs')).cpSync(original.dir, install, { recursive: true });
  const ref = join(install, 'references/plan.md');
  await appendFile(ref, '\nReference revision fixture.\n');
  const newRunner = join(install, 'scripts/runner.mjs');
  await execArgv(['node', newRunner, 'status', '--repo', w.repo], { cwd: w.repo, env: w.env, timeoutMs: 30000 });
  expect(JSON.parse(await readFile(pinPath, 'utf8')).dir).toBe(original.dir);
  const repin = await execArgv(['node', newRunner, 'resume', '--repo', w.repo, '--repin'], { cwd: w.repo, env: w.env, timeoutMs: 30000 });
  expect(repin.stdout).toContain('runtime re-pinned');
  const updated = JSON.parse(await readFile(pinPath, 'utf8'));
  expect(updated.digest).not.toBe(original.digest);
  expect(await readFile(join(updated.dir, 'references/plan.md'), 'utf8')).toContain('Reference revision fixture.');
  expect(await readFile(join(original.dir, 'references/plan.md'), 'utf8')).not.toContain('Reference revision fixture.');
  expect(existsSync(join(S(w.repo), 'approval.json'))).toBe(false);
}, 240_000);

test('guidance: model-stop work receives verification guidance without operator procedures', async () => {
  const w = await world();
  await toApprovedIntent(w);
  await git(w.repo, 'commit', '--allow-empty', '-m', 'feat: fixture implementation');
  await writeFile(join(w.repo, 'dirty.txt'), 'fixture work');
  const r = await ben(w, ['run', '--repo', w.repo, '--once']);
  expect(r.exitCode).toBe(0);
  const tidy = (await driverRows(w)).find(x => /tidy|worktree is dirty/.test(x.instruction));
  expect(tidy).toBeDefined();
  expect(tidy.instruction).toContain(readGuidance(BEN_DIR, 'verification').text);
  expect(tidy.instruction).not.toContain('# Recovery reference');
  expect(tidy.instruction).not.toContain('record-grant --kind');
}, 240_000);

test('guidance: reconciliation stretches receive the selected reference', async () => {
  const w = await world({ handler: RECONCILING_HANDLER });
  await w.reviewer.respond({ verdict: 'NO_GO', blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'empty case missing', evidence: 'math.ts', falsifier: 'test zero' }] });
  await ben(w, ['assign', '--repo', w.repo, '--inline', '--plan-rounds', '1', '--plan-rounds-max', '1', 'subtract']);
  const gate = (await readTask(w.repo)).gate.id;
  await ben(w, ['resume', '--repo', w.repo, '--gate', gate, '--choose', 'continue', '--rounds', '1', '--inline']);
  const work = (await driverRows(w)).filter(x => x.instruction.includes('[ben work guidance: reconcile]'));
  expect(work.length).toBeGreaterThan(0);
  for (const row of work) {
    expect(row.instruction).toContain(readGuidance(BEN_DIR, 'reconcile').text);
    expect(row.instruction).not.toContain('record-veto --response');
    expect(row.instruction).not.toContain('# Runner reference');
  }
  expect(existsSync(join(S(w.repo), 'approval.json'))).toBe(false);
}, 240_000);

// Notification integration uses only a local stdin-to-file sink. No live delivery.
async function notificationSink(w: World, fail = false) {
  const path = join(w.home, 'notification-sink.mjs');
  const received = join(w.home, 'notifications-received.jsonl');
  await writeFile(path, `import {readFileSync,appendFileSync} from 'node:fs';
const event=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(received)},JSON.stringify(event)+'\\n');
process.exit(${fail ? 1 : 0});\n`);
  await writeFile(join(w.home, 'notifications.json'), JSON.stringify({enabled:true,argv:[process.execPath,path]}));
  return async () => existsSync(received) ? (await readFile(received,'utf8')).trim().split('\n').map(line=>JSON.parse(line)) : [];
}
function notificationOutbox(w: World) {
  const dirs=readdirSync(join(w.home,'notifications'));
  expect(dirs).toHaveLength(1);
  return join(w.home,'notifications',dirs[0]!, 'outbox.json');
}

test('notifications: approval and completion reach a fake sink once across repeated runs, status reads and service lifetimes', async () => {
  const w=await world();const received=await notificationSink(w);
  const assigned=await ben(w,['assign','--repo',w.repo,'--inline','Add subtract']);
  expect(assigned.exitCode).toBe(0);expect(assigned.stdout).toContain('WAITING ON YOU (approval)');
  expect((await received()).map(r=>r.kind)).toEqual(['park']);
  const beforeTask=await readFile(join(S(w.repo),'task.json'),'utf8');
  const beforeLedger=existsSync(join(S(w.repo),'ledger.jsonl'))?await readFile(join(S(w.repo),'ledger.jsonl'),'utf8'):null;
  const outbox=await readFile(notificationOutbox(w),'utf8');
  expect((await ben(w,['status','--repo',w.repo,'--json'])).exitCode).toBe(0);
  expect(await readFile(notificationOutbox(w),'utf8')).toBe(outbox);
  expect((await ben(w,['notify','--repo',w.repo])).exitCode).toBe(0);
  const services=await Promise.all([ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'}),ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'})]);
  expect(services.every(r=>r.exitCode===0)).toBe(true);
  expect(await readFile(join(S(w.repo),'task.json'),'utf8')).toBe(beforeTask);
  if(beforeLedger!==null)expect(await readFile(join(S(w.repo),'ledger.jsonl'),'utf8')).toBe(beforeLedger);
  expect(await received()).toHaveLength(1);
  const gate=(await readTask(w.repo)).gate.id;
  const done=await ben(w,['resume','--repo',w.repo,'--gate',gate,'--choose','approve','--inline']);
  expect(done.exitCode).toBe(0);expect(done.stdout).toContain('READY FOR REVIEW');
  expect((await received()).map(r=>r.kind)).toEqual(['park','complete']);
  const task=await readTask(w.repo);
  expect((await received())[1].reviewedSha).toBe(task.pr.headSha);
  expect((await received())[1].prUrl).toBe(task.pr.url);
  expect((await ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'})).exitCode).toBe(0);
  expect(await received()).toHaveLength(2);
  expect(JSON.parse(await readFile(w.store,'utf8')).prs).toHaveLength(1);
},240_000);

test('notifications: fake sink failure cannot alter a limit park; restart keeps the saved notification retry deadline', async () => {
  const w=await world({handler:DEFAULT_HANDLER.replace('cost: 0.11','cost: 1')});
  const received=await notificationSink(w,true);
  const assigned=await ben(w,['assign','--repo',w.repo,'--inline','--usd','0.5','Add subtract']);
  expect(assigned.exitCode).toBe(0);expect((await readTask(w.repo)).gate.kind).toBe('limit');
  expect((await received()).map(r=>r.kind)).toEqual(['limit']);
  const before=await readFile(join(S(w.repo),'task.json'),'utf8');
  const box=await readFile(notificationOutbox(w),'utf8');
  expect(JSON.parse(box).items[0]).toMatchObject({state:'pending',attempts:1});
  expect((await ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'})).exitCode).toBe(0);
  expect(await readFile(notificationOutbox(w),'utf8')).toBe(box);
  expect(await readFile(join(S(w.repo),'task.json'),'utf8')).toBe(before);
  expect(await received()).toHaveLength(1);
},240_000);

test('notifications: authentication stop emits a generic alert without provider output, and service does not restart the actor', async () => {
  const handler=DEFAULT_HANDLER.replace('export async function handle','async function baseHandle')+`
export async function handle(instruction,ctx){
 if(/Write the plan artifacts/.test(instruction))return {isError:true,text:'401 unauthorized PRIVATE_PROVIDER_OUTPUT'};
 return baseHandle(instruction,ctx);
}`;
  const w=await world({handler});const received=await notificationSink(w);
  const result=await ben(w,['assign','--repo',w.repo,'--inline','Add subtract']);
  expect(result.exitCode).toBe(1);expect(result.stdout).toContain('authentication needs renewal');
  expect((await received()).map(r=>r.kind)).toEqual(['stop']);
  expect(JSON.stringify(await received())).not.toContain('PRIVATE_PROVIDER_OUTPUT');
  const count=(await driverRows(w)).length;
  expect((await ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'})).exitCode).toBe(0);
  expect((await driverRows(w)).length).toBe(count);expect(await received()).toHaveLength(1);
},240_000);

test('notifications: first service observation catches an already parked task after opt-in, without launching a model', async () => {
  const w=await world();
  expect((await ben(w,['assign','--repo',w.repo,'--inline','Add subtract'])).stdout).toContain('WAITING ON YOU (approval)');
  expect(existsSync(join(w.home,'notifications'))).toBe(false);
  const received=await notificationSink(w);
  const drivers=(await driverRows(w)).length;
  expect((await ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'})).exitCode).toBe(0);
  expect((await received()).map(r=>r.kind)).toEqual(['park']);
  expect((await driverRows(w)).length).toBe(drivers);
},240_000);

test('notifications: recorded abandonment emits stop without publication or duplicate operator decisions', async () => {
  const w=await world();const received=await notificationSink(w);
  expect((await ben(w,['assign','--repo',w.repo,'--inline','Add subtract'])).exitCode).toBe(0);
  const gate=(await readTask(w.repo)).gate.id;
  await ben(w,['resume','--repo',w.repo,'--gate',gate,'--choose','abort','--note','fixture stop','--inline']);
  const events=await received();
  expect(events.map(r=>r.kind)).toEqual(['park','stop']);expect(events[1].reason).toBe('abandoned');
  const before=await readFile(join(S(w.repo),'task.json'),'utf8');
  expect((await ben(w,['notify','--repo',w.repo])).exitCode).toBe(0);
  expect(await received()).toHaveLength(2);
  expect(await readFile(join(S(w.repo),'task.json'),'utf8')).toBe(before);
  expect((await readTask(w.repo)).pr).toBeUndefined();
},240_000);

test('notifications: a damaged delivered-task pin cannot terminate service notification observation', async () => {
  const w=await world();await notificationSink(w);
  await toApprovedIntent(w);
  expect((await ben(w,['run','--repo',w.repo])).stdout).toContain('READY FOR REVIEW');
  const taskBefore=await readFile(join(S(w.repo),'task.json'),'utf8');
  const keys=readdirSync(join(w.home,'tasks'));
  expect(keys).toHaveLength(1);
  const pin=join(w.home,'tasks',keys[0]!, 'runtime.json');
  const saved=await readFile(pin,'utf8');
  await writeFile(pin,JSON.stringify({...JSON.parse(saved),dir:join(w.home,'missing-runtime')}));
  const before=await readFile(pin,'utf8');
  const result=await ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'});
  expect(result.exitCode).toBe(0);
  expect(await readFile(pin,'utf8')).toBe(before);
  expect(await readFile(join(S(w.repo),'task.json'),'utf8')).toBe(taskBefore);
  await rename(pin,pin+'.preserved');
  expect((await ben(w,['serve'],{BEN_RUNNER_SERVE_ONCE:'1'})).exitCode).toBe(0);
  expect(existsSync(pin)).toBe(false);
  expect(await readFile(pin+'.preserved','utf8')).toBe(before);
  expect(await readFile(join(S(w.repo),'task.json'),'utf8')).toBe(taskBefore);
},240_000);
