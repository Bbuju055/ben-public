# Runner reference

For operators. Commands require the relevant human decision or existing
authorization; they are not headless work instructions. The sequencer controls
which operation is legal.

## Setup and authorization

Start with the [quickstart](../GETTING_STARTED.md). The runner requires macOS,
`/usr/bin/sandbox-exec`, compatible authenticated `claude`/`codex`/`gh` CLIs, and
a target with a clean Git tree, an initial commit, GitHub `origin`, Git identity
and installed project dependencies. The default base branch is `main`.

**`assign` authorizes branch push and PR creation and launches paid-capable model
calls, including preflight and isolation probes.** It is not a free setup check.
Ben never merges, deploys or makes human decisions.

Define the alias from the ben checkout:

```bash
export BEN="$(pwd)"  # run from the ben checkout
alias ben='node "$BEN/scripts/runner.mjs"'
```

## Commands

Replace `<path>` and other placeholders with actual values. Quote paths and text.

| Command | Purpose |
| --- | --- |
| `ben assign --repo <path> "<outcome>"` | Create `ben/<slug>` from `origin/<base>`, ignore `.ben/`, initialize, probe and run |
| `ben status --repo <path> --detail` | Inspect cached local state |
| `ben status --repo <path> --json` | Inspect state as JSON |
| `ben status --repo <path> --refresh-ci` | Fetch CI evidence for the reviewed SHA |
| `ben readiness --repo <path>` | Inspect local service, task, gate, probe and budget state |
| `ben ci-observe --repo <path>` | Perform one due opt-in CI observation |
| `ben resume --repo <path> --gate <id> --choose <token>` | Submit the gate's exact answer; may resume paid work |
| `ben follow-up --repo <path> --pr N "<note>"` | Start a new task on the same branch and PR; archive the prior task under `.ben/history/` |
| `ben repair --repo <path>` | Identify the engineering recovery step |
| `ben service status` | Inspect the optional logged-in-session LaunchAgent |

Use the exact resume command from `.ben/WAITING.md`, including its reply, note,
criterion, residual or budget flags. Service installation/uninstallation is
explicit (`ben service install` / `ben service uninstall`); installed-service and
OS recovery tests remain deferred.

## CI evidence

`status --refresh-ci` reads GitHub check runs and latest commit statuses for the
recorded PR's reviewed SHA, checking the PR head before and after collection.
It appends a dated observation to `.ben/runner/ci-observations.jsonl`; ordinary
status reads that cache offline (`--detail` includes check links, `--json` the
full observation). A changed reviewed/local/observed PR head invalidates the
snapshot. A cached result cannot detect later remote changes; refresh to check.

### Optional bounded CI observation

Automatic CI observation defaults off. Enable it only in the operator-owned
runner home (`~/.ben-runner/ci-observer.json`, or `BEN_RUNNER_HOME`):

```json
{"enabled":true}
```

`ci-observe --repo <path>` performs at most one due observation of the recorded
PR's reviewed SHA. The supervisor also calls it for completed tasks when there
is no active worker. It never starts an actor, changes task approvals or budgets,
publishes, merges, reruns checks or sends notifications. Existing runtime pins
are not automatically upgraded.

| Bound | Policy |
| --- | --- |
| Identity | Repository / PR / reviewed SHA |
| Attempts | Maximum 20, at least one minute apart, within 30 minutes of the first attempt |
| Collection timeout | Shared 15-second monotonic budget across all pages and both head checks |
| Terminal result | Passed, failed or cancelled stops polling; later reruns need `status --refresh-ci` |
| Pending/unknown | Retry within the same bounds |
| Reset | Disabling/re-enabling or returning to an old SHA never resets attempts or deadlines |

Failed/interrupted attempts count. Reservations and observations live atomically
under the runner home's `ci-observer/`, outside task authority. Each request is
reserved as unknown before collection. Dead-owner locks can be reclaimed;
ambiguous locks and corrupt state are preserved for operator inspection.

Status reads the newer manual/scheduled snapshot offline. Corrupt scheduled
state forces unknown regardless of timestamps. Local/task changes during
collection invalidate evidence; cached results cannot detect later remote edits.
Exhaustion changes neither task state nor CI to passing.

### Result interpretation

CI is informational. `passed` means all observed checks/statuses succeeded, not
that branch protection or required checks are satisfied. The policy selects the
newest run ID per app/suite/name and preserves distinct suites.

States: pending, passed, failed, cancelled, unknown. Skipped, neutral, missing,
unreadable or incomplete evidence is unknown. Each API is limited to 20 pages;
failures never reuse old green evidence. Delivery gates, PR bodies and merge
behavior are unchanged.

