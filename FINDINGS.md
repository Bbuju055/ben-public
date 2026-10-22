# Known limitations

- **Verification adequacy:** an e2e criterion's presence does not establish that
  it covers the changed behavior. Reviewers must judge adequacy; passing commands
  and model agreement can still miss defects.
- **Live reliability:** live blocker reconciliation, review continuation beyond
  the soft cap and full integrated live runner acceptance remain open, as defined
  in the [roadmap](ROADMAP.md#live-verification-open). Scripted actors do not establish
  live model compliance.
- **Hosted evidence:** target PRs do not automatically receive hosted CI proof.
  Checks of ben itself do not establish the correctness of a target change.
- **Spending:** accounting includes estimates and conservative reservations;
  thresholds are not guaranteed billing ceilings. Legacy model-price constants
  are estimates, not current price quotations.
- **Publication:** observations are checked for internal consistency, not
  independently authenticated. Later remote edits require another check.
- **Follow-up context:** review ingestion is bounded to 50 pages of 50 threads
  and the first 50 comments per thread; it cannot guarantee every comment is read.
- **Isolation:** the runner requires macOS `sandbox-exec` and compatible model
  CLIs. Interactive verification acquires no runner sandbox unless its command
  wrapper is supplied. Environment filtering is a denylist, not a guarantee that
  all possible secrets are removed.
- **Unattended recovery:** automatic retries and fresh-context recovery are bounded
  by the existing task budgets. Unknown failures, exhausted recovery, authentication
  renewal and human gates still stop work. Error classification depends on CLI
  output. The service requires a logged-in macOS session; idle-sleep inhibition
  does not prevent logout, forced sleep or shutdown. Local tests do not establish
  full overnight reliability.
- **Legacy implementation:** `src/` is tested but retired; its approval,
  manual-criterion and prompt behavior differs from the active Node scripts.

Regression coverage includes actual-diff e2e applicability and complete review
inputs (`tests/pregate-script.test.ts`, `tests/reviewer-script.test.ts`), distinct
finding fingerprints (`tests/ledger-script.test.ts`), and dirty-worktree stop
bindings and PR retry gates (`tests/item16-sequencer.test.ts`). See
[verification](VERIFICATION.md) for recorded local check results.
