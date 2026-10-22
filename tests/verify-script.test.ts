import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { git, makeTmpDir } from './helpers';

// scripts/verify.mjs — verification, ported from machine.ts
// gates()/verify()/implement() and src/gates/{deterministic,criteria,evidence}.ts.

const SCRIPT = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));

async function workspace(files: Record<string, unknown> = {}): Promise<string> {
  const dir = await makeTmpDir('verify-');
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function verify(dir: string, ...args: string[]): Promise<ExecResult> {
  return execArgv(['node', SCRIPT, ...args], { cwd: dir, timeoutMs: 60_000 });
}

const criterion = (id: string, command: string | undefined, method = 'command') => ({
  id,
  statement: `criterion ${id} holds`,
  verification: command === undefined ? { method } : { method, command },
});

test('one passing and one failing gate: Gates failed with raw evidence, then escalation past the cap', async () => {
  const dir = await workspace({ 'gates.json': { ok: 'true', bad: 'false' } });

  const first = await verify(dir, 'gates', dir, '--cap', '1');
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toStartWith('Gates failed — raw evidence below');
  expect(first.stdout).toContain('### gate: bad (exit 1)');
  expect(first.stdout).not.toContain('### gate: ok'); // green gates send no evidence back
  expect(existsSync(join(dir, 'evidence', 'gate-ok-r1.txt'))).toBe(true);
  expect(await readFile(join(dir, 'evidence', 'gate-bad-r1.txt'), 'utf8')).toStartWith('$ false\nexit: 1');

  // cap 1: the second red run exceeds it — human decision
  const second = await verify(dir, 'gates', dir, '--cap', '1');
  expect(second.exitCode).toBe(2);
  expect(second.stdout).toContain('gates still red after 1 fix attempts: bad');
});

test('all gates green exits 0', async () => {
  const dir = await workspace({ 'gates.json': { ok: 'true', also: 'echo fine' } });
  const r = await verify(dir, 'gates', dir);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('2 gate(s) green');
});

test('evidence is round-stamped — a fix attempt never overwrites the evidence of the failure', async () => {
  const dir = await workspace({ 'gates.json': { bad: 'echo attempt-output && false' } });
  await verify(dir, 'gates', dir);
  await verify(dir, 'gates', dir);
  // both rounds on disk, distinct files
  expect(existsSync(join(dir, 'evidence', 'gate-bad-r1.txt'))).toBe(true);
  expect(existsSync(join(dir, 'evidence', 'gate-bad-r2.txt'))).toBe(true);
});

test('criteria red: Criteria failed with raw evidence and criteria-matrix.json, then escalation past the cap', async () => {
  const dir = await workspace({
    'criteria.json': { taskId: 'T1', criteria: [criterion('C1', 'true'), criterion('C2', 'echo boom && false')] },
  });

  const first = await verify(dir, 'criteria', dir, '--cap', '1');
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toStartWith('Criteria failed — raw evidence below');
  expect(first.stdout).toContain('### criterion C2 FAILED');
  expect(first.stdout).toContain('boom');
  const matrix = JSON.parse(await readFile(join(dir, 'evidence', 'criteria-matrix.json'), 'utf8'));
  expect(matrix.C1.status).toBe('pass');
  expect(matrix.C2.status).toBe('fail');

  const second = await verify(dir, 'criteria', dir, '--cap', '1');
  expect(second.exitCode).toBe(2);
  expect(second.stdout).toContain('criteria still failing after 1 fix attempts: C2');
});

test('manual criteria never auto-pass and never auto-fail — reported for a human check', async () => {
  const dir = await workspace({
    'criteria.json': { taskId: 'T1', criteria: [criterion('C1', 'true'), criterion('C2', undefined, 'manual')] },
  });
  const r = await verify(dir, 'criteria', dir);
  expect(r.exitCode).toBe(0); // manual does not fail the run…
  expect(r.stdout).toContain('1 manual (human check before merge: C2)'); // …but is never silently a pass
  const matrix = JSON.parse(await readFile(join(dir, 'evidence', 'criteria-matrix.json'), 'utf8'));
  expect(matrix.C2.status).toBe('manual');
  expect(await readFile(matrix.C2.evidencePath, 'utf8')).toContain('MANUAL criterion — requires a human check');
});

test('a non-manual criterion with no command fails', async () => {
  const dir = await workspace({ 'criteria.json': { taskId: 'T1', criteria: [criterion('C1', undefined)] } });
  const r = await verify(dir, 'criteria', dir);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('FAIL: criterion has method "command" but no command.');
});

test('an e2e criterion runs as a self-contained command', async () => {
  const dir = await workspace({ 'criteria.json': { taskId: 'T1', criteria: [criterion('C1', 'true', 'e2e')] } });
  const r = await verify(dir, 'criteria', dir);
  expect(r.exitCode).toBe(0);
});

test('oversized evidence is truncated mechanically with a marker; the full file stays on disk', async () => {
  const dir = await workspace({ 'gates.json': { noisy: 'seq 5000 && false' } });
  const r = await verify(dir, 'gates', dir);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('lines omitted — full file at');
  const full = await readFile(join(dir, 'evidence', 'gate-noisy-r1.txt'), 'utf8');
  expect(full).toContain('\n4999\n5000'); // untruncated on disk
});

// --- scope: e2e applicability re-derived from the ACTUAL diff  ---

/** Git repo with one base commit; returns [dir, baseSha]. */
async function repoFixture(files: Record<string, unknown> = {}): Promise<[string, string]> {
  const dir = await workspace({ 'seed.md': 'seed\n', ...files });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'chore: fixture init');
  const base = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 })).stdout.trim();
  return [dir, base];
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-m', message);
}

