# Free prerequisite checker

Run from the ben checkout:

```bash
node scripts/doctor.mjs [--repo <path>] [--online] [--json]
```

The standalone Node-builtins checker performs no model inference. It is separate
from runner startup preflight, whose paid-capable probes remain unchanged.
It does not require task state or Bun (Bun is a development dependency).

By default it checks macOS, sandbox-exec presence, Node 24, Git/Claude/Codex/gh
versions, the `~/.claude/skills/ben` symlink selecting this checkout, required
runtime files, and non-inference Claude/Codex login status. Required guidance must
be a regular, non-symlink file with nonblank content, at most 1 MiB per file.
CLI versions are
reported as observed numeric versions, without asserting a compatibility range.
Unrecognized or unreadable login responses are unknown, not an asserted logout.
No GitHub network probe runs by default.

`--repo` selects a Git working-tree root and checks an initial commit, clean
tracked/untracked state, configured Git identity,
and a credential-free github.com HTTPS or SSH origin. Project dependencies and
acceptance-check adequacy remain unverified. Target scripts are not run and
dependencies are not installed. Repositories with clean/process filters,
submodules, or assume-unchanged/skip-worktree index flags receive unknown
cleanliness: Git status can execute filters or hide tracked changes. Partial-clone
configuration causes commit and cleanliness checks to remain unknown; Git lazy
fetching is disabled as well. The checker never fetches missing objects, even with
`--online`. Explicit global/system Git config file overrides are respected;
environment overrides selecting another repository/index are removed.
GitHub Enterprise origins are not supported.

`--online` explicitly enables non-interactive GitHub API GET requests: authenticated
user, and, when a repository is selected, repository reachability, default-branch
ref pointing to a commit and API-reported push permission. This does not test Git transport, branch
rules, PR creation or successful publication. Without `--repo`, online scope
checks only GitHub authentication. Network/authentication errors remain unknown.
All online tests in the test suite use stubs, never real providers.

Each subprocess has closed stdin, a four-second deadline, a combined 64 KiB
output cap, prompt suppression and process-group cleanup on macOS/Linux, including
when doctor receives SIGINT/SIGTERM or exits normally. Uncatchable termination
such as SIGKILL of doctor can leave detached children behind. There
are at most 17 subprocesses (68 seconds of subprocess deadlines), without retries.
Raw command output, credential/config contents, identity values and origin URLs
are withheld. Only recognized version numbers and fixed diagnostic messages are
reported. Slow or changed CLIs may therefore produce unknown results.

Results are point-in-time observations; keep the checkout and its configuration
quiescent during inspection. The checker does not lock out concurrent writers.
The checker does not write repo/task/runner state, runtime pins, links or services,
or modify Git. External CLIs may maintain their own caches. It invokes trusted
executables from PATH; it is not a sandbox for malicious CLI replacements.

Results use stable check IDs and `pass`, `fail`, `unknown`, or `skipped`, with a
`required` flag and concise remedies. JSON has `schemaVersion: 1`, `scope`,
`checks`, `limitations` and `exitCode`. Usage/inspection errors instead have an
`error` and `detail`. Exit codes:

- **0:** every required check in the selected scope passed.
- **1:** a required check failed, is unknown, or was skipped due to a missing
  prerequisite; also unexpected inspection errors.
- **2:** invalid arguments (including duplicate options).

During a subprocess check, SIGINT/SIGTERM clean up children and exit 130/143.

Optional unselected checks are skipped and do not block exit 0. Live limitations
are disclosed even on success: model availability, billing, CLI isolation,
publication, deliveries, installed services, OS recovery and newcomer end-to-end
success remain untested. Runtime file presence is not integrity verification;
existing task runtime pins are not checked. A green result does not establish
safe unattended operation.

Offline regression checks: `bun test tests/doctor.test.ts` (also included in
`bun run test:core`). Fixtures exercise status parsing, missing prerequisites,
Git state, link conflicts, subprocess bounds, redaction and read-only behavior.
