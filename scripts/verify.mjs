#!/usr/bin/env node
// verify — gates, criteria, scope and commit checks.
// Behaviour ported from gates()/verify()/implement() in src/orchestrator/machine.ts and
// src/gates/{deterministic,criteria,evidence}.ts (legacy implementation).
// Zero dependencies. Node only (git invoked for the commit check).
//
// Usage:
//   node scripts/verify.mjs gates    <dir> [--repo p] [--gates f]    [--cap 2] [--timeout ms]
//   node scripts/verify.mjs criteria <dir> [--repo p] [--criteria f] [--cap 2] [--timeout ms]
//   node scripts/verify.mjs commits  <dir> [--repo p] --since <ref>
//   node scripts/verify.mjs scope    <dir> [--repo p] --base <ref> [--e2e-paths a,b] [--cap 2]
//
// Per-command isolation: with `--command-wrapper <json argv>` (or
// BEN_COMMAND_WRAPPER) set, every gate/criterion command is spawned as
// `<wrapper…> /bin/sh -c <command>` in a SCRUBBED environment, with
// BEN_SCRATCH_DIR pointing at a fresh, empty, per-command scratch directory
// under <dir>/evidence/scratch/; the runner wrapper limits .ben writes to this path.
// After the command exits the referee alone promotes regular files from
// scratch into <dir>/evidence/artifacts/<label>/ (copied, never executed,
// exec bits stripped). Unset, behaviour is byte-identical to before.
//
// `scope` re-derives e2e
// applicability from the ACTUAL diff, not the plan's declaration: if any path
// changed since --base matches a configured e2e glob and the criteria carry no
// e2e-method criterion, the build is red regardless of what plan-files.json
// declared. Paths come from `git diff --name-only --no-renames -z` — exact
// NUL-delimited records, immune to core.quotePath quoting, and --no-renames
// lists BOTH sides of a rename (a UI file renamed away is still a UI change).
// With no e2e paths configured the check is inert (exit 0).
//
// <dir> holds the state files and receives evidence/ (default: cwd); --repo is where the
// commands run (default: <dir>). Evidence is round-stamped (-rN from the fix tally in
// rounds.json) so a fix attempt never overwrites the evidence of the failure. Red output
// is echoed raw, truncated mechanically (head+tail+marker) — never summarized; the full
// file stays on disk. An e2e criterion's command runs like any other and must be
// self-contained (including any server orchestration).
//
// `commits` is the implement-phase honesty check: zero commits since --since is a failure
// ("You finished without committing anything"), escalating on the second offense.
//
// Exit codes: 0 green · 1 red, fix and re-run · 2 escalated (cap exhausted) · 3 usage/IO error

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { deriveAdjudication, readLedgerStrict, resolveRepoForState } from './adjudication.lib.mjs';

const MAX_PROMPT_BYTES = 16_384;
const HEAD_LINES = 200;
const TAIL_LINES = 200;

function fail(msg) {
  console.error(`verify: ${msg}`);
  process.exit(3);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readRounds(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObj(parsed)) throw new Error('expected an object');
  return parsed;
}

// Isolated commands remove a defined set of credential and harness variables.
// This denylist cannot identify every possible secret. Git/gh user config is disabled.
function scrubbedEnv(scratchDir, ghEmptyDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'].includes(k)) continue;
    if (k.startsWith('CLAUDE') || k.startsWith('BEN_RUN_PAUSE') || k.startsWith('GIT_CONFIG_')) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GH_CONFIG_DIR = ghEmptyDir;
  env.BEN_SCRATCH_DIR = scratchDir;
  return env;
}

