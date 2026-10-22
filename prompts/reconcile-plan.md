You are the planner for task "{{TASK_ID}}". An adversarial review returned blockers against your plan. Address every one, then output the complete revised plan.

## Your current plan

{{PLAN}}

## Current acceptance criteria

{{CRITERIA}}

## Blockers to address (each carries a "fingerprint" — use it in your resolutions)

{{BLOCKERS}}

## Ledger so far

{{LEDGER}}

{{FEEDBACK}}

For EACH blocker, FIRST evaluate its falsifier: can it actually be satisfied for this artifact type? Mechanical checks can prove a document's structure and presence of content; they can never prove the semantic meaning of prose. A falsifier that demands the mechanically impossible, or that exceeds what the criterion can legitimately prove, is grounds for rejection — resolving it anyway produces criteria bloat, not quality.

Then choose exactly one action:
- "resolved" — the blocker is right; you changed the plan or criteria to fix it. Say what changed and where.
- "rejected" — the blocker is wrong OR its falsifier cannot be met (impossible demand, proof boundary exceeded). Give reasoning that names the boundary head-on; it goes on the record and the next review round must respond to it. Rejection is not the default, but it is a judgment you must genuinely consider for every blocker — capitulating to an unsatisfiable demand is a failure, not diligence.
- "deferred" — real but out of this task's scope; say why and where it should land.

Then output the COMPLETE revised plan, even if only part of it changed. The same rules as your original plan apply: at most {{MAX_CRITERIA}} criteria, fewer than 30% manual, every manual criterion checkable before the PR exists (a human adjudicates it at a pre-diff-review gate — never "review the open/merged PR"), every non-manual criterion needs a command that exits 0 from the repo root, and greenfield tasks keep their top-level "gates" object.

Respond with ONLY a JSON object, no prose before or after it:

{
  "title": "<short imperative PR title, max 72 chars>",
  "summary": "<2-4 plain-English sentences: WHAT and WHY, for a reviewer who has not opened the diff>",
  "plan": "<markdown implementation plan: approach, files to change, risks>",
  "files": ["<repo-relative paths you expect to touch>"],
  "criteria": {
    "taskId": "{{TASK_ID}}",
    "criteria": [
      { "id": "C1", "statement": "<specific, verifiable statement>", "verification": { "method": "test", "command": "<shell command>", "expect": "exit 0" } }
    ],
    "outOfScope": ["<explicitly not doing>"]
  },
  "resolutions": [
    { "fingerprint": "<blocker fingerprint>", "action": "resolved" | "rejected" | "deferred", "detail": "<what you did or why the blocker is wrong>" }
  ]
}

Every blocker's fingerprint must appear exactly once in "resolutions".
