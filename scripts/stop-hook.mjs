#!/usr/bin/env node
// stop-hook — optional turn-end guard; adapted from unlazy (see ../THIRD_PARTY_NOTICES.md).
// Claude Stop hook: structurally blocks ending the turn while the ben state dir
// (.ben/ in cwd) says the work is not done. Zero tokens — a file scan, not a model call.
//
// Blocks when:
//   - blockers.json holds open blockers (a review round awaiting reconcile)
//   - evidence/criteria-matrix.json has any "fail" (red verify must not end silently)
//   - approval.json exists but no matrix does (an approved build that was never verified)
// Allows when:
//   - no .ben/ state in cwd (ben not active here)
//   - none of the above hold (manual criteria never block — they are the human's)
//   - .ben/ABANDON.md exists — the honest exit; its first line is surfaced, not hidden
//   - no progress across MAX_BLOCKS consecutive blocks (never traps a stuck agent;
//     progress = the state files changed since the last block)
//
// Contract (code.claude.com/docs/en/hooks): stdin JSON {cwd,...};
// stdout {"decision":"block","reason":"..."} + exit 0 blocks; silent exit 0 allows.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitingState } from './adjudication.lib.mjs';

const MAX_BLOCKS = 6;

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  /* stay permissive */
}
const cwd = payload.cwd || process.cwd();
const S = join(cwd, '.ben');
if (!existsSync(S)) process.exit(0); // ben not active here

const read = (name) => {
  try {
    return readFileSync(join(S, name), 'utf8');
  } catch {
    return undefined;
  }
};

const abandon = read('ABANDON.md');
if (abandon !== undefined) {
  const line = abandon.split('\n').find((l) => l.trim() !== '') ?? '(no reason given)';
  console.log(JSON.stringify({ systemMessage: `ben: released by ABANDON.md — ${line.trim()}` }));
  process.exit(0);
}

// A current waiting
// projection whose owner is the human (or the playbook) is the DESIGNED clean
// exit — the turn may end; the parked question survives in .ben/WAITING.md and
// answers are validated fail-closed later. A current MODEL-owned park is the
// opposite: ben still owes follow-up work, so it BLOCKS the stop even when
// nothing else does. Liveness is the shared oracle's call;
// stale/spent leftovers and any oracle error fall through unchanged.
let modelParkReason;
try {
  const ws = waitingState(S, cwd);
  if (ws.state === 'current' && (ws.waiting.owner === 'human' || ws.waiting.owner === 'playbook')) {
    console.log(JSON.stringify({ systemMessage: `ben: parked for the human — ${ws.waiting.question} (.ben/WAITING.md)` }));
    process.exit(0);
  }
  if (ws.state === 'current' && ws.waiting.owner === 'model') {
    modelParkReason = `ben-owned follow-up is parked (${ws.waiting.question}) — run the sequencer (run.mjs next) and finish it`;
  }
} catch {
  /* fail-closed: keep blocking */
}

const reasons = [];
if (modelParkReason !== undefined) reasons.push(modelParkReason);

const blockersRaw = read('blockers.json');
if (blockersRaw !== undefined) {
  try {
    const blockers = JSON.parse(blockersRaw);
    if (Array.isArray(blockers) && blockers.length > 0) {
      reasons.push(`${blockers.length} open blocker(s) await reconcile (blockers.json)`);
    }
  } catch {
    reasons.push('blockers.json is unreadable — resolve or remove it');
  }
}

const matrixRaw = read('evidence/criteria-matrix.json');
if (matrixRaw !== undefined) {
  try {
    const matrix = JSON.parse(matrixRaw);
    const failing = Object.entries(matrix)
      .filter(([, e]) => e?.status === 'fail')
      .map(([id]) => id);
    if (failing.length > 0) reasons.push(`criteria failing: ${failing.join(', ')}`);
  } catch {
    reasons.push('evidence/criteria-matrix.json is unreadable');
  }
} else if (read('approval.json') !== undefined) {
  reasons.push('build was approved but criteria were never verified (no criteria-matrix.json)');
}

if (reasons.length === 0) process.exit(0);

// progress-aware loop guard, as in unlazy: same state blocking forever helps nobody
const statePath = join(S, 'hook-state.json');
// the waiting note's STABLE identity only — its `at` timestamp changes on
// every republication of the same park and must never read as progress
const waitingIdentity = (() => {
  const raw = read('waiting.json');
  if (raw === undefined) return '';
  try {
    const w = JSON.parse(raw);
    return JSON.stringify({ kind: w.kind, owner: w.owner, question: w.question, binding: w.binding });
  } catch {
    return raw;
  }
})();
const hash = createHash('sha256')
  .update(`${blockersRaw ?? ''}|${matrixRaw ?? ''}|${waitingIdentity}`)
  .digest('hex')
  .slice(0, 16);
let state = { hash: '', blocks: 0 };
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
} catch {
  /* fresh */
}
if (state.hash !== hash) state = { hash, blocks: 0 };
state.blocks += 1;
try {
  writeFileSync(statePath, JSON.stringify(state));
} catch {
  /* non-fatal */
}

if (state.blocks > MAX_BLOCKS) {
  console.log(
    JSON.stringify({
      systemMessage: `ben: releasing after ${MAX_BLOCKS} blocks without progress; still not done: ${reasons.join('; ')}`,
    }),
  );
  process.exit(0);
}

console.log(
  JSON.stringify({
    decision: 'block',
    reason: `ben: not done — ${reasons.join('; ')}. Reconcile the blockers / fix the criteria and re-run the scripts, or write .ben/ABANDON.md with the reason (the honest exit — it is surfaced, never silent).`,
  }),
);
process.exit(0);
