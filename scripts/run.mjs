#!/usr/bin/env node
// run — the ben sequencer.
// Zero dependencies. Node only.
//
// Code owns sequencing; the referee scripts own truth and policy. This script
// derives the task's position from durable state, invokes the referees with
// arguments computed from that state (never model-supplied), performs the
// mechanical file operations the method used to assign to the model (snapshots,
// approval authorship, baselines, round numbers), records every human decision
// as a hash-bound idempotent record, and STOPs on anything unknown, ambiguous
// or inconsistent. It judges nothing the referees judge, repairs nothing,
// retries nothing the referees do not retry, and never touches the network.
//
// Usage (S is always <repo>/.ben; --repo defaults to cwd):
//   run.mjs init            [--repo p] [--title t] [--greenfield] [--e2e-paths a,b]
//                           [--plan-rounds N] [--diff-rounds N] [--gate-fixes N]
//                           [--verify-fixes N] [--timeout ms]
//                           [--plan-rounds-max N] [--diff-rounds-max N]
//                           (hard review caps — the operator's safety boundary
//                           for convergence-aware continuation; default 3× the
//                           soft budgets, must be >= them; adopt takes the same)
//   run.mjs next            [--repo p]
//   run.mjs status          [--repo p]                  read-only, never mutates
//   run.mjs adopt           [--repo p] --base <sha> --by <user> [--title t] [--confirm]
//   run.mjs record-veto     [--repo p] --response <file>
//   run.mjs record-approval [--repo p] --by <user> --decision APPROVE|RECONCILE|ABORT
//   run.mjs record-grant    [--repo p] --kind plan|diff --rounds N --by <user>
//   run.mjs record-pr       [--repo p] --url <url>
//   run.mjs record-pr-retry [--repo p] --by <user>
//   run.mjs record-pr-remote   [--repo p] --status absent|exists [--url u] --intent-hash <h> --by <user>
//   run.mjs record-pr-unusable [--repo p] --intent-hash <hash> --by <user>
//
// record-pr-remote (migration): resolves a pending PR intent whose
// approval is no longer current — the human's durable observation of the remote
// (absent → archive intent and migrate; exists → archive intent, record a
// non-terminal observedPr, migrate). record-pr-unusable: the later disposition
// of an observedPr whose head no longer matches the freshly reviewed HEAD —
// lookup-first by --intent-hash (replay after the write is a no-op), one atomic
// append+clear. Ordinary current-approval PR behavior is untouched.
//
// Exit codes: 0 advanced / instruction printed / done · 1 a referee said fix (its
// output relayed verbatim) or a record is structurally wrong · 2 human gate or
// STOP (inconsistent/unknown state, both facts printed) · 3 usage/IO error.
//
// Test seam: BEN_RUN_PAUSE_AT=<boundary> makes the process block at that
// named durable boundary so a test can SIGKILL it there. Unset, the seam is a
// single strict equality check per boundary and has zero behavioral effect.

import { readGuidance } from './guidance.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  APPROVAL_FILES,
  readReviewOutput,
  approvalHashesFor,
  approvalRelevantLedgerSha,
  approvalStateFor,
  assertAdjudicationActAllowed,
  assignmentIssues,
  FIX_GRANT_STEPS,
  PR_INSPECTION_FAILURE_MAX,
  prTitleFor,
  gateIdFor,
  higherPrecedenceIssue,
  INSPECTION_BRANCH,
  INSPECTION_PR,
  inspectionSha,
  latestInspection,
  LIMIT_KINDS,
  openLimitEvent,
  openSupervisorStop,
  stableStringify,
  canonicalBody,
  canonicalConfig,
  classifyRecords,
  criterionShaOf,
  deriveAdjudication,
  ledgerStampMatches,
  readLedgerStrict,
  recordDigest,
  renderPrBody,
  roundsGatesIssues,
  SEQUENCER_VERSION,
  validateAdjudicationRecord,
  validSequencerTask,
  WAITING_CORE_FILES,
  WAITING_JSON,
  WAITING_MD,
  waitingGitIdentity,
  waitingInputsDigest,
  waitingState,
} from './adjudication.lib.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const RESOLUTION_ACTIONS = ['resolved', 'rejected', 'deferred'];

function fail(msg) {
  setResult({ outcome: 'usage-error', error: msg });
  console.error(`run: ${msg}`);
  process.exit(3);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isBlank(v) {
  return typeof v !== 'string' || v.trim().length === 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

// ---------------------------------------------------------------------------
// test seam: inert unless BEN_RUN_PAUSE_AT names this exact boundary
function pauseAt(boundary) {
  if (process.env.BEN_RUN_PAUSE_AT !== boundary) return;
  // announce readiness, then block until killed (or 60s safety valve)
  writeFileSync(join(S, `.paused-${boundary.replaceAll(':', '_')}`), String(process.pid));
  const gate = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 600; i++) Atomics.wait(gate, 0, 0, 100);
}

// ---------------------------------------------------------------------------
// small IO helpers — atomic writes, checked reads, append-only records

function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Read+parse JSON; a missing file returns undefined; malformed → STOP. */
function readJson(path, what) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    stop(`${what} is unreadable JSON: ${err instanceof Error ? err.message : String(err)}`, `file: ${path}`);
  }
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** Append-only JSONL record; torn trailing lines are detected at read time. */
function appendJsonl(path, entry) {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

function readVetoLog() {
  const path = join(S, 'veto.jsonl');
  const entries = [];
  for (const line of readLines(path)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      stop('veto.jsonl has a torn or malformed trailing line — the veto log is authoritative', `file: ${path}\nline: ${line.slice(0, 200)}`);
    }
  }
  return entries;
}

function log(event) {
  try {
    appendFileSync(join(S, 'run.log'), `${new Date().toISOString()} ${event}\n`);
  } catch {
    /* run.log is non-authoritative — never fail on it */
  }
}

// ---------------------------------------------------------------------------
// The sequencer-owned result contract. NON-authoritative: `next --json` writes
// .ben/last-next.json at process exit describing the ONE outcome this
// invocation reached. Every exit site in cmdNext sets it through the helpers
// below; the runner consumes it and re-derives anything external from
// durable task state, never from this file. Written only under --json.

let RESULT; // { outcome, kind?, owner?, gateId?, projection?, instruction?, publication? }
let CURRENT_TASK; // the loaded task, so publishWaiting can mint the authoritative gate record
let JSON_RESULT = false;
function setResult(r) {
  RESULT = { ...(RESULT ?? {}), ...r };
}
process.on('exit', (code) => {
  if (!JSON_RESULT) return;
  try {
    const outcome = RESULT?.outcome ?? (code === 3 ? 'usage-error' : code === 2 ? 'park' : code === 1 ? 'instruction' : 'reenter');
    atomicWriteJson(join(S, 'last-next.json'), {
      ...(RESULT ?? {}),
      outcome,
      exit: code,
      invocation: process.env.BEN_NEXT_INVOCATION ?? null,
      pid: process.pid,
      at: new Date().toISOString(),
    });
  } catch {
    /* non-authoritative — never fail the exit on it */
  }
});

/** A model-work exit (a referee said fix, or an artifact is structurally wrong): exit 1, outcome instruction. */
function modelWork(text, guidance) {
  if (PARKING) clearWaiting();
  setResult({ outcome: 'instruction', instruction: text, guidance });
  console.log(`Guidance: ${readGuidance(dirname(SCRIPTS), guidance).path}`);
  console.log(text);
  process.exit(1);
}

