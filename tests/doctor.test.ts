import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspect, parseArgs, RUNTIME_FILES, runCommand, type Command, type CommandResult, type Report } from '../scripts/doctor.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ok = (out: string): CommandResult => ({ code: 0, out, err: '' });
const state = (r: Report, id: string) => r.checks.find(c => c.id === id)!.status;
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'ben-doctor-')); roots.push(base);
  const root = join(base, 'runtime'), home = join(base, 'home'), repo = join(base, 'repo');
  mkdirSync(repo); mkdirSync(join(home, '.claude/skills'), { recursive: true });
  for (const name of RUNTIME_FILES) { const p = join(root, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'fixture\n'); }
  symlinkSync(root, join(home, '.claude/skills/ben'));
  const sandbox = join(base, 'sandbox-exec'); writeFileSync(sandbox, '#!/bin/sh\nexit 99\n'); chmodSync(sandbox, 0o755);
  const calls: string[][] = [];
  const responses = new Map<string, CommandResult>();
  const run: Command = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    if (responses.has(key)) return responses.get(key)!;
    if (args[0] === '--version') return ok(({ git: 'git version 2.50.1', claude: '2.1.312 (Claude Code)', codex: 'codex-cli 0.153.2', gh: 'gh version 2.92.0' } as Record<string, string>)[cmd]!);
    if (key === 'claude auth status') return ok('{"loggedIn":true,"token":"SECRET"}');
    if (key === 'codex login status') return { code: 0, out: '', err: 'Logged in using ChatGPT' };
    if (cmd === 'git') {
      expect(args.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
      const sub = args.slice(2).join(' ');
      const values: Record<string, string> = { 'rev-parse --show-toplevel': repo, 'rev-parse --verify HEAD^{commit}': 'a'.repeat(40),
        'status --porcelain=v1 --untracked-files=all --ignore-submodules=all': '', 'config --get user.name': 'SECRET', 'config --get user.email': 'SECRET',
        'remote get-url origin': 'https://github.com/owner/repo.git', 'config --name-only --get-regexp ^(filter\\..*\\.(clean|process)|extensions\\.partialclone|remote\\..*\\.promisor)$': '', 'ls-files --stage -v -z': '' };
      if (sub in values) return ok(values[sub]!);
    }
    if (cmd === 'gh') {
      expect(args.slice(0, 5)).toEqual(['api', '--hostname', 'github.com', '--method', 'GET']);
      if (args[5] === 'user') return ok('{"login":"SECRET"}');
      if (args[5] === 'repos/owner/repo') return ok('{"full_name":"owner/repo","default_branch":"main","permissions":{"push":true}}');
      if (args[5] === 'repos/owner/repo/git/ref/heads/main') return ok(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } }));
    }
    throw new Error(`Unexpected fixture command: ${key}`);
  };
  return { base, root, home, repo, sandbox, calls, responses, context: { root, home, sandbox, run, platform: 'darwin', nodeVersion: '24.10.0' } };
}
function snapshot(path: string): unknown {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return { link: readlinkSync(path) };
  if (st.isDirectory()) return Object.fromEntries(readdirSync(path).sort().map(n => [n, snapshot(join(path, n))]));
  return readFileSync(path).toString('base64');
}

function realGitFixture() {
  const f = fixture();
  const env = { ...process.env, HOME: f.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: f.repo, env, encoding: 'utf8' });
    expect(r.status).toBe(0); return r.stdout.trim();
  };
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(f.repo, 'tracked'), 'original'); git('add', 'tracked'); git('commit', '-m', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  const run: Command = (cmd, args, options) => cmd === 'git' ? runCommand(cmd, args, { ...options, env }) : f.context.run(cmd, args, options);
  return { ...f, git, env, context: { ...f.context, run } };
}

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`doctor: hidden tracked changes cannot pass (${flag})`, async () => {
  const f = realGitFixture(); f.git('update-index', flag, 'tracked');
  writeFileSync(join(f.repo, 'tracked'), 'hidden change');
  expect(f.git('status', '--porcelain')).toBe(''); // Reproduce Git's blind spot.
  const before = snapshot(f.repo);
  const r = await inspect({ repo: f.repo }, f.context);
  expect(state(r, 'repo.clean')).toBe('unknown'); expect(r.exitCode).toBe(1);
  expect(snapshot(f.repo)).toEqual(before);
});

