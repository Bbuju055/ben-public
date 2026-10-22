# Design

Claude plans and builds. ben automatically invokes Codex for independent
plan and diff reviews. Scripts enforce the workflow; humans own consequential
decisions.

## Five decisions

| Decision | Why | Tradeoff |
| --- | --- | --- |
| Separate builder and reviewer | Codex examines Claude's artifacts and actual diff, introducing a second judgment. | More latency and model usage; both models can still miss the same defect. |
| Make evidence a gate | Scripts run declared checks and reject unsupported resolution claims. A model saying “done” cannot advance the workflow. | Passing checks proves only what those checks cover; reviewers must assess adequacy. |
| Bind approval to the work | Approval covers five plan artifacts and verdict-relevant configuration. Changed scope requires renewed approval; changed diffs invalidate stale review. | Reapproval adds friction, but prevents an old decision authorizing different work. |
| Preserve decisions across interruptions | An append-only findings ledger, atomic records, and single-writer locks support recovery without relying on chat memory. | Contradictory state stops work and may need human recovery. |
| Bound autonomy with human decisions | Disputed findings, nonconverging work, and exhausted limits can park for an explicit answer. ben never merges or deploys. | The operator must remain available; cost accounting includes estimates, not a guaranteed spending ceiling. |

## Execution boundaries

`run.mjs` sequences work. `pregate.mjs` validates the plan; `verify.mjs` runs
checks. `reviewer.mjs` calls Codex; `ledger.mjs` and `honesty.mjs` preserve findings
and check resolution evidence. `pr.mjs` assembles the handoff for human review.

The optional macOS `runner.mjs` supervises Claude work stretches and owns GitHub
publication. It pins the runtime and isolates driver commands; interactive use
does not automatically provide that sandbox. Model CLIs contact their providers.
PR observations are checked for consistency, not independently authenticated.

Node scripts use built-ins only. The retired TypeScript CLI remains a tested
legacy implementation with different approval and manual-criterion behavior.
The runner is built and locally tested; full live acceptance
remains open. See the [roadmap](ROADMAP.md) for evidence gaps and future work.
For commands and recovery, see [SKILL.md](SKILL.md).
