# Decisions reference

Operator/coordinator reference. Commands here require the corresponding real
human decision or existing authorization; they are never instructions for a
headless work stretch. The sequencer determines which operation is legal.

**Human approval — always, not opt-in.** On unanimous GO, `next` presents the
complete packet verbatim — plan, criteria, promises, rendered ledger, manual criteria —
and stops. The options are exactly APPROVE BUILD / RECONCILE / ABORT:

```
node "$BEN/scripts/run.mjs" record-approval --by <user> --decision APPROVE
```

The approval binds the SHA-256 of all five plan artifacts and verdict-relevant
configuration, computed by the sequencer. Any later edit to those inputs voids approval and
re-presents the gate. No approval record, no implementation — structurally.
(Recorded adjudication and publication audit rows in the ledger are
approval-neutral: they never block re-recording an identical approval; any
raised/resolved/granted change still does.)

**Manual-criterion adjudication — a mandatory gate, before the chain and the
diff review.** Every `method:"manual"` criterion needs a recorded human
adjudication before `next` will run scope/gates/criteria or invoke the diff
reviewer — the diff reviewer never sees a pending manual criterion, so the
"operator decision remains outstanding" treadmill is structurally unreachable.
The gate prints each pending criterion verbatim and the exact command:

```
node "$BEN/scripts/run.mjs" record-adjudication --criterion C7 --response r.json --by <user>            # dry run
node "$BEN/scripts/run.mjs" record-adjudication --criterion C7 --response r.json --by <user> --confirm  # record
```

The response is structured: `{"decision":"satisfied"|"accepted","ruling":"<the
operator's words>","residual":"<required for accepted>","basis":{"kind":"plan|diff",
"round":N,"fingerprint":"…","action":"…"}}` (basis optional; REQUIRED on a
terminal task, and it must name exactly one existing ledger entry — that entry
is embedded verbatim in the record and shown at the dry run). `satisfied` means
the human performed the check: it needs a clean worktree and binds the checked
HEAD — a later commit makes it stale and the criterion pends again (a
still-governing `accepted` under the same approval then takes over
automatically, and the fresh review sees its ruling). `accepted` is a
HEAD-independent policy acceptance of an evidence gap: its residual is
published on the PR, never hidden. `deferred` does not exist — deferring is
NOT adjudicating; absence of a record is the only other state and it
fail-closes everywhere. Every act is dual-written (the `adjudications.json`
act register + a ledger audit entry embedding the complete record); replaying
the identical act is a no-op; a contradicting act for the same binding is
refused. Recording an adjudication after a diff GO flips the governing digest:
the earned review is stale and `next` routes the task back through
verification and a fresh diff review before anything terminal — a pending PR
intent in that state routes through the `record-pr-remote` migration exactly
like a voided approval.
**Escalation.** Every referee exit 2 stops at the human with the failing output
verbatim. The options are: grant more rounds (below) / recovery of a proven partial
write per the playbook / ABORT. Recovery cannot bypass a review decision. A review-policy
stop (stall / hard cap / ambiguous records) is durable — its `rounds.gates` slot
re-presents it after any crash, and recording a grant is what clears it for that
kind. Budget extensions are recorded operations, never hand-edits:

```
node "$BEN/scripts/run.mjs" record-grant --kind plan --rounds 2 --by <user>
```

This example grants two plan-review rounds. Use `--kind diff` for diff review
and replace `2` with the number of rounds the human authorized.

ABORT is `$S/ABANDON.md` with the reason on line one — the honest exit; it is
surfaced, never silent, and it is terminal until a human deletes it.
## Unattended stretches — park, answer, resume

ben works while the human is away; no human gate is ever auto-passed. The loop
is unchanged — `next` → do exactly what it says → `next` — with these standing
rules for the stretch between human gates:

- **Ask the human NOTHING that is not a parked gate.** Between gates, every
  instruction `next` prints is yours to perform. A question to the human that
  no gate asked is a method violation.

- **Exit 2 is not automatically the human's.** Read `run.mjs status`: the
  waiting note is owner-classified. `ben HAS FOLLOW-UP WORK PARKED` (a PR
  inspection, an observed-PR record step) is YOUR work — do it in this session
  and continue. Only `WAITING ON YOU` (or a playbook STOP) ends the stretch.

- **Park legibly, then end the turn.** At a human-owned stop, `next` has
  already published `.ben/waiting.json` + `.ben/WAITING.md` — the durable
  operator brief (what stopped / why it needs the human / the legal answers as
  exact commands / the verbatim packet). Verify it exists (`run.mjs status`
  shows it; if it is missing, re-run `next` — republishing is `next`'s job),
  report ONE line — "parked: <question> — .ben/WAITING.md; safe to leave" —
  and end the turn. The session ending is the designed exit, not a failure;
  the Stop hook releases on a current human-owned park.

- **The projection is never authority.** Never write or edit waiting.json /
  WAITING.md by hand; never read them as truth. The gate itself is durable
  state — a missing or stale note is repaired by re-running `next`, and a
  stale note can never be acted on (`answer` refuses it).

- **The human answers with `run.mjs answer`.** Tokens are listed in
  WAITING.md: e.g. `answer --choose approve --by <user>`, `--choose veto-2`,
  `--choose continue --rounds 2`, `--choose abort --note "<why>"`. The answer
  is validated against live state (stale/wrong/ambiguous fails closed, applied
  exactly once) and lands through the same record operations as ever. On
  success it prints the exact resume line.

- **Resume needs no memory.** After an answer — hours or days later — a bare
  `run.mjs next` or a fresh ben session continues from durable state exactly
  once: answered gates are not re-presented, completed work is not redone.

This is pull-based operation. Notifications and remote answers are future work
([roadmap](../ROADMAP.md)); no remote control surface is implemented.

- **Declared gaps only.** Deferring work is fine when the human hears it by name;
  a silent gap is a defect.

- **Deferred is never adjudicated.** A manual criterion is `satisfied` (the
  human checked it), `accepted` (the human accepted the gap, residual
  published), or PENDING — there is no recorded "later". Absence fail-closes.

For a presented veto gate, the coordinator may record the actual response:

```bash
node "$BEN/scripts/run.mjs" record-veto --response r.json
# {"decision":"confirm"} or {"vetoes":["<fp>"]}
```

Return to the controller: complete only the current action, then return to the
sequencer (interactive) or runner (headless). A link does not authorize a next phase.
