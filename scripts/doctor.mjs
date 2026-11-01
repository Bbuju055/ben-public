#!/usr/bin/env node
// Standalone prerequisite inspection: deliberately imports no ben runtime code.
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_FILES = [
  'SKILL.md', 'schemas/verdict.json',
  ...['run', 'runner', 'runner.lib', 'reviewer', 'verify', 'pregate', 'pr', 'ledger',
    'honesty', 'adjudication.lib', 'guidance', 'ci.lib', 'ci-observer', 'notifications',
    'install-hooks', 'stop-hook'].map(n => `scripts/${n}.mjs`),
  ...['start', 'plan', 'reconcile', 'decisions', 'verification', 'publication', 'runner', 'recovery'].map(n => `references/${n}.md`),
  ...['plan', 'implement', 'challenge-plan', 'challenge-diff', 'reconcile-plan', 'reconcile-diff'].map(n => `prompts/${n}.md`),
];
const LIMITATIONS = [
  'Project dependencies and acceptance-check adequacy are unverified.',
  'Model availability, billing, live CLI isolation and actual publication are untested.',
  'Live deliveries, installed services, OS recovery and newcomer end-to-end success are untested.',
  'Passing selected checks does not establish safe unattended operation; existing task runtime pins are not checked.',
];

// Closed stdin, explicit argv, bounded output/time and process-group cleanup.
// Never forward raw subprocess output/errors to the report.
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 4000 } = {}) {
  return new Promise(resolveResult => {
    const childEnv = { ...env, CI: '1', NO_COLOR: '1', TERM: 'dumb',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1',
      GCM_INTERACTIVE: 'Never', GH_PAGER: 'cat', PAGER: 'cat' };
    // A caller's Git context must not redirect --repo inspection elsewhere.
    for (const key of Object.keys(childEnv)) if (key.startsWith('GIT_') && !['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete childEnv[key];
    // Object reads must not turn an offline inspection into a promisor fetch.
    childEnv.GIT_NO_LAZY_FETCH = '1';
    let child;
    try { child = spawn(command, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
    catch { resolveResult({ code: null, out: '', err: '', problem: 'unavailable' }); return; }
    let out = '', err = '', bytes = 0, done = false;
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    // Detached children would otherwise survive Ctrl-C/termination of doctor,
    // losing the parent's deadline. SIGKILL of doctor itself cannot be handled.
    const interrupt = () => process.exit(130);
    const terminate = () => process.exit(143);
    process.once('exit', kill);
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const finish = (code, problem) => {
      if (done) return;
      done = true; clearTimeout(timer); kill();
      process.removeListener('exit', kill);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      child.stdout.destroy(); child.stderr.destroy();
      resolveResult({ code, out, err, ...(problem ? { problem } : {}) });
    };
    const timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
    for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', data => {
      bytes += data.length;
      if (bytes > 65536) { finish(null, 'output-limit'); return; }
      if (key === 'out') out += data.toString(); else err += data.toString();
    });
    child.on('error', error => finish(null, error.code === 'ENOENT' ? 'missing' : 'unavailable'));
    child.on('close', code => finish(code));
  });
}

export function parseArgs(args) {
  const options = { online: false, json: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--online', '--json', '--repo'].includes(arg) || seen.has(arg)) throw new Error('usage');
    seen.add(arg);
    if (arg === '--repo') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('usage');
      options.repo = resolve(args[++i]);
    } else options[arg.slice(2)] = true;
  }
  return options;
}

function json(result) { try { return JSON.parse(result.out); } catch { return null; } }
function guidancePresent(path) {
  let fd;
  try {
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) return false;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024 * 1024) return false;
    const buffer = Buffer.alloc(1024 * 1024);
    return !!buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').trim();
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}
function githubOrigin(value) {
  // Reject credential-bearing URLs, arbitrary hosts, ports and query strings.
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value.trim());
  return match && !['.', '..'].includes(match[2]) ? `${match[1]}/${match[2]}` : null;
}