/** A "re-run next" exit: state advanced mechanically, nothing is owed to anyone. */
function reenter(text) {
  if (PARKING) clearWaiting();
  setResult({ outcome: 'reenter', instruction: text });
  console.log(text);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// the waiting projection.
// A rendered, NON-authoritative operator artifact: published only from within
// cmdNext's locked human exits (PARKING true), cleared before every non-waiting
// outcome commits and by a successful `answer`. Liveness is always the shared
// oracle's call (waitingState) — nothing ever consumes the projection as truth.

let PARKING = false; // set true in cmdNext after the lock is held; nowhere else

// every printed answer line carries the gate id (substituted by
// publishWaiting once the id is minted). Runner-assigned tasks print the
// operator surface (`runner.mjs resume`); others the sequencer's own answer.
function answerCmd(tokens, extra = '') {
  const choose = tokens.map((t) => `--choose ${t}`).join(' ');
  if (isObj(CURRENT_TASK?.assignment)) {
    return `node ${shq(join(SCRIPTS, 'runner.mjs'))} resume --repo ${shq(REPO)} --gate {{GATE}} ${choose}${extra}`;
  }
  return `node ${shq(join(SCRIPTS, 'run.mjs'))} answer --repo ${shq(REPO)} --expect-gate {{GATE}} ${choose}${extra} --by <you>`;
}

/** Publish waiting.json + WAITING.md. Failures never break a gate (logged
 * only). Inputs-bound kinds (fix-cap, stop, non-slot review-stop) are bound
 * to the CODE-OWNED state manifest plus the git identity — never to a
 * caller-supplied file list. */
function publishWaiting(meta) {
  if (!PARKING) return;
  try {
    let binding = meta.binding ?? {};
    // model-stop is inputs-bound too — the oracle requires
    // the digest for it (classifyWaiting), so a dirty-worktree park without one
    // was never current and the Stop hook silently released ben's follow-up
    const inputsBound = meta.kind === 'fix-cap' || meta.kind === 'stop' || meta.kind === 'model-stop' || (meta.kind === 'review-stop' && !isObj(binding.slot));
    if (inputsBound) binding = { ...binding, ...waitingGitIdentity(REPO) };
    // the AUTHORITATIVE gate record lives in task.json (seq,
    // id, kind, binding) — minted here, under the single writer lock, BEFORE
    // the inputs digest is taken (task.json is a digest member) and before
    // the projection exists; the projection only displays the id. A task
    // without an assignmentId (legacy) mints none: its options keep the
    // placeholder-free legacy form.
    let gateId;
    if (CURRENT_TASK !== undefined && typeof CURRENT_TASK.assignmentId === 'string') {
      const seq = (isObj(CURRENT_TASK.gate) ? CURRENT_TASK.gate.seq : 0) + 1;
      gateId = gateIdFor(CURRENT_TASK.assignmentId, seq, meta.kind, binding);
      CURRENT_TASK.gate = { seq, id: gateId, kind: meta.kind, binding, at: new Date().toISOString() };
      saveTask(CURRENT_TASK);
    }
    const inputsDigest = inputsBound ? waitingInputsDigest(S, WAITING_CORE_FILES) : undefined;
    const options = (meta.options ?? []).map((o) => ({ ...o, command: String(o.command).replaceAll('{{GATE}}', gateId ?? '<gate>') }));
    const w = {
      kind: meta.kind,
      owner: meta.owner,
      question: meta.question,
      why: meta.why ?? '',
      options,
      binding,
      ...(inputsDigest !== undefined ? { inputsDigest } : {}),
      ...(gateId !== undefined ? { gateId } : {}),
      ...(meta.notes ? { notes: meta.notes } : {}),
      packet: meta.packet,
      at: new Date().toISOString(),
    };
    setResult({ outcome: 'park', kind: w.kind, owner: w.owner, question: w.question, gateId: gateId ?? null, options: options.map((o) => o.token ?? null), projection: 'ok' });
    atomicWriteJson(join(S, WAITING_JSON), w);
    pauseAt('between-projection-files');
    writeFileSync(join(S, WAITING_MD), renderWaitingMd(w, sha256File(join(S, WAITING_JSON))));
    log(`waiting projection published (${w.kind}, owner ${w.owner}${gateId ? `, gate ${gateId}` : ''})`);
  } catch (err) {
    setResult({ outcome: 'park', kind: meta.kind, owner: meta.owner, question: meta.question, projection: 'failed' });
    log(`waiting projection publish failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Delete the projection pair — called before a non-waiting outcome commits. */
function clearWaiting() {
  pauseAt('before-projection-clear');
  for (const n of [WAITING_JSON, WAITING_MD]) {
    try {
      unlinkSync(join(S, n));
    } catch {
      /* already absent */
    }
  }
}

/** The operator brief — deterministic per-kind template, business language first, verbatim packet always attached. */
function renderWaitingMd(w, jsonSha) {
  const safeToLeave =
    w.owner === 'human'
      ? '**Yes.** Nothing proceeds until you answer. Answering later is safe: if the situation changes first, your answer is refused with an explanation — it is never misapplied.'
      : w.owner === 'model'
        ? "**Yes.** This stop is ben's own follow-up work, not your decision — start a ben session in this repo (or run `run.mjs next`) and ben continues; you will only be asked for decisions that are genuinely yours."
        : '**Yes.** ben hit an internal inconsistency it will not guess about. Nothing proceeds and nothing is lost; this needs an engineering session (the recovery playbook in references/recovery.md), not a one-word answer.';
  const options =
    w.options.length > 0
      ? w.options.map((o, i) => `${i + 1}. **${o.label}** — ${o.effect}\n   \`${o.command}\``).join('\n')
      : '_This question has no one-word answers — see the note below._';
  return [
    '# ben is waiting on you',
    '',
    `> This note may be superseded — \`run.mjs status\` shows freshness. Answers are always validated against live state and refused if out of date, so acting on an old note cannot misapply anything.`,
    '',
    '## What stopped',
    '',
    w.question,
    '',
    '## Why it needs you',
    '',
    w.why || '(see the full packet below)',
    '',
    '## Your decision',
    '',
    options,
    ...(w.notes ? ['', w.notes] : []),
    '',
    '## What happens after you answer',
    '',
    'Your answer is recorded durably and exactly once. ben resumes from it with `run.mjs next` (or a ben session in this repo) — completed work is never redone, and this question will not be asked again once validly answered.',
    '',
    '## Safe to leave?',
    '',
    safeToLeave,
    '',
    '## Full packet, verbatim',
    '',
    '```',
    w.packet,
    '```',
    '',
    `<!-- waiting.json sha256: ${jsonSha} -->`,
    '',
  ].join('\n');
}

/** STOP: exit 2 with every known fact. Never guesses, never repairs. Inside
 * cmdNext's locked context this is a playbook park (meta can override). */
function stop(what, facts = '', meta = undefined) {
  const guidance = meta?.owner === 'model' ? 'verification' : 'recovery';
  const text = `run: STOP — ${what}${facts ? `\n${facts}` : ''}\nNothing was changed. Guidance: ${readGuidance(dirname(SCRIPTS), guidance).path}${meta?.owner === 'model' ? '; perform the model-owned repair.' : '; resume with a human decision.'}`;
  // a lock-contention outcome already set by acquireLock is never downgraded to a park
  if (RESULT?.outcome !== 'contention') setResult({ outcome: 'park', kind: meta?.kind ?? 'stop', owner: meta?.owner ?? 'playbook', question: meta?.question ?? what, stop: what, guidance });
  publishWaiting({
    kind: 'stop',
    owner: 'playbook',
    question: 'ben stopped on an internal inconsistency it will not guess about.',
    why: 'Repairs follow the recovery playbook and are recorded human acts — this needs an engineering session, not a one-word answer.',
    options: [],
    ...meta,
    packet: text,
  });
  console.log(text);
  process.exit(2);
}

/** A human gate: exit 2 with the complete packet, verbatim, before options. */
function gate(packet, meta = undefined) {
  setResult({ outcome: 'park', kind: meta?.kind ?? 'stop', owner: meta?.owner ?? 'playbook', question: meta?.question ?? '' });
  if (meta) publishWaiting({ ...meta, packet: meta.packet ?? packet });
  console.log(packet);
  process.exit(2);
}

/** A creative step the sequencer cannot perform: print exactly one instruction. */
function instruct(text, guidance) {
  if (PARKING) clearWaiting(); // model work is a non-waiting outcome
  setResult({ outcome: RESULT?.outcome === 'publish' ? 'publish' : 'instruction', instruction: text, guidance });
  console.log(`Guidance: ${readGuidance(dirname(SCRIPTS), guidance).path}`);
  console.log(`run: NEXT STEP (yours)\n${text}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// git — every fact read fresh, never cached

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.allowFail) fail(`git ${args.join(' ')} failed in ${REPO}: ${(r.stderr ?? '').trim()}`);
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim() };
}

const headSha = () => git(['rev-parse', 'HEAD']).out;
const currentBranch = () => git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
const rootCommit = () => git(['rev-list', '--max-parents=0', 'HEAD']).out.split('\n')[0];
const worktreeStatus = () => git(['status', '--porcelain']).out;
const worktreeHash = () => sha256(`${worktreeStatus()}\n${git(['diff', 'HEAD']).out}`);

// ---------------------------------------------------------------------------
// referees — spawned with computed arguments; output relayed verbatim

function referee(script, args) {
  const r = spawnSync('node', [join(SCRIPTS, script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) fail(`${script} failed to spawn: ${r.error.message}`);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  return { exitCode: r.status ?? 1, output };
}

/** Relay a referee's non-zero verdict verbatim with its own exit semantics.
 * Exit 2 is a human escalation: `meta` parks it (captured output in the packet);
 * exit 1 is model work — a non-waiting outcome that clears any parked note. */
function relay(name, res, meta, guidance) {
  const text = `run: ${name} exited ${res.exitCode} — its output, verbatim:\n${res.output}`;
  if (res.exitCode === 2) {
    setResult({ outcome: 'park', kind: meta?.kind ?? 'stop', owner: meta?.owner ?? 'playbook', question: meta?.question ?? text });
    if (meta) publishWaiting({ ...meta, packet: text });
  } else {
    if (PARKING) clearWaiting();
    setResult({ outcome: 'instruction', instruction: text, guidance });
    console.log(`Guidance: ${readGuidance(dirname(SCRIPTS), guidance).path}`);
  }
  console.log(text);
  process.exit(res.exitCode === 2 ? 2 : 1);
}

// ---------------------------------------------------------------------------
// argument parsing and the lock

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      title: { type: 'string' },
      greenfield: { type: 'boolean', default: false },
      'e2e-paths': { type: 'string', default: '' },
      'plan-rounds': { type: 'string', default: '3' },
      'diff-rounds': { type: 'string', default: '3' },
      'plan-rounds-max': { type: 'string' },
      'diff-rounds-max': { type: 'string' },
      'gate-fixes': { type: 'string', default: '2' },
      'verify-fixes': { type: 'string', default: '2' },
      timeout: { type: 'string', default: '600000' },
      base: { type: 'string' },
      by: { type: 'string' },
      confirm: { type: 'boolean', default: false },
      rebind: { type: 'boolean', default: false },
      response: { type: 'string' },
      decision: { type: 'string' },
      kind: { type: 'string' },
      rounds: { type: 'string' },
      url: { type: 'string' },
      status: { type: 'string' },
      'intent-hash': { type: 'string' },
      criterion: { type: 'string' },
      'remote-observation': { type: 'string' },
      choose: { type: 'string', multiple: true },
      note: { type: 'string' },
//
      json: { type: 'boolean', default: false },
      'expect-gate': { type: 'string' },
      assignment: { type: 'string' },
      reply: { type: 'string' },
      'reply-file': { type: 'string' },
      usd: { type: 'string' },
      hours: { type: 'string' },
      stretches: { type: 'string' },
      residual: { type: 'string' },
      branch: { type: 'string' },
      pr: { type: 'string' },
      'pr-head': { type: 'string' },
      reason: { type: 'string' },
      value: { type: 'string' },
      failure: { type: 'string' },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;

const COMMANDS = [
  'init',
  'next',
  'status',
  'adopt',
  'record-veto',
  'record-approval',
  'record-grant',
  'record-pr',
  'record-pr-retry',
  'record-pr-remote',
  'record-pr-unusable',
  'record-adjudication',
  'check-pr-body',
  'record-publication',
  'answer',
//
  'record-pr-inspection',
  'record-supervisor-stop',
  'record-limit',
];
const command = positionals[0];
if (!COMMANDS.includes(command)) fail(`first argument must be one of: ${COMMANDS.join(', ')}`);

const REPO = resolvePath(values.repo ?? '.');
if (!existsSync(join(REPO, '.git'))) fail(`${REPO} is not a git repository`);
const S = join(REPO, '.ben'); // always <repo>/.ben — the Stop hook reads the same place

const TASK_PATH = join(S, 'task.json');
const LOCK_PATH = join(S, '.run-lock');
const RUNNER_LOCK_PATH = join(S, 'runner.lock');
JSON_RESULT = values.json === true && command === 'next'; // only `next` writes the handoff file — status never writes

/** a live runner owns `next`; an interactive session must stop it first. */
function requireNoForeignRunner() {
  if (!existsSync(RUNNER_LOCK_PATH)) return;
  let holder;
  try {
    holder = readFileSync(RUNNER_LOCK_PATH, 'utf8').trim();
  } catch {
    return;
  }
  const pid = Number(holder);
  if (!Number.isInteger(pid) || pid < 1) return;
  if (String(pid) === String(process.env.BEN_RUNNER_PID ?? '')) return;
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    alive = err?.code === 'EPERM';
  }
  if (!alive) return; // a dead runner's lock is the runner's own stale-lock case, not contention
  setResult({ outcome: 'contention', holder: 'runner', pid });
  console.log(`run: STOP — a ben runner (pid ${pid}) owns this task's loop (${RUNNER_LOCK_PATH}). Stop the runner before driving next interactively; nothing was changed.`);
  process.exit(2);
}

function acquireLock() {
  mkdirSync(S, { recursive: true }); // the lock lives inside $S
  let fd;
  try {
    fd = openSync(LOCK_PATH, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let holder = '(unreadable)';
      try {
        holder = readFileSync(LOCK_PATH, 'utf8').trim();
      } catch {
        /* reported as unreadable */
      }
      setResult({ outcome: 'contention', holder: 'run-lock', holderPid: Number(holder) || null });
      stop('another run.mjs invocation holds the lock (single-writer rule)', `lock: ${LOCK_PATH}\nholder pid: ${holder}\nIf that process is dead, a human deletes the lock file per the playbook — the sequencer never steals it.`);
    }
    throw err;
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  process.on('exit', () => {
    try {
      // release only our own lock — never a replacement written by someone else
      if (readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  });
}

// ---------------------------------------------------------------------------
// task.json — the only run.mjs-owned durable state (no phase, no success caches)

// the ONE semantic task-shape authority is the shared lib (validSequencerTask):
// the standalone adjudication referees consume the same definition — no weaker entry point
const validTask = validSequencerTask;
function loadTask() {
  const t = readJson(TASK_PATH, 'task.json');
  if (t === undefined) return undefined;
  if (!validTask(t)) stop('task.json does not match the sequencer schema', `file: ${TASK_PATH}\ncontent: ${JSON.stringify(t)}`);
  return t;
}

function saveTask(t) {
  pauseAt('before-task-write');
  atomicWriteJson(TASK_PATH, t);
}

// ---------------------------------------------------------------------------
// shared state readers

// six-member REVIEW/STALENESS identity: five plan artifacts + the
// canonical verdict-relevant config. The three ORIGINAL members' snapshots are
// required for a round to be anything but revised; the three NEW members
// (plan-files, gates, config) distinguish a legacy round (snapshot absent →
// historical only, never qualifying) from a revision (snapshot mismatch).
const artifactNames = ['plan.md', 'criteria.json', 'promises.json', 'plan-files.json', 'gates.json'];
const snapshotName = {
  'plan.md': 'plan.reviewed.md',
  'criteria.json': 'criteria.reviewed.json',
  'promises.json': 'promises.reviewed.json',
  'plan-files.json': 'plan-files.reviewed.json',
  'gates.json': 'gates.reviewed.json',
};
const ORIGINAL_MEMBERS = ['plan.md', 'criteria.json', 'promises.json'];
const CONFIG_SNAPSHOT = 'config.reviewed.json';

// APPROVAL_FILES and canonicalConfig live in the shared lib (one
// implementation for the sequencer AND the standalone referees).

/**
 * Three-way review-context classifier:
 *  'current'          — all six members snapshotted and matching: the verdict stands.
 *  'legacy-incomplete'— every existing snapshot matches, but a NEW member's
 *                       snapshot is absent: the recorded review judged incomplete
 *                       context — historical only; one fresh full-context round.
 *  'revised'          — any existing snapshot mismatches, or an ORIGINAL member's
 *                       snapshot is missing: existing revision semantics.
 */
function planReviewState(task) {
  let legacyIncomplete = false;
  for (const n of artifactNames) {
    const snap = join(S, snapshotName[n]);
    if (!existsSync(snap)) {
      if (ORIGINAL_MEMBERS.includes(n)) return 'revised';
      legacyIncomplete = true;
      continue;
    }
    const current = join(S, n);
    if (!existsSync(current) || readFileSync(current, 'utf8') !== readFileSync(snap, 'utf8')) return 'revised';
  }
  const configSnap = join(S, CONFIG_SNAPSHOT);
  if (!existsSync(configSnap)) legacyIncomplete = true;
  else if (readFileSync(configSnap, 'utf8') !== canonicalConfig(task)) return 'revised';
  return legacyIncomplete ? 'legacy-incomplete' : 'current';
}

/** Write the full six-member snapshot set — the fresh round's exact basis. */
function writeReviewSnapshots(task) {
  for (const n of artifactNames) writeFileSync(join(S, snapshotName[n]), readFileSync(join(S, n)));
  writeFileSync(join(S, CONFIG_SNAPSHOT), canonicalConfig(task));
}

function readRounds() {
  const r = readJson(join(S, 'rounds.json'), 'rounds.json');
  if (r === undefined) return {};
  if (!isObj(r)) stop('rounds.json is not an object', `file: ${join(S, 'rounds.json')}`);
  return r;
}

function readLedger() {
  const path = join(S, 'ledger.jsonl');
  // the ONE consumption boundary — the shared strict reader: strict
  // framing (LF only, no blank lines, terminated final record, valid JSON)
  // plus complete wrapper validation of every inert audit row. Illegal bytes
  // are never silently normalized into legal history.
  try {
    return readLedgerStrict(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stop(
      msg.includes('audit-record schema')
        ? `ledger.jsonl holds an invalid audit row — ${msg}`
        : `ledger.jsonl is not legal authoritative history — ${msg}`,
      `file: ${path}`,
    );
  }
}

function renderLedger(entries) {
  if (entries.length === 0) return '(empty)';
  return entries
    .map((e) => `[${e.kind} round ${e.round}] ${e.action} ${e.fingerprint || '-'} (${e.reviewer}${e.blockerId ? `/${e.blockerId}` : ''}): ${e.detail}`)
    .join('\n');
}

/** The kind (plan|diff) of the open blockers, derivable only from the ledger tail. */
function openBlockersKind(ledger) {
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].action === 'raised') return ledger[i].kind;
  }
  return undefined;
}

// thin wrappers over the shared-lib approval identity (one implementation for
// run.mjs and the standalone referees — no drift possible)
function approvalHashes(task) {
  return approvalHashesFor(S, task);
}

/** Valid, current approval = every bound hash matches the on-disk bytes now. */
function approvalState(task) {
  try {
    return approvalStateFor(S, task);
  } catch (err) {
    stop(err instanceof Error ? err.message : String(err), `file: ${join(S, 'approval.json')}`);
  }
}

// ---------------------------------------------------------------------------
// manual-criterion adjudication — the
// governing state is a pure computation over the act register, derived fresh
// at every consumer; the ledger is the history authority.

/** Derive register + governing + digest; malformed/tampered/conflicting/divergent state STOPs. */
function adjudicationSnapshot() {
  const criteriaDoc = readJson(join(S, 'criteria.json'), 'criteria.json');
  const approvalPath = join(S, 'approval.json');
  try {
    return {
      criteriaDoc,
      ...deriveAdjudication({
        stateDir: S,
        ledgerEntries: readLedger(),
        criteriaDoc,
        approvalBytes: existsSync(approvalPath) ? readFileSync(approvalPath) : undefined,
        getHeadSha: () => headSha(),
      }),
    };
  } catch (err) {
    stop(
      `the adjudication state is invalid: ${err instanceof Error ? err.message : String(err)}`,
      `state: ${join(S, 'adjudications.json')} and ledger.jsonl\nThe register and the ledger are reconciled by a human per the playbook — never repaired here.`,
    );
  }
}

/** The manual criteria with no governing adjudication record. */
function pendingManualCriteria(snapshot) {
  const criteria = isObj(snapshot.criteriaDoc) && Array.isArray(snapshot.criteriaDoc.criteria) ? snapshot.criteriaDoc.criteria : [];
  return criteria.filter((c) => isObj(c) && c?.verification?.method === 'manual' && !snapshot.governing.has(c.id));
}

/** The digest an earned review is bound to; legacy reviewBase reads 'NONE'. */
function earnedAdjudicationsSha(task) {
  return task.reviewBase?.adjudicationsSha ?? 'NONE';
}

// ---------------------------------------------------------------------------
// verify wrapper — the intent binds the referee tally

const VERIFY_TALLY_KEY = { commits: 'implement', gates: 'gateFix', criteria: 'verifyFix', scope: 'scopeFix' };

function verifyIdentity(task, step) {
  const artifactsHash =
    step === 'gates'
      ? existsSync(join(S, 'gates.json'))
        ? sha256File(join(S, 'gates.json'))
        : 'ABSENT'
      : step === 'scope'
        ? // every input that can change the scope verdict — the criteria
          // bytes AND the applicability config; a config change is a new identity
          sha256(`${sha256File(join(S, 'criteria.json'))}|${canonicalConfig(task)}`)
        : step === 'criteria'
          ? sha256File(join(S, 'criteria.json'))
          : `since:${task.base}`;
  return { step, headSha: headSha(), worktreeHash: worktreeHash(), artifactsHash };
}

function sameIdentity(a, b) {
  return a.step === b.step && a.headSha === b.headSha && a.worktreeHash === b.worktreeHash && a.artifactsHash === b.artifactsHash;
}

/** Round-stamped evidence proving the failed attempt N landed for this step. */
function failedEvidenceExists(step, attempt) {
  if (step === 'commits') return true; // commits writes no evidence; the tally delta is the durable fact
  const evid = join(S, 'evidence');
  if (!existsSync(evid)) return false;
  const prefix = step === 'gates' ? 'gate-' : step === 'scope' ? 'scope-' : 'criteria-';
  return readdirSync(evid).some((f) => f.startsWith(prefix) && f.endsWith(`-r${attempt}.txt`));
}

/**
 * Invoke a verify mode with the tally-bound intent guard. Returns only when the
 * referee reported green; every other outcome exits with the referee's words.
 */
/** the effective fix cap for a verify step = config cap + recorded fix grants for that step. */
function effectiveCap(task, step) {
  const base = step === 'commits' ? 1 : step === 'reconcile' ? 1 : step === 'gates' ? task.config.gateFixes : task.config.verifyFixes;
  if (!FIX_GRANT_STEPS.includes(step)) return base;
  return base + (task.fixGrants ?? []).filter((g) => g.step === step).length;
}

function runVerify(task, step, extraArgs) {
  const tallyKey = VERIFY_TALLY_KEY[step];
  const tallyNow = () => {
    const r = readRounds();
    return Number.isInteger(r[tallyKey]) && r[tallyKey] >= 0 ? r[tallyKey] : 0;
  };
  const identity = verifyIdentity(task, step);
  // one intent per step: resuming a chain (commits → gates → criteria) must not
  // let an earlier step's fresh intent clobber a later step's landed failure
  task.verifyIntents = isObj(task.verifyIntents) ? task.verifyIntents : {};
  const intent = task.verifyIntents[step];

  if (intent && sameIdentity(intent, identity)) {
    const t = tallyNow();
    if (t === intent.tallyBefore + 1 && failedEvidenceExists(step, t)) {
      // the failed invocation already landed — never consume a second attempt for it.
      // The referee's own escalation semantics are preserved: commits escalates on
      // the second strike (verify.mjs), gates/criteria past their fix caps.
      const cap = effectiveCap(task, step);
      const note =
        `run: verify ${step} already failed for this exact state (attempt ${t}, recorded intent) — fix the code/artifacts, which makes a new attempt. Recorded evidence is under ${join(S, 'evidence')} (round -r${t}).` +
        (step === 'commits' ? '\nNo commits since the baseline: implement the plan and COMMIT your changes (plain conventional commits) — uncommitted work never counts.' : '');
      if (t > cap) {
        const text = `${note}\nThe ${step === 'commits' ? 'strike' : 'fix'} cap is exhausted (${t} > ${cap}) — this is the human's decision now.`;
        const meta = verifyCapMeta(step, text, t);
        setResult({ outcome: 'park', kind: meta.kind, owner: meta.owner, question: meta.question });
        publishWaiting(meta);
        console.log(text);
        process.exit(2);
      }
      modelWork(note, 'verification'); // model work — fix and re-run
    }
    if (t !== intent.tallyBefore) {
      stop(
        `verify ${step}: the referee tally moved in a way the recorded intent cannot explain`,
        `intent: ${JSON.stringify(intent)}\ntally now: ${t}\nEither evidence or the tally was altered outside the sequencer.`,
      );
    }
    // t === tallyBefore: the invocation never durably landed — legal to invoke
  } else {
    task.verifyIntents[step] = { ...identity, tallyBefore: tallyNow() };
    saveTask(task);
  }
  pauseAt(`after-verify-intent:${step}`);

  const res = referee('verify.mjs', [step, S, '--repo', REPO, ...extraArgs]);
  pauseAt(`after-verify:${step}`);
  if (res.exitCode === 0) {
    delete task.verifyIntents[step]; // retired on consumed success — success itself is never cached
    saveTask(task);
    log(`verify ${step} green`);
    return res;
  }
  if (res.exitCode === 3) fail(`verify.mjs ${step} exited 3 (usage/IO): ${res.output}`);
  if (res.exitCode === 2 && step === 'commits' && tallyNow() <= effectiveCap(task, 'commits')) {
    // the referee's strike verdict stands (relayed verbatim, tally untouched); a
    // RECORDED human grant (fix-cap continue) routes exactly one more attempt
    modelWork(`run: verify.mjs commits exited 2 — its output, verbatim:\n${res.output}\nA recorded human grant allows one more attempt: implement the plan and COMMIT your changes.`, 'verification');
  }
  relay(`verify.mjs ${step}`, res, verifyCapMeta(step), 'verification'); // exits 1 or 2; the intent stays for crash-safe resume
}

/** The parked-note meta for a verify escalation (fix budget exhausted). */
function verifyCapMeta(step, packet = undefined, tallyAt = undefined) {
  const grantable = FIX_GRANT_STEPS.includes(step);
  const tally = tallyAt ?? (() => {
    const r = readRounds();
    const k = VERIFY_TALLY_KEY[step];
    return Number.isInteger(r[k]) && r[k] >= 0 ? r[k] : 0;
  })();
  return {
    kind: 'fix-cap',
    owner: 'human',
    question: `ben used all its allowed attempts to get "${step}" green — this needs your judgment.`,
    why: grantable
      ? 'The fix budget is a safety cap; only you extend it (one more attempt per answer) or stop the task.'
      : 'The fix budget is a safety cap; going past it needs an engineering session or your decision to stop.',
    options: [
      ...(grantable ? [{ token: 'continue', label: 'Allow one more fix attempt', effect: `ben gets exactly one more attempt at "${step}" (recorded); it parks again if that fails too`, command: answerCmd(['continue']) }] : []),
      { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
    ],
    binding: { step, tallyAt: tally },
    ...(packet !== undefined ? { packet } : {}),
  };
}

// ---------------------------------------------------------------------------
// reconcile flow — proposal before veto before resolutions before referees

function readProposal(blockers) {
  const path = join(S, 'proposal.json');
  const proposal = readJson(path, 'proposal.json');
  if (proposal === undefined) return { missing: true };
  const problems = [];
  if (!Array.isArray(proposal)) {
    problems.push('proposal.json must be an array of { fingerprint, action, detail }');
    return { problems };
  }
  proposal.forEach((p, i) => {
    if (!isObj(p)) return problems.push(`proposal[${i}]: expected an object`);
    if (isBlank(p.fingerprint)) problems.push(`proposal[${i}].fingerprint: expected a non-empty string`);
    if (!RESOLUTION_ACTIONS.includes(p.action)) problems.push(`proposal[${i}].action: expected one of ${RESOLUTION_ACTIONS.join(' | ')}`);
    if (isBlank(p.detail)) problems.push(`proposal[${i}].detail: expected substantive text, not blank`);
  });
  const open = new Set(blockers.map((b) => b.fingerprint));
  const proposed = proposal.filter(isObj).map((p) => p.fingerprint);
  for (const fp of open) if (!proposed.includes(fp)) problems.push(`open blocker ${fp} has no proposed disposition`);
  for (const fp of proposed) if (fp && !open.has(fp)) problems.push(`proposal addresses ${fp}, which is not an open blocker`);
  if (new Set(proposed).size !== proposed.length) problems.push('duplicate fingerprints in the proposal');
  return problems.length > 0 ? { problems } : { proposal };
}

// veto.jsonl holds two record types: 'presented' (the gate was actually put in
// front of the human, appended by next) and 'decision' (the human's recorded
// answer). Both are bound to kind + round + exact bytes, so an old decision can
// never be replayed against a byte-identical set in a later round.
function findVetoRecord(type, kind, round, blockersSha, proposalSha) {
  return readVetoLog().find(
    (v) => (v.type ?? 'decision') === type && v.kind === kind && v.round === round && v.blockersSha === blockersSha && v.proposalSha === proposalSha,
  );
}

/**
 * D3 — the six checks, evaluated on the ACTUAL representations: the
 * blockers.json entries' flag arrays AND the ledger's raised rows for this
 * round, the validated proposal, rounds.gates, abstain rows, the ledger tail.
 * Returns {applies:true} or {applies:false, reason}. Never throws on shape
 * problems: any doubt is a reason (the human gate stands).
 */
function emptyVetoApplies(task, kind, round, blockers, proposal, rounds, ledger) {
  const no = (reason) => ({ applies: false, reason });
  if (!Array.isArray(blockers) || blockers.length === 0) return no('no open blockers');
  if (!Array.isArray(proposal) || proposal.length === 0) return no('no proposal');
  const open = new Set(blockers.map((b) => b?.fingerprint));
  const proposed = new Set(proposal.map((p) => p.fingerprint));
  if (open.size !== blockers.length || proposed.size !== proposal.length) return no('duplicate fingerprints');
  if (open.size !== proposed.size || [...open].some((fp) => !proposed.has(fp))) return no('the proposal does not cover exactly the open set');
  if (proposal.some((p) => p.action !== 'resolved')) return no('a disposition is not "resolved"');
  for (const b of blockers) {
    if (!isObj(b)) return no('malformed blocker');
    // flags must be ABSENT or well-formed empty arrays; anything else (a
    // string, an object, a non-empty array) keeps the human gate
    for (const k of ['priorRejections', 'respondsTo']) {
      if (b[k] !== undefined && !Array.isArray(b[k])) return no(`blocker ${b.fingerprint} carries a malformed ${k}`);
      if (Array.isArray(b[k]) && b[k].length > 0) return no(`blocker ${b.fingerprint} carries ${k}`);
    }
    if (typeof b.detail === 'string' && /\[(prior rejection\(s\)|contests):/.test(b.detail)) return no(`blocker ${b.fingerprint} is flagged`);
  }
  if (isObj(rounds.gates) && rounds.gates[kind] !== undefined) return no('a review stop stands for this kind');
  const roundRows = ledger.filter((e) => e.kind === kind && e.round === round);
  if (roundRows.some((e) => e.action === 'abstain')) return no('a reviewer abstained this round');
  const raisedRows = roundRows.filter((e) => e.action === 'raised');
  for (const e of raisedRows) {
    if (typeof e.detail === 'string' && /\[(prior rejection\(s\)|contests):/.test(e.detail)) return no('a raised row is flagged');
    // the ledger row's own flag arrays (when present) must agree: absent or empty
    for (const k of ['priorRejections', 'respondsTo']) {
      if (e[k] !== undefined && (!Array.isArray(e[k]) || e[k].length > 0)) return no(`raised row ${e.fingerprint} carries ${k}`);
    }
  }
  const raisedFps = new Set(raisedRows.map((e) => e.fingerprint));
  if (raisedFps.size !== open.size || [...open].some((fp) => !raisedFps.has(fp))) return no("the round's raised set is not the open set");
  // the ledger tail for this kind must be exactly this round's raised set
  const kindRows = ledger.filter((e) => e.kind === kind);
  const tail = kindRows.slice(kindRows.length - raisedRows.length);
  if (tail.length !== raisedRows.length || tail.some((e) => e.action !== 'raised' || e.round !== round)) return no('the ledger tail for this kind is not this round\'s raised set');
  // the veto packet presents blockers, proposal and ledger — never a manual-
  // criterion decision (structural; asserted, not assumed)
  const packetPresentsManual = false;
  if (packetPresentsManual) return no('the packet would present a manual-criterion decision');
  return { applies: true };
}

function reconcileFlow(task, kind, blockers, rounds, ledger) {
  // durable exit-2 disposition: a policy/cap gate recorded by ledger.mjs
  // (rounds.gates, one slot per kind) outlives any crash between adjudication
  // and presentation — reconciliation is unreachable while this kind's record
  // stands; only a recorded human act (grant / playbook recovery / ABANDON)
  // clears it. The shared exact-shape validator runs before any consumption.
  const gateIssues = roundsGatesIssues(rounds);
  if (gateIssues.length > 0) {
    stop('rounds.gates is malformed', `${gateIssues.join('\n')}\nA human reconciles per the playbook.`);
  }
  const standingGate = isObj(rounds.gates) ? rounds.gates[kind] : undefined;
  if (standingGate !== undefined) {
    gate(
      `run: HUMAN GATE — ${kind} review stopped (recorded at round ${standingGate.round}):\n${standingGate.reason}\n\nOptions: grant rounds (run.mjs record-grant --kind ${kind} --rounds N --by <you>) / ABORT (write .ben/ABANDON.md).\n\nLedger:\n${renderLedger(ledger)}`,
      {
        kind: 'review-stop',
        owner: 'human',
        question: `The ${kind === 'plan' ? 'plan' : 'code'} review stopped at your safety limit: ${standingGate.reason}`,
        why: 'More review rounds cost time and money — the limit is your boundary, so only you extend it (or stop the task).',
        options: [
          { token: 'continue', label: 'Let ben keep reviewing', effect: 'grants one more review round (add --rounds N for more) and ben continues on its own', command: answerCmd(['continue']) },
          { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
        ],
        binding: { gateKind: kind, slot: { gateKind: kind, round: standingGate.round, reason: standingGate.reason } },
      },
    );
  }
  const round = Number.isInteger(rounds[kind]) ? rounds[kind] : 0;
  const blockersSha = sha256File(join(S, 'blockers.json'));

  const prop = readProposal(blockers);
  if (prop.missing) {
    instruct(
      `Reconcile ${kind} round ${round}: write ${join(S, 'proposal.json')} — one proposed disposition per open blocker:\n` +
        `[{ "fingerprint": "...", "action": "resolved|rejected|deferred", "detail": "why, substantively" }]\n` +
        `Open blockers:\n${JSON.stringify(blockers, null, 2)}\n` +
        `Do NOT write resolutions.json yet — the human sees the proposal first. Then run: run.mjs next`,
      'reconcile',
    );
  }
  if (prop.problems) {
    modelWork(`run: proposal.json is not a valid disposition proposal — fix it and re-run next\n- ${prop.problems.join('\n- ')}`, 'reconcile');
  }
  const proposal = prop.proposal;
  const proposalSha = sha256File(join(S, 'proposal.json'));
  const rejections = proposal.filter((p) => p.action === 'rejected');

  let veto = findVetoRecord('decision', kind, round, blockersSha, proposalSha);
  if (!veto) {
    // D3: an EMPTY veto — every disposition resolved,
    // nothing to dismiss, no contest/prior-rejection context, no standing
    // stop, no abstain, clean ledger tail — is skipped with its decision
    // record preserved in the EXISTING decision-row shape (policy actor +
    // basis). Any failed check → the human gate as today (fail-closed).
    const d3 = emptyVetoApplies(task, kind, round, blockers, proposal, rounds, ledger);
    if (d3.applies) {
      const at = new Date().toISOString();
      const row = { type: 'decision', at, kind, round, blockersSha, proposalSha, response: { decision: 'confirm' }, by: 'ben-policy:empty-veto', basis: { rule: 'D3-empty-veto', blockersSha, proposalSha } };
      if (!findVetoRecord('presented', kind, round, blockersSha, proposalSha)) {
        appendJsonl(join(S, 'veto.jsonl'), { type: 'presented', at, kind, round, blockersSha, proposalSha, by: 'ben-policy:empty-veto' });
      }
      pauseAt('before-empty-veto-append');
      appendJsonl(join(S, 'veto.jsonl'), row);
      log(`D3 empty veto confirmed by policy (${kind} round ${round})`);
      console.log(`run: reconcile ${kind} round ${round}: every disposition is "resolved" with nothing to dismiss and no contest context — the veto gate is skipped by the D3 policy (recorded in veto.jsonl as ben-policy:empty-veto).`);
      veto = row;
    } else {
      log(`D3 empty veto not applicable (${kind} round ${round}): ${d3.reason}`);
    }
  }
  if (!veto) {
    // the presentation itself is a durable fact: record-veto refuses to record a
    // decision for a gate that was never put in front of the human
    if (!findVetoRecord('presented', kind, round, blockersSha, proposalSha)) {
      appendJsonl(join(S, 'veto.jsonl'), { type: 'presented', at: new Date().toISOString(), kind, round, blockersSha, proposalSha });
    }
    pauseAt('after-presented-append');
    const byFp = new Map(blockers.map((b) => [b.fingerprint, b]));
    const vetoOptions = [
      { token: 'accept', label: "Accept ben's proposal as-is", effect: 'confirms every proposed disposition; ben applies them and continues', command: answerCmd(['accept']) },
      ...rejections.map((r, i) => ({
        token: `veto-${i + 1}`,
        label: `Veto dismissing finding ${i + 1}: ${byFp.get(r.fingerprint)?.claim ?? r.fingerprint}`,
        effect: 'this finding may NOT be dismissed — ben must address it instead (veto tokens combine; everything else stays as proposed)',
        command: answerCmd([`veto-${i + 1}`]),
      })),
      { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
    ];
    gate(
      `run: HUMAN GATE — reconcile veto (${kind} round ${round})\n\n` +
        `Open blockers, verbatim:\n${JSON.stringify(blockers, null, 2)}\n\n` +
        `Proposed dispositions, verbatim:\n${JSON.stringify(proposal, null, 2)}\n\n` +
        (rejections.length > 0
          ? `Proposed REJECTIONS (your veto applies here):\n${rejections.map((r) => `- ${r.fingerprint}: ${r.detail}`).join('\n')}\n\n`
          : `Zero rejections proposed — the method requires the model to defend that above; capitulating to every finding is a failure mode, not diligence.\n\n`) +
        `Ledger:\n${renderLedger(ledger)}\n\n` +
        `Record your decision (the model relays it verbatim):\n` +
        `  run.mjs record-veto --response <file>   with {"decision":"confirm"} or {"vetoes":["<fingerprint>", ...]}`,
      {
        kind: 'veto',
        owner: 'human',
        question: `The ${kind === 'plan' ? 'plan' : 'code'} review raised ${blockers.length} problem(s); ben proposes how to settle each${rejections.length > 0 ? ` — including dismissing ${rejections.length} of them` : ''}. Do you accept ben's proposal?`,
        why: 'ben proposes, but only you can allow a review finding to be dismissed.',
        options: vetoOptions,
        binding: { gateKind: kind, round, blockersSha, proposalSha },
      },
    );
  }

  const vetoed = new Set(veto.response.vetoes ?? []);
  const resolutions = readJson(join(S, 'resolutions.json'), 'resolutions.json');
  if (resolutions === undefined) {
    instruct(
      `The human ${vetoed.size > 0 ? `VETOED rejection of: ${[...vetoed].join(', ')}` : 'confirmed the proposal'}.\n` +
        `Write ${join(S, 'resolutions.json')} matching the approved proposal exactly (same fingerprint→action map` +
        (vetoed.size > 0 ? `, except vetoed fingerprints must NOT be "rejected"` : '') +
        `), then apply the artifact/code changes the resolved blockers demand, then run: run.mjs next`,
      'reconcile',
    );
  }

  // structural binding to the approved proposal — content judgment stays with honesty.mjs
  const problems = [];
  const resByFp = new Map(Array.isArray(resolutions) ? resolutions.filter(isObj).map((r) => [r.fingerprint, r]) : []);
  for (const p of proposal) {
    const r = resByFp.get(p.fingerprint);
    if (!r) continue; // missing coverage is honesty.mjs's call, not ours
    if (isBlank(r.detail)) problems.push(`resolution for ${p.fingerprint} has a blank detail`);
    if (vetoed.has(p.fingerprint)) {
      if (r.action === 'rejected') problems.push(`the human vetoed rejecting ${p.fingerprint}, but resolutions.json still rejects it`);
    } else if (r.action !== p.action) {
      problems.push(
        `resolution for ${p.fingerprint} is "${r.action}" but the human-approved proposal says "${p.action}" — a changed disposition needs a new proposal and a new veto gate`,
      );
    }
  }
  if (Array.isArray(resolutions)) {
    for (const r of resolutions.filter(isObj)) {
      if (r.action === 'rejected' && !proposal.some((p) => p.fingerprint === r.fingerprint && p.action === 'rejected' && !vetoed.has(r.fingerprint))) {
        problems.push(`resolutions.json rejects ${r.fingerprint}, which was never proposed as a rejection to the human`);
      }
    }
  }
  if (problems.length > 0) {
    modelWork(`run: resolutions.json does not match the human-approved proposal — fix it and re-run next\n- ${problems.join('\n- ')}`, 'reconcile');
  }

  // crash inside ledger.mjs resolve leaves resolutions in the ledger with
  // blockers.json still present — replaying resolve would duplicate append-only
  // history. Detect and STOP for the playbook; never repair, never re-append.
  const landed = ledger.filter((e) => e.kind === kind && e.round === round && RESOLUTION_ACTIONS.includes(e.action));
  if (landed.length > 0) {
    stop(
      `the ledger already holds ${landed.length} resolution(s) for ${kind} round ${round} but blockers.json still exists (crash inside ledger.mjs resolve)`,
      `ledger entries:\n${renderLedger(landed)}\nPlaybook: confirm every open fingerprint has its ledger resolution, then delete blockers.json — a human act, never the sequencer's.`,
    );
  }

  const honestyArgs = kind === 'plan' ? ['plan', S] : ['diff', S, '--before', task.reviewBase?.sha ?? '', '--repo', REPO];
  if (kind === 'diff' && isBlank(task.reviewBase?.sha)) {
    stop('reconciling a diff round but task.json has no reviewBase sha', `task.json: ${JSON.stringify(task)}`);
  }

  // tally-bound honesty intent: honesty.mjs durably bumps the reconcile-retry
  // tally on failure, so a crash between that write and our relay must not let
  // the identical retry consume a second attempt on resume
  const reconcileTally = () => {
    const r = readRounds();
    return Number.isInteger(r.reconcile) && r.reconcile >= 0 ? r.reconcile : 0;
  };
  const hIdentity = {
    kind,
    blockersSha,
    resolutionsSha: sha256File(join(S, 'resolutions.json')),
    head: kind === 'diff' ? headSha() : '',
  };
  const hIntent = task.honestyIntent;
  const hSame = hIntent && hIntent.kind === hIdentity.kind && hIntent.blockersSha === hIdentity.blockersSha && hIntent.resolutionsSha === hIdentity.resolutionsSha && hIntent.head === hIdentity.head;
  if (hSame && reconcileTally() === hIntent.reconcileBefore + 1) {
    const output = hIntent.output ?? '(honesty output lost in a crash — the recorded attempt still stands; any change to resolutions.json makes a new attempt)';
    const text = `run: honesty.mjs already rejected this exact reconcile (attempt ${reconcileTally()}) — its recorded output:\n${output}`;
    if (reconcileTally() > effectiveCap(task, 'reconcile')) {
      const meta = {
        kind: 'fix-cap',
        owner: 'human',
        question: 'ben ran out of attempts to honestly settle the review findings — this needs your judgment.',
        why: 'The honesty referee rejected the settlement repeatedly; more attempts need an engineering session or your decision to stop.',
        options: [{ token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') }],
        binding: { step: 'reconcile', tallyAt: reconcileTally() },
        packet: text,
      };
      setResult({ outcome: 'park', kind: meta.kind, owner: meta.owner, question: meta.question });
      publishWaiting(meta);
      console.log(text);
      process.exit(2);
    }
    modelWork(text, 'reconcile'); // model work — fix the resolutions and retry
  }
  if (hSame && reconcileTally() !== hIntent.reconcileBefore) {
    stop('the reconcile-retry tally moved in a way the recorded honesty intent cannot explain', `intent: ${JSON.stringify(hIntent)}\ntally now: ${reconcileTally()}`);
  }
  if (!hSame) {
    task.honestyIntent = { ...hIdentity, reconcileBefore: reconcileTally() };
    saveTask(task);
  }
  const honesty = referee('honesty.mjs', honestyArgs);
  if (honesty.exitCode !== 0) {
    if (honesty.exitCode === 3) fail(`honesty.mjs exited 3: ${honesty.output}`);
    task.honestyIntent.output = honesty.output; // durable before the relay, for crash-safe re-presentation
    saveTask(task);
    relay('honesty.mjs', honesty, {
      kind: 'fix-cap',
      owner: 'human',
      question: 'ben ran out of attempts to honestly settle the review findings — this needs your judgment.',
      why: 'The honesty referee rejected the settlement repeatedly; more attempts need an engineering session or your decision to stop.',
      options: [
        { token: 'continue', label: 'Allow one more attempt', effect: 'ben gets exactly one more attempt at settling the findings honestly (recorded)', command: answerCmd(['continue']) },
        { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
      ],
      binding: { step: 'reconcile', tallyAt: reconcileTally() },
    }, 'reconcile');
  }
  delete task.honestyIntent;
  saveTask(task);
  console.log(honesty.output);
  pauseAt('after-honesty');

  const resolve = referee('ledger.mjs', ['resolve', S, '--kind', kind]);
  if (resolve.exitCode !== 0) fail(`ledger.mjs resolve exited ${resolve.exitCode}: ${resolve.output}`);
  console.log(resolve.output);
  log(`reconcile ${kind} round ${round} recorded`);
  pauseAt('after-resolve');

  // route exactly as the referees print; proposal is spent alongside resolutions
  for (const name of ['proposal.json', 'resolutions.json']) {
    try {
      unlinkSync(join(S, name));
    } catch {
      /* already consumed */
    }
  }
  if (kind === 'plan') {
    console.log('run: revised plan returns to review — continuing.');
    return; // the caller's loop re-derives: pregate → snapshot → next round
  }
  if (headSha() !== task.reviewBase.sha) {
    delete task.reviewBase; // HEAD moved: changed code must re-pass gates before review (invariant #4)
    saveTask(task);
    console.log('run: HEAD moved during diff reconcile — changed code returns to gates. Continuing.');
  } else {
    console.log('run: HEAD unchanged (all rejected/deferred) — back to diff review. Continuing.');
  }
}

// ---------------------------------------------------------------------------
// review helper — snapshot → reviewer → adjudicate, shared by plan and diff

function ledgerEntriesForRound(ledger, kind, round) {
  return ledger.filter((e) => e.kind === kind && e.round === round);
}

/**
 * Drive the pending review round for `kind`. Returns 'GO' when the panel is
 * unanimous; otherwise exits (instruction, relay, or gate).
 */
/** The latest supersession watermark cutoff for (kind, round) — 0 when none. */
function watermarkCutoff(task, kind, round) {
  let cut = 0;
  for (const w of task.reviewWatermarks ?? []) {
    if (w.kind === kind && w.round === round && w.ledgerLength > cut) cut = w.ledgerLength;
  }
  return cut;
}

function reviewRound(task, kind, reviewerArgs) {
  const rounds = readRounds();
  const tally = Number.isInteger(rounds[kind]) ? rounds[kind] : 0;
  const round = tally + 1;
  const verdictPath = join(S, 'reviews', `${kind}-round-${round}-codex.json`);
  const ledger = readLedger();
  const fullEntries = ledgerEntriesForRound(ledger, kind, round);
  // scope: the watermark bounds REPLAY CLASSIFICATION only
  // (GO replay, abstain detection, dropped-only logic). The integrity guards
  // below always read the FULL unscoped ledger.
  const cutoff = watermarkCutoff(task, kind, round);
  const entries = ledger.filter((e, i) => e.kind === kind && e.round === round && i >= cutoff);

  // crash window inside ledger.mjs round: tally advanced to R and raised entries
  // for R written, but blockers.json never landed. Deriving round R+1 would skip
  // a raised round — STOP for the playbook instead. FULL ledger, always.
  const priorEntries = ledgerEntriesForRound(ledger, kind, tally);
  if (
    tally > 0 &&
    priorEntries.some((e) => e.action === 'raised') &&
    !priorEntries.some((e) => RESOLUTION_ACTIONS.includes(e.action)) &&
    !existsSync(join(S, 'blockers.json'))
  ) {
    stop(
      `the ledger holds raised blockers for ${kind} round ${tally} with no resolutions and no blockers.json (crash inside ledger.mjs round)`,
      `ledger entries:\n${renderLedger(priorEntries)}\nPlaybook: restore blockers.json from the round's verdict file (the raised fingerprints name them) or abandon the round — a human act.`,
    );
  }
  // a raised row for THIS round without resolutions and without
  // blockers.json is authoritative crash evidence wherever it sits relative to
  // a watermark — it STOPs for the playbook, never permits a fresh reviewer.
  if (
    fullEntries.some((e) => e.action === 'raised') &&
    !fullEntries.some((e) => RESOLUTION_ACTIONS.includes(e.action)) &&
    !existsSync(join(S, 'blockers.json'))
  ) {
    stop(
      `ledger holds raised blockers for ${kind} round ${round} but blockers.json is gone and the tally was not advanced`,
      `ledger entries:\n${renderLedger(fullEntries)}\nThis is a partial ledger write (crash inside ledger.mjs) — playbook, not guesswork.`,
    );
  }

  // review-context state is computed BEFORE reading the round's ledger record:
  // a recorded round only stands for the exact bytes it reviewed, and a legacy
  // round (incomplete authority set) is historical only — never qualifying
  // No silent grandfathering.
  const state = kind === 'plan' ? planReviewState(task) : undefined;
  const legacyFresh = kind === 'plan' && state === 'legacy-incomplete';
  if (legacyFresh) {
    if (existsSync(verdictPath)) {
      quarantineVerdict(task, kind, round, verdictPath);
      log(`round ${round} verdict superseded — legacy review context incomplete`);
      console.log(
        `run: round ${round}'s recorded review judged an incomplete authority set (pre-upgrade context) — verdict quarantined as history; the plan earns one fresh complete-context review round.`,
      );
    }
    writeReviewSnapshots(task);
    log(`snapshotted full review context for fresh round ${round} (legacy migration)`);
  }

  if (!legacyFresh && entries.length > 0 && !existsSync(join(S, 'blockers.json'))) {
    // the referee already recorded this round (post-watermark); read its own
    // record — never re-adjudicate
    if (kind === 'plan' && state === 'revised') {
      stop(
        `plan artifacts were revised after ${kind} round ${round} was recorded in the ledger`,
        `The recorded round stands for other bytes; re-adjudicating would duplicate append-only history. A human decides (playbook) — typically: abandon or revise onward under a granted round.`,
      );
    }
    // replay must mirror ledger.mjs unanimous-GO semantics — ANY abstain in
    // the round means unanimous GO was never established. A mixed set (old
    // dropped entries + a fresh abstain, e.g. after a legacy migration whose
    // mandatory complete-context reviewer abstained) must never read as GO.
    if (entries.some((e) => e.action === 'abstain')) {
      gate(
        `run: HUMAN GATE — one or more ${kind} reviewers abstained in round ${round} (recorded in the ledger); unanimous GO was never established for this round.\nOptions: grant rounds (run.mjs record-grant) / ABORT (write .ben/ABANDON.md).\n\nLedger:\n${renderLedger(ledger)}`,
        {
          kind: 'review-stop',
          owner: 'human',
          question: `A ${kind === 'plan' ? 'plan' : 'code'} reviewer could not give a verdict — continue with another review round, or stop?`,
          why: 'Without a unanimous reviewer verdict ben does not proceed; spending another round is your call.',
          options: [
            { token: 'continue', label: 'Let ben run another review round', effect: 'grants one more round (add --rounds N for more) and ben continues on its own', command: answerCmd(['continue']) },
            { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
          ],
          binding: { gateKind: kind },
        },
      );
    }
    // verdict-presence rule: the recorded-round GO replay
    // stands ONLY while the round's canonical verdict survives. Quarantine is
    // the durable mark of supersession — with the verdict gone, the recorded
    // rows are historical and the round re-earns a fresh reviewer invocation.
    if (existsSync(verdictPath)) {
      try { readReviewOutput(verdictPath); } catch (err) {
        stop(`recorded ${kind} round ${round} cannot establish GO`, `The canonical review is missing, invalid or marked abstained: ${err.message}. Preserve the evidence and resolve the inconsistent round through the recovery playbook.`);
      }
      return 'GO'; // only auto-dropped / re-raise-dropped entries: the referee let the round pass
    }
    console.log(`run: ${kind} round ${round}'s recorded entries belong to a superseded pass (verdict quarantined) — the round re-earns a fresh reviewer invocation.`);
  }

  if (kind === 'plan' && !legacyFresh && state === 'revised') {
    if (existsSync(verdictPath)) {
      // a revision (e.g. RECONCILE at the approval gate) supersedes an
      // un-adjudicated or GO verdict: quarantine it — kept, never deleted —
      // and the revised bytes get their own fresh round. Blocker-bearing
      // rounds never reach here (open blockers route to reconcile first).
      quarantineVerdict(task, kind, round, verdictPath);
      log(`round ${round} verdict superseded by artifact revision — re-reviewing`);
      console.log(`run: plan artifacts were revised after round ${round}'s verdict — verdict quarantined, revised plan gets a fresh review.`);
    }
    writeReviewSnapshots(task);
    log(`snapshotted plan artifacts for round ${round}`);
  }

  if (!existsSync(verdictPath)) {
    console.log(`run: invoking reviewer for ${kind} round ${round} (this calls the reviewer CLI)...`);
    // BEN_REVIEWER_CLI: test seam forwarding reviewer.mjs's own tests-only --cli
    // override; unset (normal execution) it adds nothing.
    const cliOverride = process.env.BEN_REVIEWER_CLI ? ['--cli', process.env.BEN_REVIEWER_CLI] : [];
    const rev = referee('reviewer.mjs', [kind, S, '--round', String(round), '--repo', REPO, ...reviewerArgs, ...cliOverride]);
    if (rev.exitCode === 3) fail(`reviewer.mjs exited 3: ${rev.output}`);
    console.log(rev.output); // exit 1 = abstain saved; the adjudicator records it
    pauseAt('after-reviewer');
  }
  // what the reviewer judged must still be what exists NOW — for the plan, the
  // full six-member snapshot set; for the diff, the reviewed HEAD, a clean
  // tree, the approval binding AND the adjudication digest under which the
  // baseline was recorded (any re-approval or
  // adjudication change invalidates in-flight review)
  if (kind === 'plan' && planReviewState(task) !== 'current') {
    quarantineVerdict(task, kind, round, verdictPath);
    log(`round ${round} verdict quarantined (artifacts changed mid-review)`);
    reenter('run: plan artifacts or config changed while the reviewer ran — verdict quarantined, the revised plan gets a fresh review. Re-run next.');
  }
  if (kind === 'diff') {
    const aprNow = approvalState(task);
    const aprCurrent =
      aprNow.present &&
      aprNow.matches &&
      isObj(task.reviewBase.approvalHashes) &&
      JSON.stringify(task.reviewBase.approvalHashes) === JSON.stringify(aprNow.approval.sha256);
    const digestCurrent = aprCurrent && adjudicationSnapshot().digest === earnedAdjudicationsSha(task);
    if (headSha() !== task.reviewBase.sha || worktreeStatus() !== '' || !aprCurrent || !digestCurrent) {
      quarantineVerdict(task, kind, round, verdictPath);
      delete task.reviewBase;
      saveTask(task);
      reenter('run: HEAD, the worktree, the approval, or the adjudication state no longer matches the reviewed baseline — verdict quarantined, changed code returns to gates. Re-run next.');
    }
  }

  const cap = kind === 'plan' ? task.config.planRounds : task.config.diffRounds;
  // the operator's hard review boundary: forwarded when configured; a present
  // hard cap that fails validation STOPs — it is never silently ignored, and
  // an ABSENT field (legacy task) simply keeps pre-convergence gating
  const capMaxName = kind === 'plan' ? 'planRoundsMax' : 'diffRoundsMax';
  const capMax = task.config[capMaxName];
  if (capMax !== undefined && (!Number.isSafeInteger(capMax) || capMax < cap)) {
    stop(
      `config.${capMaxName} is present but invalid — it must be an integer >= config.${kind === 'plan' ? 'planRounds' : 'diffRounds'} (${cap})`,
      `value: ${JSON.stringify(capMax)}\nA present hard cap is never silently dropped; a human fixes task.json deliberately.`,
    );
  }
  const adj = referee('ledger.mjs', [
    'round',
    S,
    '--kind',
    kind,
    '--verdict',
    `codex=reviews/${kind}-round-${round}-codex.json`,
    '--cap',
    String(cap),
    ...(capMax !== undefined ? ['--cap-max', String(capMax)] : []),
  ]);
  pauseAt('after-adjudicate');
  console.log(adj.output);
  if (adj.exitCode === 0) {
    log(`${kind} round ${round}: unanimous GO`);
    return 'GO';
  }
  if (adj.exitCode === 1) {
    log(`${kind} round ${round}: blockers survive`);
    const blockers = readJson(join(S, 'blockers.json'), 'blockers.json');
    instruct(
      `Blockers survive ${kind} round ${round}. Write ${join(S, 'proposal.json')} — one proposed disposition per blocker (the human sees it before any resolution file exists):\n${JSON.stringify(blockers, null, 2)}\nThen run: run.mjs next`,
      'reconcile',
    );
  }
  if (adj.exitCode === 3) fail(`ledger.mjs round exited 3: ${adj.output}`);
  const escalationText = `run: HUMAN GATE — ${kind} review escalated (referee exit 2), its output above, verbatim.\nOptions: grant rounds (run.mjs record-grant --kind ${kind} --rounds N --by <you>) / ABORT (write .ben/ABANDON.md).`;
  // a policy stop just recorded by the referee carries its durable slot — the
  // park binds to it; a slot-less escalation (recorded abstain) binds to state
  const slotNow = (() => {
    const r = readRounds();
    return isObj(r.gates) && isObj(r.gates[kind]) ? r.gates[kind] : undefined;
  })();
  gate(escalationText, {
    kind: 'review-stop',
    owner: 'human',
    question: `The ${kind === 'plan' ? 'plan' : 'code'} review stopped and needs your call: continue with more review, or stop?`,
    why: 'The review referee escalated (stall, cap, or ambiguous records); spending more rounds is your boundary to extend.',
    options: [
      { token: 'continue', label: 'Let ben keep reviewing', effect: 'grants one more review round (add --rounds N for more) and ben continues on its own', command: answerCmd(['continue']) },
      { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
    ],
    binding: { gateKind: kind, ...(slotNow !== undefined ? { slot: { gateKind: kind, round: slotNow.round, reason: slotNow.reason } } : {}) },
    // the projection packet embeds the referee's words — printed "above" on
    // the terminal, but the parked note must be complete on its own
    packet: `${escalationText}\n\n=== referee output (verbatim) ===\n${adj.output}`,
  });
}

/**
 * quarantine = the durable mark of supersession. The watermark
 * ({kind, round, ledgerLength}) is persisted in task.json BEFORE the rename
 * (crash-ordered): a crash between the two re-detects the stale context next
 * derivation and quarantines again — a later watermark for the same round
 * supersedes; the rename is then retried idempotently.
 */
function quarantineVerdict(task, kind, round, verdictPath) {
  task.reviewWatermarks = [...(task.reviewWatermarks ?? []), { kind, round, ledgerLength: readLedger().length }];
  saveTask(task);
  pauseAt('after-watermark');
  const dir = join(S, 'reviews', 'superseded');
  mkdirSync(dir, { recursive: true });
  renameSync(verdictPath, join(dir, `${Date.now()}-${verdictPath.split('/').pop()}`));
  const abstainPath = verdictPath.replace(/\.json$/, '.abstain.txt');
  if (existsSync(abstainPath)) renameSync(abstainPath, join(dir, `${Date.now()}-${abstainPath.split('/').pop()}`));
}

// ---------------------------------------------------------------------------
// the transition walk — one legal continuation, derived fresh every invocation

function cmdNext() {
  requireNoForeignRunner();
  acquireLock();
  PARKING = true; // locked human-exit context: gates/STOPs publish the waiting projection
  const task = loadTask();
  CURRENT_TASK = task;
  if (task !== undefined && task.assignmentId === undefined) {
    // a legacy task receives its immutable assignment
    // identity on first sight — a recorded sequencer act, never a guess
    task.assignmentId = randomUUID();
    saveTask(task);
    log(`assignmentId minted for a legacy task: ${task.assignmentId}`);
  }
  if (task === undefined) {
    if (existsSync(S) && readdirSync(S).some((f) => !f.startsWith('.'))) {
      stop(
        `${S} holds pre-sequencer state but no task.json`,
        `The sequencer never adopts silently. Inspect with: run.mjs status\nAdopt deliberately with: run.mjs adopt --base <implementation-baseline-sha> --by <you> --confirm`,
      );
    }
    instruct(`No task here. Start one with: run.mjs init --title "<the task, in the human's words>" [--greenfield]`, 'start');
  }

  if (existsSync(join(S, 'ABANDON.md'))) {
    const line = readFileSync(join(S, 'ABANDON.md'), 'utf8').split('\n').find((l) => l.trim() !== '') ?? '(no reason given)';
    gate(`run: task is ABANDONED — ${line.trim()}\nThe state stays intact for inspection. Deleting ABANDON.md (a human act) reopens it.`, {
      kind: 'abandoned',
      owner: 'human',
      question: `This task is closed as abandoned: ${line.trim()}`,
      why: 'Reopening (deleting .ben/ABANDON.md) is your act; nothing runs while it stands.',
      options: [],
      binding: { abandonSha: sha256File(join(S, 'ABANDON.md')) },
    });
  }

  // identity checks — every derivation, before anything else
  if (rootCommit() !== task.repo.rootCommit) {
    stop(
      'this repository is not the one the task is bound to',
      `task.repo.rootCommit: ${task.repo.rootCommit}\nthis repo's root commit: ${rootCommit()}\nIf the move is intended: run.mjs adopt --rebind --by <you> --confirm`,
    );
  }
  if (git(['cat-file', '-e', `${task.base}^{commit}`], { allowFail: true }).status !== 0) {
    stop(`task base commit ${task.base} is not reachable in this repository`, `repo: ${REPO}`);
  }
  const criteriaDoc = readJson(join(S, 'criteria.json'), 'criteria.json');
  if (criteriaDoc !== undefined && isObj(criteriaDoc) && !isBlank(criteriaDoc.taskId)) {
    if (task.taskId === undefined) {
      task.taskId = criteriaDoc.taskId; // first sight — recorded as a non-authoritative cross-check
      saveTask(task);
    } else if (task.taskId !== criteriaDoc.taskId) {
      stop('criteria.json belongs to a different task than task.json', `task.json.taskId: ${task.taskId}\ncriteria.json.taskId: ${criteriaDoc.taskId}\nOne state dir, one task — never reuse $S.`);
    }
  }

  // terminal: the one and only PR completion authority. Success is never
  // reported over invalid adjudication truth — the same derivation every
  // consumer uses runs first and STOPs on divergence/malformed state.
  if (task.pr) {
    adjudicationSnapshot();
    clearWaiting(); // terminal success is a non-waiting outcome — no contradictory state
    setResult({ outcome: 'terminal', pr: { url: task.pr.url, headSha: task.pr.headSha } });
    console.log(`run: done — PR ${task.pr.url} (head ${task.pr.headSha}). The human merges; ben never does.`);
    process.exit(0);
  }

  // pending PR intent: never a second create instruction without a recorded human retry
  if (task.prIntent) {
    const aprAtPr = approvalState(task);
    // the intent's earned authority is stale when the approval is
    // voided OR the adjudication digest moved past the earned review — both
    // route through the SAME record-pr-remote migration protocol
    const digestStale = aprAtPr.present && aprAtPr.matches && adjudicationSnapshot().digest !== earnedAdjudicationsSha(task);
    if (!aprAtPr.present || !aprAtPr.matches || digestStale) {
      // the durable replay identity is printed BEFORE any write exists, so
      // the exact instructed command is already the crash-replay-safe command
      const pendingHash = sha256(JSON.stringify(task.prIntent));
      stop(
        digestStale
          ? 'a PR intent is pending but the adjudication state changed after its earned diff review'
          : 'a PR intent is pending but the approval no longer matches the on-disk artifacts',
        'Nothing terminal or external proceeds on a stale earned authority. Resolve the remote state as a recorded human act:\n' +
          `  inspect the remote first (e.g. gh pr list --head ${task.prIntent.branch})\n` +
          `  PR confirmed absent → run.mjs record-pr-remote --status absent --intent-hash ${pendingHash} --by <you>\n` +
          `  PR exists           → run.mjs record-pr-remote --status exists --url <its url> --intent-hash ${pendingHash} --by <you>\n` +
          'Repeating the exact command after an interruption is safe: it lands the resolution once, then replays as a no-op.\n' +
          'Either resolution archives the pending intent and routes the task through migration (a fresh complete-context review that re-binds the adjudication digest) before anything terminal or external can proceed.',
        {
          kind: 'pr-migration',
          owner: 'human',
          question: 'A pull-request step was interrupted and its earlier authorization is out of date — ben needs your recorded observation of GitHub before anything else can happen.',
          why: 'Only a human may resolve what exists remotely; ben never guesses about external state.',
          options: [],
          binding: { intentHash: pendingHash },
          notes:
            'Start a ben session in this repo: ben performs the GitHub inspection and prepares the exact recorded command — you only confirm what it found. The full packet below carries the exact commands if you prefer to run them yourself.',
        },
      );
    }
    // the ORDERED transition table.
    // I = the latest recorded GitHub inspection for this exact intent; R = an
    // unconsumed human retry. Facts (I) supersede authorizations (R) recorded
    // against older facts; a PR that exists always governs; authorization is
    // bound to the inspected attempt through R.inspectionSha.
    const intentHash = sha256(JSON.stringify(task.prIntent));
    const insp = latestInspection(task, intentHash);
    const inspSha = insp === undefined ? undefined : inspectionSha(insp);
    const retries = (task.prRetries ?? []).filter((r) => r.intentHash === intentHash && r.consumedByAttempt === undefined);
    const retry = retries.find((r) => (insp === undefined ? r.inspectionSha === undefined : r.inspectionSha === inspSha));
    const stale = retries.filter((r) => r !== retry);
    if (stale.length > 0) log(`${stale.length} retry authorization(s) superseded by a newer inspection — inert`);
    const prBinding = { intentHash, ...(inspSha !== undefined ? { inspectionSha: inspSha } : {}) };
    const headAtAssign = task.assignment?.publication?.mode === 'update' ? task.assignment.publication.pr.headAtAssign : undefined;
    if (retry) {
      if (insp !== undefined && insp.pr === 'exists' && insp.prHead === task.prIntent.headSha) {
        // a newer fact says the PR already exists at the reviewed head — the
        // authorization is moot; recording governs (below), R stays unconsumed
        log('retry authorization moot: the PR exists at the reviewed head');
      } else {
        // (a) an authorized retry against the CURRENT facts: consume it once.
        // A PR that exists at another head makes the retry an UPDATE of that
        // PR (fast-forward only, enforced by the runner); else the task's mode.
        const attempt = task.prIntent.attempt + 1;
        if (headSha() !== task.prIntent.headSha) {
          stop('a PR retry is authorized but HEAD no longer matches the reviewed intent', `intent head: ${task.prIntent.headSha}\nHEAD now: ${headSha()}`);
        }
        const publication =
          insp !== undefined && insp.pr === 'exists'
            ? { mode: 'update', prUrl: insp.url }
            : task.prIntent.publication ?? publicationFor(task);
        retry.consumedByAttempt = attempt;
        // history is never erased: the superseded intent is kept in full, so every
        // prior attempt (which may have created a remote PR) stays reconstructible
        task.prAttempts = [...(task.prAttempts ?? []), task.prIntent];
        task.prIntent = { attempt, branch: task.prIntent.branch, headSha: task.prIntent.headSha, rootCommit: task.repo.rootCommit, at: new Date().toISOString(), publication };
        saveTask(task); // one atomic write: retry consumed + prior intent archived + fresh intent
        log(`PR intent attempt ${attempt} (retry authorized by ${retry.by}, mode ${publication.mode})`);
        emitPrCreateInstruction(task);
      }
    }
    if (insp !== undefined) {
      const branch = task.prIntent.branch;
      if (insp.pr === 'exists' && insp.prHead === task.prIntent.headSha) {
        gate(
          `run: GitHub inspection found PR ${insp.url} at the reviewed head ${insp.prHead}. No create instruction will be emitted. Record it terminally with a validated remote observation:\n` +
            `  gh pr view ${insp.url} --json url,body,headRefOid,updatedAt > ${shq(join(S, 'remote-observation.json'))}\n` +
            `  run.mjs record-pr --url ${insp.url} --remote-observation ${shq(join(S, 'remote-observation.json'))}`,
          {
            kind: 'pr-record',
            owner: 'model',
            question: 'ben needs to finish recording the pull request GitHub already has — the runner (or a ben session) does this.',
            why: "This is ben's own follow-up (fetching the remote observation and recording it); no decision of yours is pending here.",
            options: [],
            binding: prBinding,
          },
        );
      }
      // the retry request names what failed, what
      // GitHub showed and when (an observation, not a guarantee about now), and
      // exactly what a retry does — the human decides with the facts in view
      const failureShort = insp.failure === undefined ? undefined : insp.failure.length > 200 ? `${insp.failure.slice(0, 199)}…` : insp.failure;
      const failedLead = failureShort === undefined ? 'Publishing may have half-happened. ' : `Publishing failed: ${failureShort} `;
      const failurePacket = insp.failure === undefined ? '' : `The last publication attempt failed: ${insp.failure}\n`;
      if (insp.pr === 'exists' && headAtAssign !== undefined && insp.prHead === headAtAssign) {
        gate(
          `run: HUMAN GATE — publish the follow-up? PR ${insp.url} still sits at the previous delivery (${insp.prHead}); the reviewed head ${task.prIntent.headSha} has not been pushed (branch ${branch}: ${insp.branch}).\n` +
            failurePacket +
            `GitHub as observed at ${insp.at}: branch ${branch} ${insp.branch}, PR ${insp.url} at ${insp.prHead}.\n` +
            `  retry → push the reviewed head and update the PR (fast-forward only)\n  abort → write .ben/ABANDON.md`,
          {
            kind: 'pr-retry',
            owner: 'human',
            question: `${failedLead}At ${insp.at} GitHub showed PR ${insp.url} still at the previous delivery and the reviewed commit not pushed. Retry will push the reviewed commit (fast-forward only) and update that same PR — exactly once. Retry, or stop?`,
            why: 'ben never retries an external action on its own; you authorize the one retry.',
            options: [
              { token: 'retry', label: 'Retry the publication', effect: 'pushes the reviewed head (fast-forward only) and updates the same PR — exactly once', command: answerCmd(['retry']) },
              { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
            ],
            binding: prBinding,
          },
        );
      }
      if (insp.pr === 'exists') {
        gate(
          `run: HUMAN GATE — pull request head mismatch\nPR ${insp.url} is at ${insp.prHead}; the reviewed head is ${task.prIntent.headSha} (branch ${branch}: ${insp.branch}).\n` +
            `ben will not guess. Options:\n  retry → fast-forward the branch to the reviewed head and update this PR (refused if that is not a fast-forward)\n  abort → write .ben/ABANDON.md`,
          {
            kind: 'pr-head-mismatch',
            owner: 'human',
            question: `A pull request for this branch exists on GitHub at a different commit (${insp.prHead.slice(0, 12)}) than the code ben just finished reviewing (${task.prIntent.headSha.slice(0, 12)}). Update that PR to the reviewed code, or stop?`,
            why: 'Someone or something moved the PR; only you decide whether ben may move it to the reviewed code.',
            options: [
              { token: 'retry', label: 'Update the PR to the reviewed code', effect: 'fast-forwards the branch to the reviewed head and updates the PR body (a non-fast-forward is refused and parked for you)', command: answerCmd(['retry']) },
              { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
            ],
            binding: prBinding,
          },
        );
      }
      if (insp.branch === 'other') {
        gate(
          `run: HUMAN GATE — branch ${branch} exists on GitHub at a commit that is neither the reviewed head (${task.prIntent.headSha}) nor a known previous delivery, and no PR exists for it. Someone else pushed; ben will not overwrite anything.\n` +
            `  Resolve the remote branch, then re-inspect (runner.mjs resume --choose reinspect) — or abort (write .ben/ABANDON.md).`,
          {
            kind: 'pr-branch-conflict',
            owner: 'human',
            question: `The branch ${branch} on GitHub holds someone else's commit; ben will not overwrite it. Resolve the branch and re-inspect, or stop?`,
            why: 'Nothing is ever force-pushed; a conflicting remote branch is a human matter.',
            options: [
              { token: 'reinspect', label: 'Re-check GitHub', effect: 'ben re-inspects the branch and PR (observation only, no decision recorded) and continues if the conflict is gone', command: answerCmd(['reinspect']) },
              { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
            ],
            binding: prBinding,
          },
        );
      }
      // pr absent, branch absent | at-sha | at-previous → the human retry gate
      const branchSeen = insp.branch === 'at-sha' ? 'pushed at the reviewed commit' : insp.branch === 'absent' ? 'not pushed' : 'at the previous delivery';
      const retryDoes = insp.branch === 'at-sha' ? 'skip the push (the branch is already at the reviewed commit) and create the pull request' : 'push the reviewed commit and create the pull request';
      gate(
        `run: HUMAN GATE — create the pull request? GitHub inspection: branch ${branch} ${insp.branch}, PR absent (attempt ${task.prIntent.attempt}, head ${task.prIntent.headSha}).\n` +
          failurePacket +
          `GitHub as observed at ${insp.at}: branch ${branch} ${branchSeen}, no pull request for it.\n` +
          `  retry → ${retryDoes} — exactly once; a pull request that appears in the meantime is recorded, never duplicated\n  abort → write .ben/ABANDON.md`,
        {
          kind: 'pr-retry',
          owner: 'human',
          question: `${failedLead}At ${insp.at} GitHub showed the branch ${branchSeen} and no pull request. Retry will ${retryDoes} — exactly once, never a second PR. Retry, or stop?`,
          why: 'ben never retries an external action on its own; you authorize the one retry (never two PRs).',
          options: [
            { token: 'retry', label: 'Retry the publication', effect: 'one fresh attempt: push (if needed) and create the PR — exactly once', command: answerCmd(['retry']) },
            { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
          ],
          binding: prBinding,
        },
      );
    }
    gate(
      `run: PR intent attempt ${task.prIntent.attempt} is pending (branch ${task.prIntent.branch}, head ${task.prIntent.headSha}) and no PR is recorded.\n` +
        `A create instruction may already have run — the sequencer will NOT emit another.\n` +
        `Required action: inspect whether the PR exists remotely (e.g. gh pr list --head ${task.prIntent.branch}).\n` +
        `  record what you find → run.mjs record-pr-inspection --branch absent|at-sha|other --pr absent|exists [--url <url> --pr-head <sha>] --intent-hash ${intentHash} --by <you|ben-runner>\n` +
        `  PR exists   → gh pr view <its url> --json url,body,headRefOid,updatedAt > ${shq(join(S, 'remote-observation.json'))}\n` +
        `                run.mjs record-pr --url <its url> --remote-observation ${shq(join(S, 'remote-observation.json'))}\n` +
        `  PR confirmed absent → run.mjs record-pr-retry --by <you>   (records the authorization; only then can a fresh create be emitted)`,
      {
        kind: 'pr-pending',
        owner: 'model',
        question: 'ben needs to finish checking a pull request on GitHub — the runner (or a ben session) does this.',
        why: "This is ben's own follow-up (inspecting GitHub and recording what it finds); you will only be asked for the final authorization if a retry is needed.",
        options: [],
        binding: { intentHash },
      },
    );
  }

  // fail-closed at the sequencer: a grant that reached rounds.json
  // without its ledger audit row (crash inside ledger.mjs grant) is never
  // continued on — the extended budget would be unaudited. Detected from the
  // sequencer's own crash intent with the exact matrix coreRecordGrant uses;
  // the runner repairs it (rollback + slot restore) before it ever calls next.
  const halfGrant = halfAppliedGrant(task);
  if (halfGrant !== undefined) {
    stop(
      'a grant reached rounds.json but its ledger audit entry is missing (crash inside ledger.mjs grant)',
      `intent: ${JSON.stringify(halfGrant.intent)}\nrounds.json grant: ${JSON.stringify(halfGrant.grant)}\nThe runner rolls the half-applied grant back and re-presents the review stop; interactively, follow the playbook — never continue on an unaudited budget.`,
    );
  }

  // -----  precedence: a recorded supervisor stop, then a limit event,
  // govern before every plan/implement-phase gate (PR family above them) -----
  const sstop = openSupervisorStop(task);
  if (sstop !== undefined) {
    gate(
      `run: HUMAN GATE — ben stopped itself: ${sstop.reason}\n(recorded by ${sstop.by} at ${sstop.at})\nOptions: continue (one more try) / abort.`,
      {
        kind: 'supervisor-stop',
        owner: 'playbook',
        question: `ben made no progress and has parked itself: ${sstop.reason}`,
        why: 'Repeating the same step without change wastes budget; you decide whether ben tries once more or stops.',
        options: [
          { token: 'continue', label: 'Let ben try once more', effect: 'one more attempt at the same step; ben parks again if nothing changes (add --note "<hint>" to pass ben a hint)', command: answerCmd(['continue']) },
          { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
        ],
        binding: { stopId: sstop.id },
      },
    );
  }
  const limitEv = openLimitEvent(task);
  if (limitEv !== undefined) {
    const unit = limitEv.kind === 'usd' ? '$' : limitEv.kind === 'time' ? 'active hours' : 'work stretches';
    const flag = limitEv.kind === 'usd' ? '--usd N' : limitEv.kind === 'time' ? '--hours N' : '--stretches N';
    gate(
      `run: HUMAN GATE — LIMIT REACHED (${limitEv.kind}: ${limitEv.value} ${unit}, recorded by ${limitEv.by} at ${limitEv.at}).\nOptions: continue ${flag} (adds to the budget) / abort.`,
      {
        kind: 'limit',
        owner: 'human',
        question: `ben reached its ${limitEv.kind === 'usd' ? 'spending' : limitEv.kind === 'time' ? 'active-time' : 'stretch'} limit (${limitEv.kind === 'usd' ? `$${limitEv.value}` : `${limitEv.value} ${unit}`}) and is parked. Extend it, or stop?`,
        why: 'Budgets are your boundary; only you extend them, by a specific amount — nothing ever becomes unlimited.',
        options: [
          { token: 'continue', label: 'Extend the budget', effect: `adds the amount you name (${flag}) and ben continues; a continue without an amount is refused`, command: answerCmd(['continue'], ` ${flag}`) },
          { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
        ],
        binding: { eventId: limitEv.id, limitKind: limitEv.kind },
      },
    );
  }

  // ----- plan phase: everything before a valid approval -----
  const appr = approvalState(task);
  if (!appr.present || !appr.matches) {
    if (appr.present && !appr.matches) {
      log('approval no longer matches the artifacts — re-presenting');
    }

    // consequential ambiguity — the plan stretch may ask; the
    // human answers through the clarify gate; the driver folds the answers in
    const questionsPath = join(S, 'questions.json');
    if (existsSync(questionsPath)) {
      const questions = readJson(questionsPath, 'questions.json');
      const qSha = sha256File(questionsPath);
      if (!Array.isArray(questions) || questions.length === 0 || questions.some((q) => !isObj(q) || isBlank(q.id) || isBlank(q.question))) {
        modelWork(`run: ${questionsPath} must be a non-empty array of {id, question} — fix or delete it and re-run next`, 'plan');
      }
      const answered = (task.clarifications ?? []).find((c) => c.questionsSha === qSha);
      if (answered === undefined) {
        gate(
          `run: HUMAN GATE — clarify (ben needs ${questions.length} answer(s) before planning)\n` +
            questions.map((q, i) => `  ${i + 1}. [${q.id}] ${q.question}`).join('\n') +
            `\n\nAnswer with plain words: runner.mjs resume --choose reply --reply "<your answers>" (or --reply-file <path>)`,
          {
            kind: 'clarify',
            owner: 'human',
            question: `ben needs ${questions.length} answer(s) before planning: ${questions.map((q, i) => `${i + 1}. ${q.question}`).join(' ')}`,
            why: 'These answers change what gets built; ben never guesses a consequential ambiguity.',
            options: [{ token: 'reply', label: 'Answer the questions', effect: 'your plain-text answers are recorded and folded into the brief; ben then plans', command: answerCmd(['reply'], ' --reply "<answers, plain text>"') }],
            binding: { questionsSha: qSha },
          },
        );
      }
      instruct(
        `The human answered your questions (${answered.by}, ${answered.at}). Fold the answers into ${join(S, 'brief.md')} (quote the questions and answers), then delete ${questionsPath}, then run: run.mjs next\n` +
          `Questions:\n${JSON.stringify(questions, null, 2)}\nAnswers (verbatim):\n${answered.answers}`,
        'plan',
      );
    }
    // an outstanding revision request whose packet bytes are
    // still on disk — the driver revises before anything else
    const outstandingRevision = (task.revisions ?? []).filter((r) => r.presentedAt === undefined).at(-1);
    if (outstandingRevision !== undefined) {
      const hashesNow = approvalHashes(task);
      if (hashesNow !== undefined && JSON.stringify(hashesNow) === JSON.stringify(outstandingRevision.hashes)) {
        instruct(
          `The human asked for changes to the plan instead of approving it (${outstandingRevision.by}, ${outstandingRevision.at}). Revise plan.md / criteria.json / promises.json / plan-files.json / gates.json accordingly, then run: run.mjs next\n` +
            `Their notes, verbatim:\n${outstandingRevision.notes}`,
          'plan',
      );
      }
    }
    // gates.json is a plan artifact here: verify consumes it later and the
    // approval binds its hash, so it must exist before the approval gate
    for (const name of ['plan.md', 'criteria.json', 'promises.json', 'plan-files.json', 'gates.json']) {
      const p = join(S, name);
      if (!existsSync(p) || (name === 'plan.md' && isBlank(readFileSync(p, 'utf8')))) {
        instruct(
          `Write the plan artifacts into ${S}: plan.md (what/why/how — not blank), criteria.json, promises.json, plan-files.json, gates.json (gate name -> shell command; the toolchain that judges the build). Then run: run.mjs next` +
            (outstandingRevision !== undefined ? `\nOutstanding revision request (${outstandingRevision.by}, ${outstandingRevision.at}), verbatim:\n${outstandingRevision.notes}` : ''),
          'plan',
      );
      }
    }

    const rounds = readRounds();
    const ledger = readLedger();
    const blockers = readJson(join(S, 'blockers.json'), 'blockers.json');
    if (blockers !== undefined) {
      if (!Array.isArray(blockers)) stop('blockers.json is not an array', `file: ${join(S, 'blockers.json')}`);
      const kind = openBlockersKind(ledger);
      if (kind !== 'plan') {
        stop('open blockers exist before approval but the ledger says they are not plan blockers', `ledger tail kind: ${kind}\nblockers: ${JSON.stringify(blockers)}`);
      }
      reconcileFlow(task, 'plan', blockers, rounds, ledger);
      // falls through: revised plan re-enters pregate → snapshot → review below
    }

    const pregateArgs = [
      S,
      '--plan-rounds',
      String(task.config.planRounds),
      ...(task.config.greenfield ? ['--greenfield'] : []),
      ...(task.config.e2ePaths ? ['--e2e-paths', task.config.e2ePaths] : []),
    ];
    const pre = referee('pregate.mjs', pregateArgs);
    pauseAt('after-pregate');
    if (pre.exitCode !== 0) {
      if (pre.exitCode === 3) fail(`pregate.mjs exited 3: ${pre.output}`);
      relay('pregate.mjs', pre, {
        kind: 'fix-cap',
        owner: 'human',
        question: 'The plan phase stopped at its budget — this needs your judgment.',
        why: 'Plan rounds cost time and money; extending the budget is your call.',
        options: [
          { token: 'continue', label: 'Let ben keep planning', effect: 'grants one more plan review round and ben continues on its own', command: answerCmd(['continue']) },
          { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
        ],
        binding: { step: 'plan-rounds' },
        notes: 'To extend the plan budget instead, use the grant command in the full packet below (run.mjs record-grant --kind plan --rounds N --by <you>), or start a ben session.',
      }, 'plan');
    }
    console.log(pre.output);

    if (reviewRound(task, 'plan', []) === 'GO') {
      const packetLedger = renderLedger(readLedger());
      const manual = (readJson(join(S, 'criteria.json'), 'criteria.json')?.criteria ?? [])
        .filter((c) => c?.verification?.method === 'manual')
        .map((c) => `- ${c.id}: ${c.statement}`);
      // the presented packet is a durable fact, hash-bound: record-approval
      // refuses to record an approval for a packet that was never presented.
      // the ledger stamp is the APPROVAL-RELEVANT digest — inert audit
      // rows (adjudication/publication) never participate; 'ABSENT' when the
      // relevant row set is empty.
      const gateHashes = approvalHashes(task);
      let gateLedgerSha;
      try {
        gateLedgerSha = approvalRelevantLedgerSha(join(S, 'ledger.jsonl'));
      } catch (err) {
        stop(`the ledger cannot be digested for the approval packet: ${err instanceof Error ? err.message : String(err)}`, `file: ${join(S, 'ledger.jsonl')}`);
      }
      task.approvalGate = {
        at: new Date().toISOString(),
        hashes: gateHashes,
        ledgerSha: gateLedgerSha,
      };
      // an outstanding revision request is presented (its notes
      // ride the packet) once the packet's bytes differ from the ones it
      // asked to change; stamped so it stops instructing but stays history
      const revisionsPresented = (task.revisions ?? []).filter((r) => r.presentedAt === undefined && JSON.stringify(r.hashes) !== JSON.stringify(gateHashes));
      for (const r of revisionsPresented) r.presentedAt = task.approvalGate.at;
      const vetoDecisions = readVetoLog().filter((v) => (v.type ?? 'decision') === 'decision');
      saveTask(task);
      pauseAt('after-approval-gate-record');
      gate(
        `run: HUMAN GATE — APPROVE BUILD (always, never opt-in)\n\n` +
          `=== plan.md (verbatim) ===\n${readFileSync(join(S, 'plan.md'), 'utf8')}\n` +
          `=== criteria.json (verbatim) ===\n${readFileSync(join(S, 'criteria.json'), 'utf8')}\n` +
          `=== promises.json (verbatim) ===\n${readFileSync(join(S, 'promises.json'), 'utf8')}\n` +
          `=== plan-files.json (verbatim) ===\n${readFileSync(join(S, 'plan-files.json'), 'utf8')}\n` +
          `=== gates.json (verbatim — these commands will judge the build) ===\n${readFileSync(join(S, 'gates.json'), 'utf8')}\n` +
          `=== config (canonical, verdict-relevant — e2ePaths drives UI/E2E applicability; approval binds it) ===\n${canonicalConfig(task)}\n` +
          `=== ledger ===\n${packetLedger}\n` +
          (vetoDecisions.length > 0
            ? `=== reconcile decisions (veto.jsonl, verbatim) ===\n${vetoDecisions.map((v) => `[${v.kind} round ${v.round}] ${JSON.stringify(v.response)} by ${v.by ?? '(unrecorded actor)'} at ${v.at}${v.basis ? ` basis ${JSON.stringify(v.basis)}` : ''}`).join('\n')}\n`
            : '') +
          (revisionsPresented.length > 0
            ? `=== revision requests answered by this packet (verbatim) ===\n${revisionsPresented.map((r) => `-- ${r.by} at ${r.at}:\n${r.notes}`).join('\n')}\n`
            : '') +
          (manual.length > 0
            ? `=== manual criteria (each needs a recorded human adjudication before the build can reach diff review: run.mjs record-adjudication --criterion <id> --response <file> --by <you>) ===\n${manual.join('\n')}\n`
            : '') +
          `\nOptions: APPROVE BUILD / RECONCILE / ABORT — recorded via:\n  run.mjs record-approval --by <you> --decision APPROVE|RECONCILE|ABORT`,
        {
          kind: 'approval',
          owner: 'human',
          question: `Approve this build plan${task.title ? ` for "${task.title}"` : ''}? The reviewed plan passed adversarial review; nothing is built until you approve.`,
          why: 'Plans are only ever built after your explicit approval — ben never approves for you.',
          options: [
            { token: 'approve', label: 'APPROVE BUILD', effect: 'ben implements exactly this plan, on its own, and comes back only for decisions that are yours', command: answerCmd(['approve']) },
            { token: 'revise', label: 'Ask for changes', effect: 'your notes are recorded; ben revises the plan, it re-earns review, and comes back to this gate', command: answerCmd(['revise'], ' --reply "<what to change>"') },
            { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
          ],
          binding: { hashes: gateHashes, ledgerSha: gateLedgerSha },
          notes: 'Want changes instead? Answer "revise" with your notes in plain words — ben folds them into the plan, which re-earns review and comes back to this gate.',
        },
      );
    }
    return; // unreachable — reviewRound and gate always exit on non-GO paths
  }

  if (appr.approval.decision !== undefined && appr.approval.decision !== 'APPROVE') {
    stop('approval.json records a non-APPROVE decision yet still exists', `approval: ${JSON.stringify(appr.approval)}`);
  }

  // ----- implement phase -----
  runVerify(task, 'commits', ['--since', task.base]); // returns only on green; exit 1 tells the model to implement

  // diff blockers take precedence over starting a fresh round
  const ledger = readLedger();
  const rounds = readRounds();
  const blockers = readJson(join(S, 'blockers.json'), 'blockers.json');
  if (blockers !== undefined) {
    if (!Array.isArray(blockers)) stop('blockers.json is not an array', `file: ${join(S, 'blockers.json')}`);
    const kind = openBlockersKind(ledger);
    if (kind !== 'diff') {
      stop('open blockers exist after approval but the ledger says they are plan blockers', `ledger tail kind: ${kind}\nAn approved plan cannot have open plan blockers — the state disagrees with itself.`);
    }
    reconcileFlow(task, 'diff', blockers, rounds, ledger);
    // falls through: the referee's printed route is realized by re-derivation below
  }

  // ----- the manual-criterion adjudication gate — post-approval, after
  // commits and any open-blocker reconcile, BEFORE scope/gates/criteria and
  // diff review. No diff review on the sequenced path ever sees a pending
  // manual criterion (a pending manual criterion cannot reach diff review).
  const adjSnapshot = adjudicationSnapshot();
  const pendingManual = pendingManualCriteria(adjSnapshot);
  if (pendingManual.length > 0) {
    gate(
      `run: HUMAN GATE — manual criteria need a recorded adjudication before verification and diff review\n\n` +
        `Pending manual criteria, verbatim:\n` +
        pendingManual.map((c) => `=== ${c.id} ===\n${JSON.stringify(c, null, 2)}`).join('\n') +
        `\n\nRecord each as a human act (dry run first, then --confirm):\n` +
        `  run.mjs record-adjudication --criterion <id> --response <file> --by <you>\n` +
        `  run.mjs record-adjudication --criterion <id> --response <file> --by <you> --confirm\n` +
        `The response file is JSON: {"decision":"satisfied"|"accepted","ruling":"<your words>","residual":"<required for accepted>","basis":{"kind":"plan|diff","round":N,"fingerprint":"...","action":"..."}} (basis optional; required on a terminal task).\n` +
        `satisfied binds the checked HEAD and needs a clean worktree; accepted is HEAD-independent policy acceptance whose residual is published on the PR.`,
      {
        kind: 'manual-adjudication',
        owner: 'human',
        question: `${pendingManual.length} item(s) on the plan need your personal check or sign-off before ben can continue: ${pendingManual.map((c) => `${c.id} ("${c.statement}")`).join('; ')}.`,
        why: 'These were declared human-checked in the approved plan — no script or model may decide them for you.',
        options: [
          { token: 'satisfied', label: 'I checked it and it holds', effect: 'records your ruling (in your words) as satisfied for the checked code', command: answerCmd(['satisfied'], `${pendingManual.length > 1 ? ' --criterion <id>' : ''} --reply "<what you checked>"`) },
          { token: 'accepted', label: 'Ship without that check', effect: 'records your ruling AND the gap that remains — published on the PR, never hidden', command: answerCmd(['accepted'], `${pendingManual.length > 1 ? ' --criterion <id>' : ''} --reply "<your ruling>" --residual "<the gap that remains>"`) },
          { token: 'abort', label: 'Stop this task', effect: 'closes the task honestly; nothing is lost and it can be reopened later', command: answerCmd(['abort'], ' --note "<why>"') },
        ],
        binding: {
          criterionIds: pendingManual.map((c) => c.id).sort(),
          criteriaSha: sha256File(join(S, 'criteria.json')),
          approvalSha: sha256File(join(S, 'approval.json')),
          headSha: headSha(),
        },
        notes:
          'This decision needs your own words, so it has no one-word answer. For each item: if you checked it and it holds, record decision "satisfied" with a one-line ruling in your words; if you accept shipping without that check, record "accepted" with a ruling AND the gap that remains (it is published on the PR, never hidden). The exact commands are in the full packet below — or start a ben session and dictate your ruling; ben prepares the record and shows you the dry run to confirm.',
      },
    );
  }

  // ----- scope → gates → criteria → diff review, git-bound -----
  // resume-mid-review additionally requires the reviewBase to be bound to the
  // CURRENT approval AND the current adjudication digest: a
  // re-approval or a recorded adjudication change — migration's included —
  // structurally invalidates every in-flight diff verdict and baseline
  const diffTally = Number.isInteger(readRounds().diff) ? readRounds().diff : 0;
  const pendingVerdict = join(S, 'reviews', `diff-round-${diffTally + 1}-codex.json`);
  const resumeMidReview =
    task.reviewBase !== undefined &&
    task.reviewBase.sha === headSha() &&
    existsSync(pendingVerdict) &&
    isObj(task.reviewBase.approvalHashes) &&
    JSON.stringify(task.reviewBase.approvalHashes) === JSON.stringify(appr.approval.sha256) &&
    earnedAdjudicationsSha(task) === adjSnapshot.digest;

  if (!resumeMidReview) {
    if (existsSync(pendingVerdict)) {
      // a pending verdict whose reviewed baseline no longer matches HEAD (or
      // whose approval binding or adjudication digest was superseded) is stale
      // by definition — quarantine it BEFORE re-verifying, or the fresh
      // reviewBase would launder it (the C33 escape)
      quarantineVerdict(task, 'diff', diffTally + 1, pendingVerdict);
      delete task.reviewBase;
      saveTask(task);
      console.log('run: pending diff verdict no longer matches HEAD, the current approval, or the adjudication state — verdict quarantined, changed code re-earns gates, criteria and review.');
      log(`diff round ${diffTally + 1} verdict quarantined (baseline mismatch)`);
    }
    const dirty = worktreeStatus();
    if (dirty !== '') {
      stop(
        'the worktree is dirty — verification for review and the diff reviewer must see the same committed code',
        `git status --porcelain:\n${dirty}\nCommit (or deliberately discard) every change, then re-run next.`,
        {
          kind: 'model-stop', // cleaning the worktree is ben's work, never parked on the operator
          owner: 'model',
          question: 'ben needs to tidy uncommitted changes before review — start a ben session in this repo.',
          why: "This stop is ben's own follow-up (committing or deliberately discarding its changes); no decision of yours is pending here.",
        },
      );
    }
    // the whole chain judges ONE HEAD, captured before the first
    // referee; scope runs first (no user commands — git only, cheapest first)
    const chainHead = headSha();
    runVerify(task, 'scope', ['--base', task.base, '--e2e-paths', task.config.e2ePaths ?? '', '--cap', String(effectiveCap(task, 'scope'))]);
    runVerify(task, 'gates', ['--cap', String(effectiveCap(task, 'gates')), '--timeout', String(task.config.timeoutMs)]);
    requireChainConsistent(task, chainHead, 'after gates, before criteria'); // boundary 1
    runVerify(task, 'criteria', ['--cap', String(effectiveCap(task, 'criteria')), '--timeout', String(task.config.timeoutMs)]);
    const dirtiedByCommands = worktreeStatus();
    if (dirtiedByCommands !== '') {
      // a green gate/criterion command mutated tracked files: the verified tree
      // and the tree the reviewer would see have already diverged
      stop(
        'a gate or criterion command dirtied the worktree during verification',
        `git status --porcelain:\n${dirtiedByCommands}\nCommit or discard deliberately (and make the command side-effect-free), then re-run next.`,
        {
          kind: 'model-stop', // a command side-effect is ben's to clean up, never the operator's
          owner: 'model',
          question: 'A build command left stray changes ben needs to clean up — start a ben session in this repo.',
          why: "This stop is ben's own follow-up (cleaning the worktree and de-side-effecting the command); no decision of yours is pending here.",
        },
      );
    }
    requireChainConsistent(task, chainHead, 'after criteria, before the review baseline'); // boundary 2
    // reviewBase records the HEAD the chain PROVED — never a re-read that
    // could race the boundary; later HEAD/worktree guards stay in force.
    // the adjudication digest is re-derived here (a verification command
    // could have mutated the register — never bound unverified).
    task.reviewBase = {
      sha: chainHead,
      verifiedAt: new Date().toISOString(),
      approvalHashes: appr.approval.sha256,
      adjudicationsSha: adjudicationSnapshot().digest,
    };
    saveTask(task);
    pauseAt('after-review-base');
  }

  if (reviewRound(task, 'diff', ['--base', task.base]) === 'GO') {
    // ----- PR phase -----
    // the intent head must be the reviewed head, verified at the last possible
    // moment: a commit landing during adjudication or body assembly must not
    // become the PR head without earning gates, criteria and review
    if (headSha() !== task.reviewBase.sha || worktreeStatus() !== '') {
      delete task.reviewBase;
      saveTask(task);
      reenter('run: HEAD or the worktree changed after diff GO — changed code returns to gates. Re-run next.');
    }
    // boundary 4: nothing terminal or external on a voided/rebound approval
    const aprGo = approvalState(task);
    if (
      !aprGo.present ||
      !aprGo.matches ||
      !isObj(task.reviewBase.approvalHashes) ||
      JSON.stringify(task.reviewBase.approvalHashes) !== JSON.stringify(aprGo.approval.sha256)
    ) {
      stop(
        'the approval changed after diff GO — nothing terminal proceeds on a voided or rebound approval',
        'The next run re-presents the plan phase; a re-approval invalidates in-flight diff review state by design.',
      );
    }
    // the diff GO stands only for the adjudication state it reviewed
    if (adjudicationSnapshot().digest !== earnedAdjudicationsSha(task)) {
      const goVerdict = join(S, 'reviews', `diff-round-${(Number.isInteger(readRounds().diff) ? readRounds().diff : 0) + 1}-codex.json`);
      if (existsSync(goVerdict)) quarantineVerdict(task, 'diff', (Number.isInteger(readRounds().diff) ? readRounds().diff : 0) + 1, goVerdict);
      delete task.reviewBase;
      saveTask(task);
      reenter('run: the adjudication state changed after diff GO — the changed governing set re-earns verification and review. Re-run next.');
    }

    // an observed remote PR governs the PR phase — no create
    // instruction ever exists on this path
    if (task.observedPr) {
      if (task.reviewBase.sha === task.observedPr.headSha) {
        const rq = task.observedPr.requalified;
        const rqCurrent =
          isObj(rq) && rq.reviewBaseSha === task.reviewBase.sha && JSON.stringify(rq.approvalHashes) === JSON.stringify(aprGo.approval.sha256);
        if (!rqCurrent) {
          // durable "fresh diff GO earned" fact, bound to the reviewed head AND
          // the approval authority it was earned under — record-pr requires
          // both; a re-approval makes a stale stamp unusable until a fresh GO
          // under the new approval re-stamps here. Idempotent on re-derivation.
          task.observedPr.requalified = { at: new Date().toISOString(), reviewBaseSha: task.reviewBase.sha, approvalHashes: aprGo.approval.sha256 };
          saveTask(task);
          log(`observedPr requalified at ${task.reviewBase.sha} under the current approval`);
        }
        gate(
          `run: an existing remote PR was observed (${task.observedPr.url}) and the freshly reviewed HEAD matches its head (${task.observedPr.headSha}).\n` +
            `No create instruction will be emitted. Record it terminally with a validated remote observation:\n` +
            `  node scripts/pr.mjs ${shq(S)} --repo ${shq(REPO)} --title ${shq(task.title ?? task.taskId ?? 'ben task')}   (regenerate the body; update the remote if it differs: gh pr edit ${task.observedPr.url} --body-file ${shq(join(S, 'pr-body.md'))})\n` +
            `  gh pr view ${task.observedPr.url} --json url,body,headRefOid,updatedAt > ${shq(join(S, 'remote-observation.json'))}\n` +
            `  run.mjs record-pr --url ${task.observedPr.url} --remote-observation ${shq(join(S, 'remote-observation.json'))}`,
          {
            kind: 'pr-observed',
            owner: 'model',
            question: 'ben needs to finish recording an already-existing pull request — start a ben session in this repo.',
            why: "This is ben's own follow-up (regenerating the PR body, fetching the remote observation, recording it); no decision of yours is pending here.",
            options: [],
            binding: { intentHash: task.observedPr.intentHash, reviewBaseSha: task.reviewBase.sha },
          },
        );
      }
      if (!isObj(task.observedPr.mismatch) || task.observedPr.mismatch.reviewBaseSha !== task.reviewBase.sha) {
        // the gate presentation is a durable fact: record-pr-unusable answers
        // a presented gate, never an unseen one
        task.observedPr.mismatch = { at: new Date().toISOString(), reviewBaseSha: task.reviewBase.sha };
        saveTask(task);
        log(`observedPr head mismatch presented (reviewed ${task.reviewBase.sha}, observed ${task.observedPr.headSha})`);
      }
      gate(
        `run: HUMAN GATE — observed remote PR head mismatch\n` +
          `observed PR: ${task.observedPr.url} (head ${task.observedPr.headSha})\n` +
          `freshly reviewed HEAD: ${task.reviewBase.sha}\n` +
          `ben will not guess how the remote PR should be updated.\n` +
          `Options:\n` +
          `  ABORT → write .ben/ABANDON.md with the reason\n` +
          `  declare the observed PR no longer governing → run.mjs record-pr-unusable --intent-hash ${task.observedPr.intentHash} --by <you>`,
        {
          kind: 'pr-observed',
          owner: 'human',
          question: 'An older pull request exists on GitHub, but the code ben just finished reviewing is newer — should the old PR stop governing this task?',
          why: 'ben will not guess how a remote PR should be updated; declaring it no longer governing (or abandoning) is your call.',
          options: [],
          binding: { intentHash: task.observedPr.intentHash, reviewBaseSha: task.reviewBase.sha },
          notes:
            'Start a ben session in this repo: ben explains the two paths and prepares the exact recorded command — you only decide. The full packet below carries the exact commands if you prefer to run them yourself.',
        },
      );
    }

    const title = task.title ?? task.taskId ?? 'ben task';
    const pr = referee('pr.mjs', [S, '--repo', REPO, '--title', title]);
    if (pr.exitCode !== 0) fail(`pr.mjs exited ${pr.exitCode}: ${pr.output}`);
    log('pr-body assembled');

    // attempt numbering is monotonic over the archived history — a fresh intent
    // after a migration never reuses (or resurrects) an archived attempt
    const attempt = Math.max(0, ...(task.prAttempts ?? []).map((a) => (Number.isInteger(a.attempt) ? a.attempt : 0))) + 1;
    task.prIntent = { attempt, branch: currentBranch(), headSha: task.reviewBase.sha, rootCommit: task.repo.rootCommit, at: new Date().toISOString(), publication: publicationFor(task) };
    saveTask(task); // durable BEFORE the create instruction can exist
    pauseAt('after-pr-intent');
    emitPrCreateInstruction(task);
  }
}

/**
 * boundary invariant, centralized: no downstream stage consumes
 * approval-bound artifacts/config after an external command unless the
 * approval binding is still current AND no verification command moved HEAD.
 * STOP is fail-closed: evidence and tallies from the tainted attempt stay on
 * disk but are consumed by nothing — the next derivation re-earns everything
 * fresh, and rewritten bytes are never blessed implicitly.
 */
function requireChainConsistent(task, chainHead, where) {
  const apr = approvalState(task);
  if (!apr.present || !apr.matches) {
    stop(
      `the approval no longer matches the on-disk artifacts (${where})`,
      'A verification command (or another writer) changed an approval-bound artifact or the config mid-chain.\nNothing after this boundary consumed the changed bytes; the next run re-presents the plan phase. Rewritten bytes are never blessed implicitly.',
    );
  }
  if (headSha() !== chainHead) {
    stop(
      `a verification command moved HEAD during the chain (${where})`,
      `chain HEAD: ${chainHead}\nHEAD now: ${headSha()}\nMake the command side-effect-free, or deliberately bless the new state and re-run next — the whole chain (scope, gates, criteria) re-runs at the new HEAD. Mixed-HEAD evidence is never review authority.`,
    );
  }
}

// single-quote shell quoting: title and paths are data, never shell syntax
function shq(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

/** The publication shape a fresh intent carries: the task's mode and (in update mode) the PR it updates. */
function publicationFor(task) {
  const p = task.assignment?.publication;
  if (isObj(p) && p.mode === 'update') return { mode: 'update', prUrl: p.pr.url };
  return { mode: 'create' };
}

function emitPrCreateInstruction(task) {
  // under --json the runner performs publication from durable
  // task.prIntent; the printed instruction stays for interactive use
  setResult({
    outcome: 'publish',
    publication: {
      attempt: task.prIntent.attempt,
      branch: task.prIntent.branch,
      headSha: task.prIntent.headSha,
      title: task.title ?? task.taskId ?? 'ben task',
      bodyPath: join(S, 'pr-body.md'),
      ...(task.prIntent.publication ?? publicationFor(task)),
    },
  });
  instruct(
    `PR body is at ${join(S, 'pr-body.md')}. Create the PR (attempt ${task.prIntent.attempt}, this instruction is emitted exactly once per authorized attempt):\n` +
      `  git push -u origin ${shq(task.prIntent.branch)}\n` +
      `  gh pr create --title ${shq(prTitleFor(task.title ?? task.taskId ?? 'ben task'))} --body-file ${shq(join(S, 'pr-body.md'))}\n` +
      `  gh pr view <the PR url> --json url,body,headRefOid,updatedAt > ${shq(join(S, 'remote-observation.json'))}\n` +
      `  run.mjs record-pr --url <the PR url> --remote-observation ${shq(join(S, 'remote-observation.json'))}\n` +
      `Report the PR URL to the human — the human merges, ben never does.`,
    'publication',
  );
}

// ---------------------------------------------------------------------------
// init / adopt / status

function cmdInit() {
  acquireLock();
  if (existsSync(TASK_PATH)) stop('task.json already exists — one task, one state dir', `file: ${TASK_PATH}`);
  // a follow-up task starts in a dir holding ONLY the moved
  // history and the lineage record; anything else is a dirty dir as before
  const tolerated = ['history', 'lineage.json', 'runner.lock']; // the runner holds its lock across the follow-up transition
  if (existsSync(S) && readdirSync(S).some((f) => !f.startsWith('.') && !tolerated.includes(f))) {
    stop(`${S} is not empty — a new task starts clean; adopt an existing task deliberately`, `contents: ${readdirSync(S).join(', ')}\nUse: run.mjs adopt --base <sha> --by <you> --confirm`);
  }
  let assignment;
  if (!isBlank(values.assignment)) {
    const raw = readJson(resolvePath(values.assignment), 'assignment file');
    if (raw === undefined) fail(`--assignment file not found: ${values.assignment}`);
    const issues = assignmentIssues(raw);
    if (issues.length > 0) fail(`--assignment is not a valid assignment:\n- ${issues.join('\n- ')}`);
    assignment = raw;
  }
  mkdirSync(S, { recursive: true });
  if (git(['rev-parse', 'HEAD'], { allowFail: true }).status !== 0) {
    fail('the repository has no commits — ben needs a baseline (greenfield repos start from an empty root commit)');
  }
  const task = {
    sequencerVersion: SEQUENCER_VERSION,
    assignmentId: randomUUID(),
    ...(values.title ? { title: values.title } : {}),
    base: headSha(),
    repo: { rootCommit: rootCommit() },
    config: {
      greenfield: values.greenfield,
      e2ePaths: values['e2e-paths'],
      planRounds: positiveInt(values['plan-rounds'], 'plan-rounds'),
      diffRounds: positiveInt(values['diff-rounds'], 'diff-rounds'),
      planRoundsMax: hardCapInt(values['plan-rounds-max'], 'plan-rounds-max', values['plan-rounds']),
      diffRoundsMax: hardCapInt(values['diff-rounds-max'], 'diff-rounds-max', values['diff-rounds']),
      gateFixes: positiveInt(values['gate-fixes'], 'gate-fixes'),
      verifyFixes: positiveInt(values['verify-fixes'], 'verify-fixes'),
      timeoutMs: positiveInt(values.timeout, 'timeout'),
    },
    ...(assignment !== undefined ? { assignment } : {}),
  };
  if (assignment !== undefined && currentBranch() !== assignment.publication.branch) {
    fail(`--assignment names branch ${assignment.publication.branch} but the repo is on ${currentBranch()} — init runs on the task branch`);
  }
  saveTask(task);
  // the referee's own start-of-task operation: seeds rounds.json with the plan
  // tally so every later referee agrees on the file's shape
  const reset = referee('pregate.mjs', [S, '--reset']);
  if (reset.exitCode !== 0) fail(`pregate.mjs --reset exited ${reset.exitCode}: ${reset.output}`);
  log(`task initialized (base ${task.base})`);
  console.log(
    `run: task initialized — base ${task.base}, branch ${currentBranch()}.\n` +
      `Review budgets: plan ${task.config.planRounds} round(s), hard cap ${task.config.planRoundsMax}; diff ${task.config.diffRounds} round(s), hard cap ${task.config.diffRoundsMax}. ` +
      `Converging reviews continue autonomously up to the hard cap — your boundary.\n` +
      `Add ".ben/" to .gitignore if it is not already there.\n` +
      `Next: run.mjs next`,
  );
}

function positiveInt(raw, name) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) fail(`--${name} must be a positive integer, got "${raw}"`);
  return n;
}

// the operator's hard review boundary (convergence-aware continuation):
// defaults to 3× the soft budget when the flag is absent; an explicit value
// below the soft budget is refused — the boundary must dominate the budget,
// and every stored cap (explicit or defaulted) must be a safe integer
function hardCapInt(raw, name, softRaw) {
  const softName = name.replace(/-max$/, '');
  const soft = positiveInt(softRaw, softName);
  if (raw === undefined) {
    const def = 3 * soft;
    if (!Number.isSafeInteger(def)) fail(`--${softName} ${soft} is too large to default --${name} (3×) — pass --${name} explicitly`);
    return def;
  }
  const n = positiveInt(raw, name);
  if (n < soft) fail(`--${name} must be >= --${softName} (${soft}), got ${n}`);
  return n;
}

function legacyWarnings() {
  const warnings = [];
  const ledger = existsSync(join(S, 'ledger.jsonl')) ? readLedger() : [];
  const reviewsDir = join(S, 'reviews');
  const reviewFiles = existsSync(reviewsDir) ? readdirSync(reviewsDir) : [];
  const roundsSeen = new Set(ledger.filter((e) => e.round > 0).map((e) => `${e.kind}-round-${e.round}`));
  for (const key of roundsSeen) {
    if (!reviewFiles.some((f) => f.startsWith(`${key}-`))) warnings.push(`ledger records ${key.replace('-round-', ' round ')} but reviews/ holds no file for it (orphaned history — a partial seed lies)`);
  }
  return warnings;
}

function cmdAdopt() {
  acquireLock();
  if (values.rebind) {
    // an existing task deliberately moved to another clone/worktree: only the
    // repo binding changes, as a recorded human act
    const task = requireTask();
    if (isBlank(values.by)) fail('--by <user> is required — a rebind is a recorded human act');
    if (git(['cat-file', '-e', `${task.base}^{commit}`], { allowFail: true }).status !== 0) {
      fail(`the task base ${task.base} is not reachable in this repository — this is not a home for this task`);
    }
    if (!values.confirm) {
      console.log(`run: rebind dry run — task bound to root ${task.repo.rootCommit}, this repo's root is ${rootCommit()}. Re-run with --confirm.`);
      process.exit(0);
    }
    task.repo = { rootCommit: rootCommit() };
    task.adoption = { by: values.by, at: new Date().toISOString(), suppliedBase: task.base, rebind: true };
    saveTask(task);
    log(`rebound to root ${task.repo.rootCommit} by ${values.by}`);
    console.log(`run: rebound to this repository (root ${task.repo.rootCommit}). Next: run.mjs next`);
    process.exit(0);
  }
  if (existsSync(TASK_PATH)) stop('task.json already exists — nothing to adopt (a deliberate repo move is: adopt --rebind --by <you> --confirm)', `file: ${TASK_PATH}`);
  if (!existsSync(S)) fail(`${S} does not exist — nothing to adopt (use init)`);
  if (isBlank(values.base)) fail('--base <sha> is required: the implementation baseline is not derivable from artifacts — the human supplies it');
  if (isBlank(values.by)) fail('--by <user> is required: adoption is a recorded human act');
  if (git(['cat-file', '-e', `${values.base}^{commit}`], { allowFail: true }).status !== 0) {
    fail(`--base ${values.base} is not a commit in this repository`);
  }

  const rounds = readRounds();
  const ledger = existsSync(join(S, 'ledger.jsonl')) ? readLedger() : [];
  const warnings = legacyWarnings();
  const appr = readJson(join(S, 'approval.json'), 'approval.json');
  // legacy = the recorded binding does not cover every approval-bound artifact
  // present on disk (the pre-sequencer format hashed plan+criteria[+promises]
  // only) or the canonical config member
  const requiredBindings = [...APPROVAL_FILES.filter((n) => n !== 'gates.json' || existsSync(join(S, n))), 'config'];
  const legacyApproval = appr !== undefined && (!isObj(appr.sha256) || !requiredBindings.every((n) => n in appr.sha256));

  const summary =
    `run: adoption summary for ${S}\n` +
    `rounds.json: ${JSON.stringify(rounds)}\n` +
    `ledger (${ledger.length} entries):\n${renderLedger(ledger)}\n` +
    `approval: ${appr === undefined ? 'none' : legacyApproval ? 'LEGACY format — will be re-presented for full binding' : 'present'}\n` +
    (warnings.length > 0 ? `warnings:\n- ${warnings.join('\n- ')}\n` : '');

  if (!values.confirm) {
    console.log(`${summary}\nDry run. Re-run with --confirm to adopt (base ${values.base}, by ${values.by}).`);
    process.exit(0);
  }
  const task = {
    sequencerVersion: SEQUENCER_VERSION,
    ...(values.title ? { title: values.title } : {}),
    base: values.base,
    repo: { rootCommit: rootCommit() },
    config: {
      greenfield: values.greenfield,
      e2ePaths: values['e2e-paths'],
      planRounds: positiveInt(values['plan-rounds'], 'plan-rounds'),
      diffRounds: positiveInt(values['diff-rounds'], 'diff-rounds'),
      planRoundsMax: hardCapInt(values['plan-rounds-max'], 'plan-rounds-max', values['plan-rounds']),
      diffRoundsMax: hardCapInt(values['diff-rounds-max'], 'diff-rounds-max', values['diff-rounds']),
      gateFixes: positiveInt(values['gate-fixes'], 'gate-fixes'),
      verifyFixes: positiveInt(values['verify-fixes'], 'verify-fixes'),
      timeoutMs: positiveInt(values.timeout, 'timeout'),
    },
    adoption: { by: values.by, at: new Date().toISOString(), suppliedBase: values.base },
    assignmentId: randomUUID(),
  };
  if (legacyApproval) {
    unlinkSync(join(S, 'approval.json')); // re-presented under full binding — never silently grandfathered
  }
  saveTask(task);
  log(`adopted by ${values.by} (base ${values.base})`);
  console.log(
    `${summary}\nAdopted. Review budgets: plan ${task.config.planRounds} round(s), hard cap ${task.config.planRoundsMax}; diff ${task.config.diffRounds} round(s), hard cap ${task.config.diffRoundsMax}. ${legacyApproval ? 'The legacy approval was cleared; the approval gate will re-present under full binding. ' : ''}Next: run.mjs next`,
  );
}

/** every human-kind record row with its actor — the runner's actor-audit input. */
function actorRows(task) {
  const rows = [];
  const push = (kind, by, at, extra = {}) => rows.push({ kind, by: by ?? null, at: at ?? null, ...extra });
  const appr = readJson(join(S, 'approval.json'), 'approval.json');
  if (appr !== undefined) push('approval', appr.approvedBy, appr.at);
  if (existsSync(S)) {
    for (const f of readdirSync(S)) {
      if (/^approval\.superseded-.*\.json$/.test(f)) {
        const a = readJson(join(S, f), f);
        if (a !== undefined) push('approval-superseded', a.approvedBy, a.at, { file: f });
      }
    }
  }
  for (const v of readVetoLog()) {
    if ((v.type ?? 'decision') !== 'decision') continue;
    // a policy row is legal ONLY when it is the D3 confirm with its basis
    const policy = v.by === 'ben-policy:empty-veto' && isObj(v.response) && v.response.decision === 'confirm' && v.response.vetoes === undefined && isObj(v.basis) && v.basis.rule === 'D3-empty-veto';
    push('veto', v.by ?? null, v.at, { kind2: v.kind, round: v.round, policy });
  }
  const rounds = readJson(join(S, 'rounds.json'), 'rounds.json') ?? {};
  for (const g of Array.isArray(rounds.grants) ? rounds.grants : []) push('grant', g.by, g.at, { gateKind: g.kind, rounds: g.rounds });
  const register = readJson(join(S, 'adjudications.json'), 'adjudications.json');
  for (const r of Array.isArray(register) ? register : []) push('adjudication', r.by, r.at, { criterionId: r.criterionId });
  if (task !== undefined) {
    for (const r of task.prRetries ?? []) push('pr-retry', r.by, r.at);
    for (const r of task.prResolutions ?? []) push(`pr-${r.type}`, r.by, r.at);
    for (const r of task.prInspections ?? []) push('pr-inspection', r.by, r.at);
    for (const x of task.supervisorStops ?? []) {
      push('supervisor-stop', x.by, x.at);
      if (x.resolution) push('supervisor-stop-resolution', x.resolution.by, x.resolution.at);
    }
    for (const e of task.limitEvents ?? []) push('limit-event', e.by, e.at);
    for (const e of task.limitExtensions ?? []) push('limit-extension', e.by, e.at, { amount: e.amount, limitKind: e.kind });
    for (const g of task.fixGrants ?? []) push('fix-grant', g.by, g.at, { step: g.step });
    for (const r of task.revisions ?? []) push('revision', r.by, r.at);
    for (const c of task.clarifications ?? []) push('clarification', c.by, c.at);
    if (task.adoption) push('adoption', task.adoption.by, task.adoption.at);
  }
  return rows;
}

function cmdStatus() {
  // read-only: no lock, no referee invocations, no writes
  const task = readJson(TASK_PATH, 'task.json');
  if (values.json) {
    // the machine-readable projection the runner consumes —
    // never authority; the oracle and the record rows are the same ones the
    // text form renders
    const valid = task !== undefined && validTask(task);
    const ws = existsSync(S) ? waitingState(S, REPO) : { state: 'absent' };
    const out = {
      stateDir: S,
      task: task === undefined ? null : valid ? { base: task.base, title: task.title ?? null, assignmentId: task.assignmentId ?? null, assignment: task.assignment ?? null, pr: task.pr ?? null, prIntent: task.prIntent ?? null, gate: task.gate ?? null, reviewBase: task.reviewBase ?? null } : 'INVALID',
      abandoned: existsSync(join(S, 'ABANDON.md')),
      waiting: ws.state === 'current' ? { state: 'current', kind: ws.waiting.kind, owner: ws.waiting.owner, question: ws.waiting.question, gateId: ws.waiting.gateId ?? null, options: ws.waiting.options.map((o) => o.token ?? null) } : { state: ws.state, reason: ws.reason ?? null },
      supervisorStop: valid ? (openSupervisorStop(task) ?? null) : null,
      limitEvent: valid ? (openLimitEvent(task) ?? null) : null,
      rounds: readJson(join(S, 'rounds.json'), 'rounds.json') ?? null,
      openBlockers: (() => {
        const b = readJson(join(S, 'blockers.json'), 'blockers.json');
        return b === undefined ? 0 : Array.isArray(b) ? b.length : 'MALFORMED';
      })(),
      approval: existsSync(join(S, 'approval.json')),
      criteriaMatrix: readJson(join(S, 'evidence', 'criteria-matrix.json'), 'criteria-matrix.json') ?? null,
      actors: valid || task === undefined ? actorRows(task) : [],
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  const facts = [];
  if (!existsSync(S)) {
    console.log('run: no .ben state here.');
    process.exit(0);
  }
  facts.push(`state dir: ${S}`);
  // an invalid task is surfaced as invalid — never cosmetically rendered as a
  // legitimate terminal/publication state (correction)
  if (task !== undefined && !validTask(task)) {
    console.log(`run: status\n- state dir: ${S}\n- task.json: INVALID — does not match the sequencer schema (run.mjs next will STOP; a human reconciles per the playbook)`);
    process.exit(0);
  }
  facts.push(task === undefined ? 'task.json: none (pre-sequencer or fresh dir)' : `task.json: base ${task.base}, ${task.title ? `"${task.title}", ` : ''}v${task.sequencerVersion}`);
  if (existsSync(join(S, 'ABANDON.md'))) facts.push('ABANDONED (ABANDON.md present)');
  const rounds = readJson(join(S, 'rounds.json'), 'rounds.json') ?? {};
  facts.push(`rounds: ${JSON.stringify(rounds)}`);
  // durable review gates are rendered as what they are — a standing human stop
  // or, when they fail the shared validator, illegal durable state by name
  const gatesIssues = roundsGatesIssues(rounds);
  if (gatesIssues.length > 0) {
    facts.push(`rounds.gates: MALFORMED — ${gatesIssues.join('; ')} (run.mjs next will STOP; a human reconciles per the playbook)`);
  } else if (isObj(rounds.gates)) {
    for (const [k, v] of Object.entries(rounds.gates)) facts.push(`review gate standing (${k}): recorded at round ${v.round} — ${v.reason}`);
  }
  const blockers = readJson(join(S, 'blockers.json'), 'blockers.json');
  facts.push(blockers === undefined ? 'open blockers: none' : `open blockers: ${Array.isArray(blockers) ? blockers.length : 'MALFORMED'}`);
  const appr = readJson(join(S, 'approval.json'), 'approval.json');
  facts.push(appr === undefined ? 'approval: none' : `approval: by ${appr.approvedBy ?? '?'} at ${appr.at ?? '?'}`);
  const matrix = readJson(join(S, 'evidence', 'criteria-matrix.json'), 'criteria-matrix.json');
  if (matrix !== undefined && isObj(matrix)) {
    const failing = Object.entries(matrix).filter(([, e]) => e?.status === 'fail').map(([id]) => id);
    facts.push(`criteria matrix: ${Object.keys(matrix).length} entries${failing.length > 0 ? `, FAILING: ${failing.join(', ')}` : ''}`);
  }
  // governing adjudication per manual criterion, or PENDING.
  // Adjudication integrity is derived UNCONDITIONALLY (fail-closed at
  // read) — zero manual criteria never skips the derivation, and invalid
  // state dominates the operator-facing overall status.
  const criteriaDocStatus = readJson(join(S, 'criteria.json'), 'criteria.json');
  const manualCriteria = isObj(criteriaDocStatus) && Array.isArray(criteriaDocStatus.criteria) ? criteriaDocStatus.criteria.filter((c) => isObj(c) && c?.verification?.method === 'manual') : [];
  let adjInvalid;
  try {
    const approvalPathStatus = join(S, 'approval.json');
    const { governing } = deriveAdjudication({
      stateDir: S,
      ledgerEntries: readLedger(),
      criteriaDoc: criteriaDocStatus,
      approvalBytes: existsSync(approvalPathStatus) ? readFileSync(approvalPathStatus) : undefined,
      getHeadSha: () => headSha(),
    });
    for (const c of manualCriteria) {
      const g = governing.get(c.id);
      facts.push(g === undefined ? `manual ${c.id}: PENDING adjudication` : `manual ${c.id}: ADJUDICATED ${g.decision} by ${g.by} at ${g.at}`);
    }
  } catch (err) {
    adjInvalid = err instanceof Error ? err.message : String(err);
    facts.push(`adjudications: INVALID — ${adjInvalid}`);
    facts.unshift('OVERALL: INVALID — the adjudication state fails validation; nothing below is a green state (run.mjs next will STOP; a human reconciles per the playbook)');
  }
  if (task?.prIntent) facts.push(`PR intent: attempt ${task.prIntent.attempt} pending (head ${task.prIntent.headSha})`);
  if (task?.pr) {
    facts.push(
      adjInvalid !== undefined
        ? `PR: ${task.pr.url} — recorded terminal basis (NOT presentable as terminal while adjudications are INVALID)`
        : `PR: ${task.pr.url} — terminal${legacyWarnings().length > 0 ? ' (complete per available evidence — recorded gaps below)' : ''}`,
    );
    if (isObj(task.pr.publication)) facts.push(`publication stamped: body ${task.pr.publication.bodySha} @ ${task.pr.publication.headRefOid}`);
  }
  // the operator's "where are you?" line, first. Read-only —
  // the oracle never writes and never throws; regeneration is next's job.
  const ws = waitingState(S, REPO);
  if (ws.state === 'current') {
    facts.unshift(
      ws.waiting.owner === 'model'
        ? `ben HAS FOLLOW-UP WORK PARKED — ${ws.waiting.question} (details: ${join(S, WAITING_MD)})`
        : `WAITING ON YOU — ${ws.waiting.question} (full brief: ${join(S, WAITING_MD)})`,
    );
  } else if (ws.state === 'stale' || ws.state === 'spent') {
    facts.unshift(`a previous waiting note is out of date (${ws.reason}) — run.mjs next re-presents the current state`);
  } else if (task !== undefined && !task?.pr && !existsSync(join(S, 'ABANDON.md'))) {
    facts.unshift('no current waiting note on record — run run.mjs next (or start a ben session): if a human gate is live it will re-present and republish WAITING.md');
  }
  const warnings = legacyWarnings();
  console.log(`run: status\n${facts.map((f) => `- ${f}`).join('\n')}${warnings.length > 0 ? `\nwarnings:\n- ${warnings.join('\n- ')}` : ''}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// record-* every human decision becomes a hash-bound idempotent record.
// the bodies that `answer` also drives are RETURNING CORES —
// no lock acquisition and no process.exit on their own success/refusal paths
// (shared fail-closed helpers like readJson/readRounds keep their established
// exit semantics, identical from either entry). The CLI commands are thin
// wrappers: lock + core + render, byte-identical observable behavior.

class RecordRefusal extends Error {
  constructor(mode, message, facts = '') {
    super(message);
    this.mode = mode; // 'fail' → exit 3, 'stop' → exit 2 — exactly as before
    this.facts = facts;
  }
}
const refuse = (message) => new RecordRefusal('fail', message);
const refuseStop = (message, facts = '') => new RecordRefusal('stop', message, facts);

/** Run a record core and render its outcome exactly as the pre-core commands did. */
function renderRecordOutcome(fn) {
  let r;
  try {
    r = fn();
  } catch (e) {
    if (e instanceof RecordRefusal) {
      if (e.mode === 'fail') fail(e.message);
      stop(e.message, e.facts);
    }
    throw e;
  }
  console.log(r.message);
}

function requireTask() {
  const task = loadTask();
  if (task === undefined) fail('no task.json — record commands need an initialized task');
  return task;
}

function cmdRecordVeto() {
  acquireLock();
  requireTask();
  if (isBlank(values.response)) fail('--response <file> is required');
  const blockersPath = join(S, 'blockers.json');
  const proposalPath = join(S, 'proposal.json');
  if (!existsSync(blockersPath) || !existsSync(proposalPath)) {
    fail('record-veto needs open blockers.json and proposal.json — there is no veto gate to answer');
  }
  const responseRaw = readFileSync(resolvePath(values.response), 'utf8');
  let response;
  try {
    response = JSON.parse(responseRaw);
  } catch (err) {
    fail(`response file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  renderRecordOutcome(() => coreRecordVeto({ response, by: values.by }));
}

function coreRecordVeto({ response, by = undefined, expect = undefined }) {
  requireTask();
  const blockersPath = join(S, 'blockers.json');
  const proposalPath = join(S, 'proposal.json');
  if (!existsSync(blockersPath) || !existsSync(proposalPath)) {
    throw refuse('record-veto needs open blockers.json and proposal.json — there is no veto gate to answer');
  }
  const confirmShape = isObj(response) && response.decision === 'confirm' && response.vetoes === undefined;
  const vetoShape = isObj(response) && response.decision === undefined && Array.isArray(response.vetoes) && response.vetoes.length > 0 && response.vetoes.every((v) => !isBlank(v));
  if (!confirmShape && !vetoShape) {
    throw refuse('response must be exactly {"decision":"confirm"} or {"vetoes":["<fingerprint>", ...]} — the human decision is structured, never free text');
  }
  const ledgerEntriesNow = readLedger();
  const kind = openBlockersKind(ledgerEntriesNow);
  const proposal = readJson(proposalPath, 'proposal.json');
  if (vetoShape) {
    const proposedRejections = new Set((Array.isArray(proposal) ? proposal : []).filter((p) => isObj(p) && p.action === 'rejected').map((p) => p.fingerprint));
    for (const v of response.vetoes) {
      if (!proposedRejections.has(v)) throw refuse(`veto of ${v} is meaningless — the proposal does not propose rejecting it`);
    }
  }
  const entry = {
    type: 'decision',
    at: new Date().toISOString(),
    kind,
    round: (() => {
      const r = readRounds();
      return Number.isInteger(r[kind]) ? r[kind] : 0;
    })(),
    blockersSha: sha256File(blockersPath),
    proposalSha: sha256File(proposalPath),
    response: confirmShape ? { decision: 'confirm' } : { vetoes: response.vetoes },
    ...(isBlank(response.annotation) ? {} : { annotation: response.annotation }),
    ...(isBlank(by) ? {} : { by: by.trim() }), // the actor, when the answer path knows it
  };
  const existing = findVetoRecord('decision', entry.kind, entry.round, entry.blockersSha, entry.proposalSha);
  if (existing) {
    if (JSON.stringify(existing.response) === JSON.stringify(entry.response)) {
      return { message: 'run: this veto decision is already recorded for exactly these blockers and this proposal — no-op.' };
    }
    throw refuseStop('a different veto decision is already recorded for these exact bytes', `recorded: ${JSON.stringify(existing.response)}\nsubmitted: ${JSON.stringify(entry.response)}\nA changed mind needs a changed proposal (new bytes, new gate).`);
  }
  if (!findVetoRecord('presented', entry.kind, entry.round, entry.blockersSha, entry.proposalSha)) {
    throw refuse('this veto gate was never presented — run.mjs next presents the blockers and proposal to the human first, and records that it did');
  }
  // an answer records ONLY the exact bytes its validation pass saw —
  // a swap to a different (even previously-presented) proposal refuses here
  if (expect !== undefined && (entry.blockersSha !== expect.blockersSha || entry.proposalSha !== expect.proposalSha)) {
    throw refuse('the blockers or proposal changed while your answer was being recorded — nothing was written; run.mjs next re-presents the current state');
  }
  pauseAt('before-veto-append');
  appendJsonl(join(S, 'veto.jsonl'), entry);
  log(`veto recorded (${kind} round ${entry.round}): ${JSON.stringify(entry.response)}`);
  return { message: `run: veto recorded for ${kind} round ${entry.round}. Next: write resolutions.json matching the approved proposal, then run.mjs next` };
}

function cmdRecordApproval() {
  acquireLock();
  renderRecordOutcome(() => coreRecordApproval({ by: values.by, decision: values.decision }));
}

function coreRecordApproval({ by, decision }) {
  requireTask();
  if (isBlank(by)) throw refuse('--by <user> is required');
  if (!['APPROVE', 'RECONCILE', 'ABORT'].includes(decision ?? '')) throw refuse('--decision must be APPROVE, RECONCILE or ABORT');
  if (decision === 'ABORT') {
    return { message: 'run: ABORT chosen — write .ben/ABANDON.md with the reason (the honest exit; it is surfaced, never silent). Nothing else changes.' };
  }
  if (decision === 'RECONCILE') {
    log(`approval gate: ${by} chose RECONCILE`);
    return { message: 'run: RECONCILE chosen — revise plan.md / criteria.json / promises.json / plan-files.json / gates.json; the revision re-enters pregate and a fresh review round via run.mjs next.' };
  }
  if (existsSync(join(S, 'blockers.json'))) throw refuse('cannot approve with open blockers — reconcile first');
  const hashes = approvalHashes(requireTask());
  if (hashes === undefined) throw refuse('cannot approve: a required plan artifact is missing');
  // the approval must answer a presented packet: run.mjs next records the gate
  // (hash-bound) when it puts the artifacts in front of the human. No packet,
  // no approval — pregate, review and GO all precede that presentation.
  const presentedGate = requireTask().approvalGate;
  if (!isObj(presentedGate) || JSON.stringify(presentedGate.hashes) !== JSON.stringify(hashes)) {
    throw refuse('no APPROVE BUILD packet has been presented for these exact artifact bytes — run.mjs next presents it (after review reaches GO); approve only what was displayed');
  }
  // the freshness comparison uses the APPROVAL-RELEVANT ledger digest —
  // inert audit rows (adjudication/publication) are approval-neutral and never
  // block a replay; any raised/resolved/granted/reconciliation change still
  // fails exactly as before. Check order is untouched: open blockers first,
  // packet hash, this digest, then the no-op. Legacy stamps ('ABSENT' when no
  // ledger file existed; a full-file digest when every row was plan|diff;
  // sha256 of zero bytes for a zero-byte file) compare correctly by
  // construction (ledgerStampMatches handles the two canonical empty shapes).
  let ledgerShaNow;
  try {
    ledgerShaNow = approvalRelevantLedgerSha(join(S, 'ledger.jsonl'));
  } catch (err) {
    throw refuseStop(`the ledger cannot be digested for approval freshness: ${err instanceof Error ? err.message : String(err)}`, `file: ${join(S, 'ledger.jsonl')}\nNo approval decision was made.`);
  }
  if (!ledgerStampMatches(presentedGate.ledgerSha, ledgerShaNow)) {
    throw refuse('the ledger changed after the packet was presented — run.mjs next re-presents the gate');
  }
  const existing = readJson(join(S, 'approval.json'), 'approval.json');
  if (existing !== undefined && isObj(existing.sha256) && JSON.stringify(existing.sha256) === JSON.stringify(hashes)) {
    return { message: 'run: these exact artifact bytes are already approved — no-op.' };
  }
  pauseAt('before-approval-write');
  // actId makes every approval act byte-unique and clock-independent —
  // an A→B→A content resurrection can never revive act-1-bound records.
  // Legacy approvals without actId stay valid as-is.
  atomicWriteJson(join(S, 'approval.json'), { approvedBy: by, at: new Date().toISOString(), actId: randomUUID(), decision: 'APPROVE', sha256: hashes });
  log(`build approved by ${by}`);
  return { message: `run: approval recorded, bound to ${Object.keys(hashes).length} artifact hashes. Next: run.mjs next (implementation).` };
}

/** The half-applied grant window, derived from an unconsumed grant intent: {intent, grant} or undefined. */
function halfAppliedGrant(task) {
  for (const g of (task.grantIntents ?? []).filter((x) => isObj(x) && x.consumed === false)) {
    const m = /^(.*)\|(plan|diff)\|(\d+)\|tally(\d+)$/.exec(g.key);
    if (!m) continue;
    const [, by, kind, roundsStr, tallyStr] = m;
    const granted = Number(roundsStr);
    const tally = Number(tallyStr);
    const rounds = readRounds();
    const grantsAfter = (Array.isArray(rounds.grants) ? rounds.grants : []).slice(g.grantsBefore).filter((x) => isObj(x) && x.kind === kind && x.rounds === granted && x.by === by);
    const auditAfter = readLedger()
      .filter((e) => e.action === 'granted')
      .slice(g.ledgerBefore)
      .filter((e) => e.reviewer === by && e.kind === kind && e.round === tally && String(e.detail).includes(`granted ${granted} more ${kind}`));
    if (grantsAfter.length > 0 && auditAfter.length === 0) return { intent: g, grant: grantsAfter[grantsAfter.length - 1] };
  }
  return undefined;
}

function cmdRecordGrant() {
  acquireLock();
  renderRecordOutcome(() => coreRecordGrant({ by: values.by, kind: values.kind, rounds: values.rounds }));
}

function coreRecordGrant({ by: rawBy, kind: grantKind, rounds: rawRounds, conditionalOnGate = undefined, slot = undefined }) {
  const task = requireTask();
  if (isBlank(rawBy)) throw refuse('--by <user> is required');
  // ONE actor normalization — identical at key construction, referee
  // invocation, durable write (ledger.mjs trims), and replay comparison
  const by = rawBy.trim();
  if (grantKind !== 'plan' && grantKind !== 'diff') throw refuse('--kind must be plan or diff');
  const granted = positiveInt(rawRounds, 'rounds');
  // an answer-driven grant is
  // CONDITIONAL on the exact live gate it answers. The callback re-proves the
  // stop is still owed BEFORE this core mutates anything (its own intent
  // write would otherwise flip the state-bound note stale) and returns the
  // sha256 of the rounds.json bytes it validated; the referee then applies
  // the grant as a compare-and-swap on those exact bytes — a stop cleared at
  // ANY later instant refuses at the authoritative boundary with zero writes.
  let expectRoundsSha;
  if (conditionalOnGate !== undefined) {
    expectRoundsSha = conditionalOnGate();
    if (expectRoundsSha === undefined) {
      throw refuse('the review stop was cleared while your answer was being recorded — nothing was granted; run.mjs next continues from the recorded state');
    }
  }
  // preflight BEFORE any mutation (task.json included): invalid or
  // divergent adjudication state STOPs the end-to-end command with zero writes
  adjudicationSnapshot();
  const rounds = readRounds();
  const tally = Number.isInteger(rounds[grantKind]) ? rounds[grantKind] : 0;
  const key = `${by}|${grantKind}|${granted}|tally${tally}`;
  const grantsCount = () => (Array.isArray(readRounds().grants) ? readRounds().grants.length : 0);
  const ledgerGrantCount = () => readLedger().filter((e) => e.action === 'granted').length;

  task.grantIntents = Array.isArray(task.grantIntents) ? task.grantIntents : [];
  // canonical lookup PLUS legacy compatibility: a pre-normalization intent
  // keyed with a whitespace-bearing actor still names this same semantic act
  // (its durable half was always written trimmed) — it must replay, never
  // trigger a second human authorization. New intents are canonical-only.
  const legacySuffix = `|${grantKind}|${granted}|tally${tally}`;
  const matches = task.grantIntents.filter(
    (g) => g.key === key || (g.key.endsWith(legacySuffix) && g.key.slice(0, -legacySuffix.length).trim() === by),
  );
  if (matches.length > 1) {
    throw refuseStop(
      'ambiguous grant intents: more than one stored intent normalizes to this exact grant identity',
      `identity: ${key}\nintents: ${JSON.stringify(matches)}\nThe intended act cannot be uniquely established — a human reconciles per the playbook; no grant is issued on a guess.`,
    );
  }
  const existing = matches[0];
  if (existing) {
    // the referee's own durable state, matched to THIS grant's EXACT canonical
    // identity (actor|kind|amount|tally — the same tuple the key encodes):
    // another grant's landing, including an earlier look-alike at a different
    // tally, must never mark this one consumed
    const roundsNow = readRounds();
    const grantsAfter = (Array.isArray(roundsNow.grants) ? roundsNow.grants : [])
      .slice(existing.grantsBefore)
      .filter((g) => isObj(g) && g.kind === grantKind && g.rounds === granted && g.by === by);
    const auditAfter = readLedger()
      .filter((e) => e.action === 'granted')
      .slice(existing.ledgerBefore)
      .filter((e) => e.reviewer === by && e.kind === grantKind && e.round === tally && String(e.detail).includes(`granted ${granted} more ${grantKind}`));
    if (existing.consumed) {
      // consumed is bookkeeping, never proof — the short-circuit must find the
      // act itself in the durable state, else the flag is fabricated/rolled-back
      if (grantsAfter.length > 0 && auditAfter.length > 0) {
        return { message: 'run: this exact grant is already recorded — no-op.' };
      }
      throw refuseStop(
        'the grant intent is marked consumed but the recorded grant is absent from the durable state',
        `intent: ${JSON.stringify(existing)}\nrounds.json landed: ${grantsAfter.length > 0}\nledger landed: ${auditAfter.length > 0}\nA consumed flag is bookkeeping, never proof of the act — a human reconciles per the playbook.`,
      );
    }
    if (grantsAfter.length > 0 && auditAfter.length > 0) {
      existing.consumed = true;
      saveTask(task);
      return { message: 'run: this exact grant had already landed in rounds.json and the ledger — intent marked consumed, no-op.' };
    }
    if (grantsAfter.length > 0 && auditAfter.length === 0) {
      throw refuseStop('the grant reached rounds.json but its ledger audit entry is missing (crash inside ledger.mjs grant)', `intent: ${JSON.stringify(existing)}\nPlaybook: a human restores the audit entry or removes the half-applied grant — never both silently.`);
    }
    if (grantsAfter.length === 0 && auditAfter.length > 0) {
      // the fourth arm of the crash matrix: ONE landed half — ledger-only —
      // STOPs like rounds-only does; re-invoking would duplicate a human
      // authorization on top of the existing audit act
      throw refuseStop('the grant is recorded in the ledger but its rounds.json half is missing (rolled back or corrupted)', `intent: ${JSON.stringify(existing)}\nPlaybook: a human restores rounds.json or removes the half-applied act — never both silently; no second authorization is issued.`);
    }
    // NEITHER landed: fall through and invoke the referee under this same intent
  } else {
    // the answered review-stop slot rides the intent so a
    // half-applied grant can be rolled back to the ORIGINAL gate identity
    // even after later presentations moved task.gate
    task.grantIntents.push({ key, consumed: false, grantsBefore: grantsCount(), ledgerBefore: ledgerGrantCount(), ...(isObj(slot) && Number.isSafeInteger(slot.round) && !isBlank(slot.reason) ? { slot: { round: slot.round, reason: slot.reason } } : {}) });
    saveTask(task);
  }
  pauseAt('after-grant-intent');
  const res = referee('ledger.mjs', [
    'grant',
    S,
    '--kind',
    grantKind,
    '--rounds',
    String(granted),
    '--by',
    by,
    ...(expectRoundsSha !== undefined ? ['--expect-rounds-sha', expectRoundsSha] : []),
  ]);
  if (res.exitCode !== 0) throw refuse(`ledger.mjs grant exited ${res.exitCode}: ${res.output}`);
  const intent = existing ?? task.grantIntents.find((g) => g.key === key);
  intent.consumed = true;
  saveTask(task);
  log(`grant recorded: ${key}`);
  return { message: res.output };
}

// ---------------------------------------------------------------------------
// answer — the operator intake. A TRANSLATOR in front of the
// existing record cores: it validates the parked question is still owed (the
// shared oracle), maps CODE-OWNED tokens onto the same cores the direct
// commands drive, and cleans up the projection. It grants nothing the record
// layer would refuse; every refusal keeps that layer's exact semantics.

/** The legal answer tokens per gate kind — code, never projection content. */
function legalTokensFor(w) {
  switch (w.kind) {
    case 'approval':
      return ['approve', 'revise', 'abort'];
    case 'veto':
      return ['accept', ...vetoTokensNow().map((v) => v.token), 'abort'];
    case 'review-stop':
      return ['continue', 'abort'];
    case 'fix-cap':
      // one more attempt is grantable for the verify steps and the
      // plan-round budget; commits/honesty thresholds are referee constants
      return FIX_GRANT_STEPS.includes(w.binding?.step) || w.binding?.step === 'plan-rounds' ? ['continue', 'abort'] : ['abort'];
    case 'manual-adjudication':
      return ['satisfied', 'accepted', 'abort'];
    case 'clarify':
      return ['reply', 'abort'];
    case 'supervisor-stop':
      return ['continue', 'abort'];
    case 'limit':
      return ['continue', 'abort'];
    case 'pr-retry':
    case 'pr-head-mismatch':
      return ['retry', 'abort'];
    case 'pr-branch-conflict':
      return ['abort']; // `reinspect` is the runner's observation act, never an answer
    case 'pr-observed':
      return w.owner === 'human' ? ['release', 'abort'] : [];
    default:
      return []; // pr-pending/pr-record/pr-migration, playbook stops, abandoned: no one-word answers
  }
}

/** The plain-text reply an answer may carry (`--reply` inline or `--reply-file`). */
function replyText() {
  if (!isBlank(values.reply) && !isBlank(values['reply-file'])) fail('use --reply or --reply-file, not both');
  if (!isBlank(values.reply)) return values.reply;
  if (!isBlank(values['reply-file'])) {
    const p = resolvePath(values['reply-file']);
    if (!existsSync(p)) fail(`--reply-file not found: ${p}`);
    return readFileSync(p, 'utf8');
  }
  return undefined;
}

/** name the resolution of an answered question where the records say who/when. */
function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function resolutionOf(g, fallback = 'resolved by a recorded act') {
  if (!isObj(g)) return fallback;
  const b = g.binding ?? {};
  try {
    switch (g.kind) {
      case 'approval': {
        const a = readJson(join(S, 'approval.json'), 'approval.json');
        if (a && JSON.stringify(a.sha256) === JSON.stringify(b.hashes)) return `approved by ${a.approvedBy} at ${a.at}`;
        const rev = (CURRENT_TASK?.revisions ?? []).find((r) => JSON.stringify(r.hashes) === JSON.stringify(b.hashes));
        if (rev) return `revision requested by ${rev.by} at ${rev.at}`;
        break;
      }
      case 'veto': {
        const v = readVetoLog().find((e) => (e.type ?? 'decision') === 'decision' && e.blockersSha === b.blockersSha && e.proposalSha === b.proposalSha);
        if (v) return `${JSON.stringify(v.response)} by ${v.by ?? '(unrecorded actor)'} at ${v.at}`;
        break;
      }
      case 'supervisor-stop': {
        const x = (CURRENT_TASK?.supervisorStops ?? []).find((y) => y.id === b.stopId);
        if (x?.resolution) return `continue by ${x.resolution.by} at ${x.resolution.at}`;
        break;
      }
      case 'limit': {
        const e = (CURRENT_TASK?.limitExtensions ?? []).find((y) => y.eventId === b.eventId);
        if (e) return `extended ${e.kind} +${e.amount} by ${e.by} at ${e.at}`;
        break;
      }
      case 'fix-cap': {
        const f = (CURRENT_TASK?.fixGrants ?? []).find((y) => y.step === b.step && y.tallyAt === b.tallyAt);
        if (f) return `one more ${f.step} attempt granted by ${f.by} at ${f.at}`;
        break;
      }
      case 'clarify': {
        const c = (CURRENT_TASK?.clarifications ?? []).find((y) => y.questionsSha === b.questionsSha);
        if (c) return `answered by ${c.by} at ${c.at}`;
        break;
      }
      case 'pr-retry':
      case 'pr-head-mismatch': {
        const r = (CURRENT_TASK?.prRetries ?? []).find((y) => y.intentHash === b.intentHash && y.inspectionSha === b.inspectionSha);
        if (r) return `retry authorized by ${r.by} at ${r.at}`;
        break;
      }
      default:
        break;
    }
  } catch {
    /* fall through */
  }
  if (existsSync(join(S, 'ABANDON.md'))) return `abandoned: ${readFileSync(join(S, 'ABANDON.md'), 'utf8').split('\n')[0]}`;
  return fallback;
}

/** veto-<n> → fingerprint, derived from the AUTHORITATIVE proposal bytes (the
 * oracle already proved they equal the parked binding's proposalSha). */
function vetoTokensNow() {
  const proposal = readJson(join(S, 'proposal.json'), 'proposal.json');
  return (Array.isArray(proposal) ? proposal : [])
    .filter((p) => isObj(p) && p.action === 'rejected')
    .map((p, i) => ({ token: `veto-${i + 1}`, fingerprint: p.fingerprint }));
}

/** The honest exit as a returning core: O_EXCL create, idempotent replay, conflict refused. */
function coreAbandon({ note, by }) {
  if (isBlank(note)) throw refuse('"abort" requires --note "<why>" — abandoning without a stated reason is a silent gap');
  const p = join(S, 'ABANDON.md');
  const reason = note.trim().split('\n')[0].trim();
  const conflictOrReplay = () => {
    const first = readFileSync(p, 'utf8').split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    if (first === reason) return { message: 'run: ABANDON.md already records this exact reason — no-op.' };
    throw refuseStop('a different ABANDON reason is already recorded', `recorded: ${first}\nsubmitted: ${reason}\nOne honest exit, one reason — a human resolves a genuine difference by hand.`);
  };
  if (existsSync(p)) return conflictOrReplay();
  // the reason is fully written to a temp file FIRST, then linked
  // into place — link fails with EEXIST rather than replacing, so the
  // O_EXCL conflict semantics hold AND an interrupted write can never publish
  // an empty/partial authoritative abandon file.
  const tmp = join(S, `.abandon-tmp-${process.pid}`);
  try {
    writeFileSync(tmp, `${reason}\n\nabandoned by ${by} at ${new Date().toISOString()} (via run.mjs answer)\n`);
    linkSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    if (err && err.code === 'EEXIST') return conflictOrReplay();
    throw refuse(`ABANDON.md cannot be written: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* best effort — the published file is the authority */
  }
  log(`abandoned via answer by ${by}: ${reason}`);
  return { message: 'run: task abandoned — .ben/ABANDON.md written. The state stays intact for inspection; deleting ABANDON.md (a human act) reopens it.' };
}

function cmdAnswer() {
  acquireLock(); // ONE lock held across liveness validation → record → cleanup (no TOCTOU)
  CURRENT_TASK = requireTask();
  const st = waitingState(S, REPO);
  const lastGate = CURRENT_TASK.gate;
  if (st.state === 'absent') {
    if (!isBlank(values['expect-gate']) && isObj(lastGate) && lastGate.id === values['expect-gate']) {
      // the answered projection is gone, but the authoritative gate record names
      // exactly the question this answer targets: it was already answered
      console.log(`run: that question was already answered (${resolutionOf(lastGate)}) — your answer was NOT applied, nothing changed. run.mjs next (or the runner) continues from the recorded state.`);
      process.exit(1);
    }
    console.log('run: nothing is waiting on you here — run.mjs status shows where the task is; run.mjs next (or a ben session) continues it.');
    process.exit(1);
  }
  if (st.state === 'spent') {
    console.log(`run: that question was already answered (${resolutionOf(readJsonIfPresent(join(S, WAITING_JSON)) ?? lastGate, st.reason)}) — your answer was NOT applied, nothing changed. run.mjs next (or the runner) continues from the recorded state.`);
    process.exit(1);
  }
  if (st.state !== 'current') {
    console.log(
      `run: the parked question is out of date (${st.reason}) — your answer was NOT applied, nothing was changed. Run run.mjs next (or start a ben session) to re-present the current state.`,
    );
    process.exit(1);
  }
  const w = st.waiting;
  if (w.owner === 'model') {
    console.log("run: the current stop is ben's own follow-up work, not your decision — start a ben session in this repo (or run run.mjs next) to continue. Nothing was changed.");
    process.exit(1);
  }
  // the gate identity check reads the AUTHORITATIVE record
  // (task.gate), never the projection's own id — a forged or stale note can
  // never satisfy it; the check and the record happen under the one lock
  const expectGate = values['expect-gate'];
  if (!isBlank(expectGate)) {
    const g = CURRENT_TASK.gate;
    if (!isObj(g) || g.id !== expectGate || g.kind !== w.kind) {
      console.log(
        `run: the question changed since it was shown to you (you answered gate ${expectGate}; the current one is ${isObj(g) ? g.id : 'unrecorded'}). Nothing was changed. Here is the current question:\n` +
          `  ${w.question}\n` +
          (w.options ?? []).map((o) => `  - ${o.label}: ${o.command}`).join('\n'),
      );
      process.exit(1);
    }
  }
  if (isBlank(values.by)) fail('--by <user> is required — an answer is a recorded human act');
  const chosen = Array.isArray(values.choose) ? values.choose : [];
  if (chosen.length === 0) fail(`--choose <token> is required — ${join(S, 'WAITING.md')} lists the legal answers`);
  const tokens = legalTokensFor(w);
  if (tokens.length === 0) {
    console.log(`run: this question has no one-word answers — ${join(S, 'WAITING.md')} explains what it needs (typically a ben session, or the exact commands in its full packet). Nothing was changed.`);
    process.exit(1);
  }
  for (const c of chosen) {
    if (!tokens.includes(c)) fail(`"${c}" is not a legal answer to the parked question — legal answers: ${tokens.join(', ')}`);
  }
  if (new Set(chosen).size !== chosen.length) fail('duplicate --choose tokens — name each answer once');
  const isVetoTok = (t) => /^veto-\d+$/.test(t);
  if (chosen.includes('abort') && chosen.length > 1) fail('"abort" stands alone — it cannot be combined with other answers');
  if (chosen.includes('accept') && chosen.some(isVetoTok)) {
    fail('"accept" and "veto-<n>" contradict each other — accept confirms the whole proposal; veto tokens name the dismissals you refuse');
  }
  if (!chosen.some(isVetoTok) && chosen.length > 1) fail('only veto-<n> tokens combine — choose exactly one answer otherwise');
  const noteAllowed = chosen[0] === 'abort' || (chosen[0] === 'continue' && (w.kind === 'supervisor-stop' || w.kind === 'limit'));
  if (!isBlank(values.note) && !noteAllowed) fail('--note is only recorded with "abort" (and with "continue" on a supervisor stop or limit) — other answers are structured tokens; a nuanced decision belongs in a ben session');
  const reply = replyText();
  pauseAt('after-answer-validate');

  let outcome;
  try {
    if (chosen[0] === 'abort') {
      outcome = coreAbandon({ note: values.note, by: values.by });
    } else {
      switch (w.kind) {
        case 'approval':
          outcome = chosen[0] === 'revise' ? coreRecordRevision({ notes: reply, by: values.by, expect: { hashes: w.binding.hashes } }) : coreRecordApproval({ by: values.by, decision: 'APPROVE' });
          break;
        case 'veto': {
          // the token map and the recorded bytes are ONE read — the
          // expected identity (from the oracle's validated pass) rides into the
          // core, which refuses right before its append if the bytes moved.
          const map = new Map(vetoTokensNow().map((v) => [v.token, v.fingerprint]));
          const response = chosen[0] === 'accept' ? { decision: 'confirm' } : { vetoes: chosen.map((t) => map.get(t)) };
          outcome = coreRecordVeto({ response, by: values.by, expect: { blockersSha: st.derived.blockersSha, proposalSha: st.derived.proposalSha } });
          break;
        }
        case 'review-stop': {
          // the grant target is the ORACLE-DERIVED kind (authoritative
          // state), never the projection's own field; the grant is
          // conditional on the exact live gate — the callback re-validates and
          // captures the rounds.json bytes the referee's compare-and-swap binds
          outcome = coreRecordGrant({
            by: values.by,
            kind: st.derived.gateKind,
            rounds: values.rounds ?? '1',
            slot: isObj(w.binding?.slot) ? w.binding.slot : undefined,
            conditionalOnGate: () => {
              const again = waitingState(S, REPO);
              if (!(again.state === 'current' && again.waiting.kind === 'review-stop' && again.derived.gateKind === st.derived.gateKind)) return undefined;
              const roundsPath = join(S, 'rounds.json');
              return existsSync(roundsPath) ? sha256File(roundsPath) : undefined;
            },
          });
          break;
        }
        case 'fix-cap': {
          // the plan-round budget maps to the existing grant core;
          // verify steps get a sequencer-owned one-more-attempt grant
          if (w.binding?.step === 'plan-rounds') {
            outcome = coreRecordGrant({ by: values.by, kind: 'plan', rounds: '1' });
          } else {
            outcome = coreRecordFixGrant({ by: values.by, expect: { step: w.binding?.step, tallyAt: w.binding?.tallyAt } });
          }
          break;
        }
        case 'manual-adjudication': {
          const ids = Array.isArray(w.binding?.criterionIds) ? w.binding.criterionIds : [];
          const criterionId = !isBlank(values.criterion) ? values.criterion : ids.length === 1 ? ids[0] : undefined;
          if (criterionId === undefined) fail(`${ids.length} criteria are pending (${ids.join(', ')}) — name one with --criterion <id>`);
          if (!ids.includes(criterionId)) fail(`criterion ${criterionId} is not among the pending ones (${ids.join(', ')})`);
          if (isBlank(reply)) fail(`"${chosen[0]}" requires --reply "<your ruling, in your words>" (or --reply-file)`);
          if (chosen[0] === 'accepted' && isBlank(values.residual)) fail('"accepted" requires --residual "<the gap that remains>" — it is published on the PR, never hidden');
          if (chosen[0] === 'satisfied' && !isBlank(values.residual)) fail('"satisfied" carries no --residual');
          const response = { decision: chosen[0], ruling: reply.trim(), ...(chosen[0] === 'accepted' ? { residual: values.residual.trim() } : {}) };
          outcome = coreRecordAdjudication({ criterionId, response, by: values.by, confirm: true });
          break;
        }
        case 'clarify':
          outcome = coreRecordClarification({ answers: reply, by: values.by, expect: { questionsSha: st.derived.questionsSha } });
          break;
        case 'supervisor-stop':
          outcome = coreResolveSupervisorStop({ by: values.by, note: values.note, expect: { stopId: st.derived.stopId } });
          break;
        case 'limit':
          outcome = coreRecordLimitExtension({ by: values.by, usd: values.usd, hours: values.hours, stretches: values.stretches, note: values.note, expect: { eventId: st.derived.eventId } });
          break;
        case 'pr-retry':
        case 'pr-head-mismatch':
          outcome = coreRecordPrRetry({ by: values.by, expect: { intentHash: st.derived.intentHash, inspectionSha: st.derived.inspectionSha } });
          break;
        case 'pr-observed':
          outcome = coreRecordPrUnusable({ target: w.binding.intentHash, by: values.by });
          break;
        default:
          fail(`no answer mapping exists for kind ${w.kind}`); // unreachable: legalTokensFor gated above
      }
    }
  } catch (e) {
    // the record layer's own refusal, verbatim, with its exact exit semantics
    if (e instanceof RecordRefusal) {
      if (e.mode === 'fail') fail(e.message);
      stop(e.message, e.facts);
    }
    throw e;
  }
  pauseAt('after-answer-record');
  clearWaiting();
  console.log(outcome.message);
  const resumeLine = isObj(CURRENT_TASK.assignment)
    ? `  node ${shq(join(SCRIPTS, 'runner.mjs'))} resume --repo ${shq(REPO)}`
    : `  node ${shq(join(SCRIPTS, 'run.mjs'))} next --repo ${shq(REPO)}`;
  console.log(`run: answer recorded (${chosen.join(' ')} by ${values.by}). ben resumes with:\n${resumeLine}\n— or start a ben session in this repo.`);
}

// the recorded operator observation of the remote PR (trust class:
// operator evidence, internally validated, durably recorded — NOT
// authenticated remote provenance). Instructed fetch:
//   gh pr view <url> --json url,body,headRefOid,updatedAt > .ben/remote-observation.json
function readRemoteObservation() {
  const p = values['remote-observation'];
  if (isBlank(p)) {
    fail('--remote-observation <file> is required — fetch it with: gh pr view <url> --json url,body,headRefOid,updatedAt > .ben/remote-observation.json');
  }
  const path = resolvePath(p);
  if (!existsSync(path)) fail(`remote observation file not found: ${path}`);
  let obs;
  try {
    obs = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`remote observation is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObj(obs) || isBlank(obs.url) || typeof obs.body !== 'string' || isBlank(obs.headRefOid) || isBlank(obs.updatedAt)) {
    fail('remote observation must carry non-blank url, headRefOid, updatedAt and a string body (gh pr view --json url,body,headRefOid,updatedAt)');
  }
  return obs;
}

/** The CURRENT pure projection — rendered in memory, never written here. */
function currentProjection(task) {
  try {
    return renderPrBody(S, { title: task.title ?? task.taskId ?? 'ben task', repoDir: REPO });
  } catch (err) {
    fail(`the PR body cannot be rendered: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The four internal-consistency checks: url, head, canonical body vs
 * the current projection, and the body digest. Returns the problems (with
 * digests printed on a body mismatch) and the publication stamp when clean.
 */
function checkObservation(obs, { expectedUrl, expectedHead, projection }) {
  const problems = [];
  if (obs.url !== expectedUrl) problems.push(`observation.url is ${obs.url} — expected ${expectedUrl}`);
  if (obs.headRefOid !== expectedHead) problems.push(`observation.headRefOid is ${obs.headRefOid} — expected ${expectedHead}`);
  const obsBody = canonicalBody(obs.body);
  const projBody = canonicalBody(projection);
  if (obsBody !== projBody) {
    problems.push(`observation.body does not canonically equal the current generated body — observed body sha256 ${sha256(obsBody)}, generated body sha256 ${sha256(projBody)}`);
  }
  return {
    problems,
    publication: { bodySha: sha256(projBody), headRefOid: expectedHead, remoteUpdatedAt: obs.updatedAt, observedAt: new Date().toISOString() },
  };
}

/** at the terminal boundary: no PR is recorded over a pending manual criterion. */
function requireNoPendingManual() {
  const snapshot = adjudicationSnapshot();
  const pending = pendingManualCriteria(snapshot);
  if (pending.length > 0) {
    fail(
      `manual criteria are not adjudicated: ${pending.map((c) => c.id).join(', ')} — record each with run.mjs record-adjudication --criterion <id> --response <file> --by <you> --confirm, then re-run next`,
    );
  }
  return snapshot;
}

function cmdRecordPr() {
  acquireLock();
  const task = requireTask();
  if (isBlank(values.url)) fail('--url <url> is required');
  if (!task.prIntent && isObj(task.observedPr)) {
    // terminal recording of an already-existing remote PR —
    // legal only after the requalified stamp (the durable "fresh diff GO
    // earned" fact, bound to the reviewed head). No create was ever emitted.
    const aprObs = approvalState(task);
    if (!aprObs.present || !aprObs.matches) {
      stop('the approval no longer matches the on-disk artifacts — nothing terminal proceeds on a voided approval', 'A human decides (playbook).');
    }
    // the stamp is terminally usable only when its head equals the current
    // HEAD, its recorded approval authority equals the CURRENT approval, and
    // the reviewBase that earned the fresh diff GO carries that same authority
    // a stamp earned under a superseded approval never permits terminality
    const rq = task.observedPr.requalified;
    const rqUsable =
      isObj(rq) &&
      rq.reviewBaseSha === headSha() &&
      JSON.stringify(rq.approvalHashes) === JSON.stringify(aprObs.approval.sha256) &&
      isObj(task.reviewBase) &&
      task.reviewBase.sha === rq.reviewBaseSha &&
      JSON.stringify(task.reviewBase.approvalHashes) === JSON.stringify(aprObs.approval.sha256);
    if (!rqUsable) {
      fail(
        'the observed PR has not been requalified at the current HEAD under the current approval — run.mjs next must reach a fresh diff GO (head match) first; terminality cannot precede fresh diff review under this approval',
      );
    }
    if (values.url !== task.observedPr.url) {
      fail(`--url must be the observed PR url (${task.observedPr.url}) — record-pr on this path records the PR the human already observed, never a new one`);
    }
    if (task.pr) {
      if (task.pr.url === values.url && task.pr.headSha === task.observedPr.headSha) {
        // the terminal replay is a success claim — invalid/divergent
        // adjudication state STOPs before any no-op response
        adjudicationSnapshot();
        console.log('run: this PR is already recorded — no-op.');
        process.exit(0);
      }
      stop('a different PR is already recorded', `recorded: ${JSON.stringify(task.pr)}\nsubmitted url: ${values.url}`);
    }
    // on the observedPr path too: adjudication + digest + observation
    requireNoPendingManual();
    if (adjudicationSnapshot().digest !== earnedAdjudicationsSha(task)) {
      stop(
        'the adjudication state changed after the earned diff review — nothing terminal proceeds on a stale review basis',
        `current adjudicationsSha: ${adjudicationSnapshot().digest}\nreviewBase.adjudicationsSha: ${earnedAdjudicationsSha(task)}\nrun.mjs next re-earns verification and review at the current governing set.`,
      );
    }
    const obsObserved = readRemoteObservation();
    const checkedObserved = checkObservation(obsObserved, { expectedUrl: task.observedPr.url, expectedHead: task.observedPr.headSha, projection: currentProjection(task) });
    if (checkedObserved.problems.length > 0) {
      fail(`the remote observation does not validate against the PR being terminalized:\n- ${checkedObserved.problems.join('\n- ')}`);
    }
    task.pr = { url: task.observedPr.url, headSha: task.observedPr.headSha, publication: checkedObserved.publication };
    saveTask(task);
    log(`PR recorded from observedPr: ${values.url}`);
    console.log(`run: PR recorded — ${values.url} (head ${task.pr.headSha}, pre-existing remote PR, no create emitted; publication stamped, body ${checkedObserved.publication.bodySha}). Terminal. The human merges.`);
    process.exit(0);
  }
  if (!task.prIntent) fail('no pending PR intent — record-pr answers an emitted create instruction');
  const apr = approvalState(task);
  if (!apr.present || !apr.matches) {
    stop('the approval no longer matches the on-disk artifacts — nothing terminal proceeds on a voided approval', 'A human decides (playbook).');
  }
  if (task.pr) {
    if (task.pr.url === values.url && task.pr.headSha === task.prIntent.headSha) {
      // the terminal replay is a success claim — invalid/divergent
      // adjudication state STOPs before any no-op response
      adjudicationSnapshot();
      console.log('run: this PR is already recorded — no-op.');
      process.exit(0);
    }
    stop('a different PR is already recorded', `recorded: ${JSON.stringify(task.pr)}\nsubmitted url: ${values.url}`);
  }
  if (headSha() !== task.prIntent.headSha) {
    stop('HEAD no longer matches the PR intent — the recorded PR must be the reviewed head', `intent head: ${task.prIntent.headSha}\nHEAD now: ${headSha()}`);
  }
  // adjudication complete + digest still the earned review's +
  // a validated recorded observation — all before anything terminal lands
  requireNoPendingManual();
  if (adjudicationSnapshot().digest !== earnedAdjudicationsSha(task)) {
    stop(
      'the adjudication state changed after the earned diff review — nothing terminal proceeds on a stale review basis',
      `current adjudicationsSha: ${adjudicationSnapshot().digest}\nreviewBase.adjudicationsSha: ${earnedAdjudicationsSha(task)}\nrun.mjs next re-earns verification and review at the current governing set.`,
    );
  }
  const obs = readRemoteObservation();
  const checked = checkObservation(obs, { expectedUrl: values.url, expectedHead: task.prIntent.headSha, projection: currentProjection(task) });
  if (checked.problems.length > 0) {
    fail(`the remote observation does not validate against the PR being terminalized:\n- ${checked.problems.join('\n- ')}`);
  }
  task.pr = { url: values.url, headSha: task.prIntent.headSha, publication: checked.publication };
  saveTask(task); // pr is the one and only completion authority
  log(`PR recorded: ${values.url}`);
  console.log(`run: PR recorded — ${values.url} (head ${task.pr.headSha}; publication stamped, body ${checked.publication.bodySha}). Terminal. The human merges.`);
}

function cmdRecordPrRetry() {
  acquireLock();
  renderRecordOutcome(() => coreRecordPrRetry({ by: values.by }));
}

/** the retry authorization, bound (when answered at a gate) to the exact inspection it answers. */
function coreRecordPrRetry({ by, expect = undefined }) {
  const task = requireTask();
  if (isBlank(by)) throw refuse('--by <user> is required — a retry is a recorded human authorization');
  if (!task.prIntent) throw refuse('no pending PR intent — nothing to retry');
  if (task.pr) throw refuse('a PR is already recorded — nothing to retry');
  const aprRetry = approvalState(task);
  if (!aprRetry.present || !aprRetry.matches) {
    throw refuseStop('the approval no longer matches the on-disk artifacts — no retry can be authorized on a voided approval', 'A human decides (playbook).');
  }
  const intentHash = sha256(JSON.stringify(task.prIntent));
  if (expect !== undefined && expect.intentHash !== intentHash) {
    throw refuse('the pending PR intent changed while your answer was being recorded — nothing was written; run.mjs next re-presents the current state');
  }
  const insp = latestInspection(task, intentHash);
  const inspSha = insp === undefined ? undefined : inspectionSha(insp);
  if (expect !== undefined && expect.inspectionSha !== inspSha) {
    throw refuse('GitHub was re-inspected while your answer was being recorded — nothing was written; run.mjs next re-presents the current facts');
  }
  task.prRetries = Array.isArray(task.prRetries) ? task.prRetries : [];
  const existing = task.prRetries.find((r) => r.intentHash === intentHash && (r.inspectionSha ?? undefined) === inspSha);
  if (existing) {
    if (existing.by === by && existing.consumedByAttempt === undefined) {
      return { message: 'run: this retry authorization is already recorded and unconsumed — no-op. run.mjs next will emit the fresh create instruction.' };
    }
    if (existing.consumedByAttempt !== undefined) {
      throw refuseStop('a retry for this intent was already consumed', `retry: ${JSON.stringify(existing)}\nA further attempt needs the NEW pending intent's own authorization.`);
    }
    throw refuseStop('a conflicting retry authorization exists for this intent', `recorded: ${JSON.stringify(existing)}\nsubmitted by: ${by}`);
  }
  task.prRetries.push({ forAttempt: task.prIntent.attempt, intentHash, ...(inspSha !== undefined ? { inspectionSha: inspSha } : {}), by, at: new Date().toISOString() });
  saveTask(task);
  log(`PR retry authorized by ${by} for attempt ${task.prIntent.attempt}${inspSha ? ` (inspection ${inspSha.slice(0, 12)})` : ''}`);
  return { message: `run: retry recorded (operator authorized attempt ${task.prIntent.attempt + 1}${insp ? ` against GitHub inspection: branch ${insp.branch}, PR ${insp.pr}` : ''}). run.mjs next will emit exactly one fresh publication.` };
}

// ---------------------------------------------------------------------------
// record commands (inspection, supervisor stop, limits,
// answer-surface cores). Observation acts are the runner's (`--by
// ben-runner`); authorizations are the human's — all hash-bound and idempotent.

function cmdRecordPrInspection() {
  acquireLock();
  renderRecordOutcome(() =>
    coreRecordPrInspection({ branch: values.branch, pr: values.pr, url: values.url, prHead: values['pr-head'], intentHash: values['intent-hash'], failure: values.failure, by: values.by }),
  );
}

function coreRecordPrInspection({ branch, pr, url, prHead, intentHash, failure = undefined, by }) {
  const task = requireTask();
  if (isBlank(by)) throw refuse('--by <actor> is required — an inspection is a recorded observation act');
  // the publication failure this inspection follows — an observed fact the
  // retry gate shows the human; the runner scrubs and bounds it, the sequencer validates
  if (failure !== undefined && (typeof failure !== 'string' || failure.trim() === '' || failure.length > PR_INSPECTION_FAILURE_MAX)) {
    throw refuse(`--failure must be a non-blank string of at most ${PR_INSPECTION_FAILURE_MAX} characters`);
  }
  if (!INSPECTION_BRANCH.includes(branch)) throw refuse(`--branch must be one of ${INSPECTION_BRANCH.join('|')}`);
  if (!INSPECTION_PR.includes(pr)) throw refuse(`--pr must be one of ${INSPECTION_PR.join('|')}`);
  if (pr === 'exists' && (isBlank(url) || isBlank(prHead))) throw refuse('--pr exists requires --url <pr url> and --pr-head <sha>');
  if (pr === 'absent' && (!isBlank(url) || !isBlank(prHead))) throw refuse('--pr absent takes no --url / --pr-head');
  if (!task.prIntent) throw refuse('no pending PR intent — nothing to inspect');
  if (task.pr) throw refuse('a PR is already recorded — nothing to inspect');
  const current = sha256(JSON.stringify(task.prIntent));
  if (isBlank(intentHash)) throw refuse('--intent-hash <hash> is required — the pending gate prints the exact value');
  if (intentHash !== current) throw refuseStop('the supplied --intent-hash does not match the pending intent', `pending intent hash: ${current}\nsupplied: ${intentHash}\nNothing was written.`);
  const row = { intentHash, branch, pr, ...(pr === 'exists' ? { url, prHead } : {}), ...(failure !== undefined ? { failure: failure.trim() } : {}), by, at: new Date().toISOString() };
  const latest = latestInspection(task, intentHash);
  if (latest !== undefined && latest.branch === branch && latest.pr === pr && latest.url === row.url && latest.prHead === row.prHead && latest.failure === row.failure) {
    return { message: 'run: this inspection matches the latest recorded one — no-op.' };
  }
  task.prInspections = [...(task.prInspections ?? []), row];
  saveTask(task);
  log(`PR inspection recorded by ${by}: branch ${branch}, pr ${pr}${url ? ` ${url}@${prHead}` : ''}${row.failure ? ` (after a publication failure: ${row.failure.slice(0, 120)})` : ''}`);
  return { message: `run: inspection recorded (branch ${branch}, PR ${pr}${url ? ` at ${prHead}` : ''}${row.failure ? '; the publication failure is on record' : ''}). run.mjs next routes from these facts.` };
}

function cmdRecordSupervisorStop() {
  acquireLock();
  renderRecordOutcome(() => coreRecordSupervisorStop({ reason: values.reason, by: values.by }));
}

function coreRecordSupervisorStop({ reason, by }) {
  const task = requireTask();
  if (isBlank(reason)) throw refuse('--reason <text> is required');
  if (isBlank(by)) throw refuse('--by <actor> is required');
  if (task.pr) throw refuse('the task is terminal — nothing to stop');
  const open = openSupervisorStop(task);
  if (open !== undefined) return { message: `run: a supervisor stop is already open (${open.id.slice(0, 12)}: ${open.reason}) — no-op.` };
  const at = new Date().toISOString();
  const row = { id: sha256(`${reason}|${at}|${randomUUID()}`), reason: reason.trim(), by, at };
  task.supervisorStops = [...(task.supervisorStops ?? []), row];
  saveTask(task);
  log(`supervisor stop recorded by ${by}: ${row.reason}`);
  return { message: `run: supervisor stop recorded (${row.id.slice(0, 12)}). run.mjs next parks it for the human (continue / abort).` };
}

function coreResolveSupervisorStop({ by, note, expect }) {
  const task = requireTask();
  if (isBlank(by)) throw refuse('--by <user> is required');
  const open = openSupervisorStop(task);
  if (open === undefined) return { message: 'run: no supervisor stop is open — no-op.' };
  if (expect !== undefined && expect.stopId !== open.id) throw refuse('the supervisor stop changed while your answer was being recorded — nothing was written');
  open.resolution = { decision: 'continue', by, at: new Date().toISOString(), ...(isBlank(note) ? {} : { note: note.trim() }) };
  saveTask(task);
  log(`supervisor stop ${open.id.slice(0, 12)} continued by ${by}`);
  return { message: `run: continue recorded (${by}) — ben gets one more attempt${isBlank(note) ? '' : ' with your note'}. Next: run.mjs next` };
}

function cmdRecordLimit() {
  acquireLock();
  renderRecordOutcome(() => coreRecordLimit({ kind: values.kind, value: values.value, by: values.by }));
}

function coreRecordLimit({ kind, value, by }) {
  const task = requireTask();
  if (!LIMIT_KINDS.includes(kind)) throw refuse(`--kind must be one of ${LIMIT_KINDS.join('|')}`);
  const v = Number(value);
  if (!Number.isFinite(v)) throw refuse('--value <number> is required (the accounted total that reached the limit)');
  if (isBlank(by)) throw refuse('--by <actor> is required');
  if (task.pr) throw refuse('the task is terminal — no limit applies');
  const open = openLimitEvent(task);
  if (open !== undefined && open.kind === kind) return { message: `run: a ${kind} limit event is already open (${open.id.slice(0, 12)}) — no-op.` };
  const at = new Date().toISOString();
  const row = { id: sha256(`${kind}|${v}|${at}|${randomUUID()}`), kind, value: v, by, at };
  task.limitEvents = [...(task.limitEvents ?? []), row];
  saveTask(task);
  log(`limit event recorded by ${by}: ${kind} ${v}`);
  return { message: `run: limit reached recorded (${kind} ${v}, ${row.id.slice(0, 12)}). run.mjs next parks it for the human (continue --${kind === 'usd' ? 'usd' : kind === 'time' ? 'hours' : 'stretches'} N / abort).` };
}

function coreRecordLimitExtension({ by, usd, hours, stretches, note, expect }) {
  const task = requireTask();
  if (isBlank(by)) throw refuse('--by <user> is required');
  const open = openLimitEvent(task);
  if (open === undefined) return { message: 'run: no limit event is open — no-op.' };
  if (expect !== undefined && expect.eventId !== open.id) throw refuse('the limit event changed while your answer was being recorded — nothing was written');
  const flag = open.kind === 'usd' ? usd : open.kind === 'time' ? hours : stretches;
  const flagName = open.kind === 'usd' ? '--usd' : open.kind === 'time' ? '--hours' : '--stretches';
  const others = [usd, hours, stretches].filter((x) => x !== undefined && x !== flag);
  if (others.length > 0) throw refuse(`this limit is ${open.kind}: only ${flagName} N applies here`);
  const amount = Number(flag);
  if (flag === undefined || !Number.isFinite(amount) || amount <= 0 || (open.kind === 'stretches' && !Number.isSafeInteger(amount))) {
    throw refuse(`"continue" on a ${open.kind} limit requires ${flagName} N (a positive ${open.kind === 'stretches' ? 'integer' : 'number'}) — nothing ever becomes unlimited`);
  }
  const row = { eventId: open.id, kind: open.kind, amount, by, at: new Date().toISOString(), ...(isBlank(note) ? {} : { note: note.trim() }) };
  task.limitExtensions = [...(task.limitExtensions ?? []), row];
  saveTask(task);
  log(`limit extension recorded by ${by}: ${open.kind} +${amount}`);
  return { message: `run: extension recorded — ${open.kind} +${amount} (${by}). ben continues. Next: run.mjs next` };
}

function coreRecordFixGrant({ by, expect }) {
  const task = requireTask();
  if (isBlank(by)) throw refuse('--by <user> is required');
  const step = expect?.step;
  if (!FIX_GRANT_STEPS.includes(step)) throw refuse(`"continue" is not available for this stop (${step ?? 'unknown step'}) — its threshold is a referee constant; abort or start an engineering session`);
  const tallyKey = step === 'reconcile' ? 'reconcile' : VERIFY_TALLY_KEY[step];
  const r = readRounds();
  const tallyNow = Number.isInteger(r[tallyKey]) && r[tallyKey] >= 0 ? r[tallyKey] : 0;
  if (expect.tallyAt !== tallyNow) throw refuse('the fix tally moved while your answer was being recorded — nothing was written; run.mjs next re-presents the current state');
  const existing = (task.fixGrants ?? []).find((g) => g.step === step && g.tallyAt === tallyNow);
  if (existing) return { message: `run: one more ${step} attempt is already granted at this tally — no-op.` };
  task.fixGrants = [...(task.fixGrants ?? []), { step, tallyAt: tallyNow, by, at: new Date().toISOString() }];
  saveTask(task);
  log(`fix grant recorded by ${by}: ${step} at tally ${tallyNow}`);
  return { message: `run: one more "${step}" fix attempt granted (${by}). Next: run.mjs next` };
}

function coreRecordRevision({ notes, by, expect }) {
  const task = requireTask();
  if (isBlank(by)) throw refuse('--by <user> is required');
  if (isBlank(notes)) throw refuse('"revise" requires --reply "<what to change>" (or --reply-file) — a revision without notes is a silent gap');
  const hashes = approvalHashes(task);
  if (hashes === undefined || !isObj(task.approvalGate) || JSON.stringify(task.approvalGate.hashes) !== JSON.stringify(hashes)) {
    throw refuse('no APPROVE BUILD packet stands for the current artifact bytes — nothing to revise; run.mjs next re-presents the current state');
  }
  if (expect !== undefined && JSON.stringify(expect.hashes) !== JSON.stringify(hashes)) {
    throw refuse('the plan artifacts changed while your answer was being recorded — nothing was written');
  }
  const existing = (task.revisions ?? []).find((r) => JSON.stringify(r.hashes) === JSON.stringify(hashes) && r.presentedAt === undefined);
  if (existing) {
    if (existing.notes === notes.trim()) return { message: 'run: this revision request is already recorded for these exact artifact bytes — no-op.' };
    throw refuseStop('a different revision request is already recorded for these exact bytes', `recorded: ${existing.notes}\nsubmitted: ${notes.trim()}\nben is revising per the recorded notes; a changed mind waits for the revised packet.`);
  }
  // a stale approval for OTHER bytes must not resurrect when
  // those bytes return — the human asked for change, so any standing
  // approval act is superseded (moved, never deleted)
  let supersededApproval;
  const approvalPath = join(S, 'approval.json');
  if (existsSync(approvalPath)) {
    const a = readJson(approvalPath, 'approval.json');
    supersededApproval = `approval.superseded-${a?.actId ?? Date.now()}.json`;
    renameSync(approvalPath, join(S, supersededApproval));
  }
  const at = new Date().toISOString();
  const row = { id: sha256(`${JSON.stringify(hashes)}|${at}|${randomUUID()}`), hashes, notes: notes.trim(), by, at, ...(supersededApproval ? { supersededApproval } : {}) };
  task.revisions = [...(task.revisions ?? []), row];
  saveTask(task);
  log(`revision requested by ${by} (approval gate ${JSON.stringify(hashes).slice(0, 40)}…)${supersededApproval ? `; ${supersededApproval}` : ''}`);
  return { message: `run: revision recorded (${by}) — ben revises the plan per your notes; the revised plan re-earns review and returns to the approval gate. Next: run.mjs next` };
}

function coreRecordClarification({ answers, by, expect }) {
  const task = requireTask();
  if (isBlank(by)) throw refuse('--by <user> is required');
  if (isBlank(answers)) throw refuse('"reply" requires --reply "<answers>" (or --reply-file)');
  const qPath = join(S, 'questions.json');
  if (!existsSync(qPath)) throw refuse('no questions.json — nothing to answer');
  const qSha = sha256File(qPath);
  if (expect !== undefined && expect.questionsSha !== qSha) throw refuse('the questions changed while your answer was being recorded — nothing was written');
  const existing = (task.clarifications ?? []).find((c) => c.questionsSha === qSha);
  if (existing) {
    if (existing.answers === answers.trim()) return { message: 'run: these answers are already recorded — no-op.' };
    throw refuseStop('different answers are already recorded for these exact questions', `recorded: ${existing.answers}\nsubmitted: ${answers.trim()}`);
  }
  task.clarifications = [...(task.clarifications ?? []), { questionsSha: qSha, answers: answers.trim(), by, at: new Date().toISOString() }];
  saveTask(task);
  log(`clarification recorded by ${by}`);
  return { message: `run: answers recorded (${by}) — ben folds them into the brief and plans. Next: run.mjs next` };
}

// the durable human resolution of a pending PR side effect
// whose approval is not current — the only recorded exit from that STOP.
function cmdRecordPrRemote() {
  acquireLock();
  const task = requireTask(); // structural validation happened in loadTask
  const status = values.status;
  if (status !== 'absent' && status !== 'exists') fail('--status must be absent or exists');
  if (isBlank(values.by)) fail('--by <user> is required — the remote observation is a recorded human act');
  if (status === 'exists' && isBlank(values.url)) fail('--status exists requires --url <the observed PR url>');
  const resolutions = Array.isArray(task.prResolutions) ? task.prResolutions : [];
  // --intent-hash is REQUIRED (matching record-pr-unusable's durable-target
  // discipline) — the voided-approval gate prints the exact value, so the
  // instructed command IS the crash-replay-safe command. Lookup-first: a landed
  // identical observation replays as a no-op even though the active prIntent
  // was cleared by the same atomic write. The target is never inferred from
  // --by, "latest" history, array position, or the absence of active state.
  const suppliedTarget = values['intent-hash'];
  if (isBlank(suppliedTarget)) {
    fail('--intent-hash <hash> is required — the pending-intent gate (run.mjs next) prints the exact value to use');
  }
  const landed = resolutions.find((r) => r.type === 'observation' && r.intentHash === suppliedTarget);
  if (landed) {
    if (landed.status === status && (status !== 'exists' || landed.url === values.url)) {
      console.log('run: this remote observation is already recorded — no-op. run.mjs next continues from it.');
      process.exit(0);
    }
    stop(
      'a different remote observation is already recorded for this intent',
      `recorded: ${JSON.stringify(landed)}\nsubmitted: status=${status}${values.url ? ` url=${values.url}` : ''}\nOne pending side effect, one initial observation — a contradiction is never merged.`,
    );
  }
  if (!task.prIntent) {
    fail('no pending PR intent and no recorded observation for the supplied --intent-hash — nothing to resolve');
  }
  // the refusal is relaxed exactly this far — the ordinary protocol
  // governs only while the approval is current AND the adjudication digest
  // still matches the intent's earned review; a digest-stale intent under a
  // current approval routes through this migration.
  const aprRemote = approvalState(task);
  if (aprRemote.present && aprRemote.matches && adjudicationSnapshot().digest === earnedAdjudicationsSha(task)) {
    fail('the approval is current — the ordinary protocol governs (record-pr / record-pr-retry); record-pr-remote is only for a pending intent whose earned authority is stale (voided approval or a changed adjudication digest)');
  }
  const intentHash = sha256(JSON.stringify(task.prIntent));
  if (!isBlank(suppliedTarget) && suppliedTarget !== intentHash) {
    stop('the supplied --intent-hash does not match the pending intent', `pending intent hash: ${intentHash}\nsupplied: ${suppliedTarget}\nNothing was written.`);
  }
  task.prResolutions = resolutions;
  const existing = resolutions.find((r) => r.type === 'observation' && r.intentHash === intentHash);
  if (existing) {
    stop(
      'a remote observation is already recorded for this pending intent',
      `recorded: ${JSON.stringify(existing)}\nsubmitted: status=${status}${values.url ? ` url=${values.url}` : ''}\nOne pending side effect, one initial observation — a contradictory second observation is never merged.`,
    );
  }
  // one atomic write: intent archived + typed observation appended (+ observedPr) + active intent cleared
  task.prAttempts = [...(task.prAttempts ?? []), task.prIntent];
  task.prResolutions.push({
    type: 'observation',
    intentHash,
    status,
    ...(status === 'exists' ? { url: values.url } : {}),
    by: values.by,
    at: new Date().toISOString(),
  });
  if (status === 'exists') {
    task.observedPr = { url: values.url, headSha: task.prIntent.headSha, intentHash, by: values.by, at: new Date().toISOString() };
  }
  delete task.prIntent;
  pauseAt('before-pr-remote-write');
  saveTask(task);
  pauseAt('after-pr-remote-write'); // crash window: write landed, success output not yet delivered
  log(`pr-remote observation recorded by ${values.by}: ${status} (intent ${intentHash.slice(0, 12)})`);
  console.log(
    (status === 'absent'
      ? 'run: remote observation recorded — no PR exists for the archived intent. run.mjs next routes the task through migration (fresh complete-context plan review); a new create can only follow full requalification.'
      : `run: remote observation recorded — PR ${values.url} exists for the archived intent (non-terminal). run.mjs next routes the task through migration; the observed PR can only become terminal after a fresh diff GO at a matching head.`) +
      '\nRepeating this exact command is a safe idempotent no-op.',
  );
}

// later disposition of an observedPr whose head no longer
// matches the freshly reviewed HEAD. Lookup-first by explicit --intent-hash:
// replay after the atomic append+clear is a no-op; the target is never
// inferred from --by, "latest" history, array position, or observedPr absence.
function cmdRecordPrUnusable() {
  acquireLock();
  renderRecordOutcome(() => coreRecordPrUnusable({ target: values['intent-hash'], by: values.by }));
}

function coreRecordPrUnusable({ target, by }) {
  const task = requireTask(); // step 1: structural validation (validTask) happened in loadTask
  if (isBlank(target)) throw refuse('--intent-hash <hash> is required — the mismatch gate prints the exact value');
  if (isBlank(by)) throw refuse('--by <user> is required — a disposition is a recorded human act');
  const resolutions = Array.isArray(task.prResolutions) ? task.prResolutions : [];
  // step 2: disposition lookup FIRST — even though observedPr may already be cleared
  const dispositions = resolutions.filter((r) => r.type === 'disposition' && r.intentHash === target);
  if (dispositions.length > 0) {
    if (dispositions.length === 1 && dispositions[0].disposition === 'unusable') {
      return { message: 'run: this observed PR is already dispositioned unusable — no-op. run.mjs next continues (exactly one fresh create intent may follow the earned diff GO).' };
    }
    throw refuseStop('conflicting disposition history for this intent', `recorded:\n${dispositions.map((d) => JSON.stringify(d)).join('\n')}\nsubmitted: unusable by ${by}`);
  }
  // step 3: no disposition exists — the active observedPr must be the exact target
  if (!isObj(task.observedPr)) {
    throw refuse(`no active observedPr and no disposition recorded for intent ${target} — nothing to disposition`);
  }
  if (task.observedPr.intentHash !== target) {
    throw refuseStop(
      'the supplied --intent-hash does not match the active observedPr',
      `active observedPr intentHash: ${task.observedPr.intentHash}\nsupplied: ${target}\nThe mismatch gate prints the exact hash — nothing was written.`,
    );
  }
  if (!isObj(task.observedPr.mismatch)) {
    throw refuse('the observed PR has not been presented at a head-mismatch gate — a disposition answers a presented gate (run.mjs next presents it after a fresh diff GO)');
  }
  if (task.prIntent) throw refuse('an active PR intent exists — the ordinary protocol governs; record-pr-unusable dispositions an observedPr only');
  if (task.pr) throw refuse('a PR is already recorded terminally — nothing to disposition');
  // step 4: ONE atomic task.json replacement — typed disposition appended (full
  // observed fact embedded, history never deleted) + observedPr cleared
  task.prResolutions = [
    ...resolutions,
    { type: 'disposition', disposition: 'unusable', intentHash: target, by, at: new Date().toISOString(), observedPr: task.observedPr },
  ];
  delete task.observedPr;
  pauseAt('before-unusable-write');
  saveTask(task);
  log(`observedPr dispositioned unusable by ${by} (intent ${target.slice(0, 12)})`);
  return {
    message:
      'run: observed PR dispositioned unusable — its URL/head/history stay durable in prResolutions. run.mjs next resumes from the already-earned diff GO and emits exactly one fresh create intent at the reviewed HEAD.',
  };
}

// ---------------------------------------------------------------------------
// record-adjudication — one durable human adjudication act per manual
// criterion, dual-written (act register + ledger audit entry) through
// ledger.mjs adjudicate under a grant-pattern crash intent.

const ADJUDICATION_RESPONSE_FIELDS = ['decision', 'ruling', 'residual', 'basis'];

function cmdRecordAdjudication() {
  acquireLock();
  let response;
  if (isBlank(values.response)) fail('--response <file> is required');
  try {
    response = JSON.parse(readFileSync(resolvePath(values.response), 'utf8'));
  } catch (err) {
    fail(`response file unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  renderRecordOutcome(() => coreRecordAdjudication({ criterionId: values.criterion, response, by: values.by, confirm: values.confirm }));
}

/** The adjudication act as a returning core (called from `answer satisfied|accepted`). */
function coreRecordAdjudication({ criterionId, response, by, confirm }) {
  const task = requireTask();
  if (isBlank(criterionId)) throw refuse('--criterion <id> is required');
  if (isBlank(by)) throw refuse('--by <user> is required — an adjudication is a recorded human act');

  // the criterion and approval bytes are needed to CONSTRUCT the record; the
  // authoritative precondition enforcement is the shared lib guard below
  const criteriaDoc = readJson(join(S, 'criteria.json'), 'criteria.json');
  if (!isObj(criteriaDoc) || !Array.isArray(criteriaDoc.criteria)) throw refuse('criteria.json is missing or not a criteria doc');
  const matching = criteriaDoc.criteria.filter((c) => isObj(c) && c.id === criterionId);
  if (matching.length === 0) throw refuse(`criterion ${criterionId} does not exist in criteria.json`);
  if (matching.length > 1) throw refuse(`criterion id ${criterionId} is duplicated in criteria.json — one id, one criterion; fix the criteria (pregate rejects duplicates)`);
  const criterion = matching[0];
  if (!existsSync(join(S, 'approval.json'))) {
    throw refuse('no current matching approval — an adjudication binds the exact approval act; run.mjs next re-presents the plan phase first');
  }

  if (!isObj(response)) throw refuse('response must be a JSON object: {"decision","ruling"[,"residual"][,"basis"]}');
  for (const k of Object.keys(response)) {
    if (!ADJUDICATION_RESPONSE_FIELDS.includes(k)) throw refuse(`response carries unknown field "${k}" — the decision is structured, exactly {"decision","ruling"[,"residual"][,"basis"]}`);
  }
  if (response.decision !== 'satisfied' && response.decision !== 'accepted') throw refuse('response.decision must be "satisfied" or "accepted" — absence of a record is the only other state (fail-closed)');
  if (isBlank(response.ruling)) throw refuse("response.ruling must carry the operator's words, non-blank");
  if (response.decision === 'accepted' && isBlank(response.residual)) throw refuse('an accepted decision requires a non-blank residual — the surviving gap is published on the PR, never silent');
  if (response.decision === 'satisfied' && response.residual !== undefined) throw refuse('a satisfied decision must not carry a residual');

  // basis: optional normally, REQUIRED when the task is terminal
  let basis;
  let basisEntry;
  if (response.basis !== undefined) {
    const b = response.basis;
    if (!isObj(b) || (b.kind !== 'plan' && b.kind !== 'diff') || !Number.isInteger(b.round) || isBlank(b.fingerprint) || isBlank(b.action)) {
      throw refuse('response.basis must be {"kind":"plan|diff","round":N,"fingerprint":"...","action":"..."} naming an existing ledger entry');
    }
    for (const k of Object.keys(b)) {
      if (!['kind', 'round', 'fingerprint', 'action'].includes(k)) {
        throw refuse(`response.basis carries unknown field "${k}" — the citation is exactly {"kind","round","fingerprint","action"}, never silently trimmed`);
      }
    }
    const matches = readLedger().filter((e) => e.kind === b.kind && e.round === b.round && e.fingerprint === b.fingerprint && e.action === b.action);
    if (matches.length !== 1) {
      throw refuse(`basis must match exactly one ledger entry on kind/round/fingerprint/action — matched ${matches.length}. Nothing was written.`);
    }
    basis = { kind: b.kind, round: b.round, fingerprint: b.fingerprint, action: b.action };
    basisEntry = matches[0];
  }
  const record = {
    type: 'adjudication',
    criterionId: criterion.id,
    criterionSha: criterionShaOf(criterion),
    criterion,
    approvalActSha: sha256File(join(S, 'approval.json')),
    headSha: headSha(),
    decision: response.decision,
    ruling: response.ruling,
    ...(response.residual !== undefined ? { residual: response.residual } : {}),
    ...(basis !== undefined ? { basis, basisEntry } : {}),
    by,
    at: new Date().toISOString(),
  };
  const recordIssues = validateAdjudicationRecord(record);
  if (recordIssues.length > 0) throw refuse(`the constructed record does not validate: ${recordIssues.join('; ')}`);
  // task-level preconditions — the ONE shared guard (also enforced by
  // the standalone ledger.mjs adjudicate; no weaker entry point exists):
  // manual method, current criterion bytes, approval currency + act binding,
  // satisfied → clean worktree at the bound HEAD, terminal → basis required
  try {
    assertAdjudicationActAllowed({ stateDir: S, repoDir: REPO, task, record });
  } catch (err) {
    throw refuse(err instanceof Error ? err.message : String(err));
  }
  const digest = recordDigest(record);

  if (!confirm) {
    return {
      message:
        `run: record-adjudication DRY RUN — nothing written\n\n` +
        `=== criterion ${criterion.id} (verbatim) ===\n${JSON.stringify(criterion, null, 2)}\n\n` +
        `=== parsed response ===\n${JSON.stringify(response, null, 2)}\n\n` +
        `=== binding identity ===\n` +
        `decision: ${record.decision}\n` +
        `criterionSha: ${record.criterionSha}\n` +
        `approvalActSha: ${record.approvalActSha}\n` +
        `headSha (${record.decision === 'satisfied' ? 'binding' : 'context only — accepted is HEAD-independent'}): ${record.headSha}\n` +
        `record digest: ${digest}\n` +
        (record.decision === 'accepted'
          ? `\nWARNING — accepted is a HEAD-independent policy acceptance: it keeps governing as code changes, its residual is published on the PR, and every later review keeps full authority to challenge whether new bytes invalidate its assumptions.\n`
          : '') +
        (basisEntry !== undefined ? `\n=== referenced ledger entry (basis, verbatim) ===\n${JSON.stringify(basisEntry, null, 2)}\n` : '') +
        `\nRe-run with --confirm to record.`,
    };
  }

  // the total comparator against the register (divergence/conflict fail closed inside)
  const snapshot = adjudicationSnapshot();
  for (const existing of snapshot.records) {
    const cls = classifyRecords(record, existing);
    if (cls === 'replay') {
      // both-landed recovery: the register and the ledger agree (the
      // divergence check above proved it) — a crash-left unconsumed intent for
      // this act reaches its contracted consumed state before the no-op
      const landedIntent = (task.adjudicationIntents ?? []).find((a) => a.key === digest && !a.consumed);
      if (landedIntent) {
        landedIntent.consumed = true;
        saveTask(task);
      }
      return { message: `run: this exact adjudication act is already recorded for ${criterion.id} (digest ${digest}) — no-op. The original act stands.` };
    }
    if (cls === 'conflict') {
      throw refuseStop(
        `a conflicting adjudication record exists for ${criterion.id} — same binding identity, different content`,
        `recorded: ${JSON.stringify(existing)}\nsubmitted: ${JSON.stringify(record)}\nNothing was written. A changed ruling needs new bytes under a new binding (new approval act, new HEAD for satisfied) — or a human reconciles per the playbook.`,
      );
    }
  }

  // grant-pattern crash intent: {key: record digest, consumed, recordsBefore, ledgerBefore}
  const registerCount = () => snapshotRegisterCount();
  const ledgerAdjCount = () => readLedger().filter((e) => e.kind === 'adjudication').length;
  task.adjudicationIntents = Array.isArray(task.adjudicationIntents) ? task.adjudicationIntents : [];
  const intent = task.adjudicationIntents.find((a) => a.key === digest);
  if (intent) {
    const registerAfter = snapshot.records.slice(intent.recordsBefore).filter((r) => recordDigest(r) === digest);
    const auditAfter = readLedger()
      .filter((e) => e.kind === 'adjudication')
      .slice(intent.ledgerBefore)
      .filter((e) => e.fingerprint === digest);
    if (intent.consumed) {
      // consumed is bookkeeping, never proof — the short-circuit must find the
      // act itself in the durable state, else the flag is fabricated/rolled-back
      if (registerAfter.length > 0 && auditAfter.length > 0) {
        return { message: 'run: this exact adjudication is already recorded — no-op.' };
      }
      throw refuseStop(
        'the adjudication intent is marked consumed but the recorded act is absent from the durable state',
        `intent: ${JSON.stringify(intent)}\nregister landed: ${registerAfter.length > 0}\nledger landed: ${auditAfter.length > 0}\nA consumed flag is bookkeeping, never proof of the act — a human reconciles per the playbook.`,
      );
    }
    if (registerAfter.length > 0 && auditAfter.length > 0) {
      intent.consumed = true;
      saveTask(task);
      return { message: 'run: this adjudication had already landed in the register and the ledger — intent marked consumed, no-op.' };
    }
    if (registerAfter.length > 0 || auditAfter.length > 0) {
      throw refuseStop(
        'the adjudication dual write is half-applied (crash inside ledger.mjs adjudicate)',
        `intent: ${JSON.stringify(intent)}\nregister landed: ${registerAfter.length > 0}\nledger landed: ${auditAfter.length > 0}\nPlaybook: a human completes or removes the half-applied act — never both silently.`,
      );
    }
    // neither landed: fall through and invoke the referee under this same intent
  } else {
    task.adjudicationIntents.push({ key: digest, consumed: false, recordsBefore: registerCount(), ledgerBefore: ledgerAdjCount() });
    saveTask(task);
  }
  pauseAt('after-adjudication-intent');

  const recordPath = join(S, '.adjudication-record.json');
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const res = referee('ledger.mjs', ['adjudicate', S, '--repo', REPO, '--record', recordPath]);
  if (res.exitCode !== 0) throw refuse(`ledger.mjs adjudicate exited ${res.exitCode}: ${res.output}`);
  pauseAt('after-adjudicate-referee');
  try {
    unlinkSync(recordPath);
  } catch {
    /* best-effort cleanup of the handoff file */
  }
  const done = task.adjudicationIntents.find((a) => a.key === digest);
  done.consumed = true;
  saveTask(task);
  log(`adjudication recorded: ${criterion.id} ${record.decision} by ${by} (${digest})`);
  return { message: `${res.output}\nrun: adjudication recorded — ${criterion.id} ${record.decision} by ${by}. Next: run.mjs next` };
}

// count of records currently in adjudications.json (0 when absent) — used for
// the crash-intent baseline BEFORE the referee runs
function snapshotRegisterCount() {
  const parsed = readJson(join(S, 'adjudications.json'), 'adjudications.json');
  if (parsed === undefined) return 0;
  if (!Array.isArray(parsed)) stop('adjudications.json is not an array', `file: ${join(S, 'adjudications.json')}`);
  return parsed.length;
}

// ---------------------------------------------------------------------------
// check-pr-body — truly read-only: no lock, no writes, not even run.log.
// Requires a terminal task.pr and derives every expected identity from it.

function cmdCheckPrBody() {
  const task = loadTask();
  if (task === undefined) fail('no task.json — check-pr-body validates a terminal task');
  if (!task.pr) {
    fail('the task is not terminal — check-pr-body validates the recorded PR (task.pr); mid-flight publication validation belongs to record-pr');
  }
  const obs = readRemoteObservation();
  let projection;
  try {
    projection = renderPrBody(S, { title: task.title ?? task.taskId ?? 'ben task', repoDir: REPO });
  } catch (err) {
    fail(`the PR body cannot be rendered: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = checkObservation(obs, { expectedUrl: task.pr.url, expectedHead: task.pr.headSha, projection });
  if (checked.problems.length > 0) {
    console.log(`run: check-pr-body MISMATCH — the observation does not validate against the terminal PR\n- ${checked.problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `run: check-pr-body OK — ${task.pr.url} @ ${task.pr.headSha}; the observed body canonically equals the current generated body (sha256 ${checked.publication.bodySha}).`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// record-publication — the durable attestation for an already
// terminal task: validates exactly as check-pr-body, then appends the ledger
// audit entry (kind "publication"). task.pr is never touched.

function cmdRecordPublication() {
  acquireLock();
  const task = requireTask();
  if (isBlank(values.by)) fail('--by <user> is required — a publication attestation is a recorded human act');
  if (!task.pr) {
    fail('the task is not terminal — record-publication attests the recorded PR (task.pr); mid-flight publication validation belongs to record-pr');
  }
  const obs = readRemoteObservation();
  let projection;
  try {
    projection = renderPrBody(S, { title: task.title ?? task.taskId ?? 'ben task', repoDir: REPO });
  } catch (err) {
    fail(`the PR body cannot be rendered: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = checkObservation(obs, { expectedUrl: task.pr.url, expectedHead: task.pr.headSha, projection });
  if (checked.problems.length > 0) {
    fail(`the remote observation does not validate against the terminal PR:\n- ${checked.problems.join('\n- ')}`);
  }
  // readLedger IS the validated consumption boundary — every inert row's
  // complete wrapper has passed validation before any replay classification
  const ledgerForReplay = readLedger();
  // idempotent replay: an identical VALID attestation (same url/head/body/
  // remote timestamp/actor) already in the ledger is a no-op, never a second append
  const existing = ledgerForReplay.find(
    (e) =>
      e.kind === 'publication' &&
      isObj(e.publication) &&
      e.publication.url === task.pr.url &&
      e.publication.headRefOid === task.pr.headSha &&
      e.publication.bodySha === checked.publication.bodySha &&
      e.publication.remoteUpdatedAt === obs.updatedAt &&
      e.publication.by === values.by,
  );
  if (existing) {
    console.log('run: this exact publication attestation is already recorded in the ledger — no-op.');
    process.exit(0);
  }
  const res = referee('ledger.mjs', [
    'attest',
    S,
    '--repo',
    REPO,
    '--url',
    task.pr.url,
    '--head-ref',
    task.pr.headSha,
    '--body-sha',
    checked.publication.bodySha,
    '--remote-updated-at',
    obs.updatedAt,
    '--observed-at',
    new Date().toISOString(),
    '--by',
    values.by,
  ]);
  if (res.exitCode !== 0) fail(`ledger.mjs attest exited ${res.exitCode}: ${res.output}`);
  log(`publication attested by ${values.by}: ${task.pr.url} (body ${checked.publication.bodySha})`);
  console.log(res.output);
  console.log(`run: publication attested — ${task.pr.url} @ ${task.pr.headSha}, body ${checked.publication.bodySha}. Durable in the ledger; task.pr untouched.`);
}

// ---------------------------------------------------------------------------

switch (command) {
  case 'init':
    cmdInit();
    break;
  case 'next':
    cmdNext();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'adopt':
    cmdAdopt();
    break;
  case 'record-veto':
    cmdRecordVeto();
    break;
  case 'record-approval':
    cmdRecordApproval();
    break;
  case 'record-grant':
    cmdRecordGrant();
    break;
  case 'record-pr':
    cmdRecordPr();
    break;
  case 'record-pr-retry':
    cmdRecordPrRetry();
    break;
  case 'record-pr-remote':
    cmdRecordPrRemote();
    break;
  case 'record-pr-unusable':
    cmdRecordPrUnusable();
    break;
  case 'record-adjudication':
    cmdRecordAdjudication();
    break;
  case 'check-pr-body':
    cmdCheckPrBody();
    break;
  case 'record-publication':
    cmdRecordPublication();
    break;
  case 'answer':
    cmdAnswer();
    break;
  case 'record-pr-inspection':
    cmdRecordPrInspection();
    break;
  case 'record-supervisor-stop':
    cmdRecordSupervisorStop();
    break;
  case 'record-limit':
    cmdRecordLimit();
    break;
}
