import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { makeTmpDir } from './helpers';

// scripts/pregate.mjs — plan admissibility, ported from machine.ts pregate.
// One fixture per check; each red fixture must fail only its own check.

const SCRIPT = fileURLToPath(new URL('../scripts/pregate.mjs', import.meta.url));

async function workspace(files: Record<string, unknown>): Promise<string> {
  const dir = await makeTmpDir('pregate-');
  // promises.json, plan-files.json and gates.json are required artifacts like
  // criteria.json; fixtures get valid defaults so each red fixture
  // still trips only its own check. Pass null to omit a default.
  const defaults: Record<string, unknown> = { 'promises.json': [], 'plan-files.json': [], 'gates.json': { test: 'bun test' } };
  for (const [name, content] of Object.entries({ ...defaults, ...files })) {
    if (content === null) continue;
    await Bun.write(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function pregate(dir: string, ...args: string[]): Promise<ExecResult> {
  return execArgv(['node', SCRIPT, dir, ...args], { cwd: dir, timeoutMs: 30_000 });
}

/** The `- …` problem lines from the script's report. */
function problems(r: ExecResult): string[] {
  return r.stdout.split('\n').filter((l) => l.startsWith('- '));
}

const criterion = (id: string, verification: Record<string, unknown> = {}) => ({
  id,
  statement: `criterion ${id} holds`,
  verification: { method: 'test', command: 'bun test', ...verification },
});

const manualCriterion = (id: string) => ({
  id,
  statement: `criterion ${id} holds`,
  verification: { method: 'manual' },
});

const doc = (criteria: unknown[]) => ({ taskId: 'T1', criteria });

test('admissible plan exits 0 and does not touch the rounds tally', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1'), criterion('C2')]) });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('plan admissible (2 criteria)');
  expect(existsSync(join(dir, 'rounds.json'))).toBe(false);
});

test('unparseable criteria.json fails only the parse check', async () => {
  const dir = await workspace({ 'criteria.json': '{ nope' });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toHaveLength(1);
  expect(problems(r)[0]).toStartWith('- criteria.json invalid:');
});

test('schema-invalid criteria.json fails only the parse check — later checks are skipped', async () => {
  // 13 criteria (would also trip the count check) but each missing its statement:
  // an invalid doc must produce exactly one problem, like machine.ts where parse failure skips the rest
  const bad = Array.from({ length: 13 }, (_, i) => ({ id: `C${i}`, verification: { method: 'test', command: 'x' } }));
  const dir = await workspace({ 'criteria.json': doc(bad) });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toHaveLength(1);
  expect(problems(r)[0]).toStartWith('- criteria.json invalid:');
  expect(problems(r)[0]).toContain('criteria[0].statement');
});

test('more than maxCriteria criteria fails only the count check', async () => {
  const many = Array.from({ length: 13 }, (_, i) => criterion(`C${i}`));
  const dir = await workspace({ 'criteria.json': doc(many) });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual(['- 13 criteria exceeds max 12 — decompose the task']);
});

test('--max-criteria raises the cap for an otherwise clean plan', async () => {
  const many = Array.from({ length: 13 }, (_, i) => criterion(`C${i}`));
  const dir = await workspace({ 'criteria.json': doc(many) });
  const r = await pregate(dir, '--max-criteria', '20');
  expect(r.exitCode).toBe(0);
});

test('manual share over 30% fails only the manual-share check', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1'), criterion('C2'), manualCriterion('C3'), manualCriterion('C4')]),
  });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual(['- 2/4 criteria are manual (>30%) — decompose further']);
});

test('manual share of exactly 30% passes', async () => {
  const criteria = [...Array.from({ length: 7 }, (_, i) => criterion(`C${i}`)), ...['M1', 'M2', 'M3'].map(manualCriterion)];
  const dir = await workspace({ 'criteria.json': doc(criteria) });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(0);
});

test('non-manual criterion without a command fails only the command check', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1'), { id: 'C2', statement: 'criterion C2 holds', verification: { method: 'command' } }]),
  });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual(['- criterion C2 has method "command" but no command']);
});

