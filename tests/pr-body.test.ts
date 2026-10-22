import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { prBody } from '../src/github/pr';
import { evidenceDir, newTaskState, taskDir } from '../src/orchestrator/state';
import { useTmpHome } from './helpers';

beforeEach(async () => {
  await useTmpHome();
});

test('PR body is a readable story: what, why, how, and criteria as sentences', async () => {
  const state = newTaskState({ taskId: 'story', title: 'add dedupe to the webhook', ceilingUsd: 25, repoPath: '/x' });
  state.shortTitle = 'Add webhook dedupe';
  const dir = taskDir('story');
  await mkdir(evidenceDir('story'), { recursive: true });
  await writeFile(join(dir, 'summary.md'), 'Deduplicates webhook deliveries so retries never start two builds.');
  await writeFile(join(dir, 'plan.md'), '# plan\n\nuse a TTL set keyed on event_id');
  await writeFile(
    join(dir, 'criteria.json'),
    JSON.stringify({
      taskId: 'story',
      criteria: [
        { id: 'C1', statement: 'Duplicate event_ids are processed exactly once', verification: { method: 'test', command: 'x', expect: 'exit 0' } },
        { id: 'C2', statement: 'Operator confirms the Slack thread stays readable', verification: { method: 'manual' } },
      ],
    }),
  );
  await writeFile(
    join(evidenceDir('story'), 'criteria-matrix.json'),
    JSON.stringify({ C1: { status: 'pass', evidencePath: 'x' }, C2: { status: 'manual', evidencePath: 'x' } }),
  );

  const body = await prBody(state);

  expect(body).toContain('## What');
  expect(body).toContain('Deduplicates webhook deliveries');
  expect(body).toContain('## Why');
  expect(body).toContain('add dedupe to the webhook');
  expect(body).toContain('## How');
  expect(body).toContain('TTL set keyed on event_id');
  // criteria are sentences with verdicts, never bare ids
  expect(body).toContain('✅ Duplicate event_ids are processed exactly once');
  expect(body).toContain('👤 Operator confirms the Slack thread stays readable — **needs a human check before merge**');
  expect(body).not.toMatch(/- [✅❌👤] C\d+$/m);
  expect(body).not.toContain('## Review notes'); // no reviews recorded → no notes section
});

test('MAJOR/NIT panel findings appear as non-blocking PR notes; BLOCKERs stay out', async () => {
  const state = newTaskState({ taskId: 'noted', title: 'add dedupe', ceilingUsd: 25, repoPath: '/x' });
  const reviewsDir = join(taskDir('noted'), 'reviews');
  await mkdir(reviewsDir, { recursive: true });
  const verdict = (blockers: unknown[]) => JSON.stringify({ verdict: 'GO', blockers, notes: '' });
  await writeFile(
    join(reviewsDir, 'plan-round-1-codex.json'),
    verdict([
      { id: 'B1', severity: 'MAJOR', claim: 'dedupe set is never persisted', evidence: 'src/dedupe.ts:9' },
      { id: 'B2', severity: 'NIT', claim: 'event_id could be a branded type', evidence: 'src/types.ts:3' },
      { id: 'B3', severity: 'BLOCKER', claim: 'cache is unbounded', evidence: 'src/dedupe.ts:14', falsifier: 'show eviction' },
    ]),
  );
  // the same MAJOR repeated in a later round must not duplicate the note
  await writeFile(
    join(reviewsDir, 'diff-round-1-codex.json'),
    verdict([{ id: 'B1', severity: 'MAJOR', claim: 'dedupe set is never persisted', evidence: 'src/dedupe.ts:9' }]),
  );

  const body = await prBody(state);

  expect(body).toContain('## Review notes — non-blocking');
  expect(body).toContain('**MAJOR** (codex, plan review round 1): dedupe set is never persisted — src/dedupe.ts:9');
  expect(body).toContain('**NIT** (codex, plan review round 1): event_id could be a branded type');
  expect(body.match(/dedupe set is never persisted/g)?.length).toBe(1); // deduped across rounds
  expect(body).not.toContain('cache is unbounded'); // BLOCKERs live in the ledger, not the notes
});
