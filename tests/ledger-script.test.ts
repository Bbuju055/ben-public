import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { makeTmpDir } from './helpers';

// scripts/ledger.mjs — review adjudication, ported from machine.ts
// reviewPanel()/appendResolutions() and src/ledger/ledger.ts.
// One fixture per rule; each red fixture trips only its own rule.

const SCRIPT = fileURLToPath(new URL('../scripts/ledger.mjs', import.meta.url));

async function workspace(files: Record<string, unknown> = {}): Promise<string> {
  const dir = await makeTmpDir('ledger-');
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function ledger(dir: string, ...args: string[]): Promise<ExecResult> {
  return execArgv(['node', SCRIPT, ...args], { cwd: dir, timeoutMs: 30_000 });
}

async function ledgerEntries(dir: string): Promise<Array<Record<string, unknown>>> {
  if (!existsSync(join(dir, 'ledger.jsonl'))) return [];
  const raw = await readFile(join(dir, 'ledger.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

const blocker = (over: Record<string, unknown> = {}) => ({
  id: 'B1',
  severity: 'BLOCKER',
  claim: 'the plan has no empty-case test',
  evidence: 'src/x.ts:14 — add() lacks a zero-operand test',
  falsifier: 'a criterion whose command exercises add(0, 0)',
  criterionRef: 'C1',
  ...over,
});

const verdict = (v: 'GO' | 'NO_GO', blockers: unknown[] = []) => ({ verdict: v, blockers });

test('unanimous GO across reviewers exits 0 and consumes no budget', async () => {
  const dir = await workspace({ 'a.json': verdict('GO'), 'b.json': verdict('GO') });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('unanimous GO in plan round 1');
  expect(existsSync(join(dir, 'blockers.json'))).toBe(false);
  expect(existsSync(join(dir, 'rounds.json'))).toBe(false);
});

test('MAJOR and NIT never gate, even under a NO_GO verdict', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker({ severity: 'MAJOR' }), blocker({ id: 'B2', severity: 'NIT' })]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(dir, 'blockers.json'))).toBe(false);
  // never fingerprinted either — no identity machinery leaves a trace
  expect(await ledgerEntries(dir)).toEqual([]);
});

test('a blocker missing evidence or falsifier is auto-dropped and does not gate', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker({ falsifier: '  ' }), blocker({ id: 'B2', evidence: undefined })]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(0); // nothing survives — the round is a GO with the drops on record
  const entries = await ledgerEntries(dir);
  expect(entries.map((e) => e.action)).toEqual(['auto-dropped', 'auto-dropped']);
  expect(entries[0]?.detail).toStartWith('missing falsifier:');
  expect(entries[1]?.detail).toStartWith('missing evidence:');
});

// matrix 14 (with the matrix-1 companion): byte-identical tuples are the ONLY merge
test('byte-identical tuples from two reviewers merge to one thread; any wording drift splits', async () => {
  // byte-identical tuple (id/reviewer differ — both excluded from identity) → one thread
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker()]),
    'b.json': verdict('NO_GO', [blocker({ id: 'X9' })]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  expect(r.exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'))).toHaveLength(1);
  expect((await ledgerEntries(dir)).filter((e) => e.action === 'raised')).toHaveLength(1);

  // differently-worded claims are distinct defects → two threads
  const dir2 = await workspace({
    'a.json': verdict('NO_GO', [blocker()]),
    'b.json': verdict('NO_GO', [blocker({ id: 'X9', claim: 'zero-operand behaviour is untested' })]),
  });
  const r2 = await ledger(dir2, 'round', dir2, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  expect(r2.exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir2, 'blockers.json'), 'utf8'))).toHaveLength(2);
});

test('a rejected v2 fingerprint re-raised byte-identically is dropped; exact respondsTo escapes; paraphrase survives flagged', async () => {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);

  const [{ fingerprint }] = JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'));
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify([{ fingerprint, action: 'rejected', detail: 'covered by C2' }]));
  expect((await ledger(dir, 'resolve', dir, '--kind', 'plan')).exitCode).toBe(0);

  // byte-identical re-raise, no respondsTo → Tier-1 dropped, round is a GO; the drop cites the live handle
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker()])));
  const dropped = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json');
  expect(dropped.exitCode).toBe(0);
  const dropEntry = (await ledgerEntries(dir)).at(-1);
  expect(dropEntry?.action).toBe('re-raise-dropped');
  expect(dropEntry?.detail).toContain(fingerprint);

  // paraphrase + line drift is a DIFFERENT tuple → never suppressed; surfaces context-linked (matrix 18 shape)
  await Bun.write(
    join(dir, 'c.json'),
    JSON.stringify(verdict('NO_GO', [blocker({ evidence: 'src/x.ts:99 — still no zero test', claim: 'empty case remains unhandled' })])),
  );
  const paraphrase = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=c.json');
  expect(paraphrase.exitCode).toBe(1);
  const [reworded] = JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'));
  expect(reworded.priorRejections).toEqual([fingerprint]);
  expect((await ledgerEntries(dir)).at(-1)?.detail).toContain(`[prior rejection(s): ${fingerprint}]`);

  // the exact fingerprint contested byte-exactly via respondsTo escapes Tier 1
  await Bun.write(join(dir, 'd.json'), JSON.stringify(verdict('NO_GO', [blocker({ respondsTo: fingerprint })])));
  const contested = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=d.json');
  expect(contested.exitCode).toBe(1);
  const last = (await ledgerEntries(dir)).at(-1);
  expect(last?.action).toBe('raised');
  expect(last?.detail).toContain(`[contests: ${fingerprint}]`);
});

test('resolve records resolutions in the ledger and closes blockers.json', async () => {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  await ledger(dir, 'round', dir, '--kind', 'diff', '--verdict', 'codex=a.json');
  const [{ fingerprint }] = JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'));
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify([{ fingerprint, action: 'resolved', detail: 'committed the fix' }]));

  const r = await ledger(dir, 'resolve', dir, '--kind', 'diff');
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(dir, 'blockers.json'))).toBe(false);
  const last = (await ledgerEntries(dir)).at(-1);
  expect(last?.action).toBe('resolved');
  expect(last?.fingerprint).toBe(fingerprint);
});

test('every reviewer abstaining escalates — an absent verdict is never a pass', async () => {
  const dir = await workspace({ 'a.json': '{ not json' }); // b.json does not even exist
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('every plan reviewer abstained in round 1');
  expect((await ledgerEntries(dir)).map((e) => e.action)).toEqual(['abstain', 'abstain']);
});

test('one abstain with zero blockers escalates: unanimous-go violated', async () => {
  const dir = await workspace({ 'a.json': verdict('GO'), 'b.json': '{ not json' });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('unanimous-go violated in plan round 1: 1 reviewer(s) abstained with no blockers');
});

test('full-round semantics: rounds exhausted only when a further blocker-bearing round would exceed the cap', async () => {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });

  // round 1, cap 1: within budget — this round gets its reconcile
  const first = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1');
  expect(first.exitCode).toBe(1);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'))).toEqual({ plan: 1, survivors: { 'plan-1': 1 } });

  const [{ fingerprint }] = JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'));
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify([{ fingerprint, action: 'rejected', detail: 'not material' }]));
  await ledger(dir, 'resolve', dir, '--kind', 'plan');

  // round 2 raises a different blocker: the cap now bites — human decision, not a GO
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker({ evidence: 'src/other.ts — races on init', claim: 'init races' })])));
  const second = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1');
  expect(second.exitCode).toBe(2);
  expect(second.stdout).toContain('plan rounds exhausted (1/1 consumed; another blocker-bearing round would exceed the cap)');
});

test('the plan tally is shared with pregate bounces — pregate rounds count toward exhausted', async () => {
  // three plan rounds already consumed (e.g. pregate bounces): the next blocker-bearing round exceeds cap 3
  const dir = await workspace({ 'rounds.json': { plan: 3 }, 'a.json': verdict('NO_GO', [blocker()]) });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '3');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('plan rounds exhausted (3/3 consumed');
});

// --- capitulation smell ---

const CAPITULATION_WARNING = 'zero rejections across 5 resolutions — check for severity inflation';

const resolvedEntry = (round: number, kind = 'plan') =>
  JSON.stringify({
    ts: '2026-08-21T00:00:00.000Z',
    kind,
    round,
    reviewer: 'codex',
    blockerId: `B${round}`,
    fingerprint: `fp${round}`,
    action: 'resolved',
    detail: 'fixed',
  });