test('UI-touching plan without an e2e criterion fails only the e2e check', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'plan-files.json': ['src/ui/App.tsx', 'src/lib/x.ts'],
  });
  const r = await pregate(dir, '--e2e-paths', 'src/ui/**,app/**');
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual(['- plan touches UI paths (src/ui/**, app/**) but has no e2e criterion']);
});

test('UI-touching plan with an e2e criterion passes', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1'), criterion('C2', { method: 'e2e' })]),
    'plan-files.json': ['src/ui/App.tsx'],
  });
  const r = await pregate(dir, '--e2e-paths', 'src/ui/**,app/**');
  expect(r.exitCode).toBe(0);
});

test('non-UI plan needs no e2e criterion', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'plan-files.json': ['src/lib/x.ts'],
  });
  const r = await pregate(dir, '--e2e-paths', 'src/ui/**,app/**');
  expect(r.exitCode).toBe(0);
});

test('missing plan-files.json fails closed when e2e paths are configured', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'plan-files.json': null });
  const r = await pregate(dir, '--e2e-paths', 'src/ui/**');
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toHaveLength(1);
  expect(problems(r)[0]).toStartWith('- plan-files.json invalid:');
});

test('missing plan-files.json fails closed even without e2e paths — it is a required plan artifact', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'plan-files.json': null });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toHaveLength(1);
  expect(problems(r)[0]).toStartWith('- plan-files.json invalid:');
});

test('frozen plan-files entry semantics: blank, duplicate, absolute, "./", "..", "//", backslash and glob forms are rejected by name', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'plan-files.json': ['  ', 'src/x.ts', 'src/x.ts', '/abs/path.ts', './src/y.ts', 'src/../z.ts', 'src//w.ts', 'src\\win.ts', 'src/ui/**'],
  });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toHaveLength(1);
  const p = problems(r)[0];
  expect(p).toStartWith('- plan-files.json invalid:');
  expect(p).toContain('blank');
  expect(p).toContain('duplicate');
  expect(p).toContain('absolute path');
  expect(p).toContain('"./" form');
  expect(p).toContain('".." traversal');
  expect(p).toContain('empty path segment');
  expect(p).toContain('backslash');
  expect(p).toContain('glob syntax is not supported');
});

test('plan-files entries are byte-literal — space-bearing filenames are distinct and legal; only exact duplicates collapse; trim exists solely for blank detection', async () => {
  // "x.ts" and "x.ts " are DIFFERENT legal literal filenames — never conflated
  const distinct = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'plan-files.json': ['x.ts', 'x.ts ', ' lead.ts', ' /space-dir-not-absolute.ts'],
  });
  expect((await pregate(distinct)).exitCode).toBe(0); // all four are exact-literal legal, no false duplicate, no false absolute

  // exact byte-identical entries ARE duplicates
  const dupes = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'plan-files.json': ['x.ts', 'x.ts'],
  });
  const r = await pregate(dupes);
  expect(r.exitCode).toBe(1);
  expect(problems(r)[0]).toContain('duplicate');
  expect(problems(r)[0]).toContain('"x.ts"'); // diagnostics JSON-encode the exact entry
});

test('a directory-looking literal entry is admissible and inert for e2e matching — the actual-diff scope check is the backstop', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]), // no e2e criterion
    'plan-files.json': ['src/ui'], // literal path; does NOT match src/ui/** (entries are file paths)
  });
  const r = await pregate(dir, '--e2e-paths', 'src/ui/**');
  expect(r.exitCode).toBe(0);
});

test('glob-side normalization: a "./"-prefixed e2e glob still matches canonical declared paths', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]), // no e2e criterion
    'plan-files.json': ['src/ui/App.tsx'],
  });
  const r = await pregate(dir, '--e2e-paths', './src/ui/**');
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual(['- plan touches UI paths (src/ui/**) but has no e2e criterion']);
});

test('missing promises.json fails only the manifest check — the manifest is required', async () => {
  const dir = await makeTmpDir('pregate-'); // no helper: the default manifest must be absent
  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(doc([criterion('C1')]), null, 2));
  await Bun.write(join(dir, 'plan-files.json'), JSON.stringify([]));
  await Bun.write(join(dir, 'gates.json'), JSON.stringify({ test: 'bun test' }));
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual([
    '- promises.json missing — declare the plan\'s promises as [{ "promise", "criterionRef" }] ([] when the prose promises nothing beyond the criteria)',
  ]);
});

