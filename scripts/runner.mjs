#!/usr/bin/env node
// runner — ben's assignment supervisor.
//
// The runner owns publication; model CLIs also contact providers. It can spawn
// a bounded, sandboxed driver stretch; run publication with arguments composed
// from task.json; record supervisor facts through run.mjs record commands
// (observation acts, `--by ben-runner`); compute the operator's status; and
// stop. It NEVER sequences (run.mjs does), never judges a referee's output,
// never records a human decision (the human answers through `run.mjs answer`,
// which the runner merely invokes with the operator's own words and actor).
//
// Usage ("ben" = a shell alias for this script):
//   runner.mjs assign   --repo <path> "<outcome>" [--base main] [--usd 25] [--hours 8] [--stretches 40]
//                       [--allow-domains a,b] [--research-domains a,b] [--allow-network gates] [--by <operator>]
//                       [--plan-rounds N] [--diff-rounds N] [--plan-rounds-max N] [--diff-rounds-max N] [--e2e-paths a,b]
//   runner.mjs resume   --repo <path> [--gate <id>] [--choose <token>] [--reply <text>|--reply-file <f>] [--note <t>]
//                       [--usd N|--hours N|--stretches N] [--criterion <id>] [--residual <t>] [--inline]
//   runner.mjs status   --repo <path> [--detail] [--json]
//   runner.mjs readiness --repo <path>                 (read-only local readiness)
//   assign/resume/follow-up accept --keep-awake or --allow-sleep (explicit idle-sleep policy)
//   runner.mjs follow-up --repo <path> --pr N "<note>" [--reopen|--abandon]
//   runner.mjs repair   --repo <path>
//   runner.mjs service  install|uninstall|status
//   runner.mjs run      --repo <path> [--inline]        (the loop; normally started detached by assign/resume)
//   runner.mjs serve                                     (the service loop over the registry)
//   runner.mjs gate-wrap <profile-template> -- <argv…>   (internal: verify.mjs's per-command wrapper)
//
// Seams (tests only; unset in production): BEN_RUNNER_HOME, BEN_DRIVER_CLI, BEN_GH_CLI,
// BEN_CODEX_CLI, BEN_RUNNER_PAUSE_AT (kill seam, one strict equality per boundary),
// BEN_RUNNER_BACKOFF_MS, BEN_RUNNER_NO_PROBE, BEN_RUNNER_SKIP_PREFLIGHT_MODEL,
// BEN_RUNNER_STRETCH_MAX_TURNS (drill: forced no-progress), BEN_REVIEWER_CLI_REAL.
//
// Exit codes: 0 done/parked/working · 1 NEEDS YOU or usage error · 2 contention.

import { validateGuidance, withWorkGuidance } from './guidance.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  accountTotals,
  failureKind,
  researchFiles,
  BEN_DIR,
  classifyStatus,
  configurationProblems,
  DEFAULT_LIMITS,
  DEFAULT_STRETCH,
  DRIVER_TOOLS,
  driverArgv,
  effectiveLimits,
  gateWrapperArgv,
  HEADLESS_DRIVER_PROTOCOL,
  isBlank,
  isObj,
  judgeProbe,
  ownerRepoFromUrl,
  parseJsonl,
  planDependenciesSection,
  progressIdentity,
  sleepGapMs,
  PUBLICATION_TIMEOUT_MS,
  reachedLimit,
  realOrResolved,
  renderDriverSettings,
  renderGateProfile,
  scrubbedDriverEnv,
  scrubForOperator,
  sha256,
} from './runner.lib.mjs';
import { assignmentIssues, prTitleFor } from './adjudication.lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const RUNNER_HOME = realOrResolved(process.env.BEN_RUNNER_HOME ?? join(homedir(), '.ben-runner'));
const DRIVER_CLI = process.env.BEN_DRIVER_CLI ?? 'claude';
const GH_CLI = process.env.BEN_GH_CLI ?? 'gh';
const CODEX_CLI = process.env.BEN_CODEX_CLI ?? 'codex';
const SERVICE_LABEL = 'com.ben.runner';
const POLICY_ACTORS = ['ben-runner', 'ben-policy:empty-veto'];

// ---------------------------------------------------------------------------
// tiny helpers

function fail(msg, code = 1) {
  console.error(`ben: ${msg}`);
  process.exit(code);
}

function pauseAt(boundary, dir) {
  if (process.env.BEN_RUNNER_PAUSE_AT !== boundary) return;
  writeFileSync(join(dir, `.runner-paused-${boundary.replaceAll(':', '_')}`), String(process.pid));
  const gate = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 600; i++) Atomics.wait(gate, 0, 0, 100);
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Append one JSON line and fsync it — the durable launch reservation. */
function appendDurable(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sh(argv, { cwd = process.cwd(), env = process.env, timeoutMs = 120_000, input = undefined } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, input });
  return { code: r.error ? (r.error.code === 'ETIMEDOUT' ? 124 : 126) : (r.status ?? 1), out: (r.stdout ?? '').trim(), err: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`.trim(), error: r.error };
}

function git(repo, args, opts = {}) {
  return sh(['git', '-C', repo, ...args], { timeoutMs: 120_000, ...opts });
}

function gh(args, opts = {}) {
  return sh([GH_CLI, ...args], { cwd: nowhereDir(), timeoutMs: 120_000, ...opts });
}

function nowhereDir() {
  const d = join(RUNNER_HOME, 'nowhere');
  mkdirSync(d, { recursive: true });
  return d;
}

function ghEmptyDir() {
  const d = join(RUNNER_HOME, 'gh-empty');
  mkdirSync(d, { recursive: true });
  return d;
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// the pinned read-only runtime: every trusted process runs from
// a copy of ben's scripts the runner made, never from the target checkout

let RUNTIME;
/** Copy (or reuse) the runtime for the CURRENT install — used only by operator acts that pin (assign, follow-up, service install, resume --repin). */
function installRuntimeDir() {
  if (RUNTIME) { validateGuidance(RUNTIME); return RUNTIME; }
  validateGuidance(BEN_DIR);
  const parts = ['scripts', 'prompts', 'schemas', 'references', 'SKILL.md'];
  const files = [];
  const walk = (rel) => {
    const abs = join(BEN_DIR, rel);
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const n of readdirSync(abs).sort()) if (!n.startsWith('.')) walk(join(rel, n));
    } else files.push(rel);
  };
  for (const p of parts) walk(p);
  const digest = sha256(files.map((f) => `${f}:${sha256(readFileSync(join(BEN_DIR, f)))}`).join('\n')).slice(0, 16);
  const dir = join(RUNNER_HOME, 'runtime', digest);
  if (!existsSync(join(dir, '.complete'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(BEN_DIR, f), join(dir, f));
    }
    // node_modules are not needed: the referees are zero-dependency
    writeFileSync(join(dir, '.complete'), `${nowIso()}\nsource ${BEN_DIR}\n`);
  }
  validateGuidance(dir);
  RUNTIME = dir;
  return dir;
}

// trust must survive restarts. Every task carries an immutable
// runtime pin (~/.ben-runner/tasks/<key>/runtime.json, driver-unwritable);
// every trusted invocation for that task — run.mjs, gate-wrap, the detached
// loop, the service's per-repo runner — executes the PINNED copy, never the
// install (which, when ben builds ben, is the checkout the driver edits).
// Only operator acts re-pin: assign, follow-up, service install, resume --repin.
let PINNED;
function pinPath(repo) {
  const task = safeReadTask(repo).task;
  return join(RUNNER_HOME, 'tasks', taskKey(repo, task), 'runtime.json');
}
function writePin(repo, dir, by) {
  const p = pinPath(repo);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteJson(p, { dir, digest: basename(dir), pinnedAt: nowIso(), by, install: BEN_DIR });
  PINNED = dir;
  return dir;
}
/** Absence permits legacy first-sight pinning; a broken existing binding never does. */
function readRuntimePin(repo) {
  const path = pinPath(repo);
  let regular = false;
  try { regular = lstatSync(path).isFile(); } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    fail(`cannot inspect existing runtime pin: ${path}: ${err.message}`);
  }
  let pin;
  try { pin = readJson(path); } catch { /* malformed existing pins are refused below */ }
  if (!regular || !pin || typeof pin.dir !== 'string' || !pin.dir.trim() ||
      typeof pin.digest !== 'string' || !pin.digest.trim() || !existsSync(join(pin.dir, '.complete'))) {
    fail(`existing runtime pin is invalid or unavailable: ${path}. Preserve it and restore the pinned runtime, or explicitly use resume --repin --repo ${repo}. Nothing was re-pinned.`);
  }
  return pin;
}
/** The task's pinned runtime dir; a task without a pin (pre-pin state) is pinned from the install as a recorded act. */
function runtimeDir(repo = undefined) {
  if (PINNED) return PINNED;
  if (repo && existsSync(join(S(repo), 'task.json'))) {
    const pin = readRuntimePin(repo);
    if (pin) {
      PINNED = pin.dir;
      return PINNED;
    }
    rlog(repo, 'no runtime pin for this task — pinning the current install (recorded)');
    return writePin(repo, installRuntimeDir(), 'first-sight');
  }
  return installRuntimeDir();
}
const RUN_MJS = (repo) => join(runtimeDir(repo), 'scripts', 'run.mjs');
const RUNNER_MJS = (repo) => join(runtimeDir(repo), 'scripts', 'runner.mjs');

/** Task-bound commands typed from the install re-exec from the task's pinned runtime (unless already there). */
function reexecFromPin(repo) {
  if (process.env.BEN_RUNNER_NO_REEXEC === '1') return;
  if (!existsSync(join(S(repo), 'task.json'))) return;
  const pin = readRuntimePin(repo);
  if (!pin) return;
  const selfDir = realOrResolved(dirname(dirname(SELF)));
  if (selfDir === realOrResolved(pin.dir)) return; // already pinned code
  const r = spawnSync(process.execPath, [join(pin.dir, 'scripts', 'runner.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, BEN_RUNNER_NO_REEXEC: '1' } });
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// per-repo runner state

const S = (repo) => join(repo, '.ben');
const RDIR = (repo) => join(S(repo), 'runner');
const STRETCHES = (repo) => join(RDIR(repo), 'stretches.jsonl');
const STATE = (repo) => join(RDIR(repo), 'state.json');
const RLOCK = (repo) => join(S(repo), 'runner.lock');

function rlog(repo, msg) {
  try {
    mkdirSync(RDIR(repo), { recursive: true });
    appendFileSync(join(RDIR(repo), 'runner.log'), `${nowIso()} ${msg}\n`);
  } catch {
    /* non-authoritative */
  }
}

function readState(repo) {
  try {
    return readJson(STATE(repo)) ?? {};
  } catch {
    return {};
  }
}

function writeState(repo, patch) {
  const st = { ...readState(repo), ...patch, updatedAt: nowIso() };
  atomicWriteJson(STATE(repo), st);
  return st;
}

function rows(repo) {
  return existsSync(STRETCHES(repo)) ? parseJsonl(readFileSync(STRETCHES(repo), 'utf8')) : [];
}

function readTask(repo) {
  return readJson(join(S(repo), 'task.json'));
}

/** task.json read that never throws: {task} | {broken:true, raw} | {task: undefined}. */
function safeReadTask(repo) {
  const p = join(S(repo), 'task.json');
  if (!existsSync(p)) return { task: undefined };
  const raw = readFileSync(p, 'utf8');
  try {
    return { task: JSON.parse(raw), raw };
  } catch {
    return { broken: true, raw };
  }
}

/** unreadable task.json: save a copy, park NEEDS YOU with the `repair` answer. */
function parkBrokenTask(repo, raw) {
  mkdirSync(RDIR(repo), { recursive: true });
  const copy = join(RDIR(repo), `task.json.broken-${Date.now()}`);
  writeFileSync(copy, raw);
  const base = /"base":\s*"([0-9a-f]{40})"/.exec(raw)?.[1] ?? null;
  writeState(repo, { needsYou: { kind: 'task-json-unreadable', copy, base, summary: 'ben cannot read its own task record (task.json is corrupt).', detail: `A copy is saved at ${copy}. Choices: runner.mjs resume --repo ${repo} --choose repair   (re-creates the record from the saved copy's baseline${base ? ` ${base.slice(0, 12)}` : ''}, a recorded act) · or abandon.`, at: nowIso() } });
  rlog(repo, `task.json unreadable — copy saved at ${copy}`);
  console.log(`ben: NEEDS YOU · ben cannot read its own task record (task.json is corrupt).\nA copy is saved at ${copy}. Choices: runner.mjs resume --repo ${repo} --choose repair · or abandon.`);
}

/** operator identity: assignment.operator > --by > config.json > git user.name */
function operatorFor(repo, task) {
  if (task?.assignment?.operator) return task.assignment.operator;
  if (!isBlank(values.by)) return values.by.trim();
  const cfg = readJson(join(RUNNER_HOME, 'config.json'));
  if (cfg?.operator) return cfg.operator;
  const n = git(repo, ['config', 'user.name']).out;
  return isBlank(n) ? undefined : n;
}

function taskKey(repo, task) {
  return `${basename(repo)}-${String(task?.assignmentId ?? 'na').slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// configuration check — refuse repo-shipped configuration

function configurationCheck(repo, expectedRemoteUrl) {
  const claudeDir = join(repo, '.claude');
  // configuration = settings*.json, hooks/, commands/, agents/, skills/, …; the
  // harness's own bookkeeping dotfiles (e.g. `.cc-writes`, written by the claude
  // process into any project it runs in) configure nothing and are not flagged
  const claudeEntries = existsSync(claudeDir) ? readdirSync(claudeDir).filter((e) => !e.startsWith('.')) : [];
  const hooksDir = join(repo, '.git', 'hooks');
  const hookEntries = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((h) => {
        if (h.endsWith('.sample')) return false; // inert git samples are not active hooks
        try {
          return (statSync(join(hooksDir, h)).mode & 0o111) !== 0;
        } catch {
          return false;
        }
      })
    : [];
  const cfg = sh(['git', 'config', '--file', join(repo, '.git', 'config'), '--list']);
  const managed = '/Library/Application Support/ClaudeCode/managed-settings.json';
  return configurationProblems({
    repo,
    expectedRemoteUrl,
    gitConfigList: cfg.code === 0 ? cfg.out : '',
    managedSettingsText: existsSync(managed) ? readFileSync(managed, 'utf8') : undefined,
    hookEntries,
    claudeEntries,
    hasMcpJson: existsSync(join(repo, '.mcp.json')),
  });
}

function needsYou(repo, summary, detail = '') {
  writeState(repo, { needsYou: { summary, detail, at: nowIso() } });
  rlog(repo, `NEEDS YOU: ${summary}`);
  console.log(`ben: NEEDS YOU · ${summary}${detail ? `\n${detail}` : ''}`);
}

function clearNeedsYou(repo) {
  const st = readState(repo);
  if (st.needsYou) {
    delete st.needsYou;
    atomicWriteJson(STATE(repo), st);
  }
}

// ---------------------------------------------------------------------------
// task-local runner files: driver settings per mode, gate profile template

function taskFilesDir(repo, task) {
  const d = join(RUNNER_HOME, 'tasks', taskKey(repo, task));
  mkdirSync(join(d, 'profiles'), { recursive: true });
  return d;
}

function writeDriverSettings(repo, task, mode) {
  const dir = taskFilesDir(repo, task);
  const a = task.assignment ?? {};
  const settings = renderDriverSettings({
    repo,
    runtimeDir: runtimeDir(repo),
    runnerHome: RUNNER_HOME,
    mode,
    allowedDomains: mode === 'research' ? (a.researchDomains ?? []) : (a.allowDomains ?? []),
  });
  // research: a POSITIVE write boundary — the stretch's working
  // directory is .ben/research/ (the sandbox's default writable tree) and the
  // file-writing tools are absent; the repo stays readable (probed live)
  if (mode === 'research') mkdirSync(join(S(repo), 'research'), { recursive: true });
  const p = join(dir, `driver-settings-${mode}.json`);
  atomicWriteJson(p, settings);
  return p;
}

function writeGateProfileTemplate(repo, task) {
  const dir = taskFilesDir(repo, task);
  const p = join(dir, 'gate-profile.template.sb');
  // the template allows ONLY the placeholder scratch dir; gate-wrap renders it per command
  const profile = renderGateProfile({ repo, runnerHome: RUNNER_HOME, benDir: BEN_DIR, runtimeDir: runtimeDir(repo), allowNetwork: task.assignment?.allowNetworkGates === true, extraProtected: [] }).replace(
    `(allow file-write* (subpath "${join(realOrResolved(repo), '.ben', 'evidence', 'scratch')}"))`,
    '(allow file-write* (subpath "__SCRATCH__"))',
  );
  if (!profile.includes('__SCRATCH__')) throw new Error('gate profile template lost its scratch placeholder');
  writeFileSync(p, profile);
  return p;
}

function commandWrapperFor(repo, task) {
  const template = writeGateProfileTemplate(repo, task);
  return JSON.stringify([process.execPath, RUNNER_MJS(repo), 'gate-wrap', template, '--']);
}

/** internal: verify.mjs spawns `<wrapper…> /bin/sh -c <command>` — render the per-command profile and exec under sandbox-exec. */
function cmdGateWrap() {
  const template = positionals[1];
  const sep = process.argv.indexOf('--');
  const rest = sep >= 0 ? process.argv.slice(sep + 1) : [];
  if (isBlank(template) || rest.length === 0) fail('gate-wrap <profile-template> -- <argv…>', 3);
  const scratch = process.env.BEN_SCRATCH_DIR;
  if (isBlank(scratch)) fail('gate-wrap: BEN_SCRATCH_DIR is not set — verify.mjs sets it per command', 3);
  const rendered = readFileSync(template, 'utf8').replaceAll('__SCRATCH__', realOrResolved(scratch).replaceAll('\\', '\\\\').replaceAll('"', '\\"'));
  const out = join(dirname(template), 'profiles', `${sha256(rendered).slice(0, 16)}.sb`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rendered);
  const r = spawnSync(gateWrapperArgv(out)[0], [...gateWrapperArgv(out).slice(1), ...rest], { stdio: 'inherit', env: process.env });
  if (r.error) fail(`gate-wrap: ${r.error.message}`, 126);
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// model launches — every launch is reserved BEFORE spawning

function reserveLaunch(repo, row) {
  const target = repo && existsSync(S(repo)) ? STRETCHES(repo) : join(RUNNER_HOME, 'launches.jsonl');
  appendDurable(target, row);
  return target;
}

/** Copy pre-task launch rows (preflight/probe) into the task's log once .ben exists. */
function adoptPreTaskLaunches(repo, assignRunId) {
  const p = join(RUNNER_HOME, 'launches.jsonl');
  if (!existsSync(p)) return;
  for (const r of parseJsonl(readFileSync(p, 'utf8'))) if (r.assignRunId === assignRunId && r.type !== 'torn') appendDurable(STRETCHES(repo), r);
}

/**
 * One driver stretch. Returns {ok, costUsd, turns,
 * sessionId, isError, text, outputs, transcript, violations, exitCode, timedOut}.
 */
async function driverStretch(repo, task, { instruction, mode = 'work', kind = 'stretch', cwd = repo, sessionId, resume, maxTurns = DEFAULT_STRETCH.maxTurns, maxBudgetUsd = DEFAULT_STRETCH.maxBudgetUsd, timeoutMs = DEFAULT_STRETCH.timeoutMs, settingsPath, assignRunId }) {
  const id = randomUUID();
  const settings = settingsPath ?? writeDriverSettings(repo, task, mode);
  const tools = mode === 'research' ? 'Read,Grep,Glob,Bash' : DRIVER_TOOLS;
  if (mode === 'research') cwd = join(S(repo), 'research');
  const argv = driverArgv({ settingsPath: settings, sessionId, resume, maxTurns, maxBudgetUsd, systemPrompt: HEADLESS_DRIVER_PROTOCOL, instruction, tools });
  const launched = { type: 'launched', id, kind, mode, capUsd: maxBudgetUsd, maxTurns, timeoutMs, sessionId, instructionSha: sha256(instruction), at: nowIso(), ...(assignRunId ? { assignRunId } : {}) };
  const logPath = reserveLaunch(repo, launched);
  appendDurable(logPath, { type: 'started', id, kind: 'stretch', timeoutMs, at: nowIso(), ...(assignRunId ? { assignRunId } : {}) });
  const startedAt = Date.now();
  if (repo && existsSync(S(repo))) writeState(repo, { step: `${kind} (${mode})`, lastActivityAt: nowIso(), currentStretch: id });
  const env = scrubbedDriverEnv(process.env, { ghEmptyDir: ghEmptyDir() });
  const child = spawn(DRIVER_CLI, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // the driver's process group is owned durably — a replacement
  // runner terminates a surviving group before it starts anything
  if (repo && existsSync(S(repo))) writeState(repo, { currentStretchPid: child.pid ?? null });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    if (repo && existsSync(S(repo))) writeState(repo, { lastActivityAt: nowIso() });
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 10_000).unref();
  }, timeoutMs);
  const exitCode = await new Promise((res) => {
    child.on('exit', (code) => res(code ?? 1));
    child.on('error', () => res(126));
  });
  clearTimeout(timer);
  const transcript = parseJsonl(stdout).filter((l) => l.type !== 'torn');
  // Background-task completions can emit another result in the same CLI process.
  // Costs are cumulative: use the final result, never sum or reuse a partial one.
  const result = transcript.findLast((l) => l.type === 'result');
  const outputs = transcript
    .flatMap((l) => (l.type === 'user' && Array.isArray(l.message?.content) ? l.message.content : []))
    .filter((c) => c?.type === 'tool_result')
    .map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)))
    .join('\n');
  const violations = (outputs.match(/<sandbox_violations>/g) ?? []).length;
  const ms = Date.now() - startedAt;
  const costUsd = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : undefined;
  appendDurable(logPath, {
    type: 'completed',
    id,
    at: nowIso(),
    exitCode,
    timedOut,
    ...(costUsd !== undefined ? { costUsd } : { unreported: true }),
    turns: result?.num_turns ?? null,
    sessionId: result?.session_id ?? sessionId,
    isError: result?.is_error === true,
    violations,
    ms,
    ...(assignRunId ? { assignRunId } : {}),
  });
  appendDurable(logPath, { type: 'ended', id, ms, at: nowIso(), ...(assignRunId ? { assignRunId } : {}) });
  if (repo && existsSync(S(repo))) {
    writeState(repo, { lastActivityAt: nowIso(), currentStretch: null, currentStretchPid: null });
    // the stretch's own report + tool evidence, kept for diagnosis (non-authoritative)
    try {
      mkdirSync(join(RDIR(repo), 'stretches'), { recursive: true });
      writeFileSync(
        join(RDIR(repo), 'stretches', `${id}.txt`),
        `# stretch ${id} (${kind}, ${mode})\nexit ${exitCode}${timedOut ? ' TIMEOUT' : ''} · cost ${costUsd ?? 'unreported'} · turns ${result?.num_turns ?? '?'} · violations ${violations}\n\n## instruction\n${instruction}\n\n## driver report\n${result?.result ?? '(none)'}\n\n## tool results (tail)\n${outputs.slice(-6000)}\n\n## stderr (tail)\n${stderr.slice(-2000)}\n`,
      );
    } catch {
      /* diagnostics only */
    }
  }
  return { id, limitReached: /^error_max_(turns|budget_usd)$/.test(result?.subtype ?? '') || /(?:max(?:imum)?[ -]turns|max(?:imum)? budget).*?(?:reached|exceeded)/i.test(result?.result ?? ''), ok: exitCode === 0 && result !== undefined && result.is_error !== true, costUsd, turns: result?.num_turns, sessionId: result?.session_id ?? sessionId, isError: result?.is_error === true, text: result?.result ?? '', outputs, transcript, violations, exitCode, timedOut, stderr };
}

