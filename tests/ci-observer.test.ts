import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_POLL, observeCi, scheduledCi } from '../scripts/ci-observer.mjs';
import { ciForStatus, ciTarget } from '../scripts/ci.lib.mjs';
import fixture from './fixtures/ci.json';

function world() {
  const home = mkdtempSync(join(tmpdir(), 'ben-ci-observer-'));
  const repo = '/disposable/repo';
  const dir = join(home, 'ci-observer', createHash('sha256').update(repo).digest('hex'));
  writeFileSync(join(home, 'ci-observer.json'), JSON.stringify({ enabled: true }));
  const task = { pr: { url: fixture.pr.html_url, headSha: fixture.pr.head.sha } };
  const current = { task, localHead: task.pr.headSha };
  const data = structuredClone(fixture);
  let time = 1000, calls = 0;
  const get = (path: string, opts: { timeoutMs: number }) => {
    calls++;
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(CI_POLL.collectionMs);
    if (path.endsWith('/pulls/7')) return data.pr;
    if (path.includes('/check-runs?')) return data.checks;
    if (path.includes('/status?')) return data.statuses;
    throw new Error('unexpected request');
  };
  const options = { home, repo, snapshot: () => current, get, now: () => time, monotonic: () => time };
  const path = join(dir, 'state.json');
  return { home, repo, dir, path, current, data, options, get,
    run: () => observeCi(options), calls: () => calls, setTime: (t: number) => { time = t; },
    read: () => JSON.parse(readFileSync(path, 'utf8')), cached: () => scheduledCi(home, repo, ciTarget(task)) };
}

test('CI scheduler defaults off: no snapshot, request or durable state', () => {
  const home = mkdtempSync(join(tmpdir(), 'ben-ci-off-'));
  expect(observeCi({ home, repo: '/fixture', snapshot: () => { throw Error('snapshot'); }, get: () => { throw Error('get'); } }).state).toBe('disabled');
  expect(existsSync(join(home, 'ci-observer'))).toBe(false);
});

for (const [conclusion, state] of [['success', 'passed'], ['failure', 'failed'], ['cancelled', 'cancelled']]) {
  test(`CI scheduler pending -> ${state}; terminal observations stop requests`, () => {
    const w = world();
    w.data.checks.check_runs[0]!.status = 'in_progress';
    expect(w.run().observation?.state).toBe('pending');
    const reserved = w.read().items[0];
    expect(reserved).toMatchObject({ attempts: 1, nextAt: 61000, expiresAt: 1801000 });
    expect(w.run().state).toBe('waiting');
    expect(w.calls()).toBe(4);
    w.data.checks.check_runs[0]!.status = 'completed';
    w.data.checks.check_runs[0]!.conclusion = conclusion!;
    w.setTime(61000);
    expect(w.run().observation?.state).toBe(state);
    w.setTime(99999999);
    expect(w.run().state).toBe('complete');
    expect(w.calls()).toBe(8);
    expect(w.read().items[0].observations.map((o: any) => o.state)).toEqual(['pending', state]);
  });
}

test('CI scheduler reserves before requests; unavailable calls consume attempts, never leak errors, and exhaust at the cap', () => {
  const w = world();
  const run = () => observeCi({ ...w.options, get: () => {
    const row = w.read().items[0];
    expect(row.nextAt).toBeGreaterThan(w.options.now());
    expect(row.observations.at(-1).state).toBe('unknown');
    throw Error('SECRET provider stderr');
  } });
  for (let n = 0; n < CI_POLL.attempts; n++) {
    w.setTime(1000 + n * CI_POLL.intervalMs);
    expect(run()).toMatchObject({ state: 'observed', attempts: n + 1, observation: { state: 'unknown' } });
  }
  expect(run().state).toBe('exhausted');
  expect(readFileSync(w.path, 'utf8')).not.toContain('SECRET');
});

