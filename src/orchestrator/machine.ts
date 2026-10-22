import { join } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentAdapter, AgentRunResult } from '../agents/types';
import type { BenConfig } from '../config';
import {
  criteriaDocSchema,
  planOutputSchema,
  reconcileDiffOutputSchema,
  reconcilePlanOutputSchema,
  verdictSchema,
  type CriteriaDoc,
  type PlanOutput,
  type Resolution,
  type Verdict,
} from '../schemas';
import { runGates } from '../gates/deterministic';
import { runCriteria, failingCriteria } from '../gates/criteria';
import { truncateForPrompt } from '../gates/evidence';
import {
  appendLedger,
  fingerprintBlocker,
  readLedger,
  rejectedFingerprints,
  renderLedger,
  type LedgerEntry,
  type LedgerKind,
} from '../ledger/ledger';
import {
  abortRequested,
  acquireLock,
  evidenceDir,
  loadState,
  planApprovalCurrent,
  releaseLock,
  saveState,
  taskDir,
  type Phase,
  type State,
} from './state';
import { commitCountSince, createWorktree, diffSince, headSha, resolveDefaultBranch } from './worktree';

export interface PrResult {
  number: number;
  url: string;
  headSha: string;
}

export interface MachineDeps {
  adapters: Record<string, AgentAdapter>;
  createPr: (state: State, cfg: BenConfig) => Promise<PrResult>;
}

export interface RunOpts {
  /** test seam: stop (without cleanup, like a crash) after this many transitions */
  maxTransitions?: number;
  /**
   * Test seam: pause when this phase is reached, before executing it.
   * The human plan gate no longer needs it — AWAIT_PLAN_APPROVAL pauses the loop
   * unconditionally until an approval matching the on-disk plan is recorded.
   */
  stopBefore?: Phase;
}

const PROMPTS_DIR = join(import.meta.dir, '../../prompts');
const VERDICT_SCHEMA_PATH = join(import.meta.dir, '../../schemas/verdict.json');

// --- small helpers ---

function addCost(state: State, r: AgentRunResult): void {
  state.budget.spentUsd += r.costUsd;
  if (r.costIsEstimate) state.budget.estimated = true;
}

function feedbackPath(taskId: string): string {
  return join(taskDir(taskId), 'feedback.md');
}

async function writeFeedback(taskId: string, title: string, body: string): Promise<void> {
  await writeFile(feedbackPath(taskId), `## ${title}\n\n${body}\n`);
}

async function takeFeedback(taskId: string): Promise<string> {
  const p = feedbackPath(taskId);
  if (!existsSync(p)) return '';
  const content = await readFile(p, 'utf8');
  await rm(p, { force: true });
  return content;
}

