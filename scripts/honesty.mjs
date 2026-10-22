#!/usr/bin/env node
// honesty — reconcile adjudication.
// Behaviour ported from reconcilePlan()/reconcileDiff()/unresolved()/reconcileRetry()
// in src/orchestrator/machine.ts (legacy implementation).
// Zero dependencies. Node only (git invoked for HEAD in diff mode).
//
// Usage:
//   node scripts/honesty.mjs plan [dir] [--reviewed-plan f] [--reviewed-criteria f] [--resolutions f]
//   node scripts/honesty.mjs diff [dir] --before <sha> [--after <sha>] [--repo <path>] [--resolutions f]
//
// Reads from <dir> (default: cwd):
//   blockers.json            open blockers from the review round (array with fingerprints)
//   resolutions.json         one decision per blocker: { fingerprint, action, detail }
//   plan.md, criteria.json   the (possibly revised) plan artifacts        (plan mode)
//   promises.json            the (possibly revised) promise manifest      (plan mode)
//   plan.reviewed.md         snapshot of the plan the panel reviewed      (plan mode)
//   criteria.reviewed.json   snapshot of the criteria the panel reviewed  (plan mode)
//   promises.reviewed.json   snapshot of the manifest the panel reviewed  (plan mode)
//   plan-files.json + plan-files.reviewed.json, gates.json + gates.reviewed.json
// five-file identity members; a member whose
//                            snapshot is absent (legacy round) is skipped with a
//                            printed notice — honest basis, never qualification
//
// The manifest joins the plan-mode identity check: a reconcile that only pins a prose
// promise to an existing criterion changes promises.json alone, and that is a real
// change. promises.json and its snapshot must both exist or both be absent (a task
// seeded before the manifest existed) — exactly one present fails closed.
//   rounds.json              retry tally (shared with pregate; distinct keys)
//
// diff mode: --before is the HEAD sha when the review round started; --after defaults
// to `git rev-parse HEAD` in --repo (default: <dir>).
//
// The script adjudicates and keeps the retry tally; it does not touch blockers.json or
// the ledger (step 3), and routing after acceptance is the method's job — it only
// prints the routing hint (HEAD moved -> re-gate; unchanged -> back to review).
//
// Exit codes: 0 accepted · 1 rejected, retry · 2 escalated (second consecutive rejection) · 3 usage/IO error

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ACTIONS = ['resolved', 'rejected', 'deferred'];

function fail(msg) {
  console.error(`honesty: ${msg}`);
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

function readBlockers(path) {
  const parsed = JSON.parse(readText(path, 'blockers.json'));
  if (!Array.isArray(parsed) || parsed.some((b) => !isObj(b) || typeof b.fingerprint !== 'string' || b.fingerprint.length === 0)) {
    fail('blockers.json: expected an array of objects each carrying a non-empty "fingerprint"');
  }
  return parsed;
}

// same shape as resolutionSchema in src/schemas.ts, hand-rolled (zero deps);
// a violation is the reconciler's problem, not the caller's — reported, not exit 3
function resolutionIssues(value) {
  if (!Array.isArray(value)) return ['root: expected an array of resolutions'];
  const issues = [];
  value.forEach((r, i) => {
    const at = `resolutions[${i}]`;
    if (!isObj(r)) {
      issues.push(`${at}: expected an object`);
      return;
    }
    if (typeof r.fingerprint !== 'string' || r.fingerprint.length === 0) issues.push(`${at}.fingerprint: expected a non-empty string`);
    if (!ACTIONS.includes(r.action)) issues.push(`${at}.action: expected one of ${ACTIONS.join(' | ')}`);
    if (typeof r.detail !== 'string' || r.detail.length === 0) issues.push(`${at}.detail: expected a non-empty string`);
  });
  return issues;
}

// verbatim behaviour of unresolved() in machine.ts, plus a duplicate check:
// in a file-based world two decisions for one fingerprint is an ambiguity, not a merge
function coverage(blockers, resolutions) {
  const covered = new Set(resolutions.map((r) => r.fingerprint));
  const missing = blockers.filter((b) => !covered.has(b.fingerprint)).map((b) => b.fingerprint);
  if (missing.length > 0) return `resolutions missing for blocker fingerprint(s): ${missing.join(', ')}`;
  const seen = new Set();
  const dupes = new Set();
  for (const r of resolutions) {
    if (seen.has(r.fingerprint)) dupes.add(r.fingerprint);
    seen.add(r.fingerprint);
  }
  if (dupes.size > 0) return `duplicate resolutions for blocker fingerprint(s): ${[...dupes].join(', ')}`;
  return undefined;
}

function readRounds(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObj(parsed)) throw new Error('expected an object');
  return parsed;
}

function headSha(repo) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) fail(`git rev-parse HEAD failed in ${repo}: ${(r.stderr ?? '').trim()}`);
  return r.stdout.trim();
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      'reviewed-plan': { type: 'string', default: 'plan.reviewed.md' },
      'reviewed-criteria': { type: 'string', default: 'criteria.reviewed.json' },
      'reviewed-promises': { type: 'string', default: 'promises.reviewed.json' },
      resolutions: { type: 'string', default: 'resolutions.json' },
      before: { type: 'string' },
      after: { type: 'string' },
      repo: { type: 'string' },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;