test('CI scheduler preserves deadlines across invocations and stops at the elapsed window', () => {
  const w = world();
  observeCi({ ...w.options, get: () => { throw Error('offline'); } });
  w.setTime(61000 - 1);
  expect(w.run()).toMatchObject({ state: 'waiting', attempts: 1, nextAt: 61000 });
  expect(w.calls()).toBe(0);
  w.setTime(1000 + CI_POLL.windowMs);
  expect(w.run()).toMatchObject({ state: 'exhausted', attempts: 1 });
  expect(w.calls()).toBe(0);
});

test('CI collection shares one total deadline across requests, including slow responses', () => {
  const w = world();
  const budgets: number[] = [];
  let n = 0;
  const result = observeCi({ ...w.options, get: (path, opts) => {
    budgets.push(opts.timeoutMs);
    const response = w.get(path, opts);
    w.setTime(1000 + ++n * 6000);
    return response;
  } });
  expect(budgets).toEqual([15000, 9000, 3000]);
  expect(result.observation).toMatchObject({ state: 'unknown', reason: 'CI collection deadline reached.' });
});

test('CI changed remote head, local head and task identity cannot produce green evidence', () => {
  const remote = world();
  remote.data.pr.head.sha = 'b'.repeat(40);
  expect(remote.run().observation?.state).toBe('unknown');
  const local = world();
  local.current.localHead = 'b'.repeat(40);
  expect(local.run().state).toBe('stale');
  expect(local.calls()).toBe(0);
  for (const change of ['local', 'task', 'unavailable']) {
    const w = world(); let snapshots = 0;
    const result = observeCi({ ...w.options, snapshot: () => {
      if (++snapshots === 1) return w.current;
      if (change === 'unavailable') return undefined;
      return change === 'local' ? { ...w.current, localHead: 'b'.repeat(40) } : { ...w.current, task: { pr: { ...w.current.task.pr, url: 'https://github.com/o/r/pull/8' } } };
    } });
    expect(result.observation?.state).toBe('unknown');
  }
});

test('CI new reviewed head gets its own bounded history; returning to an earlier head cannot reset its attempts', () => {
  const w = world();
  const run = () => observeCi({ ...w.options, get: () => { throw Error('offline'); } });
  run();
  w.current.task.pr.headSha = w.current.localHead = 'b'.repeat(40);
  expect(run().attempts).toBe(1);
  w.current.task.pr.headSha = w.current.localHead = fixture.pr.head.sha;
  expect(run()).toMatchObject({ state: 'waiting', attempts: 1 });
  expect(w.read().items).toHaveLength(2);
});

test('CI malformed durable state and ambiguous/live locks fail closed and preserve bytes', () => {
  for (const lock of ['', 'unknown', String(process.pid)]) {
    const w = world(); mkdirSync(w.dir, { recursive: true });
    writeFileSync(join(w.dir, 'lock'), lock);
    expect(w.run().state).toBe('busy'); expect(w.calls()).toBe(0);
    expect(readFileSync(join(w.dir, 'lock'), 'utf8')).toBe(lock);
  }
  const w = world(); w.run();
  writeFileSync(w.path, '{broken');
  expect(w.run().state).toBe('error');
  expect(w.cached()?.state).toBe('unknown');
  expect(readFileSync(w.path, 'utf8')).toBe('{broken');
  expect(w.calls()).toBe(4);
});

test('CI concurrent observer cannot issue requests while the first owns the lock; cached reads perform no writes', () => {
  const w = world();
  let nested = false;
  observeCi({ ...w.options, get: (path, opts) => {
    if (!nested) { nested = true; expect(w.run().state).toBe('busy'); }
    return w.get(path, opts);
  } });
  const before = readFileSync(w.path, 'utf8');
  expect(w.cached()?.state).toBe('passed');
  expect(readFileSync(w.path, 'utf8')).toBe(before);
  expect(ciForStatus(w.cached(), ciTarget(w.current.task), 'b'.repeat(40)).state).toBe('unknown');
  expect(w.calls()).toBe(4);
});

