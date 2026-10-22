# Recovery reference

Operator/coordinator reference. Commands here require the corresponding real
human decision or existing authorization; they are never instructions for a
headless work stretch. The sequencer determines which operation is legal.

## Recovery playbook — when `next` says STOP

The sequencer diagnoses; the runner can repair specific, proven partial writes.
Interactive recovery follows the cases below. Hard invariants: never
rewrite or delete append-only ledger history to look consistent; never fabricate an
adjudication outcome; complete a missing derivative only when it is unambiguously
implied by durable authoritative facts; if that bar is not met, the disposition is the
human's (up to and including ABANDON.md). The known partial states:

- **Stale lock** (`.ben/.run-lock`, holder pid dead): verify the pid is truly gone
  (`ps -p <pid>`), then delete the lock file. The sequencer never steals it.

- **Ledger holds `raised` entries for a round, `blockers.json` missing, tally not
  advanced** (crash inside `ledger.mjs round`): the blocker set is unambiguously
  implied by the verdict file plus those entries — restore `blockers.json` from the
  verdict's BLOCKER findings (fingerprints in the ledger lines) and set the round
  tally to that round in `rounds.json`; or abandon the round to the human.

- **Ledger holds resolutions for a round but `blockers.json` still exists** (crash
  inside `ledger.mjs resolve`): the resolutions landed; delete `blockers.json` after
  confirming every open fingerprint has its ledger resolution.

- **Grant in `rounds.json` without its ledger audit line** (crash inside
  `ledger.mjs grant`): the runner uses the saved intent to roll back that grant,
  restore its review-stop slot and ask the same question again. Interactively,
  either remove the half-applied grant object from `rounds.json`
  and re-run `record-grant`, or append the missing audit line by hand — one or the
  other, never both, and say which was done.

- **Torn trailing line in `veto.jsonl`**: the record before the torn line is intact;
  remove the torn fragment (it was never a complete record) and re-record the veto.

- **`task.json` unreadable**: save a copy of the broken file, remove it, then
  re-create the sequencer state via `adopt --base <sha> --by <user> --confirm`
  against the same dir (adopt refuses while a `task.json` exists).

- **Exhausted or abstained review:** grant another round through the recorded
  operation and let the review finish, or abandon. Disputed findings use the
  proposal/veto/resolution path. Hand-editing state to bypass a referee is not a
  supported recovery operation.

- **Adjudication state/ledger divergence** (a record in `adjudications.json`
  whose complete record is absent from the ledger, or vice versa — the
  half-applied dual write): the ledger is the history authority. A register
  record missing its ledger row is completed by appending the matching audit
  entry (kind `adjudication`, round 0, fingerprint = record digest, the record
  embedded) or removed as never-landed; a ledger act missing from the register
  is restored INTO the register (superset-only — never delete other records).
  One or the other, never both, and say which was done.

- **Conflicting adjudication records** (same binding identity, different
  content): the tooling refuses to create these; hand-restored state can hold
  them. The human keeps the record that reflects the actual decision and
  removes the fabricated one FROM BOTH files only if it provably never was a
  real act; otherwise ABANDON-level escalation — adjudication history is never
  silently rewritten.

- **Pending PR intent with a stale adjudication digest** (an adjudication was
  recorded after the intent's earned diff GO): not corruption — the pending-intent
  migration. Run the exact `record-pr-remote` command the gate prints; the
  task re-earns verification and diff review at the current governing set
  before anything terminal.

Everything in `$S` stays on disk for inspection; clean nothing up.

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.
