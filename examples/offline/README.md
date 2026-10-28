# Offline example

Run from the ben checkout with Node.js 24 and Git:

```bash
node examples/offline/run.mjs
```

This uses the real sequencer, approval records, check commands, evidence files,
and PR-body generator. The reviewer always returns a scripted GO; implementation
edits and operator answers are simulated. No credentials, model calls, remote
repository, or publication are involved. It creates local commits in a fresh
temporary repository and prints the evidence directory for inspection.

Observed output (the final temporary path varies):

```text
Offline example: real checks; scripted reviewer and simulated operator decisions.
Task: subtract two numbers, including zero and negative results.
Plan: scripted GO; real sequencer parks for approval.
Simulated operator: approve. Recorded against six artifact/config hashes.
Attempt 1: addition instead of subtraction. Gate fails; no PR intent.
Attempt 2: off-by-one repair. Gate fails; allowance exhausted; human decision required.
Simulated operator: allow one more attempt through the recorded answer operation.
Final: all three cases pass; scripted diff GO; local PR body and intent generated.
Nothing published. No model calls. No live runner acceptance claimed.
```

The script asserts these outcomes and exits nonzero if any stop being true.
Inspect `transcript.txt` for raw command output and `repo/.ben/` for the approval,
decision records, failed and passing evidence, criteria matrix, and PR body.
It stops before publication and does not claim a delivered PR or satisfy the
[live runner acceptance criteria](../../VERIFICATION.md#live-acceptance-and-release-decision). It illustrates why a scripted GO
alone is insufficient: the deliberately wrong code still has to pass real checks.