async function resolveOneBlocker(dir: string, action: 'resolved' | 'rejected'): Promise<ExecResult> {
  await Bun.write(join(dir, 'a.json'), JSON.stringify(verdict('NO_GO', [blocker()])));
  await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  const [{ fingerprint }] = JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'));
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify([{ fingerprint, action, detail: 'reconciled' }]));
  return ledger(dir, 'resolve', dir, '--kind', 'plan');
}

test('capitulation smell: zero rejections across 5 cumulative resolutions warns on resolve', async () => {
  const dir = await workspace({ 'ledger.jsonl': `${[1, 2, 3, 4].map((n) => resolvedEntry(n)).join('\n')}\n` });
  const r = await resolveOneBlocker(dir, 'resolved'); // the fifth all-resolved resolution
  expect(r.exitCode).toBe(0); // a warning, never a gate
  expect(r.stdout).toContain(CAPITULATION_WARNING);
  expect(r.stdout).toContain('capitulating to an unsatisfiable demand is a failure, not diligence');
});

test('capitulation smell: below the threshold stays quiet', async () => {
  const dir = await workspace({ 'ledger.jsonl': `${[1, 2, 3].map((n) => resolvedEntry(n)).join('\n')}\n` });
  const r = await resolveOneBlocker(dir, 'resolved'); // four resolutions, zero rejections
  expect(r.exitCode).toBe(0);
  expect(r.stdout).not.toContain('WARNING');
});

test('capitulation smell: a single rejection anywhere in the ledger clears it', async () => {
  const dir = await workspace({ 'ledger.jsonl': `${[1, 2, 3, 4, 5].map((n) => resolvedEntry(n)).join('\n')}\n` });
  const r = await resolveOneBlocker(dir, 'rejected'); // five resolved on record, but this round pushed back
  expect(r.exitCode).toBe(0);
  expect(r.stdout).not.toContain('WARNING');
});

// --- budget grants ---

test('grant is a recorded operation: who/when/how many in rounds.json and the ledger', async () => {
  const dir = await workspace({ 'rounds.json': { plan: 3 } });
  const r = await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '2', '--by', 'operator');
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('operator granted 2 more plan round(s)');

  const rounds = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'));
  expect(rounds.plan).toBe(3); // the tally is never hand-touched
  expect(rounds.grants).toHaveLength(1);
  expect(rounds.grants[0]).toMatchObject({ kind: 'plan', rounds: 2, by: 'operator' });
  expect(typeof rounds.grants[0].at).toBe('string');

  const last = (await ledgerEntries(dir)).at(-1);
  expect(last?.action).toBe('granted');
  expect(last?.reviewer).toBe('operator');
});

test('a conditional grant is a compare-and-swap on the validated rounds.json bytes: mismatch refuses with zero writes', async () => {
  const gate = { plan: 2, gates: { plan: { round: 2, reason: 'hard cap reached' } } };
  const dir = await workspace({ 'rounds.json': gate });
  const before = await readFile(join(dir, 'rounds.json'), 'utf8');
  const sha = createHash('sha256').update(before).digest('hex');

  // the state the answer validated moved (here: the gate was cleared by hand) → REFUSED, nothing lands
  await Bun.write(join(dir, 'rounds.json'), JSON.stringify({ plan: 2 }, null, 2) + '\n');
  const refused = await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '1', '--by', 'operator', '--expect-rounds-sha', sha);
  expect(refused.exitCode).toBe(1);
  expect(refused.stdout).toContain('grant REFUSED');
  const afterRefusal = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'));
  expect(afterRefusal.grants).toBeUndefined(); // no orphan grant exists to satisfy any later gate
  expect(await ledgerEntries(dir)).toHaveLength(0);

  // the exact validated bytes → the grant lands and clears exactly that gate
  await Bun.write(join(dir, 'rounds.json'), before);
  const granted = await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '1', '--by', 'operator', '--expect-rounds-sha', sha);
  expect(granted.exitCode).toBe(0);
  const after = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'));
  expect(after.grants).toHaveLength(1);
  expect(after.gates).toBeUndefined();

  // a malformed expectation is a usage failure, never a silent unconditional grant
  const usage = await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '1', '--by', 'operator', '--expect-rounds-sha', 'nothex');
  expect(usage.exitCode).toBe(3);
});

test('a grant raises the cap: an exhausted budget admits blocker-bearing rounds again', async () => {
  // plan tally at the cap — without a grant the next blocker-bearing round exits 2 (proven above)
  const dir = await workspace({ 'rounds.json': { plan: 3 }, 'a.json': verdict('NO_GO', [blocker()]) });
  await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '2', '--by', 'operator');
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '3');
  expect(r.exitCode).toBe(1); // within the granted budget — the round gets its reconcile
  expect(r.stdout).toContain('1 blocker(s) survive plan round 4');
});

test('a grant for one kind does not extend the other', async () => {
  const dir = await workspace({ 'rounds.json': { plan: 3 }, 'a.json': verdict('NO_GO', [blocker()]) });
  await ledger(dir, 'grant', dir, '--kind', 'diff', '--rounds', '2', '--by', 'operator');
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '3');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('plan rounds exhausted (3/3 consumed');
});

test('grant without --by is refused — an unattributed grant is a hand-edit', async () => {
  const dir = await workspace({ 'rounds.json': { plan: 3 } });
  const r = await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '2');
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('--by is required');
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'))).toEqual({ plan: 3 }); // untouched
});

// --- fingerprint matrix — v2 exact identity, contextKey
// context, contest aggregation, two-phase construction. Numbers reference the matrix.

