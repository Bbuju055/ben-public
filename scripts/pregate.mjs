#!/usr/bin/env node
// pregate — plan admissibility.
// Behaviour ported from pregate() in src/orchestrator/machine.ts (legacy implementation).
// Zero dependencies. Node only.
//
// Usage:
//   node scripts/pregate.mjs [dir] [options]
//
// Reads from <dir> (default: cwd):
//   criteria.json     the criteria contract (required)
//   promises.json     the promise manifest (required): every capability the plan's prose
//                     promises, each pinned to the criterion that proves it — the
//                     treadmill fix: prose may not promise what criteria don't pin
//   plan-files.json   literal repo-relative file paths the plan expects to touch
// (required always; strict entry semantics: no blanks,
//                     duplicates, absolute/"./"/".."/"//"/backslash forms, no globs)
//   gates.json        gate name -> shell command — the toolchain that judges the
// build (required always; --greenfield only
//                     sharpens the message)
//   rounds.json       plan-round tally, written on every failed run
//
// Options:
//   --greenfield        plan must declare non-empty gates in gates.json
//   --max-criteria N    default 12
//   --manual-share X    max manual fraction, default 0.3
//   --e2e-paths a,b     globs; plans touching them must carry an e2e criterion
//   --plan-rounds N     escalation cap, default 3
//   --reset             zero the plan-round tally and exit (start of a new task)
//
// Failed-attempt dedupe (referee-owned, rounds.json): a failed run records the
// sha-256 identity of the COMPLETE effective invocation — this script's own bytes,
// every input file's bytes (or absence), and every flag/cap value (pregate consumes
// no environment variables). Re-running the identical failed invocation (e.g. after
// a crash) reports the same problems without consuming another budget unit; any
// verdict-relevant change — including to pregate.mjs itself — is a new attempt.
// Success is never inferred from the failure record.
//
// Exit codes: 0 admissible · 1 failed, replan · 2 escalated (rounds over cap) · 3 usage/IO error

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const METHODS = ['test', 'command', 'e2e', 'manual'];

function fail(msg) {
  console.error(`pregate: ${msg}`);
  process.exit(3);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// non-empty means non-blank: a whitespace-only id, statement or command is a
// placeholder, not a value
function isBlank(v) {
  return typeof v !== 'string' || v.trim().length === 0;
}

// zero-dependency criteria validation, with additional blank and duplicate checks beyond src/schemas.ts
function validateDoc(value) {
  const issues = [];
  if (!isObj(value)) return ['root: expected an object'];
  if (isBlank(value.taskId)) {
    issues.push('taskId: expected a non-empty string');
  }
  if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
    issues.push('criteria: expected a non-empty array');
  } else {
    // criterion ids are the adjudication join key —
    // duplicates are rejected by name, never silently tolerated
    const seenIds = new Set();
    for (const c of value.criteria) {
      if (isObj(c) && !isBlank(c.id)) {
        if (seenIds.has(c.id)) issues.push(`criteria: duplicate id "${c.id}" — one id, one criterion`);
        seenIds.add(c.id);
      }
    }
    value.criteria.forEach((c, i) => {
      const at = `criteria[${i}]`;
      if (!isObj(c)) {
        issues.push(`${at}: expected an object`);
        return;
      }
      if (isBlank(c.id)) issues.push(`${at}.id: expected a non-empty string`);
      if (isBlank(c.statement)) {
        issues.push(`${at}.statement: expected a non-empty string`);
      }
      const v = c.verification;
      if (!isObj(v)) {
        issues.push(`${at}.verification: expected an object`);
        return;
      }
      if (!METHODS.includes(v.method)) {
        issues.push(`${at}.verification.method: expected one of ${METHODS.join(' | ')}`);
      }
      for (const key of ['command', 'expect', 'artifacts']) {
        if (v[key] !== undefined && typeof v[key] !== 'string') {
          issues.push(`${at}.verification.${key}: expected a string`);
        }
      }
    });
  }
  if (
    value.outOfScope !== undefined &&
    (!Array.isArray(value.outOfScope) || value.outOfScope.some((s) => typeof s !== 'string'))
  ) {
    issues.push('outOfScope: expected an array of strings');
  }
  return issues;
}

