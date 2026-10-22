#!/usr/bin/env node
// reviewer — cross-vendor review runner, restoring old ben's codex adapter guarantees
// (src/agents/codex.ts + reviewPanel prompt assembly in machine.ts — the spec).
// Zero dependencies. Node only (invokes the reviewer CLI and git).
//
// Why this exists as a script: the verdict file must provably be the reviewer's own
// output, and the prompt must contain the approved plan and raw artifacts, without
// a separate implementer completion narrative. Both guarantees die if the session agent
// assembles prompts or transcribes verdicts by hand. This script does both mechanically:
// it fills the challenge template from files, runs the CLI, and writes what came back —
// the agent's hands never touch the JSON.
//
// Usage:
//   node scripts/reviewer.mjs plan <dir> --round N [--name codex] [--repo p] [--timeout ms]
//   node scripts/reviewer.mjs diff <dir> --round N --base <ref> [--name codex] [--repo p] [--timeout ms]
//
// plan prompt:  prompts/challenge-plan.md  ← plan.md, criteria.json, promises.json,
//               plan-files.json, gates.json, canonical config (task.json), ledger.jsonl
// diff prompt:  prompts/challenge-diff.md  ← git diff <base>...HEAD (saved round-stamped
//               to <dir>/diff-rN.patch), approved plan.md, plan-files.json, exact
//               changed paths (--name-only --no-renames -z), canonical config,
//               criteria.json, evidence/criteria-matrix.json, each criterion's
//               evidence file (mechanically truncated), ledger.jsonl
//
// The CLI is invoked as: <cli> exec --json -C <repo> -s read-only -o <file>
// --output-schema schemas/verdict.json <prompt>   (verified against codex-cli 0.144.1).
// Valid verdict → written to <dir>/reviews/<kind>-round-N-<name>.json. Unparseable after
// one retry → a non-verdict abstention record is written to that path; raw output
// remains in .abstain.txt. Failed processes cannot supply a passing verdict.
//
// Exit codes: 0 verdict written · 1 abstain (raw written) · 3 usage/IO error

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deriveAdjudication, readLedgerStrict, resolveRepoForState } from './adjudication.lib.mjs';

const BEN = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_PROMPT_BYTES = 16_384;
const HEAD_LINES = 200;
const TAIL_LINES = 200;
const SEVERITIES = ['BLOCKER', 'MAJOR', 'NIT'];

