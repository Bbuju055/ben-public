import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { approvalHashesFor, criterionShaOf, sha256, recordDigest, adjudicationDetail, validSequencerTask } from '../scripts/adjudication.lib.mjs';

// These tests use a deliberately nonfunctional .git marker and a strict read-only
// Git stub. They never initialize repositories, create commits or launch models.
const root = fileURLToPath(new URL('../', import.meta.url));
const head = 'b'.repeat(40), base = 'a'.repeat(40);
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ben-review-regression-'));
  const repo = join(dir, 'repo'), s = join(repo, '.ben'), bin = join(dir, 'bin'), home = join(dir, 'home');
  for (const p of [s, bin, home]) mkdirSync(p, { recursive: true });
  writeFileSync(join(repo, '.git'), 'Synthetic marker: only the test Git stub handles this directory.\n');
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='-C')a.splice(0,2);
const q=a.join(' ');
if(q==='rev-parse HEAD')console.log('${head}');
else if(q==='rev-list --max-parents=0 HEAD')console.log('${base}');
else if(q==='rev-parse --show-toplevel')console.log(process.env.TEST_REPO);
else if(q==='rev-parse --is-inside-work-tree')console.log('true');
else if(q==='config user.name')console.log('test operator');
else if(q==='cat-file -e ${base}^{commit}'){}
else if(q==='status --porcelain'||q==='diff HEAD'){}
else { console.error('Refused unexpected Git operation: '+q);process.exit(99); }
`, { mode: 0o755 });
  const env = { PATH: bin + ':' + process.env.PATH, HOME: home, TMPDIR: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', TEST_REPO: repo, BEN_RUNNER_HOME: join(dir, 'runner') };
  const task = { sequencerVersion: 1, assignmentId: '12345678-1234-1234-1234-123456789abc', base, repo: { rootCommit: base }, config: { planRounds: 3, diffRounds: 3, planRoundsMax: 9, diffRoundsMax: 9, gateFixes: 2, verifyFixes: 2, timeoutMs: 30000 } };
  expect(validSequencerTask(task)).toBe(true);
  json(join(s, 'task.json'), task);
  const criteria = [{ id: 'C1', statement: 'Check the rendered result', verification: { method: 'manual' } }];
  json(join(s, 'criteria.json'), { taskId: 'test', criteria });
  json(join(s, 'promises.json'), []); json(join(s, 'plan-files.json'), []); json(join(s, 'gates.json'), { test: 'true' });
  writeFileSync(join(s, 'plan.md'), '# Plan\nRender the result.\n');
  const run = (script: string, args: string[] = [], extra = {}) => spawnSync('node', [join(root, 'scripts', script), ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  return { dir, repo, s, env, task, criteria, run };
}
function reviewer(f: ReturnType<typeof fixture>, mode: 'success' | 'exit' | 'timeout') {
  const path = join(f.dir, 'reviewer');
  writeFileSync(path, `#!/usr/bin/env node
