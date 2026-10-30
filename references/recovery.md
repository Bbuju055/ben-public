# Recovery reference

For operators handling a diagnosed STOP. Commands require the relevant human
decision or existing authorization; they are not headless work instructions.
The sequencer determines the legal next operation.

## Before repairing state

- Preserve evidence. Never rewrite or delete append-only history to make it agree.
- Never fabricate an adjudication outcome.
- Reconstruct a missing derivative only when durable authoritative facts imply it
  unambiguously. Otherwise escalate to the human, including abandonment.
- Apply only the diagnosed repair below. Return to the controller afterward;
  a reference link does not authorize the next phase.

## Locks and incomplete writes

### Stale `.ben/.run-lock`

Confirm the holder PID is dead with `ps -p <pid>`, then delete that lock.
The sequencer never steals it.

### Missing `blockers.json` after `ledger.mjs round`

If the ledger has the round's `raised` entries but the tally has not advanced,
restore `blockers.json` from the verdict's BLOCKER findings using the ledger
fingerprints. Set that round's tally in `rounds.json`. If the evidence is
ambiguous, leave the round's disposition to the human.

### Resolved findings still in `blockers.json`

After a crash in `ledger.mjs resolve`, confirm every open fingerprint has a
ledger resolution before deleting `blockers.json`.

### Grant without its audit line

After a crash in `ledger.mjs grant`, the runner uses saved intent to roll back
the grant, restore its review-stop slot and ask again.

For interactive repair, either remove the partial grant from `rounds.json` and
rerun `record-grant`, or append the missing audit line. Never do both; record
which repair was applied.

### Torn `veto.jsonl` tail

Confirm the preceding record is intact. Remove only the incomplete trailing
fragment and re-record the veto.

### Unreadable `task.json`

Save a copy, remove the broken file, then recreate state in the same directory
with `adopt --base <sha> --by <user> --confirm`. Adoption refuses an existing
`task.json`.

## Review and adjudication

### Exhausted or abstained review

Use the recorded operation to grant another round, or abandon. Disputed findings
use proposal/veto/resolution. Do not hand-edit state to bypass a referee.

### Adjudication register/ledger divergence

The ledger is authoritative. For a partial dual write:

- **Register record without a ledger row:** append the matching audit entry
  (`kind: adjudication`, round 0, fingerprint = record digest, embedded record),
  or remove the register record as never-landed. Never do both; record the choice.
- **Ledger act without a register record:** restore it into `adjudications.json`.
  Preserve all other register records.

### Conflicting adjudication records

For the same binding identity with different content, the human selects the
record reflecting the actual decision. Remove the fabricated record from both
files only if it provably never represented a real act. Otherwise escalate to
ABANDON-level handling; never silently rewrite adjudication history.

## Stale adjudication digest in a pending PR intent

An adjudication recorded after diff GO triggers migration, not corruption.
Run the exact `record-pr-remote` command printed by the gate. The task must
re-earn verification and diff review under the current governing set before
reaching a terminal state.

Preserve the remaining state and evidence for inspection; do no general cleanup.