const CRIT_NO_E2E = { taskId: 'T1', criteria: [criterion('C1', 'true')] };
const CRIT_WITH_E2E = { taskId: 'T1', criteria: [criterion('C1', 'true'), criterion('C2', 'true', 'e2e')] };

test('actual-diff scope: the actual diff touches UI with no e2e criterion — red with evidence, escalation past the cap, green once an e2e criterion exists', async () => {
  const [dir, base] = await repoFixture({ 'criteria.json': CRIT_NO_E2E });
  await Bun.write(join(dir, 'src/ui/App.tsx'), 'ui\n');
  await commitAll(dir, 'feat: touch ui');

  // an empty/narrow plan-files declaration is irrelevant here BY DESIGN: scope
  // never reads plan-files.json — the declaration cannot suppress what the diff proves
  const first = await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**', '--cap', '1');
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toStartWith('Scope failed — the actual diff touches e2e paths but the criteria carry no e2e criterion');
  expect(first.stdout).toContain('src/ui/App.tsx');
  expect(await readFile(join(dir, 'evidence', 'scope-r1.txt'), 'utf8')).toContain('src/ui/App.tsx');

  const second = await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**', '--cap', '1');
  expect(second.exitCode).toBe(2);
  expect(second.stdout).toContain('scope still failing after 1 fix attempts');
  expect(existsSync(join(dir, 'evidence', 'scope-r2.txt'))).toBe(true); // round-stamped, never overwritten

  await Bun.write(join(dir, 'criteria.json'), JSON.stringify(CRIT_WITH_E2E, null, 2));
  const green = await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**', '--cap', '1');
  expect(green.exitCode).toBe(0);
  expect(green.stdout).toContain('match e2e globs and an e2e criterion is present');
});