/** Terminate a surviving driver process group left by a previous runner (SIGTERM, then SIGKILL). */
async function reapOrphanDriver(repo) {
  const st = readState(repo);
  const pid = Number(st.currentStretchPid);
  if (!Number.isInteger(pid) || pid < 1) return;
  if (pidAlive(pid)) {
    rlog(repo, `orphaned driver process group ${pid} from a previous runner — terminating before continuing`);
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* not a group leader or gone */
    }
    for (let i = 0; i < 10 && pidAlive(pid); i++) await sleep(500);
    if (pidAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  }
  writeState(repo, { currentStretchPid: null, currentStretch: null });
}

/** A timed trusted child (next / publication): started/ended rows for active time. */
async function timedChild(repo, kind, timeoutMs, fn) {
  const id = randomUUID();
  appendDurable(STRETCHES(repo), { type: 'started', id, kind, timeoutMs, at: nowIso() });
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    appendDurable(STRETCHES(repo), { type: 'ended', id, ms: Date.now() - t0, at: nowIso() });
  }
}

// ---------------------------------------------------------------------------
// sequencer invocations (from the pinned runtime)

function runMjs(repo, args, { env = {}, timeoutMs = 30 * 60 * 1000 } = {}) {
  const r = sh([process.execPath, RUN_MJS(repo), ...args, '--repo', repo], { cwd: repo, env: { ...process.env, ...env }, timeoutMs });
  return { code: r.code, out: `${r.out}${r.err ? `\n${r.err}` : ''}`.trim(), stdout: r.out, stderr: r.err };
}

