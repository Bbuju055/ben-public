# Plan reference

`$S` is the target repository’s `.ben/` directory.

This is task-work guidance, not permission to advance the workflow. Perform only
the assigned action. The interactive coordinator returns to `run.mjs next`; a
headless driver returns its report to the runner and never invokes the sequencer,
records a decision, pushes or calls `gh`.

**Plan.** When `next` asks, write these five artifacts into `$S`:

| File | Purpose | Required contents |
| --- | --- | --- |
| `plan.md` | Explain the proposed change. | What, why and how; cite `brief.md`. |
| `criteria.json` | Define the acceptance contract. | Every criterion needs a statement and verification `method`; every non-manual criterion also needs a `command` that proves it. |
| `promises.json` | Bind prose promises to verification. | Pin every capability promised in the plan to the criterion that proves it. Use `[]` when the prose promises nothing beyond the criteria. Remove unsupported promises or pin them to criteria (shrink-or-pin). |
| `plan-files.json` | Declare approximate file scope, not an exact manifest. | Literal repository-relative file paths expected to change. No globs, blank or duplicate entries, `./`, `..` or absolute forms; pregate rejects them. A directory-looking literal is admissible but does not match files for e2e applicability, so declare files individually. |
| `gates.json` | Define the commands that judge the build. | Map each gate name to a shell command. Required for every task; for greenfield work this declares the toolchain. |

`next` runs pregate itself.
Pregate counts the rounds, not you; a crash-replay of the identical failing plan does
not burn budget (the referee dedupes on the complete invocation identity).

- **Manual criteria are adjudicable pre-PR.** Never write one whose check needs
  the open or merged PR; the adjudication gate runs before the diff review.

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.
