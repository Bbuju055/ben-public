import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { BenConfig } from '../config';
import type { PrResult } from '../orchestrator/machine';
import { criteriaDocSchema, verdictSchema } from '../schemas';
import { evidenceDir, taskDir, type State } from '../orchestrator/state';
import { execArgv } from '../lib/exec';

const GIT_TIMEOUT_MS = 120_000;

async function readIfExists(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, 'utf8') : '';
}

/**
 * MAJOR/NIT findings from the review panel land on the PR as non-blocking notes
 * (only BLOCKER gates). Read from the persisted verdict files; deduped
 * so a note repeated across rounds appears once.
 */
async function reviewNotes(taskId: string): Promise<string> {
  const dir = join(taskDir(taskId), 'reviews');
  if (!existsSync(dir)) return '';
  // chronological, not alphabetical: plan rounds precede diff rounds, so a note
  // repeated across rounds is attributed to its first appearance
  const chronoKey = (f: string) => f.replace(/^plan-round-(\d+)/, '0-$1').replace(/^diff-round-(\d+)/, '1-$1');
  const files = (await readdir(dir))
    .filter((f) => /^(plan|diff)-round-\d+-.+\.json$/.test(f))
    .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const file of files) {
    const m = file.match(/^(plan|diff)-round-(\d+)-(.+)\.json$/)!;
    const parsed = verdictSchema.safeParse(JSON.parse(await readFile(join(dir, file), 'utf8')));
    if (!parsed.success) continue;
    for (const b of parsed.data.blockers) {
      if (b.severity === 'BLOCKER') continue; // gating findings live in the ledger, not here
      const key = `${b.severity}|${b.claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const evidence = b.evidence?.trim() ? ` — ${b.evidence.trim()}` : '';
      notes.push(`- **${b.severity}** (${m[3]}, ${m[1]} review round ${m[2]}): ${b.claim}${evidence}`);
    }
  }
  if (notes.length === 0) return '';
  return ['## Review notes — non-blocking', 'The review panel recorded these; none of them gate the merge.', ...notes].join('\n');
}

/**
 * The PR body is the story; the diff is the detail. A reviewer must understand
 * what/why/how without opening a single file. Criteria appear as sentences with
 * their verdicts — never as bare ids.
 */
export async function prBody(state: State): Promise<string> {
  const dir = taskDir(state.taskId);
  const summary = (await readIfExists(join(dir, 'summary.md'))).trim();
  const plan = (await readIfExists(join(dir, 'plan.md'))).trim();

  let proof = '_no criteria matrix found_';
  const matrixPath = join(evidenceDir(state.taskId), 'criteria-matrix.json');
  const criteriaPath = join(dir, 'criteria.json');
  if (existsSync(matrixPath) && existsSync(criteriaPath)) {
    const matrix = JSON.parse(await readFile(matrixPath, 'utf8')) as Record<string, { status: string }>;
    const doc = criteriaDocSchema.parse(JSON.parse(await readFile(criteriaPath, 'utf8')));
    proof = doc.criteria
      .map((c) => {
        const status = matrix[c.id]?.status ?? 'missing';
        const icon = status === 'pass' ? '✅' : status === 'manual' ? '👤' : '❌';
        const suffix = status === 'manual' ? ' — **needs a human check before merge**' : '';
        return `- ${icon} ${c.statement}${suffix}`;
      })
      .join('\n');
  }

  const notes = await reviewNotes(state.taskId);

  return [
    '## What',
    summary || state.title,
    '',
    '## Why',
    `Requested task: ${state.title}`,
    '',
    '## How',
    '<details><summary>Implementation plan</summary>',
    '',
    plan || '_no plan recorded_',
    '',
    '</details>',
    '',
    '## Proof — every criterion ran, verdicts below',
    proof,
    '',
    ...(notes ? [notes, ''] : []),
    '🤖 opened by ben — the human merges.',
  ].join('\n');
}

/** Push the task branch and open a PR via gh. The human merges; ben never does. */
export async function createPrReal(state: State, _cfg: BenConfig): Promise<PrResult> {
  const push = await execArgv(['git', 'push', '-u', 'origin', state.branch], {
    cwd: state.worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);

  const title = state.shortTitle ?? state.title.slice(0, 72);
  const create = await execArgv(
    ['gh', 'pr', 'create', '--head', state.branch, '--title', title, '--body', await prBody(state)],
    { cwd: state.worktreePath, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (create.exitCode !== 0) throw new Error(`gh pr create failed: ${create.stderr}`);

  const view = await execArgv(['gh', 'pr', 'view', '--json', 'number,url,headRefOid'], {
    cwd: state.worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (view.exitCode !== 0) throw new Error(`gh pr view failed: ${view.stderr}`);
  const parsed = JSON.parse(view.stdout) as { number: number; url: string; headRefOid: string };
  return { number: parsed.number, url: parsed.url, headSha: parsed.headRefOid };
}
