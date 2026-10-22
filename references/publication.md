# Publication reference

Operator/coordinator reference. Commands here require the corresponding real
human decision or existing authorization; they are never instructions for a
headless work stretch. The sequencer determines which operation is legal.

**PR.** On diff GO, `next` assembles the PR body mechanically (`pr.mjs`: what/why/
how, criteria as sentences with verdicts — adjudicated manual criteria render
their recorded decision and any accepted residual, pending ones keep "needs a
human check before merge" — MAJOR/NIT notes, stale notes stamped) and
records a durable PR intent before emitting — exactly once — the create instruction:

```
git push -u origin <branch>
gh pr create --title "<title>" --body-file .ben/pr-body.md
gh pr view <url> --json url,body,headRefOid,updatedAt > .ben/remote-observation.json
node "$BEN/scripts/run.mjs" record-pr --url <url> --remote-observation .ben/remote-observation.json
```

**Publication integrity — the honest trust boundary.** `record-pr` requires the
fetched remote observation and refuses unless it is internally consistent: the
observed url is the submitted url, the observed head is the reviewed head being
terminalized, and the observed body canonically equals the current generated
body (CRLF→LF, trailing newlines stripped; digests printed on mismatch). The sequencer does
not fetch that observation itself: the observation is a **recorded operator evidence act** — the
same trust class as `record-pr-remote` — NOT authenticated remote provenance.
What is proven mechanically is internal consistency; a remote body edited
AFTER the observation is outside the guarantee and is caught by re-running the
check against a fresh fetch. Success stamps `task.pr.publication`
({bodySha, headRefOid, remoteUpdatedAt, observedAt}). Two commands work on an
already terminal task: `check-pr-body --remote-observation <f>` (truly
read-only — exits 0/1 with digests) and `record-publication
--remote-observation <f> --by <user>` (validates identically against the exact
`task.pr` url/head and the current projection, then appends a durable
`publication` audit entry to the ledger; `task.pr` untouched — this is a
closure record).

If the session dies around PR creation, `next` will never emit a second create
instruction: it stops and requires you to inspect the remote and either `record-pr`
(it exists) or have the human authorize a retry (`record-pr-retry --by <user>`,
single-use, bound to the exact pending attempt). **Always report the PR URL to the
human** — the human merges, ben never does.

If a pending intent's approval is voided (an artifact or the config changed after
approval), the ordinary retry protocol is closed; the human resolves the remote
state instead with the exact commands the gate prints (they carry the pending
intent's `--intent-hash`, so repeating one after an interruption is a safe
no-op): `record-pr-remote --status absent --intent-hash <hash> --by <user>` (no
PR exists — archive the intent and migrate) or `record-pr-remote --status exists
--url <url> --intent-hash <hash> --by <user>` (a PR exists — recorded as a
non-terminal observation). Either way
the task re-earns a fresh complete-context plan review, approval and diff review;
an observed PR becomes terminal via `record-pr` only after a fresh diff GO whose
head matches, and a head mismatch gates for the human, whose recorded exit is
`record-pr-unusable --intent-hash <hash> --by <user>` (the gate prints the exact
hash) or ABANDON. No path on this protocol ever emits a duplicate create.

- **No terminalization without a validated recorded observation.** `record-pr`
  refuses without the fetched remote observation matching the submitted url,
  the reviewed head, and the byte-canonical current body — and the observation
  is operator evidence, not remote provenance; post-observation remote edits
  are caught only by re-checking (`check-pr-body`) against a fresh fetch.

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.