Coverage uses fake responses, clocks, disposable homes and direct CLI calls.
Live scheduler polling, scheduler-specific service integration, installed-service
behavior and OS recovery remain deferred; see [verification](../VERIFICATION.md).

Follow-up reads at most 50 pages of 50 review threads and the first 50 comments per thread.
It updates the existing PR; [interactive publication](publication.md) is a
separate path.

## Human gates

Use the exact command in `.ben/WAITING.md`. Gates carry a sequencer-minted
`task.gate` ID. Noninteractive answers require `--gate`; superseded IDs are
rejected without writes and the current question is shown.

| Gate | Choices |
| --- | --- |
| Approval | `approve`, `revise --reply`, `abort` |
| Veto | `accept`, `veto-N`, `abort` |
| Review stop | `continue [--rounds N]`, `abort` |
| Fix cap | `continue`, `abort` |
| Manual adjudication | `satisfied --reply`, `accepted --reply --residual`, `abort`; add `--criterion` when several are pending |
| Clarify | `reply --reply` |
| Supervisor stop | `continue [--note]`, `abort` |
| Limit | `continue` with `--usd N`, `--hours N` or `--stretches N`; or `abort` |
| PR retry / head mismatch | `retry`, `abort` |
| PR branch conflict | `reinspect` (observation only), `abort` |

Fix caps cover gates/criteria/scope, commit checks and plan-round budgets.
A commit grant allows one extra attempt without resetting the referee tally.
The honesty threshold remains a referee constant: abort or request engineering
recovery rather than increasing it.

## Isolation and runtime pins

The runner calls `run.mjs next --json` and follows `.ben/last-next.json`:
`instruction | reenter | park | publish | terminal | stop | contention | usage-error`.
It launches a bounded driver, publishes from its mirror, records supervisor
observations as `ben-runner`, or stops. See [design](../DESIGN.md).

A stretch is `claude -p --setting-sources ""
--strict-mcp-config --tools Read,Edit,Write,Grep,Glob,Bash --permission-mode
acceptEdits --settings <runner-written file>` in a filtered environment. The
runner generates settings that disable repository/user settings and restrict
writes to the task tree, excluding authoritative `.ben` records, `.claude`,
`.git/{config,hooks,info}`, the pinned runtime and runner state. It denies reads
of specified credential paths. Work-mode network access uses task-granted
domains; approved install and research modes have their own allowances.
The startup probe requires tool/process evidence of the boundary. Scripted
settings tests alone do not prove a live CLI honors it; compatibility must be
checked in the execution environment.
Trusted processes run from the **pinned runtime**
(`~/.ben-runner/runtime/<sha>/`), never from the target checkout. An existing pin
that is invalid or points to an unavailable runtime stops task-bound commands;
the runner does not silently replace it. Preserve the pin and restore its runtime,
or explicitly select the current ben installation with:

```bash
ben resume --repo <path> --repin
```

Repinning is an operator action: it changes the task's runtime to the installation
selected by `$BEN` and may resume work, including model calls. Use it only with
that authorization. It refuses while a runner or an orphaned driver still owns
the task; resolve that ownership before retrying. It does not automatically answer a human gate.

Gate and criterion commands run under a per-command `sandbox-exec` profile through
`verify.mjs --command-wrapper`: `.ben/**` is unwritable except the command's
own `BEN_SCRATCH_DIR` (`.ben/evidence/scratch/<label>/`), whose regular files the
referee alone promotes into `.ben/evidence/artifacts/<label>/`.

### Headless driver protocol

The driver must:

- Perform only the current instruction and write only its named artifacts.
- Never call `next`, `record-*`, `answer`, `gh`, or push.
- Do not ask the human directly. Write planning ambiguities to
  `.ben/questions.json` (`[{id, question}]`); the runner parks for the human.
- Request installs through `.ben/stretch-request.json` with
  `{"mode":"install","packages":[…]}`, only after approval and only for packages
  listed under `## Dependencies` in the approved plan.
- Request research through `.ben/stretch-request.json` with
  `{"mode":"research","reason":…}`, only for domains granted at assignment.
- End with a short report. The current instruction overrides resumed context.

## Process lifetime and recovery

`assign`/`resume` detach by default; logs live in `.ben/runner/`. Closing the
terminal does not stop work. There is no general `ben stop` command. At a human
gate, leave the task parked or use its offered abort choice.

Without the optional service, a crashed runner needs manual resume. For an
engineering STOP, preserve evidence and consult [recovery](recovery.md).
Resume can start paid work.