function statusJson(repo) {
  const r = runMjs(repo, ['status', '--json'], { timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

/** The reviewer shim: counts every reviewer CLI call at a process boundary, then execs the real CLI. */
function reviewerShim(repo) {
  const p = join(taskFilesDir(repo, readTask(repo)), 'reviewer-shim.mjs');
  const script = `#!/usr/bin/env node
import { appendFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const log = ${JSON.stringify(STRETCHES(repo))};
const fd = openSync(log, 'a'); writeSync(fd, JSON.stringify({ type: 'reviewer-launch', at: new Date().toISOString(), argv: process.argv.slice(2, 4) }) + '\\n'); fsyncSync(fd); closeSync(fd);
const r = spawnSync(${JSON.stringify(process.env.BEN_REVIEWER_CLI_REAL ?? CODEX_CLI)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;
  writeFileSync(p, script);
  const wrapper = join(taskFilesDir(repo, readTask(repo)), 'reviewer-shim');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(p)} "$@"\n`);
  try {
    spawnSync('chmod', ['+x', wrapper]);
  } catch {
    /* best effort */
  }
  return wrapper;
}

// ---------------------------------------------------------------------------
// actor audit

// actors are validated PER ACT KIND — human decisions belong to
// the operator, observation acts to ben-runner, and the D3 policy identity is
// legal only on a veto row it validly produced; a missing actor is a violation
const OBSERVATION_KINDS = new Set(['pr-inspection', 'pr-observation', 'supervisor-stop', 'limit-event']);
function actorAudit(repo, task, status) {
  const operator = operatorFor(repo, task);
  const bad = [];
  for (const a of status?.actors ?? []) {
    const by = a.by === null || a.by === undefined ? '' : String(a.by).trim();
    const kind = String(a.kind);
    let ok;
    if (OBSERVATION_KINDS.has(kind)) ok = by === 'ben-runner';
    else if (kind === 'veto') ok = (operator !== undefined && by === operator) || (by === 'ben-policy:empty-veto' && a.policy === true);
    else ok = operator !== undefined && by === operator;
    if (!ok) bad.push({ ...a, by: by || '(missing actor)' });
  }
  return bad;
}

// ---------------------------------------------------------------------------
// GitHub facts (the runner's observation acts)

/** The remote branch tip, read through the runner-owned mirror (its config is runner-written). null = absent. */
function remoteBranchSha(repo, branch) {
  const remoteUrl = git(repo, ['config', '--get', 'remote.origin.url']).out;
  const ownerRepo = ownerRepoFromUrl(remoteUrl);
  if (!ownerRepo) throw new Error(`origin (${remoteUrl}) is not a GitHub repository URL`);
  const mirror = mirrorFor(ownerRepo, remoteUrl, repo);
  const r = sh(['git', '-C', mirror, 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], { env: runnerGitEnv(), timeoutMs: 120_000 });
  if (r.code === 2) return null; // absent
  if (r.code !== 0) throw new Error(`git ls-remote failed: ${r.err}`);
  return r.out.split(/\s+/)[0];
}

function prForBranch(ownerRepo, branch) {
  const r = gh(['pr', 'list', '--repo', ownerRepo, '--head', branch, '--state', 'all', '--json', 'number,url,headRefOid,state,mergedAt', '--limit', '20']);
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.err}`);
  const list = JSON.parse(r.out || '[]');
  // an open PR governs; else the newest
  return list.find((p) => p.state === 'OPEN') ?? list[0];
}

function prView(url) {
  const r = gh(['pr', 'view', url, '--json', 'url,body,headRefOid,updatedAt,number,state,mergedAt,baseRefName,headRefName']);
  if (r.code !== 0) throw new Error(`gh pr view failed: ${r.err}`);
  return JSON.parse(r.out);
}

function classifyBranch(sha, intentHead, headAtAssign) {
  if (sha === null) return 'absent';
  if (sha === intentHead) return 'at-sha';
  if (headAtAssign !== undefined && sha === headAtAssign) return 'at-previous';
  return 'other';
}

/** pr-pending: inspect GitHub and record what was found (observation act). */
function inspectAndRecord(repo, task, failure = undefined) {
  const { pub, ownerRepo, expectedRemoteUrl } = publicationTarget(repo, task);
  const cfg = configurationCheck(repo, expectedRemoteUrl);
  if (cfg.length > 0) throw new Error(`repository configuration changed:\n- ${cfg.join('\n- ')}`);
  const intent = task.prIntent;
  const intentHash = sha256(JSON.stringify(intent));
  const sha = remoteBranchSha(repo, intent.branch);
  const branch = classifyBranch(sha, intent.headSha, pub?.mode === 'update' ? pub.pr.headAtAssign : undefined);
  const pr = prForBranch(ownerRepo, intent.branch);
  const args = ['record-pr-inspection', '--branch', branch, '--pr', pr ? 'exists' : 'absent', '--intent-hash', intentHash, '--by', 'ben-runner'];
  if (pr) args.push('--url', pr.url, '--pr-head', pr.headRefOid);
  if (!isBlank(failure)) args.push('--failure', scrubForOperator(failure));
  const r = runMjs(repo, args);
  rlog(repo, `inspection: branch ${branch}${sha ? ` (${sha.slice(0, 12)})` : ''}, PR ${pr ? `${pr.url}@${pr.headRefOid.slice(0, 12)} ${pr.state}` : 'absent'} → ${r.code}`);
  if (r.code !== 0) throw new Error(`record-pr-inspection failed: ${r.out}`);
  return { branch, pr };
}

/** pr-record: fetch the observation, reconcile the body, record terminally. */
/** The publication destination the assignment binds; legacy tasks fall back to origin's owner/repo. */
function publicationTarget(repo, task) {
  const pub = task.assignment?.publication;
  const remoteUrl = git(repo, ['config', '--get', 'remote.origin.url']).out;
  const ownerRepo = pub?.repo ?? ownerRepoFromUrl(remoteUrl);
  const expectedRemoteUrl = pub?.remoteUrl ?? (pub?.repo ? remoteUrl : undefined);
  return { pub, remoteUrl, ownerRepo, expectedRemoteUrl };
}

/** Everything that must hold before ANY credentialed mutation. Returns a problem string or undefined. */
function publicationPreconditions(repo, task, { expectedHead, view = undefined }) {
  const { pub, remoteUrl, ownerRepo, expectedRemoteUrl } = publicationTarget(repo, task);
  const problems = configurationCheck(repo, expectedRemoteUrl);
  if (problems.length > 0) return `ben cannot publish while this repository ships configuration ben did not write:\n- ${problems.join('\n- ')}`;
  if (!ownerRepo) return `origin (${remoteUrl}) is not a GitHub repository URL`;
  if (pub && ownerRepoFromUrl(remoteUrl) !== pub.repo) return `origin now resolves to ${ownerRepoFromUrl(remoteUrl) ?? '(not GitHub)'} — the task was assigned to ${pub.repo}; nothing is published`;
  const intent = task.prIntent;
  if (!intent) return 'no pending publication intent';
  if (pub && intent.branch !== pub.branch) return `the intent names branch ${intent.branch} but the assignment binds ${pub.branch} — refused`;
  if (!/^ben\//.test(intent.branch)) return `the task branch ${intent.branch} is not a ben/* branch — ben never pushes elsewhere`;
  if (intent.branch === (pub?.base ?? 'main')) return 'the task branch equals the base branch — refused';
  if (view !== undefined) {
    if (view.state !== 'OPEN') return `PR ${view.url} is ${view.state} — ben will not modify a closed or merged PR`;
    if (pub && view.headRefName !== pub.branch) return `PR ${view.url} head branch is ${view.headRefName}, not the assigned ${pub.branch}`;
    if (pub && view.baseRefName !== pub.base) return `PR ${view.url} base is ${view.baseRefName}, not the assigned ${pub.base}`;
    if (expectedHead && view.headRefOid !== expectedHead) return `PR ${view.url} is at ${view.headRefOid.slice(0, 12)}, not the reviewed head ${expectedHead.slice(0, 12)} — ben will not publish evidence for other code`;
  }
  return undefined;
}

function recordExistingPr(repo, task, url, expectedHead) {
  const bodyPath = join(S(repo), 'pr-body.md');
  const title = task.title ?? 'ben task';
  // fresh facts + every precondition BEFORE any external mutation
  let view = prView(url);
  const problem = publicationPreconditions(repo, task, { expectedHead, view });
  if (problem) throw new Error(problem);
  // regenerate the body from state (pr.mjs is a referee — invoked from the runtime)
  const pr = sh([process.execPath, join(runtimeDir(repo), 'scripts', 'pr.mjs'), S(repo), '--repo', repo, '--title', title], { cwd: repo });
  if (pr.code !== 0) throw new Error(`pr.mjs failed: ${pr.err}`);
  const canon = (t) => String(t).replaceAll('\r\n', '\n').replace(/\n+$/, '');
  if (canon(view.body) !== canon(readFileSync(bodyPath, 'utf8'))) {
    const e = gh(['pr', 'edit', url, '--body-file', bodyPath]);
    if (e.code !== 0) throw new Error(`gh pr edit failed: ${e.err}`);
    view = prView(url);
  }
  const obs = join(S(repo), 'remote-observation.json');
  writeFileSync(obs, JSON.stringify({ url: view.url, body: view.body, headRefOid: view.headRefOid, updatedAt: view.updatedAt }, null, 2));
  const r = runMjs(repo, ['record-pr', '--url', view.url, '--remote-observation', obs]);
  rlog(repo, `record-pr ${view.url} → ${r.code}`);
  if (r.code !== 0) throw new Error(`record-pr refused: ${r.out}`);
}

// ---------------------------------------------------------------------------
// publication — from a runner-owned mirror, arguments composed from task.json

// Per-checkout mirrors keep concurrent service workers from sharing Git locks/config.
function mirrorFor(ownerRepo, remoteUrl, repo) {
  const dir = join(RUNNER_HOME, 'mirrors', `${ownerRepo.replace('/', '-')}-${sha256(realOrResolved(repo)).slice(0, 16)}.git`);
  const hooks = join(RUNNER_HOME, 'empty-hooks');
  mkdirSync(hooks, { recursive: true });
  if (!existsSync(join(dir, 'HEAD'))) {
    mkdirSync(dir, { recursive: true });
    const r = sh(['git', 'init', '--bare', '-q', dir]);
    if (r.code !== 0) throw new Error(`mirror init failed: ${r.err}`);
  }
  // the runner WRITES the mirror config wholesale: no other keys survive
  writeFileSync(
    join(dir, 'config'),
    `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\thooksPath = ${hooks}\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[credential]\n\thelper = !${GH_CLI} auth git-credential\n`,
  );
  return dir;
}

function runnerGitEnv() {
  const cfg = join(RUNNER_HOME, 'gitconfig');
  if (!existsSync(cfg)) writeFileSync(cfg, '[core]\n\tautocrlf = false\n');
  return { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg, GIT_TERMINAL_PROMPT: '0' };
}

async function publish(repo, task) {
  const intent = task.prIntent;
  if (!intent) throw new Error('publish: no pending intent in task.json');
  const pre = publicationPreconditions(repo, task, { expectedHead: intent.headSha });
  if (pre) return { needsYou: pre };
  const { pub, remoteUrl, ownerRepo } = publicationTarget(repo, task);
  const branch = intent.branch;
  const base = pub?.base ?? 'main';
  if (git(repo, ['rev-parse', 'HEAD']).out !== intent.headSha) return { needsYou: `HEAD (${git(repo, ['rev-parse', 'HEAD']).out}) is not the reviewed head ${intent.headSha} — nothing is published` };
  if (git(repo, ['status', '--porcelain']).out !== '') return { needsYou: 'the worktree is dirty — nothing is published' };
  const mode = intent.publication?.mode ?? pub?.mode ?? 'create';
  const prUrl = intent.publication?.prUrl ?? pub?.pr?.url;
  const headAtAssign = pub?.mode === 'update' ? pub.pr.headAtAssign : undefined;
  const intentHash = sha256(JSON.stringify(intent));
  return timedChild(repo, 'publication', PUBLICATION_TIMEOUT_MS, async () => {
    // fresh remote facts BEFORE any external action
    const sha = remoteBranchSha(repo, branch);
    const branchState = classifyBranch(sha, intent.headSha, headAtAssign);
    const existing = prForBranch(ownerRepo, branch);
    if (mode === 'create' && existing) {
      // a PR already exists: never a second one — record the fact and let the sequencer route
      runMjs(repo, ['record-pr-inspection', '--branch', branchState, '--pr', 'exists', '--url', existing.url, '--pr-head', existing.headRefOid, '--intent-hash', intentHash, '--by', 'ben-runner']);
      return { inspected: true };
    }
    if (mode === 'update' && (!existing || (prUrl && existing.url !== prUrl))) {
      return { needsYou: `update mode expected PR ${prUrl ?? '(recorded)'} for branch ${branch}, GitHub shows ${existing ? existing.url : 'no PR'} — ben will not guess` };
    }
    // recovery regression: the PR may have been merged or closed since the
    // follow-up started — fresh state governs; nothing is pushed to or edited on it
    if (mode === 'update' && existing.state !== 'OPEN') {
      return { needsYou: `PR ${existing.url} is ${String(existing.state).toLowerCase()} — ben will not push to or modify a closed or merged PR; nothing was published` };
    }
    if (branchState === 'other') {
      const prev = existing?.headRefOid;
      // update mode: the branch may sit at the PR's current head (someone pushed) — only a fast-forward is ever pushed
      if (!(mode === 'update' && prev !== undefined && sha === prev)) {
        runMjs(repo, ['record-pr-inspection', '--branch', 'other', '--pr', existing ? 'exists' : 'absent', ...(existing ? ['--url', existing.url, '--pr-head', existing.headRefOid] : []), '--intent-hash', intentHash, '--by', 'ben-runner']);
        return { needsYou: `branch ${branch} on GitHub is at ${sha?.slice(0, 12)} — neither the reviewed head nor a known previous delivery; nothing is overwritten` };
      }
    }
    pauseAt('publish:before-push', S(repo));
    const mirror = mirrorFor(ownerRepo, remoteUrl, repo);
    const env = runnerGitEnv();
    const f = sh(['git', '-C', mirror, 'fetch', '-q', repo, intent.headSha], { env, timeoutMs: PUBLICATION_TIMEOUT_MS });
    if (f.code !== 0) throw new Error(`mirror fetch failed: ${f.err}`);
    if (sha !== intent.headSha) {
      // fast-forward only: a non-ff is refused by git (no --force ever)
      const p = sh(['git', '-C', mirror, 'push', 'origin', `${intent.headSha}:refs/heads/${branch}`], { env, timeoutMs: PUBLICATION_TIMEOUT_MS });
      rlog(repo, `push ${intent.headSha.slice(0, 12)}:refs/heads/${branch} → ${p.code} ${p.err.slice(0, 200)}`);
      if (p.code !== 0) {
        if (/non-fast-forward|rejected|fetch first/.test(p.err)) return { needsYou: `pushing the reviewed head to ${branch} is not a fast-forward — someone else's commits are on the branch; ben never force-pushes.\n${p.err}` };
        throw new Error(`push failed: ${p.err}`);
      }
    } else rlog(repo, `push skipped: ${branch} already at ${intent.headSha.slice(0, 12)}`);
    pauseAt('publish:after-push', S(repo));
    const bodyPath = join(S(repo), 'pr-body.md');
    // the title GitHub receives is bounded (prTitleFor); the full task
    // title is already in the body (pr-body.md, assembled by the sequencer)
    const title = prTitleFor(task.title ?? 'ben task');
    let url;
    if (mode === 'create') {
      const c = gh(['pr', 'create', '--repo', ownerRepo, '--head', branch, '--base', base, '--title', title, '--body-file', bodyPath]);
      if (c.code !== 0) throw new Error(`gh pr create failed: ${c.err}`);
      url = c.out.split('\n').find((l) => /^https?:\/\//.test(l.trim()))?.trim() ?? c.out.trim();
      rlog(repo, `pr created ${url}`);
    } else {
      url = existing.url;
      const e = gh(['pr', 'edit', url, '--body-file', bodyPath]);
      if (e.code !== 0) throw new Error(`gh pr edit failed: ${e.err}`);
      rlog(repo, `pr body updated ${url}`);
    }
    pauseAt('publish:after-create', S(repo));
    const view = prView(url);
    const obs = join(S(repo), 'remote-observation.json');
    writeFileSync(obs, JSON.stringify({ url: view.url, body: view.body, headRefOid: view.headRefOid, updatedAt: view.updatedAt }, null, 2));
    const r = runMjs(repo, ['record-pr', '--url', view.url, '--remote-observation', obs]);
    rlog(repo, `record-pr → ${r.code}`);
    if (r.code !== 0) throw new Error(`record-pr refused: ${r.out}`);
    return { published: view.url };
  });
}

// ---------------------------------------------------------------------------
// playbook — runner-owned deterministic repairs; the rest is NEEDS YOU

function playbookRepair(repo, resultText) {
  const s = S(repo);
  // (a) resolutions landed, blockers.json still present (crash inside ledger.mjs resolve)
  if (existsSync(join(s, 'blockers.json')) && /already holds .* resolution\(s\)/.test(resultText)) {
    try {
      const blockers = JSON.parse(readFileSync(join(s, 'blockers.json'), 'utf8'));
      const ledger = parseJsonl(readFileSync(join(s, 'ledger.jsonl'), 'utf8'));
      // the resolutions must belong to the CURRENT raised occurrence: same review
      // kind (the ledger tail's) and its current round — a historical
      // resolution of a re-raised fingerprint never clears the derivative
      const tail = [...ledger].reverse().find((e) => e.action === 'raised');
      const kind = tail?.kind;
      const rounds = JSON.parse(readFileSync(join(s, 'rounds.json'), 'utf8'));
      const round = Number.isInteger(rounds[kind]) ? rounds[kind] : undefined;
      const resolved = new Set(ledger.filter((e) => e.kind === kind && e.round === round && ['resolved', 'rejected', 'deferred'].includes(e.action)).map((e) => e.fingerprint));
      if (kind !== undefined && round !== undefined && Array.isArray(blockers) && blockers.length > 0 && blockers.every((b) => resolved.has(b.fingerprint))) {
        renameSync(join(s, 'blockers.json'), join(RDIR(repo), `blockers.json.repaired-${Date.now()}`));
        rlog(repo, 'playbook: resolutions landed, derivative blockers.json removed (kept under runner/)');
        return { repaired: 'blockers.json derivative removed — every open fingerprint has its ledger resolution' };
      }
    } catch {
      /* fall through */
    }
  }
  // (b) torn trailing veto.jsonl line
  if (/veto\.jsonl has a torn or malformed trailing line/.test(resultText)) {
    const p = join(s, 'veto.jsonl');
    const raw = readFileSync(p, 'utf8');
    const lines = raw.split('\n');
    const last = lines.filter((l) => l.trim() !== '').at(-1);
    let torn = false;
    try {
      JSON.parse(last);
    } catch {
      torn = true;
    }
    if (torn) {
      copyFileSync(p, join(RDIR(repo), `veto.jsonl.torn-${Date.now()}`));
      const keep = lines.filter((l) => l.trim() !== '').slice(0, -1);
      writeFileSync(p, keep.length > 0 ? `${keep.join('\n')}\n` : '');
      rlog(repo, 'playbook: torn trailing veto.jsonl fragment removed (copy kept under runner/)');
      return { repaired: 'torn veto.jsonl fragment removed — the gate re-presents' };
    }
  }
  // (c) the half-applied grant is handled at loop start by repairHalfGrant()
  // This case: it is detected from the durable grant intent, never from text.
  return undefined;
}

/**
 * A grant in rounds.json without its ledger audit line (crash
 * inside ledger.mjs grant between its two writes). Detected from the durable
 * facts the sequencer keeps for exactly this window (task.grantIntents:
 * consumed=false, grantsBefore, ledgerBefore) — the same matrix run.mjs
 * coreRecordGrant applies before refusing. The runner rolls the half back:
 * removes the one grant object the intent describes and restores the review
 * stop slot the referee's first write lifted, from the AUTHORITATIVE gate
 * record (task.gate.binding.slot). The ledger is untouched (append-only);
 * the intent stays (its next answer re-invokes the referee cleanly); the same
 * question re-presents with "your earlier answer did not complete".
 */
function repairHalfGrant(repo) {
  const s = S(repo);
  const task = safeReadTask(repo).task;
  if (!isObj(task)) return undefined;
  const intents = (task.grantIntents ?? []).filter((g) => isObj(g) && g.consumed === false);
  if (intents.length === 0) return undefined;
  // the rewrite happens under the sequencer's own single-writer lock so an
  // interactive answer/record can never interleave with it; a live holder
  // means "not now" (the loop retries next round), a dead holder is stale
  const lock = join(s, '.run-lock');
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const holder = Number(readFileSync(lock, 'utf8').trim());
    if (pidAlive(holder)) return undefined;
    rlog(repo, `stale .run-lock (pid ${holder} dead) removed before the half-grant repair`);
    unlinkSync(lock);
    fd = openSync(lock, 'wx');
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  try {
    return repairHalfGrantLocked(repo, task, intents);
  } finally {
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock);
    } catch {
      /* gone */
    }
  }
}