test('malformed promises.json is reported, not treated as missing', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'promises.json': { promise: 'x' } });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual(['- promises.json invalid: expected a JSON array of { promise, criterionRef }']);
});

test('a promise without a criterionRef fails the manifest shape check', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'promises.json': [{ promise: 'errors are surfaced to the user' }],
  });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual([
    '- promises.json invalid: promises[0].criterionRef: expected a non-empty string — every promise pins a criterion',
  ]);
});

test('a promise pinning a criterion that does not exist fails only the coverage check', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'promises.json': [{ promise: 'retries are bounded', criterionRef: 'C9' }],
  });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual([
    '- promise "retries are bounded" pins criterion "C9" which does not exist — pin it to a real criterion or shrink the plan',
  ]);
});

test('a manifest whose every promise pins a real criterion passes', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1'), criterion('C2')]),
    'promises.json': [
      { promise: 'retries are bounded', criterionRef: 'C1' },
      { promise: 'errors are surfaced to the user', criterionRef: 'C2' },
    ],
  });
  expect((await pregate(dir)).exitCode).toBe(0);
});

test('greenfield plan without gates fails only the gates check', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'gates.json': null });
  const r = await pregate(dir, '--greenfield');
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual([
    '- greenfield plan declares no gates — declare the toolchain (typecheck and test commands at minimum)',
  ]);
});

test('non-greenfield plan without gates also fails — gates.json is a required plan artifact', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'gates.json': null });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual([
    '- gates.json missing or empty — declare the toolchain that judges the build (gate name -> shell command)',
  ]);
});

test('non-greenfield plan with an empty gates object fails the gates check', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'gates.json': {} });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual([
    '- gates.json missing or empty — declare the toolchain that judges the build (gate name -> shell command)',
  ]);
});

test('greenfield plan with empty gates object still fails the gates check', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'gates.json': {} });
  const r = await pregate(dir, '--greenfield');
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toHaveLength(1);
  expect(problems(r)[0]).toContain('greenfield plan declares no gates');
});

test('greenfield plan with declared gates passes; non-greenfield validates the same gates green', async () => {
  const dir = await workspace({
    'criteria.json': doc([criterion('C1')]),
    'gates.json': { typecheck: 'bun run typecheck', test: 'bun test' },
  });
  expect((await pregate(dir, '--greenfield')).exitCode).toBe(0);
  expect((await pregate(dir)).exitCode).toBe(0);
});

test('malformed gates.json is reported, not treated as missing gates', async () => {
  const dir = await workspace({ 'criteria.json': doc([criterion('C1')]), 'gates.json': { typecheck: 3 } });
  const r = await pregate(dir, '--greenfield');
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual(['- gates.json invalid: gate "typecheck" command must be a non-empty string']);
});

// distinct failing docs: each is invalid in a different way, so each is a genuinely
// new failed attempt under the complete-invocation dedupe
const badDoc = (n: number) => doc([{ id: `C${n}`, statement: `criterion C${n} holds`, verification: { method: 'test' } }]);

test('distinct failed rounds accumulate and escalate past the cap; --reset restores the budget', async () => {
  const dir = await workspace({ 'criteria.json': badDoc(1) });

  const first = await pregate(dir, '--plan-rounds', '2');
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toStartWith('Pregate failed — fix the plan');

  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(badDoc(2), null, 2));
  const second = await pregate(dir, '--plan-rounds', '2');
  expect(second.exitCode).toBe(1);

  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(badDoc(3), null, 2));
  const third = await pregate(dir, '--plan-rounds', '2');
  expect(third.exitCode).toBe(2);
  expect(third.stdout).toStartWith('pregate failed after 3 plan rounds:');
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(3);

  const reset = await pregate(dir, '--reset');
  expect(reset.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'))).toEqual({ plan: 0 });

  const again = await pregate(dir, '--plan-rounds', '2');
  expect(again.exitCode).toBe(1); // back within budget
});