// every verdict-relevant input is read from `bytes` captured ONCE at startup —
// the judged bytes and the dedupe-identity bytes are the same bytes by construction
function mustRead(bytes, name) {
  if (bytes === undefined) throw new Error(`ENOENT: no such file, ${name}`);
  return bytes;
}

function readCriteriaDoc(bytes) {
  const parsed = JSON.parse(mustRead(bytes, 'criteria.json').toString('utf8'));
  const issues = validateDoc(parsed);
  if (issues.length > 0) throw new Error(issues.join('; '));
  return parsed;
}

// strict semantics: entries are literal, canonical,
// repo-relative, forward-slash FILE paths — an approximate scope declaration,
// never an exact manifest, never a glob/directory policy language. Non-canonical
// or glob-like entries are rejected, never silently interpreted. A literal path
// that happens to name a directory is syntactically admissible and simply inert
// for e2e matching; the actual-diff scope check (verify.mjs scope) is the
// deterministic backstop either way.
function planFileEntryIssue(t) {
  if (t.startsWith('/')) return 'absolute path — repo-relative only';
  if (t.includes('\\')) return 'backslash — forward-slash repo-relative paths only';
  if (/[*?[{]/.test(t)) return 'glob syntax is not supported — declare literal file paths';
  const segments = t.split('/');
  if (segments.some((s) => s === '')) return 'empty path segment ("//" or a leading/trailing slash) — not canonical';
  if (segments.some((s) => s === '.')) return '"./" form — not canonical';
  if (segments.some((s) => s === '..')) return '".." traversal is not allowed';
  return undefined;
}

function readPlanFiles(bytes) {
  const parsed = JSON.parse(mustRead(bytes, 'plan-files.json').toString('utf8'));
  if (!Array.isArray(parsed) || parsed.some((f) => typeof f !== 'string')) {
    throw new Error('expected a JSON array of file paths');
  }
  const issues = [];
  const seen = new Set();
  parsed.forEach((f, i) => {
    // entries are LITERAL — trim is used only to detect all-whitespace
    // blanks; validation and deduplication operate on the exact bytes, so
    // "x" and "x " are distinct legal filenames and are never conflated or
    // normalized. Diagnostics JSON-encode the entry so whitespace is visible.
    if (isBlank(f)) {
      issues.push(`entry ${i}: blank — every entry is a literal repo-relative file path`);
      return;
    }
    const label = `entry ${i} (${JSON.stringify(f.length > 60 ? `${f.slice(0, 57)}...` : f)})`;
    if (seen.has(f)) issues.push(`${label}: duplicate`);
    seen.add(f);
    const issue = planFileEntryIssue(f);
    if (issue) issues.push(`${label}: ${issue}`);
  });
  if (issues.length > 0) throw new Error(issues.join('; '));
  return parsed;
}

// returns undefined when the file is absent (reported as its own problem);
// throws on malformed content
function readPromises(bytes) {
  if (bytes === undefined) return undefined;
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of { promise, criterionRef }');
  parsed.forEach((p, i) => {
    if (!isObj(p) || isBlank(p.promise)) {
      throw new Error(`promises[${i}].promise: expected a non-empty string`);
    }
    if (isBlank(p.criterionRef)) {
      throw new Error(`promises[${i}].criterionRef: expected a non-empty string — every promise pins a criterion`);
    }
  });
  return parsed;
}

// returns undefined when the file is absent; throws on malformed content
function readGates(bytes) {
  if (bytes === undefined) return undefined;
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!isObj(parsed)) throw new Error('expected an object of gate name -> shell command');
  for (const [name, cmd] of Object.entries(parsed)) {
    if (isBlank(cmd)) throw new Error(`gate "${name}" command must be a non-empty string`);
  }
  return parsed;
}

function readRounds(path) {
  if (!existsSync(path)) return { plan: 0 };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObj(parsed) || !Number.isInteger(parsed.plan) || parsed.plan < 0) {
    throw new Error('"plan" must be a non-negative integer');
  }
  return parsed;
}