function repairHalfGrantLocked(repo, task, intents) {
  const s = S(repo);
  const roundsPath = join(s, 'rounds.json');
  const rounds = readJson(roundsPath) ?? {};
  const ledger = existsSync(join(s, 'ledger.jsonl')) ? parseJsonl(readFileSync(join(s, 'ledger.jsonl'), 'utf8')) : [];
  const grants = Array.isArray(rounds.grants) ? rounds.grants : [];
  for (const g of intents) {
    const m = /^(.*)\|(plan|diff)\|(\d+)\|tally(\d+)$/.exec(g.key);
    if (!m) continue;
    const [, by, kind, roundsStr, tallyStr] = m;
    const granted = Number(roundsStr);
    const tally = Number(tallyStr);
    const after = grants.map((x, i) => ({ x, i })).slice(g.grantsBefore).filter(({ x }) => isObj(x) && x.kind === kind && x.rounds === granted && x.by === by);
    const audit = ledger.filter((e) => e.action === 'granted').slice(g.ledgerBefore).filter((e) => e.reviewer === by && e.kind === kind && e.round === tally && String(e.detail).includes(`granted ${granted} more ${kind}`));
    if (after.length === 0 || audit.length > 0) continue; // neither landed, or both: not this window
    // exactly the half-applied window: roll the rounds.json half back
    copyFileSync(roundsPath, join(RDIR(repo), `rounds.json.half-grant-${Date.now()}`));
    const idx = after[after.length - 1].i;
    rounds.grants = grants.filter((_, i) => i !== idx);
    if (rounds.grants.length === 0) delete rounds.grants;
    const slot = isObj(g.slot) ? g.slot : task.gate?.kind === 'review-stop' && task.gate.binding?.gateKind === kind && isObj(task.gate.binding.slot) ? task.gate.binding.slot : undefined;
    if (slot !== undefined) rounds.gates = { ...(isObj(rounds.gates) ? rounds.gates : {}), [kind]: { round: slot.round, reason: slot.reason } };
    writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
    rlog(repo, `playbook: half-applied ${kind} grant by ${by} rolled back (rounds.json copy kept under runner/); ${slot ? 'the review stop slot is restored' : 'no slot to restore (abstain stop)'} — the question re-presents`);
    writeState(repo, { lastRepair: { kind: 'half-grant', at: nowIso(), note: 'your earlier answer did not complete (the record was half-written when the process died) — the same question is asked again' } });
    return { repaired: 'half-applied grant rolled back; the same question is asked again (your earlier answer did not complete)' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the runner lock

function acquireRunnerLock(repo) {
  mkdirSync(S(repo), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(RLOCK(repo), 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.on('exit', () => {
        try {
          if (readFileSync(RLOCK(repo), 'utf8').trim() === String(process.pid)) unlinkSync(RLOCK(repo));
        } catch {
          /* gone */
        }
      });
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(RLOCK(repo), 'utf8').trim());
      if (pidAlive(pid)) return false;
      rlog(repo, `stale runner.lock (pid ${pid} dead) replaced`);
      unlinkSync(RLOCK(repo));
    }
  }
  return false;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Release the runner lock if THIS process holds it (never another runner's). */
function releaseRunnerLock(repo) {
  try {
    if (readFileSync(RLOCK(repo), 'utf8').trim() === String(process.pid)) unlinkSync(RLOCK(repo));
  } catch {
    /* gone */
  }
}

/**
 * Service-start race: a launcher (service, detached start,
 * resume) resolves RUNNER_MJS(repo) BEFORE its child starts; a repin landing in
 * between leaves an old-runtime runner owning a task whose authoritative pin —
 * and therefore whose trusted children (run.mjs, gate-wrap, pr.mjs) — now name a
 * newer runtime. So, AFTER ownership is taken and BEFORE any task evaluation,
 * probing or work, the executing runtime is bound to the pin: equal digests →
 * the runner proceeds on exactly that pin; a stale launcher releases ownership
 * and hands off to the pinned runtime (which takes ownership itself). Old runner
 * code never runs with new trusted children. Shared by every launch path.
 */
function executingRuntime() {
  const selfDir = realOrResolved(dirname(dirname(SELF)));
  if (existsSync(join(selfDir, '.complete'))) return { dir: selfDir, digest: basename(selfDir) };
  return { dir: selfDir, digest: basename(installRuntimeDir()) }; // the install: its content digest (a copy exists or is made)
}
function bindExecutingRuntime(repo, { once }) {
  const pin = readJson(pinPath(repo));
  if (!isObj(pin) || !existsSync(join(pin.dir, '.complete'))) {
    runtimeDir(repo); // no pin yet: the first-sight pin is taken from the executing install (recorded act)
    return { bound: true };
  }
  const me = executingRuntime();
  if (me.digest === pin.digest) {
    PINNED = pin.dir; // every trusted child of this runner comes from the runtime this code was pinned from
    return { bound: true };
  }
  rlog(repo, `stale launcher: this runner executes ${me.dir} (digest ${me.digest}) but the task is pinned to ${pin.dir} (digest ${pin.digest}) — handing off to the pinned runtime`);
  releaseRunnerLock(repo);
  const r = spawnSync(process.execPath, [join(pin.dir, 'scripts', 'runner.mjs'), 'run', '--repo', repo, ...(once ? ['--once'] : [])], { stdio: 'inherit', env: { ...process.env, BEN_RUNNER_NO_REEXEC: '1' } });
  return { bound: false, code: r.status ?? 1 };
}

function runnerAlive(repo) {
  try {
    return pidAlive(Number(readFileSync(RLOCK(repo), 'utf8').trim()));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// offline handling

function online() {
  const r = gh(['api', 'rate_limit', '--silent'], { timeoutMs: 20_000 });
  if (r.code !== 0 && failureKind(r.err) === 'auth') throw new Error('GitHub authentication expired — authenticate gh before resuming');
  return r.code === 0;
}

const BACKOFF_MS = process.env.BEN_RUNNER_BACKOFF_MS ? [Number(process.env.BEN_RUNNER_BACKOFF_MS)] : [60_000, 300_000, 900_000];
const OFFLINE_BOUND_MS = 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForNetwork(repo) {
  const since = readState(repo).paused?.since ?? nowIso();
  writeState(repo, { paused: { since } });
  rlog(repo, `offline — paused since ${since}; nothing runs and nothing is published until the network returns`);
  let i = 0;
  while (!online()) {
    if (Date.now() - Date.parse(since) > OFFLINE_BOUND_MS) return false;
    const ms = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
    rlog(repo, `offline — retry in ${Math.round(ms / 1000)} s`);
    if (process.env.BEN_RUNNER_SERVICE_CHILD === '1') {
      writeState(repo, { paused: { since, nextAt: Date.now() + ms } });
      return 'deferred'; // service schedules the next observation without occupying a worker
    }
    await sleep(ms);
    i++;
  }
  const st = readState(repo);
  delete st.paused;
  atomicWriteJson(STATE(repo), st);
  return true;
}

/** Retry observations/infrastructure only; never auto-answer a gate or repeat publication. */
async function retryTransient(repo, key, message, force = false) {
  if (!force && failureKind(message) !== 'transient') return false;
  const retries = readState(repo).retries ?? {};
  const previous = retries[key];
  const count = (previous?.count ?? 0) + 1;
  if (count > 6) return false;
  const retryAfter = /retry.after[:= ]+(\d+)/i.exec(message);
  const base = Number(process.env.BEN_RUNNER_BACKOFF_MS ?? Math.min(retryAfter ? Number(retryAfter[1]) * 1000 : 60_000 * 2 ** (count - 1) * (0.8 + Math.random() * 0.4), 900_000));
  const nextAt = previous?.nextAt > Date.now() ? previous.nextAt : Date.now() + base;
  writeState(repo, { retries: { ...retries, [key]: { count, nextAt } }, step: `retrying ${key}` });
  rlog(repo, `${key}: transient attempt ${count}/6; retry after ${Math.max(0, nextAt - Date.now())} ms`);
  if (process.env.BEN_RUNNER_SERVICE_CHILD !== '1') await sleep(Math.max(0, nextAt - Date.now()));
  return true;
}

function clearRetry(repo, key) {
  const retries = { ...(readState(repo).retries ?? {}) };
  delete retries[key];
  writeState(repo, { retries });
}

// ---------------------------------------------------------------------------
// the loop

async function runLoop(repo, { once = false } = {}) {
  repo = realOrResolved(repo);
  if (!existsSync(join(S(repo), 'task.json'))) fail(`no task in ${repo} — runner.mjs assign first`);
  if (!acquireRunnerLock(repo)) {
    console.log(`ben: another runner is alive for ${repo} (${RLOCK(repo)})`);
    process.exit(2);
  }
  // ownership taken: bind the executing runtime to the authoritative pin before
  // anything task-specific (a stale launcher hands off here and never evaluates,
  // probes or works on the task)
  const bound = bindExecutingRuntime(repo, { once });
  if (!bound.bound) return bound.code;
  const first = safeReadTask(repo);
  if (first.broken) {
    parkBrokenTask(repo, first.raw);
    return 1;
  }
  validateGuidance(runtimeDir(repo));
  await reapOrphanDriver(repo);
  let task = first.task;
  // the launch probe is a prerequisite on EVERY entry path — bound
  // to the exact work settings and the pinned runtime; absent or stale → run it
  // now; failed → nothing starts
  const probeOk = await requireProbe(repo, task);
  if (!probeOk) return 1;
  const halfGrant = repairHalfGrant(repo);
  if (halfGrant) console.log(`ben: ${halfGrant.repaired}`);
  const wrapper = commandWrapperFor(repo, task);
  const shim = reviewerShim(repo);
  let sessionId = readState(repo).sessionId ?? randomUUID();
  let sessionStarted = readState(repo).sessionStarted === true;
  // the heartbeat measures sleep gaps within THIS runner's lifetime only — a
  // previous runner's last beat must never read as a sleep gap
  writeState(repo, { sessionId, sessionStarted, pid: process.pid, step: 'starting', lastActivityAt: nowIso(), heartbeatAt: nowIso() });
  clearNeedsYou(repo);
  // Explicit opt-in, scoped to this process. Never changes system power settings.
  let awake;
  if (readState(repo).keepAwake === true && process.platform === 'darwin') {
    awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    awake.on('error', (err) => rlog(repo, `keep-awake unavailable: ${err.message}`));
  }
  // sleep detection: wall clock vs monotonic clock drift —
  // blocking work never reads as sleep; only real suspension does
  const wallStart = Date.now();
  const monoStartMs = Number(process.hrtime.bigint() / 1_000_000n);
  let sleepCounted = 0;
  const checkSleep = () => {
    const gap = sleepGapMs({ wallStart, monoStartMs, wallNow: Date.now(), monoNowMs: Number(process.hrtime.bigint() / 1_000_000n), previouslyCounted: sleepCounted });
    if (gap > 30_000) {
      appendDurable(STRETCHES(repo), { type: 'sleep-gap', ms: gap, at: nowIso() });
      sleepCounted += gap;
    }
  };
  const heartbeat = setInterval(() => {
    checkSleep();
    writeState(repo, { heartbeatAt: nowIso() });
  }, 5000);
  heartbeat.unref();
  try {
    for (;;) {
      if (process.env.BEN_RUNNER_SERVICE_CHILD === '1') {
        const st = readState(repo);
        if (Math.max(st.paused?.nextAt ?? 0, ...Object.values(st.retries ?? {}).map((r) => r.nextAt ?? 0)) > Date.now()) return 0;
        const network = st.paused ? await waitForNetwork(repo) : true;
        if (network === false) {
          needsYou(repo, 'no network for 24 hours — ben stopped waiting');
          return 1;
        }
        if (network === 'deferred') return 0;
      }
      task = readTask(repo);
      // actor audit — third layer
      const status = statusJson(repo);
      if (status === undefined) {
        // task.json unreadable? — save a copy and park NEEDS YOU with repair
        const tp = join(S(repo), 'task.json');
        let broken = false;
        try {
          JSON.parse(readFileSync(tp, 'utf8'));
        } catch {
          broken = true;
        }
        if (broken) {
          const copy = join(RDIR(repo), `task.json.broken-${Date.now()}`);
          copyFileSync(tp, copy);
          needsYou(repo, 'ben cannot read its own task record (task.json is corrupt).', `A copy is saved at ${copy}. Choices: runner.mjs resume --repo ${repo} --choose repair   (re-creates the record from the saved copy's baseline, a recorded act) · or abandon.`);
          writeState(repo, { needsYou: { ...readState(repo).needsYou, kind: 'task-json-unreadable', copy } });
          return 1;
        }
        if (await retryTransient(repo, 'status', 'sequencer status timed out or unavailable', true)) continue;
        needsYou(repo, 'run.mjs status failed — an engineering session is needed');
        return 1;
      }
      clearRetry(repo, 'status');
      const badActors = actorAudit(repo, task, status);
      if (badActors.length > 0) {
        needsYou(repo, `a recorded human-kind act names an actor outside the operator allowlist: ${badActors.map((a) => `${a.kind} by ${a.by}`).join(', ')}. ben will not continue until an engineering session reconciles it.`);
        return 1;
      }
      // limits
      const totals = accountTotals(rows(repo));
      const limits = effectiveLimits(task);
      const hit = reachedLimit(totals, limits);
      if (hit && !status.limitEvent && !task.pr) {
        const r = runMjs(repo, ['record-limit', '--kind', hit.kind, '--value', String(hit.value), '--by', 'ben-runner']);
        rlog(repo, `limit reached: ${hit.kind} ${hit.value} → ${r.code}`);
      }
      // next --json
      rmSync(join(S(repo), 'last-next.json'), { force: true });
      const inv = randomUUID();
      writeState(repo, { step: 'deriving (run.mjs next)', lastActivityAt: nowIso() });
      const next = await timedChild(repo, 'next', 30 * 60 * 1000, async () => runMjs(repo, ['next', '--json'], { env: { BEN_NEXT_INVOCATION: inv, BEN_RUNNER_PID: String(process.pid), BEN_COMMAND_WRAPPER: wrapper, BEN_REVIEWER_CLI: shim } }));
      let res = readJson(join(S(repo), 'last-next.json'));
      if (!isObj(res) || res.invocation !== inv || res.exit !== next.code) {
        if (next.code === 124 && await retryTransient(repo, 'next-timeout', 'sequencer timed out')) continue;
        needsYou(repo, 'the sequencer produced no usable result for this invocation (missing, foreign or exit-inconsistent last-next.json)', next.out.slice(-2000));
        return 1;
      }
      clearRetry(repo, 'next-timeout');
      rlog(repo, `next → ${res.outcome}${res.kind ? ` ${res.kind}/${res.owner}` : ''} (exit ${res.exit})`);
      task = readTask(repo);
      if (res.outcome !== 'contention') clearRetry(repo, 'contention');
      switch (res.outcome) {
        case 'reenter':
          break;
        case 'terminal': {
          writeState(repo, { step: 'READY FOR REVIEW' });
          console.log(`ben: READY FOR REVIEW (not merged, not deployed) · ${res.pr?.url} (head ${res.pr?.headSha})\n     Next: review and merge on GitHub. ben does not merge or deploy.`);
          return 0;
        }
        case 'usage-error':
          needsYou(repo, 'the sequencer refused an invocation (usage error) — an engineering session is needed', next.out.slice(-2000));
          return 1;
        case 'contention': {
          if (res.holder === 'run-lock') {
            const lock = join(S(repo), '.run-lock');
            const recordedHolder = existsSync(lock) ? readFileSync(lock, 'utf8').trim() : '';
            const pid = res.holderPid ?? Number(recordedHolder);
            if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid) && existsSync(lock) && readFileSync(lock, 'utf8').trim() === String(pid)) {
              rlog(repo, `stale .run-lock (pid ${pid} dead) removed — runner-owned playbook repair`);
              rmSync(lock, { force: true });
              break;
            }
          }
          if (await retryTransient(repo, 'contention', 'task lock contention', true)) break;
          console.log(`ben: another process owns this task right now (${next.out.split('\n')[0]}). Stopping.`);
          return 2;
        }
        case 'instruction': {
          const stretch = await guardedStretch(repo, task, withWorkGuidance(runtimeDir(repo), res.guidance, res.instruction), 'instruction', sessionId, sessionStarted);
          if (stretch.halted) return 1;
          if (stretch.stopped) break; // supervisor stop recorded → next parks it
          sessionStarted = stretch.sessionStarted;
          sessionId = stretch.sessionId;
          writeState(repo, { sessionId, sessionStarted });
          if (stretch.offline) {
            if (!(await waitForNetwork(repo))) {
              needsYou(repo, 'no network for 24 hours — ben stopped waiting');
              return 1;
            }
            break;
          }
          break;
        }
        case 'publish': {
          if (!isObj(task.prIntent) || task.prIntent.attempt !== res.publication?.attempt || task.prIntent.headSha !== res.publication?.headSha) {
            rlog(repo, 'publish result does not match the durable intent — re-deriving');
            break;
          }
          writeState(repo, { step: 'publishing (push + PR)', lastActivityAt: nowIso() });
          if (!online()) {
            const network = await waitForNetwork(repo);
            if (network === false) {
              needsYou(repo, 'no network for 24 hours — publication never attempted offline');
              return 1;
            }
            if (network === 'deferred') break;
          }
          let out;
          try {
            out = await publish(repo, task);
          } catch (err) {
            // the failure rides the next inspection (an observed fact the
            // retry gate shows the human); scrubbed and bounded before it is kept
            const message = scrubForOperator(err.message);
            rlog(repo, `publication error: ${message}`);
            writeState(repo, { lastPublicationFailure: { at: nowIso(), intentHash: sha256(JSON.stringify(task.prIntent)), message } });
            // a crash mid-publication is reconciled on the next derivation (pr-pending → inspection)
            break;
          }
          if (out.needsYou) {
            needsYou(repo, out.needsYou);
            return 1;
          }
          break;
        }
        case 'park': {
          const kind = res.kind;
          const owner = res.owner;
          if (owner === 'model') {
            if (kind === 'pr-pending') {
              if (!online()) {
                const network = await waitForNetwork(repo);
                if (network === false) {
                  needsYou(repo, 'no network for 24 hours');
                  return 1;
                }
                if (network === 'deferred') break;
              }
              const lastFailure = readState(repo).lastPublicationFailure;
              const failure = isObj(lastFailure) && isObj(task.prIntent) && lastFailure.intentHash === sha256(JSON.stringify(task.prIntent)) ? lastFailure.message : undefined;
              try {
                inspectAndRecord(repo, task, failure);
                clearRetry(repo, 'inspect');
              } catch (err) {
                if (await retryTransient(repo, 'inspect', err.message)) break;
                needsYou(repo, `ben could not inspect GitHub: ${err.message}`);
                return 1;
              }
              if (failure !== undefined) writeState(repo, { lastPublicationFailure: undefined }); // recorded with the inspection; never carried to a later intent
              break;
            }
            if (kind === 'pr-record' || kind === 'pr-observed') {
              const url = kind === 'pr-record' ? (task.prInspections ?? []).filter((i) => i.pr === 'exists').at(-1)?.url : task.observedPr?.url;
              const expectedHead = kind === 'pr-record' ? task.prIntent?.headSha : task.observedPr?.headSha;
              try {
                recordExistingPr(repo, task, url, expectedHead);
                clearRetry(repo, 'record-pr');
              } catch (err) {
                if (await retryTransient(repo, 'record-pr', err.message)) break;
                needsYou(repo, `ben could not record the existing PR ${url}: ${err.message}`);
                return 1;
              }
              break;
            }
            if (kind === 'model-stop') {
              const instruction = `${res.question}\n\n${res.stop ?? ''}\nThe sequencer's words:\n${next.out}`;
              const stretch = await guardedStretch(repo, task, withWorkGuidance(runtimeDir(repo), res.guidance, instruction), 'model-stop', sessionId, sessionStarted);
              if (stretch.halted) return 1;
              if (stretch.stopped) break;
              sessionStarted = stretch.sessionStarted;
              sessionId = stretch.sessionId;
              writeState(repo, { sessionId, sessionStarted });
              if (stretch.offline) {
                if (!(await waitForNetwork(repo))) {
                  needsYou(repo, 'no network for 24 hours');
                  return 1;
                }
                break;
              }
              break;
            }
            needsYou(repo, `ben does not know how to perform the model-owned park "${kind}"`);
            return 1;
          }
          if (kind === 'pr-migration') {
            // the runner performs the inspection and records the observation act
            try {
              const intent = task.prIntent;
              const ownerRepo = task.assignment?.publication?.repo ?? ownerRepoFromUrl(git(repo, ['config', '--get', 'remote.origin.url']).out);
              const pr = prForBranch(ownerRepo, intent.branch);
              const hash = sha256(JSON.stringify(intent));
              const r = runMjs(repo, ['record-pr-remote', '--status', pr ? 'exists' : 'absent', ...(pr ? ['--url', pr.url] : []), '--intent-hash', hash, '--by', 'ben-runner']);
              rlog(repo, `pr-migration observation → ${r.code}`);
              if (r.code !== 0) throw new Error(r.out);
              clearRetry(repo, 'migration');
            } catch (err) {
              if (await retryTransient(repo, 'migration', err.message)) break;
              needsYou(repo, `ben could not resolve the interrupted PR step: ${err.message}`);
              return 1;
            }
            break;
          }
          if (kind === 'stop') {
            const rep = playbookRepair(repo, next.out);
            if (rep) {
              rlog(repo, `playbook repair: ${rep.repaired}`);
              break;
            }
            const d6r = /crash inside ledger\.mjs round|adjudication state is invalid|register .* ledger|divergen/i.test(next.out);
            needsYou(
              repo,
              d6r
                ? 'ben found inconsistent review records and cannot safely repair them automatically. Preserve the task files. Decide: hold for an engineering session (runner.mjs repair names the playbook step) or abandon this task.'
                : 'ben stopped on an internal inconsistency it will not guess about — an engineering session (runner.mjs repair names the playbook step) or abandon.',
              next.out.slice(-3000),
            );
            return 1;
          }
          // human / playbook gate: parked, durable — the operator answers later
          writeState(repo, { step: `parked: ${kind}`, parkedKind: kind, lastActivityAt: nowIso() });
          const w = readJson(join(S(repo), 'waiting.json'));
          const repairNote = readState(repo).lastRepair;
          if (repairNote) {
            const st2 = readState(repo);
            delete st2.lastRepair;
            atomicWriteJson(STATE(repo), st2);
          }
          console.log(`ben: WAITING ON YOU (${kind}) · ${res.question}${repairNote ? `\n     Note: ${repairNote.note}` : ''}\n     Full brief: ${join(S(repo), 'WAITING.md')}\n${(w?.options ?? []).map((o) => `     ${o.label}: ${o.command}`).join('\n')}`);
          return 0;
        }
        default:
          needsYou(repo, `unknown sequencer outcome ${res.outcome}`);
          return 1;
      }
      if (once) return 0;
    }
  } catch (err) {
    needsYou(repo, `runner stopped: ${scrubForOperator(err.message)}`);
    return 1;
  } finally {
    clearInterval(heartbeat);
    awake?.kill();
  }
}

/** progress identity + repeat counter around a driver stretch, applied to EVERY stretch route. */
async function guardedStretch(repo, task, instruction, route, sessionId, sessionStarted) {
  const head = git(repo, ['rev-parse', 'HEAD']).out;
  const identity = progressIdentity({
    stateDir: S(repo),
    headSha: head,
    worktreeStatus: git(repo, ['status', '--porcelain']).out,
    worktreeDiff: git(repo, ['diff', 'HEAD']).out,
    extraFiles: [...git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).out.split('\0').filter((name) => name && !name.split('/').some((part) => part.startsWith('.') || part === 'node_modules')).map((name) => join(repo, name)), ...researchFiles(join(S(repo), 'research'))],
    ledgerLines: existsSync(join(S(repo), 'ledger.jsonl')) ? readFileSync(join(S(repo), 'ledger.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0,
  });
  const key = sha256(`${identity}|${sha256(instruction)}`);
  const st = readState(repo);
  const repeat = st.repeat?.key === key ? st.repeat.count + 1 : 1;
  writeState(repo, { repeat: { key, count: repeat, route } });
  if (repeat > 5) {
    // Three ordinary attempts plus two bounded recovery attempts changed nothing
    const short = instruction.split('\n')[0].slice(0, 120);
    const r = runMjs(repo, ['record-supervisor-stop', '--reason', `ben tried "${short}" ${repeat - 1} times without any change to the task state`, '--by', 'ben-runner']);
    rlog(repo, `supervisor stop (repeat ${repeat}) → ${r.code}`);
    // a `continue` buys EXACTLY one more attempt on this same state: the counter
    // resumes at 4 so the next identical observation runs once, the one after parks
    writeState(repo, { repeat: { key, count: 4, route } });
    return { stopped: true };
  }
  if (repeat === 4 || repeat === 5) {
    sessionId = randomUUID();
    sessionStarted = false;
    instruction += repeat === 4
      ? '\n[runner recovery] Start from the current artifacts. Diagnose why earlier attempts made no observable progress, then perform the smallest safe next step. Do not change scope, approvals or limits.'
      : '\n[runner recovery] Final bounded recovery attempt: use a focused alternative within the same approved scope. Verify the resulting artifact change. Do not repeat an ineffective approach or bypass a gate.';
    writeState(repo, { sessionId, sessionStarted });
    rlog(repo, `bounded recovery ${repeat - 3}/2`);
  }
  // stretch mode: a driver request is honoured only within the task's grants
  let mode = 'work';
  const reqPath = join(S(repo), 'stretch-request.json');
  if (existsSync(reqPath)) {
    let req;
    try {
      req = JSON.parse(readFileSync(reqPath, 'utf8'));
    } catch {
      req = undefined;
    }
    const decision = stretchModeFor(repo, task, req);
    mode = decision.mode;
    rlog(repo, `stretch request ${JSON.stringify(req)} → ${decision.mode}${decision.reason ? ` (${decision.reason})` : ''}`);
    mkdirSync(join(RDIR(repo), 'requests'), { recursive: true });
    renameSync(reqPath, join(RDIR(repo), 'requests', `${Date.now()}-${decision.mode}.json`));
    if (decision.reason) instruction = `${instruction}\n\n[runner] your stretch request (${JSON.stringify(req)}) was ${decision.mode === 'work' ? 'refused' : 'granted'}: ${decision.reason}`;
  }
  const hint = (task.supervisorStops ?? []).at(-1)?.resolution?.note;
  const full = `${instruction}${hint && (task.supervisorStops ?? []).at(-1)?.resolution ? `\n\n[operator note] ${hint}` : ''}`;
  // BEN_RUNNER_STRETCH_MAX_TURNS: a drill seam — unset in production
  const maxTurns = process.env.BEN_RUNNER_STRETCH_MAX_TURNS ? Number(process.env.BEN_RUNNER_STRETCH_MAX_TURNS) : DEFAULT_STRETCH.maxTurns;
  const out = await driverStretch(repo, task, { instruction: full, mode, kind: route === 'model-stop' ? 'tidy' : 'stretch', sessionId, resume: sessionStarted, maxTurns });
  rlog(repo, `stretch ${out.id} (${mode}) exit ${out.exitCode}${out.timedOut ? ' TIMEOUT' : ''} cost ${out.costUsd ?? 'unreported'} turns ${out.turns ?? '?'} violations ${out.violations}`);
  if (out.limitReached) {
    // Per-stretch caps end this driver, not the approved task. Re-derive under task budgets.
    clearRetry(repo, 'driver-session');
    clearRetry(repo, 'driver-transient');
    return { sessionId: randomUUID(), sessionStarted: false };
  }
  if (!out.ok) {
    const kind = failureKind(`${out.text}\n${out.stderr}${out.timedOut ? '\ntimed out' : ''}`);
    // Infrastructure failures do not consume useful-work attempts; launches still cost budget.
    writeState(repo, { repeat: { key, count: repeat - 1, route } });
    if (kind === 'transient' && /ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|connection error/i.test(out.text + out.stderr) && !online()) return { offline: true, sessionId: randomUUID(), sessionStarted: false };
    if (kind === 'session' || kind === 'transient') {
      if (await retryTransient(repo, `driver-${kind}`, out.text + out.stderr, kind === 'session')) {
        // An error response may have allocated a conversation without a usable result.
        // Start fresh from artifacts instead of guessing whether --resume is valid.
        return { sessionId: randomUUID(), sessionStarted: false };
      }
    }
    needsYou(repo, kind === 'auth' ? 'Claude authentication needs renewal' : `driver ${kind} failure; automatic recovery exhausted or unsafe`, scrubForOperator(out.text || out.stderr || `exit ${out.exitCode}`));
    return { halted: true };
  }
  clearRetry(repo, 'driver-session');
  clearRetry(repo, 'driver-transient');
  return { sessionId: out.sessionId ?? sessionId, sessionStarted: true };
}

/** stretch modes: install needs approval + a plan `## Dependencies` section naming the packages; research needs researchDomains. */
function stretchModeFor(repo, task, req) {
  if (!isObj(req) || !['install', 'research'].includes(req.mode)) return { mode: 'work', reason: 'unknown or malformed request' };
  if (req.mode === 'install') {
    if (!existsSync(join(S(repo), 'approval.json'))) return { mode: 'work', reason: 'install stretches run only after the plan is approved' };
    const plan = existsSync(join(S(repo), 'plan.md')) ? readFileSync(join(S(repo), 'plan.md'), 'utf8') : '';
    const declared = planDependenciesSection(plan);
    if (declared === undefined) return { mode: 'work', reason: 'the approved plan.md declares no "## Dependencies" section' };
    const pkgs = Array.isArray(req.packages) ? req.packages.filter((p) => typeof p === 'string') : [];
    if (pkgs.length === 0) return { mode: 'work', reason: 'an install request must name its packages' };
    const missing = pkgs.filter((p) => !declared.includes(p));
    if (missing.length > 0) return { mode: 'work', reason: `packages not declared in the approved plan: ${missing.join(', ')}` };
    return { mode: 'install', reason: `declared dependencies: ${pkgs.join(', ')}` };
  }
  const domains = task.assignment?.researchDomains ?? [];
  if (domains.length === 0) return { mode: 'work', reason: 'the task grants no research domains (assign --research-domains)' };
  return { mode: 'research', reason: `domains: ${domains.join(', ')}` };
}

// ---------------------------------------------------------------------------
// preflight  and the launch probe

async function preflight(repo, { ownerRepo, base, branchToCheck, assignRunId }) {
  const problems = [];
  const auth = gh(['auth', 'status'], { timeoutMs: 30_000 });
  if (auth.code !== 0) problems.push(`GitHub: ${GH_CLI} is not logged in — fix: gh auth login`);
  const account = /account (\S+)/.exec(`${auth.out}\n${auth.err}`)?.[1];
  if (isBlank(git(repo, ['config', 'user.name']).out) || isBlank(git(repo, ['config', 'user.email']).out)) problems.push('git identity missing — fix: git config user.name / user.email');
  const ls = git(repo, ['ls-remote', '--exit-code', 'origin', 'HEAD'], { timeoutMs: 60_000 });
  if (ls.code !== 0) problems.push(`origin unreachable — ${ls.err.split('\n')[0]}`);
  const url = git(repo, ['config', '--get', 'remote.origin.url']).out;
  const resolved = ownerRepoFromUrl(url);
  if (resolved !== ownerRepo) problems.push(`origin resolves to ${resolved ?? '(not GitHub)'} — expected ${ownerRepo}`);
  if (branchToCheck !== undefined) {
    if (!/^ben\//.test(branchToCheck)) problems.push(`branch ${branchToCheck} is not ben/*`);
    if (branchToCheck === base) problems.push(`branch equals base ${base}`);
  }
  const codex = sh([CODEX_CLI, 'login', 'status'], { timeoutMs: 30_000 });
  if (codex.code !== 0 || !/logged in/i.test(`${codex.out}\n${codex.err}`)) problems.push(`codex reviewer not logged in — fix: codex login`);
  if (process.env.BEN_RUNNER_SKIP_PREFLIGHT_MODEL !== '1') {
    const settings = join(RUNNER_HOME, 'preflight-settings.json');
    atomicWriteJson(settings, renderDriverSettings({ repo, runtimeDir: runtimeDir(), runnerHome: RUNNER_HOME, mode: 'probe' }));
    const r = await driverStretch(repo, {}, { instruction: 'Reply with exactly the word ok and nothing else. Use no tools.', mode: 'probe', kind: 'preflight', sessionId: randomUUID(), resume: false, maxTurns: 1, maxBudgetUsd: 0.2, timeoutMs: 120_000, settingsPath: settings, assignRunId });
    if (!r.ok) problems.push(`claude -p is not reachable (${r.text || r.stderr.split('\n')[0] || `exit ${r.exitCode}`}) — fix: claude /login`);
  }
  return { problems, account };
}

/** The probe binding: sha256 of the work-mode settings + the pinned runtime digest. */
function probeBinding(repo, task) {
  const settings = writeDriverSettings(repo, task, 'work');
  return { settingsSha: sha256(readFileSync(settings)), runtime: basename(runtimeDir(repo)) };
}

/** Enforce the probe prerequisite before any task work; runs it when absent/stale. */
async function requireProbe(repo, task) {
  const p = readJson(join(RDIR(repo), 'probe.json'));
  const bind = probeBinding(repo, task);
  if (p && p.ok === true && p.settingsSha === bind.settingsSha && p.runtime === bind.runtime) return true;
  if (p && p.skipped === true && process.env.BEN_RUNNER_NO_PROBE === '1') return true;
  rlog(repo, p ? `probe stale (${p.ok ? 'binding changed' : 'previous probe failed'}) — re-probing` : 'no probe on record — probing before any work');
  const verdict = await launchProbe(repo, task, undefined);
  if (!verdict.ok) {
    needsYou(repo, `the launch probe found the driver boundary is not enforced on this machine — nothing was started:\n- ${verdict.problems.join('\n- ')}`);
    return false;
  }
  return true;
}

async function launchProbe(repo, task, assignRunId) {
  const bind = probeBinding(repo, task);
  if (process.env.BEN_RUNNER_NO_PROBE === '1') {
    atomicWriteJson(join(RDIR(repo), 'probe.json'), { skipped: true, reason: 'BEN_RUNNER_NO_PROBE (tests only)', at: nowIso(), ...bind });
    return { ok: true, problems: [] };
  }
  const secret = `ben-canary-${randomUUID()}`;
  const canaryDir = join(RUNNER_HOME, 'tasks', taskKey(repo, task), 'canary');
  mkdirSync(canaryDir, { recursive: true });
  const canaryFile = join(canaryDir, 'canary.txt'); // under ~/.ben-runner: denied for writes
  writeFileSync(canaryFile, 'canary-v1\n');
  const secretFile = join(homedir(), '.ssh', `.ben-probe-${randomUUID().slice(0, 8)}`); // under a denied credential dir
  let secretWritten = false;
  try {
    mkdirSync(join(homedir(), '.ssh'), { recursive: true });
    writeFileSync(secretFile, `${secret}\n`);
    secretWritten = true;
  } catch {
    /* no ~/.ssh — the read-denial probe uses the canary dir's sibling instead */
  }
  let hits = 0;
  const listener = createServer((sock) => {
    hits++;
    sock.destroy();
  });
  await new Promise((res) => listener.listen(0, '127.0.0.1', res));
  const port = listener.address().port;
  const instruction = [
    'You are running a launch probe. Run exactly these four Bash commands as separate tool calls and report each outcome verbatim (a refusal is a valid outcome — report its text):',
    `1) printf modified > ${canaryFile}; echo EXIT=$?`,
    secretWritten ? `2) cat ${secretFile}; echo EXIT=$?` : `2) cat ${join(homedir(), '.ssh', 'id_rsa')}; echo EXIT=$?`,
    `3) curl -sS -m 5 http://127.0.0.1:${port}/probe; echo EXIT=$?`,
    '4) curl -sS -m 5 https://example.com; echo EXIT=$?',
    'Then, using the Read tool, try to read the file from step 2 and report the outcome verbatim.',
  ].join('\n');
  const before = readFileSync(canaryFile);
  const r = await driverStretch(repo, task, { instruction, mode: 'probe', kind: 'probe', sessionId: randomUUID(), resume: false, maxTurns: 12, maxBudgetUsd: 0.5, timeoutMs: 300_000, assignRunId });
  const after = readFileSync(canaryFile);
  await new Promise((res) => listener.close(res));
  if (secretWritten) rmSync(secretFile, { force: true });
  // judged from correlated tool calls/results only — the driver's prose is never evidence
  const verdict = judgeProbe({
    transcript: r.transcript,
    canaryBefore: before,
    canaryAfter: after,
    secret,
    listenerHits: hits,
    canaries: { writePath: canaryFile, readPath: secretWritten ? secretFile : join(homedir(), '.ssh', 'id_rsa'), listener: `127.0.0.1:${port}`, network: 'https://example.com' },
  });
  atomicWriteJson(join(RDIR(repo), 'probe.json'), { at: nowIso(), ok: verdict.ok, problems: verdict.problems, costUsd: r.costUsd ?? null, turns: r.turns ?? null, violations: r.violations, listenerHits: hits, exitCode: r.exitCode, ...bind });
  return verdict;
}

// ---------------------------------------------------------------------------
// detached start / service wake

function startDetached(repo) {
  mkdirSync(RDIR(repo), { recursive: true });
  const out = openSync(join(RDIR(repo), 'runner.out'), 'a');
  const child = spawn(process.execPath, [RUNNER_MJS(repo), 'run', '--repo', repo], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, BEN_RUNNER_NO_REEXEC: '1' } });
  child.unref();
  closeSync(out);
  return child.pid;
}

function serviceLoaded() {
  const r = sh(['launchctl', 'print', `gui/${process.getuid()}/${SERVICE_LABEL}`], { timeoutMs: 15_000 });
  return r.code === 0;
}

function startRunner(repo, { inline }) {
  if (values['keep-awake'] || values['allow-sleep']) writeState(repo, { keepAwake: values['keep-awake'] === true });
  if (!inline && !serviceLoaded()) console.log('ben: unattended recovery requires the optional service; this detached runner will not restart itself after a crash.');
  if (runnerAlive(repo)) {
    console.log(`     ben is already working (runner pid ${readFileSync(RLOCK(repo), 'utf8').trim()}). Check with: node ${SELF} status --repo ${repo}`);
    return Promise.resolve();
  }
  if (inline) return runLoop(repo).then((code) => process.exit(code));
  if (serviceLoaded() && !process.env.BEN_RUNNER_HOME) {
    registerRepo(repo);
    console.log('     ben is queued (the service checks every 20 s; starts when a slot is available). Check with: ' + `node ${SELF} status --repo ${repo}`);
    return Promise.resolve();
  }
  const pid = startDetached(repo);
  console.log(`     ben is working (runner pid ${pid}, log ${join(RDIR(repo), 'runner.out')}). Check with: node ${SELF} status --repo ${repo}`);
  return Promise.resolve();
}

function registerRepo(repo) {
  const p = join(RUNNER_HOME, 'registry.json');
  const reg = readJson(p) ?? { repos: [] };
  if (!reg.repos.includes(repo)) reg.repos.push(repo);
  atomicWriteJson(p, reg);
}

// ---------------------------------------------------------------------------
// assign

async function cmdAssign() {
  const repo = realOrResolved(values.repo ?? fail('--repo <path> is required'));
  const outcome = positionals.slice(1).join(' ').trim();
  if (isBlank(outcome)) fail('describe the outcome: runner.mjs assign --repo <path> "<what you want>"');
  if (!existsSync(join(repo, '.git'))) fail(`${repo} is not a git repository`);
  if (existsSync(join(S(repo), 'task.json'))) fail(`${repo} already has a task (.ben/task.json) — one task per repo; use follow-up or finish it first`);
  const assignRunId = randomUUID();
  runtimeDir();
  // configuration check first: refuse repo-shipped configuration, touch nothing
  const remoteUrl = git(repo, ['config', '--get', 'remote.origin.url']).out;
  const cfgProblems = configurationCheck(repo, undefined);
  if (cfgProblems.length > 0) {
    console.log(`ben: NEEDS YOU · ben cannot isolate itself from this repository's configuration; nothing was started.\n- ${cfgProblems.join('\n- ')}\nben never edits, moves or deletes these files — remove or relocate them yourself, then assign again.`);
    process.exit(1);
  }
  if (git(repo, ['status', '--porcelain']).out !== '') fail('the worktree is dirty — commit or stash first; ben starts from a clean tree');
  const ownerRepo = ownerRepoFromUrl(remoteUrl);
  if (!ownerRepo) fail(`origin (${remoteUrl || 'none'}) is not a GitHub repository`);
  // base: --base or the remote default branch
  let base = values.base;
  if (isBlank(base)) {
    const d = gh(['repo', 'view', ownerRepo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], { timeoutMs: 60_000 });
    base = d.code === 0 && !isBlank(d.out) ? d.out.trim() : 'main';
  }
  // access preflight BEFORE any branch is created
  const pf = await preflight(repo, { ownerRepo, base, assignRunId });
  if (pf.problems.length > 0) {
    console.log(`ben: NEEDS YOU · ben can't start:\n- ${pf.problems.join('\n- ')}\nNothing was started.`);
    process.exit(1);
  }
  const f = git(repo, ['fetch', '-q', 'origin', base], { timeoutMs: 120_000 });
  if (f.code !== 0) fail(`git fetch origin ${base} failed: ${f.err}`);
  const baseSha = git(repo, ['rev-parse', `origin/${base}`]).out;
  const slug = outcome
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-')
    .slice(0, 40) || 'task';
  let branch = `ben/${slug}`;
  for (let i = 2; git(repo, ['rev-parse', '--verify', '-q', branch]).code === 0 || remoteBranchSha(repo, branch) !== null; i++) branch = `ben/${slug}-${i}`;
  const co = git(repo, ['checkout', '-q', '-b', branch, baseSha]);
  if (co.code !== 0) fail(`could not create ${branch} from ${baseSha}: ${co.err}`);
  // branch validation after creation
  const pf2 = await preflightBranchOnly(base, branch);
  if (pf2.length > 0) fail(pf2.join('; '));
  // .ben/ ignored (commit)
  const gi = join(repo, '.gitignore');
  const current = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === '.ben/' || l.trim() === '.ben')) {
    writeFileSync(gi, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}.ben/\n`);
    git(repo, ['add', '.gitignore']);
    const c = git(repo, ['commit', '-q', '-m', 'chore: ignore .ben/ (ben task state)']);
    if (c.code !== 0) fail(`could not commit .gitignore: ${c.err}`);
  }
  const operator = operatorFor(repo, undefined) ?? fail('no operator identity — pass --by <name> or set git user.name');
  const limits = { usd: Number(values.usd ?? DEFAULT_LIMITS.usd), hours: Number(values.hours ?? DEFAULT_LIMITS.hours), stretches: Number(values.stretches ?? DEFAULT_LIMITS.stretches) };
  const assignment = {
    publication: { repo: ownerRepo, remote: 'origin', remoteUrl, base, baseSha, branch, mode: 'create' },
    limits,
    allowDomains: splitList(values['allow-domains']),
    researchDomains: splitList(values['research-domains']),
    allowNetworkGates: values['allow-network'] === 'gates',
    operator,
  };
  const aPath = join(RUNNER_HOME, `assignment-${assignRunId}.json`);
  atomicWriteJson(aPath, assignment);
  const initArgs = ['init', '--title', outcome, '--assignment', aPath];
  for (const k of ['plan-rounds', 'diff-rounds', 'plan-rounds-max', 'diff-rounds-max', 'e2e-paths']) if (!isBlank(values[k])) initArgs.push(`--${k}`, values[k]);
  const init = runMjs(repo, initArgs);
  if (init.code !== 0) fail(`run.mjs init failed:\n${init.out}`);
  rmSync(aPath, { force: true });
  writePin(repo, installRuntimeDir(), `assign by ${operator}`); // the runtime pin: an operator act
  writeFileSync(join(S(repo), 'brief.md'), `# Brief\n\nAssigned by ${operator} on ${nowIso()}.\n\n## Outcome, in the operator's words\n\n${outcome}\n\n## Publication\n\nBranch ${branch} → PR against ${ownerRepo} ${base} (base ${baseSha}). ben delivers READY FOR REVIEW; the human merges.\n`);
  adoptPreTaskLaunches(repo, assignRunId);
  const task = readTask(repo);
  writeState(repo, { assignedAt: nowIso(), operator });
  // the launch probe: judged from evidence; any deviation → the task does not start
  const probe = await launchProbe(repo, task, assignRunId);
  if (!probe.ok) {
    needsYou(repo, `the launch probe found the driver boundary is not enforced on this machine — nothing was started:\n- ${probe.problems.join('\n- ')}`);
    process.exit(1);
  }
  registerRepo(repo);
  console.log(`ben: task ${basename(repo)}/${slug} created on branch ${branch} (base ${baseSha.slice(0, 7)}).\n     limits: $${limits.usd}, ${limits.hours}h, ${limits.stretches} work stretches. publication: PR to ${ownerRepo} ${base}.`);
  await startRunner(repo, { inline: values.inline === true });
}

async function preflightBranchOnly(base, branch) {
  const p = [];
  if (!/^ben\//.test(branch)) p.push(`branch ${branch} is not ben/*`);
  if (branch === base) p.push('branch equals base');
  return p;
}

function splitList(v) {
  return isBlank(v) ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// resume

async function cmdResume() {
  const repo = realOrResolved(values.repo ?? fail('--repo <path> is required'));
  if (!existsSync(join(S(repo), 'task.json'))) fail(`no task in ${repo}`);
  const st = readState(repo);
  const chosen = Array.isArray(values.choose) ? values.choose : [];
  const read = safeReadTask(repo);
  // runner-handled observation/repair tokens never reach `answer`
  if (chosen[0] === 'repair') {
    if (st.needsYou?.kind !== 'task-json-unreadable') fail('repair applies only to the corrupt task.json case ben parked');
    const copy = st.needsYou.copy;
    const base = st.needsYou.base ?? /"base":\s*"([0-9a-f]{40})"/.exec(readFileSync(copy, 'utf8'))?.[1];
    if (!base) fail(`the saved copy ${copy} carries no readable base sha — an engineering session is needed`);
    const operator = operatorFor(repo, undefined) ?? fail('no operator identity — pass --by <name>');
    renameSync(join(S(repo), 'task.json'), join(RDIR(repo), `task.json.replaced-${Date.now()}`));
    const r = runMjs(repo, ['adopt', '--base', base, '--by', operator, '--confirm']);
    if (r.code !== 0) fail(`adopt failed:\n${r.out}`);
    console.log(`ben: task record re-created from the saved copy's baseline ${base.slice(0, 12)} (adopt by ${operator}).`);
    clearNeedsYou(repo);
    return startRunner(repo, { inline: values.inline === true });
  }
  if (read.broken) {
    parkBrokenTask(repo, read.raw);
    process.exit(1);
  }
  const task = read.task;
  const operator = operatorFor(repo, task) ?? fail('no operator identity');
  if (values.repin === true) {
    // a LOCKED transition. The runner lock is held for the
    // replacement, so neither the service nor another resume can start a runner
    // meanwhile (they see a live holder); a task a runner owns is refused, and so
    // is a task whose previous runner died leaving a driver alive on the tree
    // (the next runner reaps it — the pin must not move under it). The lock is
    // released right after the pin write; a refusal releases it on exit.
    if (!acquireRunnerLock(repo)) fail(`a runner owns this task (${RLOCK(repo)}) — wait for its park or stop it before re-pinning; nothing was changed`);
    const orphan = Number(readState(repo).currentStretchPid);
    if (Number.isInteger(orphan) && orphan > 0 && pidAlive(orphan)) {
      fail(`a driver process (pid ${orphan}) from a previous runner still owns the working tree — run resume first (the runner reaps it) or stop that process; nothing was changed`);
    }
    const dir = writePin(repo, installRuntimeDir(), `resume --repin by ${operator}`);
    rlog(repo, `runtime re-pinned by ${operator}: ${dir}`);
    console.log(`ben: runtime re-pinned to ${dir} (operator act).`);
    releaseRunnerLock(repo);
  }
  if (chosen[0] === 'reinspect') {
    if (!task.prIntent) fail('reinspect applies only while a publication is pending');
    if (runnerAlive(repo)) fail('a runner is alive — it re-inspects on its own');
    try {
      const facts = inspectAndRecord(repo, task); // an observation act, never a decision
      console.log(`ben: re-inspected GitHub — branch ${facts.branch}, PR ${facts.pr ? `${facts.pr.url} @ ${facts.pr.headRefOid.slice(0, 12)}` : 'absent'}; the sequencer routes from these facts.`);
    } catch (err) {
      fail(`ben could not inspect GitHub: ${err.message}`);
    }
    clearNeedsYou(repo);
    return startRunner(repo, { inline: values.inline === true });
  }
  const status = statusJson(repo);
  const w = status?.waiting;
  if (w?.state === 'current' && (w.owner === 'human' || w.owner === 'playbook') && (w.options ?? []).length > 0) {
    if (chosen.length === 0 && isBlank(values.reply) && isBlank(values['reply-file'])) {
      // interactive: show the question, capture the identity, read the choice
      if (!process.stdin.isTTY) fail(`a noninteractive answer needs --gate <id> and --choose <token> — the printed line in ${join(S(repo), 'WAITING.md')} carries both`);
      const gate = w.gateId;
      console.log(`ben · ${basename(repo)} · WAITING ON YOU (${w.kind})\n   ${w.question}\n   legal answers: ${w.options.join(', ')}`);
      const choice = (await prompt('   your answer (token, optionally followed by text): ')).trim();
      const [tok, ...restWords] = choice.split(/\s+/);
      const text = restWords.join(' ');
      const args = ['answer', '--expect-gate', gate, '--choose', tok, '--by', operator];
      if (text) args.push(tok === 'abort' || tok === 'continue' ? '--note' : '--reply', text);
      const r = runMjs(repo, args);
      console.log(r.out);
      if (r.code !== 0) process.exit(1);
    } else {
      if (isBlank(values.gate)) fail(`a noninteractive answer needs --gate <id> — copy the printed line from ${join(S(repo), 'WAITING.md')}; an answer is never bound to "the latest question"`);
      const args = ['answer', '--expect-gate', values.gate, '--by', operator];
      for (const c of chosen) args.push('--choose', c);
      for (const k of ['reply', 'reply-file', 'note', 'usd', 'hours', 'stretches', 'criterion', 'residual']) if (!isBlank(values[k])) args.push(`--${k}`, values[k]);
      const r = runMjs(repo, args);
      console.log(r.out);
      if (r.code !== 0) process.exit(1);
    }
  } else if (chosen.length > 0 || !isBlank(values.gate)) {
    // a late or replayed answer: the sequencer names the resolution (task.gate is
    // authoritative); nothing is applied. If THIS exact gate was already answered
    // and the work is still pending, the same command resumes it (the answer→launch crash window) — never a second decision.
    const args = ['answer', '--by', operator, ...(isBlank(values.gate) ? [] : ['--expect-gate', values.gate])];
    for (const c of chosen) args.push('--choose', c);
    for (const k of ['usd', 'hours', 'stretches']) if (!isBlank(values[k])) args.push(`--${k}`, values[k]);
    const r = runMjs(repo, args);
    console.log(r.out || `ben: nothing is waiting on you (${w?.state ?? 'no note'}${w?.reason ? `: ${w.reason}` : ''}) — the answer was not applied.`);
    const alreadyAnswered = /already answered/.test(r.out) && !isBlank(values.gate) && task.gate?.id === values.gate;
    if (!alreadyAnswered) {
      if (runnerAlive(repo)) console.log(`     ben is already working (runner pid ${readFileSync(RLOCK(repo), 'utf8').trim()}).`);
      process.exit(1);
    }
    console.log('     That answer already landed; resuming the pending work from durable state.');
  }
  clearNeedsYou(repo);
  if (readTask(repo)?.pr) {
    console.log(`ben: READY FOR REVIEW (not merged, not deployed) · ${readTask(repo).pr.url}`);
    return;
  }
  return startRunner(repo, { inline: values.inline === true });
}

function prompt(q) {
  return new Promise((res) => {
    process.stdout.write(q);
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      buf += d;
      res(buf);
    });
  });
}

// ---------------------------------------------------------------------------
// status

function cmdStatus() {
  const repo = realOrResolved(values.repo ?? fail('--repo <path> is required'));
  if (!existsSync(join(S(repo), 'task.json'))) {
    console.log(`ben: no task in ${repo}`);
    return;
  }
  const readT = safeReadTask(repo);
  const st = readState(repo);
  if (readT.broken) {
    console.log(`${basename(repo)} · NEEDS YOU · ${st.needsYou?.summary ?? 'task.json is corrupt'}\n  ${st.needsYou?.detail ?? `runner.mjs resume --repo ${repo} --choose repair (after the runner has saved a copy) · or abandon`}`);
    return;
  }
  runtimeDir(repo);
  const task = readT.task;
  const status = statusJson(repo);
  const alive = runnerAlive(repo);
  const totals = accountTotals(rows(repo), alive ? { inFlightId: st.currentStretch ?? undefined, live: true } : {});
  const limits = effectiveLimits(task);
  const lastActivityMs = st.lastActivityAt ? Date.now() - Date.parse(st.lastActivityAt) : undefined;
  const cls = classifyStatus({ status, runnerAlive: alive, runnerState: st, lastActivityMs });
  const pub = task?.assignment?.publication;
  const name = `${basename(repo)}/${pub?.branch?.replace(/^ben\//, '') ?? task?.title ?? 'task'}`;
  const spent = `spent $${totals.usd.toFixed(2)} of $${limits.usd} (${totals.exactUsd.toFixed(2)} exact${totals.cappedUsd > 0 ? ` + ${totals.cappedUsd.toFixed(2)} unreported, charged at cap` : ''}${totals.inFlightCapUsd > 0 ? ` + one stretch in flight, cap $${totals.inFlightCapUsd.toFixed(2)}` : ''} + ${totals.reviewerCalls} reviewer calls estimated $${totals.reviewerUsd.toFixed(2)}) · ${(totals.activeMs / 3600000).toFixed(2)}h of ${limits.hours}h active · stretch ${totals.stretches}/${limits.stretches}`;
  if (values.json) {
    console.log(JSON.stringify({ state: cls.state, detail: cls.detail, name, totals, limits, runnerAlive: alive, runnerState: st, sequencer: status }, null, 2));
    return;
  }
  const lines = [`${name} · ${cls.state}${cls.detail ? ` · ${cls.detail}` : ''}`];
  if (st.lastActivityAt) lines.push(`  last activity ${Math.round((lastActivityMs ?? 0) / 60000)} min ago · ${spent}`);
  else lines.push(`  ${spent}`);
  if (cls.state === 'WAITING ON YOU' || cls.state === 'LIMIT REACHED' || (cls.state === 'NEEDS YOU' && status?.waiting?.state === 'current')) {
    lines.push(`  answer: see ${join(S(repo), 'WAITING.md')}`);
    const w = readJson(join(S(repo), 'waiting.json'));
    for (const o of w?.options ?? []) lines.push(`    ${o.label}: ${o.command}`);
  } else if (cls.state === 'WORKING') lines.push(`  next: ${st.step ?? 'working'} · nothing needed from you`);
  else if (cls.state === 'READY FOR REVIEW') lines.push('  Next: review and merge on GitHub. ben does not merge or deploy.');
  else if (cls.state === 'NOT RUNNING') lines.push(`  resume with: node ${SELF} resume --repo ${repo}`);
  if (values.detail) {
    lines.push('  --- detail ---');
    lines.push(`  sequencer: ${JSON.stringify(status?.waiting)}`);
    lines.push(`  runner state: ${JSON.stringify(st)}`);
    lines.push(`  probe: ${JSON.stringify(readJson(join(RDIR(repo), 'probe.json')))}`);
    lines.push(`  needs you: ${JSON.stringify(st.needsYou ?? null)}`);
  }
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// follow-up

async function cmdFollowUp() {
  const repo = realOrResolved(values.repo ?? fail('--repo <path> is required'));
  const s = S(repo);
  const lineagePath = join(s, 'lineage.json');
  let lineage = readJson(lineagePath) ?? [];
  // an in-progress transition (moving | moved | initialized) resumes from its
  // persisted request; the operator's arguments are not required again
  // an in-progress transition carries its persisted request; a legacy 'moved'
  // entry (pre-phase format) is a completed follow-up, never resumed
  let mv = lineage.find((l) => ['moving', 'moved', 'initialized'].includes(l.status) && isObj(l.request));
  const prNum = mv ? mv.pr : Number(values.pr);
  if (!Number.isSafeInteger(prNum) || prNum < 1) fail('--pr <number> is required');
  const note = mv ? mv.request.note : positionals.slice(1).join(' ').trim();
  if (isBlank(note)) fail('describe the follow-up: runner.mjs follow-up --repo <path> --pr N "<note>"');
  if (runnerAlive(repo)) fail('a runner is alive for this repo — stop it first');
  if (!acquireRunnerLock(repo)) fail('could not take the runner lock');
  const prevRead = safeReadTask(repo);
  const prev = prevRead.task;
  if (mv === undefined) {
    if (prevRead.broken) fail('the current task.json is corrupt — runner.mjs resume --choose repair first');
    if (prev === undefined) fail(`no completed task in ${repo} to follow up on`);
    if (!prev.pr) fail('the current task is not READY FOR REVIEW yet — follow-up applies to a delivered PR');
  }
  const cfgProblems = configurationCheck(repo, undefined);
  if (cfgProblems.length > 0) fail(`repository ships configuration ben did not write:\n- ${cfgProblems.join('\n- ')}`);
  const ownerRepo = (mv?.assignment ?? prev?.assignment)?.publication?.repo ?? ownerRepoFromUrl(git(repo, ['config', '--get', 'remote.origin.url']).out);
  // reconcile the PR — on a resumed transition the snapshot taken at the start governs
  const view = mv?.prView ?? prView(`https://github.com/${ownerRepo}/pull/${prNum}`);
  if (mv === undefined) {
    // the COMPLETE effective request is validated here,
    // before any transition or external mutation — an invalid request refuses with
    // nothing changed, so the delivered task stays intact and a corrected command
    // works normally. A valid request is persisted and replayed exactly (below).
    const requested = Object.fromEntries(['plan-rounds', 'diff-rounds', 'plan-rounds-max', 'diff-rounds-max', 'e2e-paths', 'usd', 'hours', 'stretches'].filter((k) => !isBlank(values[k])).map((k) => [k, values[k]]));
    const problems = [];
    const posInt = (k) => {
      const n = Number(requested[k]);
      if (!Number.isSafeInteger(n) || n < 1) problems.push(`--${k} must be a positive integer, got "${requested[k]}"`);
      return n;
    };
    for (const kind of ['plan', 'diff']) {
      const soft = requested[`${kind}-rounds`] !== undefined ? posInt(`${kind}-rounds`) : 3; // init's default
      if (requested[`${kind}-rounds-max`] !== undefined) {
        const max = posInt(`${kind}-rounds-max`);
        if (Number.isSafeInteger(max) && Number.isSafeInteger(soft) && max < soft) problems.push(`--${kind}-rounds-max must be >= --${kind}-rounds (${soft}), got ${max}`);
      }
    }
    const baseLimits = prev?.assignment?.limits ?? DEFAULT_LIMITS;
    const provisional = {
      publication: { repo: ownerRepo, remote: 'origin', remoteUrl: git(repo, ['config', '--get', 'remote.origin.url']).out, base: view.baseRefName, baseSha: view.headRefOid, branch: view.headRefName, mode: 'update', pr: { number: prNum, url: view.url, headAtAssign: view.headRefOid } },
      limits: { usd: isBlank(requested.usd) ? baseLimits.usd : Number(requested.usd), hours: isBlank(requested.hours) ? baseLimits.hours : Number(requested.hours), stretches: isBlank(requested.stretches) ? baseLimits.stretches : Number(requested.stretches) },
      allowDomains: prev?.assignment?.allowDomains ?? [],
      researchDomains: prev?.assignment?.researchDomains ?? [],
      allowNetworkGates: prev?.assignment?.allowNetworkGates === true,
      operator: operatorFor(repo, prev) ?? '',
    };
    problems.push(...assignmentIssues(provisional));
    if (problems.length > 0) fail(`follow-up request refused — nothing was changed:\n- ${problems.join('\n- ')}`);
    if (view.state === 'MERGED' || view.mergedAt) fail(`PR #${prNum} is merged; assign a new outcome from the merged base instead`);
    if (view.state === 'CLOSED') {
      if (values.reopen === true) {
        const r = gh(['pr', 'reopen', view.url]);
        if (r.code !== 0) fail(`gh pr reopen failed: ${r.err}`);
        view.state = 'OPEN';
      } else if (values.abandon === true) fail(`PR #${prNum} stays closed; nothing created (abandon acknowledged)`);
      else fail(`PR #${prNum} is closed without merge — pass --reopen to reopen it, or --abandon`);
    }
  }
  const branch = view.headRefName;
  if (!/^ben\//.test(branch)) fail(`PR #${prNum} head branch ${branch} is not a ben/* branch`);
  const delivered = prev?.pr?.headSha ?? mv?.deliveredHead;
  const headMoved = Boolean(delivered && view.headRefOid !== delivered);
  // review threads: GraphQL with isResolved, paginated; failure → refuse (retryable)
  const threads = mv?.threads ?? fetchReviewThreads(ownerRepo, prNum);
  const comments = mv?.comments ?? (Array.isArray(view.comments) ? view.comments : fetchIssueComments(ownerRepo, prNum));
  const n = mv ? mv.n : lineage.filter((l) => l.status === 'done' || l.status === 'moved').length + 1;
  const slug = (mv?.assignment ?? prev?.assignment)?.publication?.branch?.replace(/^ben\//, '') ?? `task-${n}`;
  const destRel = join('history', `${n}-${slug}`);
  if (mv === undefined) {
    const entries = readdirSync(s).filter((e) => e !== 'history' && e !== 'lineage.json' && !e.startsWith('.runner-paused') && e !== 'runner.lock');
    lineage.push({
      n,
      status: 'moving',
      dest: destRel,
      entries,
      pr: prNum,
      prUrl: view.url,
      deliveredHead: delivered ?? null,
      assignment: prev?.assignment ?? null,
      limits: prev ? effectiveLimits(prev) : null,
      // the same caps/limits flags as assign, persisted with the
      // request so a resumed transition applies exactly what the operator typed
      request: { note, prNum, by: operatorFor(repo, prev) ?? null, flags: Object.fromEntries(['plan-rounds', 'diff-rounds', 'plan-rounds-max', 'diff-rounds-max', 'e2e-paths', 'usd', 'hours', 'stretches'].filter((k) => !isBlank(values[k])).map((k) => [k, values[k]])) },
      prView: view,
      threads,
      comments,
      at: nowIso(),
    });
    atomicWriteJson(lineagePath, lineage);
    lineage = readJson(lineagePath);
    mv = lineage.find((l) => l.status === 'moving');
  }
  const persist = () => atomicWriteJson(lineagePath, lineage);
  if (mv.status === 'moving') {
    mkdirSync(join(s, mv.dest), { recursive: true });
    pauseAt('followup:moving', s);
    for (const e of mv.entries) {
      const from = join(s, e);
      const to = join(s, mv.dest, e);
      if (existsSync(from) && !existsSync(to)) renameSync(from, to);
      else if (existsSync(from) && existsSync(to)) fail(`both ${from} and ${to} exist — an engineering session reconciles the interrupted move`);
    }
    mv.status = 'moved';
    mv.movedAt = nowIso();
    persist();
  }
  pauseAt('followup:moved', s);
  const prevA = mv.assignment ?? {};
  const operator = operatorFor(repo, undefined) ?? mv.request?.by ?? prevA.operator ?? fail('no operator identity');
  if (mv.status === 'moved') {
    // checkout the branch at the PR head
    const f = git(repo, ['fetch', '-q', 'origin', branch]);
    if (f.code !== 0) fail(`git fetch origin ${branch} failed: ${f.err}`);
    const co = git(repo, ['checkout', '-q', '-B', branch, view.headRefOid]);
    if (co.code !== 0) fail(`checkout ${branch} at ${view.headRefOid} failed: ${co.err}`);
    const assignment = {
      publication: { repo: ownerRepo, remote: 'origin', remoteUrl: git(repo, ['config', '--get', 'remote.origin.url']).out, base: view.baseRefName, baseSha: view.headRefOid, branch, mode: 'update', pr: { number: prNum, url: view.url, headAtAssign: view.headRefOid } },
      limits: (() => {
        const base = mv.limits ?? prevA.limits ?? DEFAULT_LIMITS;
        const f = isObj(mv.request?.flags) ? mv.request.flags : {};
        return { usd: isBlank(f.usd) ? base.usd : Number(f.usd), hours: isBlank(f.hours) ? base.hours : Number(f.hours), stretches: isBlank(f.stretches) ? base.stretches : Number(f.stretches) };
      })(),
      allowDomains: prevA.allowDomains ?? [],
      researchDomains: prevA.researchDomains ?? [],
      allowNetworkGates: prevA.allowNetworkGates === true,
      operator,
    };
    const aPath = join(RUNNER_HOME, `assignment-${randomUUID()}.json`);
    atomicWriteJson(aPath, assignment);
    const initArgs = ['init', '--title', `follow-up on PR #${prNum}: ${note.slice(0, 80)}`, '--assignment', aPath];
    const flags = isObj(mv.request?.flags) ? mv.request.flags : {};
    for (const k of ['plan-rounds', 'diff-rounds', 'plan-rounds-max', 'diff-rounds-max', 'e2e-paths']) if (!isBlank(flags[k])) initArgs.push(`--${k}`, flags[k]);
    const init = runMjs(repo, initArgs);
    rmSync(aPath, { force: true });
    if (init.code !== 0) fail(`run.mjs init failed:\n${init.out}`);
    writePin(repo, installRuntimeDir(), `follow-up by ${operator}`);
    const brief = [
      '# Brief (follow-up)',
      '',
      `Follow-up task ${n} on PR #${prNum} (${view.url}), base = the PR head ${view.headRefOid}${headMoved ? ` — NOTE: the head moved since ben's delivery (${delivered}); this follow-up bases on the current head` : ''}. Previous task kept under .ben/${mv.dest}/.`,
      '',
      "## The operator's note",
      '',
      note,
      '',
      '## Review comments on the PR (unresolved threads and top-level comments, fetched by the runner)',
      '',
      ...threads.map((t) => `- [thread ${t.path ?? ''}${t.line ? `:${t.line}` : ''}] ${t.comments.map((c) => `${c.author}: ${c.body}`).join(' / ')}`),
      ...comments.map((c) => `- [comment] ${c.author?.login ?? c.author ?? '?'}: ${c.body}`),
      ...(threads.length + comments.length === 0 ? ['(none)'] : []),
      '',
      '## Publication',
      '',
      `Push to ${branch} (fast-forward), update PR #${prNum}'s body, record it. The human merges.`,
    ].join('\n');
    writeFileSync(join(s, 'brief.md'), `${brief}\n`);
    mv.status = 'initialized';
    mv.initializedAt = nowIso();
    persist();
  }
  pauseAt('followup:initialized', s);
  const task = readTask(repo);
  const probe = await launchProbe(repo, task, undefined);
  if (!probe.ok) {
    needsYou(repo, `the launch probe found the driver boundary is not enforced — nothing was started:\n- ${probe.problems.join('\n- ')}`);
    process.exit(1);
  }
  mv.status = 'done';
  mv.doneAt = nowIso();
  persist();
  registerRepo(repo);
  // release our lock before the loop takes it (detached or inline)
  try {
    if (readFileSync(RLOCK(repo), 'utf8').trim() === String(process.pid)) unlinkSync(RLOCK(repo));
  } catch {
    /* gone */
  }
  console.log(`ben: checked PR #${prNum}: ${view.state.toLowerCase()}, head ${view.headRefOid.slice(0, 7)}${headMoved ? ' (moved since delivery — basing on the current head)' : " (unchanged since ben's delivery)"}.\n     follow-up task ${n} created on ${branch} (base ${view.headRefOid.slice(0, 7)}); previous task kept under .ben/${mv.dest}/. PR #${prNum} will be updated, not recreated.`);
  await startRunner(repo, { inline: values.inline === true });
}

function fetchReviewThreads(ownerRepo, prNum) {
  const [owner, name] = ownerRepo.split('/');
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const q = `query($owner:String!,$name:String!,$n:Int!,$c:String){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:50,after:$c){pageInfo{hasNextPage endCursor}nodes{isResolved path line comments(first:50){nodes{author{login}body}}}}}}}`;
    const r = gh(['api', 'graphql', '-f', `query=${q}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${prNum}`, ...(cursor ? ['-f', `c=${cursor}`] : [])], { timeoutMs: 60_000 });
    if (r.code !== 0) fail(`could not fetch the PR's review threads (${r.err.split('\n')[0]}) — retry follow-up when GitHub is reachable; the brief is never silently narrowed`);
    const data = JSON.parse(r.out).data.repository.pullRequest.reviewThreads;
    for (const t of data.nodes) if (!t.isResolved) out.push({ path: t.path, line: t.line, comments: t.comments.nodes.map((c) => ({ author: c.author?.login ?? '?', body: c.body })) });
    if (!data.pageInfo.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }
  return out;
}

function fetchIssueComments(ownerRepo, prNum) {
  const r = gh(['api', `repos/${ownerRepo}/issues/${prNum}/comments`, '--paginate'], { timeoutMs: 60_000 });
  if (r.code !== 0) fail(`could not fetch the PR's comments (${r.err.split('\n')[0]}) — retry when GitHub is reachable`);
  return JSON.parse(r.out || '[]').map((c) => ({ author: c.user?.login, body: c.body }));
}

// ---------------------------------------------------------------------------
// repair (name the playbook step; the engineering session does the rest)

function cmdRepair() {
  const repo = realOrResolved(values.repo ?? fail('--repo <path> is required'));
  runtimeDir();
  const st = readState(repo);
  const status = statusJson(repo);
  const last = readJson(join(S(repo), 'last-next.json'));
  console.log(`ben repair · ${repo}\n` + `runner state: ${JSON.stringify(st.needsYou ?? st.step ?? null)}\n` + `sequencer waiting: ${JSON.stringify(status?.waiting ?? null)}\n` + `last sequencer outcome: ${JSON.stringify(last ? { outcome: last.outcome, kind: last.kind, stop: last.stop } : null)}\n\n` + 'Playbook (references/recovery.md) — the step that matches the stop text above is the one to perform in an engineering session; ben never repairs authoritative history itself. The two accepted engineering-session cases: a ledger round with `raised` rows and no blockers.json; an adjudication register/ledger divergence.\n' + `After the repair: node ${SELF} resume --repo ${repo}`);
}

// ---------------------------------------------------------------------------
// service

function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function cmdService() {
  const sub = positionals[1];
  const uid = process.getuid();
  if (sub === 'install') {
    mkdirSync(dirname(plistPath()), { recursive: true });
    mkdirSync(join(RUNNER_HOME, 'logs'), { recursive: true });
    // the service runs a PINNED copy of the install (an operator act at install time)
    const serveRuntime = installRuntimeDir();
    atomicWriteJson(join(RUNNER_HOME, 'service-runtime.json'), { dir: serveRuntime, pinnedAt: nowIso(), install: BEN_DIR });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${join(serveRuntime, 'scripts', 'runner.mjs')}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(RUNNER_HOME, 'logs', 'serve.out')}</string>
  <key>StandardErrorPath</key><string>${join(RUNNER_HOME, 'logs', 'serve.err')}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string><key>HOME</key><string>${homedir()}</string><key>BEN_RUNNER_NO_REEXEC</key><string>1</string></dict>
</dict></plist>
`;
    writeFileSync(plistPath(), plist);
    sh(['launchctl', 'bootout', `gui/${uid}/${SERVICE_LABEL}`]);
    const r = sh(['launchctl', 'bootstrap', `gui/${uid}`, plistPath()]);
    if (r.code !== 0) fail(`launchctl bootstrap failed: ${r.err}`);
    console.log(`ben: service installed and started (${plistPath()}). It runs only while you are logged in — nothing runs while logged out. It checks every 20 s and supervises up to two tasks concurrently. Non-parked tasks resume when a slot is available; after logout or reboot this happens at the next login.`);
    return;
  }
  if (sub === 'uninstall') {
    sh(['launchctl', 'bootout', `gui/${uid}/${SERVICE_LABEL}`]);
    rmSync(plistPath(), { force: true });
    console.log('ben: service removed.');
    return;
  }
  if (sub === 'status') {
    const r = sh(['launchctl', 'print', `gui/${uid}/${SERVICE_LABEL}`]);
    const reg = readJson(join(RUNNER_HOME, 'registry.json')) ?? { repos: [] };
    console.log(`ben: service ${r.code === 0 ? 'loaded' : 'not loaded'} (${plistPath()}${existsSync(plistPath()) ? '' : ' absent'})\n     registry: ${reg.repos.length === 0 ? '(no repos)' : reg.repos.join(', ')}`);
    return;
  }
  fail('service install|uninstall|status');
}

async function cmdServe() {
  runtimeDir();
  const interval = Number(process.env.BEN_RUNNER_SERVE_INTERVAL_MS ?? 20_000);
  const children = new Map();
  const concurrency = 2;
  for (;;) {
    const reg = readJson(join(RUNNER_HOME, 'registry.json')) ?? { repos: [] };
    for (const repo of reg.repos) {
      try {
        // each repo runs ITS pinned runtime — for the inspection (`status --json`)
        // as much as for the launch: the memoized pin of the previous repo is
        // dropped BEFORE anything task-specific runs
        PINNED = undefined;
        if (!existsSync(join(S(repo), 'task.json'))) continue;
        const task = readTask(repo);
        if (task?.pr) continue;
        if (children.has(repo) || runnerAlive(repo)) continue;
        if (children.size >= concurrency) continue;
        const st = readState(repo);
        if (st.needsYou) continue;
        if (Math.max(st.paused?.nextAt ?? 0, ...Object.values(st.retries ?? {}).map((r) => r.nextAt ?? 0)) > Date.now()) continue;
        const status = statusJson(repo);
        const w = status?.waiting;
        if (w?.state === 'current' && (w.owner === 'human' || w.owner === 'playbook')) continue; // parked for the human: nothing to do
        console.log(`${nowIso()} serve: resuming ${repo}`);
        const child = spawn(process.execPath, [RUNNER_MJS(repo), 'run', '--repo', repo], { stdio: 'inherit', env: { ...process.env, BEN_RUNNER_NO_REEXEC: '1', BEN_RUNNER_SERVICE_CHILD: '1' } });
        const done = new Promise((resolve) => {
          child.once('exit', () => { children.delete(repo); resolve(); });
          child.once('error', (err) => { children.delete(repo); console.error(`serve: ${repo}: ${err.message}`); resolve(); });
        });
        children.set(repo, done);
      } catch (err) {
        console.error(`${nowIso()} serve: ${repo}: ${err.message}`);
      }
    }
    if (process.env.BEN_RUNNER_SERVE_ONCE === '1') { await Promise.all(children.values()); return; }
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// argv

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      repo: { type: 'string' },
      by: { type: 'string' },
      base: { type: 'string' },
      usd: { type: 'string' },
      hours: { type: 'string' },
      stretches: { type: 'string' },
      'allow-domains': { type: 'string' },
      'research-domains': { type: 'string' },
      'allow-network': { type: 'string' },
      'plan-rounds': { type: 'string' },
      'diff-rounds': { type: 'string' },
      'plan-rounds-max': { type: 'string' },
      'diff-rounds-max': { type: 'string' },
      'e2e-paths': { type: 'string' },
      gate: { type: 'string' },
      choose: { type: 'string', multiple: true },
      reply: { type: 'string' },
      'reply-file': { type: 'string' },
      note: { type: 'string' },
      criterion: { type: 'string' },
      residual: { type: 'string' },
      pr: { type: 'string' },
      reopen: { type: 'boolean', default: false },
      abandon: { type: 'boolean', default: false },
      detail: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      inline: { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      repin: { type: 'boolean', default: false },
      'keep-awake': { type: 'boolean' },
      'allow-sleep': { type: 'boolean' },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err), 1);
}
const { values, positionals } = parsed;
const command = positionals[0];
if (values['keep-awake'] && values['allow-sleep']) fail('choose --keep-awake or --allow-sleep, not both');

// task-bound commands run the task's PINNED runtime; assign,
// follow-up and service are operator acts that (re)pin from the install.
// `resume --repin` is such an operator act too — it
// must run from the INSTALL (re-executed from the old pin, installRuntimeDir()
// would resolve to the pin itself and re-pin the old runtime under its own digest)
if (['run', 'resume', 'status', 'repair', 'readiness'].includes(command) && !isBlank(values.repo) && !(command === 'resume' && values.repin === true)) reexecFromPin(realOrResolved(values.repo));

switch (command) {
  case 'readiness': {
    const repo = realOrResolved(values.repo ?? fail('--repo <path> is required'));
    const status = statusJson(repo);
    const task = safeReadTask(repo);
    console.log(JSON.stringify({ serviceLoaded: serviceLoaded(), loggedInServiceOnly: true,
      keepAwake: readState(repo).keepAwake === true, taskReadable: !task.broken,
      waiting: status?.waiting ?? null, needsYou: readState(repo).needsYou ?? null,
      limits: task.broken ? null : effectiveLimits(task.task), totals: accountTotals(rows(repo)),
      probeRecordedOk: readJson(join(RDIR(repo), 'probe.json'))?.ok === true,
      note: 'Readiness is local state, not proof of current provider authentication or a current probe binding; launch validates the binding. Approve the exact plan and resolve human criteria before leaving. Sleep/logout can suspend work; use --keep-awake explicitly for idle sleep.' }, null, 2));
    break;
  }
  case 'assign':
    await cmdAssign();
    break;
  case 'resume':
    await cmdResume();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'follow-up':
    await cmdFollowUp();
    break;
  case 'repair':
    cmdRepair();
    break;
  case 'service':
    cmdService();
    break;
  case 'run': {
    const code = await runLoop(realOrResolved(values.repo ?? fail('--repo <path> is required')), { once: values.once === true });
    process.exit(code);
    break;
  }
  case 'serve':
    await cmdServe();
    break;
  case 'gate-wrap':
    cmdGateWrap();
    break;
  default:
    fail('usage: runner.mjs assign|resume|status|follow-up|repair|service|run|serve|gate-wrap (see the header)');
}