test('replaying the identical failed invocation does not double-bump — crash recovery is budget-neutral', async () => {
  const dir = await workspace({ 'criteria.json': badDoc(1) });

  const first = await pregate(dir, '--plan-rounds', '2');
  expect(first.exitCode).toBe(1);
  const afterFirst = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'));
  expect(afterFirst.plan).toBe(1);

  // identical bytes, identical flags — e.g. resumed after an interruption
  const replay = await pregate(dir, '--plan-rounds', '2');
  expect(replay.exitCode).toBe(1); // still a failure, never inferred green
  expect(replay.stdout).toStartWith('Pregate failed — fix the plan');
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(1);
});

test('changing any verdict-relevant input or flag makes a new failed attempt', async () => {
  const dir = await workspace({ 'criteria.json': badDoc(1) });
  expect((await pregate(dir)).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(1);

  // same artifacts, different flag value — a different effective invocation
  expect((await pregate(dir, '--max-criteria', '11')).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(2);

  // changed input file — again a new attempt
  await Bun.write(join(dir, 'promises.json'), JSON.stringify([{ promise: 'x', criterionRef: 'missing' }], null, 2));
  expect((await pregate(dir, '--max-criteria', '11')).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(3);
});

test('a changed referee implementation makes the identical plan a new failed attempt (identity includes pregate.mjs bytes)', async () => {
  const dir = await workspace({ 'criteria.json': badDoc(1) });
  // run a byte-copy of the referee so the real script is never modified
  const copyA = join(dir, 'pregate-copy.mjs');
  await Bun.write(copyA, await readFile(SCRIPT, 'utf8'));
  const runCopy = () => execArgv(['node', copyA, dir, '--plan-rounds', '5'], { cwd: dir, timeoutMs: 30_000 });

  expect((await runCopy()).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(1);
  expect((await runCopy()).exitCode).toBe(1); // identical implementation replay: deduped
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(1);

  // implementation B: byte-different referee — the same plan/config is a NEW attempt
  await Bun.write(copyA, `${await readFile(SCRIPT, 'utf8')}\n// implementation B\n`);
  expect((await runCopy()).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(2);
});

test('a grant lifts exhaustion immediately without re-billing the unchanged failing plan; a real change bills a new attempt', async () => {
  const LEDGER = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));
  const dir = await workspace({ 'criteria.json': badDoc(1) });

  // drive the unchanged failing plan to the exhaustion boundary (cap 1)
  expect((await pregate(dir, '--plan-rounds', '1')).exitCode).toBe(1); // tally 1, within cap
  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(badDoc(2), null, 2));
  expect((await pregate(dir, '--plan-rounds', '1')).exitCode).toBe(2); // tally 2 > cap — exhausted
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(2);

  // a human grant, recorded through the referee — never a hand-edit
  const grant = await execArgv(['node', LEDGER, 'grant', dir, '--kind', 'plan', '--rounds', '2', '--by', 'operator'], { cwd: dir, timeoutMs: 30_000 });
  expect(grant.exitCode).toBe(0);

  // the exact same failed invocation, unchanged bytes: observed immediately,
  // exhausted → ordinary failure, and the tally does NOT increment again
  const replay = await pregate(dir, '--plan-rounds', '1');
  expect(replay.exitCode).toBe(1);
  expect(replay.stdout).toStartWith('Pregate failed — fix the plan');
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(2);

  // a verdict-relevant change is a genuinely new attempt and bills one
  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(badDoc(3), null, 2));
  expect((await pregate(dir, '--plan-rounds', '1')).exitCode).toBe(1); // 3 <= cap 1 + granted 2
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(3);
});

test('an absent input and a file whose bytes are literally "ABSENT" get different identities (domain separation)', async () => {
  const dir = await workspace({ 'criteria.json': badDoc(1), 'gates.json': null }); // no gates.json
  expect((await pregate(dir)).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(1);

  await Bun.write(join(dir, 'gates.json'), 'ABSENT');
  expect((await pregate(dir)).exitCode).toBe(1); // same verdict, but a different invocation
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(2);
});

test('success is never inferred from the failure record — a green run re-judges and clears it', async () => {
  const dir = await workspace({ 'criteria.json': badDoc(1) });
  expect((await pregate(dir)).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).lastPregateFail).toBeString();

  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(doc([criterion('C1')]), null, 2));
  expect((await pregate(dir)).exitCode).toBe(0);
  const rounds = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'));
  expect(rounds.plan).toBe(1); // budget untouched by green
  expect(rounds.lastPregateFail).toBeUndefined();
});

