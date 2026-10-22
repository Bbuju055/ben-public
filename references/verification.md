# Verification reference

`$S` is the target repository’s `.ben/` directory.

This is task-work guidance, not permission to advance the workflow. Perform only
the assigned action. The interactive coordinator returns to `run.mjs next`; a
headless driver returns its report to the runner and never invokes the sequencer,
records a decision, pushes or calls `gh`.

**Implement.** Build what the plan says, committing as you go. `next` checks commits against the durable baseline (zero commits is a failure,
in ben's words), then runs scope, gates and criteria. The scope referee re-derives
e2e applicability from the ACTUAL diff (`git diff --name-only --no-renames`): a
diff touching configured e2e paths with no e2e criterion is red no matter what
plan-files.json declared — the declaration can never suppress what the diff
proves. Red comes back as raw, round-stamped
evidence (`$S/evidence/*-rN.txt`) — read it and fix the failure. Interactive
coordinators rerun `next`; headless drivers report the result and return control
to the runner. Never summarize failing output; quote it. A crash between a failed
check and your next move never double-bills the fix budget (tally-bound intents). Manual criteria never auto-pass.

**Adversarial diff review — isolation is the law.** `next` requires a clean
worktree (uncommitted code cannot pass verification while dodging the reviewer),
re-runs gates and criteria at the exact HEAD under review, records that baseline, and
only then invokes the diff reviewer. `reviewer.mjs` builds the prompt from the approved
plan and raw artifacts; a separate completion narrative cannot substitute for them. If HEAD
moves while a verdict is pending, the verdict is quarantined (kept under
`reviews/superseded/`, never deleted) and the changed code re-earns gates, criteria and
review. Reconcile follows [the proposal/veto/resolution protocol](reconcile.md), with `honesty.mjs diff`.

- **The scripts are the referee.** Never hand-simulate a check, never skip one because
  it "obviously passes", never report a check green without having run it this session.

- **The sequencer is the sequence.** Do not perform lifecycle steps by hand around it;
  if `next`'s derivation is wrong, that is a bug to report, not to route around.

- **Raw evidence only.** Failing output is quoted (the scripts truncate mechanically);
  a summary of a failure is not evidence.

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.
