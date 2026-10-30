# Quickstart

Claude builds. Codex reviews. You approve the plan and review the result.
Ben never merges or deploys.

## Requirements

| Workflow | Requirements |
| --- | --- |
| All workflows (including the offline demo) | Git, Node.js 24 |
| Live features additionally require | macOS, Claude Code, Codex CLI, your own authenticated Claude and Codex access |
| PR publication additionally requires | GitHub CLI, GitHub `origin`, branch push and PR permissions |

Live work may incur charges. Ben provides no model access or usage credits.
Bun is only required for developing ben.

## Install

Already cloned? Enter that checkout and skip the first two lines.

```bash
git clone https://github.com/Bbuju055/ben-public.git
cd ben-public
export BEN="$(pwd -P)"
mkdir -p "$HOME/.claude/skills"
if [ ! -e "$HOME/.claude/skills/ben" ] && [ ! -L "$HOME/.claude/skills/ben" ]; then
  ln -s "$BEN" "$HOME/.claude/skills/ben"
else
  ls -ld "$HOME/.claude/skills/ben"
fi
```

An existing skill entry is preserved. Confirm it points to `$BEN`.

<details>
<summary>Replace an existing symlink</summary>

Run only when intentionally switching checkouts. Real directories are preserved.

```bash
test -L "$HOME/.claude/skills/ben" &&
  unlink "$HOME/.claude/skills/ben" &&
  ln -s "$BEN" "$HOME/.claude/skills/ben"
readlink "$HOME/.claude/skills/ben"
```

Existing runner tasks retain their pinned runtime.

</details>

## Offline demo — no AI calls

From the checkout:

```bash
node examples/offline/run.mjs
```

Expected: two failed implementations, then a passing repair and an evidence path.
Scripted agents only—no credentials, dependencies, model calls or publication.
This demonstrates the workflow; it cannot build a new feature.

## Build a feature

Check authentication in your terminal:

```bash
claude auth status
codex login status
gh auth status  # required for publication
```

If needed: `claude auth login`, `codex login`, `gh auth login`.
Status checks make no model calls.

Use a target repository with a clean working tree, an initial commit, configured
Git identity and installed project dependencies. Open a new Claude session there:

> Build this through ben: [change]. Acceptance criteria: [checks].
> Present the plan for approval. Stop before pushing or opening a PR.

Approve the plan, answer decision gates, then review the diff and evidence.
Preserve `.ben/` for recovery. Use the skill; `bun run ben` is retired.

Start supervised. Leave live notifications, installed-service tests and OS
recovery tests deferred; [unattended reliability remains unverified](VERIFICATION.md).

## Reference

- [Runner](references/runner.md): automation, status, budgets and publication.
  `assign` includes paid-capable probes and authorizes publication. Closing the
  terminal does not stop a detached runner.
- [Recovery](references/recovery.md): crashes and engineering stops.
- [Limitations](FINDINGS.md): checks can miss defects; estimates are not spending ceilings.