// oracle: the retired v1 fingerprint algorithm, replicated verbatim — the expected
// contextKey and the shape of every legacy (12-hex) historical fingerprint
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|css|html|py|rs|go|sql|toml|yaml|yml|sh)$/i;
function oldFp(b: { claim: string; evidence?: string; criterionRef?: string }): string {
  const tokens = (b.evidence ?? '').match(/[\w.@/-]+/g) ?? [];
  const paths = [...new Set(tokens.filter((t) => t.includes('/') || CODE_EXT_RE.test(t)))].sort();
  const basis =
    paths.length > 0
      ? `${b.criterionRef ?? ''}|${paths.join('|')}`
      : `${b.criterionRef ?? ''}|${(b.claim.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ')}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

const legacyLine = (fingerprint: string, action: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-08-20T00:00:00.000Z',
    kind: 'plan',
    round: 1,
    reviewer: 'codex',
    blockerId: 'B1',
    fingerprint,
    action,
    detail: 'from a pre-v2 round',
    ...over,
  });

async function readBlockers(dir: string): Promise<Array<Record<string, any>>> {
  return JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'));
}

// runs one plan round carrying both blockers in one verdict and requires the two to
// survive as DISTINCT threads — a false merge collapses them to one and fails here
async function expectTwoThreads(b1: Record<string, unknown>, b2: Record<string, unknown>): Promise<string> {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [b1, b2]) });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(1);
  const blockers = await readBlockers(dir);
  expect(blockers).toHaveLength(2);
  expect(blockers[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(blockers[0]?.fingerprint).not.toBe(blockers[1]?.fingerprint);
  expect((await ledgerEntries(dir)).filter((e) => e.action === 'raised')).toHaveLength(2);
  return dir;
}

async function rejectAllOpen(dir: string): Promise<string[]> {
  const fps = (await readBlockers(dir)).map((b) => b.fingerprint as string);
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify(fps.map((fingerprint) => ({ fingerprint, action: 'rejected', detail: 'rejected' }))));
  expect((await ledger(dir, 'resolve', dir, '--kind', 'plan')).exitCode).toBe(0);
  return fps;
}

async function rejectOneOpen(dir: string): Promise<string> {
  const fps = await rejectAllOpen(dir);
  expect(fps).toHaveLength(1);
  return fps[0] ?? ''; // unreachable fallback — the expect above throws first
}

test('same criterion and path, different claims → two threads', async () => {
  await expectTwoThreads(
    blocker({ claim: 'endpoint /users returns 401', evidence: 'plan-files.json — /users route untested', criterionRef: 'C7' }),
    blocker({ id: 'B2', claim: 'endpoint /admins returns 403', evidence: 'plan-files.json — /users route untested', criterionRef: 'C7' }),
  );
});

test('same criterion, path and claim, different evidence → two threads', async () => {
  await expectTwoThreads(
    blocker({ claim: 'missing authorization check', evidence: 'src/api.ts:120 — GET handler lacks auth' }),
    blocker({ id: 'B2', claim: 'missing authorization check', evidence: 'src/api.ts:480 — DELETE handler lacks auth' }),
  );
});

test('tuple encoding is injective — flat-join collisions split, and rejection of one never suppresses the other', async () => {
  await expectTwoThreads(
    blocker({ claim: 'a|b', evidence: 'c', criterionRef: undefined }),
    blocker({ id: 'B2', claim: 'a', evidence: 'b|c', criterionRef: undefined }),
  );

  // reject the first shape, raise the second — a flat criterion|claim|evidence join
  // would alias them; the structured tuple must keep the second alive
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker({ claim: 'a|b', evidence: 'c', criterionRef: undefined })]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  await rejectAllOpen(dir);
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker({ claim: 'a', evidence: 'b|c', criterionRef: undefined })])));
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json');
  expect(r.exitCode).toBe(1);
  expect((await ledgerEntries(dir)).at(-1)?.action).toBe('raised');
});

test('delimiter and JSON characters in any field are inert; identical tuples are stable', async () => {
  await expectTwoThreads(blocker({ claim: 'emits a"b' }), blocker({ id: 'B2', claim: 'emits a\\b' }));
  await expectTwoThreads(blocker({ criterionRef: 'C|1' }), blocker({ id: 'B2', criterionRef: 'C1|' }));
  // evidence-side special characters are identity too — stripping them would merge these
  await expectTwoThreads(blocker({ evidence: 'a|b' }), blocker({ id: 'B2', evidence: 'ab' }));
  await expectTwoThreads(blocker({ evidence: 'says "x"' }), blocker({ id: 'B2', evidence: 'says x' }));
  await expectTwoThreads(blocker({ evidence: 'saw \\x' }), blocker({ id: 'B2', evidence: 'saw x' }));

  // the same pipe/quote/backslash-bearing tuple in two separate runs → one identical fingerprint
  const spiky = blocker({ claim: 'claim with | and "quotes"', evidence: 'src/x.ts — output was \\ and |', criterionRef: 'C|2' });
  const dirs = await Promise.all([workspace({ 'a.json': verdict('NO_GO', [spiky]) }), workspace({ 'a.json': verdict('NO_GO', [spiky]) })]);
  for (const d of dirs) expect((await ledger(d, 'round', d, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const [[x], [y]] = [await readBlockers(dirs[0]), await readBlockers(dirs[1])];
  expect(x?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(x?.fingerprint).toBe(y?.fingerprint);
});

test('near-identical path strings and case differences are distinct', async () => {
  await expectTwoThreads(
    blocker({ evidence: '/users/admin returns 500' }),
    blocker({ id: 'B2', evidence: '/users-admin returns 500' }),
  );
  await expectTwoThreads(
    blocker({ claim: 'Foo is unhandled', evidence: 'gate output shows a failure' }),
    blocker({ id: 'B2', claim: 'foo is unhandled', evidence: 'gate output shows a failure' }),
  );
});

test('internal whitespace differences in the claim are distinct', async () => {
  await expectTwoThreads(
    blocker({ claim: 'fixture emits "a  b"', evidence: 'gate output shows a failure' }),
    blocker({ id: 'B2', claim: 'fixture emits "a b"', evidence: 'gate output shows a failure' }),
  );
});

test('numeric literals inside quoted program output are distinct', async () => {
  await expectTwoThreads(
    blocker({ claim: 'parser rejects input "line 120"', evidence: 'gate output shows a failure' }),
    blocker({ id: 'B2', claim: 'parser rejects input "line 121"', evidence: 'gate output shows a failure' }),
  );
});

test('claim-side path:line churn with identical evidence is distinct', async () => {
  await expectTwoThreads(
    blocker({ claim: 'parser emits literal src/x.ts:14', evidence: 'observed in gate output for src/parser.ts' }),
    blocker({ id: 'B2', claim: 'parser emits literal src/x.ts:99', evidence: 'observed in gate output for src/parser.ts' }),
  );
});

test('evidence-side semantic path:line data is distinct, and rejecting one never suppresses the other', async () => {
  const b1 = blocker({ claim: 'diagnostic token drifted', evidence: 'actual diagnostic token is src/x.ts:14' });
  const b2 = blocker({ id: 'B2', claim: 'diagnostic token drifted', evidence: 'actual diagnostic token is src/x.ts:99' });
  await expectTwoThreads(b1, b2);

  const dir = await workspace({ 'a.json': verdict('NO_GO', [b1]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const fp1 = await rejectOneOpen(dir);
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [b2])));
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json');
  expect(r.exitCode).toBe(1); // survives — context-linked, never Tier-1 suppressed
  const [survivor] = await readBlockers(dir);
  expect(survivor?.priorRejections).toEqual([fp1]);
});

test('outer whitespace is identity — evidence and criterionRef variants split and never suppress each other', async () => {
  const trailing = blocker({ claim: 'emitted value has a trailing blank', evidence: 'value ' });
  const bare = blocker({ id: 'B2', claim: 'emitted value has a trailing blank', evidence: 'value' });
  await expectTwoThreads(trailing, bare);
  await expectTwoThreads(
    blocker({ claim: 'emitted value has a leading blank', evidence: ' value' }),
    blocker({ id: 'B2', claim: 'emitted value has a leading blank', evidence: 'value' }),
  );
  await expectTwoThreads(blocker({ criterionRef: 'C2' }), blocker({ id: 'B2', criterionRef: ' C2' }));

  // reject the trailing-blank finding; the bare-value finding must survive
  const dir = await workspace({ 'a.json': verdict('NO_GO', [trailing]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  await rejectAllOpen(dir);
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [bare])));
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json')).exitCode).toBe(1);
  expect((await ledgerEntries(dir)).at(-1)?.action).toBe('raised');
});

test('two distinct findings in one file with no criterionRef → two threads', async () => {
  await expectTwoThreads(
    blocker({ claim: 'init races on startup', evidence: 'src/boot.ts — init() awaited nowhere', criterionRef: undefined }),
    blocker({ id: 'B2', claim: 'shutdown leaks the handle', evidence: 'src/boot.ts — close() never called', criterionRef: undefined }),
  );
});

test('the same tuple shape against different files → two threads', async () => {
  await expectTwoThreads(
    blocker({ claim: 'file is untested', evidence: 'src/a.ts — no test imports it' }),
    blocker({ id: 'B2', claim: 'file is untested', evidence: 'src/b.ts — no test imports it' }),
  );
});

test('same claim, endpoints differing only in evidence → two threads', async () => {
  await expectTwoThreads(
    blocker({ claim: 'endpoint unauthenticated', evidence: '/users responds 200 without a token' }),
    blocker({ id: 'B2', claim: 'endpoint unauthenticated', evidence: '/admins responds 200 without a token' }),
  );
});

test('free-form line churn splits visibly, shares one contextKey, and carries the linked rejection', async () => {
  const b14 = blocker({ claim: 'zero test missing', evidence: 'add() untested at src/x.ts:14' });
  const b99 = blocker({ id: 'B2', claim: 'zero test missing', evidence: 'add() untested at src/x.ts:99' });
  const legacy = oldFp(b14); // line-insensitive path basis — identical for both variants
  expect(oldFp(b99)).toBe(legacy);

  const dir = await workspace({
    'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`,
    'a.json': verdict('NO_GO', [b14, b99]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(1);
  const blockers = await readBlockers(dir);
  expect(blockers).toHaveLength(2); // split, never merged
  expect(blockers[0]?.contextKey).toMatch(/^[0-9a-f]{12}$/);
  expect(blockers[0]?.contextKey).toBe(blockers[1]?.contextKey);
  for (const b of blockers) expect(b.priorRejections).toEqual([legacy]);
});