const kind = positionals[0];
if (kind !== 'plan' && kind !== 'diff') fail('first argument must be "plan" or "diff"');
const dir = resolve(positionals[1] ?? '.');
const roundsPath = join(dir, 'rounds.json');

const blockers = readBlockers(join(dir, 'blockers.json'));

let resolutions;
let problem;
try {
  resolutions = JSON.parse(readText(join(dir, values.resolutions), values.resolutions));
} catch (err) {
  problem = `output did not match the reconcile schema: ${err instanceof Error ? err.message : String(err)}`;
}
if (!problem) {
  const issues = resolutionIssues(resolutions);
  if (issues.length > 0) problem = `output did not match the reconcile schema: ${issues.join('; ')}`;
}
if (!problem) problem = coverage(blockers, resolutions);

let headMoved; // diff mode only
if (!problem) {
  const claimsResolved = resolutions.some((r) => r.action === 'resolved');
  if (kind === 'plan') {
    const plan = readText(join(dir, 'plan.md'), 'plan.md');
    const criteria = readText(join(dir, 'criteria.json'), 'criteria.json');
    const reviewedPlan = readText(join(dir, values['reviewed-plan']), values['reviewed-plan']);
    const reviewedCriteria = readText(join(dir, values['reviewed-criteria']), values['reviewed-criteria']);
    const promisesPath = join(dir, 'promises.json');
    const reviewedPromisesPath = join(dir, values['reviewed-promises']);
    if (existsSync(promisesPath) !== existsSync(reviewedPromisesPath)) {
      fail(
        `promises.json and ${values['reviewed-promises']} must both exist (snapshot the manifest before every review round) or both be absent`,
      );
    }
    const hasManifest = existsSync(promisesPath);
    const promisesIdentical = !hasManifest || readText(promisesPath, 'promises.json') === readText(reviewedPromisesPath, values['reviewed-promises']);
    // five-file RECONCILE HONESTY comparison: plan-files.json and
    // gates.json join the mutable-artifact identity — a resolution whose only
    // honest change is to either of them is a real change. Per-file legacy
    // rule: a member whose reviewed snapshot does not exist was not part of
    // the reviewed context (a pre-upgrade round) and is skipped with a printed
    // notice — an honest basis, never review qualification (run.mjs owns
    // that). Config is deliberately NOT here: it is sequencer config, not a
    // reconcile-editable plan file (it stays staleness- and approval-bound).
    let extraIdentical = true;
    const legacyNotices = [];
    for (const [current, snapshot] of [
      ['plan-files.json', 'plan-files.reviewed.json'],
      ['gates.json', 'gates.reviewed.json'],
    ]) {
      const snapshotPath = join(dir, snapshot);
      if (!existsSync(snapshotPath)) {
        legacyNotices.push(`${current}: no reviewed snapshot (legacy round) — excluded from the identity comparison`);
        continue;
      }
      const currentPath = join(dir, current);
      // a deleted current file differs from its snapshot: that is a change
      const same = existsSync(currentPath) && readText(currentPath, current) === readText(snapshotPath, snapshot);
      if (!same) extraIdentical = false;
    }
    if (legacyNotices.length > 0) console.log(`honesty: ${legacyNotices.join('; ')}`);
    // honesty check, plan: "resolved" must change a reviewed artifact
    if (claimsResolved && plan === reviewedPlan && criteria === reviewedCriteria && promisesIdentical && extraIdentical) {
      problem = hasManifest
        ? 'blocker(s) marked "resolved" but the plan, criteria, promises, plan-files and gates are identical to the reviewed version — change the artifact or reject with reasoning'
        : 'blocker(s) marked "resolved" but the plan and criteria are identical to the reviewed version — change the artifact or reject with reasoning';
    }
  } else {
    if (!values.before) fail('diff mode requires --before <sha>');
    const after = values.after ?? headSha(resolve(values.repo ?? dir));
    headMoved = after !== values.before;
    // honesty check, diff: "resolved" with no commit is a claim without a diff
    if (!headMoved && claimsResolved) {
      problem = 'blocker(s) marked "resolved" but nothing was committed — commit the fix or reject with reasoning';
    }
  }
}

let rounds;
try {
  rounds = readRounds(roundsPath);
} catch (err) {
  fail(`rounds.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
}

if (problem) {
  // reconcileRetry(): one retry with feedback, then escalate
  rounds.reconcile = (Number.isInteger(rounds.reconcile) && rounds.reconcile >= 0 ? rounds.reconcile : 0) + 1;
  writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
  if (rounds.reconcile > 1) {
    console.log(`reconcile (${kind}) failed twice: ${problem}`);
    process.exit(2);
  }
  console.log(`Reconcile retry\n${problem}\nAddress every blocker fingerprint exactly once and match the required JSON shape.`);
  process.exit(1);
}

rounds.reconcile = 0;
writeFileSync(roundsPath, `${JSON.stringify(rounds, null, 2)}\n`);
if (kind === 'plan') {
  console.log('honesty: reconcile (plan) accepted — revised plan returns to review, never straight to implement');
} else if (headMoved) {
  console.log('honesty: reconcile (diff) accepted — HEAD moved, changed code must pass gates before review (invariant #4)');
} else {
  console.log('honesty: reconcile (diff) accepted — HEAD unchanged (all rejected/deferred), back to diff review');
}
process.exit(0);
