# Known limitations

Ben is experimental. Passing checks and model agreement do not prove correctness.

## Correctness and evidence

| Limit | Implication |
| --- | --- |
| Check adequacy | An e2e criterion can exist without covering the changed behavior. Reviewers must assess coverage. |
| Hosted CI | Ben's CI does not verify target changes. Target PRs do not automatically receive hosted CI proof. |
| Publication observations | Checked for internal consistency, not independently authenticated. Refresh after remote edits. |
| Review ingestion | At most 50 pages of 50 threads, and the first 50 comments per thread. Some comments may be missed. |

## Cost and isolation

- **Spending:** estimates and conservative reservations are not guaranteed billing
  ceilings. Legacy price constants are estimates, not current quotations.
- **Isolation:** the runner requires macOS `sandbox-exec` and compatible model
  CLIs. Interactive checks have no runner sandbox unless supplied its command
  wrapper. Environment filtering uses a denylist; it cannot guarantee removal
  of every possible secret.

## Live operation

Bounded acceptance does not prove general autonomous or overnight reliability.
Beyond-soft-cap live continuation remains unexercised and accepted as a release
gap. Installed-service and OS recovery remain unverified. See
[live verification](VERIFICATION.md#live-acceptance-and-release-decision).

Retries and fresh-context recovery stay within task budgets. Unknown failures,
exhausted recovery, authentication renewal and human gates stop work. Error
classification depends on CLI output.

The service requires a logged-in macOS session. Idle-sleep inhibition does not
prevent logout, forced sleep or shutdown.

## Legacy interface

`src/` is tested but retired. Its approval, manual-criterion and prompt behavior
differs from the active Node scripts. Use the [skill](SKILL.md).

## Regression coverage

| Area | Tests |
| --- | --- |
| Actual-diff e2e applicability | `tests/pregate-script.test.ts` |
| Complete review inputs | `tests/reviewer-script.test.ts` |
| Distinct finding fingerprints | `tests/ledger-script.test.ts` |
| Dirty-worktree stop bindings and PR retry gates | `tests/item16-sequencer.test.ts` |

See [verification](VERIFICATION.md) for recorded results and their scope.