test('fingerprints are stable across separate round invocations and are full 64-hex', async () => {
  const dirs = await Promise.all([workspace({ 'a.json': verdict('NO_GO', [blocker()]) }), workspace({ 'a.json': verdict('NO_GO', [blocker()]) })]);
  for (const d of dirs) expect((await ledger(d, 'round', d, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const [[x], [y]] = [await readBlockers(dirs[0]), await readBlockers(dirs[1])];
  expect(x?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(x?.fingerprint).toBe(y?.fingerprint);
});

test('mixed 12-hex and 64-hex handles coexist; only the exact 64-hex respondsTo escapes Tier 1', async () => {
  const legacy = 'abc123def456'; // a 12-hex pre-v2 rejection on the books
  const dir = await workspace({ 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const v2fp = await rejectOneOpen(dir);
  expect(v2fp).toMatch(/^[0-9a-f]{64}$/);

  // legacy 12-hex handle does NOT escape a v2 rejection; the drop cites the live 64-hex handle
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker({ respondsTo: legacy })])));
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json')).exitCode).toBe(0);
  const drop = (await ledgerEntries(dir)).at(-1);
  expect(drop?.action).toBe('re-raise-dropped');
  expect(drop?.detail).toContain(v2fp);

  // the byte-exact 64-hex handle escapes; the inert legacy marker is preserved verbatim
  await Bun.write(join(dir, 'c.json'), JSON.stringify(verdict('NO_GO', [blocker({ respondsTo: v2fp })])));
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=c.json')).exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.respondsTo).toEqual([v2fp]);

  // both widths render side by side in the ledger view
  await Bun.write(join(dir, 'z.json'), '{ not json');
  const rendered = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=z.json');
  expect(rendered.exitCode).toBe(2);
  expect(rendered.stdout).toContain(legacy);
  expect(rendered.stdout).toContain(v2fp);
});

test('a pre-v2 PATHFUL rejection re-raised byte-identically is NOT suppressed and carries the prior rejection', async () => {
  const b = blocker();
  const legacy = oldFp(b);
  const dir = await workspace({ 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [b]) });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(1);
  const [survivor] = await readBlockers(dir);
  expect(survivor?.priorRejections).toEqual([legacy]);
  expect((await ledgerEntries(dir)).at(-1)?.detail).toContain(`[prior rejection(s): ${legacy}]`);
});

test('a pre-v2 PATHLESS rejection re-raised byte-identically is NOT suppressed and carries the prior rejection', async () => {
  const b = blocker({ claim: 'the empty case is unhandled', evidence: 'gate output shows a bare failure' });
  const legacy = oldFp(b); // pathless: old normalized-claim basis
  const dir = await workspace({ 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [b]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const [survivor] = await readBlockers(dir);
  expect(survivor?.priorRejections).toEqual([legacy]);
});

test('a DIFFERENT finding colliding under the old lossy pathless normalization survives, flagged not suppressed', async () => {
  const legacy = oldFp({ claim: 'empty CASE unhandled!', evidence: 'reviewer prose, no artifact', criterionRef: 'C1' });
  const b = blocker({ claim: 'Empty case unhandled', evidence: 'a genuinely new failing scenario was observed' });
  expect(oldFp(b)).toBe(legacy); // normalization-stable collision
  const dir = await workspace({ 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [b]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.priorRejections).toEqual([legacy]);
});

test('a post-v2 pathless rejection links rewordings via the stored contextKey; Tier 1 needs the full exact tuple', async () => {
  const b = blocker({ claim: 'the gate output shows FAIL', evidence: 'exit code 3 observed', criterionRef: 'C2' });
  const dir = await workspace({ 'a.json': verdict('NO_GO', [b]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const v2fp = await rejectOneOpen(dir);

  // reworded claim, identical under the old normalization → survives with the 64-hex prior rejection attached
  const reworded = blocker({ claim: 'The Gate Output shows fail', evidence: 'exit code 3 observed', criterionRef: 'C2' });
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [reworded])));
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json');
  expect(r.exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.priorRejections).toEqual([v2fp]);
});

test('contextKey collisions are flag-only — cardinality, exit and tally identical with and without the linked rejection', async () => {
  const b1 = blocker({ claim: 'plan-files omits the migration dir', evidence: 'plan-files.json — the migration dir is absent', criterionRef: 'C7' });
  const b2 = blocker({ id: 'B2', claim: 'plan-files omits the e2e dir', evidence: 'plan-files.json — the e2e dir is absent', criterionRef: 'C7' });
  const legacy = oldFp(b1);
  expect(oldFp(b2)).toBe(legacy); // shared old path basis — the historical lossy-fingerprint collision

  const flagged = await workspace({ 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [b1, b2]) });
  const clean = await workspace({ 'a.json': verdict('NO_GO', [b1, b2]) });
  const rf = await ledger(flagged, 'round', flagged, '--kind', 'plan', '--verdict', 'codex=a.json');
  const rc = await ledger(clean, 'round', clean, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(rf.exitCode).toBe(1);
  expect(rc.exitCode).toBe(1);
  expect(await readBlockers(flagged)).toHaveLength(2);
  expect(await readBlockers(clean)).toHaveLength(2);
  expect(JSON.parse(await readFile(join(flagged, 'rounds.json'), 'utf8'))).toEqual(JSON.parse(await readFile(join(clean, 'rounds.json'), 'utf8')));
  for (const b of await readBlockers(flagged)) expect(b.priorRejections).toEqual([legacy]); // the only difference: flags

  // cap/grant interaction: a context-linked round at an exhausted cap honours a
  // recorded grant exactly like an unflagged one — exit 1, never a flag-driven exit 2
  const atCap = await workspace({
    'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`,
    'rounds.json': { plan: 3 },
    'a.json': verdict('NO_GO', [b1, b2]),
  });
  await ledger(atCap, 'grant', atCap, '--kind', 'plan', '--rounds', '2', '--by', 'operator');
  const granted = await ledger(atCap, 'round', atCap, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '3');
  expect(granted.exitCode).toBe(1); // within the granted budget, flags notwithstanding
  expect(await readBlockers(atCap)).toHaveLength(2);
  for (const b of await readBlockers(atCap)) expect(b.priorRejections).toEqual([legacy]);
});

test('mutable reviews/ artifacts never influence adjudication — legacy-rejection path included', async () => {
  // the sharp case: a legacy rejection whose historical review file could tempt a
  // reconstruction — adjudication must be byte-identical with the review file absent,
  // present with a conflicting verdict, or replaced with garbage
  const b = blocker();
  const legacy = oldFp(b);
  const inputs = { 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [b]) };
  const bare = await workspace(inputs);
  const conflicting = await workspace({
    ...inputs,
    'reviews/plan-round-1-codex.json': verdict('GO'), // claims the round was clean
  });
  const garbage = await workspace({
    ...inputs,
    'reviews/plan-round-1-codex.json': '{ not even json',
  });
  for (const dir of [bare, conflicting, garbage]) {
    expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  }
  const expected = await readFile(join(bare, 'blockers.json'), 'utf8');
  expect(JSON.parse(expected)[0]?.priorRejections).toEqual([legacy]); // survives flagged, never suppressed
  expect(await readFile(join(conflicting, 'blockers.json'), 'utf8')).toBe(expected);
  expect(await readFile(join(garbage, 'blockers.json'), 'utf8')).toBe(expected);
});

test('legacy rejected A never suppresses distinct new B sharing its old basis — the F-03 defect is gone', async () => {
  const A = blocker({ claim: 'scope check missing', evidence: 'plan-files.json omits the src tree', criterionRef: 'C7' });
  const B = blocker({ id: 'B2', claim: 'scope check missing', evidence: 'plan-files.json omits the tests tree', criterionRef: 'C7' });
  const legacy = oldFp(A);
  expect(oldFp(B)).toBe(legacy); // old algorithm collapsed these — v2 must not
  const dir = await workspace({ 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [B]) });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(1);
  const [survivor] = await readBlockers(dir);
  expect(survivor?.claim).toBe(B.claim);
  expect(survivor?.priorRejections).toEqual([legacy]);
});

test('a full legacy raised→rejected→contested→resolved history never suppresses a post-cutover re-raise', async () => {
  const b = blocker();
  const legacy = oldFp(b);
  const history = [
    legacyLine(legacy, 'raised'),
    legacyLine(legacy, 'rejected'),
    legacyLine(legacy, 'raised', { round: 2, detail: 'contested via respondsTo' }),
    legacyLine(legacy, 'resolved', { round: 2 }),
  ].join('\n');
  const dir = await workspace({ 'ledger.jsonl': `${history}\n`, 'a.json': verdict('NO_GO', [b]) });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.priorRejections).toEqual([legacy]);
});

test('an adopted legacy ledger adjudicates end-to-end with legacy context intact', async () => {
  const rejected = blocker({ claim: 'criteria lack an e2e proof', evidence: 'criteria.json — no method e2e', criterionRef: 'C3' });
  const legacy = oldFp(rejected);
  const history = [
    legacyLine('0f1e2d3c4b5a', 'raised', { detail: 'plan omits rollback' }),
    legacyLine('0f1e2d3c4b5a', 'resolved', { detail: 'rollback criterion added' }),
    legacyLine(legacy, 'raised', { round: 2, detail: rejected.claim }),
    legacyLine(legacy, 'rejected', { round: 2, detail: 'e2e not applicable to this slice' }),
    legacyLine('9a8b7c6d5e4f', 'raised', { kind: 'diff', detail: 'diff touches unplanned file' }),
    legacyLine('9a8b7c6d5e4f', 'resolved', { kind: 'diff' }),
  ].join('\n');
  const dir = await workspace({
    'ledger.jsonl': `${history}\n`,
    'rounds.json': { plan: 2, diff: 1 },
    'a.json': verdict('NO_GO', [rejected, blocker({ id: 'B2', claim: 'a genuinely new finding', evidence: 'src/new.ts — untested' })]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '5');
  expect(r.exitCode).toBe(1);
  const blockers = await readBlockers(dir);
  expect(blockers).toHaveLength(2); // the legacy-rejected re-raise survives (flagged), the new finding survives
  expect(blockers.find((b) => b.claim === rejected.claim)?.priorRejections).toEqual([legacy]);
  expect(blockers.find((b) => b.claim === 'a genuinely new finding')?.priorRejections).toBeUndefined();
});

test('a malformed historical ledger line fails the round loudly — nothing silently migrated', async () => {
  const dir = await workspace({
    'ledger.jsonl': `${legacyLine('abc123def456', 'rejected')}\nthis line is not JSON\n`,
    'a.json': verdict('NO_GO', [blocker()]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).not.toBe(0);
  // the failure stays loud and names the ledger (reads go
  // through the shared strict boundary, which echoes the offending line)
  expect(r.stderr).toContain('ledger.jsonl has a malformed line');
  expect(r.stderr).toContain('this line is not JSON');
  expect(existsSync(join(dir, 'blockers.json'))).toBe(false);
});

test('matrix 28+36: a duplicate\'s contest handle survives dedupe into blockers.json and the single raised entry', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker()]),
    'b.json': verdict('NO_GO', [blocker({ id: 'X9', respondsTo: 'abc123def456' })]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  expect(r.exitCode).toBe(1);
  const blockers = await readBlockers(dir);
  expect(blockers).toHaveLength(1);
  expect(blockers[0]?.respondsTo).toEqual(['abc123def456']);
  const raised = (await ledgerEntries(dir)).filter((e) => e.action === 'raised');
  expect(raised).toHaveLength(1); // exactly one final entry for the thread
  expect(raised[0]?.detail).toContain('[contests: abc123def456]');
});

test('matrix 29+37: reverse encounter order yields byte-equivalent contest metadata', async () => {
  const withHandle = blocker({ id: 'X9', respondsTo: 'abc123def456' });
  const forward = await workspace({ 'a.json': verdict('NO_GO', [blocker()]), 'b.json': verdict('NO_GO', [withHandle]) });
  const reverse = await workspace({ 'a.json': verdict('NO_GO', [withHandle]), 'b.json': verdict('NO_GO', [blocker()]) });
  await ledger(forward, 'round', forward, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  await ledger(reverse, 'round', reverse, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json');
  const [f] = await readBlockers(forward);
  const [g] = await readBlockers(reverse);
  expect(f?.respondsTo).toEqual(['abc123def456']);
  expect(g?.respondsTo).toEqual(['abc123def456']);
  const fRaised = (await ledgerEntries(forward)).filter((e) => e.action === 'raised');
  const gRaised = (await ledgerEntries(reverse)).filter((e) => e.action === 'raised');
  expect(fRaised[0]?.detail).toContain('[contests: abc123def456]');
  expect(fRaised[0]?.detail).toBe(gRaised[0]?.detail);
});

test('duplicates carrying different handles preserve BOTH, deterministically sorted', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker({ respondsTo: 'zzz999zzz999' })]),
    'b.json': verdict('NO_GO', [blocker({ id: 'X9', respondsTo: 'aaa111aaa111' })]),
  });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json')).exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.respondsTo).toEqual(['aaa111aaa111', 'zzz999zzz999']);
});

