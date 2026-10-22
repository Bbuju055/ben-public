# Reconcile reference

`$S` is the target repository’s `.ben/` directory.

This is task-work guidance, not permission to advance the workflow. Perform only
the assigned action. The interactive coordinator returns to `run.mjs next`; a
headless driver returns its report to the runner and never invokes the sequencer,
records a decision, pushes or calls `gh`.

**Adversarial plan review.** `next` snapshots the artifacts, invokes the reviewer
through `reviewer.mjs` (your hands never assemble prompts or touch verdict JSON), and
adjudicates through `ledger.mjs`. Never edit, tidy, or hand-write a verdict file; an
absent verdict is never a pass.
Past the soft budget the referee applies the convergence policy instead of stopping:
a blocker-bearing round continues to its normal reconcile without a human grant ONLY
while the review is converging (strictly fewer surviving blockers than the previous
consumed round, or the same count made purely of the previous round's exact
fingerprints), up to and including the hard cap round. A stall, the hard cap, or
ANY ambiguity in the durable records (a pregate bounce just before, disagreeing
or malformed grant records, missing bookkeeping) stops at the human gate, and
that stop is itself durable (a per-kind slot in `rounds.json`'s `rounds.gates`):
it survives crashes and re-presents until a recorded human act — a grant for
that kind, a playbook recovery, or ABANDON — clears it.

**Reconcile — proposal before veto before resolutions.** When blockers survive,
`next` tells you to write `$S/proposal.json`: one proposed disposition per blocker,
`[{ "fingerprint", "action": "resolved|rejected|deferred", "detail" }]`. Evaluate every
blocker on its evidence and falsifier. Reject a finding only when the reasoning
supports rejection; explain that reasoning in the proposal. If every finding is
valid, propose resolving every finding. Do not manufacture pushback to satisfy a
quota. Blockers may arrive flagged:
`[prior rejection(s): fp …]` links a finding to earlier rejections and
`[contests: fp …]` carries the reviewers' explicit `respondsTo` handles — both are
context only, never an automatic disposition. Decide each on its merits: the same
previously rejected defect (re-reject, citing the prior reasoning), a legitimate
contest (engage it), or a genuinely new finding (judge it fresh). The human then sees the blockers and
your proposal verbatim at the veto gate; their decision is recorded structurally:

The operator records that decision through the current gate; see
[human decisions](decisions.md). A headless driver never records it.

Only after that do you write `$S/resolutions.json` — and it must match the approved
proposal exactly (a vetoed rejection must become resolved or deferred; an unproposed
rejection is refused structurally). **Empty-veto policy:** when every proposed
disposition is `resolved`, no blocker carries a prior-rejection or contest flag, no
review stop or abstain stands and the ledger tail is exactly this round's raised set,
the veto gate is skipped and the decision is recorded in `veto.jsonl` as
`by: "ben-policy:empty-veto"` (rendered in the approval packet); any doubt keeps the
human gate. `next` then runs `honesty.mjs` ("resolved" over
identical bytes is rejected; "resolved" with no commit is a claim without a diff) and
`ledger.mjs resolve`, and routes exactly as they print. A revised plan returns to
review, never straight to implement.

- **Rejected means rejected.** A verbatim re-raise of a rejected blocker is
  mechanically dropped; contest one explicitly by setting `respondsTo` to the exact
  fingerprint the ledger shows. A reworded or legacy re-raise is not dropped — it
  surfaces flagged `[prior rejection(s): …]` for the human to adjudicate: re-reject
  citing the prior reasoning, engage a legitimate contest, or judge a genuinely new
  defect on its merits. Neither flag is ever an automatic disposition.

- **Convergence is a signal — and now a policy.** Inside the operator's hard cap the
  referee continues a converging review autonomously (strict decrease, or equal count
  that is pure continuation of the previous round's exact fingerprints); no grant
  ceremony is owed for a qualifying continuation. Equal fingerprints show continuity,
  not defect reduction. At a stall or hard cap, present the findings and the recorded
  choices: grant another review round or abandon. Disputed findings use the
  proposal/veto/resolution path; an unresolved blocking finding is not converted
  into a PR note to bypass the gate.

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.
