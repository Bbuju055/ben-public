import { expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execArgv } from '../src/lib/exec';
import { git, makeTmpDir } from './helpers';
import fixture from './fixtures/ci.json';

const runner = fileURLToPath(new URL('../scripts/runner.mjs', import.meta.url));
const run = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));

test('CI observer CLI only reads stubbed GETs; status stays offline and task/authority files remain unchanged', async () => {
  const repo = await makeTmpDir('ci-cli-repo-');
  const home = await makeTmpDir('ci-cli-home-');
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(repo, '.gitignore'), '.ben/\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'fixture');
  const head = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 30000 })).stdout.trim();
  const init = await execArgv(['node', run, 'init', '--title', 'offline CI fixture'], { cwd: repo, timeoutMs: 30000 });
  expect(init.exitCode).toBe(0);
  const taskPath = join(repo, '.ben', 'task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf8'));
  task.pr = { url: fixture.pr.html_url, headSha: head };
  writeFileSync(taskPath, JSON.stringify(task));
  const fake = JSON.parse(JSON.stringify(fixture).replaceAll(fixture.pr.head.sha, head));
  const responses = join(home, 'responses.json');
  writeFileSync(responses, JSON.stringify(fake));
  const log = join(home, 'requests.jsonl');
  const stub = join(home, 'gh.mjs');
  writeFileSync(stub, `import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]!=='api'||args[1]!=='--method'||args[2]!=='GET')process.exit(19);
const f=JSON.parse(readFileSync(${JSON.stringify(responses)},'utf8'));const path=args[3];
console.log(JSON.stringify(path.includes('/pulls/')?f.pr:path.includes('/check-runs?')?f.checks:f.statuses));`);
  const gh = join(home, 'gh');
  writeFileSync(gh, `#!/bin/sh\nexec node '${stub}' "$@"\n`); chmodSync(gh, 0o755);
  const forbidden = join(home, 'forbidden');
  writeFileSync(forbidden, `#!/bin/sh\nprintf forbidden >> '${join(home, 'forbidden.log')}'\nexit 20\n`); chmodSync(forbidden, 0o755);
  // Even enabling a notification sink must not cause the CI-only command to deliver.
  writeFileSync(join(home, 'notifications.json'), JSON.stringify({ enabled: true, argv: [forbidden] }));
  const env = { BEN_RUNNER_HOME: home, BEN_GH_CLI: gh, BEN_DRIVER_CLI: forbidden, BEN_CODEX_CLI: forbidden, BEN_RUNNER_NO_REEXEC: '1' };
  const invoke = async (args: string[]) => {
    const result = await execArgv(['node', runner, ...args, '--repo', repo], { cwd: repo, env, timeoutMs: 30000 });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout);
  };
  const before = readFileSync(taskPath, 'utf8');
  expect((await invoke(['ci-observe'])).state).toBe('disabled');
  expect(existsSync(log)).toBe(false);
  writeFileSync(join(home, 'ci-observer.json'), JSON.stringify({ enabled: true }));
  expect(await invoke(['ci-observe'])).toMatchObject({ state: 'observed', attempts: 1, observation: { state: 'passed', reviewedSha: head } });
  const calls = readFileSync(log, 'utf8');
  expect(calls.trim().split('\n')).toHaveLength(4);
  expect((await invoke(['ci-observe'])).state).toBe('complete');
  expect((await invoke(['status', '--json'])).ci.state).toBe('passed');
  expect(readFileSync(log, 'utf8')).toBe(calls);
  expect(readFileSync(taskPath, 'utf8')).toBe(before);
  expect(existsSync(join(home, 'forbidden.log'))).toBe(false);
  expect(existsSync(join(home, 'notifications'))).toBe(false);
  expect(existsSync(join(repo, '.ben', 'runner', 'stretches.jsonl'))).toBe(false);
  expect((await execArgv(['git', 'status', '--porcelain'], { cwd: repo, timeoutMs: 30000 })).stdout.trim()).toBe('');
  // A damaged schedule must not silently fall back to a prior passing manual snapshot.
  const manualPass = (await invoke(['status', '--json', '--refresh-ci'])).ci;
  fake.checks.check_runs[0].conclusion = 'failure';
  writeFileSync(responses, JSON.stringify(fake));
  expect((await invoke(['status', '--json', '--refresh-ci'])).ci.state).toBe('failed');
  const afterRefresh = readFileSync(log, 'utf8');
  expect((await invoke(['status', '--json'])).ci.state).toBe('failed');
  expect(readFileSync(log, 'utf8')).toBe(afterRefresh);
  const observerDir = join(home, 'ci-observer', readdirSync(join(home, 'ci-observer'))[0]!);
  // A wall-clock rollback can leave a valid old observation dated in the future.
  manualPass.observedAt = '2099-01-01T00:00:00.000Z';
  appendFileSync(join(repo, '.ben', 'runner', 'ci-observations.jsonl'), JSON.stringify(manualPass) + '\n');
  writeFileSync(join(observerDir, 'state.json'), '{broken');
  expect((await invoke(['status', '--json'])).ci.state).toBe('unknown');
  // Exercise the real command timeout with a sleeping local executable, never GitHub.
  const timeoutHome = await makeTmpDir('ci-cli-timeout-');
  writeFileSync(join(timeoutHome, 'ci-observer.json'), JSON.stringify({ enabled: true }));
  const sleeping = join(timeoutHome, 'sleeping-gh');
  const sleeper = join(timeoutHome, 'sleeping.mjs');
  const descendantPid = join(timeoutHome, 'descendant.pid');
  writeFileSync(sleeper, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn('/bin/sleep',['60'],{stdio:'inherit'});writeFileSync(${JSON.stringify(descendantPid)},String(child.pid));setInterval(()=>{},1000);`);
  writeFileSync(sleeping, `#!/bin/sh\nexec node '${sleeper}'\n`); chmodSync(sleeping, 0o755);
  const started = Date.now();
  const timed = await execArgv(['node', runner, 'ci-observe', '--repo', repo], {
    cwd: repo, timeoutMs: 25000, env: { ...env, BEN_RUNNER_HOME: timeoutHome, BEN_GH_CLI: sleeping },
  });
  expect(timed.exitCode).toBe(0);
  expect(JSON.parse(timed.stdout)).toMatchObject({ attempts: 1, observation: { state: 'unknown' } });
  expect(Date.now() - started).toBeLessThan(24000);
  const pid = readFileSync(descendantPid, 'utf8');
  // Reaping can lag behind SIGKILL; a zombie is already dead and cannot run.
  const childState = await execArgv(['ps', '-o', 'stat=', '-p', pid], { cwd: repo, timeoutMs: 5000 });
  expect(childState.exitCode !== 0 || childState.stdout.trim().startsWith('Z')).toBe(true);
  expect(readdirSync(join(timeoutHome, 'nowhere'))).toEqual([]);
  expect(readFileSync(taskPath, 'utf8')).toBe(before);
}, 60000);