const fs=require('node:fs'); const a=process.argv.slice(2);
fs.writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({verdict:'GO',blockers:[]}));
${mode === 'timeout' ? 'setInterval(()=>{},1000);' : `process.exit(${mode === 'exit' ? 1 : 0});`}
`, { mode: 0o755 });
  return path;
}
for (const mode of ['exit', 'timeout', 'success'] as const) test(`review outcome: valid GO with ${mode} preserves process success requirement`, () => {
  const f = fixture();
  const r = f.run('reviewer.mjs', ['plan', f.s, '--repo', f.repo, '--round', '1', '--timeout', '500', '--cli', reviewer(f, mode)]);
  expect(r.status).toBe(mode === 'success' ? 0 : 1);
  const verdictPath = join(f.s, 'reviews/plan-round-1-codex.json');
  if (mode !== 'success') {
    expect(JSON.parse(readFileSync(verdictPath, 'utf8')).type).toBe('reviewer-abstain');
    expect(JSON.parse(readFileSync(verdictPath.replace('.json', '.abstain.txt'), 'utf8')).verdict).toBe('GO');
  }
  // A separate process consumes/replays the saved output, with no reviewer running.
  const ledger = f.run('ledger.mjs', ['round', f.s, '--kind', 'plan', '--verdict', 'codex=reviews/plan-round-1-codex.json']);
  expect(ledger.status).toBe(mode === 'success' ? 0 : 2);
  expect(ledger.stdout).toContain(mode === 'success' ? 'unanimous GO' : 'abstained');
});

test('review outcome: legacy GO raw with an abstention sidecar remains abstained', () => {
  const f = fixture(); mkdirSync(join(f.s, 'reviews'));
  json(join(f.s, 'reviews/plan-round-1-codex.json'), { verdict: 'GO', blockers: [] });
  writeFileSync(join(f.s, 'reviews/plan-round-1-codex.abstain.txt'), 'transport failed');
  const r = f.run('ledger.mjs', ['round', f.s, '--kind', 'plan', '--verdict', 'codex=reviews/plan-round-1-codex.json']);
  expect(r.status).toBe(2); expect(r.stdout).toContain('abstained');
});

test('review outcome: crash before raw sidecar still leaves a non-verdict', () => {
  const f = fixture(); mkdirSync(join(f.s, 'reviews'));
  json(join(f.s, 'reviews/plan-round-1-codex.json'), { type: 'reviewer-abstain', reason: 'failed process' });
  expect(f.run('ledger.mjs', ['round', f.s, '--kind', 'plan', '--verdict', 'codex=reviews/plan-round-1-codex.json']).status).toBe(2);
});

for (const broken of ['missing-directory', 'missing-complete', 'malformed', 'invalid-shape']) test(`runtime pin: ${broken} is preserved until explicit repin`, () => {
  const f = fixture();
  // Terminal task lets explicit repin finish without starting a driver or probe.
  json(join(f.s, 'task.json'), { ...f.task, pr: { url: 'https://example.test/pr/1', headSha: head } });
  const path = join(f.env.BEN_RUNNER_HOME, 'tasks', `${basename(f.repo)}-12345678`, 'runtime.json');
  mkdirSync(dirname(path), { recursive: true });
  const oldDir = join(f.dir, 'old-runtime');
  if (broken === 'missing-complete') mkdirSync(oldDir);
  writeFileSync(path, broken === 'malformed' ? '{broken' : JSON.stringify(broken === 'invalid-shape' ? { dir: 3 } : { dir: oldDir, digest: 'old-runtime', by: 'operator' }));
  const before = readFileSync(path, 'utf8');
  for (const cmd of ['status', 'readiness', 'run', 'resume']) {
    const r = f.run('runner.mjs', [cmd, '--repo', f.repo]);
    expect(r.status).not.toBe(0); expect(r.stderr + r.stdout).toContain('existing runtime pin');
    expect(readFileSync(path, 'utf8')).toBe(before);
  }
  const r = f.run('runner.mjs', ['resume', '--repin', '--repo', f.repo]);
  expect(r.status).toBe(0); expect(r.stdout).toContain('runtime re-pinned');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  expect(after.dir).not.toBe(oldDir); expect(existsSync(join(after.dir, '.complete'))).toBe(true);
  expect(existsSync(join(f.s, 'runner/stretches.jsonl'))).toBe(false);
  const pinned = readFileSync(path, 'utf8');
  expect(f.run('runner.mjs', ['status', '--repo', f.repo]).status).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(pinned);
});

function manualFixture(two = false) {
  const f = fixture();
  if (two) f.criteria.push({ ...f.criteria[0]!, id: 'C2' });
  json(join(f.s, 'criteria.json'), { taskId: 'test', criteria: f.criteria });
  json(join(f.s, 'approval.json'), { approvedBy: 'operator', decision: 'APPROVE', sha256: approvalHashesFor(f.s, f.task) });
  const approvalSha = sha256(readFileSync(join(f.s, 'approval.json')));
  const record = (id = 'C1', decision: 'satisfied' | 'accepted' = 'satisfied', atHead = base) => {
    const criterion = f.criteria.find(c => c.id === id)!;
    return { type: 'adjudication' as const, criterionId: id, criterionSha: criterionShaOf(criterion), criterion, approvalActSha: approvalSha, headSha: atHead, decision, ruling: 'Checked this revision', ...(decision === 'accepted' ? { residual: 'Visual check not repeated' } : {}), by: 'operator', at: '2026-01-01T00:00:00.000Z' };
  };
  const saveRecords = (records: ReturnType<typeof record>[]) => {
    json(join(f.s, 'adjudications.json'), records);
    writeFileSync(join(f.s, 'ledger.jsonl'), records.map(r => JSON.stringify({ ts: r.at, kind: 'adjudication', round: 0, reviewer: r.by, blockerId: r.criterionId, fingerprint: recordDigest(r), action: 'adjudicated', detail: adjudicationDetail(r), record: r }) + '\n').join(''));
  };
  const w = { kind: 'manual-adjudication', owner: 'human', question: 'Check current result', packet: 'manual check', options: [{ token: 'satisfied', label: 'Checked', effect: 'Record check', command: 'answer' }], binding: { criterionIds: f.criteria.map(c => c.id), criteriaSha: sha256(readFileSync(join(f.s, 'criteria.json'))), approvalSha, headSha: head } };
  json(join(f.s, 'waiting.json'), w);writeFileSync(join(f.s, 'WAITING.md'), sha256(readFileSync(join(f.s, 'waiting.json'))));
  const state = () => {
    const p = spawnSync('node', ['--input-type=module', '-e', `import {waitingState} from ${JSON.stringify(join(root, 'scripts/adjudication.lib.mjs'))};console.log(JSON.stringify(waitingState(${JSON.stringify(f.s)},${JSON.stringify(f.repo)})))`], { env: f.env, cwd: f.repo, encoding: 'utf8' });
    expect(p.status).toBe(0);return JSON.parse(p.stdout);
  };
  return { ...f, record, saveRecords, state };
}

test('manual gate: stale satisfied record stays pending and a fresh human answer lands', () => {
  const f = manualFixture();f.saveRecords([f.record()]);
  expect(f.state().state).toBe('current');
  const r = f.run('run.mjs', ['answer', '--repo', f.repo, '--choose', 'satisfied', '--reply', 'Checked the current result', '--by', 'operator']);
  expect(r.status).toBe(0);
  const records = JSON.parse(readFileSync(join(f.s, 'adjudications.json'), 'utf8'));
  expect(records).toHaveLength(2); expect(records[1].headSha).toBe(head);
});

test('manual gate: accepted fallback remains governing when satisfied record is stale', () => {
  const f = manualFixture();f.saveRecords([f.record(), f.record('C1', 'accepted')]);
  expect(f.state().state).toBe('spent');
});

test('manual gate: one answered criterion does not spend a multi-criterion question', () => {
  const f = manualFixture(true);f.saveRecords([f.record('C1', 'satisfied', head), f.record('C2')]);
  expect(f.state().state).toBe('current');
});

test('manual gate: register divergence and invalid records fail closed without an answer', () => {
  const f = manualFixture();f.saveRecords([f.record()]);
  writeFileSync(join(f.s, 'ledger.jsonl'), '');
  expect(f.state().state).toBe('stale');
  const before = readFileSync(join(f.s, 'adjudications.json'), 'utf8');
  expect(f.run('run.mjs', ['answer', '--repo', f.repo, '--choose', 'satisfied', '--reply', 'check', '--by', 'operator']).status).toBe(1);
  expect(readFileSync(join(f.s, 'adjudications.json'), 'utf8')).toBe(before);
  json(join(f.s, 'adjudications.json'), [{}]);expect(f.state().state).toBe('stale');
});

function reviewFixture() {
  const f = fixture();
  json(join(f.s, 'criteria.json'), { taskId: 'test', criteria: [{ id: 'C1', statement: 'Check the result', verification: { method: 'test', command: 'true' } }] });
  return f;
}

test('review replay: failed process parks across sequencer restarts', () => {
  const f = reviewFixture();const cli = reviewer(f, 'exit');
  for (let i = 0; i < 2; i++) {
    const r = f.run('run.mjs', ['next', '--repo', f.repo], { BEN_REVIEWER_CLI: cli });
    expect(r.status).toBe(2);expect(r.stdout).toContain('reviewer');
    expect(JSON.parse(readFileSync(join(f.s, 'waiting.json'), 'utf8')).kind).toBe('review-stop');
    expect(existsSync(join(f.s, 'approval.json'))).toBe(false);
  }
});

test('review replay: legacy dropped-only ledger cannot launder a failed GO', () => {
  const f = reviewFixture();
  expect(f.run('run.mjs', ['next', '--repo', f.repo], { BEN_REVIEWER_CLI: reviewer(f, 'exit') }).status).toBe(2);
  const rows = readFileSync(join(f.s, 'ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.some(row => row.action === 'abstain')).toBe(true);
  writeFileSync(join(f.s, 'ledger.jsonl'), rows.map(row => JSON.stringify({ ...row, action: 'auto-dropped', detail: 'legacy missing evidence' }) + '\n').join(''));
  json(join(f.s, 'reviews/plan-round-1-codex.json'), { verdict: 'GO', blockers: [] });
  const r = f.run('run.mjs', ['next', '--repo', f.repo]);
  expect(r.status).toBe(2);expect(r.stdout).toContain('cannot establish GO');
  expect(existsSync(join(f.s, 'approval.json'))).toBe(false);
});
