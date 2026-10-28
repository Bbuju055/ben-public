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

## Live verification

- Blocker reconciliation (A): passed in two separate synthetic assignments.
- Integrated runner acceptance (E1–E6): passed in one assignment, with human
  amendments and manual recovery.
- Beyond-soft-cap continuation (C/CF-C1): unexercised; release owner accepted
  the gap on 2026-10-28. Campaign closed; no further live attempts.

See [verification](VERIFICATION.md#live-acceptance-and-release-decision) for scope and limitations.

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