test('duplicate exact contests of a rejected v2 fingerprint both escape Tier 1 and dedupe to one thread', async () => {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const v2fp = await rejectOneOpen(dir);
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker({ respondsTo: v2fp })])));
  await Bun.write(join(dir, 'c.json'), JSON.stringify(verdict('NO_GO', [blocker({ id: 'X9', respondsTo: v2fp })])));
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json', '--verdict', 'gemini=c.json');
  expect(r.exitCode).toBe(1);
  const blockers = await readBlockers(dir);
  expect(blockers).toHaveLength(1);
  expect(blockers[0]?.respondsTo).toEqual([v2fp]);
});

test('a legacy context link plus a legacy respondsTo marker both surface, neither disposes', async () => {
  const b = blocker();
  const legacy = oldFp(b);
  const dir = await workspace({
    'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`,
    'a.json': verdict('NO_GO', [blocker({ respondsTo: legacy })]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(1); // survives — a human decision, never automatic
  const [survivor] = await readBlockers(dir);
  expect(survivor?.priorRejections).toEqual([legacy]);
  expect(survivor?.respondsTo).toEqual([legacy]);
  const raised = (await ledgerEntries(dir)).at(-1);
  expect(raised?.detail).toContain(`[prior rejection(s): ${legacy}]`);
  expect(raised?.detail).toContain(`[contests: ${legacy}]`);
});

test('a paraphrase treadmill consumes budget and escalates at the cap — bounded, visible, never silent', async () => {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1')).exitCode).toBe(1);
  await rejectAllOpen(dir);
  // the reworded re-raise is NOT dropped — it consumes the budget and trips the cap
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker({ claim: 'empty case still unhandled, reworded' })])));
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('plan rounds exhausted');
  expect((await ledgerEntries(dir)).filter((e) => e.action === 'raised')).toHaveLength(2); // visible, not suppressed
});

test('a pathless re-raise reworded beyond the old normalization surfaces with no link — accepted residual', async () => {
  const legacy = oldFp({ claim: 'the empty case is unhandled', evidence: 'reviewer prose only', criterionRef: 'C1' });
  const reworded = blocker({ claim: 'zero-operand invocation lacks any test', evidence: 'no artifact exercises the zero path' });
  const dir = await workspace({ 'ledger.jsonl': `${legacyLine(legacy, 'rejected')}\n`, 'a.json': verdict('NO_GO', [reworded]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.priorRejections).toBeUndefined();
});

test('three duplicates with handles on the later two produce one raised entry with the sorted union', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker()]),
    'b.json': verdict('NO_GO', [blocker({ id: 'X8', respondsTo: 'zzz999zzz999' })]),
    'c.json': verdict('NO_GO', [blocker({ id: 'X9', respondsTo: 'aaa111aaa111' })]),
  });
  const r = await ledger(
    dir, 'round', dir, '--kind', 'plan',
    '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json', '--verdict', 'gpt=c.json',
  );
  expect(r.exitCode).toBe(1);
  const raised = (await ledgerEntries(dir)).filter((e) => e.action === 'raised');
  expect(raised).toHaveLength(1);
  expect(raised[0]?.detail).toContain('[contests: aaa111aaa111 zzz999zzz999]');
  expect((await readBlockers(dir))[0]?.respondsTo).toEqual(['aaa111aaa111', 'zzz999zzz999']);
});

test('contest metadata outlives blockers.json — the durable raised detail keeps it after resolve', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker()]),
    'b.json': verdict('NO_GO', [blocker({ id: 'X9', respondsTo: 'abc123def456' })]),
  });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--verdict', 'gemini=b.json')).exitCode).toBe(1);
  const open = await readBlockers(dir);
  await Bun.write(
    join(dir, 'resolutions.json'),
    JSON.stringify(open.map((b) => ({ fingerprint: b.fingerprint, action: 'resolved', detail: 'fixed' }))),
  );
  expect((await ledger(dir, 'resolve', dir, '--kind', 'plan')).exitCode).toBe(0);
  expect(existsSync(join(dir, 'blockers.json'))).toBe(false);
  const raised = (await ledgerEntries(dir)).filter((e) => e.action === 'raised');
  expect(raised[0]?.detail).toContain('[contests: abc123def456]');

  // and the RENDERED ledger view still shows it — not just the raw jsonl bytes
  await Bun.write(join(dir, 'z.json'), '{ not json');
  const rendered = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=z.json');
  expect(rendered.exitCode).toBe(2);
  expect(rendered.stdout).toContain('[contests: abc123def456]');
});

