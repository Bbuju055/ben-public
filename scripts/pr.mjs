#!/usr/bin/env node
// pr — assemble the PR body as old ben wrote it, ported string-for-string from
// src/github/pr.ts (legacy implementation). Zero dependencies. Node only.
//
// The PR body is the story; the diff is the detail. A reviewer must understand
// what/why/how without opening a single file. Criteria appear as sentences with their
// verdicts — never as bare ids. MAJOR/NIT findings from the review rounds land as
// non-blocking notes, deduped, attributed to their first appearance.
//
// The rendering itself lives in scripts/adjudication.lib.mjs (renderPrBody — the
// pure in-memory projection shared with run.mjs check-pr-body/record-pr/
// record-publication). This script is render + write.
// Manual criteria render from the GOVERNING adjudication state: pending →
// "needs a human check before merge" (byte-identical legacy), satisfied →
// ✅ ADJUDICATED, accepted → 👤 ADJUDICATED with its unproven residual, plus an
// Adjudications section carrying ruling/residual/basis verbatim.
//
// Usage:
//   node scripts/pr.mjs <dir> [--repo p] --title "<task title>" [--out pr-body.md]
//
// --repo: required only when adjudication state exists
// and a `.ben`-parent repo cannot be derived; an explicit --repo must be the
// state dir's own repository when the dir is a repo-local `.ben`. cwd is never
// consulted for repo derivation.
//
// Exit codes: 0 body written · 3 usage/IO error (malformed state included)

import { writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { renderPrBody, resolveRepoForState } from './adjudication.lib.mjs';

function fail(msg) {
  console.error(`pr: ${msg}`);
  process.exit(3);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      out: { type: 'string', default: 'pr-body.md' },
      repo: { type: 'string' },
    },
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const { values, positionals } = parsed;
const dir = resolvePath(positionals[0] ?? '.');
if (!values.title) fail('--title is required (the task title, human words)');

let repoDir;
try {
  repoDir = resolveRepoForState(dir, values.repo);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

let body;
try {
  body = renderPrBody(dir, { title: values.title, repoDir });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const outPath = join(dir, values.out);
writeFileSync(outPath, `${body}\n`);
console.log(body);
console.error(`\npr: body written to ${outPath}`);
