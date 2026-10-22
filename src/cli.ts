import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import config from '../config/ben.config';
import { parseLedger, renderLedger } from './ledger/ledger';
import { execArgv } from './lib/exec';
import { defaultAdapters } from './agents/registry';
import { createPrReal } from './github/pr';
import { runTask, type MachineDeps } from './orchestrator/machine';
import {
  acquireLock,
  approvePlan,
  hashPlanArtifacts,
  listTaskIds,
  loadState,
  newTaskState,
  releaseLock,
  requestAbort,
  saveState,
  statePath,
  taskDir,
} from './orchestrator/state';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
}

function realDeps(): MachineDeps {
  return { adapters: defaultAdapters(), createPr: createPrReal };
}

function usage(): never {
  console.log(
    [
      'ben — deterministic build loop',
      '',
      'usage:',
      '  ben start <repoPath> <description...>   plan → review → APPROVAL GATE → implement → gates → verify → PR',
      '  ben new <repoPath> <description...>     greenfield: init repo + private GitHub remote, then the loop',
      '  ben approve <taskId> [--by <name>]      APPROVE BUILD at the gate (records who/when in state.json)',
      '      --yes                               non-interactive attestation that the printed plan was read',
      '  ben status <taskId>                     current phase, rounds, spend',
      '  ben resume <taskId>                     continue from state.json (re-presents the gate if unapproved)',
      '  ben resume <taskId> --reconcile         at the gate: one more reconciliation round instead of approving',
      '  ben abort <taskId>                      stop at the next phase boundary',
      '  ben list                                all tasks and their phases',
      '',
      'every task pauses at AWAIT_PLAN_APPROVAL before any code is written; --review-plan is retired (always on)',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * The machine-enforced presentation: plan + criteria + files + gates + ledger +
 * unresolved blockers, every time. Returns the sha of exactly what was shown,
 * so approval can be bound to the displayed artifacts.
 */
async function printApprovalPacket(taskId: string): Promise<{ artifactsSha: string; contextSha: string }> {
  const dir = taskDir(taskId);
  const state = await loadState(taskId);
  // ONE read per artifact: the same strings are displayed AND hashed — no re-reads
  const plan = await Bun.file(`${dir}/plan.md`).text();
  const criteria = await Bun.file(`${dir}/criteria.json`).text();
  const planFiles = existsSync(`${dir}/plan-files.json`) ? await Bun.file(`${dir}/plan-files.json`).text() : '';
  const gatesJson = JSON.stringify(state.gates ?? {});
  const ledgerRaw = existsSync(`${dir}/ledger.jsonl`) ? await Bun.file(`${dir}/ledger.jsonl`).text() : '';
  const blockersRaw = existsSync(`${dir}/blockers.json`) ? await Bun.file(`${dir}/blockers.json`).text() : '';
  const lines = [
    `⏸  ${taskId} at AWAIT_PLAN_APPROVAL — no code written yet, nothing spent on implementation.`,
    '',
    '════ PLAN ════',
    plan,
    '════ CRITERIA (the contract) ════',
    criteria,
    '════ FILES THE PLAN TOUCHES ════',
    planFiles,
  ];
  if (planFiles === '') lines.push('(none recorded)');
  lines.push('════ GATES (the commands that will run) ════', gatesJson);
  if (gatesJson === '{}') {
    lines.push('(legacy pre-pin task: gates come from config and are NOT approval-bound — reconcile to pin them)');
  }
  if (ledgerRaw !== '') {
    lines.push('════ REVIEW LEDGER ════', renderLedger(parseLedger(ledgerRaw)));
  }
  if (state.planReviewExhausted) {
    lines.push(
      '════ ⚠ REVIEW BUDGET EXHAUSTED — this is NOT a GO ════',
      `The panel used all ${config.caps.planRounds} plan rounds and still holds the blockers below.`,
      'The plan above is the panel-hardened version; the ledger has the full history.',
      '',
      '── unresolved blockers ──',
      blockersRaw || '[]',
    );
  }
  lines.push('═════════════', 'the exits:', `  APPROVE BUILD:  ben approve ${taskId}`);
  if (blockersRaw !== '') {
    lines.push(`  RECONCILE:      ben resume ${taskId} --reconcile   (one more review round on the blockers)`);
  }
  lines.push(
    `  ABORT:          ben abort ${taskId}   (takes effect on the next resume)`,
    `files, if you want to tweak plan/criteria first: ${dir}/ (edits void any stale approval automatically)`,
  );
  console.log(lines.join('\n'));
  // hash the exact strings that were just displayed — never a fresh disk read
  return {
    artifactsSha: hashPlanArtifacts(plan, criteria, planFiles, gatesJson),
    contextSha: hashPlanArtifacts(ledgerRaw, blockersRaw, '', ''),
  };
}

async function main(): Promise<void> {
  console.error('ben: this TypeScript CLI is retired. Use SKILL.md and scripts/run.mjs for the current workflow; see README.md.');
  const [cmd, ...restRaw] = Bun.argv.slice(2);
  if (restRaw.includes('--review-plan')) {
    console.log('note: --review-plan is retired — the approval gate is always on; every task pauses at AWAIT_PLAN_APPROVAL.');
  }
  const rest = restRaw.filter((a) => a !== '--review-plan');
  switch (cmd) {
    case 'start': {
      const [repoArg, ...descParts] = rest;
      if (!repoArg || descParts.length === 0) usage();
      const repoPath = resolve(repoArg);
      if (!existsSync(repoPath)) {
        console.error(`repo not found: ${repoPath}`);
        process.exit(1);
      }
      const title = descParts.join(' ');
      let taskId = slugify(title);
      if (existsSync(taskDir(taskId))) taskId = `${taskId}-${Date.now() % 10_000}`;
      const state = newTaskState({ taskId, title, repoPath, ceilingUsd: config.budgetUsd });
      await saveState(state);
      console.log(`task ${taskId} created — ${statePath(taskId)}`);
      const final = await runTask(taskId, config, realDeps());
      if (final.phase === 'AWAIT_PLAN_APPROVAL') {
        await printApprovalPacket(taskId);
        break;
      }
      report(final.taskId, final.phase, final.lastError, final.pr?.url);
      break;
    }
    case 'new': {
      const [pathArg, ...descParts] = rest;
      if (!pathArg || descParts.length === 0) usage();
      const repoPath = resolve(pathArg);
      if (existsSync(repoPath)) {
        console.error(`refusing: ${repoPath} already exists — use "ben start" for existing repos`);
        process.exit(1);
      }
      await mkdir(repoPath, { recursive: true });
      for (const args of [
        ['git', 'init', '-b', 'main'],
        ['git', 'commit', '--allow-empty', '-m', 'chore: init'],
        // remote first, before any model spend — if the name is taken we fail here, cheaply
        ['gh', 'repo', 'create', basename(repoPath), '--private', '--source', repoPath, '--push'],
      ]) {
        const r = await execArgv(args, { cwd: repoPath, timeoutMs: 120_000 });
        if (r.exitCode !== 0) {
          console.error(`${args.join(' ')} failed: ${r.stderr.trim()}`);
          console.error(`nothing started — ${repoPath} left as-is for inspection`);
          process.exit(1);
        }
      }
      const title = descParts.join(' ');
      let taskId = slugify(title);
      if (existsSync(taskDir(taskId))) taskId = `${taskId}-${Date.now() % 10_000}`;
      const state = newTaskState({ taskId, title, repoPath, ceilingUsd: config.budgetUsd, greenfield: true });
      await saveState(state);
      console.log(`greenfield task ${taskId} created — repo ${repoPath}`);
      const final = await runTask(taskId, config, realDeps());
      if (final.phase === 'AWAIT_PLAN_APPROVAL') {
        await printApprovalPacket(taskId);
        break;
      }
      report(final.taskId, final.phase, final.lastError, final.pr?.url);
      break;
    }
    case 'approve': {
      const yes = rest.includes('--yes');
      const byIdx = rest.indexOf('--by');
      const approvedBy = byIdx >= 0 && rest[byIdx + 1] ? rest[byIdx + 1]! : (process.env.USER ?? 'unknown');
      const taskId = rest.filter((a, i) => a !== '--yes' && a !== '--by' && i !== byIdx + 1)[0];
      if (!taskId) usage();
      const s = await loadState(taskId);
      if (s.phase !== 'AWAIT_PLAN_APPROVAL') {
        console.error(`nothing to approve: ${taskId} is in ${s.phase}`);
        process.exit(1);
      }
      // machine-enforced presentation: the artifact prints before any approval is possible;
      // the shas of what was DISPLAYED bind the approval — later edits are refused
      const presented = await printApprovalPacket(taskId);
      if (!yes) {
        if (!process.stdin.isTTY) {
          console.error('non-interactive session: re-run with --yes to attest the printed plan was read');
          process.exit(1);
        }
        const answer = prompt('type APPROVE to build (anything else cancels): ');
        if (answer !== 'APPROVE') {
          console.log('not approved — task stays at the gate');
          break;
        }
      }
      await approvePlan(taskId, approvedBy, presented.artifactsSha, presented.contextSha);
      console.log(`✔ plan approved by ${approvedBy} — building`);
      const final = await runTask(taskId, config, realDeps());
      report(final.taskId, final.phase, final.lastError, final.pr?.url);
      break;
    }
    case 'resume': {
      const reconcile = rest.includes('--reconcile');
      const taskId = rest.filter((a) => a !== '--reconcile')[0];
      if (!taskId) usage();
      if (reconcile) {
        // human chose RECONCILE at the gate: one more review round on the open blockers
        const s = await loadState(taskId);
        if (s.phase !== 'AWAIT_PLAN_APPROVAL') {
          console.error(`--reconcile only applies at AWAIT_PLAN_APPROVAL (phase=${s.phase})`);
          process.exit(1);
        }
        // the human's RECONCILE exit checks AND mutates under the same branch lock
        // runTask/approve use, so no concurrent process can interleave; the lock is
        // released by the finally before any exit (never process.exit inside the try)
        let reconcileError = '';
        await acquireLock(s.branch);
        try {
          const fresh = await loadState(taskId);
          if (fresh.phase !== 'AWAIT_PLAN_APPROVAL') {
            reconcileError = `--reconcile raced another process (phase=${fresh.phase}); re-run ben status`;
          } else if (!existsSync(`${taskDir(taskId)}/blockers.json`)) {
            reconcileError =
              'nothing to reconcile — the panel left no unresolved blockers. Approve, abort, or edit ' +
              `${taskDir(taskId)}/plan.md + criteria.json directly (edits void any stale approval automatically).`;
          } else {
            fresh.planApproval = undefined; // any prior approval is void once the plan is revised
            fresh.phase = 'RECONCILE_PLAN';
            await saveState(fresh);
          }
        } finally {
          await releaseLock(s.branch);
        }
        if (reconcileError) {
          console.error(reconcileError);
          process.exit(1);
        }
        const paused = await runTask(taskId, config, realDeps());
        if (paused.phase === 'AWAIT_PLAN_APPROVAL') {
          await printApprovalPacket(taskId);
          break;
        }
        report(paused.taskId, paused.phase, paused.lastError, paused.pr?.url);
        break;
      }
      // run the machine first: abort flags and valid approvals are handled inside;
      // an unapproved gate falls straight back out and re-presents the packet
      const final = await runTask(taskId, config, realDeps());
      if (final.phase === 'AWAIT_PLAN_APPROVAL') {
        await printApprovalPacket(taskId);
        break;
      }
      report(final.taskId, final.phase, final.lastError, final.pr?.url);
      break;
    }
    case 'status': {
      const taskId = rest[0];
      if (!taskId) usage();
      const s = await loadState(taskId);
      console.log(
        [
          `task:    ${s.taskId} — ${s.title}`,
          `phase:   ${s.phase}${s.lastError ? ` (${s.lastError})` : ''}`,
          `rounds:  plan=${s.rounds.plan} gateFix=${s.rounds.gateFix} verifyFix=${s.rounds.verifyFix}`,
          `spend:   $${s.budget.spentUsd.toFixed(2)} / $${s.budget.ceilingUsd}${s.budget.estimated ? ' (estimated)' : ''}`,
          `active:  ${Math.round(s.activeMs / 1000)}s`,
          s.pr ? `pr:      ${s.pr.url}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      break;
    }
    case 'abort': {
      const taskId = rest[0];
      if (!taskId) usage();
      await requestAbort(taskId);
      console.log(`abort requested for ${taskId} — takes effect at the next phase boundary`);
      break;
    }
    case 'list': {
      for (const id of await listTaskIds()) {
        try {
          const s = await loadState(id);
          console.log(`${id}\t${s.phase}\t$${s.budget.spentUsd.toFixed(2)}`);
        } catch {
          console.log(`${id}\t<corrupt state>`);
        }
      }
      break;
    }
    default:
      usage();
  }
}

function report(taskId: string, phase: string, lastError?: string, prUrl?: string): void {
  if (phase === 'DONE') {
    console.log(`✅ ${taskId} DONE${prUrl ? ` — ${prUrl}` : ''}`);
  } else {
    console.log(`🛑 ${taskId} ${phase}${lastError ? ` — ${lastError}` : ''}`);
    console.log(`worktree kept for inspection; state: ${statePath(taskId)}`);
  }
}

await main();
