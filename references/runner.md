# Runner reference

Operator/coordinator reference. Commands here require the corresponding real
human decision or existing authorization; they are never instructions for a
headless work stretch. The sequencer determines which operation is legal.

## The runner — ben owns an assignment to READY FOR REVIEW

`scripts/runner.mjs` (alias `ben`) is the unattended operator surface. The runner never
makes human decisions. It submits explicit operator answers to the sequencer for
validation and recording. For automatic continuation, it runs `run.mjs next --json`,
reads the sequencer-owned result (`.ben/last-next.json`: `instruction | reenter |
park | publish | terminal | stop | contention | usage-error`), and does exactly
one mechanical thing per outcome — launch a bounded driver stretch, publish from
a runner-owned mirror, record an observation act (`--by ben-runner`), or stop.
It owns GitHub publication (scoped `ben/*` push + PR create/edit; no merge or
deploy). Model CLIs also contact their providers. See [design](../DESIGN.md).
The runner is built and locally tested on macOS with `/usr/bin/sandbox-exec`.
Full live acceptance remains open; see [roadmap](../ROADMAP.md).
`assign` authorizes the publication workflow and launches paid-capable model calls;
use it only with publication and spending authorization. Define the alias first:

```bash
export BEN="$(pwd)"  # run from the ben checkout
alias ben='node "$BEN/scripts/runner.mjs"'
```

The target needs a clean Git working tree, an initial commit, a GitHub `origin`,
a configured Git identity, authenticated `claude`/`codex`/`gh`, and installed
project dependencies. The runner's default base branch is `main`.

```
ben assign  --repo <path> "<outcome>"            # branch ben/<slug> from origin/<base>, .ben ignored, init, brief, probe, run
ben status  --repo <path> [--detail|--json] [--refresh-ci]
ben resume  --repo <path> --gate <id> --choose <token> [--reply "<text>" | --reply-file f] [--note] [--usd N|--hours N|--stretches N] [--criterion C] [--residual "<gap>"]
ben follow-up --repo <path> --pr N "<note>"        # new task on the same branch; previous task kept under .ben/history/<n>-<slug>/; the SAME PR is updated
ben service install|uninstall|status              # LaunchAgent (logged-in sessions only): re-resumes a non-parked task after a runner crash, and after login following logout/reboot
ben repair  --repo <path>                          # names the playbook step for an engineering session (recovery cases)
```

`status --refresh-ci` reads GitHub check runs and latest commit statuses for the
recorded PR's reviewed SHA, checking the PR head before and after collection.
It appends a dated observation to `.ben/runner/ci-observations.jsonl`; ordinary
status reads that cache offline (`--detail` includes check links, `--json` the
full observation). A changed reviewed/local/observed PR head invalidates the
snapshot. A cached result cannot detect later remote changes; refresh to check.

CI is informational: `passed` means all observed checks and status contexts
succeeded, not that required checks or branch protection are satisfied. The
versioned policy keeps the newest run ID per app/suite/name and keeps distinct
suites separate. States are pending/passed/failed/cancelled/unknown; skipped,
neutral, missing, unreadable or incomplete evidence is unknown. Reads stop at
20 pages per API; failures never reuse an older green observation. This does
not change delivery gates, PR bodies or merge behavior.

Follow-up reads at most 50 pages of 50 review threads and the first 50 comments
per thread. The runner updates the existing PR; the [interactive publication instructions](publication.md) describe a different publication path.

Every parked question carries a **gate id** minted by the sequencer
(`task.gate`); `.ben/WAITING.md` prints the exact `ben resume … --gate <id>
--choose <token>` lines. A noninteractive answer without `--gate` is refused; a
superseded id is refused with zero writes and the current question shown.
Tokens: approval `approve | revise --reply | abort`; veto `accept | veto-N |
abort`; review-stop `continue [--rounds N] | abort`; fix-cap `continue | abort`
(gates/criteria/scope, the commits check and the plan-round budget; a commits
grant permits one extra attempt without resetting the referee tally; the honesty
threshold remains a referee constant — abort or an engineering session);
manual-adjudication `satisfied --reply | accepted --reply --residual | abort`
(`--criterion` when several are pending); clarify `reply --reply`;
supervisor-stop `continue [--note] | abort`; limit `continue --usd N|--hours
N|--stretches N | abort`; pr-retry / pr-head-mismatch `retry | abort`;
pr-branch-conflict `reinspect` (an observation, never a decision) `| abort`.

**The driver boundary.** A stretch is `claude -p --setting-sources ""
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

**Headless driver protocol** (appended to the driver's system prompt): perform
exactly the one instruction; never run `next`/`record-*`/`answer`; never push or
call `gh`; write only the named artifacts; ask the human nothing — write
`.ben/questions.json` (`[{id, question}]`) in the plan stretch for a consequential
ambiguity and the runner parks it; request an `install` or `research` stretch by
writing `.ben/stretch-request.json` (`{"mode":"install","packages":[…]}` — only
after approval and only for packages the approved `plan.md` lists under `##
Dependencies`; `{"mode":"research","reason":…}` — only with domains granted at
assign); end the turn with a short report. The current instruction always wins
over resumed context.

**Process lifetime.** `assign`/`resume` detach the runner from the terminal;
logs live under `.ben/runner/`. After a crash, durable state supports a plain
`resume`. The optional LaunchAgent resumes non-parked tasks after login; nothing
runs while logged out. Service recovery was observed for a killed runner while
logged in, not a physical reboot. Without the service, resume manually. Human
parks always require an answer. The service checks every 20 seconds and supervises
up to two tasks concurrently; queued tasks wait for a slot. Tasks waiting for a
network or provider retry release their service slot until the saved retry time.

Before leaving a task unattended, run `ben readiness --repo <path>` to inspect
local service, task, gate, probe and budget state. This does not contact providers
or prove current authentication. Approve the exact plan and resolve pending human
criteria before leaving. `assign`, `resume` and `follow-up` accept `--keep-awake`
to inhibit idle sleep while the runner is active; `--allow-sleep` clears that
choice. This does not prevent logout, shutdown, forced sleep or laptop lid sleep.
Without the service a crashed runner needs manual resume. Notifications and
automatic assignment of new tasks are not implemented.

The optional interactive Stop hook is retained. Headless stretches use isolated
settings without that hook: the runner returns to the sequencer after each
stretch and owns continuation. Transient read-only inspections and live lock
contention can retry; publication retry gates, approval, isolation failures and
ambiguous authoritative state remain protected.

**Limits (accounted, not a hard cap):** $25 / 8 active hours / 40 stretches by
default; every model launch is reserved in `.ben/runner/stretches.jsonl` before
it spawns; a launch without a completion is charged at its cap; reviewer calls
are counted at a process boundary and estimated at $0.50 each. Three unchanged
stretches trigger two bounded recovery attempts with fresh context. If neither
makes progress, ben parks a supervisor stop; a human continue permits one more
attempt. Infrastructure failures have a separate maximum of six automatic retries
with persisted backoff (up to 15 minutes per delay); their launches still count
against the same budgets. Authentication failures require renewal. Reaching a per-stretch turn or dollar
cap ends that stretch; the sequencer re-derives the next step under the unchanged
task budget. Interactive use stays
supported: `run.mjs next` refuses while a runner is alive (`.ben/runner.lock`).
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
