# Roadmap

ben is experimental. The core workflow and macOS runner are implemented;
scripted checks and historical live observations do not establish full live
reliability. See [verification](VERIFICATION.md) for local check results.

## Implemented

- Independent plan and diff review, with an append-only findings ledger.
- Human approval bound to plan artifacts and verdict-relevant configuration.
- A durable sequencer, actual-diff scope checks and recorded verification.
- Park, answer and resume with stale-answer protection.
- A macOS runner with isolated work stretches, publication and recovery paths.
- Bounded transient retries, fresh-context recovery, concurrent task supervision
  and local unattended-readiness reporting.

## Live verification open

- **Live blocker reconciliation (A):** real Codex NO_GO → ben's disposition →
  automatic reconciliation or a human veto gate.
- **Review continuation beyond the soft cap (C):** a qualifying live review with
  blockers continues under the convergence policy.
- **Full live runner acceptance:** an integrated assignment through publication
  and recovery drills. Partial historical runs and scripted tests do not establish
  a complete qualifying run.

A failed-check repair (B) and some publication/recovery paths were observed in
historical live runs. Those observations do not close live blocker reconciliation,
review continuation beyond the soft cap or full live runner acceptance.
The [CSV example](examples/csv-export/PROVENANCE.md) is a separate,
bounded interactive happy-path example.

## Future work

- Notifications on park, stop, limit and completion.
- Richer intake and roadmap assignment.
- Full spend ledger and referee recovery tooling.
- Remote answer, status, abort and note controls.
- Automatic PR follow-through and hosted per-task evidence.
- Additional reviewers and multi-reviewer policies.
- Execution environments beyond macOS.

These are directions, not delivery commitments. Current follow-up is explicitly
operator-initiated.
