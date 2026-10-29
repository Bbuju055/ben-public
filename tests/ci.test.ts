import { expect, test } from 'bun:test';
import { ciTarget, collectCi, ciForStatus } from '../scripts/ci.lib.mjs';
import fixture from './fixtures/ci.json';

const target = { repo: 'o/r', number: 7, prUrl: fixture.pr.html_url, reviewedSha: fixture.pr.head.sha };
const OTHER = 'b'.repeat(40);
const AT = '2026-10-29T12:00:00.000Z';
function setup() {
  const f = structuredClone(fixture);
  const requests: string[] = [];
  const get = (path: string) => {
    requests.push(path);
    if (path.endsWith('/pulls/7')) return f.pr;
    if (path.includes('/check-runs?')) return f.checks;
    if (path.includes('/status?')) return f.statuses;
    throw new Error(`Unexpected fixture request ${path}`);
  };
  return { f, get, requests, collect: () => collectCi(target, get, () => AT) };
}

test('CI: exact reviewed SHA, source URLs and observation time; no branch/ref queries', () => {
  const s = setup();
  const result = s.collect();
  expect(result).toMatchObject({ state: 'passed', observedAt: AT, reviewedSha: target.reviewedSha, observedHeadSha: target.reviewedSha });
  expect(result.checks.map(c => c.state)).toEqual(['passed', 'passed']);
  expect(result.sources).toHaveLength(3);
  expect(s.requests).toEqual([
    'repos/o/r/pulls/7', `repos/o/r/commits/${target.reviewedSha}/check-runs?filter=all&per_page=100&page=1`,
    `repos/o/r/commits/${target.reviewedSha}/status?per_page=100&page=1`, 'repos/o/r/pulls/7',
  ]);
  expect(ciForStatus(result, target, target.reviewedSha).state).toBe('passed');
});

for (const [conclusion, state] of [['success', 'passed'], ['failure', 'failed'], ['timed_out', 'failed'], ['action_required', 'failed'], ['cancelled', 'cancelled'], ['skipped', 'unknown'], ['neutral', 'unknown'], ['stale', 'unknown'], ['new-result', 'unknown'], ['constructor', 'unknown']] as const) {
  test(`CI: check conclusion ${conclusion} maps to ${state} alongside passing statuses`, () => {
    const s = setup();
    s.f.checks.check_runs[0]!.conclusion = conclusion!;
    expect(s.collect().state).toBe(state);
  });
}

test('CI: pending rerun supersedes success only within its app/suite/name; other suites cannot hide failures', () => {
  const s = setup();
  s.f.checks.check_runs.push({ ...s.f.checks.check_runs[0]!, id: 101, status: 'in_progress', conclusion: '' });
  s.f.checks.total_count = 2;
  expect(s.collect().state).toBe('pending');
  s.f.checks.check_runs[1]!.status = 'completed';
  s.f.checks.check_runs[1]!.conclusion = 'success';
  s.f.checks.check_runs[0]!.conclusion = 'failure';
  expect(s.collect().state).toBe('passed');
  s.f.checks.check_runs[1]!.check_suite = { id: 11 };
  expect(s.collect().state).toBe('failed');
});

for (const [value, state] of [['pending', 'pending'], ['failure', 'failed'], ['error', 'failed'], ['unrecognized', 'unknown'], ['__proto__', 'unknown']] as const) {
  test(`CI: latest status ${value} is not masked by a passing check`, () => {
    const s = setup();
    s.f.statuses.statuses[0]!.state = value!;
    expect(s.collect().state).toBe(state);
  });
}

test('CI: empty, unavailable, malformed and wrong-SHA responses never pass', () => {
  const s = setup();
  s.f.checks = { total_count: 0, check_runs: [] };
  s.f.statuses = { ...s.f.statuses, total_count: 0, statuses: [] };
  expect(s.collect()).toMatchObject({ state: 'unknown', checks: [] });
  for (const field of ['check', 'status', 'pr']) {
    const bad = setup();
    if (field === 'check') bad.f.checks.check_runs[0]!.head_sha = OTHER;
    if (field === 'status') bad.f.statuses.sha = OTHER;
    if (field === 'pr') bad.f.pr.head.sha = OTHER;
    expect(bad.collect().state).toBe('unknown');
  }
  for (const pathPart of ['/pulls/', '/check-runs?', '/status?']) {
    expect(collectCi(target, path => {
      if (path.includes(pathPart)) throw new Error('API unavailable');
      return setup().get(path);
    }).state).toBe('unknown');
  }
  expect(collectCi(target, () => ({})).state).toBe('unknown');
});