test('CI crashed reservation survives process restart; stale-lock reclamation does not reset attempt or deadline', async () => {
  const w = world();
  const script = join(w.home, 'crash.mjs');
  writeFileSync(script, `import {observeCi} from ${JSON.stringify(new URL('../scripts/ci-observer.mjs', import.meta.url).href)};
observeCi({home:${JSON.stringify(w.home)},repo:${JSON.stringify(w.repo)},snapshot:()=>(${JSON.stringify(w.current)}),now:()=>1000,get:()=>process.exit(17)});`);
  const processResult = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
  expect(await processResult.exited).toBe(17);
  expect(w.read().items[0]).toMatchObject({ attempts: 1, nextAt: 61000 });
  expect(w.cached()?.state).toBe('unknown');
  expect(w.run().state).toBe('waiting');
  expect(w.calls()).toBe(0);
  w.setTime(61000);
  expect(w.run()).toMatchObject({ attempts: 2, observation: { state: 'passed' } });
});

test('CI unavailable snapshots preserve pending deadlines without requests; invalid config is inert', () => {
  const w = world();
  w.data.checks.check_runs[0]!.status = 'in_progress';
  w.run();
  const before = readFileSync(w.path, 'utf8');
  w.setTime(61000);
  expect(observeCi({ ...w.options, snapshot: () => undefined }).state).toBe('unavailable');
  expect(readFileSync(w.path, 'utf8')).toBe(before);
  expect(w.calls()).toBe(4);
  writeFileSync(join(w.home, 'ci-observer.json'), '{broken');
  expect(w.run().state).toBe('error');
  expect(readFileSync(w.path, 'utf8')).toBe(before);
  expect(w.calls()).toBe(4);
});

test('CI structurally corrupt attempt histories never reset budgets or expose passing evidence', () => {
  for (const damage of [
    (row: any) => { row.attempts = 0; },
    (row: any) => { row.expiresAt++; },
    (row: any) => { row.observations = []; },
    (row: any) => { row.observations[0].checks = []; },
  ]) {
    const w = world(); w.run();
    const state = w.read(); damage(state.items[0]);
    const before = JSON.stringify(state); writeFileSync(w.path, before);
    expect(w.run().state).toBe('error');
    expect(w.cached()?.state).toBe('unknown');
    expect(readFileSync(w.path, 'utf8')).toBe(before);
    expect(w.calls()).toBe(4);
  }
});

test('CI two replacement processes reclaim a dead owner without duplicate collection', async () => {
  const w = world();
  const script = join(w.home, 'dispatch.mjs');
  const calls = join(w.home, 'calls');
  writeFileSync(script, `import {observeCi} from ${JSON.stringify(new URL('../scripts/ci-observer.mjs', import.meta.url).href)};
import {appendFileSync} from 'node:fs';
const f=${JSON.stringify(fixture)};
const crash=process.argv[2]==='crash';
observeCi({home:${JSON.stringify(w.home)},repo:${JSON.stringify(w.repo)},snapshot:()=>(${JSON.stringify(w.current)}),now:()=>crash?1000:61000,get:path=>{
if(crash)process.exit(17);
appendFileSync(${JSON.stringify(calls)},path+'\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
return path.includes('/pulls/')?f.pr:path.includes('/check-runs?')?f.checks:f.statuses;
}});`);
  const launch = (mode: string) => Bun.spawn([process.execPath, script, mode], { stdout: 'pipe', stderr: 'pipe' });
  expect(await launch('crash').exited).toBe(17);
  const workers = [launch('recover'), launch('recover')];
  expect(await Promise.all(workers.map(w => w.exited))).toEqual([0, 0]);
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(4);
  expect(w.read().items[0].attempts).toBe(2);
  expect(w.cached()?.state).toBe('passed');
});


test('CI total collection timeout survives a wall-clock rollback', () => {
  const w = world();
  let elapsed = 0;
  const budgets: number[] = [];
  const result = observeCi({ ...w.options, monotonic: () => elapsed, get: (path, opts) => {
    budgets.push(opts.timeoutMs);
    const response = w.get(path, opts);
    elapsed += 6000;
    w.setTime(w.options.now() - 60000);
    return response;
  } });
  expect(result.observation?.state).toBe('unknown');
  expect(budgets).toEqual([15000, 9000, 3000]);
});