async function loadPrompt(name: string, vars: Record<string, string>): Promise<string> {
  let text = await readFile(join(PROMPTS_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

async function readCriteria(taskId: string): Promise<CriteriaDoc> {
  const raw = await readFile(join(taskDir(taskId), 'criteria.json'), 'utf8');
  return criteriaDocSchema.parse(JSON.parse(raw));
}

/** Keep only gates whose command actually runs something — '' exits 0 vacuously. */
function nonBlankGates(gates: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!gates) return undefined;
  const real = Object.fromEntries(Object.entries(gates).filter(([, cmd]) => cmd.trim().length > 0));
  return real;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
  return new RegExp(`^${pattern}$`);
}

async function escalate(state: State, reason: string): Promise<State> {
  state.lastError = reason;
  state.phase = 'ESCALATED';
  // the lock is released by runTask's finally AFTER the state is persisted —
  // releasing here would let a second process load the stale pre-terminal phase
  return state;
}

function requireAdapter(deps: MachineDeps, name: string): AgentAdapter {
  const adapter = deps.adapters[name];
  if (!adapter) throw new Error(`no adapter registered under "${name}"`);
  return adapter;
}

// --- the loop ---

export async function runTask(taskId: string, cfg: BenConfig, deps: MachineDeps, opts: RunOpts = {}): Promise<State> {
  // load once only to learn the branch, lock, then RELOAD: decisions must never
  // rest on a snapshot taken before the lock (a concurrent reconcile/approve
  // could have changed phase or approval in between)
  const branch = (await loadState(taskId)).branch;
  await acquireLock(branch);
  let state = await loadState(taskId);
  let transitions = 0;

  try {
  while (state.phase !== 'DONE' && state.phase !== 'ESCALATED') {
    if (opts.stopBefore !== undefined && state.phase === opts.stopBefore) {
      await releaseLock(state.branch); // paused; state already saved
      break;
    }
    if (abortRequested(taskId)) {
      // checked before the approval pause so ABORT works at the gate too
      state = await escalate(state, 'aborted by user');
      await saveState(state);
      break;
    }
    if (state.phase === 'AWAIT_PLAN_APPROVAL' && !(await planApprovalCurrent(state))) {
      // The unavoidable human gate. No approval — or an approval whose sha no longer
      // matches the plan on disk — pauses the loop here, whatever driver is running it.
      if (state.planApproval) {
        state.planApproval = undefined; // plan changed since approval: void it, re-present
        await saveState(state);
      }
      await releaseLock(state.branch); // paused for the human; free the branch for `ben approve`
      break;
    }
    const t0 = Date.now();
    try {
      state = await step(state, cfg, deps, opts);
    } catch (err) {
      state = await escalate(state, `unhandled error in ${state.phase}: ${err instanceof Error ? err.message : String(err)}`);
    }
    state.activeMs += Date.now() - t0;

    if (state.phase !== 'DONE' && state.phase !== 'ESCALATED') {
      if (state.budget.spentUsd >= state.budget.ceilingUsd) {
        state = await escalate(state, `budget ceiling breached: $${state.budget.spentUsd.toFixed(2)} >= $${state.budget.ceilingUsd}`);
      } else if (state.activeMs > cfg.timeoutMinutes * 60_000) {
        state = await escalate(state, `active wall clock exceeded ${cfg.timeoutMinutes} minutes`);
      }
    }
    await saveState(state); // persist FIRST; the finally releases the lock afterwards

    transitions += 1;
    if (opts.maxTransitions !== undefined && transitions >= opts.maxTransitions) return state; // crash simulation: no cleanup
  }
  } finally {
    // never leave a live process holding the branch — runs on every exit path,
    // crash-simulation included (that seam tests state resume, not lock retention);
    // releaseLock is pid-guarded, so releasing an already-released lock is a no-op
    await releaseLock(state.branch);
  }
  return state;
}

async function step(state: State, cfg: BenConfig, deps: MachineDeps, opts: RunOpts): Promise<State> {
  switch (state.phase) {
    case 'INTAKE':
      return intake(state);
    case 'PLAN':
      return plan(state, cfg, deps);
    case 'PREGATE':
      return pregate(state, cfg);
    case 'REVIEW_PLAN':
      return reviewPanel(state, cfg, deps, 'plan', opts);
    case 'RECONCILE_PLAN':
      return reconcilePlan(state, cfg, deps);
    case 'AWAIT_PLAN_APPROVAL':
      // only reachable when runTask verified a current approval — hand off to the build
      state.planReviewExhausted = false;
      state.phase = 'IMPLEMENT';
      return state;
    case 'IMPLEMENT':
      return implement(state, cfg, deps);
    case 'GATES':
      return gates(state, cfg);
    case 'VERIFY':
      return verify(state, cfg);
    case 'REVIEW_DIFF':
      return reviewPanel(state, cfg, deps, 'diff', opts);
    case 'RECONCILE_DIFF':
      return reconcileDiff(state, cfg, deps);
    case 'PR':
      return openPr(state, cfg, deps);
    default:
      // AWAIT_HUMAN and ADDRESS_COMMENTS are not implemented
      return escalate(state, `phase ${state.phase} is not implemented yet`);
  }
}

// --- phase handlers ---

async function intake(state: State): Promise<State> {
  await acquireLock(state.branch);
  state.defaultBranch = await resolveDefaultBranch(state.repoPath);
  await createWorktree(state.repoPath, state.branch, state.worktreePath, state.defaultBranch);
  state.phase = 'PLAN';
  return state;
}

async function plan(state: State, cfg: BenConfig, deps: MachineDeps): Promise<State> {
  const planner = requireAdapter(deps, cfg.planner);
  const feedback = await takeFeedback(state.taskId);
  const greenfieldBlock = state.greenfield
    ? [
        '## Greenfield project',
        'This repository is EMPTY — you are bootstrapping it from nothing. Your plan must scaffold the project AND declare its toolchain.',
        'Add a top-level "gates" object to your JSON: shell commands (typecheck and test at minimum) that must exit 0, runnable from the repo root, using only tools already on this machine (bun, node, npx). Example: "gates": { "typecheck": "bun x tsc --noEmit", "test": "bun test" }.',
        'A greenfield plan with no gates is rejected.',
      ].join('\n')
    : '';
  const prompt = await loadPrompt('plan.md', {
    TASK_ID: state.taskId,
    DESCRIPTION: state.title,
    MAX_CRITERIA: String(cfg.maxCriteria),
    E2E_PATHS: cfg.e2e.requiredForPaths.join(', '),
    GREENFIELD: greenfieldBlock,
    FEEDBACK: feedback ? `## Feedback from the previous attempt — address it\n\n${feedback}` : '',
  });

  const res = await planner.run({
    prompt,
    cwd: state.worktreePath,
    timeoutMs: cfg.agentTimeoutMs,
    readOnly: true,
    sessionId: state.sessions.planner,
  });
  addCost(state, res);
  if (res.sessionId) state.sessions.planner = res.sessionId;

  const parsed = planOutputSchema.safeParse(res.parsed);
  if (!res.ok || !parsed.success) {
    state.retries.plan += 1;
    if (state.retries.plan > 1) {
      return escalate(state, `planner failed twice: ${res.ok ? 'output did not match plan schema' : `exit ${res.exitCode}`}`);
    }
    await writeFeedback(
      state.taskId,
      'Planner retry',
      res.ok
        ? `Your previous reply was not valid JSON matching the required schema. Error: ${parsed.success ? '' : parsed.error.message}`
        : `The previous run failed (exit ${res.exitCode}).`,
    );
    return state; // stay in PLAN
  }

  await writePlanArtifacts(state, parsed.data);
  state.phase = 'PREGATE';
  return state;
}

async function writePlanArtifacts(state: State, plan: PlanOutput): Promise<void> {
  const dir = taskDir(state.taskId);
  await writeFile(join(dir, 'plan.md'), plan.plan);
  await writeFile(join(dir, 'summary.md'), plan.summary);
  await writeFile(join(dir, 'plan-files.json'), JSON.stringify(plan.files, null, 2));
  await writeFile(join(dir, 'criteria.json'), JSON.stringify(plan.criteria, null, 2));
  state.shortTitle = plan.title;
  // Greenfield: the CURRENT plan's declared gates replace any earlier plan's —
  // a replan that omits gates clears them (pregate then rejects it), so a
  // rejected draft's toolchain can never silently survive into a later round.
  // Blank commands are dropped up front: '' would exit 0 having verified nothing.
  if (state.greenfield) state.gates = nonBlankGates(plan.gates);
}

async function pregate(state: State, cfg: BenConfig): Promise<State> {
  const problems: string[] = [];
  let doc: CriteriaDoc | undefined;
  try {
    doc = await readCriteria(state.taskId);
  } catch (err) {
    problems.push(`criteria.json invalid: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (doc) {
    if (doc.criteria.length > cfg.maxCriteria) {
      problems.push(`${doc.criteria.length} criteria exceeds max ${cfg.maxCriteria} — decompose the task`);
    }
    const manual = doc.criteria.filter((c) => c.verification.method === 'manual').length;
    if (manual / doc.criteria.length > 0.3) {
      problems.push(`${manual}/${doc.criteria.length} criteria are manual (>30%) — decompose further`);
    }
    for (const c of doc.criteria) {
      if (c.verification.method !== 'manual' && !c.verification.command) {
        problems.push(`criterion ${c.id} has method "${c.verification.method}" but no command`);
      }
    }
    // UI-touching plans must carry an e2e criterion
    const files: string[] = JSON.parse(await readFile(join(taskDir(state.taskId), 'plan-files.json'), 'utf8'));
    const uiTouched = cfg.e2e.requiredForPaths.some((glob) => files.some((f) => globToRegExp(glob).test(f)));
    const hasE2e = doc.criteria.some((c) => c.verification.method === 'e2e');
    if (uiTouched && !hasE2e) {
      problems.push(`plan touches UI paths (${cfg.e2e.requiredForPaths.join(', ')}) but has no e2e criterion`);
    }
    if (state.greenfield && Object.keys(nonBlankGates(state.gates) ?? {}).length === 0) {
      problems.push('greenfield plan declares no runnable gates — declare the toolchain (typecheck and test commands at minimum; blank commands do not count)');
    }
  }

  if (problems.length > 0) {
    // full-round semantics, same as reviewPanel: a bounce within budget gets its replan
    state.rounds.plan += 1;
    if (state.rounds.plan > cfg.caps.planRounds) {
      return escalate(state, `pregate failed after ${state.rounds.plan} plan rounds:\n- ${problems.join('\n- ')}`);
    }
    await writeFeedback(state.taskId, 'Pregate failed — fix the plan', problems.map((p) => `- ${p}`).join('\n'));
    state.phase = 'PLAN';
    return state;
  }
  // pin the effective gate commands at plan time: the approval hash must cover
  // exactly the executables that will run, for existing repos and greenfield alike
  if (!state.gates || Object.keys(state.gates).length === 0) state.gates = { ...cfg.gates };
  // empty panel = no review phase — but the human approval gate is unavoidable either way
  state.phase = cfg.panel.plan.length > 0 ? 'REVIEW_PLAN' : 'AWAIT_PLAN_APPROVAL';
  return state;
}

async function implement(state: State, cfg: BenConfig, deps: MachineDeps): Promise<State> {
  // Re-validate on EVERY entry (first build, gate-fix and verify-fix retries alike):
  // an artifact edited after the gate check must never be implemented unapproved.
  if (!(await planApprovalCurrent(state))) {
    state.planApproval = undefined;
    state.phase = 'AWAIT_PLAN_APPROVAL';
    return state;
  }
  const implementer = requireAdapter(deps, cfg.implementer);
  const dir = taskDir(state.taskId);
  const planText = await readFile(join(dir, 'plan.md'), 'utf8');
  const criteriaText = await readFile(join(dir, 'criteria.json'), 'utf8');
  const feedback = await takeFeedback(state.taskId);

  const prompt = await loadPrompt('implement.md', {
    TASK_ID: state.taskId,
    PLAN: planText,
    CRITERIA: criteriaText,
    FEEDBACK: feedback ? `## Feedback — the previous attempt failed, fix this\n\n${feedback}` : '',
  });

  const res = await implementer.run({
    prompt,
    cwd: state.worktreePath,
    timeoutMs: cfg.agentTimeoutMs,
    readOnly: false,
    sessionId: state.sessions.implementer,
  });
  addCost(state, res);
  if (res.sessionId) state.sessions.implementer = res.sessionId;

  if (!res.ok) {
    state.retries.implement += 1;
    if (state.retries.implement > 1) {
      return escalate(state, `implementer failed twice (exit ${res.exitCode})`);
    }
    await writeFeedback(state.taskId, 'Implementer retry', `The previous run failed (exit ${res.exitCode}). Continue where you left off.`);
    return state; // stay in IMPLEMENT
  }

  const commits = await commitCountSince(state.worktreePath, state.defaultBranch);
  if (commits === 0) {
    state.retries.implement += 1;
    if (state.retries.implement > 1) {
      return escalate(state, 'implementer produced no commits after two attempts');
    }
    await writeFeedback(state.taskId, 'No commits', 'You finished without committing anything. Implement the plan and commit your changes.');
    return state;
  }

  state.phase = 'GATES';
  return state;
}

async function gates(state: State, cfg: BenConfig): Promise<State> {
  const attempt = state.rounds.gateFix + 1;
  const gateCommands = state.gates ?? cfg.gates;
  const results = await runGates(gateCommands, state.worktreePath, evidenceDir(state.taskId), cfg.gateTimeoutMs, `-r${attempt}`);
  const red = results.filter((r) => r.exitCode !== 0);
  if (red.length > 0) {
    state.rounds.gateFix += 1;
    if (state.rounds.gateFix > cfg.caps.gateFixes) {
      return escalate(state, `gates still red after ${cfg.caps.gateFixes} fix attempts: ${red.map((r) => r.name).join(', ')}`);
    }
    const sections = await Promise.all(
      red.map(async (r) => `### gate: ${r.name} (exit ${r.exitCode})\n\n${truncateForPrompt(await readFile(r.evidencePath, 'utf8'), r.evidencePath)}`),
    );
    await writeFeedback(state.taskId, 'Gates failed — raw evidence below', sections.join('\n\n'));
    state.phase = 'IMPLEMENT';
    return state;
  }
  state.phase = 'VERIFY';
  return state;
}

async function verify(state: State, cfg: BenConfig): Promise<State> {
  const doc = await readCriteria(state.taskId);
  const attempt = state.rounds.verifyFix + 1;
  const matrix = await runCriteria(doc, state.worktreePath, taskDir(state.taskId), cfg.e2e, cfg.gateTimeoutMs, `-r${attempt}`);
  const failing = failingCriteria(matrix);
  if (failing.length > 0) {
    state.rounds.verifyFix += 1;
    if (state.rounds.verifyFix > cfg.caps.verifyFixes) {
      return escalate(state, `criteria still failing after ${cfg.caps.verifyFixes} fix attempts: ${failing.join(', ')}`);
    }
    const sections = await Promise.all(
      failing.map(async (id) => {
        const entry = matrix[id];
        if (!entry) return `### criterion ${id}: no matrix entry`;
        return `### criterion ${id} FAILED\n\n${truncateForPrompt(await readFile(entry.evidencePath, 'utf8'), entry.evidencePath)}`;
      }),
    );
    await writeFeedback(state.taskId, 'Criteria failed — raw evidence below', sections.join('\n\n'));
    state.phase = 'IMPLEMENT';
    return state;
  }
  state.phase = cfg.panel.diff.length > 0 ? 'REVIEW_DIFF' : 'PR';
  return state;
}

async function openPr(state: State, cfg: BenConfig, deps: MachineDeps): Promise<State> {
  try {
    state.pr = await deps.createPr(state, cfg);
  } catch (err) {
    state.retries.pr += 1;
    if (state.retries.pr > 1) {
      return escalate(state, `PR creation failed twice: ${err instanceof Error ? err.message : String(err)}`);
    }
    return state; // stay in PR, retry next loop
  }
  state.phase = 'DONE'; // the loop ends at the PR; AWAIT_HUMAN is not implemented
  return state;
}

// --- adversarial review panel + ledger ---

/** A BLOCKER that survived the mechanical filters and awaits reconciliation. */
interface OpenBlocker {
  fingerprint: string;
  reviewer: string;
  id: string;
  claim: string;
  evidence: string;
  falsifier: string;
  criterionRef?: string;
}

function blockersPath(taskId: string): string {
  return join(taskDir(taskId), 'blockers.json');
}

function ledgerEntry(
  kind: LedgerKind,
  round: number,
  reviewer: string,
  blockerId: string,
  fingerprint: string,
  action: LedgerEntry['action'],
  detail: string,
): LedgerEntry {
  return { ts: new Date().toISOString(), kind, round, reviewer, blockerId, fingerprint, action, detail };
}

/**
 * REVIEW_PLAN / REVIEW_DIFF. The round's decision is a pure function of surviving
 * BLOCKERs and abstains: blockers → reconcile (consuming a round from the
 * shared cap), all GO → proceed, any ABSTAIN with no blockers → ESCALATED, all
 * abstain → ESCALATED. MAJOR/NIT stay in the verdict file and never gate.
 */
async function reviewPanel(state: State, cfg: BenConfig, deps: MachineDeps, kind: LedgerKind, opts: RunOpts): Promise<State> {
  const panel = kind === 'plan' ? cfg.panel.plan : cfg.panel.diff;
  const proceed: Phase = kind === 'plan' ? 'AWAIT_PLAN_APPROVAL' : 'PR';
  if (panel.length === 0) {
    state.phase = proceed; // resume-safety: normally PREGATE/VERIFY skip this phase entirely
    return state;
  }

  const round = (kind === 'plan' ? state.rounds.plan : state.rounds.diff) + 1;
  const ledger = await readLedger(state.taskId);
  const priorRejected = rejectedFingerprints(ledger, kind);
  const prompt =
    kind === 'plan'
      ? await buildPlanReviewPrompt(state, round, ledger)
      : await buildDiffReviewPrompt(state, round, ledger);
  const reviewsDir = join(taskDir(state.taskId), 'reviews');
  await mkdir(reviewsDir, { recursive: true });

  const entries: LedgerEntry[] = [];
  const surviving: OpenBlocker[] = [];
  let abstains = 0;

  for (const name of panel) {
    const reviewer = requireAdapter(deps, name);
    let verdict: Verdict | undefined;
    let raw = '';
    for (let attempt = 0; attempt < 2 && verdict === undefined; attempt++) {
      const res = await reviewer.run({
        prompt,
        cwd: state.worktreePath,
        timeoutMs: cfg.agentTimeoutMs,
        readOnly: true,
        schemaPath: VERDICT_SCHEMA_PATH,
      });
      addCost(state, res);
      raw = res.raw;
      if (res.ok) {
        const parsed = verdictSchema.safeParse(res.parsed);
        if (parsed.success) verdict = parsed.data;
      }
    }

    if (verdict === undefined) {
      abstains += 1;
      const rawPath = join(reviewsDir, `${kind}-round-${round}-${name}.abstain.txt`);
      await writeFile(rawPath, raw);
      entries.push(ledgerEntry(kind, round, name, '', '', 'abstain', `output unparseable after one retry — raw at ${rawPath}`));
      continue;
    }
    await writeFile(join(reviewsDir, `${kind}-round-${round}-${name}.json`), JSON.stringify(verdict, null, 2));

    for (const b of verdict.blockers) {
      if (b.severity !== 'BLOCKER') continue; // only BLOCKER gates
      const fp = fingerprintBlocker(b);
      if (!b.evidence?.trim() || !b.falsifier?.trim()) {
        // a blocker that cannot be falsified does not gate
        entries.push(
          ledgerEntry(kind, round, name, b.id, fp, 'auto-dropped', `missing ${b.evidence?.trim() ? 'falsifier' : 'evidence'}: ${b.claim}`),
        );
        continue;
      }
      if (priorRejected.has(fp) && b.respondsTo?.trim() !== fp) {
        entries.push(
          ledgerEntry(kind, round, name, b.id, fp, 're-raise-dropped', `fingerprint ${fp} was rejected in an earlier round and re-raised without respondsTo: ${b.claim}`),
        );
        continue;
      }
      if (surviving.some((s) => s.fingerprint === fp)) continue; // two reviewers, one issue — one ledger thread
      surviving.push({
        fingerprint: fp,
        reviewer: name,
        id: b.id,
        claim: b.claim,
        evidence: b.evidence,
        falsifier: b.falsifier,
        criterionRef: b.criterionRef?.trim() ? b.criterionRef : undefined,
      });
      entries.push(ledgerEntry(kind, round, name, b.id, fp, 'raised', b.claim));
    }
  }

  await appendLedger(state.taskId, entries);

  if (abstains === panel.length) {
    return escalate(
      state,
      `every ${kind} reviewer abstained in round ${round}\n\nLedger:\n${renderLedger(await readLedger(state.taskId))}`,
    );
  }
  if (surviving.length > 0) {
    // Blockers consume a budget unit; the plan counter is shared with pregate bounces.
    // Full-round semantics: a round within budget (count <= cap) gets its reconcile;
    // the cap bites only when a further budget-consuming round would exceed it.
    const rounds = kind === 'plan' ? (state.rounds.plan += 1) : (state.rounds.diff += 1);
    const cap = kind === 'plan' ? cfg.caps.planRounds : cfg.caps.diffRounds;
    await writeFile(blockersPath(state.taskId), JSON.stringify(surviving, null, 2));
    if (rounds > cap) {
      // Plan review exhaustion never throws the hardened plan away: it lands at the
      // unavoidable approval gate with the unresolved blockers on display. The human
      // chooses: `ben approve` (override & build), `ben resume --reconcile` (one more
      // round), `ben abort`. This is NOT a GO — nothing builds until a recorded approval.
      if (kind === 'plan') {
        state.planReviewExhausted = true;
        state.phase = 'AWAIT_PLAN_APPROVAL'; // runTask pauses here without a current approval
        return state;
      }
      return escalate(
        state,
        `${kind} rounds exhausted (${rounds - 1}/${cap} consumed; another blocker-bearing round would exceed the cap)\n\nLedger:\n${renderLedger(await readLedger(state.taskId))}`,
      );
    }
    state.phase = kind === 'plan' ? 'RECONCILE_PLAN' : 'RECONCILE_DIFF';
    return state;
  }
  if (abstains > 0) {
    // unanimous-go: a missing verdict with no blockers is never a pass
    return escalate(state, `unanimous-go violated in ${kind} round ${round}: ${abstains} reviewer(s) abstained with no blockers`);
  }
  if (kind === 'plan') state.planReviewExhausted = false; // clean GO clears any pending human decision
  state.phase = proceed;
  return state;
}

async function buildPlanReviewPrompt(state: State, round: number, ledger: LedgerEntry[]): Promise<string> {
  const dir = taskDir(state.taskId);
  return loadPrompt('challenge-plan.md', {
    TASK_ID: state.taskId,
    ROUND: String(round),
    PLAN: await readFile(join(dir, 'plan.md'), 'utf8'),
    CRITERIA: await readFile(join(dir, 'criteria.json'), 'utf8'),
    LEDGER: renderLedger(ledger),
  });
}

/** Review inputs are the approved plan and raw artifacts, not a completion narrative. */
async function buildDiffReviewPrompt(state: State, round: number, ledger: LedgerEntry[]): Promise<string> {
  const dir = taskDir(state.taskId);
  const diff = await diffSince(state.worktreePath, state.defaultBranch);
  const diffPath = join(dir, `diff-r${round}.patch`); // round-stamped, full diff kept on disk
  await writeFile(diffPath, diff);
  const matrix = JSON.parse(await readFile(join(evidenceDir(state.taskId), 'criteria-matrix.json'), 'utf8')) as Record<
    string,
    { status: string; evidencePath: string }
  >;
  const evidenceSections = await Promise.all(
    Object.entries(matrix).map(
      async ([id, m]) =>
        `### criterion ${id} (${m.status})\n\n${truncateForPrompt(await readFile(m.evidencePath, 'utf8'), m.evidencePath)}`,
    ),
  );
  return loadPrompt('challenge-diff.md', {
    TASK_ID: state.taskId,
    ROUND: String(round),
    DIFF: truncateForPrompt(diff, diffPath),
    CRITERIA: await readFile(join(dir, 'criteria.json'), 'utf8'),
    MATRIX: JSON.stringify(matrix, null, 2),
    EVIDENCE: evidenceSections.join('\n\n'),
    LEDGER: renderLedger(ledger),
  });
}

function unresolved(blockers: OpenBlocker[], resolutions: Resolution[]): string | undefined {
  const covered = new Set(resolutions.map((r) => r.fingerprint));
  const missing = blockers.filter((b) => !covered.has(b.fingerprint)).map((b) => b.fingerprint);
  return missing.length > 0 ? `resolutions missing for blocker fingerprint(s): ${missing.join(', ')}` : undefined;
}

async function reconcileRetry(state: State, kind: LedgerKind, problem: string): Promise<State> {
  state.retries.reconcile += 1;
  if (state.retries.reconcile > 1) {
    return escalate(state, `reconcile (${kind}) failed twice: ${problem}`);
  }
  await writeFeedback(
    state.taskId,
    'Reconcile retry',
    `${problem}\nAddress every blocker fingerprint exactly once and match the required JSON shape.`,
  );
  return state; // stay in the reconcile phase
}

async function appendResolutions(
  state: State,
  kind: LedgerKind,
  round: number,
  blockers: OpenBlocker[],
  resolutions: Resolution[],
): Promise<void> {
  const byFp = new Map(blockers.map((b) => [b.fingerprint, b]));
  const entries = resolutions
    .filter((r) => byFp.has(r.fingerprint))
    .map((r) => {
      const b = byFp.get(r.fingerprint)!;
      return ledgerEntry(kind, round, b.reviewer, b.id, r.fingerprint, r.action, r.detail);
    });
  await appendLedger(state.taskId, entries);
}

async function readOpenBlockers(taskId: string): Promise<OpenBlocker[]> {
  return JSON.parse(await readFile(blockersPath(taskId), 'utf8')) as OpenBlocker[];
}

async function reconcilePlan(state: State, cfg: BenConfig, deps: MachineDeps): Promise<State> {
  const planner = requireAdapter(deps, cfg.planner);
  const dir = taskDir(state.taskId);
  const blockers = await readOpenBlockers(state.taskId);
  const feedback = await takeFeedback(state.taskId);
  const oldPlan = await readFile(join(dir, 'plan.md'), 'utf8');
  const oldCriteria = await readFile(join(dir, 'criteria.json'), 'utf8');
  const prompt = await loadPrompt('reconcile-plan.md', {
    TASK_ID: state.taskId,
    PLAN: oldPlan,
    CRITERIA: oldCriteria,
    BLOCKERS: JSON.stringify(blockers, null, 2),
    LEDGER: renderLedger(await readLedger(state.taskId)),
    MAX_CRITERIA: String(cfg.maxCriteria),
    FEEDBACK: feedback ? `## Feedback from the previous attempt — address it\n\n${feedback}` : '',
  });

  const res = await planner.run({
    prompt,
    cwd: state.worktreePath,
    timeoutMs: cfg.agentTimeoutMs,
    readOnly: true,
    sessionId: state.sessions.planner,
  });
  addCost(state, res);
  if (res.sessionId) state.sessions.planner = res.sessionId;

  const parsed = reconcilePlanOutputSchema.safeParse(res.parsed);
  let problem = !res.ok
    ? `agent failed (exit ${res.exitCode})`
    : !parsed.success
      ? `output did not match the reconcile schema: ${parsed.error.message}`
      : unresolved(blockers, parsed.data.resolutions);
  if (!problem && parsed.success && parsed.data.resolutions.some((r) => r.action === 'resolved')) {
    // honesty check, mirroring reconcileDiff's HEAD compare: "resolved" must change the reviewed artifact
    const unchanged = parsed.data.plan === oldPlan && JSON.stringify(parsed.data.criteria, null, 2) === oldCriteria;
    if (unchanged) {
      problem = 'blocker(s) marked "resolved" but the plan and criteria are identical to the reviewed version — change the artifact or reject with reasoning';
    }
  }
  if (!problem && parsed.success && state.greenfield && Object.keys(nonBlankGates(parsed.data.gates) ?? {}).length === 0) {
    problem = 'greenfield reconcile must re-declare runnable toolchain gates (typecheck and test at minimum) — an empty or blank gate set would verify nothing';
  }
  if (problem) return reconcileRetry(state, 'plan', problem);

  await writePlanArtifacts(state, parsed.data!);
  await appendResolutions(state, 'plan', state.rounds.plan, blockers, parsed.data!.resolutions);
  await rm(blockersPath(state.taskId), { force: true });
  state.retries.reconcile = 0;
  // the revised plan re-earns PREGATE first (criteria shape, manual ratio, e2e
  // coverage, gates) — a reconcile must not be a side door around those checks;
  // on pregate pass it proceeds to the panel exactly as any plan does
  state.phase = 'PREGATE';
  return state;
}

async function reconcileDiff(state: State, cfg: BenConfig, deps: MachineDeps): Promise<State> {
  const implementer = requireAdapter(deps, cfg.implementer);
  const dir = taskDir(state.taskId);
  const blockers = await readOpenBlockers(state.taskId);
  const before = await headSha(state.worktreePath);
  const feedback = await takeFeedback(state.taskId);
  const prompt = await loadPrompt('reconcile-diff.md', {
    TASK_ID: state.taskId,
    CRITERIA: await readFile(join(dir, 'criteria.json'), 'utf8'),
    BLOCKERS: JSON.stringify(blockers, null, 2),
    LEDGER: renderLedger(await readLedger(state.taskId)),
    FEEDBACK: feedback ? `## Feedback from the previous attempt — address it\n\n${feedback}` : '',
  });

  const res = await implementer.run({
    prompt,
    cwd: state.worktreePath,
    timeoutMs: cfg.agentTimeoutMs,
    readOnly: false,
    sessionId: state.sessions.implementer,
  });
  addCost(state, res);
  if (res.sessionId) state.sessions.implementer = res.sessionId;

  const parsed = reconcileDiffOutputSchema.safeParse(res.parsed);
  const after = await headSha(state.worktreePath);
  let problem = !res.ok
    ? `agent failed (exit ${res.exitCode})`
    : !parsed.success
      ? `output did not match the reconcile schema: ${parsed.error.message}`
      : unresolved(blockers, parsed.data.resolutions);
  if (!problem && parsed.success && after === before && parsed.data.resolutions.some((r) => r.action === 'resolved')) {
    // honesty check: "resolved" with no commit is a claim without a diff
    problem = 'blocker(s) marked "resolved" but nothing was committed — commit the fix or reject with reasoning';
  }
  if (problem) return reconcileRetry(state, 'diff', problem);

  await appendResolutions(state, 'diff', state.rounds.diff, blockers, parsed.data!.resolutions);
  await rm(blockersPath(state.taskId), { force: true });
  state.retries.reconcile = 0;
  // HEAD moved → changed code never reaches review ungated;
  // HEAD identical (all rejected/deferred) → straight back to the panel
  state.phase = after === before ? 'REVIEW_DIFF' : 'GATES';
  return state;
}