test('matrix 40+43: degenerate zero-token claims keep the old contextKey, stay flag-only, and never change gating', async () => {
  const bang = blocker({ claim: '!!!', evidence: 'exit code 3 observed', criterionRef: 'C1' });
  const dir = await workspace({ 'a.json': verdict('NO_GO', [bang]) });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(r.exitCode).toBe(1); // no crash, survives normally
  const [survivor] = await readBlockers(dir);
  expect(survivor?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(survivor?.contextKey).toBe(oldFp(bang)); // the degenerate `crit|` key
  expect(survivor?.contextKey).toBe(createHash('sha256').update('C1|').digest('hex').slice(0, 12));

  // colliding degenerate keys plus a linked rejection: gating identical, only flags differ (matrix 43)
  const pair = [bang, blocker({ id: 'B2', claim: '???', evidence: 'exit code 3 observed', criterionRef: 'C1' })];
  const flagged = await workspace({ 'ledger.jsonl': `${legacyLine(oldFp(bang), 'rejected')}\n`, 'a.json': verdict('NO_GO', pair) });
  const clean = await workspace({ 'a.json': verdict('NO_GO', pair) });
  const rf = await ledger(flagged, 'round', flagged, '--kind', 'plan', '--verdict', 'codex=a.json');
  const rc = await ledger(clean, 'round', clean, '--kind', 'plan', '--verdict', 'codex=a.json');
  expect(rf.exitCode).toBe(rc.exitCode);
  expect(await readBlockers(flagged)).toHaveLength(2);
  expect(await readBlockers(clean)).toHaveLength(2);
  expect(JSON.parse(await readFile(join(flagged, 'rounds.json'), 'utf8'))).toEqual(JSON.parse(await readFile(join(clean, 'rounds.json'), 'utf8')));
});

test('the pathless contextKey equals the historical old-algorithm output byte-for-byte', async () => {
  const b = blocker({ claim: 'the empty case is unhandled', evidence: 'gate output shows a bare failure' });
  const dir = await workspace({ 'a.json': verdict('NO_GO', [b]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.contextKey).toBe(oldFp(b));
});

test('the pathful contextKey equals the historical old-algorithm output byte-for-byte', async () => {
  const b = blocker();
  const dir = await workspace({ 'a.json': verdict('NO_GO', [b]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  expect((await readBlockers(dir))[0]?.contextKey).toBe(oldFp(b));
});

test('respondsTo is byte-exact — a stray-whitespace handle does not escape Tier 1 and is stored verbatim', async () => {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json')).exitCode).toBe(1);
  const v2fp = await rejectOneOpen(dir);

  // " fp" does NOT escape; the drop message cites the correct handle
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker({ respondsTo: ` ${v2fp}` })])));
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json')).exitCode).toBe(0);
  const drop = (await ledgerEntries(dir)).at(-1);
  expect(drop?.action).toBe('re-raise-dropped');
  expect(drop?.detail).toContain(`exact respondsTo ${v2fp}`);

  // the byte-exact handle escapes; a stray-whitespace handle on a NEW finding is stored and rendered exactly
  await Bun.write(
    join(dir, 'c.json'),
    JSON.stringify(verdict('NO_GO', [
      blocker({ respondsTo: v2fp }),
      blocker({ id: 'B2', claim: 'a different finding entirely', evidence: 'src/other.ts — races on init', respondsTo: ' abc123def456' }),
    ])),
  );
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=c.json', '--cap', '5')).exitCode).toBe(1);
  const blockers = await readBlockers(dir);
  expect(blockers.find((b) => b.id === 'B1')?.respondsTo).toEqual([v2fp]);
  expect(blockers.find((b) => b.id === 'B2')?.respondsTo).toEqual([' abc123def456']);
  const raisedB2 = (await ledgerEntries(dir)).filter((e) => e.action === 'raised' && e.blockerId === 'B2');
  expect(raisedB2[0]?.detail).toContain('[contests:  abc123def456]'); // verbatim — leading space preserved
});

// ---------------------------------------------------------------------------
// corrections: every reachable
// ledger-mutating CLI path validates existing ledger state BEFORE mutating

const invalidAdjRow = JSON.stringify({
  ts: '2026-08-24T00:00:00.000Z',
  kind: 'adjudication',
  round: 0,
  reviewer: 'operator',
  blockerId: 'C7',
  fingerprint: 'a'.repeat(64),
  action: 'adjudicated',
  detail: 'a wrapper with no embedded record',
});

test('resolve validates the ledger BEFORE mutating — invalid or torn rows cause zero appends and keep blockers.json', async () => {
  for (const badLedger of [`${invalidAdjRow}\n`, '{ torn\n']) {
    const dir = await workspace({
      'blockers.json': [{ id: 'B1', reviewer: 'codex', fingerprint: 'f'.repeat(64) }],
      'resolutions.json': [{ fingerprint: 'f'.repeat(64), action: 'resolved', detail: 'done' }],
      'ledger.jsonl': badLedger,
    });
    const r = await ledger(dir, 'resolve', dir, '--kind', 'plan');
    expect(r.exitCode).toBe(3);
    expect(existsSync(join(dir, 'blockers.json'))).toBe(true); // never deleted
    expect(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).toBe(badLedger); // never appended
  }
});

test('grant validates the ledger BEFORE mutating — invalid or torn rows cause zero rounds.json writes and zero appends', async () => {
  for (const badLedger of [`${invalidAdjRow}\n`, '{ torn\n']) {
    const roundsBefore = JSON.stringify({ plan: 0 }, null, 2);
    const dir = await workspace({ 'ledger.jsonl': badLedger });
    await Bun.write(join(dir, 'rounds.json'), roundsBefore);
    const r = await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '2', '--by', 'operator');
    expect(r.exitCode).toBe(3);
    expect(await readFile(join(dir, 'rounds.json'), 'utf8')).toBe(roundsBefore); // no grant landed
    expect(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).toBe(badLedger); // never appended
  }
});

// ---------------------------------------------------------------------------
// corrections: the strict
// framing boundary and  register/ledger agreement gate EVERY mutation

import { adjudicationDetail, criterionShaOf, recordDigest, sha256 as libSha256 } from '../scripts/adjudication.lib.mjs';

const FRAME_CRITERION = { id: 'C7', statement: 'a human eyeballs the output once', verification: { method: 'manual' } };
const FRAME_APPROVAL = Buffer.from(JSON.stringify({ approvedBy: 'operator', at: 't', actId: 'act-1', decision: 'APPROVE', sha256: {} }, null, 2) + '\n');

function frameRecord() {
  return {
    type: 'adjudication' as const,
    criterionId: 'C7',
    criterionSha: criterionShaOf(FRAME_CRITERION),
    criterion: FRAME_CRITERION,
    approvalActSha: libSha256(FRAME_APPROVAL),
    headSha: 'a'.repeat(40),
    decision: 'satisfied' as const,
    ruling: 'checked it by hand, output is right',
    by: 'operator',
    at: '2026-08-24T00:00:00.000Z',
  };
}

function frameAuditRow(r: ReturnType<typeof frameRecord>) {
  return { ts: r.at, kind: 'adjudication', round: 0, reviewer: r.by, blockerId: r.criterionId, fingerprint: recordDigest(r), action: 'adjudicated', detail: adjudicationDetail(r), record: r };
}

const VALID_PLAN_ROW = JSON.stringify({ ts: '2026-08-24T00:00:00.000Z', kind: 'plan', round: 1, reviewer: 'codex', blockerId: 'B1', fingerprint: 'a'.repeat(64), action: 'resolved', detail: 'done' });

// every invalid framing: blank line, CRLF, malformed JSON, and a valid
// final JSON record missing its terminating LF
const ILLEGAL_FRAMINGS: Array<[string, string]> = [
  ['blank line', `${VALID_PLAN_ROW}\n\n`],
  ['CRLF', `${VALID_PLAN_ROW}\r\n`],
  ['malformed JSON', '{ torn\n'],
  ['valid record, missing final LF', VALID_PLAN_ROW],
];

test('resolve and grant refuse every invalid framing with zero mutation', async () => {
  for (const [, badLedger] of ILLEGAL_FRAMINGS) {
    const rdir = await workspace({
      'blockers.json': [{ id: 'B1', reviewer: 'codex', fingerprint: 'f'.repeat(64) }],
      'resolutions.json': [{ fingerprint: 'f'.repeat(64), action: 'resolved', detail: 'done' }],
      'ledger.jsonl': badLedger,
    });
    const res = await ledger(rdir, 'resolve', rdir, '--kind', 'plan');
    expect(res.exitCode).toBe(3);
    expect(existsSync(join(rdir, 'blockers.json'))).toBe(true);
    expect(await readFile(join(rdir, 'ledger.jsonl'), 'utf8')).toBe(badLedger);

    const roundsBefore = JSON.stringify({ plan: 0 }, null, 2);
    const gdir = await workspace({ 'ledger.jsonl': badLedger });
    await Bun.write(join(gdir, 'rounds.json'), roundsBefore);
    const g = await ledger(gdir, 'grant', gdir, '--kind', 'plan', '--rounds', '2', '--by', 'operator');
    expect(g.exitCode).toBe(3);
    expect(await readFile(join(gdir, 'rounds.json'), 'utf8')).toBe(roundsBefore);
    expect(await readFile(join(gdir, 'ledger.jsonl'), 'utf8')).toBe(badLedger);
  }
});

test('round refuses every invalid framing before any write', async () => {
  for (const [, badLedger] of ILLEGAL_FRAMINGS) {
    const dir = await workspace({ 'ledger.jsonl': badLedger, 'a.json': verdict('NO_GO', [blocker()]) });
    const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json');
    expect(r.exitCode).toBe(3);
    expect(existsSync(join(dir, 'blockers.json'))).toBe(false);
    expect(await readFile(join(dir, 'ledger.jsonl'), 'utf8')).toBe(badLedger);
  }
});

test('register/ledger divergence in either direction blocks grant, resolve, and round with zero mutation', async () => {
  const rec = frameRecord();
  const registerOnly = { 'adjudications.json': [rec] }; // record never landed in the ledger
  const ledgerOnly = { 'ledger.jsonl': `${JSON.stringify(frameAuditRow(rec))}\n` }; // row without its register record
  for (const divergence of [registerOnly, ledgerOnly]) {
    // grant
    const roundsBefore = JSON.stringify({ plan: 0 }, null, 2);
    const gdir = await workspace(divergence);
    await Bun.write(join(gdir, 'rounds.json'), roundsBefore);
    const ledgerBefore = existsSync(join(gdir, 'ledger.jsonl')) ? await readFile(join(gdir, 'ledger.jsonl'), 'utf8') : undefined;
    const g = await ledger(gdir, 'grant', gdir, '--kind', 'plan', '--rounds', '2', '--by', 'operator');
    expect(g.exitCode).toBe(3);
    expect(g.stderr.length).toBeGreaterThan(0);
    expect(await readFile(join(gdir, 'rounds.json'), 'utf8')).toBe(roundsBefore);
    if (ledgerBefore !== undefined) expect(await readFile(join(gdir, 'ledger.jsonl'), 'utf8')).toBe(ledgerBefore);
    else expect(existsSync(join(gdir, 'ledger.jsonl'))).toBe(false);

    // resolve
    const rdir = await workspace({
      ...divergence,
      'blockers.json': [{ id: 'B1', reviewer: 'codex', fingerprint: 'f'.repeat(64) }],
      'resolutions.json': [{ fingerprint: 'f'.repeat(64), action: 'resolved', detail: 'done' }],
    });
    const res = await ledger(rdir, 'resolve', rdir, '--kind', 'plan');
    expect(res.exitCode).toBe(3);
    expect(existsSync(join(rdir, 'blockers.json'))).toBe(true);

    // round
    const ndir = await workspace({ ...divergence, 'a.json': verdict('NO_GO', [blocker()]) });
    const n = await ledger(ndir, 'round', ndir, '--kind', 'plan', '--verdict', 'codex=a.json');
    expect(n.exitCode).toBe(3);
    expect(existsSync(join(ndir, 'blockers.json'))).toBe(false);
  }
});

test('invalid UTF-8 bytes in the ledger refuse grant and resolve with zero mutation', async () => {
  const { writeFile } = await import('node:fs/promises');
  const badBytes = Buffer.concat([
    Buffer.from('{"ts":"t","kind":"plan","round":1,"reviewer":"codex","blockerId":"B1","fingerprint":"x","action":"resolved","detail":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);

  const roundsBefore = JSON.stringify({ plan: 0 }, null, 2);
  const gdir = await workspace({});
  await writeFile(join(gdir, 'ledger.jsonl'), badBytes);
  await Bun.write(join(gdir, 'rounds.json'), roundsBefore);
  const g = await ledger(gdir, 'grant', gdir, '--kind', 'plan', '--rounds', '2', '--by', 'operator');
  expect(g.exitCode).toBe(3);
  expect(g.stderr).toContain('invalid UTF-8');
  expect(await readFile(join(gdir, 'rounds.json'), 'utf8')).toBe(roundsBefore);
  expect(Buffer.compare(await readFile(join(gdir, 'ledger.jsonl')), badBytes)).toBe(0); // byte-identical

  const rdir = await workspace({
    'blockers.json': [{ id: 'B1', reviewer: 'codex', fingerprint: 'f'.repeat(64) }],
    'resolutions.json': [{ fingerprint: 'f'.repeat(64), action: 'resolved', detail: 'done' }],
  });
  await writeFile(join(rdir, 'ledger.jsonl'), badBytes);
  const r = await ledger(rdir, 'resolve', rdir, '--kind', 'plan');
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('invalid UTF-8');
  expect(existsSync(join(rdir, 'blockers.json'))).toBe(true);
  expect(Buffer.compare(await readFile(join(rdir, 'ledger.jsonl')), badBytes)).toBe(0);
});

// --- convergence window: soft budget → hard cap ---

const resolveAll = async (dir: string, action = 'resolved') => {
  const open = JSON.parse(await readFile(join(dir, 'blockers.json'), 'utf8'));
  await Bun.write(join(dir, 'resolutions.json'), JSON.stringify(open.map((b: { fingerprint: string }) => ({ fingerprint: b.fingerprint, action, detail: 'addressed in plan' }))));
  const r = await ledger(dir, 'resolve', dir, '--kind', 'plan');
  expect(r.exitCode).toBe(0);
};

test('convergence: strictly fewer blockers past the soft cap auto-continues inside the hard cap', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker(), blocker({ id: 'B2', claim: 'init races', evidence: 'src/other.ts — races on init' })]),
  });
  const first = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5');
  expect(first.exitCode).toBe(1); // within soft budget — unchanged
  await resolveAll(dir);

  // round 2 re-raises one of round 1's exact tuples: 2 → 1, no grant owed
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker()])));
  const second = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1', '--cap-max', '5');
  expect(second.exitCode).toBe(1);
  expect(second.stdout).toContain('convergence policy — blockers 2 → 1, round 2 of hard cap 5; review continues without an operator grant');
  const rounds = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'));
  expect(rounds).toEqual({ plan: 2, survivors: { 'plan-1': 2, 'plan-2': 1 } }); // no gate record on a continue
});