function runShell(command, cwd, timeoutMs, isolation = undefined) {
  const started = Date.now();
  let argv0 = '/bin/sh';
  let argv = ['-c', command];
  const opts = { cwd, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 };
  if (isolation !== undefined) {
    // fresh, empty scratch — a crash-retry of the same attempt never inherits
    // files it did not write in THIS run; the dir is proven contained (never
    // a symlink, never outside evidence/scratch) before any trusted rm
    mkdirSync(isolation.scratchRoot, { recursive: true });
    assertContained(isolation.scratchRoot, isolation.scratchDir, 'scratch dir');
    rmSync(isolation.scratchDir, { recursive: true, force: true });
    mkdirSync(isolation.scratchDir, { recursive: true });
    assertContained(isolation.artifactsRoot, isolation.artifactsDir, 'artifacts dir');
    mkdirSync(isolation.ghEmptyDir, { recursive: true });
    [argv0, ...argv] = [...isolation.wrapper, '/bin/sh', '-c', command];
    opts.env = scrubbedEnv(isolation.scratchDir, isolation.ghEmptyDir);
  }
  const r = spawnSync(argv0, argv, opts);
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const spawnFailed = r.error !== undefined && !timedOut;
  return {
    exitCode: timedOut ? 124 : spawnFailed ? 126 : (r.status ?? 1),
    stdout: r.stdout ?? '',
    stderr: spawnFailed ? `${r.stderr ?? ''}\n[verify: the isolation wrapper failed to spawn: ${r.error.message}]` : (r.stderr ?? ''),
    durationMs: Date.now() - started,
    timedOut,
    // promotion happens AFTER exit: the referee alone copies regular files
    // out of scratch into authoritative evidence; nothing is executed
    artifacts: isolation === undefined ? undefined : promoteScratch(isolation.scratchDir, isolation.artifactsDir),
  };
}

/** Copy regular files (only) from scratch into evidence/artifacts/<label>/; returns their relative paths. */
function promoteScratch(scratchDir, artifactsDir) {
  const promoted = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const src = join(dir, name);
      let st;
      try {
        st = lstatSync(src); // lstat: a symlink is never followed
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(src);
      else if (st.isFile()) {
        const rel = relative(scratchDir, src);
        if (rel.startsWith('..')) continue; // never promote outside the scratch tree
        const dst = join(artifactsDir, rel);
        mkdirSync(join(dst, '..'), { recursive: true });
        copyFileSync(src, dst);
        promoted.push({ path: rel, bytes: st.size });
      }
      // symlinks, sockets, fifos, devices: skipped — never promoted
    }
  };
  walk(scratchDir);
  for (const a of promoted) {
    try {
      // strip every exec bit: promoted evidence is data, never executable
      chmodSync(join(artifactsDir, a.path), 0o644);
    } catch {
      /* best effort */
    }
  }
  return promoted;
}

// verbatim format from src/gates/evidence.ts
function formatEvidence(command, r) {
  return [
    `$ ${command}`,
    `exit: ${r.exitCode}${r.timedOut ? ' (TIMED OUT, killed)' : ''}  duration: ${r.durationMs}ms`,
    '--- stdout ---',
    r.stdout,
    '--- stderr ---',
    r.stderr,
    ...(r.artifacts !== undefined
      ? ['--- artifacts promoted from BEN_SCRATCH_DIR ---', ...(r.artifacts.length > 0 ? r.artifacts.map((a) => `${a.path} (${a.bytes} bytes)`) : ['(none)'])]
      : []),
  ].join('\n');
}

// Untrusted names (gate names, criterion ids) become path components: keep
// them opaque — every character outside [A-Za-z0-9._-] becomes '_' (sane
// names are unchanged), so no name can climb out of evidence/.
function safeLabel(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
}

/** Refuse to touch a path that is not strictly inside `root` (lexically and via realpath of the deepest existing ancestor) or that is a symlink. */
function assertContained(root, path, what) {
  // compare REAL paths on both sides (macOS: /var → /private/var); the parent of
  // `path` always exists here (it is the root itself or a dir created under it)
  const rootReal = realpathSync(root);
  const full = join(realpathSync(dirname(path)), basename(path));
  const rel = relative(rootReal, full);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) fail(`${what} escapes ${root}: ${path}`);
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    /* absent: fine */
  }
  if (isLink) fail(`${what} is a symbolic link: ${path}`);
}

