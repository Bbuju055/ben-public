import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTmpDir } from './helpers';

// scripts/stop-hook.mjs + install-hooks.mjs — optional turn-end enforcement,
// modelled on unlazy: unmet work blocks the stop; an honest abandon line releases it.

const HOOK = fileURLToPath(new URL('../scripts/stop-hook.mjs', import.meta.url));
const INSTALLER = fileURLToPath(new URL('../scripts/install-hooks.mjs', import.meta.url));

async function workspace(files: Record<string, unknown> = {}): Promise<string> {
  const dir = await makeTmpDir('stophook-');
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, '.ben', name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

async function hook(dir: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(['node', HOOK], {
    cwd: dir,
    stdin: Buffer.from(JSON.stringify({ cwd: dir })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
}

function decision(stdout: string): Record<string, unknown> {
  return stdout.trim() === '' ? {} : JSON.parse(stdout.trim());
}

const matrix = (statuses: Record<string, string>) =>
  Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, evidencePath: 'x' }]));

test('no ben state allows the stop', async () => {
  const dir = await makeTmpDir('stophook-none-');
  const r = await hook(dir);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('');
});

test('an open blocker blocks the stop', async () => {
  const dir = await workspace({ 'blockers.json': [{ fingerprint: 'fp1' }] });
  const d = decision((await hook(dir)).stdout);
  expect(d.decision).toBe('block');
  expect(String(d.reason)).toContain('1 open blocker(s) await reconcile');
});

test('failing criteria block the stop', async () => {
  const dir = await workspace({ 'evidence/criteria-matrix.json': matrix({ C1: 'pass', C2: 'fail' }) });
  const d = decision((await hook(dir)).stdout);
  expect(d.decision).toBe('block');
  expect(String(d.reason)).toContain('criteria failing: C2');
});

test('an approved build with no verification blocks the stop', async () => {
  const dir = await workspace({ 'approval.json': { approvedBy: 'operator' } });
  const d = decision((await hook(dir)).stdout);
  expect(d.decision).toBe('block');
  expect(String(d.reason)).toContain('never verified');
});

test('a green matrix with manual criteria allows the stop — manual never blocks', async () => {
  const dir = await workspace({
    'approval.json': { approvedBy: 'operator' },
    'evidence/criteria-matrix.json': matrix({ C1: 'pass', C2: 'manual' }),
  });
  const r = await hook(dir);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe('');
});

test('an honest ABANDON.md releases the stop and is surfaced, never silent', async () => {
  const dir = await workspace({
    'blockers.json': [{ fingerprint: 'fp1' }],
    'ABANDON.md': 'abandoning: reviewer disagreement needs a human ruling\n',
  });
  const r = await hook(dir);
  expect(r.exitCode).toBe(0);
  const d = decision(r.stdout);
  expect(d.decision).toBeUndefined();
  expect(String(d.systemMessage)).toContain('released by ABANDON.md — abandoning: reviewer disagreement needs a human ruling');
});

test('no progress across six blocks releases with a warning instead of trapping', async () => {
  const dir = await workspace({ 'blockers.json': [{ fingerprint: 'fp1' }] });
  for (let i = 0; i < 6; i++) {
    expect(decision((await hook(dir)).stdout).decision).toBe('block');
  }
  const seventh = decision((await hook(dir)).stdout);
  expect(seventh.decision).toBeUndefined();
  expect(String(seventh.systemMessage)).toContain('releasing after 6 blocks without progress');
});

test('progress resets the block counter', async () => {
  const dir = await workspace({ 'blockers.json': [{ fingerprint: 'fp1' }] });
  for (let i = 0; i < 6; i++) await hook(dir);
  // state changed → a fresh streak, still blocking
  await Bun.write(join(dir, '.ben', 'blockers.json'), JSON.stringify([{ fingerprint: 'fp2' }]));
  expect(decision((await hook(dir)).stdout).decision).toBe('block');
});

test('installer registers the hook, is idempotent, and uninstalls cleanly', async () => {
  const dir = await makeTmpDir('stophook-install-');
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(['node', INSTALLER, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: await proc.exited, stdout };
  };

  const install = await run();
  expect(install.exitCode).toBe(0);
  const target = join(dir, '.claude', 'settings.local.json');
  const settings = JSON.parse(await readFile(target, 'utf8'));
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.Stop[0].hooks[0].command).toContain('stop-hook.mjs');

  const again = await run();
  expect(again.stdout).toContain('Already installed');
  expect(JSON.parse(await readFile(target, 'utf8')).hooks.Stop).toHaveLength(1);

  const remove = await run('--uninstall');
  expect(remove.exitCode).toBe(0);
  expect(JSON.parse(await readFile(target, 'utf8')).hooks).toBeUndefined();
});