test('CI: a PR head change during observation invalidates passing results; old cache cannot bind to new targets', () => {
  const s = setup();
  let heads = 0;
  const moved = collectCi(target, path => path.endsWith('/pulls/7') && ++heads === 2 ? { ...s.f.pr, head: { sha: OTHER } } : s.get(path));
  expect(moved).toMatchObject({ state: 'unknown', observedHeadSha: OTHER });
  const good = s.collect();
  expect(ciForStatus(good, { ...target, reviewedSha: OTHER }, OTHER).state).toBe('unknown');
  expect(ciForStatus(good, { ...target, prUrl: 'https://github.com/o/r/pull/8' }, target.reviewedSha).state).toBe('unknown');
  expect(ciForStatus(good, target, OTHER).state).toBe('unknown');
  expect(ciForStatus({ type: 'torn' }, target, target.reviewedSha).state).toBe('unknown');
  expect(ciForStatus(undefined, target, target.reviewedSha).state).toBe('unknown');
  expect(ciForStatus({ ...good, checks: [] }, target, target.reviewedSha).state).toBe('unknown');
  expect(ciForStatus({ ...good, checks: [null] }, target, target.reviewedSha).state).toBe('unknown');
});

test('CI: pagination includes late failures in both APIs, refuses truncation, count drift and duplicate rows', () => {
  for (const kind of ['checks', 'statuses'] as const) {
    const s = setup();
    const rows = Array.from({ length: 101 }, (_, i) => kind === 'checks'
      ? { ...s.f.checks.check_runs[0]!, id: i + 1, name: `job-${i}`, conclusion: i === 100 ? 'failure' : 'success' }
      : { ...s.f.statuses.statuses[0]!, id: i + 1, context: `context-${i}`, state: i === 100 ? 'failure' : 'success' });
    const get = (path: string) => {
      if (!path.includes(kind === 'checks' ? '/check-runs?' : '/status?')) return s.get(path);
      const page = Number(new URL(`https://api.github.com/${path}`).searchParams.get('page'));
      return { sha: target.reviewedSha, total_count: 101, [kind === 'checks' ? 'check_runs' : 'statuses']: rows.slice((page - 1) * 100, page * 100) };
    };
    expect(collectCi(target, get).state).toBe('failed');
    expect(collectCi(target, path => path.endsWith('page=2') ? {} : get(path)).state).toBe('unknown');
    expect(collectCi(target, path => path.endsWith('page=2') ? { ...get(path), total_count: 102 } : get(path)).state).toBe('unknown');
    rows[100] = rows[0]!;
    expect(collectCi(target, get).state).toBe('unknown');
  }
});

test('CI: oversized or incomplete result sets are unknown; target is a recorded PR, not an arbitrary URL', () => {
  const s = setup();
  s.f.checks.total_count = 2;
  expect(s.collect().state).toBe('unknown');
  let pages = 0;
  const result = collectCi(target, path => {
    if (!path.includes('/check-runs?')) return s.get(path);
    const page = ++pages;
    return { total_count: 2001, check_runs: Array.from({ length: 100 }, (_, i) => ({ ...fixture.checks.check_runs[0], id: page * 100 + i })) };
  });
  expect(result.state).toBe('unknown');
  expect(pages).toBe(20);
  expect(ciTarget({ pr: { url: target.prUrl, headSha: target.reviewedSha } })).toEqual(target);
  expect(ciTarget({ pr: { url: 'https://attacker.test/o/r/pull/7', headSha: target.reviewedSha } })).toBeUndefined();
  expect(ciTarget({ pr: { url: target.prUrl, headSha: 'main' } })).toBeUndefined();
  expect(ciTarget({ pr: { url: target.prUrl, headSha: target.reviewedSha }, assignment: { publication: { repo: 'other/repo' } } })).toBeUndefined();
});
