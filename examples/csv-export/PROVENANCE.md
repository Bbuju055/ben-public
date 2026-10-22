# Provenance and replay

This is an inspectable subset of the synthetic CSV example run on 2026-10-21.
Claude Opus 5.5 wrote the plan, implementation, tests and fixture README. ben
invoked real Codex GPT-6 Astra for plan and diff review; both returned GO with
zero blockers. A human approved the plan before implementation. The operator
ran the workflow commands and made the local fixture commit. Nothing was published.

The original source, test, README and six criteria are retained byte-for-byte.
Raw transcripts, local paths, actor/account details, approval records and generated
PR instructions are omitted. This packet is curated evidence, not independently
authenticated provenance or a full workflow replay.

Run `node --test export-csv.test.mjs` from this directory with Node.js 24.
The original suite had 17 distinct passing tests, reused by six criteria (not
102 tests). A historical local reproduction also passed 17/17; it did not rerun either
model, approval or the runner. Current local check results are listed in
[verification](../../VERIFICATION.md). There were no actual review
findings or failing build checks in this case. [Live blocker reconciliation and
review continuation beyond the soft cap remain open](../../ROADMAP.md#live-verification-open).

The deliberate boundary: fixed columns exclude internal notes; CSV escaping
preserves values. Spreadsheet formula injection is not neutralized. Invalid input,
streaming and performance are outside the approved scope. See README for usage.

## Actual retained verdicts

### plan

```json
{
  "verdict": "GO",
  "blockers": [],
  "notes": "Checked .ben/brief.md and the README stub. The plan matches the requested behavior and file scope. The Node test gate is appropriate for this local library; no material contradiction or verification gap warrants blocking implementation."
}
```

### diff

```json
{
  "verdict": "GO",
  "blockers": [],
  "notes": "Reviewed C1\u2013C6 against the implementation and outcome assertions. Filtering, projection, escaping, CRLF termination, empty results, and non-mutation are supported by the code and tests. README satisfies the usage and formula-injection disclosure requirements. Changed paths match the approved scope; no UI/E2E coverage applies. No material defect found."
}
```

## Retained file SHA-256

- `README.md`: `3e1f15744a1d002c48eac70bf2fe4c8cc54fb32854ffc5d5d6a1f47a00373448`
- `criteria.json`: `172f1725a33cbb26fbf38f3403116c1e8f2df5767b1a7250c572e6b3695c455b`
- `export-csv.mjs`: `37aa9da67348bca552effc1c2d47b765a34b1800308208f0d12cc0fa2732d4ea`
- `export-csv.test.mjs`: `c8e2d97b507b298168bc4fa95e894a849fc3450c82b38293b06fcfb35d6d10f7`
