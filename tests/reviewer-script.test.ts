import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { chmodSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { git, makeTmpDir } from './helpers';

// scripts/reviewer.mjs — the codex adapter guarantees, restored as a script:
// prompt built from raw artifacts, verdict written by the script's
// hands, unparseable output saved raw and adjudicated as an abstain.

const SCRIPT = fileURLToPath(new URL('../scripts/reviewer.mjs', import.meta.url));

/** A stand-in reviewer CLI: logs its argv, writes a canned response to the -o file. */
async function makeStubCli(dir: string, response: string): Promise<string> {
  const stubJs = join(dir, 'stub.mjs');
  await Bun.write(
    stubJs,
    `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify(args) + '\\n');
const out = args[args.indexOf('-o') + 1];
writeFileSync(out, readFileSync(${JSON.stringify(join(dir, 'response.txt'))}, 'utf8'));
`,
  );
  const wrapper = join(dir, 'stub-cli');
  await Bun.write(wrapper, `#!/bin/sh\nexec node "${stubJs}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  await Bun.write(join(dir, 'response.txt'), response);
  return wrapper;
}

async function workspace(files: Record<string, unknown>): Promise<string> {
  const dir = await makeTmpDir('reviewer-');
  // the complete review authority set is required input; fixtures get
  // valid defaults so each test still exercises only its own concern. Pass null
  // to omit a default.
  const defaults: Record<string, unknown> = {
    'task.json': { config: { e2ePaths: 'src/ui/**', greenfield: false } },
    'plan-files.json': ['src/declared-scope-marker.ts'],
    'gates.json': { test: 'the-gate-command-marker' },
    'plan.md': 'p\n',
    'promises.json': [],
  };
  for (const [name, content] of Object.entries({ ...defaults, ...files })) {
    if (content === null) continue;
    await Bun.write(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function reviewer(dir: string, ...args: string[]): Promise<ExecResult> {
  return execArgv(['node', SCRIPT, ...args], { cwd: dir, timeoutMs: 60_000 });
}

async function calls(stubDir: string): Promise<string[][]> {
  const raw = await readFile(join(stubDir, 'calls.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

const CRITERIA = { taskId: 'T1', criteria: [{ id: 'C1', statement: 'it works', verification: { method: 'test', command: 'x' } }] };
const VERDICT = { verdict: 'NO_GO', blockers: [{ id: 'B1', severity: 'BLOCKER', claim: 'no empty case', evidence: 'src/x.ts', falsifier: 'a test' }] };

test('plan review: prompt is built from raw artifacts and the verdict is written by the script', async () => {
  const dir = await workspace({
    'criteria.json': CRITERIA,
    'plan.md': '# plan\n\nthe secret plan marker\n',
    'promises.json': [{ promise: 'the pinned promise marker', criterionRef: 'C1' }],
  });
  const cli = await makeStubCli(dir, JSON.stringify(VERDICT));

  const r = await reviewer(dir, 'plan', dir, '--round', '1', '--cli', cli);
  expect(r.exitCode).toBe(0);

  const written = JSON.parse(await readFile(join(dir, 'reviews', 'plan-round-1-codex.json'), 'utf8'));
  expect(written.verdict).toBe('NO_GO');

  const [argv] = await calls(dir);
  expect(argv).toContain('read-only'); // reviewers never get write access
  expect(argv).toContain('--output-schema');
  const prompt = argv?.at(-1) ?? '';
  expect(prompt).toContain('the secret plan marker'); // plan text reached the reviewer
  expect(prompt).toContain('"taskId": "T1"'); // criteria reached the reviewer
  expect(prompt).toContain('the pinned promise marker'); // the manifest reached the reviewer
  expect(prompt).toContain('src/declared-scope-marker.ts'); // plan-files.json reached the reviewer
  expect(prompt).toContain('the-gate-command-marker'); // gates.json reached the reviewer
  expect(prompt).toContain('{"e2ePaths":"src/ui/**","greenfield":false}'); // canonical config header
  expect(prompt).toContain('(empty)'); // rendered empty ledger
});

test('plan review: a missing required authority member fails closed (exit 3), never a silently narrower review', async () => {
  const dir = await workspace({ 'criteria.json': CRITERIA, 'plan-files.json': null });
  const cli = await makeStubCli(dir, JSON.stringify(VERDICT));
  const r = await reviewer(dir, 'plan', dir, '--round', '1', '--cli', cli);
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain('plan-files.json unreadable');
  expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false); // the reviewer CLI was never invoked
});

test('single-pass template fill: a literal {{PLAN_FILES}} inside plan.md stays verbatim — inserted artifacts are never rescanned', async () => {
  const dir = await workspace({
    'criteria.json': CRITERIA,
    'plan.md': '# plan\n\nliteral template marker: {{PLAN_FILES}} and {{GATES}}\n',
  });
  const cli = await makeStubCli(dir, JSON.stringify({ verdict: 'GO', blockers: [] }));
  const r = await reviewer(dir, 'plan', dir, '--round', '1', '--cli', cli);
  expect(r.exitCode).toBe(0);
  const [argv] = await calls(dir);
  const prompt = argv?.at(-1) ?? '';
  expect(prompt).toContain('literal template marker: {{PLAN_FILES}} and {{GATES}}'); // untouched bytes
  expect(prompt).toContain('src/declared-scope-marker.ts'); // the real section still filled from the template
});

test('oversized plan-files input is mechanically truncated with a marker — hostile size stays bounded', async () => {
  const huge = JSON.stringify(Array.from({ length: 3000 }, (_, i) => `src/generated/file-${i}.ts`), null, 2);
  const dir = await workspace({ 'criteria.json': CRITERIA, 'plan-files.json': huge });
  const cli = await makeStubCli(dir, JSON.stringify({ verdict: 'GO', blockers: [] }));
  const r = await reviewer(dir, 'plan', dir, '--round', '1', '--cli', cli);
  expect(r.exitCode).toBe(0);
  const [argv] = await calls(dir);
  const prompt = argv?.at(-1) ?? '';
  expect(prompt).toContain('lines omitted — full file at');
});

test('a verdict wrapped in a code fence is still extracted', async () => {
  const dir = await workspace({ 'criteria.json': CRITERIA, 'plan.md': 'p\n', 'promises.json': [] });
  const cli = await makeStubCli(dir, '```json\n' + JSON.stringify({ verdict: 'GO', blockers: [] }) + '\n```\n');
  const r = await reviewer(dir, 'plan', dir, '--round', '1', '--cli', cli);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, 'reviews', 'plan-round-1-codex.json'), 'utf8')).verdict).toBe('GO');
});

test('unparseable output: one retry, then the raw text is saved as the abstain', async () => {
  const dir = await workspace({ 'criteria.json': CRITERIA, 'plan.md': 'p\n', 'promises.json': [] });
  const cli = await makeStubCli(dir, 'I refuse to emit JSON today.');

  const r = await reviewer(dir, 'plan', dir, '--round', '2', '--cli', cli);
  expect(r.exitCode).toBe(1);
  expect((await calls(dir)).length).toBe(2); // exactly one retry
  expect(JSON.parse(await readFile(join(dir, 'reviews', 'plan-round-2-codex.json'), 'utf8')).type).toBe('reviewer-abstain');
  expect(await readFile(join(dir, 'reviews', 'plan-round-2-codex.abstain.txt'), 'utf8')).toContain('I refuse to emit JSON today.');
});

test('diff review: the prompt carries the round-stamped diff, matrix and evidence — raw artifacts only', async () => {
  const dir = await workspace({ 'criteria.json': CRITERIA });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'chore: fixture init');
  const base = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 })).stdout.trim();
  await Bun.write(join(dir, 'fix.md'), 'the committed fix marker\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'fix: the fix');

  await Bun.write(join(dir, 'evidence', 'c1.txt'), 'raw evidence marker\n');
  await Bun.write(
    join(dir, 'evidence', 'criteria-matrix.json'),
    JSON.stringify({ C1: { status: 'pass', evidencePath: join(dir, 'evidence', 'c1.txt') } }),
  );
  const cli = await makeStubCli(dir, JSON.stringify({ verdict: 'GO', blockers: [] }));

  const r = await reviewer(dir, 'diff', dir, '--round', '1', '--base', base, '--cli', cli);
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(dir, 'diff-r1.patch'))).toBe(true);

  const [argv] = await calls(dir);
  const prompt = argv?.at(-1) ?? '';
  expect(prompt).toContain('the committed fix marker'); // the diff itself
  expect(prompt).toContain('criterion C1 (pass)'); // the matrix section
  expect(prompt).toContain('raw evidence marker'); // the evidence file content
  expect(prompt).toContain('p\n'); // the approved plan reached the diff reviewer
  expect(prompt).toContain('src/declared-scope-marker.ts'); // declared scope, as approved
  expect(prompt).toContain('{"e2ePaths":"src/ui/**","greenfield":false}'); // canonical config header
  // behavioral proof of CHANGED_PATHS delivery — parse the section itself,
  // never a marker that also appears in the DIFF section
  const section = prompt.split('## Actually changed paths')[1]?.split('\n## ')[0] ?? '';
  expect(JSON.parse(section.slice(section.indexOf('[')))).toEqual(['fix.md']);
  // the complete round-stamped path-record artifact exists and round-trips
  expect(JSON.parse(await readFile(join(dir, 'changed-paths-r1.json'), 'utf8'))).toEqual(['fix.md']);
});

test('changed-path records are JSON-encoded — two paths are two records, a newline-bearing name is ONE record; the full artifact round-trips exactly', async () => {
  const dir = await workspace({ 'criteria.json': CRITERIA });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'chore: fixture init');
  const base = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 })).stdout.trim();
  await Bun.write(join(dir, 'one.md'), '1\n');
  await Bun.write(join(dir, 'two.md'), '2\n');
  await Bun.write(join(dir, 'src/a\nb.ts'), 'x\n'); // newline-bearing pathname
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feat: hostile and ordinary names');
  await Bun.write(join(dir, 'evidence', 'criteria-matrix.json'), JSON.stringify({}));
  const cli = await makeStubCli(dir, JSON.stringify({ verdict: 'GO', blockers: [] }));

  const r = await reviewer(dir, 'diff', dir, '--round', '1', '--base', base, '--cli', cli);
  expect(r.exitCode).toBe(0);
  const [argv] = await calls(dir);
  const prompt = argv?.at(-1) ?? '';
  const section = prompt.split('## Actually changed paths')[1]?.split('\n## ')[0] ?? '';
  const records = JSON.parse(section.slice(section.indexOf('['))) as string[];
  expect(records).toContain('one.md');
  expect(records).toContain('two.md'); // two ordinary paths, two distinct records
  expect(records).toContain('src/a\nb.ts'); // ONE record despite the embedded newline
  expect(records).toHaveLength(3);
  expect(section).toContain('src/a\\nb.ts'); // the display form is escaped, never an ambiguous raw line break
  // the durable artifact holds the exact same records
  expect(JSON.parse(await readFile(join(dir, 'changed-paths-r1.json'), 'utf8'))).toEqual(records);
});

test('oversized changed-path lists truncate against a complete round-stamped artifact; the next round writes its own file', async () => {
  const dir = await workspace({ 'criteria.json': CRITERIA });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'ben@test.local');
  await git(dir, 'config', 'user.name', 'ben test');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'chore: fixture init');
  const base = (await execArgv(['git', 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 30_000 })).stdout.trim();
  for (let i = 0; i < 300; i++) {
    await Bun.write(join(dir, `src/generated/${'x'.repeat(60)}-${String(i).padStart(3, '0')}.ts`), 'g\n');
  }
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'feat: many files');
  await Bun.write(join(dir, 'evidence', 'criteria-matrix.json'), JSON.stringify({}));
  const cli = await makeStubCli(dir, JSON.stringify({ verdict: 'GO', blockers: [] }));

  expect((await reviewer(dir, 'diff', dir, '--round', '1', '--base', base, '--cli', cli)).exitCode).toBe(0);
  const [argv] = await calls(dir);
  const prompt = argv?.at(-1) ?? '';
  const section = prompt.split('## Actually changed paths')[1]?.split('\n## ')[0] ?? '';
  expect(section).toContain(`full file at ${join(dir, 'changed-paths-r1.json')}`); // the marker names the FULL path-record artifact, not the patch
  const full = JSON.parse(await readFile(join(dir, 'changed-paths-r1.json'), 'utf8')) as string[];
  expect(full).toHaveLength(300);
  const midPath = full[150] ?? '';
  expect(midPath).not.toBe('');
  expect(section).not.toContain(midPath); // truncated out of the prompt…
  expect(full).toContain(midPath); // …but complete in the artifact

  // a second round writes its own artifact — stale rounds cannot masquerade
  expect((await reviewer(dir, 'diff', dir, '--round', '2', '--base', base, '--cli', cli)).exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, 'changed-paths-r2.json'), 'utf8'))).toEqual(full);
  const [, argv2] = await calls(dir);
  const section2 = (argv2?.at(-1) ?? '').split('## Actually changed paths')[1]?.split('\n## ')[0] ?? '';
  expect(section2).toContain('changed-paths-r2.json');
  expect(section2).not.toContain('changed-paths-r1.json');
});

test('canonical config parity: a task carrying hard review caps serializes them into the prompt exactly as the shared lib binds them', async () => {
  const dir = await workspace({
    'criteria.json': CRITERIA,
    'task.json': { config: { e2ePaths: 'src/ui/**', greenfield: false, planRoundsMax: 9, diffRoundsMax: 12 } },
  });
  const cli = await makeStubCli(dir, JSON.stringify({ verdict: 'GO', blockers: [] }));
  expect((await reviewer(dir, 'plan', dir, '--round', '1', '--cli', cli)).exitCode).toBe(0);
  const [argv] = await calls(dir);
  const prompt = argv?.at(-1) ?? '';
  // byte-match against adjudication.lib.mjs canonicalConfig (same keys, same order)
  const { canonicalConfig } = await import('../scripts/adjudication.lib.mjs');
  expect(prompt).toContain(canonicalConfig({ config: { e2ePaths: 'src/ui/**', greenfield: false, planRoundsMax: 9, diffRoundsMax: 12 } }));
  expect(prompt).toContain('{"e2ePaths":"src/ui/**","greenfield":false,"planRoundsMax":9,"diffRoundsMax":12}');
});
