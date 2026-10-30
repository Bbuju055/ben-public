# Verification

## Scope

| Evidence | What it establishes |
| --- | --- |
| Offline and hosted checks | Scripted behavior at the recorded commits; not live model reliability |
| Bounded live acceptance | Qualified success on two synthetic assignments; not general autonomous reliability |
| Deferred tests | Not passed; see the list below |

**Deferred:** live notification deliveries, live scheduler polling,
scheduler-specific service integration, installed-service startup/restart/unload
and notification behavior, and sleep/wake, logout/login and reboot/login recovery.
No isolated account or machine is available for installed-service/OS tests.
One-shot service fixtures and the offline harness do not establish those results.

CI results apply only to their recorded commits. Later commits need their own
results. Follow-up changes below do not expand the historical live claims.

## Running checks

Requires Git, Node.js 24 and Bun 1.3.14. The full suite needs macOS,
`/usr/bin/sandbox-exec`, local listeners and nested sandbox profiles.

| Command | Scope |
| --- | --- |
| `bun run typecheck` | TypeScript |
| `bun run test` | Main Bun suite; examples and harness run separately |
| `node --test examples/csv-export/export-csv.test.mjs` | CSV example |
| `node examples/offline/run.mjs` | Scripted workflow demo |
| `node --test examples/recovery/adapter.test.mjs` | Adapter shutdown, integrity and fixture reuse |
| `node examples/recovery/prepare.mjs /absolute/new/fixture-directory` | Offline recovery harness; requires a fresh directory; no service installation or OS transitions |