test('convergence: an equal count continues only as pure continuation of the previous fingerprints; churn gates durably', async () => {
  // pure continuation: the same exact tuple survives again → continue
  const cont = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(cont, 'round', cont, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5')).exitCode).toBe(1);
  await resolveAll(cont);
  await Bun.write(join(cont, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker()])));
  const c2 = await ledger(cont, 'round', cont, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1', '--cap-max', '5');
  expect(c2.exitCode).toBe(1);
  expect(c2.stdout).toContain('convergence policy — blockers 1 → 1');

  // churn: equal count but a brand-new defect fingerprint → human gate, recorded durably
  const churn = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(churn, 'round', churn, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5')).exitCode).toBe(1);
  await resolveAll(churn);
  await Bun.write(join(churn, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker({ claim: 'init races', evidence: 'src/other.ts — races on init' })])));
  const c3 = await ledger(churn, 'round', churn, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1', '--cap-max', '5');
  expect(c3.exitCode).toBe(2);
  expect(c3.stdout).toContain('blockers held at 1 with new defect fingerprints');
  const rounds = JSON.parse(await readFile(join(churn, 'rounds.json'), 'utf8'));
  expect(rounds.gates.plan).toMatchObject({ round: 2 });
  expect(rounds.gates.plan.reason).toContain('held at 1 with new defect fingerprints');
  expect(existsSync(join(churn, 'blockers.json'))).toBe(true); // the round's evidence still lands
});

test('convergence: a rising blocker count past the soft cap gates with the stall stated', async () => {
  const dir = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5')).exitCode).toBe(1);
  await resolveAll(dir);
  await Bun.write(
    join(dir, 'b.json'),
    JSON.stringify(verdict('NO_GO', [blocker(), blocker({ id: 'B2', claim: 'init races', evidence: 'src/other.ts — races on init' })])),
  );
  const second = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1', '--cap-max', '5');
  expect(second.exitCode).toBe(2);
  expect(second.stdout).toContain('not converging past the soft budget (blockers rose 1 → 2)');
  const gates = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).gates;
  expect(gates.plan).toMatchObject({ round: 2 });
  expect(gates.plan.reason).toContain('blockers rose 1 → 2');
});

