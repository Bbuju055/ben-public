import { existsSync } from 'node:fs';
import { execArgv } from '../lib/exec';

const GIT_TIMEOUT_MS = 60_000;

export async function resolveDefaultBranch(repoPath: string): Promise<string> {
  const remote = await execArgv(['git', '-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (remote.exitCode === 0) {
    return remote.stdout.trim().replace('refs/remotes/origin/', '');
  }
  const local = await execArgv(['git', '-C', repoPath, 'symbolic-ref', '--short', 'HEAD'], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (local.exitCode === 0) return local.stdout.trim();
  throw new Error(`cannot resolve default branch for ${repoPath}: ${local.stderr}`);
}

/** Create the task worktree on a new branch. Idempotent: an existing worktree dir is reused. */
export async function createWorktree(
  repoPath: string,
  branch: string,
  dest: string,
  base: string,
): Promise<void> {
  if (existsSync(dest)) return;
  const add = await execArgv(['git', '-C', repoPath, 'worktree', 'add', '-b', branch, dest, base], {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (add.exitCode === 0) return;
  if (/already exists/.test(add.stderr)) {
    // branch left over from an earlier run — attach a worktree to it instead
    const attach = await execArgv(['git', '-C', repoPath, 'worktree', 'add', dest, branch], {
      cwd: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (attach.exitCode === 0) return;
    throw new Error(`worktree attach failed: ${attach.stderr}`);
  }
  throw new Error(`worktree add failed: ${add.stderr}`);
}

export async function headSha(worktreePath: string): Promise<string> {
  const r = await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(`rev-parse failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** The raw diff of everything the task branch adds over the base (merge-base three-dot form). */
export async function diffSince(worktreePath: string, base: string): Promise<string> {
  const r = await execArgv(['git', 'diff', `${base}...HEAD`], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(`diff failed: ${r.stderr}`);
  return r.stdout;
}

/** Number of commits on the task branch that the base branch does not have. */
export async function commitCountSince(worktreePath: string, base: string): Promise<number> {
  const r = await execArgv(['git', 'rev-list', '--count', `${base}..HEAD`], {
    cwd: worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) throw new Error(`rev-list failed: ${r.stderr}`);
  return Number.parseInt(r.stdout.trim(), 10);
}