// ported from machine.ts, dotAll enabled — `**` spans path separators
// AND newlines (a pathname may legally contain one), `*` stays within a segment
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
  return new RegExp(`^${pattern}$`, 's');
}

function positiveInt(raw, name) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer, got "${raw}"`);
  return n;
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      greenfield: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      'max-criteria': { type: 'string', default: '12' },
      'manual-share': { type: 'string', default: '0.3' },
      'e2e-paths': { type: 'string', default: '' },
      'plan-rounds': { type: 'string', default: '3' },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;

const dir = resolve(positionals[0] ?? '.');
const roundsPath = join(dir, 'rounds.json');
const maxCriteria = positiveInt(values['max-criteria'], 'max-criteria');
const planRounds = positiveInt(values['plan-rounds'], 'plan-rounds');
const manualShare = Number(values['manual-share']);
if (!Number.isFinite(manualShare) || manualShare < 0 || manualShare > 1) {
  fail(`--manual-share must be a number in [0, 1], got "${values['manual-share']}"`);
}
// the only normalization anywhere is on the glob side: trim +
// strip leading "./" — plan-files entries and git paths are canonical already
const e2ePaths = values['e2e-paths']
  .split(',')
  .map((s) => s.trim().replace(/^(\.\/)+/, ''))
  .filter(Boolean);

if (values.reset) {
  writeFileSync(roundsPath, `${JSON.stringify({ plan: 0 }, null, 2)}\n`);
  console.log('pregate: plan rounds reset to 0');
  process.exit(0);
}

// capture every verdict-relevant input ONCE: the same bytes feed judgment and
// the dedupe identity, so a concurrent edit cannot bind a verdict to other bytes
const INPUT_NAMES = ['criteria.json', 'promises.json', 'plan-files.json', 'gates.json'];
const inputs = {};
for (const name of INPUT_NAMES) {
  const p = join(dir, name);
  inputs[name] = existsSync(p) ? readFileSync(p) : undefined;
}

const problems = [];
let doc;
try {
  doc = readCriteriaDoc(inputs['criteria.json']);
} catch (err) {
  problems.push(`criteria.json invalid: ${err instanceof Error ? err.message : String(err)}`);
}

if (doc) {
  if (doc.criteria.length > maxCriteria) {
    problems.push(`${doc.criteria.length} criteria exceeds max ${maxCriteria} — decompose the task`);
  }
  const manual = doc.criteria.filter((c) => c.verification.method === 'manual').length;
  if (manual / doc.criteria.length > manualShare) {
    problems.push(`${manual}/${doc.criteria.length} criteria are manual (>${Math.round(manualShare * 100)}%) — decompose further`);
  }
  for (const c of doc.criteria) {
    if (c.verification.method !== 'manual' && isBlank(c.verification.command)) {
      problems.push(`criterion ${c.id} has method "${c.verification.method}" but no command`);
    }
  }
  // the treadmill fix: prose may not promise what criteria don't pin. The manifest is
  // required, and every declared promise must pin an existing criterion — the only two
  // moves are pin (add the criterion) or shrink (delete the promise from the prose).
  try {
    const promises = readPromises(inputs['promises.json']);
    if (promises === undefined) {
      problems.push(
        'promises.json missing — declare the plan\'s promises as [{ "promise", "criterionRef" }] ([] when the prose promises nothing beyond the criteria)',
      );
    } else {
      const ids = new Set(doc.criteria.map((c) => c.id));
      for (const p of promises) {
        if (!ids.has(p.criterionRef)) {
          const text = p.promise.length > 60 ? `${p.promise.slice(0, 57)}...` : p.promise;
          problems.push(`promise "${text}" pins criterion "${p.criterionRef}" which does not exist — pin it to a real criterion or shrink the plan`);
        }
      }
    }
  } catch (err) {
    problems.push(`promises.json invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  // plan-files.json is a required plan artifact with strict entry
  // semantics — validated unconditionally (it previously escaped validation
  // whenever --e2e-paths was unset). Fail closed: without a valid file list
  // the e2e requirement cannot be checked.
  let files;
  try {
    files = readPlanFiles(inputs['plan-files.json']);
  } catch (err) {
    problems.push(`plan-files.json invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  // UI-touching plans must carry an e2e criterion.
  // This declared-side signal is advisory-early; the actual-diff check
  // (verify.mjs scope) is the deterministic backstop after implementation.
  if (e2ePaths.length > 0 && files) {
    const uiTouched = e2ePaths.some((glob) => files.some((f) => globToRegExp(glob).test(f)));
    const hasE2e = doc.criteria.some((c) => c.verification.method === 'e2e');
    if (uiTouched && !hasE2e) {
      problems.push(`plan touches UI paths (${e2ePaths.join(', ')}) but has no e2e criterion`);
    }
  }
  // gates.json is a required plan artifact — validated
  // unconditionally; --greenfield only sharpens the message. verify.mjs gates
  // would otherwise die post-approval at exit 3 on a missing/empty toolchain.
  try {
    const gates = readGates(inputs['gates.json']);
    if (!gates || Object.keys(gates).length === 0) {
      problems.push(
        values.greenfield
          ? 'greenfield plan declares no gates — declare the toolchain (typecheck and test commands at minimum)'
          : 'gates.json missing or empty — declare the toolchain that judges the build (gate name -> shell command)',
      );
    }
  } catch (err) {
    problems.push(`gates.json invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// the COMPLETE effective invocation identity: this script's own bytes, every input
// file's captured bytes (the same bytes that were judged) with presence/absence
// domain-separated so no file content can collide with the absence marker, and
// every flag/cap value. pregate consumes no environment variables. Changing any
// verdict-relevant input — including this referee's implementation — yields a
// different identity.
function invocationIdentity() {
  const h = createHash('sha256');
  h.update(readFileSync(fileURLToPath(import.meta.url)));
  for (const name of INPUT_NAMES) {
    h.update(`|${name}|${inputs[name] === undefined ? 'A' : 'P'}|`);
    if (inputs[name] !== undefined) h.update(inputs[name]);
  }
  h.update(
    `|flags|${JSON.stringify({
      greenfield: values.greenfield,
      maxCriteria,
      manualShare,
      e2ePaths,
      planRounds,
    })}`,
  );
  return h.digest('hex');
}

if (problems.length > 0) {
  let rounds;
  try {
    rounds = readRounds(roundsPath);
  } catch (err) {
    fail(`rounds.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  // full-round semantics: a bounce within budget gets its replan; over cap escalates to the human.
  // recorded grants (ledger.mjs grant) raise the shared plan cap here too, never the tally
  const grantedPlanRounds = (Array.isArray(rounds.grants) ? rounds.grants : [])
    .filter((g) => isObj(g) && g.kind === 'plan' && Number.isInteger(g.rounds) && g.rounds > 0)
    .reduce((sum, g) => sum + g.rounds, 0);
  // failed-attempt dedupe: replaying the identical failed invocation (crash recovery)
  // reports the same problems without consuming another budget unit
  const identity = invocationIdentity();
  const isReplay = rounds.lastPregateFail === identity;
  if (!isReplay) {
    rounds.plan += 1;
    rounds.lastPregateFail = identity;
    writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
  }
  if (rounds.plan > planRounds + grantedPlanRounds) {
    console.log(`pregate failed after ${rounds.plan} plan rounds:\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }
  console.log(`Pregate failed — fix the plan\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}

// success clears the failure record (bookkeeping only — success is judged fresh
// every run and is never inferred from this field)
if (existsSync(roundsPath)) {
  let rounds;
  try {
    rounds = readRounds(roundsPath);
  } catch (err) {
    fail(`rounds.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (rounds.lastPregateFail !== undefined) {
    delete rounds.lastPregateFail;
    writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
  }
}
console.log(`pregate: plan admissible (${doc.criteria.length} criteria)`);
process.exit(0);