function fail(msg) {
  console.error(`reviewer: ${msg}`);
  process.exit(3);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    fail(`${what} unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// verbatim from src/gates/evidence.ts — head + tail + marker, never a summary
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

// verbatim from src/ledger/ledger.ts renderLedger
function renderLedger(entries) {
  if (entries.length === 0) return '(empty)';
  return entries
    .map(
      (e) =>
        `[${e.kind} round ${e.round}] ${e.action} ${e.fingerprint || '-'} (${e.reviewer}${e.blockerId ? `/${e.blockerId}` : ''}): ${e.detail}`,
    )
    .join('\n');
}

// verbatim from src/agents/claude.ts extractJson
function extractJson(text) {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// same shape as verdictSchema (src/schemas.ts), hand-rolled
function isValidVerdict(v) {
  if (!isObj(v) || !['GO', 'NO_GO'].includes(v.verdict)) return false;
  const blockers = v.blockers ?? [];
  if (!Array.isArray(blockers)) return false;
  return blockers.every(
    (b) =>
      isObj(b) &&
      typeof b.id === 'string' &&
      b.id.length > 0 &&
      SEVERITIES.includes(b.severity) &&
      typeof b.claim === 'string' &&
      b.claim.length > 0,
  );
}

// single-pass fill over the TEMPLATE only: substituted artifact bytes are never
// rescanned, so a literal "{{VAR}}" inside an artifact stays verbatim
function fillTemplate(name, vars) {
  const text = readText(join(BEN, 'prompts', name), `prompts/${name}`);
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));
}

// canonical verdict-relevant config identity — MUST byte-match run.mjs's
// canonicalConfig (same keys, same order); read from the durable task.json
function canonicalConfigFromTask(dir) {
  const raw = readText(join(dir, 'task.json'), 'task.json');
  let task;
  try {
    task = JSON.parse(raw);
  } catch (err) {
    fail(`task.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cfg = task !== null && typeof task === 'object' && task.config !== null && typeof task.config === 'object' ? task.config : {};
  // MUST byte-match adjudication.lib.mjs canonicalConfig (same keys, same
  // order; hard caps join omit-if-absent)
  const boundCap = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : undefined);
  return JSON.stringify({
    e2ePaths: typeof cfg.e2ePaths === 'string' ? cfg.e2ePaths : '',
    greenfield: cfg.greenfield === true,
    ...(boundCap(cfg.planRoundsMax) !== undefined ? { planRoundsMax: cfg.planRoundsMax } : {}),
    ...(boundCap(cfg.diffRoundsMax) !== undefined ? { diffRoundsMax: cfg.diffRoundsMax } : {}),
  });
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      round: { type: 'string' },
      base: { type: 'string' },
      name: { type: 'string', default: 'codex' },
      repo: { type: 'string' },
      timeout: { type: 'string', default: '1200000' },
      cli: { type: 'string', default: 'codex' }, // override in tests only
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;

const kind = positionals[0];
if (kind !== 'plan' && kind !== 'diff') fail('first argument must be "plan" or "diff"');
const dir = resolvePath(positionals[1] ?? '.');
// one state dir, one repo — the reviewed diff, the governing HEAD, and
// the verdict destination must all name the SAME repository authority (the
// same resolveRepoForState rule every referee uses); a foreign --repo on a
// .ben layout is refused before any prompt or verdict work. A non-.ben flat
// layout without --repo is its own repository authority, exactly as before;
// an ORPHAN .ben (parent is not a repo) fails closed — .ben itself is never
// the repository.
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
const round = Number(values.round);
if (!Number.isInteger(round) || round < 1) fail(`--round must be a positive integer, got "${values.round}"`);
const timeoutMs = Number(values.timeout);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail(`--timeout must be a positive integer (ms), got "${values.timeout}"`);

const criteriaText = readText(join(dir, 'criteria.json'), 'criteria.json');
let criteriaDoc;
try {
  criteriaDoc = JSON.parse(criteriaText);
} catch {
  fail('criteria.json is not valid JSON — run pregate.mjs first');
}
const taskId = isObj(criteriaDoc) && typeof criteriaDoc.taskId === 'string' && criteriaDoc.taskId.length > 0 ? criteriaDoc.taskId : 'task';
// the shared strict boundary: strict framing + complete wrapper validation —
// a torn, malformed, or contradictory row fails closed here, never a prompt
// assembled over a silently narrowed history
let ledgerEntries;
try {
  ledgerEntries = readLedgerStrict(join(dir, 'ledger.jsonl'));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// prompt assembly — raw artifacts only, by construction. The
// complete review authority set: the reviewer judges nothing it was
// not handed; a missing required artifact fails closed (exit 3), never a
// silently narrower review.
let prompt;
if (kind === 'plan') {
  prompt = fillTemplate('challenge-plan.md', {
    TASK_ID: taskId,
    ROUND: String(round),
    PLAN: readText(join(dir, 'plan.md'), 'plan.md'),
    CRITERIA: criteriaText,
    PROMISES: readText(join(dir, 'promises.json'), 'promises.json'),
    PLAN_FILES: truncateForPrompt(readText(join(dir, 'plan-files.json'), 'plan-files.json'), join(dir, 'plan-files.json')),
    GATES: truncateForPrompt(readText(join(dir, 'gates.json'), 'gates.json'), join(dir, 'gates.json')),
    CONFIG: canonicalConfigFromTask(dir),
    LEDGER: renderLedger(ledgerEntries),
  });
} else {
  if (!values.base) fail('diff mode requires --base <ref>');
  const diffRes = spawnSync('git', ['diff', `${values.base}...HEAD`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (diffRes.status !== 0) fail(`git diff failed in ${repo}: ${(diffRes.stderr ?? '').trim()}`);
  const diffPath = join(dir, `diff-r${round}.patch`); // round-stamped, full diff kept on disk
  writeFileSync(diffPath, diffRes.stdout);
  // exact changed-path records: -z (immune to core.quotePath), --no-renames
  // (both sides of a rename listed) — same derivation as verify.mjs scope
  const namesRes = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', `${values.base}...HEAD`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (namesRes.status !== 0) fail(`git diff --name-only failed in ${repo}: ${(namesRes.stderr ?? '').trim()}`);
  const changedPaths = namesRes.stdout.split('\0').filter((p) => p.length > 0);
  // the record boundary is NEVER a raw newline — the array is
  // JSON-encoded (one string per record; embedded newline/quote/backslash/
  // non-ASCII stay unambiguous), and the COMPLETE encoded list is written
  // round-stamped so a truncation marker always names a full, current artifact
  const changedPathsJson = `${JSON.stringify(changedPaths, null, 2)}\n`;
  const changedPathsFile = join(dir, `changed-paths-r${round}.json`);
  writeFileSync(changedPathsFile, changedPathsJson);
  const matrixText = readText(join(dir, 'evidence', 'criteria-matrix.json'), 'evidence/criteria-matrix.json');
  let rawMatrix;
  try {
    rawMatrix = JSON.parse(matrixText);
  } catch (err) {
    fail(`criteria-matrix.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObj(rawMatrix)) fail('criteria-matrix.json must be an object keyed by criterion id');
  if (!Array.isArray(criteriaDoc?.criteria) || criteriaDoc.criteria.some((c) => !isObj(c) || typeof c.id !== 'string')) {
    fail('criteria.json does not look like a criteria doc — run pregate.mjs first');
  }
  const knownIds = new Set(criteriaDoc.criteria.map((c) => c.id));
  const strayIds = Object.keys(rawMatrix).filter((id) => !knownIds.has(id));
  if (strayIds.length > 0) fail(`criteria-matrix.json holds entries for unknown criteria (${strayIds.join(', ')}) — corrupt evidence, fail closed`);
  // the reviewer's criterion
  // representation derives from the approval-bound criterion METHOD plus the
  // VALIDATED adjudication state it just computed — a raw matrix status can
  // never classify a manual criterion as an automated result, and prompt
  // assembly uses this projection, never the unvalidated matrix bytes
  let governing;
  try {
    ({ governing } = deriveAdjudication({
      stateDir: dir,
      ledgerEntries,
      criteriaDoc,
      approvalBytes: existsSync(join(dir, 'approval.json')) ? readFileSync(join(dir, 'approval.json')) : undefined,
      getHeadSha: () => {
        const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
        if (head.status !== 0) throw new Error(`git rev-parse HEAD failed in ${repo}: ${(head.stderr ?? '').trim()}`);
        return head.stdout.trim();
      },
    }));
  } catch (err) {
    fail(`adjudication state invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  const projected = {};
  const evidenceParts = [];
  for (const c of criteriaDoc.criteria) {
    const m = isObj(rawMatrix[c.id]) ? rawMatrix[c.id] : undefined;
    if (c?.verification?.method === 'manual') {
      const g = governing.get(c.id);
      if (g !== undefined) {
        projected[c.id] = { status: 'adjudicated' };
        evidenceParts.push(`### criterion ${c.id} (adjudicated)\n\n${JSON.stringify(g, null, 2)}`);
      } else {
        projected[c.id] = { status: 'manual' };
        evidenceParts.push(`### criterion ${c.id} (manual)\n\nMANUAL criterion — requires a recorded human adjudication.\nStatement: ${c.statement}`);
      }
      continue;
    }
    const status = m?.status === 'pass' ? 'pass' : 'fail';
    projected[c.id] = { status, ...(typeof m?.evidencePath === 'string' ? { evidencePath: m.evidencePath } : {}) };
    evidenceParts.push(
      `### criterion ${c.id} (${status})\n\n${
        typeof m?.evidencePath === 'string' ? truncateForPrompt(readText(m.evidencePath, m.evidencePath), m.evidencePath) : 'NO EVIDENCE RECORDED for this criterion.'
      }`,
    );
  }
  const projectedMatrixText = `${JSON.stringify(projected, null, 2)}\n`;
  const evidenceSections = evidenceParts.join('\n\n');
  prompt = fillTemplate('challenge-diff.md', {
    TASK_ID: taskId,
    ROUND: String(round),
    DIFF: truncateForPrompt(diffRes.stdout, diffPath),
    PLAN: truncateForPrompt(readText(join(dir, 'plan.md'), 'plan.md'), join(dir, 'plan.md')),
    PLAN_FILES: truncateForPrompt(readText(join(dir, 'plan-files.json'), 'plan-files.json'), join(dir, 'plan-files.json')),
    CHANGED_PATHS: truncateForPrompt(changedPathsJson, changedPathsFile),
    CONFIG: canonicalConfigFromTask(dir),
    CRITERIA: criteriaText,
    MATRIX: projectedMatrixText,
    EVIDENCE: evidenceSections,
    LEDGER: renderLedger(ledgerEntries),
  });
}

const reviewsDir = join(dir, 'reviews');
mkdirSync(reviewsDir, { recursive: true });
const verdictPath = join(reviewsDir, `${kind}-round-${round}-${values.name}.json`);
const abstainPath = verdictPath.replace(/\.json$/, '.abstain.txt');
// A crash after quarantining the verdict may leave its raw sidecar behind.
// Preserve that orphan before producing a fresh result; never clear a live failure.
if (!existsSync(verdictPath) && existsSync(abstainPath)) {
  const archive = mkdtempSync(join(reviewsDir, 'superseded-abstain-'));
  renameSync(abstainPath, join(archive, basename(abstainPath)));
}
if (existsSync(abstainPath)) fail('this round already has an abstention; use the sequencer to resolve it before another review');

// run the reviewer CLI — flags verified against codex-cli 0.144.1
function runReviewer() {
  const outDir = mkdtempSync(join(tmpdir(), 'ben-reviewer-'));
  const outFile = join(outDir, 'last-message.txt');
  try {
    const r = spawnSync(
      values.cli,
      ['exec', '--json', '-C', repo, '-s', 'read-only', '-o', outFile, '--output-schema', join(BEN, 'schemas', 'verdict.json'), prompt],
      { cwd: repo, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 },
    );
    let last = '';
    try {
      last = readFileSync(outFile, 'utf8');
    } catch {
      /* no final message (crash or timeout) — fall back to stdout/stderr below */
    }
    return { ok: r.status === 0 && !r.error, raw: last || r.stdout || r.stderr || '' };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

let raw = '';
for (let attempt = 0; attempt < 2; attempt++) {
  const r = runReviewer();
  raw = r.raw;
  const verdict = r.ok ? extractJson(r.raw) : undefined;
  if (verdict !== undefined && isValidVerdict(verdict)) {
    writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);
    const blockers = (verdict.blockers ?? []).length;
    console.log(`reviewer: ${values.name} verdict ${verdict.verdict} (${blockers} finding(s)) → ${verdictPath}`);
    process.exit(0);
  }
}

// Write the failure marker before raw evidence: a crash cannot expose raw GO as success.
writeFileSync(verdictPath, `${JSON.stringify({ type: 'reviewer-abstain', reason: 'reviewer failed or returned an invalid verdict after one retry' })}\n`);
writeFileSync(join(reviewsDir, `${kind}-round-${round}-${values.name}.abstain.txt`), raw);
console.log(`reviewer: ${values.name} failed or returned an invalid verdict after one retry — abstention saved to ${verdictPath}; raw evidence in .abstain.txt`);
process.exit(1);
