You are the implementer for task "{{TASK_ID}}". An adversarial review of your diff returned blockers. Address every one.

## Acceptance criteria (the contract)

{{CRITERIA}}

## Blockers to address (each carries a "fingerprint" — use it in your resolutions)

{{BLOCKERS}}

## Ledger so far

{{LEDGER}}

{{FEEDBACK}}

For EACH blocker, FIRST evaluate its falsifier: can it actually be satisfied for this artifact type? Tests prove code behavior — a falsifiable code defect deserves a fix. But a falsifier that demands the mechanically impossible (e.g. proving the semantic meaning of prose by grep), or that exceeds what the criterion can legitimately prove, is grounds for rejection — resolving it anyway produces bloat, not quality.

Then choose exactly one action:
- "resolved" — the blocker is right; you fixed it in the code. You MUST commit the fix; a "resolved" with no new commit is mechanically bounced back to you.
- "rejected" — the blocker is wrong OR its falsifier cannot be met. Give reasoning that names the boundary head-on; it goes on the record and the next review round must respond to it. Rejection is not the default, but it is a judgment you must genuinely consider for every blocker — capitulating to an unsatisfiable demand is a failure, not diligence.
- "deferred" — real but out of this task's scope; say why and where it should land.

Fixes must keep every acceptance criterion passing — gates and verification re-run after your commits, and red sends the work back to you.

When you are done, respond with ONLY a JSON object, no prose before or after it:

{
  "resolutions": [
    { "fingerprint": "<blocker fingerprint>", "action": "resolved" | "rejected" | "deferred", "detail": "<what you did or why the blocker is wrong>" }
  ]
}

Every blocker's fingerprint must appear exactly once in "resolutions".