Browser tests require Chromium:

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" ./node_modules/.bin/playwright install chromium
```

CI partitions the suite into `test:core`, `test:browser` and `test:sandbox`.
Tests use scripted actors and disposable repositories, not live models or external
repository writes. The network-isolation canary contacts `example.com`.

## Offline and hosted checks

| Record | Result |
| --- | --- |
| Local suite, 2026-10-22 | 483 tests, 0 failures, 4,207 assertions across 21 files; typecheck, 17 separate CSV tests and offline demo passed |
| Environment | macOS 26.1 arm64, Node.js 24.10.0, Bun 1.3.14; existing dependencies and Chromium reused |
| Published runtime `e60614ba888e1ce3d0651ddef540d6fe72ee02e1` | [Hosted Checks passed](https://github.com/Bbuju055/ben-public/actions/runs/39864942671): core/typecheck/offline/CSV, browser, macOS isolation; success rechecked 2026-10-28 |

## Follow-up verification (2026-10-29)

| Merged change | Verified scope |
| --- | --- |
| [PR #2](https://github.com/Bbuju055/ben-public/pull/2) | Four scripted cases: plan/diff continuation beyond soft caps without grants, then hard-cap or churn stops |
| [PR #3](https://github.com/Bbuju055/ben-public/pull/3) | Informational CI tied to reviewed SHA; stale heads, pagination, reruns and unavailable evidence; no delivery-gate change |
| [PR #4](https://github.com/Bbuju055/ben-public/pull/4) | Ambiguous lock preservation, duplicate-start and durable retry-deadline coverage |
| [PR #5](https://github.com/Bbuju055/ben-public/pull/5) | Five adapter regressions, nine fixtures, four interruption checkpoints: active actor, before push, after push, after PR creation |

PR #5 head `c5a98fabf0330d5efd784db45a7e556a68e04028` passed
[hosted Checks](https://github.com/Bbuju055/ben-public/actions/runs/40945957212):
core/typecheck/offline/CSV, browser, macOS isolation, adapter regressions and the
recovery harness. This is PR CI, not a separate post-merge result.

The CI collector also passed eight deterministic observations against a disposable
GitHub PR: failure, rerun success, mixed pending/failed/passed statuses, changed
head, pending and cancellation. Synthetic reviewed SHAs, no model calls;
pagination and API/permission failures remain fixture-tested.

The recovery harness uses a fixture-specific adapter and skips the live actor
isolation probe. It does not validate the production installer or live actors.
No service was installed and no OS transition tests ran.

## Notifications verification (2026-10-30)

[PR #7](https://github.com/Bbuju055/ben-public/pull/7) merged opt-in notifications
for park, limit, stop and ready-for-review completion. They cannot authorize task
work. Stable IDs, a durable outbox and bounded retries support restart recovery;
sinks must deduplicate because exactly-once delivery is not promised.

| Evidence | Result |
| --- | --- |
| Fresh local checks | Typecheck, 11 notification tests (72 assertions), syntax and diff checks passed |
| Review receipt | All six changed files matched; 81 passing macOS runner/isolation tests |
| [PR Checks](https://github.com/Bbuju055/ben-public/actions/runs/41077574422) | Passed at `8f4f0d44274d3cf32f7dd66301a394712d16e7ea` |
| [Push-triggered main Checks](https://github.com/Bbuju055/ben-public/actions/runs/41079036576) | Passed at merge `326212eec24a23d34e45fda7dc6600e700bcc09b` |

Coverage: retry deadlines, deduplication, stale-gate reactivation without retry
resets, and damaged/missing runtime-pin preservation. Both hosted runs passed all
three jobs: core/typecheck/offline/CSV/adapter, browser, and macOS runner/isolation
including the offline recovery harness. No fixes or reruns were needed.

Tests used fake local sinks, scripted actors and disposable targets. No live
deliveries, service installation or OS recovery tests ran. Deferred scope is
listed above; historical live claims remain unchanged.

## CI observer verification (2026-10-30)

[PR #9](https://github.com/Bbuju055/ben-public/pull/9) merged the opt-in scheduler.
It observes the recorded reviewed SHA at most 20 times, at least one minute
apart, within 30 minutes. Each collection has a shared 15-second monotonic request
budget. Reservations survive restarts; terminal results stop polling and later
reruns need manual refresh. CI is informational: it cannot authorize actors,
approvals, budgets, publication, reruns, merging or notifications.

| Evidence | Result |
| --- | --- |
| Final local checks | 38 focused tests (391 assertions), typecheck, syntax and diff checks passed |
| Earlier core run | 461 tests passed **before** final review fixes; not final-head evidence |
| [Initial PR run](https://github.com/Bbuju055/ben-public/actions/runs/41106953501) | Failed on an existing repin-fixture PID race |
| [Final PR Checks](https://github.com/Bbuju055/ben-public/actions/runs/41108049419) | Passed at `b1c01fe4b519dd2afbd5923ba487c1c38d6e7ba0` |
| [Push-triggered main Checks](https://github.com/Bbuju055/ben-public/actions/runs/41110213049) | Passed at merge `3b27b6b42d78bb973c0c6499237fbbb55bea6d3d` |

Coverage uses injected clocks, fake GitHub GET responses, disposable repositories
and runner homes, and direct CLI calls. It checks bounded retries, concurrency,
stale heads, process timeout/cleanup and unchanged task authority. Review fixes
prevent wall-clock rollback extending the budget and future-dated cached success
hiding corrupt scheduled evidence.

The repin fixture now waits for the hanging worker's PID marker to match durable
state, avoiding transient preflight PIDs. Three consecutive local runs passed.
Final PR and main CI passed all three jobs: core/typecheck/offline/CSV/adapter,
browser, and macOS runner/isolation with the offline service recovery harness.
No post-merge fixes or reruns were needed.

Existing scripted one-shot service fixtures do not establish scheduler-specific
service integration. No live deliveries, service installation or OS recovery
tests ran. Deferred scope is listed above; historical live claims remain unchanged.

## Live acceptance and release decision

Applies to runtime `e60614ba888e1ce3d0651ddef540d6fe72ee02e1`.
The acceptance update changed documentation only.

| Claim | Result |
| --- | --- |
| A: live blocker reconciliation | PASS in two separate synthetic assignments |
| E1–E6: integrated runner acceptance | PASS in the first assignment, with qualifications below |
| C/CF-C1: natural/controlled beyond-soft-cap continuation | NOT EXERCISED; release owner accepted the gap on 2026-10-28 |

The first assignment exercised real CLIs/isolation, human approval,
implementation/review, manual interruption/recovery and one intended private PR;
56 local tests passed. It needed one plan-round grant, two extra stretches and a
publication-retry approval. Recovery used an intentional timing seam and manual
resume, not service/reboot recovery.

A separate assignment repaired two blockers and passed 16 tests; its next review
returned GO. Successful repair followed by GO does not satisfy C, which requires
qualifying blocker-bearing continuation beyond the soft cap without a grant.
The final CF-C1 attempt timed out at an external admission gate before its probe;
no fault was injected. The campaign is closed; no further live attempts are planned.

Raw evidence and failures are privately retained. These are separate assignments,
not one all-paths run. Neither target had hosted checks observed. The results do
not establish general autonomous reliability.