test('convergence: an unknowable previous round (pregate bounce or tampered bookkeeping) fails closed', async () => {
  // bounce: the previous consumed unit has no survivors entry and no raised rows
  const bounce = await workspace({ 'rounds.json': { plan: 1 }, 'a.json': verdict('NO_GO', [blocker()]) });
  const b = await ledger(bounce, 'round', bounce, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5');
  expect(b.exitCode).toBe(2);
  expect(b.stdout).toContain("round 1's surviving-blocker record is missing or invalid");

  // tamper: a real round 1 exists, but its survivors value was rewritten to a string
  const tampered = await workspace({ 'a.json': verdict('NO_GO', [blocker()]) });
  expect((await ledger(tampered, 'round', tampered, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5')).exitCode).toBe(1);
  await resolveAll(tampered);
  const rounds = JSON.parse(await readFile(join(tampered, 'rounds.json'), 'utf8'));
  rounds.survivors['plan-1'] = '1';
  await Bun.write(join(tampered, 'rounds.json'), `${JSON.stringify(rounds, null, 2)}\n`);
  await Bun.write(join(tampered, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker()])));
  const t = await ledger(tampered, 'round', tampered, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1', '--cap-max', '5');
  expect(t.exitCode).toBe(2);
  expect(t.stdout).toContain("round 1's surviving-blocker record is missing or invalid");
});

test('convergence: the hard cap stops even a converging review; precedence puts it first', async () => {
  const dir = await workspace({
    'a.json': verdict('NO_GO', [blocker(), blocker({ id: 'B2', claim: 'init races', evidence: 'src/other.ts — races on init' })]),
  });
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '2')).exitCode).toBe(1);
  await resolveAll(dir);
  await Bun.write(join(dir, 'b.json'), JSON.stringify(verdict('NO_GO', [blocker()])));
  expect((await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=b.json', '--cap', '1', '--cap-max', '2')).exitCode).toBe(1); // 2 → 1 inside hard cap
  await resolveAll(dir);
  await Bun.write(join(dir, 'c.json'), JSON.stringify(verdict('NO_GO', [blocker()])));
  const third = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=c.json', '--cap', '1', '--cap-max', '2');
  expect(third.exitCode).toBe(2); // still 1 → 1 converging, but the operator's boundary dominates
  expect(third.stdout).toContain("reached the hard round cap (2/2 consumed) — the operator's safety boundary");
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).gates.plan).toMatchObject({ round: 3 });
});

test('convergence: disagreeing grant records are never consumed by policy', async () => {
  const dir = await workspace({
    'rounds.json': { plan: 2, survivors: { 'plan-1': 2, 'plan-2': 2 }, grants: [{ kind: 'plan', rounds: 1, by: 'x', at: '2026-01-01T00:00:00Z' }] },
    'a.json': verdict('NO_GO', [blocker()]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '9');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('grant records disagree (rounds.json holds 1 grant(s), the ledger holds 0 audit row(s))');
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).gates.plan).toMatchObject({ round: 3 });
});

test('a standing gate re-presents on round, blocks nothing cross-kind, and only its kind\'s grant clears it', async () => {
  const dir = await workspace({
    'rounds.json': { plan: 2, gates: { plan: { round: 2, reason: 'plan review stopped REASON-MARKER' } } },
    'go.json': verdict('GO'),
  });
  // the owed plan gate re-presents verbatim; nothing is written
  const blocked = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=go.json', '--cap', '3');
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stdout).toContain('REASON-MARKER');
  expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false);
  // a diff round is not the plan gate's hostage
  expect((await ledger(dir, 'round', dir, '--kind', 'diff', '--verdict', 'codex=go.json', '--cap', '3')).exitCode).toBe(0);
  // a diff grant leaves the plan gate standing; the plan grant lifts it in the same recorded act
  expect((await ledger(dir, 'grant', dir, '--kind', 'diff', '--rounds', '1', '--by', 'operator')).exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).gates.plan).toMatchObject({ round: 2 });
  expect((await ledger(dir, 'grant', dir, '--kind', 'plan', '--rounds', '1', '--by', 'operator')).exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).gates).toBeUndefined();
});

test('a malformed gate record is illegal durable state: round, grant, and blank/stale shapes all refuse', async () => {
  // blank reason
  const blank = await workspace({
    'rounds.json': { plan: 2, gates: { plan: { round: 2, reason: '' } } },
    'go.json': verdict('GO'),
  });
  const r1 = await ledger(blank, 'round', blank, '--kind', 'plan', '--verdict', 'codex=go.json', '--cap', '3');
  expect(r1.exitCode).toBe(3);
  expect(r1.stderr).toContain('rounds.gates is malformed');
  // a grant must never clear what it cannot validate
  const g1 = await ledger(blank, 'grant', blank, '--kind', 'plan', '--rounds', '1', '--by', 'operator');
  expect(g1.exitCode).toBe(3);
  expect(g1.stderr).toContain('rounds.gates is malformed');
  expect(JSON.parse(await readFile(join(blank, 'rounds.json'), 'utf8')).gates.plan).toEqual({ round: 2, reason: '' }); // untouched

  // gate round disagreeing with the tally is stale state, not authority
  const stale = await workspace({
    'rounds.json': { plan: 3, gates: { plan: { round: 2, reason: 'stale stop' } } },
    'go.json': verdict('GO'),
  });
  const r2 = await ledger(stale, 'round', stale, '--kind', 'plan', '--verdict', 'codex=go.json', '--cap', '5');
  expect(r2.exitCode).toBe(3);
  expect(r2.stderr).toContain('recorded at round 2 but the plan tally is 3');
});

test('a cross-kind exit 2 preserves the other kind\'s owed gate (per-kind slots)', async () => {
  const dir = await workspace({
    'rounds.json': { plan: 2, diff: 3, gates: { plan: { round: 2, reason: 'plan REASON-A' } } },
    'a.json': verdict('NO_GO', [blocker()]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'diff', '--verdict', 'codex=a.json', '--cap', '3');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('diff rounds exhausted');
  const gates = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8')).gates;
  expect(gates.plan).toEqual({ round: 2, reason: 'plan REASON-A' }); // never erased by the diff stop
  expect(gates.diff).toMatchObject({ round: 4 });
});

test('policy consumes only producible rows: incomplete raised or grant rows gate instead of authorizing', async () => {
  // a well-framed but incomplete raised row for the previous round is not evidence
  const skeleton = { kind: 'plan', round: 1, action: 'raised', fingerprint: 'a'.repeat(64) };
  const forged = await workspace({
    'rounds.json': { plan: 1, survivors: { 'plan-1': 1 } },
    'a.json': verdict('NO_GO', [blocker()]),
  });
  await Bun.write(join(forged, 'ledger.jsonl'), `${JSON.stringify(skeleton)}\n`);
  const r = await ledger(forged, 'round', forged, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain("round 1's surviving-blocker record is missing or invalid");

  // a malformed same-kind grant object is ambiguity, never a filtered no-op — and
  // crucially it must never INFLATE the effective budget past its own validation:
  // {kind, rounds} without by/at would satisfy the legacy accounting, so with a
  // hard cap in play only fully producible grants raise any window
  const badGrant = await workspace({
    'rounds.json': { plan: 1, survivors: { 'plan-1': 1 }, grants: [{ kind: 'plan', rounds: 1 }] },
    'a.json': verdict('NO_GO', [blocker()]),
  });
  const g = await ledger(badGrant, 'round', badGrant, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5');
  expect(g.exitCode).toBe(2);
  expect(g.stdout).toContain('plan grant records are malformed');
  expect(JSON.parse(await readFile(join(badGrant, 'rounds.json'), 'utf8')).gates.plan).toMatchObject({ round: 2 });
});

test('a survivors entry without matching raised rows in the ledger gates (bookkeeping alone is not evidence)', async () => {
  const dir = await workspace({
    'rounds.json': { plan: 1, survivors: { 'plan-1': 1 } }, // no ledger at all
    'a.json': verdict('NO_GO', [blocker()]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '5');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain("round 1's surviving-blocker record is missing or invalid");
});

test('reason precedence: the hard cap outranks an unknowable previous round', async () => {
  const dir = await workspace({
    'rounds.json': { plan: 2 }, // two bounces: no survivors, no raised rows — ALSO unknowable
    'a.json': verdict('NO_GO', [blocker()]),
  });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '1', '--cap-max', '2');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('reached the hard round cap (2/2 consumed)');
  expect(r.stdout).not.toContain('missing or invalid');
});

test('legacy exhausted exit 2 (no --cap-max) keeps its message and now records the durable gate', async () => {
  const dir = await workspace({ 'rounds.json': { plan: 3 }, 'a.json': verdict('NO_GO', [blocker()]) });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '3');
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain('plan rounds exhausted (3/3 consumed; another blocker-bearing round would exceed the cap)');
  const rounds = JSON.parse(await readFile(join(dir, 'rounds.json'), 'utf8'));
  expect(rounds.gates.plan).toMatchObject({ round: 4 });
  expect(rounds.gates.plan.reason).toContain('plan rounds exhausted');
});

test('--cap-max below --cap is a usage failure, never a silent reinterpretation', async () => {
  const dir = await workspace({ 'a.json': verdict('GO') });
  const r = await ledger(dir, 'round', dir, '--kind', 'plan', '--verdict', 'codex=a.json', '--cap', '3', '--cap-max', '2');
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('--cap-max must be an integer >= --cap (3)');
});
