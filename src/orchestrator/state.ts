import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, open, rename, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export type Phase =
  | 'INTAKE'
  | 'PLAN'
  | 'PREGATE'
  | 'REVIEW_PLAN'
  | 'RECONCILE_PLAN'
  | 'AWAIT_PLAN_APPROVAL'
  | 'IMPLEMENT'
  | 'GATES'
  | 'VERIFY'
  | 'REVIEW_DIFF'
  | 'RECONCILE_DIFF'
  | 'PR'
  | 'AWAIT_HUMAN'
  | 'ADDRESS_COMMENTS'
  | 'DONE'
  | 'ESCALATED';

export interface State {
  taskId: string;
  /** the full task description, as given */
  title: string;
  /** short imperative PR title from the planner */
  shortTitle?: string;
  source: { kind: 'cli' | 'slack' | 'github' | 'compiler'; ref: string };
  phase: Phase;
  rounds: { plan: number; diff: number; gateFix: number; verifyFix: number; human: number };
  /** one-shot retry counters from the failure table (survive resume) */
  retries: { plan: number; implement: number; pr: number; reconcile: number };
  repoPath: string;
  branch: string;
  defaultBranch: string;
  worktreePath: string;
  /** task started from an empty repo — the first plan must declare the toolchain */
  greenfield?: boolean;
  /** greenfield: gates declared by the plan; overrides config gates for this task */
  gates?: Record<string, string>;
  /** plan-review budget ran out with blockers still open; the approval gate shows them */
  planReviewExhausted?: boolean;
  /**
   * The unavoidable human gate: IMPLEMENT is unreachable until this is recorded
   * AND planSha still matches the plan artifacts the human actually read.
   * A reconciled/revised plan changes the sha and silently voids a stale approval.
   */
  planApproval?: { approvedBy: string; at: string; planSha: string };
  sessions: { planner?: string; implementer?: string };
  slack?: { channel: string; threadTs?: string };
  pr?: { number: number; url: string; headSha: string };
  budget: { spentUsd: number; ceilingUsd: number; estimated: boolean };
  activeMs: number;
  startedAt: string;
  updatedAt: string;
  lastError?: string;
}

export function benHome(): string {
  return process.env.BEN_HOME ?? join(homedir(), '.ben');
}

export function taskDir(taskId: string): string {
  return join(benHome(), 'tasks', taskId);
}

export function statePath(taskId: string): string {
  return join(taskDir(taskId), 'state.json');
}

export function evidenceDir(taskId: string): string {
  return join(taskDir(taskId), 'evidence');
}

export function worktreeRoot(): string {
  return join(benHome(), 'worktrees');
}

export function newTaskState(input: {
  taskId: string;
  title: string;
  repoPath: string;
  ceilingUsd: number;
  sourceKind?: State['source']['kind'];
  sourceRef?: string;
  greenfield?: boolean;
}): State {
  const now = new Date().toISOString();
  return {
    taskId: input.taskId,
    title: input.title,
    source: { kind: input.sourceKind ?? 'cli', ref: input.sourceRef ?? 'cli' },
    phase: 'INTAKE',
    rounds: { plan: 0, diff: 0, gateFix: 0, verifyFix: 0, human: 0 },
    retries: { plan: 0, implement: 0, pr: 0, reconcile: 0 },
    repoPath: input.repoPath,
    branch: `ben/${input.taskId}`,
    defaultBranch: '',
    worktreePath: join(worktreeRoot(), input.taskId),
    greenfield: input.greenfield ?? false,
    sessions: {},
    budget: { spentUsd: 0, ceilingUsd: input.ceilingUsd, estimated: false },
    activeMs: 0,
    startedAt: now,
    updatedAt: now,
  };
}

