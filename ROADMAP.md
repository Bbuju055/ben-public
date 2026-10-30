# Roadmap

ben is experimental. The core workflow and macOS runner are implemented;
scripted checks and historical live observations do not establish full live
reliability. See [verification](VERIFICATION.md) for local and hosted check results.

## Implemented

- Independent plan and diff review, with an append-only findings ledger.
- Human approval bound to plan artifacts and verdict-relevant configuration.
- A durable sequencer, actual-diff scope checks and recorded verification.
- Park, answer and resume with stale-answer protection.
- A macOS runner with isolated work stretches, publication and recovery paths.
- Bounded transient retries, fresh-context recovery, concurrent task supervision
  and local unattended-readiness reporting.
- Informational target-PR CI status tied to the exact reviewed SHA, refreshed
  explicitly with `status --refresh-ci`; no required-CI gate or automatic merge.
- Opt-in bounded CI-observation scheduler (PR #9), with durable attempt limits,
  polling deadlines and a shared monotonic request timeout. CI observations
  remain informational and cannot authorize task work or publication.
- Offline convergence and recovery coverage, plus a disposable service-adapter
  harness with scripted actors and hosted CI (PRs #2–#5).
- Opt-in runner notifications on park, stop, limit and ready-for-review
  completion, with a durable outbox, bounded retries and stable event IDs
  (PR #7). Notifications default off; sinks must deduplicate event IDs.

## Deferred verification

Installed-service startup, restart and unload cleanup, sleep/wake, logout/login,
and reboot/login remain **unverified and deferred** until an isolated account or
machine is available. Offline recovery checks passed; no service was installed
and no OS transition tests ran. See [verification](VERIFICATION.md#follow-up-verification-2026-10-29).

Live notification providers/deliveries and installed-service notification
behavior also remain **unverified and deferred**. Notification coverage uses
fake local sinks and disposable targets. See
[notification verification](VERIFICATION.md#notifications-verification-2026-10-30)
for the passing post-merge CI result and its scope.

Live scheduler polling and scheduler-specific service integration remain
**unverified and deferred**. Existing offline service fixtures do not establish
that integration. See [scheduler verification](VERIFICATION.md#ci-observer-verification-2026-10-30)
for offline coverage and passing post-merge CI.

## Live verification

- Blocker reconciliation (A): passed in two separate synthetic assignments.
- Integrated runner acceptance (E1–E6): passed in one assignment, with human
  amendments and manual recovery.
- Beyond-soft-cap continuation (C/CF-C1): unexercised; release owner accepted
  the gap on 2026-10-28. Campaign closed; no further live attempts.

See [verification](VERIFICATION.md#live-acceptance-and-release-decision) for scope and limitations.

## Future work

- Richer intake and roadmap assignment.
- Full spend ledger and referee recovery tooling.
- Remote answer, status, abort and note controls.
- Broader automatic PR follow-through beyond bounded informational CI observation.
- Additional reviewers and multi-reviewer policies.
- Execution environments beyond macOS.

These are directions, not delivery commitments. Current follow-up is explicitly
operator-initiated.