function writeEvidence(evidDir, name, content) {
  mkdirSync(evidDir, { recursive: true });
  const path = join(evidDir, safeLabel(name));
  assertContained(evidDir, path, 'evidence file');
  writeFileSync(path, content);
  return path;
}

// mechanical truncation for prompts: head + tail + explicit marker, full file untouched
// on disk — never a model summary. Verbatim from src/gates/evidence.ts.
function truncateForPrompt(content, fullPath) {
  if (Buffer.byteLength(content, 'utf8') <= MAX_PROMPT_BYTES) return content;
  const lines = content.split('\n');
  const omitted = Math.max(0, lines.length - HEAD_LINES - TAIL_LINES);
  const head = lines.slice(0, HEAD_LINES).join('\n');
  const tail = lines.slice(-TAIL_LINES).join('\n');
  const marker = `\n[... ${omitted} lines omitted — full file at ${fullPath} ...]\n`;
  const out = head + marker + tail;
  if (Buffer.byteLength(out, 'utf8') <= MAX_PROMPT_BYTES) return out;
  const budget = Math.floor((MAX_PROMPT_BYTES - marker.length) / 2);
  return content.slice(0, budget) + marker + content.slice(-budget);
}

// identical to pregate.mjs's copy (ported from machine.ts; dotAll enabled) —
// `**` spans path separators AND newlines (a pathname may legally contain one),
// `*` stays within a segment
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
  return new RegExp(`^${pattern}$`, 's');
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      gates: { type: 'string', default: 'gates.json' },
      criteria: { type: 'string', default: 'criteria.json' },
      cap: { type: 'string', default: '2' },
      timeout: { type: 'string', default: '600000' },
      since: { type: 'string' },
      base: { type: 'string' },
      'e2e-paths': { type: 'string', default: '' },
      'command-wrapper': { type: 'string' },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;