test('whitespace-only statements, commands, gate commands AND plan-files entries are rejected', async () => {
  const dir = await workspace({
    'criteria.json': doc([
      { id: ' ', statement: 'criterion holds', verification: { method: 'test', command: 'x' } },
      { id: 'C2', statement: '  ', verification: { method: 'test', command: 'x' } },
      { id: 'C3', statement: 'criterion C3 holds', verification: { method: 'test', command: '   ' } },
    ]),
  });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toHaveLength(1); // schema-invalid doc short-circuits, as ever
  expect(problems(r)[0]).toContain('criteria[0].id');
  expect(problems(r)[0]).toContain('criteria[1].statement');

  const dir2 = await workspace({
    'criteria.json': doc([criterion('C1'), { id: 'C3', statement: 'criterion C3 holds', verification: { method: 'test', command: '   ' } }]),
    'gates.json': { test: '  ' },
    'plan-files.json': ['src/x.ts', '  '],
  });
  const r2 = await pregate(dir2, '--greenfield', '--e2e-paths', 'src/ui/**');
  expect(r2.exitCode).toBe(1);
  const p2 = problems(r2);
  expect(p2).toContain('- criterion C3 has method "test" but no command');
  expect(p2.some((p) => p.startsWith('- gates.json invalid:') && p.includes('non-empty'))).toBe(true);
  // blank plan-files entries are invalid — the
  // entry validator rejects blank values even when the schema accepts strings
  expect(p2.some((p) => p.startsWith('- plan-files.json invalid:') && p.includes('blank'))).toBe(true);
});

test('a recorded plan grant raises the pregate cap — the shared budget is granted everywhere it is enforced', async () => {
  const dir = await workspace({
    'criteria.json': doc([{ id: 'C1', statement: 'criterion C1 holds', verification: { method: 'test' } }]),
    'rounds.json': { plan: 3, grants: [{ kind: 'plan', rounds: 2, by: 'operator', at: '2026-08-21T00:00:00.000Z' }] },
  });
  const r = await pregate(dir, '--plan-rounds', '3');
  expect(r.exitCode).toBe(1); // tally 4 <= cap 3 + granted 2 — a bounce, not an escalation
  expect(r.stdout).toStartWith('Pregate failed — fix the plan');
});

test('a diff grant does not raise the pregate plan cap', async () => {
  const dir = await workspace({
    'criteria.json': doc([{ id: 'C1', statement: 'criterion C1 holds', verification: { method: 'test' } }]),
    'rounds.json': { plan: 3, grants: [{ kind: 'diff', rounds: 2, by: 'operator', at: '2026-08-21T00:00:00.000Z' }] },
  });
  const r = await pregate(dir, '--plan-rounds', '3');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toStartWith('pregate failed after 4 plan rounds:');
});

test('a green run neither consumes nor resets the shared plan budget', async () => {
  const dir = await workspace({
    'criteria.json': doc([{ id: 'C1', statement: 'criterion C1 holds', verification: { method: 'test' } }]),
  });
  expect((await pregate(dir)).exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(1);

  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(doc([criterion('C1')]), null, 2));
  expect((await pregate(dir)).exitCode).toBe(0);
  // the counter is a task budget shared with review rounds (machine.ts:543) — green must not wipe it
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).plan).toBe(1);
});

test('one run reports every problem at once', async () => {
  const many = [
    ...Array.from({ length: 13 }, (_, i) => criterion(`C${i}`)),
    { id: 'C13', statement: 'criterion C13 holds', verification: { method: 'command' } },
  ];
  const dir = await workspace({ 'criteria.json': doc(many) });
  const r = await pregate(dir);
  expect(r.exitCode).toBe(1);
  expect(problems(r)).toEqual([
    '- 14 criteria exceeds max 12 — decompose the task',
    '- criterion C13 has method "command" but no command',
  ]);
});
