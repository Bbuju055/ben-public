// Informational GitHub observations only. Never consumed by the sequencer.
// API contracts: https://docs.github.com/en/rest/checks/runs
// and https://docs.github.com/en/rest/commits/statuses
const SHA = /^[0-9a-f]{40}$/;
const STATES = ['pending', 'passed', 'failed', 'cancelled', 'unknown'];
const POLICY = 'observed-checks-v1';
const CHECK_RESULTS = new Map([['success', 'passed'], ['failure', 'failed'], ['timed_out', 'failed'], ['action_required', 'failed'], ['cancelled', 'cancelled']]);
const STATUS_RESULTS = new Map([['success', 'passed'], ['failure', 'failed'], ['error', 'failed'], ['pending', 'pending']]);
const validId = n => Number.isSafeInteger(n) && n > 0;
const text = s => typeof s === 'string' && s.trim() !== '';
const url = s => { try { return new URL(s).protocol === 'https:'; } catch { return false; } };

export function ciTarget(task) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9][0-9]*)$/.exec(task?.pr?.url ?? '');
  if (!match || !SHA.test(task?.pr?.headSha ?? '') || (task.assignment?.publication?.repo && task.assignment.publication.repo !== match[1])) return undefined;
  return { repo: match[1], number: Number(match[2]), prUrl: task.pr.url, reviewedSha: task.pr.headSha };
}

function checkState(run) {
  if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status)) return 'pending';
  if (run.status !== 'completed') return 'unknown';
  return CHECK_RESULTS.get(run.conclusion) ?? 'unknown';
}

function aggregate(items) {
  if (!items.length) return 'unknown';
  // Incomplete evidence never implies a passing assessment.
  for (const state of ['unknown', 'failed', 'cancelled', 'pending']) if (items.some(i => i.state === state)) return state;
  return 'passed';
}

/** Synchronous injectable JSON GET transport; bounded, complete pagination. */
export function collectCi(target, get, now = () => new Date().toISOString()) {
  const observation = { version: 1, policy: POLICY, ...target, observedAt: now(), observedHeadSha: null, state: 'unknown', reason: '', sources: [], checks: [] };
  try {
    if (!target || !/^[\w.-]+\/[\w.-]+$/.test(target.repo) || !validId(target.number) || !SHA.test(target.reviewedSha)) throw new Error('invalid CI target');
    const request = path => {
      observation.sources.push(`https://api.github.com/${path}`);
      return get(path);
    };
    const prPath = `repos/${target.repo}/pulls/${target.number}`;
    const head = () => {
      const pr = request(prPath);
      if (pr?.html_url !== target.prUrl || !SHA.test(pr?.head?.sha ?? '')) throw new Error('invalid PR identity');
      observation.observedHeadSha = pr.head.sha;
      if (pr.head.sha !== target.reviewedSha) throw new Error('PR head differs from reviewed SHA');
    };
    head();
    const pages = (suffix, field) => {
      const rows = [];
      const ids = new Set();
      let total;
      for (let page = 1; page <= 20; page++) {
        const data = request(`repos/${target.repo}/commits/${target.reviewedSha}/${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || !Array.isArray(data[field])) throw new Error('malformed CI page');
        if (field === 'statuses' && data.sha !== target.reviewedSha) throw new Error('status SHA differs from reviewed SHA');
        if (total !== undefined && total !== data.total_count) throw new Error('CI changed during pagination; refresh again');
        total = data.total_count;
        for (const row of data[field]) {
          if (!validId(row?.id) || ids.has(row.id)) throw new Error('duplicate or invalid CI row');
          ids.add(row.id);
          rows.push(row);
        }
        if (rows.length > total) throw new Error('inconsistent CI count');
        if (rows.length === total) return rows;
        if (data[field].length !== 100) throw new Error('incomplete CI page');
      }
      throw new Error('CI pagination limit reached');
    };
    const runs = pages('check-runs?filter=all', 'check_runs');
    const statuses = pages('status', 'statuses');
    const latest = new Map();
    for (const run of runs) {
      if (run.head_sha !== target.reviewedSha) throw new Error('check SHA differs from reviewed SHA');
      if (!text(run.name) || !validId(run.app?.id) || !url(run.html_url)) throw new Error('malformed check run');
      // Keep distinct suites: identical names from different workflows must not
      // hide one another. A rerun within a suite replaces its earlier run ID.
      if (!validId(run.check_suite?.id)) throw new Error('missing check suite identity');
      const key = `${run.app.id}:${run.check_suite.id}:${run.name}`;
      const item = { kind: 'check', id: run.id, name: run.name, state: checkState(run), url: run.html_url, appId: run.app.id, suiteId: run.check_suite.id };
      if (!latest.has(key) || latest.get(key).id < run.id) latest.set(key, item);
    }
    const contexts = new Set();
    for (const status of statuses) {
      if (!text(status.context) || contexts.has(status.context)) throw new Error('duplicate or missing status context');
      contexts.add(status.context);
      const source = status.target_url || status.url;
      if (!url(source)) throw new Error('missing status source');
      latest.set(`status:${status.context}`, { kind: 'status', id: status.id, name: status.context, state: STATUS_RESULTS.get(status.state) ?? 'unknown', url: source });
    }
    observation.checks = [...latest.values()];
    head(); // a head change during collection invalidates the whole observation
    observation.state = aggregate(observation.checks);
    observation.reason = observation.checks.length ? 'All observed check runs and latest status contexts; required checks are not inferred.' : 'No checks or statuses observed.';
  } catch (error) {
    observation.state = 'unknown';
    // Transport errors must not leak credential-bearing API stderr.
    observation.reason = error instanceof Error ? error.message : 'CI observation failed';
  }
  observation.observedAt = now();
  observation.sources = [...new Set(observation.sources)];
  return observation;
}

/** Cached evidence is a dated snapshot, never a claim about the live PR head. */
export function ciForStatus(observation, target, localHead) {
  const unknown = reason => ({ state: 'unknown', reason, reviewedSha: target?.reviewedSha ?? null, observedAt: null, checks: [] });
  if (!target) return unknown('No recorded reviewed PR.');
  if (!observation) return unknown('No CI observation; use status --refresh-ci.');
  if (observation.version !== 1 || observation.policy !== POLICY || !STATES.includes(observation.state) || !Number.isFinite(Date.parse(observation.observedAt)) || !Array.isArray(observation.sources) || !observation.sources.every(url) || !Array.isArray(observation.checks) || !observation.checks.every(c => c && validId(c.id) && text(c.name) && STATES.includes(c.state) && url(c.url)) || (observation.state !== 'unknown' && aggregate(observation.checks) !== observation.state)) return unknown('Invalid cached CI observation; refresh required.');
  if (observation.prUrl !== target.prUrl || observation.repo !== target.repo || observation.reviewedSha !== target.reviewedSha || localHead !== target.reviewedSha || observation.observedHeadSha !== target.reviewedSha) return { ...unknown('CI evidence does not match the current reviewed PR/head; refresh required.'), observedAt: observation.observedAt };
  return observation;
}