const command = positionals[0];
if (!['gates', 'criteria', 'commits', 'scope'].includes(command)) fail('first argument must be "gates", "criteria", "commits" or "scope"');
const dir = resolvePath(positionals[1] ?? '.');
// one repo derivation — an explicit --repo must
// correspond to a `.ben` state dir's own repository; with no --repo the
// `.ben`-parent rule applies. Non-`.ben` fixture layouts keep today's
// default (the state dir itself). An ORPHAN `.ben` (parent is not a repo)
// fails closed — `.ben` itself is never the repository. cwd is never consulted.
let repo;
try {
  repo = resolveRepoForState(dir, values.repo);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
if (repo === undefined) {
  if (basename(dir) === '.ben') {
    fail(`a .ben state dir must belong to a repository — ${dir} has no repository parent and no valid --repo resolves it; refusing to treat .ben itself as the repo`);
  }
  repo = dir;
}
const cap = Number(values.cap);
if (!Number.isInteger(cap) || cap < 0) fail(`--cap must be a non-negative integer, got "${values.cap}"`);
const timeoutMs = Number(values.timeout);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail(`--timeout must be a positive integer (ms), got "${values.timeout}"`);
// the optional isolation wrapper — a JSON argv array; the flag wins over
// the environment; malformed → usage error, never a silent unwrapped run
const wrapperRaw = values['command-wrapper'] ?? process.env.BEN_COMMAND_WRAPPER;
let commandWrapper;
if (wrapperRaw !== undefined && wrapperRaw !== '') {
  try {
    commandWrapper = JSON.parse(wrapperRaw);
  } catch (err) {
    fail(`--command-wrapper / BEN_COMMAND_WRAPPER must be a JSON array of argv strings: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(commandWrapper) || commandWrapper.length === 0 || commandWrapper.some((a) => typeof a !== 'string' || a.length === 0)) {
    fail('--command-wrapper / BEN_COMMAND_WRAPPER must be a non-empty JSON array of non-empty strings');
  }
}

const evidDir = join(dir, 'evidence');
/** Per-command isolation descriptor (undefined when no wrapper is configured). */
const isolationFor = (rawLabel) => {
  if (commandWrapper === undefined) return undefined;
  const label = safeLabel(rawLabel);
  mkdirSync(join(evidDir, 'artifacts'), { recursive: true });
  return {
    wrapper: commandWrapper,
    scratchRoot: join(evidDir, 'scratch'),
    artifactsRoot: join(evidDir, 'artifacts'),
    scratchDir: join(evidDir, 'scratch', label),
    artifactsDir: join(evidDir, 'artifacts', label),
    ghEmptyDir: join(evidDir, 'scratch', '.gh-empty'),
  };
};
const roundsPath = join(dir, 'rounds.json');
let rounds;
try {
  rounds = readRounds(roundsPath);
} catch (err) {
  fail(`rounds.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
}
const tally = (key) => (Number.isInteger(rounds[key]) && rounds[key] >= 0 ? rounds[key] : 0);
const bumpTally = (key) => {
  rounds[key] = tally(key) + 1;
  writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
  return rounds[key];
};

if (command === 'commits') {
  if (!values.since) fail('commits requires --since <ref>');
  const r = spawnSync('git', ['rev-list', '--count', `${values.since}..HEAD`], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) fail(`git rev-list failed in ${repo}: ${(r.stderr ?? '').trim()}`);
  const count = Number(r.stdout.trim());
  if (count > 0) {
    console.log(`verify: ${count} commit(s) since ${values.since}`);
    process.exit(0);
  }
  const strikes = bumpTally('implement');
  if (strikes > 1) {
    console.log('implementer produced no commits after two attempts');
    process.exit(2);
  }
  console.log('No commits\nYou finished without committing anything. Implement the plan and commit your changes.');
  process.exit(1);
}

if (command === 'gates') {
  const gatesPath = join(dir, values.gates);
  if (!existsSync(gatesPath)) fail(`${values.gates} not found in ${dir} — declare the toolchain (gate name -> shell command)`);
  const gates = JSON.parse(readFileSync(gatesPath, 'utf8'));
  if (!isObj(gates) || Object.keys(gates).length === 0 || Object.values(gates).some((v) => typeof v !== 'string')) {
    fail(`${values.gates} must be a non-empty object of gate name -> shell command`);
  }
  const attempt = tally('gateFix') + 1; // -rN: a retry never overwrites the evidence of the failure
  const results = [];
  for (const [name, cmd] of Object.entries(gates)) {
    const r = runShell(cmd, repo, timeoutMs, isolationFor(`gate-${name}-r${attempt}`));
    const evidencePath = writeEvidence(evidDir, `gate-${name}-r${attempt}.txt`, formatEvidence(cmd, r));
    results.push({ name, exitCode: r.exitCode, evidencePath });
  }
  const red = results.filter((r) => r.exitCode !== 0);
  if (red.length > 0) {
    const strikes = bumpTally('gateFix');
    if (strikes > cap) {
      console.log(`gates still red after ${cap} fix attempts: ${red.map((r) => r.name).join(', ')}`);
      process.exit(2);
    }
    const sections = red.map(
      (r) => `### gate: ${r.name} (exit ${r.exitCode})\n\n${truncateForPrompt(readFileSync(r.evidencePath, 'utf8'), r.evidencePath)}`,
    );
    console.log(`Gates failed — raw evidence below\n${sections.join('\n\n')}`);
    process.exit(1);
  }
  console.log(`verify: ${results.length} gate(s) green`);
  process.exit(0);
}

if (command === 'scope') {
  if (!values.base) fail('scope requires --base <ref>');
  // the only normalization anywhere is on the glob side:
  // trim + strip leading "./"; plan-files entries and git output are canonical
  const e2eGlobs = values['e2e-paths']
    .split(',')
    .map((s) => s.trim().replace(/^(\.\/)+/, ''))
    .filter(Boolean);
  if (e2eGlobs.length === 0) {
    console.log('verify: scope inert — no e2e paths configured');
    process.exit(0);
  }
  const criteriaPath = join(dir, values.criteria);
  if (!existsSync(criteriaPath)) fail(`${values.criteria} not found in ${dir}`);
  const doc = JSON.parse(readFileSync(criteriaPath, 'utf8'));
  if (!isObj(doc) || !Array.isArray(doc.criteria) || doc.criteria.some((c) => !isObj(c) || !isObj(c.verification))) {
    fail(`${values.criteria} does not look like a criteria doc — run pregate.mjs first`);
  }
  // exact NUL-delimited path records: -z is immune to core.quotePath quoting,
  // --no-renames lists both sides of a rename as delete+add
  const r = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', `${values.base}...HEAD`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) fail(`git diff failed in ${repo}: ${(r.stderr ?? '').trim()}`);
  const changed = r.stdout.split('\0').filter((p) => p.length > 0);
  const matched = changed.filter((p) => e2eGlobs.some((g) => globToRegExp(g).test(p)));
  const hasE2e = doc.criteria.some((c) => c.verification.method === 'e2e');
  if (matched.length > 0 && !hasE2e) {
    const attempt = tally('scopeFix') + 1; // -rN: a fix attempt never overwrites the failure's evidence
    const evidence = [
      `$ git diff --name-only --no-renames -z ${values.base}...HEAD`,
      `e2e globs: ${e2eGlobs.join(', ')}`,
      `changed paths matching e2e globs (no e2e criterion in ${values.criteria}):`,
      ...matched.map((p) => `  ${p}`),
      'all changed paths:',
      ...changed.map((p) => `  ${p}`),
    ].join('\n');
    const evidencePath = writeEvidence(evidDir, `scope-r${attempt}.txt`, evidence);
    const strikes = bumpTally('scopeFix');
    if (strikes > cap) {
      console.log(`scope still failing after ${cap} fix attempts: the diff touches e2e paths (${matched.join(', ')}) with no e2e criterion`);
      process.exit(2);
    }
    console.log(
      `Scope failed — the actual diff touches e2e paths but the criteria carry no e2e criterion\n${truncateForPrompt(evidence, evidencePath)}\n` +
        `Legal fixes: add an e2e criterion that proves the changed UI behavior (and declare the touched paths in plan-files.json) — editing those artifacts voids the approval and re-presents the plan phase — or show these paths are not UI (changing the e2e configuration is the human's decision, never the model's).`,
    );
    process.exit(1);
  }
  console.log(
    matched.length > 0
      ? `verify: scope green — ${matched.length} changed path(s) match e2e globs and an e2e criterion is present`
      : `verify: scope green — ${changed.length} changed path(s), none match e2e globs`,
  );
  process.exit(0);
}

// --- criteria ---
const criteriaPath = join(dir, values.criteria);
if (!existsSync(criteriaPath)) fail(`${values.criteria} not found in ${dir}`);
const doc = JSON.parse(readFileSync(criteriaPath, 'utf8'));
if (!isObj(doc) || !Array.isArray(doc.criteria) || doc.criteria.some((c) => !isObj(c) || typeof c.id !== 'string' || !isObj(c.verification))) {
  fail(`${values.criteria} does not look like a criteria doc — run pregate.mjs first`);
}

// a manual criterion with a GOVERNING adjudication
// record lands in the matrix as `adjudicated` with the record verbatim as its
// evidence; without one it stays `manual` (never fail, never pass).
// Malformed/tampered/conflicting/divergent adjudication state is exit 3 —
// derived UNCONDITIONALLY (fail-closed at read): a criterion set with
// zero manual criteria never skips the integrity derivation.
let governing = new Map();
{
  const approvalPath = join(dir, 'approval.json');
  try {
    ({ governing } = deriveAdjudication({
      stateDir: dir,
      // the shared strict boundary — illegal framing or a torn line is exit 3,
      // never a silently narrowed history
      ledgerEntries: readLedgerStrict(join(dir, 'ledger.jsonl')),
      criteriaDoc: doc,
      approvalBytes: existsSync(approvalPath) ? readFileSync(approvalPath) : undefined,
      getHeadSha: () => {
        const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git rev-parse HEAD failed in ${repo}: ${(r.stderr ?? '').trim()}`);
        return r.stdout.trim();
      },
    }));
  } catch (err) {
    fail(`adjudication state invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const attempt = tally('verifyFix') + 1;
const matrix = {};
for (const c of doc.criteria) {
  const { method, command: cmd } = c.verification;
  if (method === 'manual') {
    const g = governing.get(c.id);
    if (g !== undefined) {
      const evidencePath = writeEvidence(evidDir, `criteria-${c.id}-r${attempt}.txt`, `${JSON.stringify(g, null, 2)}\n`);
      matrix[c.id] = { status: 'adjudicated', evidencePath };
      continue;
    }
    const evidencePath = writeEvidence(
      evidDir,
      `criteria-${c.id}-r${attempt}.txt`,
      `MANUAL criterion — requires a human check before merge.\nStatement: ${c.statement}`,
    );
    matrix[c.id] = { status: 'manual', evidencePath };
    continue;
  }
  if (!cmd) {
    const evidencePath = writeEvidence(evidDir, `criteria-${c.id}-r${attempt}.txt`, `FAIL: criterion has method "${method}" but no command.`);
    matrix[c.id] = { status: 'fail', evidencePath };
    continue;
  }
  // e2e runs like any command criterion — its command must be self-contained
  const r = runShell(cmd, repo, timeoutMs, isolationFor(`criteria-${c.id}-r${attempt}`));
  const evidencePath = writeEvidence(evidDir, `criteria-${c.id}-r${attempt}.txt`, formatEvidence(cmd, r));
  matrix[c.id] = { status: r.exitCode === 0 && !r.timedOut ? 'pass' : 'fail', evidencePath };
}
writeFileSync(join(evidDir, 'criteria-matrix.json'), JSON.stringify(matrix, null, 2));

const failing = Object.entries(matrix)
  .filter(([, e]) => e.status === 'fail')
  .map(([id]) => id);
if (failing.length > 0) {
  const strikes = bumpTally('verifyFix');
  if (strikes > cap) {
    console.log(`criteria still failing after ${cap} fix attempts: ${failing.join(', ')}`);
    process.exit(2);
  }
  const sections = failing.map(
    (id) => `### criterion ${id} FAILED\n\n${truncateForPrompt(readFileSync(matrix[id].evidencePath, 'utf8'), matrix[id].evidencePath)}`,
  );
  console.log(`Criteria failed — raw evidence below\n${sections.join('\n\n')}`);
  process.exit(1);
}
const manual = Object.entries(matrix).filter(([, e]) => e.status === 'manual').map(([id]) => id);
const adjudicated = Object.entries(matrix).filter(([, e]) => e.status === 'adjudicated').map(([id]) => id);
console.log(
  `verify: criteria green — ${Object.keys(matrix).length - manual.length - adjudicated.length} pass` +
    `${adjudicated.length > 0 ? `, ${adjudicated.length} adjudicated (recorded human decision: ${adjudicated.join(', ')})` : ''}` +
    `${manual.length > 0 ? `, ${manual.length} manual (human check before merge: ${manual.join(', ')})` : ''}`,
);
process.exit(0);