test('scope green: UI diff with a matching e2e criterion; non-UI diffs (tests, docs, lockfile) need nothing', async () => {
  const [dir, base] = await repoFixture({ 'criteria.json': CRIT_WITH_E2E });
  await Bun.write(join(dir, 'src/ui/App.tsx'), 'ui\n');
  await commitAll(dir, 'feat: ui with e2e');
  expect((await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**')).exitCode).toBe(0);

  const [dir2, base2] = await repoFixture({ 'criteria.json': CRIT_NO_E2E });
  await Bun.write(join(dir2, 'src/lib/x.test.ts'), 't\n');
  await Bun.write(join(dir2, 'docs/notes.md'), 'd\n');
  await Bun.write(join(dir2, 'bun.lock'), 'l\n');
  await commitAll(dir2, 'chore: incidental');
  const r = await verify(dir2, 'scope', dir2, '--base', base2, '--e2e-paths', 'src/ui/**');
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('none match e2e globs');
});

test('rename and deletion: a UI file renamed away or deleted is still a UI change (--no-renames lists both sides)', async () => {
  const [dir, base] = await repoFixture({ 'criteria.json': CRIT_NO_E2E, 'src/ui/A.tsx': 'ui component with enough content for rename detection\n' });
  // identical bytes at the new path + deletion of the old = a detected rename
  // at diff time (this is exactly the case where plain --name-only hides src/ui/A.tsx)
  await Bun.write(join(dir, 'src/server/A.ts'), 'ui component with enough content for rename detection\n');
  await git(dir, 'rm', '-q', 'src/ui/A.tsx');
  await commitAll(dir, 'refactor: move out of ui');
  const renamed = await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**');
  expect(renamed.exitCode).toBe(1);
  expect(renamed.stdout).toContain('src/ui/A.tsx'); // the OLD side, visible only via --no-renames

  const [dir2, base2] = await repoFixture({ 'criteria.json': CRIT_NO_E2E, 'src/ui/B.tsx': 'ui\n' });
  await git(dir2, 'rm', '-q', 'src/ui/B.tsx');
  await commitAll(dir2, 'feat: remove ui');
  expect((await verify(dir2, 'scope', dir2, '--base', base2, '--e2e-paths', 'src/ui/**')).exitCode).toBe(1);
});

test('no implementation diff is trivially green; no configured e2e paths makes the check inert', async () => {
  const [dir, base] = await repoFixture({ 'criteria.json': CRIT_NO_E2E });
  const empty = await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**');
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).toContain('0 changed path(s)');

  await Bun.write(join(dir, 'src/ui/App.tsx'), 'ui\n');
  await commitAll(dir, 'feat: ui');
  const inert = await verify(dir, 'scope', dir, '--base', base);
  expect(inert.exitCode).toBe(0);
  expect(inert.stdout).toContain('scope inert — no e2e paths configured');
});

test('a newline-bearing filename under an e2e ** glob triggers applicability; a non-matching newline name does not false-positive', async () => {
  const [dir, base] = await repoFixture({ 'criteria.json': CRIT_NO_E2E });
  await Bun.write(join(dir, 'src/ui/a\nb.tsx'), 'ui\n'); // legal POSIX pathname
  await commitAll(dir, 'feat: hostile newline name');
  const red = await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**');
  expect(red.exitCode).toBe(1); // ** spans the newline (dotAll)
  expect(await readFile(join(dir, 'evidence', 'scope-r1.txt'), 'utf8')).toContain('src/ui/a\nb.tsx');

  const [dir2, base2] = await repoFixture({ 'criteria.json': CRIT_NO_E2E });
  await Bun.write(join(dir2, 'docs/x\ny.md'), 'd\n');
  await commitAll(dir2, 'docs: newline name outside ui');
  expect((await verify(dir2, 'scope', dir2, '--base', base2, '--e2e-paths', 'src/ui/**')).exitCode).toBe(0);
});

test('byte-safe path records: spaces, quotes and non-ASCII names match exactly (-z, no core.quotePath mangling)', async () => {
  const [dir, base] = await repoFixture({ 'criteria.json': CRIT_NO_E2E });
  await Bun.write(join(dir, 'src/ui/a b.tsx'), 'ui\n');
  await Bun.write(join(dir, 'src/ui/qu"ote.tsx'), 'ui\n');
  await Bun.write(join(dir, 'src/ui/ä.tsx'), 'ui\n');
  await commitAll(dir, 'feat: hostile names');
  const r = await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/ui/**');
  expect(r.exitCode).toBe(1);
  const evidence = await readFile(join(dir, 'evidence', 'scope-r1.txt'), 'utf8');
  expect(evidence).toContain('src/ui/a b.tsx');
  expect(evidence).toContain('src/ui/qu"ote.tsx');
  expect(evidence).toContain('src/ui/ä.tsx');
  expect(evidence).not.toContain('\\303'); // no C-quoted octal mangling
});

test('glob semantics match pregate: "*" does not span "/", "**" does; "./"-prefixed globs are normalized', async () => {
  const [dir, base] = await repoFixture({ 'criteria.json': CRIT_NO_E2E });
  await Bun.write(join(dir, 'src/sub/deep.ts'), 'x\n');
  await commitAll(dir, 'feat: deep');
  expect((await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/*.ts')).exitCode).toBe(0); // * stops at /
  expect((await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', 'src/**')).exitCode).toBe(1); // ** spans
  expect((await verify(dir, 'scope', dir, '--base', base, '--e2e-paths', './src/**')).exitCode).toBe(1); // normalized
});

test('zero commits is a failure — You finished without committing anything — escalating on the second offense', async () => {
  const dir = await workspace({ 'seed.md': 'seed\n' });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'chore: fixture init');
  const base = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 })).stdout.trim();

  const first = await verify(dir, 'commits', dir, '--since', base);
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toContain('You finished without committing anything. Implement the plan and commit your changes.');

  const second = await verify(dir, 'commits', dir, '--since', base);
  expect(second.exitCode).toBe(2);
  expect(second.stdout).toContain('implementer produced no commits after two attempts');

  await Bun.write(join(dir, 'work.md'), 'the work\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feat: the work');
  const third = await verify(dir, 'commits', dir, '--since', base);
  expect(third.exitCode).toBe(0);
  expect(third.stdout).toContain('1 commit(s) since');
});