test('doctor: partial-clone inspection must not launch a lazy fetch', async () => {
  const f = realGitFixture();
  const oid = f.git('rev-parse', 'HEAD');
  const marker = join(f.base, 'fetch-ran');
  const helper = join(f.base, 'fetch-helper');
  writeFileSync(helper, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`); chmodSync(helper, 0o755);
  f.git('remote', 'set-url', 'origin', `ext::${helper}`);
  f.git('config', 'protocol.ext.allow', 'always');
  f.git('config', 'remote.origin.promisor', 'true');
  rmSync(join(f.repo, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  const r = await inspect({ repo: f.repo }, f.context);
  expect(existsSync(marker)).toBe(false);
  expect(state(r, 'repo.commit')).toBe('unknown');
  expect(state(r, 'repo.clean')).toBe('unknown');
});

for (const mode of ['symlink', 'whitespace', 'symlink-directory']) test(`doctor: guidance rejected by runner cannot pass (${mode})`, async () => {
  const f = fixture(); const p = join(f.root, 'references/start.md');
  if (mode === 'whitespace') writeFileSync(p, '  \n\t');
  else if (mode === 'symlink') { rmSync(p); symlinkSync(join(f.root, 'SKILL.md'), p); }
  else {
    const moved = join(f.base, 'references'); mkdirSync(moved);
    for (const name of readdirSync(dirname(p))) writeFileSync(join(moved, name), 'fixture');
    rmSync(dirname(p), { recursive: true }); symlinkSync(moved, dirname(p));
  }
  expect(state(await inspect({}, f.context), 'runtime.files')).toBe('fail');
});

test('doctor: honors an explicitly selected global Git config without leaking identity', async () => {
  const f = realGitFixture(); f.git('config', '--remove-section', 'user');
  const config = join(f.base, 'operator.gitconfig');
  writeFileSync(config, '[user]\nname = SECRET\nemail = SECRET@example.invalid\n');
  const run: Command = (cmd, args, options) => cmd === 'git' ? runCommand(cmd, args, { ...options, env: { ...f.env, GIT_CONFIG_GLOBAL: config } }) : f.context.run(cmd, args, options);
  const r = await inspect({ repo: f.repo }, { ...f.context, run });
  expect(state(r, 'repo.identity')).toBe('pass'); expect(r.exitCode).toBe(0);
  expect(JSON.stringify(r)).not.toContain('SECRET');
});

test('doctor: repository roots may end in whitespace', async () => {
  const f = realGitFixture(); const path = `${f.repo} `; renameSync(f.repo, path);
  expect((await inspect({ repo: path }, f.context)).exitCode).toBe(0);
});

test('doctor: stable offline scope, no network or inference and no writes', async () => {
  const f = fixture(); const before = snapshot(f.base);
  const r = await inspect({}, f.context);
  expect(r.exitCode).toBe(0);
  expect(r.schemaVersion).toBe(1);
  expect(r.scope).toEqual({ repo: false, online: false });
  expect(r.checks.map(c => c.id)).toEqual(['platform', 'sandbox', 'node', 'tool.git', 'tool.claude', 'tool.codex', 'tool.gh', 'skill.link', 'runtime.files', 'auth.claude', 'auth.codex', 'repo.exists', 'repo.commit', 'repo.clean', 'repo.identity', 'repo.origin', 'github.auth', 'github.repository', 'github.base', 'github.permission']);
  expect(f.calls).toEqual([['git', '--version'], ['claude', '--version'], ['codex', '--version'], ['gh', '--version'], ['claude', 'auth', 'status'], ['codex', 'login', 'status']]);
  expect(JSON.stringify(r)).not.toContain('SECRET');
  expect(r.limitations.join(' ')).toContain('unattended');
  expect(snapshot(f.base)).toEqual(before);
});

test('doctor: selected repository and online scope only issue bounded GET inspections', async () => {
  const f = fixture(); const before = snapshot(f.base);
  const r = await inspect({ repo: f.repo, online: true }, f.context);
  expect(r.exitCode).toBe(0);
  expect(r.checks.every(c => c.status === 'pass')).toBe(true);
  expect(f.calls.filter(c => c[0] === 'gh' && c[1] === 'api').map(c => c.at(-1))).toEqual(['user', 'repos/owner/repo', 'repos/owner/repo/git/ref/heads/main']);
  expect(JSON.stringify(r)).not.toContain('SECRET');
  expect(snapshot(f.base)).toEqual(before);
});

test('doctor: branch refs with slashes are encoded and matched exactly', async () => {
  const f = fixture();
  f.responses.set('gh api --hostname github.com --method GET repos/owner/repo', ok(JSON.stringify({ full_name: 'owner/repo', default_branch: 'release/next', permissions: { push: true } })));
  const path = 'repos/owner/repo/git/ref/heads/release%2Fnext';
  f.responses.set(`gh api --hostname github.com --method GET ${path}`, ok(JSON.stringify({ ref: 'refs/heads/release/next', object: { type: 'commit', sha: 'a'.repeat(40) } })));
  expect((await inspect({ repo: f.repo, online: true }, f.context)).exitCode).toBe(0);
  expect(f.calls.at(-1)?.at(-1)).toBe(path);
});

for (const [field, value, id] of [['platform', 'linux', 'platform'], ['nodeVersion', '22.1.0', 'node'], ['sandbox', '/nonexistent-sandbox', 'sandbox']] as const) {
  test(`doctor: wrong ${field} fails`, async () => {
    const f = fixture(); const r = await inspect({}, { ...f.context, [field]: value });
    expect(state(r, id)).toBe('fail'); expect(r.exitCode).toBe(1);
  });
}
for (const tool of ['git', 'claude', 'codex', 'gh']) test(`doctor: missing ${tool}`, async () => {
  const f = fixture(); f.responses.set(`${tool} --version`, { code: null, out: '', err: 'SECRET', problem: 'missing' });
  const r = await inspect({}, f.context); expect(state(r, `tool.${tool}`)).toBe('fail'); expect(r.exitCode).toBe(1);
  if (['claude', 'codex'].includes(tool)) expect(state(r, `auth.${tool}`)).toBe('skipped');
});
for (const mode of ['missing', 'stale', 'conflicting', 'other-checkout']) test(`doctor: ${mode} skill link`, async () => {
  const f = fixture(); const link = join(f.home, '.claude/skills/ben'); rmSync(link);
  if (mode === 'stale') symlinkSync(join(f.base, 'absent'), link);
  if (mode === 'conflicting') mkdirSync(link);
  if (mode === 'other-checkout') symlinkSync(f.repo, link);
  expect(state(await inspect({}, f.context), 'skill.link')).toBe('fail');
});
test('doctor: incomplete runtime', async () => {
  const f = fixture(); rmSync(join(f.root, 'scripts/run.mjs'));
  expect(state(await inspect({}, f.context), 'runtime.files')).toBe('fail');
});
for (const tool of ['claude', 'codex']) for (const mode of ['logout', 'malformed', 'timeout', 'unreadable']) test(`doctor: ${tool} auth ${mode}`, async () => {
  const f = fixture(); const key = tool === 'claude' ? 'claude auth status' : 'codex login status';
  f.responses.set(key, mode === 'logout' ? { code: 1, out: tool === 'claude' ? '{"loggedIn":false}' : 'Not logged in', err: '' } :
    { code: mode === 'unreadable' ? 1 : 0, out: 'SECRET malformed', err: '', ...(mode === 'timeout' ? { problem: 'timeout' } : {}) });
  const r = await inspect({}, f.context); expect(state(r, `auth.${tool}`)).toBe(mode === 'logout' ? 'fail' : 'unknown'); expect(r.exitCode).toBe(1);
  expect(JSON.stringify(r)).not.toContain('SECRET');
});
for (const [args, result, id, expected] of [
  ['rev-parse --verify HEAD^{commit}', { code: 128, out: '', err: '' }, 'repo.commit', 'fail'],
  ['status --porcelain=v1 --untracked-files=all --ignore-submodules=all', ok('?? SECRET\n'), 'repo.clean', 'fail'],
  ['config --get user.email', { code: 1, out: '', err: '' }, 'repo.identity', 'fail'],
  ['remote get-url origin', { code: 2, out: '', err: '' }, 'repo.origin', 'fail'],
  ['remote get-url origin', ok('https://SECRET@github.com/owner/repo.git'), 'repo.origin', 'fail'],
  ['status --porcelain=v1 --untracked-files=all --ignore-submodules=all', { code: null, out: '', err: 'SECRET', problem: 'timeout' }, 'repo.clean', 'unknown'],
] as const) test(`doctor: repo ${id} ${expected} ${args}`, async () => {
  const f = fixture(); f.responses.set(`git -c core.fsmonitor=false ${args}`, result);
  const r = await inspect({ repo: f.repo }, f.context); expect(state(r, id)).toBe(expected); expect(r.exitCode).toBe(1); expect(JSON.stringify(r)).not.toContain('SECRET');
});
test('doctor: missing repo and online auth-only selection', async () => {
  const f = fixture(); expect(state(await inspect({ repo: join(f.base, 'missing') }, f.context), 'repo.exists')).toBe('fail');
  const r = await inspect({ online: true }, f.context); expect(r.exitCode).toBe(0); expect(state(r, 'github.repository')).toBe('skipped');
});
for (const [args, output] of [
  ['config --name-only --get-regexp ^(filter\\..*\\.(clean|process)|extensions\\.partialclone|remote\\..*\\.promisor)$', 'filter.example.clean'],
  ['ls-files --stage -v -z', `H 160000 ${'a'.repeat(40)} 0\tsubmodule\0`],
]) test(`doctor: refuses potentially executable status inspection: ${args}`, async () => {
  const f = fixture(); f.responses.set(`git -c core.fsmonitor=false ${args}`, ok(output!));
  const r = await inspect({ repo: f.repo }, f.context);
  expect(state(r, 'repo.clean')).toBe('unknown'); expect(r.exitCode).toBe(1);
  expect(f.calls.some(c => c.includes('status') && c[0] === 'git')).toBe(false);
});
for (const [path, response, id, expected] of [
  ['user', ok('{bad'), 'github.auth', 'unknown'],
  ['repos/owner/repo', ok('{}'), 'github.repository', 'unknown'],
  ['repos/owner/repo', ok('{"full_name":"other/repo","default_branch":"main"}'), 'github.repository', 'unknown'],
  ['repos/owner/repo', ok('{"full_name":"owner/repo","default_branch":"main","permissions":{"push":false}}'), 'github.permission', 'fail'],
  ['repos/owner/repo', ok('{"full_name":"owner/repo","default_branch":"main"}'), 'github.permission', 'unknown'],
  ['repos/owner/repo/git/ref/heads/main', ok('{"sha":"bad"}'), 'github.base', 'unknown'],
  ['repos/owner/repo/git/ref/heads/main', ok(JSON.stringify({ ref: 'refs/tags/main', object: { type: 'commit', sha: 'a'.repeat(40) } })), 'github.base', 'unknown'],
  ['repos/owner/repo/git/ref/heads/main', ok(JSON.stringify({ ref: 'refs/heads/main', object: { type: 'tag', sha: 'a'.repeat(40) } })), 'github.base', 'unknown'],
  ['user', { code: null, out: 'SECRET', err: '', problem: 'timeout' }, 'github.auth', 'unknown'],
] as const) test(`doctor: online stub ${id} ${expected}`, async () => {
  const f = fixture(); f.responses.set(`gh api --hostname github.com --method GET ${path}`, response);
  const r = await inspect({ repo: f.repo, online: true }, f.context); expect(state(r, id)).toBe(expected); expect(r.exitCode).toBe(1); expect(JSON.stringify(r)).not.toContain('SECRET');
});

test('doctor: subprocess timeout, output cap, missing executable and prompt suppression', async () => {
  const f = fixture();
  const listeners = ['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
  const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim();
  const start = performance.now();
  expect((await runCommand(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 })).problem).toBe('timeout');
  expect(performance.now() - start).toBeLessThan(2000);
  expect((await runCommand(node, ['-e', "process.stdout.write('x'.repeat(100000))"])).problem).toBe('output-limit');
  expect((await runCommand(join(f.base, 'absent'), [])).problem).toBe('missing');
  const env = await runCommand(node, ['-e', 'console.log(JSON.stringify(process.env))'], { env: { PATH: process.env.PATH, GIT_DIR: 'wrong', GH_HOST: 'example.org', GIT_NO_LAZY_FETCH: '0' } });
  const parsed = JSON.parse(env.out);
  expect(parsed.GIT_DIR).toBeUndefined(); expect(parsed.GIT_TERMINAL_PROMPT).toBe('0'); expect(parsed.GIT_OPTIONAL_LOCKS).toBe('0'); expect(parsed.GH_PROMPT_DISABLED).toBe('1');
  expect(parsed.GIT_NO_LAZY_FETCH).toBe('1');
  expect(['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(listeners);
});

test('doctor: timeout kills a descendant holding inherited pipes', async () => {
  const f = fixture(); const marker = join(f.base, 'heartbeat');
  const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim();
  const worker = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)}, '.'), 20)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio:'inherit'});`;
  const r = await runCommand(node, ['-e', parent], { timeoutMs: 800 });
  expect(r.problem).toBe('timeout');
  const before = readFileSync(marker, 'utf8'); expect(before).toContain('started');
  await Bun.sleep(150); expect(readFileSync(marker, 'utf8')).toBe(before);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) test(`doctor: ${signal} cleans up its active subprocess group`, async () => {
  const f = fixture(); const marker = join(f.base, 'heartbeat'), pidFile = join(f.base, 'worker.pid');
  // Signal Node itself, not a version-manager launcher that may not forward it.
  const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim();
  const worker = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)}, '.'), 20)`;
  const parent = `import { runCommand } from ${JSON.stringify(new URL('../scripts/doctor.mjs', import.meta.url).href)}; await runCommand(process.execPath, ['-e', ${JSON.stringify(worker)}]);`;
  const proc = Bun.spawn([node, '--input-type=module', '-e', parent], { stdout: 'ignore', stderr: 'ignore' });
  try {
    for (let i = 0; i < 150 && !existsSync(marker); i++) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    proc.kill(signal); expect(await proc.exited).toBe(code);
    await Bun.sleep(100); const before = readFileSync(marker, 'utf8');
    await Bun.sleep(150); expect(readFileSync(marker, 'utf8')).toBe(before);
  } finally {
    proc.kill();
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
  }
});

test('doctor: actual fake CLIs and temporary Git fixture preserve repo and home', async () => {
  const f = fixture(); const bin = join(f.base, 'bin'); mkdirSync(bin);
  const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim();
  const env = { ...process.env, HOME: f.home, XDG_CONFIG_HOME: join(f.home, '.config'), PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: f.repo, env, encoding: 'utf8' }); expect(r.status).toBe(0); };
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  // Any command outside the status/version allowlist fails. No real providers run.
  for (const [tool, version, status] of [['claude', '2.1.312 (Claude Code)', '{"loggedIn":true}'], ['codex', 'codex-cli 0.153.2', 'Logged in using ChatGPT'], ['gh', 'gh version 2.92.0', '']] as const) {
    const script = `#!${node}\nconst a=process.argv.slice(2).join(' '); if(a==='--version')console.log(${JSON.stringify(version)});else if(a===${JSON.stringify(tool === 'claude' ? 'auth status' : 'login status')} && ${JSON.stringify(tool)}!=='gh') console.log(${JSON.stringify(status)});else {console.error('SECRET forbidden action');process.exit(99);}`;
    writeFileSync(join(bin, tool), script); chmodSync(join(bin, tool), 0o755);
  }
  const run: Command = (cmd, args, options) => runCommand(cmd, args, { ...options, env });
  const empty = await inspect({ repo: f.repo }, { ...f.context, run });
  expect(state(empty, 'repo.commit')).toBe('fail'); expect(state(empty, 'repo.origin')).toBe('fail');
  writeFileSync(join(f.repo, 'tracked'), 'original'); git('add', 'tracked'); git('commit', '-m', 'fixture');
  git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
  const before = { repo: snapshot(f.repo), home: snapshot(f.home) };
  const r = await inspect({ repo: f.repo }, { ...f.context, run }); expect(r.exitCode).toBe(0);
  expect({ repo: snapshot(f.repo), home: snapshot(f.home) }).toEqual(before);
  // Exercise the optional online argv through a real executable, still entirely
  // offline: the fake gh has no networking code and rejects any other operation.
  const apiResponses = {
    'user': { login: 'SECRET' },
    'repos/owner/repo': { full_name: 'owner/repo', default_branch: 'main', permissions: { push: true } },
    'repos/owner/repo/git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: 'a'.repeat(40) } },
  };
  writeFileSync(join(bin, 'gh'), `#!${node}\nconst a=process.argv.slice(2), r=${JSON.stringify(apiResponses)}; if(a.join(' ')==='--version')console.log('gh version 2.92.0');else if(a.length===6&&a.slice(0,5).join(' ')==='api --hostname github.com --method GET'&&Object.hasOwn(r,a[5]))console.log(JSON.stringify(r[a[5]]));else process.exit(99);`);
  const online = await inspect({ repo: f.repo, online: true }, { ...f.context, run });
  expect(online.exitCode).toBe(0); expect(JSON.stringify(online)).not.toContain('SECRET');
  expect({ repo: snapshot(f.repo), home: snapshot(f.home) }).toEqual(before);
  writeFileSync(join(f.repo, 'tracked'), 'modified'); expect(state(await inspect({ repo: f.repo }, { ...f.context, run }), 'repo.clean')).toBe('fail');
  const sentinel = join(f.base, 'filter-ran');
  git('config', 'filter.example.clean', `touch '${sentinel}'`);
  writeFileSync(join(f.repo, '.gitattributes'), 'tracked filter=example\n');
  expect(state(await inspect({ repo: f.repo }, { ...f.context, run }), 'repo.clean')).toBe('unknown');
  expect(existsSync(sentinel)).toBe(false);
  git('config', '--remove-section', 'filter.example'); rmSync(join(f.repo, '.gitattributes'));
  writeFileSync(join(f.repo, 'tracked'), 'original');
  writeFileSync(join(f.repo, 'untracked'), 'fixture'); expect(state(await inspect({ repo: f.repo }, { ...f.context, run }), 'repo.clean')).toBe('fail');
  const cli = spawnSync(node, [resolve('scripts/doctor.mjs'), '--json', '--repo', f.repo], { env, encoding: 'utf8' });
  expect(cli.status).toBe(1); expect(JSON.parse(cli.stdout).exitCode).toBe(1); expect(cli.stdout).not.toContain('SECRET');
  const text = spawnSync(node, [resolve('scripts/doctor.mjs')], { env, encoding: 'utf8' });
  expect(text.stdout).toContain('UNVERIFIED:'); expect(text.stdout).toContain('skill.link');
});

test('doctor: usage errors have distinct JSON exit code and run no probes', () => {
  for (const args of [['--wat'], ['--repo'], ['--online', '--online'], ['--repo', '--json']]) expect(() => parseArgs(args)).toThrow();
  const r = spawnSync('node', ['scripts/doctor.mjs', '--wat', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  expect(r.status).toBe(2); expect(JSON.parse(r.stdout)).toMatchObject({ schemaVersion: 1, error: 'usage', exitCode: 2 });
  const f = fixture(); const link = join(f.base, 'doctor.mjs'); symlinkSync(resolve('scripts/doctor.mjs'), link);
  const linked = spawnSync('node', [link, '--wat', '--json'], { encoding: 'utf8' });
  expect(linked.status).toBe(2); expect(JSON.parse(linked.stdout).error).toBe('usage');
});
