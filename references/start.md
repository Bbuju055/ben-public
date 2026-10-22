# Start reference

Operator/coordinator reference. Commands here require the corresponding real
human decision or existing authorization; they are never instructions for a
headless work stretch. The sequencer determines which operation is legal.

## Intake — before there is a plan

A plan built on a guessed intent fails at the only gate that matters: the human's. When
the ask is greenfield, ambiguous, or bigger than a repo-local fix, interview the human
before writing the plan. Ask about scope, non-goals, what "done" looks like, what the
human would reject. Write the outcome to `$S/brief.md`; the plan and criteria are derived
from that brief, and `plan.md` must cite it. Skip intake only when the request is already
unambiguous — a named bug, a mechanical change — and say so.

## The loop, step by step (what `next` will drive)

**Start.** `echo ".ben/" >> .gitignore` (commit it), then:

```
node "$BEN/scripts/run.mjs" init --title "<the task, in the human's words>"
```

Add `--greenfield` for a new project. For UI work, add `--e2e-paths` with the
relevant repository globs, for example `--e2e-paths 'src/ui/**,app/**'`.

`init` records the implementation baseline (`BASE` is no longer a shell variable you
must not lose — it is durable in `$S/task.json`), the repo identity, and the caps.
Review budgets are two-tier: the soft budgets (`--plan-rounds` / `--diff-rounds`,
default 3) and the operator's HARD caps (`--plan-rounds-max` / `--diff-rounds-max`,
default 3× the soft value, must be >= it; `adopt` takes the same flags). Between
them a converging review continues autonomously (the convergence policy in [reconciliation](reconcile.md)); the hard caps are
verdict-relevant config, bound into the approval hash — raising one mid-task
voids the approval and re-presents the plan gate.
Make the e2e decision explicit at init: pass `--e2e-paths` for any repo with UI
surface, and if you omit it, say so to the human — the config is verdict-relevant,
displayed in the approval packet and both reviewer prompts, and bound into the
approval hash; changing it later voids the approval.
## Resuming, seeding, adopting

Resuming in the same repo needs no ceremony and no recollection: `run.mjs next`
re-derives the one legal continuation from `$S`. Never rebuild state from memory.

Seeding a task into another repo or worktree must carry the **full** `$S` directory —
`cp -R` the whole thing, never selected files: a missing `rounds.json` silently zeroes
the budget, a missing `reviews/` orphans the ledger. The sequencer refuses a `$S`
without `task.json` rather than guessing; adoption is a deliberate, recorded human act:

```
node "$BEN/scripts/run.mjs" adopt --base <implementation-baseline-sha> --by <user>            # dry-run summary
node "$BEN/scripts/run.mjs" adopt --base <sha> --by <user> --confirm                          # record it
```

The dry run shows rounds, the rendered ledger, approval state, and every recorded gap
(orphaned ledger rounds, legacy formats) before anything is written. A legacy two-hash
approval is cleared and re-presented under full binding — never silently grandfathered.

- **One task, one state dir.** Never reuse `$S` across tasks; budgets and ledgers are
  per-task memory. `init` refuses a dirty dir; `adopt` is the deliberate exception.

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.
