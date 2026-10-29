# Verification

## Offline and hosted checks

The 2026-10-22 local suite passed: **483 tests, 0 failures, 4,207 assertions**
across 21 files. Typechecking, 17 separate CSV tests and the offline walkthrough
also passed. Environment: macOS 26.1 arm64, Node.js 24.10.0, Bun 1.3.14;
existing dependencies and Chromium were reused.

Published runtime `e60614ba888e1ce3d0651ddef540d6fe72ee02e1` passed
[hosted Checks](https://github.com/Bbuju055/ben-public/actions/runs/39864942671):
core/typecheck/offline/CSV, browser, and macOS isolation. Success was rechecked
on 2026-10-28. Later commits require their own CI result.

Tests use scripted actors and disposable repositories, not live models or
external repository writes. The network-isolation canary contacts `example.com`.
Scripted coverage does not establish live model reliability.

## Follow-up verification (2026-10-29)

The following changes are merged; they do not change the historical live
acceptance claims below.

| Change | Verified scope |
| --- | --- |
| [PR #2](https://github.com/Bbuju055/ben-public/pull/2) | Four scripted runner cases: plan/diff continuation beyond soft caps without grants, then hard-cap or churn stops. |
| [PR #3](https://github.com/Bbuju055/ben-public/pull/3) | Informational CI observations tied to the exact reviewed SHA; offline fixtures cover stale heads, pagination, reruns and unavailable evidence. No delivery-gate change. |
| [PR #4](https://github.com/Bbuju055/ben-public/pull/4) | Preserve ambiguous runner locks; scripted duplicate-start and durable retry-deadline coverage. |
| [PR #5](https://github.com/Bbuju055/ben-public/pull/5) | Five adapter regressions, nine disposable fixtures and four interruption/recovery checkpoints: active actor, before push, after push and after PR creation. |

[Hosted Checks](https://github.com/Bbuju055/ben-public/actions/runs/40945957212)
passed for PR #5 head `c5a98fabf0330d5efd784db45a7e556a68e04028`: core/typecheck/
offline/CSV, browser, macOS isolation, adapter regressions and the recovery
harness. This records the PR run, not a separate post-merge CI result.

Separately, the CI collector passed eight deterministic observations against a
disposable GitHub PR: failure, rerun success, mixed pending/failed/passed statuses,
changed head, pending and cancellation. These used synthetic reviewed SHAs and
no model calls; pagination and API/permission failures remain fixture-tested.

**Deferred, not passed:** installed-service startup, restart and unload cleanup;
sleep/wake, logout/login and reboot/login. No isolated account or machine is
currently available. No service was installed or OS transition test performed.
The recovery harness uses a fixture-specific adapter and skips the live actor
isolation probe; it does not validate the production installer or live actors.

## Running checks

| Command | Scope |
| --- | --- |
| `bun run typecheck` | TypeScript |
| `bun run test` | Main Bun suite; standalone examples and harness run separately |
| `node --test examples/csv-export/export-csv.test.mjs` | CSV example |
| `node examples/offline/run.mjs` | Scripted workflow walkthrough |
| `node --test examples/recovery/adapter.test.mjs` | Adapter shutdown, integrity and fixture-reuse regressions |
| `node examples/recovery/prepare.mjs /absolute/new/fixture-directory` | Full offline recovery harness; fresh directory required, no service installation or OS transitions |

The full suite requires macOS, `/usr/bin/sandbox-exec`, local listeners and
nested sandbox profiles. Browser tests require Chromium:
`PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" ./node_modules/.bin/playwright install chromium`.
CI partitions the suite into `test:core`, `test:browser` and `test:sandbox`.

## Live acceptance and release decision

These results apply to runtime commit `e60614ba888e1ce3d0651ddef540d6fe72ee02e1`.
The acceptance update changes documentation only.

| Claim | Result |
| --- | --- |
| A: live blocker reconciliation | PASS in two separate synthetic assignments. |
| E1–E6: integrated runner acceptance | PASS in the first assignment, with qualifications below. |
| C/CF-C1: natural/controlled beyond-soft-cap continuation | NOT EXERCISED; release owner accepted the gap on 2026-10-28. |

The first assignment exercised real CLIs/isolation, human approval,
implementation/review, manual interruption/recovery and one intended private PR;
56 local tests passed. It required one plan-round grant, two extra stretches
and a publication-retry approval. Recovery used an intentional timing seam and
manual resume, not service/reboot recovery. A separate assignment repaired two
blockers and passed 16 tests; its next review returned GO.

C requires qualifying blocker-bearing continuation beyond the soft cap without
a grant. Successful repairs followed by GO did not exercise it. The final CF-C1
attempt timed out at an external admission gate before its probe ran; no fault
was injected. The campaign is closed; no further live attempts are planned.

Raw evidence and failures remain privately retained. The assignments are
separate evidence, not one all-paths run. Neither target had hosted checks
observed. These bounded results do not establish general autonomous reliability.