export async function inspect(options = {}, context = {}) {
  const { root = ROOT, home = homedir(), platform = process.platform,
    nodeVersion = process.versions.node, sandbox = '/usr/bin/sandbox-exec', run = runCommand } = context;
  const checks = [];
  const add = (id, status, required, detail, remedy = '') => checks.push({ id, status, required, detail, remedy });
  const check = (id, ok, detail, remedy) => add(id, ok ? 'pass' : 'fail', true, detail, ok ? '' : remedy);
  const uncertain = (id, detail, remedy) => add(id, 'unknown', true, detail, remedy);
  const skipped = (id, detail, required = false) => add(id, 'skipped', required, detail, required ? 'Resolve the prerequisite and rerun.' : '');
  check('platform', platform === 'darwin', platform === 'darwin' ? 'macOS' : 'Unsupported platform.', 'Use macOS for live ben workflows.');
  let executable = false;
  try { accessSync(sandbox, constants.X_OK); executable = statSync(sandbox).isFile(); } catch {}
  check('sandbox', executable, 'sandbox-exec presence only; isolation untested.', 'Restore macOS sandbox-exec.');
  check('node', /^24\./.test(nodeVersion), /^\d+\.\d+\.\d+$/.test(nodeVersion) ? `Node ${nodeVersion}` : 'Unrecognized Node version.', 'Run with Node.js 24.');
  const available = {};
  for (const tool of ['git', 'claude', 'codex', 'gh']) {
    const result = await run(tool, ['--version']);
    const pattern = { git: /^git version (\d+\.\d+\.\d+)/, claude: /^(\d+\.\d+\.\d+) \(Claude Code\)/,
      codex: /^codex-cli (\d+\.\d+\.\d+)/, gh: /^gh version (\d+\.\d+\.\d+)/ }[tool];
    const version = pattern.exec(result.out.trim())?.[1];
    available[tool] = !result.problem && result.code === 0 && !!version;
    if (available[tool]) add(`tool.${tool}`, 'pass', true, `${tool} ${version}; compatibility not asserted.`);
    else add(`tool.${tool}`, result.problem === 'missing' ? 'fail' : 'unknown', true, 'Executable/version unavailable or unrecognized.', `Install ${tool} or inspect its version manually.`);
  }
  let linked = false;
  try { linked = lstatSync(join(home, '.claude/skills/ben')).isSymbolicLink() && realpathSync(join(home, '.claude/skills/ben')) === realpathSync(root); } catch {}
  check('skill.link', linked, linked ? 'Skill symlink selects this checkout.' : 'Skill link missing, stale, conflicting or unreadable.', 'Inspect ~/.claude/skills/ben and intentionally select this checkout.');
  let files = true;
  for (const name of RUNTIME_FILES) {
    try {
      const path = join(realpathSync(root), name);
      accessSync(path, constants.R_OK);
      if (!statSync(path).isFile() || statSync(path).size === 0 || (name.startsWith('references/') && !guidancePresent(path))) files = false;
    } catch { files = false; }
  }
  check('runtime.files', files, 'Required runtime files and regular nonblank guidance (at most 1 MiB each); integrity unverified.', 'Restore the complete ben checkout.');
  for (const tool of ['claude', 'codex']) {
    const id = `auth.${tool}`;
    if (!available[tool]) { skipped(id, 'CLI unavailable.', true); continue; }
    const r = await run(tool, tool === 'claude' ? ['auth', 'status'] : ['login', 'status']);
    let state = null;
    if (!r.problem) {
      if (tool === 'claude') {
        const loggedIn = json(r)?.loggedIn;
        if (loggedIn === true && r.code === 0) state = true;
        else if (loggedIn === false && [0, 1].includes(r.code)) state = false;
      } else {
        const output = `${r.out}\n${r.err}`.trim();
        if (r.code === 0 && /^Logged in using (ChatGPT|an API key)(?:\s|$)/.test(output)) state = true;
        else if ([0, 1].includes(r.code) && output === 'Not logged in') state = false;
      }
    }
    if (state === null) uncertain(id, 'Login status unreadable, unsupported or unrecognized.', `Inspect ${tool} login status manually; no logout is inferred.`);
    else check(id, state, state ? 'CLI reports authenticated; no inference attempted.' : 'CLI reports not logged in.', `Authenticate ${tool} interactively, then rerun.`);
  }
  let origin = null;
  const repoIds = ['repo.exists', 'repo.commit', 'repo.clean', 'repo.identity', 'repo.origin'];
  if (!options.repo) for (const id of repoIds) skipped(id, 'No --repo selected.');
  else {
    const cwd = resolve(options.repo);
    const git = args => run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd });
    let exists = false;
    try { exists = statSync(cwd).isDirectory(); } catch {}
    const top = exists && available.git ? await git(['rev-parse', '--show-toplevel']) : null;
    let valid = false;
    try { valid = top?.code === 0 && !top.problem && realpathSync(top.out.replace(/\n$/, '')) === realpathSync(cwd); } catch {}
    check('repo.exists', valid, valid ? 'Selected directory is a Git working-tree root.' : 'Repository missing, unreadable, or not a working-tree root.', 'Select a readable Git repository root.');
    if (!valid) for (const id of repoIds.slice(1)) skipped(id, 'Repository unavailable.', true);
    else {
      // Check before object reads, including on Git versions predating
      // GIT_NO_LAZY_FETCH. Treat partial-clone config conservatively even if false.
      const config = await git(['config', '--name-only', '--get-regexp', '^(filter\\..*\\.(clean|process)|extensions\\.partialclone|remote\\..*\\.promisor)$']);
      const configUnknown = config.problem || ![0, 1].includes(config.code);
      // Anything other than complete filter-key lines is a partial-clone key or
      // an ambiguous config name (subsections can contain newlines).
      const partial = config.out.split('\n').filter(Boolean).some(key => !/^filter\..*\.(clean|process)$/.test(key));
      if (configUnknown || partial) uncertain('repo.commit', 'Commit inspection withheld: partial clone or unreadable configuration.', 'Inspect a complete local clone; doctor never fetches missing objects.');
      else {
        const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
        if (head.problem) uncertain('repo.commit', 'Commit inspection unavailable.', 'Inspect Git HEAD.');
        else check('repo.commit', head.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(head.out), 'Initial commit inspection.', 'Create an initial commit before using ben.');
      }
      // Status may execute clean/process filters, including from submodule configs.
      // Do not inspect those working trees: configuration/index reads execute none.
      const index = await git(['ls-files', '--stage', '-v', '-z']);
      const entries = index.out.split('\0');
      const unsafeIndex = entries.pop() !== '' || entries.some(entry => !/^H (?:100644|100755|120000) (?:[a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t[^\0]+$/.test(entry));
      if (configUnknown || config.out.trim() || index.problem || index.code !== 0 || unsafeIndex) {
        uncertain('repo.clean', 'Cleanliness unverified: filters, partial clone, submodules, hidden index entries, or unreadable configuration/index.', 'Inspect a complete ordinary working tree without assume-unchanged/skip-worktree flags; doctor does not run target filters or submodule checks.');
      } else {
        const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']);
        if (status.problem || status.code !== 0) uncertain('repo.clean', 'Working-tree inspection unavailable.', 'Inspect Git status.');
        else check('repo.clean', status.out === '', status.out === '' ? 'Tracked and untracked state clean.' : 'Working tree contains changes.', 'Commit or preserve changes before starting ben.');
      }
      const name = await git(['config', '--get', 'user.name']);
      const email = await git(['config', '--get', 'user.email']);
      if (name.problem || email.problem || ![0, 1].includes(name.code) || ![0, 1].includes(email.code)) uncertain('repo.identity', 'Git identity unreadable.', 'Inspect Git user.name and user.email.');
      else check('repo.identity', name.code === 0 && email.code === 0 && !!name.out.trim() && !!email.out.trim(), 'Git identity presence; values withheld.', 'Configure Git user.name and user.email.');
      const remote = await git(['remote', 'get-url', 'origin']);
      if (remote.problem) uncertain('repo.origin', 'Origin inspection unavailable.', 'Inspect the origin remote.');
      else {
        origin = remote.code === 0 ? githubOrigin(remote.out) : null;
        check('repo.origin', !!origin, origin ? 'Recognized github.com origin; URL withheld.' : 'Missing or unsupported GitHub origin.', 'Set a credential-free github.com HTTPS or SSH origin.');
      }
    }
  }
  const onlineIds = ['github.auth', 'github.repository', 'github.base', 'github.permission'];
  if (!options.online) for (const id of onlineIds) skipped(id, 'Offline scope; use --online for read-only GitHub checks.');
  else {
    // Explicit host and GET bypass ambient GH_HOST and avoid GraphQL mutations.
    const api = path => run('gh', ['api', '--hostname', 'github.com', '--method', 'GET', path]);
    const user = available.gh ? await api('user') : null;
    if (user && !user.problem && user.code === 0 && typeof json(user)?.login === 'string' && json(user).login.length) add('github.auth', 'pass', true, 'GitHub API authentication succeeded.');
    else uncertain('github.auth', 'GitHub authentication could not be verified.', 'Inspect gh authentication and connectivity.');
    if (!options.repo) for (const id of onlineIds.slice(1)) skipped(id, 'No --repo selected.');
    else if (!origin || !available.gh) for (const id of onlineIds.slice(1)) skipped(id, 'GitHub origin or CLI unavailable.', true);
    else {
      const r = await api(`repos/${origin}`);
      const data = !r.problem && r.code === 0 ? json(r) : null;
      const valid = data && typeof data.full_name === 'string' && data.full_name.toLowerCase() === origin.toLowerCase() && typeof data.default_branch === 'string' && data.default_branch.length > 0;
      if (!valid) {
        uncertain('github.repository', 'Repository API response unavailable or malformed.', 'Check repository access and connectivity.');
        skipped('github.base', 'Repository response unavailable.', true);
        skipped('github.permission', 'Repository response unavailable.', true);
      } else {
        add('github.repository', 'pass', true, 'GitHub repository API reachable; Git transport untested.');
        const ref = `refs/heads/${data.default_branch}`;
        const base = await api(`repos/${origin}/git/ref/heads/${encodeURIComponent(data.default_branch)}`);
        const resolved = !base.problem && base.code === 0 ? json(base) : null;
        if (resolved?.ref === ref && resolved?.object?.type === 'commit' && /^[a-f0-9]{40}$/.test(resolved?.object?.sha ?? '')) add('github.base', 'pass', true, 'Remote default branch ref resolves to a commit.');
        else uncertain('github.base', 'Remote default branch could not be resolved.', 'Inspect the remote default branch.');
        if (typeof data.permissions?.push !== 'boolean') uncertain('github.permission', 'API write permission absent or malformed.', 'Inspect repository permissions.');
        else check('github.permission', data.permissions.push, 'API-reported push permission only; publication and branch rules untested.', 'Obtain repository write permission.');
      }
    }
  }
  return { schemaVersion: 1, scope: { repo: !!options.repo, online: !!options.online },
    checks, limitations: [...LIMITATIONS], exitCode: checks.some(c => c.required && c.status !== 'pass') ? 1 : 0 };
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); } catch {
    const usage = 'Usage: node scripts/doctor.mjs [--repo <path>] [--online] [--json]';
    console.log(args.includes('--json') ? JSON.stringify({ schemaVersion: 1, error: 'usage', detail: usage, exitCode: 2 }) : usage);
    return 2;
  }
  let report;
  try { report = await inspect(options); } catch {
    report = { schemaVersion: 1, error: 'inspection', detail: 'Inspection unavailable; no raw diagnostic output retained.', limitations: LIMITATIONS, exitCode: 1 };
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : [
    'ben doctor — bounded prerequisite inspection',
    ...(report.checks ?? []).map(c => `${c.status.toUpperCase()} ${c.id}: ${c.detail}${c.remedy ? ` Remedy: ${c.remedy}` : ''}`),
    ...(report.detail ? [report.detail] : []),
    ...report.limitations.map(s => `UNVERIFIED: ${s}`),
    `Exit ${report.exitCode}`,
  ].join('\n'));
  return report.exitCode;
}
let invoked = false;
try { invoked = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (invoked) process.exitCode = await main();