| Service behavior | Boundary |
| --- | --- |
| Check every 20 seconds; supervise up to two tasks | Other tasks queue; network/provider retry waits release their slot |
| Resume non-parked tasks after login | Nothing runs while logged out; human gates always require an answer |
| `--keep-awake` on assign/resume/follow-up | Inhibits idle sleep only; `--allow-sleep` clears it |
| Logout, shutdown, forced sleep, lid sleep | Not prevented by idle-sleep inhibition |

`readiness` inspects local service/task/gate/probe/budget state. It does not contact
providers or prove current authentication or a current probe binding. Inspection
may populate `~/.ben-runner/runtime/`; the cache must be writable. Approve the
exact plan and resolve human criteria before leaving work unattended.

Offline fixtures cover simulated failures, not installed-service or OS lifecycle
recovery. Those tests remain deferred. [Notifications](#optional-notifications)
are implemented and default off; automatic assignment of new tasks is not.

Headless stretches use isolated settings without the optional interactive Stop
hook. The runner returns to the sequencer after each stretch. Transient read-only
inspections and live lock contention can retry; publication retries, approval,
isolation failures and ambiguous authoritative state remain protected.

## Budgets and retries

Defaults: **$25 / 8 active hours / 40 stretches**. Accounting limits are not
guaranteed billing ceilings.

| Accounting/recovery | Rule |
| --- | --- |
| Model launches | Reserve in `.ben/runner/stretches.jsonl` before spawning; missing completion is charged at its cap |
| Reviewer calls | Count at the process boundary; estimate $0.50 each |
| Three unchanged stretches | Two bounded fresh-context recovery attempts, then park; human continue grants one more attempt |
| Infrastructure failures | At most six automatic retries with persisted backoff, up to 15 minutes per delay; launches count against task budgets |
| Authentication failure | Requires renewal |
| Per-stretch turn/dollar cap | End the stretch; re-derive the next step under unchanged task budgets |

Interactive `run.mjs next` refuses while the runner owns `.ben/runner.lock`.

## Hard enforcement (Claude, optional)

`scripts/stop-hook.mjs` structurally blocks ending the turn while `$S` has open
blockers, a failing or unreadable criteria matrix, an approval with no matrix,
or current model-owned follow-up. Current human/playbook parks and an ABANDON
record release it. After six unchanged blocks, the next stop releases with a
warning. This optional hook is separate from the sequencer approval gate. It changes harness behavior,
so never install it silently; offer it once:

```
node "$BEN/scripts/install-hooks.mjs"        # --uninstall to remove
```

Everything else works without it.

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.

## Optional notifications

Notifications are off by default. Configure an operator-owned sink in
`~/.ben-runner/notifications.json` (or the test runner home), never in a target
repository:

```json
{"enabled":true,"argv":["/absolute/path/to/notification-sink"]}
```

The sink receives one JSON event on stdin and acknowledges with exit zero.
Events are `park`, `stop`, `limit`, or `complete` (ready for review, not merged).
Payloads contain a stable `id`, repository path, assignment identity and reason;
completion includes the PR URL and reviewed SHA. Prompts, titles, gate packets
and provider output are omitted. The sink runs without a shell or inherited
credentials and has a two-second deadline; remaining sink process-group members
are killed. Sinks must not daemonize.
Channel-specific credentials/configuration belong to the operator's sink.

Runner exits observe durable state. `serve` also observes parked/completed tasks
and retries notifications without restarting their actors. Without a service,
`runner.mjs notify --repo /path/to/repo` explicitly observes/retries; `status`
and `readiness` remain read-only. Existing task/service pins are not upgraded
automatically. Enabling notifications observes the current state, not all
historical transitions. Model-owned work and transient backoff
are silent. Changed/answered gates supersede pending alerts. If the same gate
becomes current again, its retry count and deadline are preserved.

Delivery receipts and pending attempts live under the runner home's
`notifications/`, outside task authority. Attempts reserve their deadline before
sending: five attempts maximum, with one-, two-, four- and eight-minute retry
waits. Restarts preserve deadlines; exhausted/corrupt outboxes require operator
inspection and never change task budgets, approvals or publication. Ambiguous
lock ownership (including an interrupted reclamation guard) fails closed.
A crash after delivery but before acknowledgement can replay the same event ID;
sinks must deduplicate IDs. Exactly-once delivery is not promised.

Coverage uses local fake sinks and disposable targets only. Live channel
providers, installed-service notification delivery and OS recovery are unverified.