/** Atomic write: tmp file, fsync, rename. Never a partial state.json. */
export async function saveState(state: State): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const path = statePath(state.taskId);
  await mkdir(taskDir(state.taskId), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`; // pid-unique: concurrent writers never share a tmp file
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

export async function loadState(taskId: string): Promise<State> {
  const raw = await readFile(statePath(taskId), 'utf8');
  const parsed = JSON.parse(raw) as State;
  if (!parsed.taskId || !parsed.phase) {
    throw new Error(`corrupt state file for task ${taskId}`);
  }
  // missing review counters default to 0 so legacy state files resume cleanly
  parsed.retries.reconcile ??= 0;
  return parsed;
}

export async function listTaskIds(): Promise<string[]> {
  const dir = join(benHome(), 'tasks');
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// --- plan approval: the unavoidable human gate ---

/**
 * Content hash of everything a human approves: plan.md, criteria.json,
 * plan-files.json (drives the pregate UI-test decision), and the effective
 * gate commands (executable shell — a gate swap must void an approval).
 */
/** Pure hash over the four artifact strings — callers hash EXACTLY what they displayed. */
export function hashPlanArtifacts(plan: string, criteria: string, planFiles: string, gatesJson: string): string {
  const h = createHash('sha256');
  for (const part of [plan, criteria, planFiles, gatesJson]) {
    h.update(part).update('\0');
  }
  return h.digest('hex');
}

export async function planArtifactsSha(taskId: string, gates: Record<string, string> | undefined): Promise<string> {
  const dir = taskDir(taskId);
  const plan = await readFile(join(dir, 'plan.md'), 'utf8');
  const criteria = await readFile(join(dir, 'criteria.json'), 'utf8');
  let planFiles = '';
  try {
    planFiles = await readFile(join(dir, 'plan-files.json'), 'utf8');
  } catch {
    // absent on very old tasks -- hash the absence consistently
  }
  return hashPlanArtifacts(plan, criteria, planFiles, JSON.stringify(gates ?? {}));
}

/** True only when an approval is recorded AND it still matches the current plan artifacts. */
export async function planApprovalCurrent(state: State): Promise<boolean> {
  if (!state.planApproval) return false;
  try {
    return state.planApproval.planSha === (await planArtifactsSha(state.taskId, state.gates));
  } catch {
    return false; // artifacts missing/unreadable — never treat as approved
  }
}

/**
 * Record the human's APPROVE BUILD decision. Only legal at the gate itself;
 * the recorded sha binds the approval to the exact plan presented. Pass
 * `presentedSha` (hashed when the packet was displayed) so an edit between
 * display and approval is refused, not silently approved. Holds the branch
 * lock so a concurrent runTask or reconcile cannot interleave.
 */
/** Raw review-context bytes (ledger + unresolved blockers) as displayed in the packet. */
export async function reviewContextSha(taskId: string): Promise<string> {
  const dir = taskDir(taskId);
  let ledger = '';
  let blockers = '';
  try { ledger = await readFile(join(dir, 'ledger.jsonl'), 'utf8'); } catch { /* none yet */ }
  try { blockers = await readFile(join(dir, 'blockers.json'), 'utf8'); } catch { /* none open */ }
  return hashPlanArtifacts(ledger, blockers, '', '');
}

export async function approvePlan(
  taskId: string,
  approvedBy: string,
  presentedSha: string,
  presentedContextSha: string,
): Promise<State> {
  const branch = (await loadState(taskId)).branch;
  await acquireLock(branch);
  try {
    const state = await loadState(taskId); // re-read under the lock
    if (state.phase !== 'AWAIT_PLAN_APPROVAL') {
      throw new Error(`approve only applies at AWAIT_PLAN_APPROVAL (task is in ${state.phase})`);
    }
    const currentSha = await planArtifactsSha(taskId, state.gates);
    if (presentedSha !== currentSha) {
      throw new Error('plan artifacts changed after they were presented — re-run approve to read the current plan');
    }
    // the ledger/blockers the human read must also still be what's on disk:
    // a review-context swap that leaves the plan untouched still voids the display
    if (presentedContextSha !== (await reviewContextSha(taskId))) {
      throw new Error('review ledger/blockers changed after they were presented — re-run approve to read the current packet');
    }
    state.planApproval = { approvedBy, at: new Date().toISOString(), planSha: currentSha };
    await saveState(state);
    return state;
  } finally {
    await releaseLock(branch);
  }
}

// --- lock: one per branch, holds the PID ---

function lockPath(branch: string): string {
  return join(benHome(), 'locks', `${branch.replaceAll('/', '--')}.lock`);
}

export class LockHeldError extends Error {
  constructor(branch: string, pid: number) {
    super(`branch ${branch} is locked by live pid ${pid}`);
    this.name = 'LockHeldError';
  }
}

// The branch lock is a kernel flock, taken via bun:ffi on an open fd.
// The kernel releases it the instant the holder dies, so a stale lock cannot
// exist — which deletes the entire reclaim/steal/grace machinery and the
// delete-recreate ABA class that came with it. The lock FILE persists and
// carries the holder pid purely for human diagnostics; its content is never
// what enforcement reads.
import { dlopen, FFIType } from 'bun:ffi';

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/** open fds for locks THIS process holds, keyed by lock path (re-entrancy + release) */
const heldLocks = new Map<string, number>();

export async function acquireLock(branch: string): Promise<void> {
  const path = lockPath(branch);
  if (heldLocks.has(path)) return; // re-entrant within the process
  await mkdir(join(benHome(), 'locks'), { recursive: true });
  const fh = await open(path, 'a'); // create-or-open; never truncates a holder's note
  const rc = libc.symbols.flock(fh.fd, LOCK_EX | LOCK_NB);
  if (rc !== 0) {
    // someone live holds it (kernel guarantees liveness — dead holders auto-release)
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(await readFile(path, 'utf8'), 10);
    } catch {
      // unreadable note — the error still names the branch
    }
    await fh.close();
    throw new LockHeldError(branch, Number.isFinite(holder) ? holder : -1);
  }
  heldLocks.set(path, fh.fd);
  await writeFile(path, String(process.pid)); // diagnostic note only, never enforcement
}

/** Release the lock if this process holds it. A no-op otherwise — never touches others'. */
export async function releaseLock(branch: string): Promise<void> {
  const path = lockPath(branch);
  const fd = heldLocks.get(path);
  if (fd === undefined) return;
  heldLocks.delete(path);
  libc.symbols.flock(fd, LOCK_UN);
  const { close } = await import('node:fs');
  await new Promise<void>((resolve) => close(fd, () => resolve()));
}

// --- abort flag: checked at phase boundaries ---

function abortFlagPath(taskId: string): string {
  return join(taskDir(taskId), 'abort');
}

export async function requestAbort(taskId: string): Promise<void> {
  await mkdir(taskDir(taskId), { recursive: true });
  await writeFile(abortFlagPath(taskId), new Date().toISOString());
}

export function abortRequested(taskId: string): boolean {
  return existsSync(abortFlagPath(taskId));
}
