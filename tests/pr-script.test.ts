import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { makeTmpDir } from './helpers';

// scripts/pr.mjs — the PR story, ported string-for-string from src/github/pr.ts:
// what/why/how, criteria as sentences with verdicts, MAJOR/NIT as non-blocking notes.

const SCRIPT = fileURLToPath(new URL('../scripts/pr.mjs', import.meta.url));

async function workspace(files: Record<string, unknown>): Promise<string> {
  const dir = await makeTmpDir('pr-');
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function pr(dir: string, ...args: string[]): Promise<ExecResult> {
  return execArgv(['node', SCRIPT, dir, ...args], { cwd: dir, timeoutMs: 30_000 });
}

test('the PR body is the old story: what/why/how, criteria as sentences, notes deduped, blockers excluded', async () => {
  const dir = await workspace({
    'summary.md': 'Adds inventory categories so each product gets a type.\n',
    'plan.md': '# plan\n\nbuild the classifier\n',
    'criteria.json': {
      taskId: 'T1',
      criteria: [
        { id: 'C1', statement: 'every inventory product has a category', verification: { method: 'test', command: 'x' } },
        { id: 'C2', statement: 'a human eyeballs the output once', verification: { method: 'manual' } },
      ],
    },
    'evidence/criteria-matrix.json': { C1: { status: 'pass', evidencePath: 'x' }, C2: { status: 'manual', evidencePath: 'y' } },
    'reviews/plan-round-1-codex.json': {
      verdict: 'NO_GO',
      blockers: [
        { id: 'B1', severity: 'BLOCKER', claim: 'gates the merge, must not appear in notes' },
        { id: 'B2', severity: 'MAJOR', claim: 'naming drifts from the domain model', evidence: 'src/y.ts' },
      ],
    },
    'reviews/diff-round-1-codex.json': {
      verdict: 'GO',
      blockers: [{ id: 'B9', severity: 'MAJOR', claim: 'naming drifts from the domain model', evidence: 'src/y.ts' }],
    },
  });

  const r = await pr(dir, '--title', 'add the classifier core brick');
  expect(r.exitCode).toBe(0);
  const body = await readFile(join(dir, 'pr-body.md'), 'utf8');

  expect(body).toContain('## What\nAdds inventory categories so each product gets a type.');
  expect(body).toContain('## Why\nRequested task: add the classifier core brick');
  expect(body).toContain('<details><summary>Implementation plan</summary>');
  expect(body).toContain('- ✅ every inventory product has a category');
  expect(body).toContain('- 👤 a human eyeballs the output once — **needs a human check before merge**');
  expect(body).toContain('## Review notes — non-blocking');
  expect(body).not.toContain('gates the merge, must not appear in notes'); // BLOCKERs live in the ledger
  // duplicate MAJOR appears once, attributed to its first (plan-round) appearance
  const occurrences = body.split('naming drifts from the domain model').length - 1;
  expect(occurrences).toBe(1);
  expect(body).toContain('(codex, plan review round 1)');
  expect(body).toContain('🤖 opened by ben — the human merges.');
});

test('a note from a round older than the last artifact revision is stamped; later and other-kind notes are not', async () => {
  const dir = await workspace({
    'plan.md': 'p\n',
    'criteria.json': { taskId: 'T1', criteria: [] },
    'reviews/plan-round-1-codex.json': {
      verdict: 'GO',
      blockers: [{ id: 'B1', severity: 'MAJOR', claim: 'stale plan note from round one' }],
    },
    'reviews/plan-round-2-codex.json': {
      verdict: 'GO',
      blockers: [{ id: 'B2', severity: 'NIT', claim: 'fresh plan note from the revising round' }],
    },
    'reviews/diff-round-1-codex.json': {
      verdict: 'GO',
      blockers: [{ id: 'B3', severity: 'MAJOR', claim: 'diff note untouched by plan revisions' }],
    },
    // the reconcile after plan round 2 revised the plan; the diff was never revised
    'ledger.jsonl': [
      JSON.stringify({ ts: 't', kind: 'plan', round: 1, blockerId: 'B0', fingerprint: 'f0', action: 'raised', detail: 'd' }),
      JSON.stringify({ ts: 't', kind: 'plan', round: 2, blockerId: 'B0', fingerprint: 'f0', action: 'resolved', detail: 'd' }),
      '',
    ].join('\n'),
  });

  const r = await pr(dir, '--title', 'stale note stamping');
  expect(r.exitCode).toBe(0);
  const body = await readFile(join(dir, 'pr-body.md'), 'utf8');
  expect(body).toContain('stale plan note from round one _(recorded round 1 — artifact revised since)_');
  expect(body).toContain('fresh plan note from the revising round');
  expect(body).not.toContain('fresh plan note from the revising round _(');
  expect(body).not.toContain('diff note untouched by plan revisions _(');
});

test('missing summary falls back to the title; missing matrix is named, not faked', async () => {
  const dir = await workspace({ 'plan.md': 'p\n', 'criteria.json': { taskId: 'T1', criteria: [] } });
  const r = await pr(dir, '--title', 'tiny task');
  expect(r.exitCode).toBe(0);
  const body = await readFile(join(dir, 'pr-body.md'), 'utf8');
  expect(body).toContain('## What\ntiny task');
  expect(body).toContain('_no criteria matrix found_');
});
