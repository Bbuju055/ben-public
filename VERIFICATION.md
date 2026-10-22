# Local verification

## Full offline results

The full offline suite passed on 2026-10-22: **483 tests, 0 failures and
4,207 assertions across 21 files**. The run took about 13.4 minutes. TypeScript checking, the
separate CSV tests and the offline walkthrough also passed.

| Command | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| `bun run test` | 483 passed, 0 failed; 4,207 assertions across 21 files |
| `node --test examples/csv-export/export-csv.test.mjs` | 17 passed, 0 failed |
| `node examples/offline/run.mjs` | Passed; deliberate failures, a simulated grant and successful repair |

Checks ran on macOS 26.1 (arm64), Node.js 24.10.0 and Bun 1.3.14, from isolated
source copies with separate home, task, temporary and Git configuration state.
Existing local dependencies and Chromium were reused; this was not a fresh
lockfile installation. Model and GitHub actors were scripted. Git initialization,
commits and local pushes occurred only in disposable test fixtures. No live
model calls or external repository writes occurred.

The full suite ran outside the execution sandbox to allow local listeners and
nested macOS sandbox profiles. The typecheck, CSV tests and walkthrough passed
inside the execution sandbox on the same source bytes. “Offline” here excludes live models and external
repository writes; the network-isolation test retains its `example.com` canary.

The full run includes 15 regression tests, browser and macOS sandbox
checks, approval and Stop-hook enforcement, and runner recovery. Regression
coverage includes failed reviewer output and restart replay, broken runtime
pins and explicit repinning, stale manual checks and fresh human answers.

Recovery coverage includes lost sessions, bounded provider retries,
fresh-context recovery, concurrent service tasks, persisted backoff, offline
publication deferral and task limits. Guidance checks cover sequencer-selected
references, delivery to headless work, missing or invalid references, runtime
pinning and preservation of existing pins.

Executable code, tests and configuration match the tested source. The current
workflow guidance has not been validated in a live model session.

## Test requirements

The full suite requires macOS with `/usr/bin/sandbox-exec` and permission to
launch local processes, open listeners and run nested sandbox profiles. Browser
tests expect Chromium in `.playwright-browsers/`; install it with
`PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" ./node_modules/.bin/playwright install chromium`.
The sandbox network canary contacts `example.com`.

Tests use temporary repositories and task state, with no paid model calls or
GitHub writes. Recovery tests can deliberately pause for a minute. CI partitions
the suite into `test:core`, `test:browser` and `test:sandbox`.

## Evidence limits

The tests use scripted model actors and local Git/PR fixtures. They exercise
approval binding, stale-answer refusal, recovery, publication consistency and
isolation; they do not establish live model compliance or hosted CI success.

[Live blocker reconciliation, review continuation beyond the soft cap and full
live runner acceptance remain open](ROADMAP.md#live-verification-open).
The [CSV provenance](examples/csv-export/PROVENANCE.md) describes a separate
historical interactive example. These checks neither replay its model calls
nor close the live acceptance gaps.
