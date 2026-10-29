# Isolated recovery harness

```sh
node examples/recovery/prepare.mjs /absolute/path/to/a-new-fixture-directory
```

Requires macOS, Node 24 and Git. Preparation creates a new directory exclusively;
failed attempts and historical evidence are preserved. Use a persistent directory
in a dedicated account on a spare Mac for eventual OS tests.

The harness captures committed HEAD and its tree, copies the harness sources,
and creates nine disposable repositories with local bare remotes. Credentials
are not inherited; actors and GitHub operations are scripted, and Git transport
permits only local files. Real sequencer transitions produce approval, budget,
backoff and approved-runnable baselines. A separate smoke fixture passes real
gates and publishes one fake PR. The actor isolation probe is explicitly skipped;
this does not establish actor isolation or live-model acceptance.

`adapter.mjs CONFIG MODE` replaces the entire child environment from sealed
fixture inputs. It checks account identity and input hashes, including task pins and their
executed runtime copies, before launching. SIGTERM/SIGINT is forwarded to the
supervised process group, with bounded escalation for an unresponsive child. Modes are `inspect`, `status`, `run-once`, `serve-once`,
and `serve`. Unsupported modes, altered inputs and missing inputs fail closed.
Each fixture contains `adapter.json`, `environment.json` and a linted
`service-preview.plist` with a unique label and absolute paths. The adapter
needs no inherited fixture variables. This is a fixture-specific service entry
point, not a change to or validation of the production service installer.

## Offline checkpoint verification

Preparation also runs `verify-checkpoints.mjs` on the newly created fixtures:

- Active implementation: a bounded scripted actor writes its PID marker and
  waits. A competing start cannot launch another actor. Killing only the runner
  leaves the actor alive; recovery must reap it and charge the incomplete launch
  at its cap, without changing limits or duplicating approval or publication.
- Before push and after push: interrupt at the production pause seam. Recovery
  must park for human retry, and another service pass must preserve that park.
  An explicit scripted operator answer then authorizes completion.
- After PR creation: interrupt before local recording. Recovery must discover
  the existing fake PR and record it without a duplicate.

`checkpoint.armed` enables the configured checkpoint for the adapter's next
launch. Active entry is recorded in `active-entered.json`; publication uses
`.ben/.runner-paused-publish_*`. The active actor fails after 60 seconds; the production publication pause
automatically continues after 60 seconds. A stale marker is not proof that a
process is still paused. The verifier
moves the arm file into `checkpoint-evidence/` before recovery, preserves stale
locks and markers, and captures state, accounting and process IDs before and
after. It never deletes authoritative locks to manufacture recovery. Completed
drills are consumed evidence: create a fresh root for another run. The verifier
refuses both completed roots and roots with a previous verification start.

`checkpoint-verification.json` records assertions; `manifest.json` is written
only after every check passes and hashes the resulting evidence. Missing final
manifest means failure. The Node binary path must remain available.

Run adapter regressions with `node --test examples/recovery/adapter.test.mjs`.
The preparation command runs the full offline checkpoint verification.

## Stop before installation

No script installs, loads or unloads a service or performs sleep, logout or
reboot. Preview plists remain inside the fixture directory. The production
installer does not preserve these fixture overrides and must not be used here.

Before separately authorized installation, review the adapter and preview for
an isolated account/machine, then verify a logged-in service smoke run. For OS
checks use fresh fixtures, arm the intended checkpoint immediately before the
transition, and retain launchd logs and OS event timestamps alongside before/after
state. Nothing should run while logged out; assess recovery after login.
Actual launchd delivery, sleep/wake, logout/login and reboot remain unverified.
