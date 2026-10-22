#!/usr/bin/env node
// Real sequencer/referees; scripted reviewer, implementer, and operator.
// No remote is configured. All commits and evidence stay in a fresh temp repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runScript = fileURLToPath(new URL('../../scripts/run.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'ben-offline-'));
const repo = join(root, 'repo');
const home = join(root, 'home');
const state = join(repo, '.ben');
mkdirSync(repo);
mkdirSync(home);
const reviewer = join(root, 'reviewer.mjs');
copyFileSync(fileURLToPath(new URL('./reviewer.mjs', import.meta.url)), reviewer);
chmodSync(reviewer, 0o755);
const env = {
  PATH: process.env.PATH, HOME: home, TMPDIR: root,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  BEN_HOME: join(home, 'ben'), BEN_REVIEWER_CLI: reviewer,
};
const transcript = join(root, 'transcript.txt');
function command(executable, args, expected = 0) {
  const result = spawnSync(executable, args, { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
  appendFileSync(transcript, `$ ${[executable, ...args].join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit: ${result.status}\n\n`);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const git = (...args) => command('git', args);
const ben = (args, expected = 0) => command(process.execPath, [runScript, ...args, '--repo', repo], expected);
const read = name => JSON.parse(readFileSync(join(state, name), 'utf8'));
const json = (name, value) => writeFileSync(join(state, name), `${JSON.stringify(value, null, 2)}\n`);
function commit(message) { git('add', '.'); git('commit', '-qm', message); }
function implement(expression, message) {
  writeFileSync(join(repo, 'subtract.mjs'), `export const subtract = (a, b) => ${expression};\n`);
  commit(message);
}

console.log('Offline example: real checks; scripted reviewer and simulated operator decisions.');
console.log('Task: subtract two numbers, including zero and negative results.');
git('init', '-q', '-b', 'example');
git('config', 'user.name', 'Example Operator');
git('config', 'user.email', 'example@example.invalid');
writeFileSync(join(repo, '.gitignore'), '.ben/\n');
writeFileSync(join(repo, 'README.md'), '# Synthetic subtraction fixture\n');
commit('chore: initialize example');
ben(['init', '--title', 'Implement subtraction', '--gate-fixes', '1']);
writeFileSync(join(state, 'brief.md'), 'Implement subtraction for positive, zero, and negative results.\n');
writeFileSync(join(state, 'plan.md'), '# Subtraction\n\nImplement subtract(a, b) and test positive, zero, and negative results per brief.md.\n');
json('criteria.json', { taskId: 'offline-example', criteria: [{
  id: 'C1', statement: 'Subtraction returns 3 for (5,2), 0 for (0,0), and -3 for (2,5).',
  verification: { method: 'test', command: 'node --test subtract.test.mjs' },
}] });
json('promises.json', []);
json('plan-files.json', ['subtract.mjs', 'subtract.test.mjs']);
json('gates.json', { test: 'node --test subtract.test.mjs' });

const packet = ben(['next'], 2);
assert.match(packet, /APPROVE BUILD/);
assert.equal(read('waiting.json').kind, 'approval');
console.log('Plan: scripted GO; real sequencer parks for approval.');
ben(['answer', '--choose', 'approve', '--by', 'example-operator']);
assert.equal(Object.keys(read('approval.json').sha256).length, 6);
console.log('Simulated operator: approve. Recorded against six artifact/config hashes.');

writeFileSync(join(repo, 'subtract.test.mjs'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtract } from './subtract.mjs';
for (const [a, b, expected] of [[5, 2, 3], [0, 0, 0], [2, 5, -3]]) {
  test(a + ' minus ' + b, () => assert.equal(subtract(a, b), expected));
}
`);
implement('a + b', 'feat: deliberately incorrect subtraction');
assert.match(ben(['next'], 1), /Gates failed/);
assert.equal(read('task.json').prIntent, undefined);
assert.match(readFileSync(join(state, 'evidence/gate-test-r1.txt'), 'utf8'), /ERR_ASSERTION/);
console.log('Attempt 1: addition instead of subtraction. Gate fails; no PR intent.');

implement('a - b + 1', 'fix: deliberately incomplete repair');
ben(['next'], 2);
assert.equal(read('waiting.json').kind, 'fix-cap');
assert.equal(read('task.json').prIntent, undefined);
console.log('Attempt 2: off-by-one repair. Gate fails; allowance exhausted; human decision required.');
ben(['answer', '--choose', 'continue', '--by', 'example-operator']);
console.log('Simulated operator: allow one more attempt through the recorded answer operation.');

implement('a - b', 'fix: subtract correctly');
const final = ben(['next']);
assert.match(final, /gh pr create/);
assert.equal(read('evidence/criteria-matrix.json').C1.status, 'pass');
const task = read('task.json');
assert.equal(task.prIntent.headSha, git('rev-parse', 'HEAD').trim());
assert.equal(task.pr, undefined);
assert.equal(git('remote').trim(), '');
assert.equal(git('status', '--porcelain').trim(), '');
assert.match(readFileSync(join(state, 'pr-body.md'), 'utf8'), /Subtraction returns/);
console.log('Final: all three cases pass; scripted diff GO; local PR body and intent generated.');
console.log('Nothing published. No model calls. No live runner acceptance claimed.');
console.log(`Inspect raw commands, failure evidence, decisions, and PR body: ${root}`);
