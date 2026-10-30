// Operator-owned, bounded CI observations. Never authorizes task work.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciTarget, ciForStatus, collectCi } from './ci.lib.mjs';

export const CI_POLL = Object.freeze({ attempts: 20, intervalMs: 60_000, windowMs: 30 * 60_000, collectionMs: 15_000 });
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const directory = (home, repo) => join(home, 'ci-observer', hash(repo));
const keyFor = target => hash(JSON.stringify([target.repo, target.number, target.prUrl, target.reviewedSha]));
const terminal = state => ['passed', 'failed', 'cancelled'].includes(state);
function unknown(target, time, reason) {
  return { version: 1, policy: 'observed-checks-v1', ...target, observedAt: new Date(time).toISOString(), observedHeadSha: null, state: 'unknown', reason, sources: [], checks: [] };
}
function save(path, state) {
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function acquire(path) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const guard = path + '.reclaim';
      let fd;
      try {
        fd = openSync(guard, 'wx', 0o600);
        if (!existsSync(path)) continue;
        const owner = readFileSync(path, 'utf8');
        const pid = Number(owner);
        if (!/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(pid) || pid > 0x7fffffff) return false;
        try { process.kill(pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') return false; }
        unlinkSync(path);
      } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
      finally { if (fd !== undefined) { closeSync(fd); unlinkSync(guard); } }
    }
  }
  return false;
}
function load(path) {
  if (!existsSync(path)) return { version: 1, items: [] };
  const state = read(path);
  if (state?.version !== 1 || !Array.isArray(state.items)) throw new Error('invalid observer state');
  const keys = new Set();
  for (const row of state.items) {
    const target = ciTarget({ pr: { url: row?.target?.prUrl, headSha: row?.target?.reviewedSha } });
    if (!target || JSON.stringify(target) !== JSON.stringify(row.target) || row.key !== keyFor(target) || keys.has(row.key) ||
        !Number.isInteger(row.attempts) || row.attempts < 1 || row.attempts > CI_POLL.attempts ||
        !Number.isFinite(row.startedAt) || !Number.isFinite(row.nextAt) || row.nextAt < row.startedAt ||
        row.expiresAt !== row.startedAt + CI_POLL.windowMs || !Array.isArray(row.observations) || row.observations.length !== row.attempts ||
        row.observations.some(o => !o || o.repo !== target.repo || o.number !== target.number || o.prUrl !== target.prUrl || o.reviewedSha !== target.reviewedSha || ciForStatus(o, target, target.reviewedSha).observedAt === null)) throw new Error('invalid observer row');
    keys.add(row.key);
  }
  return state;
}

/** Read only; malformed durable evidence must not expose an older green result. */
export function scheduledCi(home, repo, target) {
  if (!target) return undefined;
  try { return load(join(directory(home, repo), 'state.json')).items.find(row => row.key === keyFor(target))?.observations.at(-1); }
  catch { return { ...unknown(target, Date.now(), 'Invalid scheduled CI evidence; operator inspection required.'), invalid: true }; }
}

/** One due attempt per call. Transport must enforce the supplied remaining timeout. */
export function observeCi({ home, repo, snapshot, get, now = Date.now, monotonic = () => performance.now() }) {
  let lock, owned = false;
  try {
    const config = join(home, 'ci-observer.json');
    if (!existsSync(config) || read(config)?.enabled !== true) return { state: 'disabled' };
    const dir = directory(home, repo);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = join(dir, 'lock');
    if (!(owned = acquire(lock))) return { state: 'busy' };
    const path = join(dir, 'state.json');
    const state = load(path);
    const current = snapshot();
    if (!current) return { state: 'unavailable' };
    const target = ciTarget(current.task);
    if (!target) return { state: 'idle' };
    const key = keyFor(target);
    let row = state.items.find(item => item.key === key);
    const time = now();
    // Never surface a previous passing result when the local reviewed head moved.
    if (current.localHead !== target.reviewedSha) return { state: 'stale' };
    const previous = row?.observations.at(-1);
    if (terminal(previous?.state)) return { state: 'complete', attempts: row.attempts };
    if (row && (row.attempts >= CI_POLL.attempts || time >= row.expiresAt)) return { state: 'exhausted', attempts: row.attempts };
    if (row && time < row.nextAt) return { state: 'waiting', attempts: row.attempts, nextAt: row.nextAt };
    if (!row) {
      row = { key, target, startedAt: time, expiresAt: time + CI_POLL.windowMs, nextAt: time, attempts: 0, observations: [] };
      state.items.push(row);
    }
    row.attempts++;
    row.nextAt = time + CI_POLL.intervalMs;
    row.observations.push(unknown(target, time, 'CI observation reserved; collection incomplete.'));
    save(path, state); // Reserve before I/O; a crashed attempt is never free.
    const deadline = monotonic() + Math.min(CI_POLL.collectionMs, row.expiresAt - time);
    const remainingMs = () => Math.floor(Math.min(deadline - monotonic(), row.expiresAt - now()));
    const observation = collectCi(target, request => {
      const remaining = remainingMs();
      if (remaining <= 0) throw new Error('CI collection deadline reached.');
      let response;
      try { response = get(request, { timeoutMs: remaining }); }
      catch { throw new Error('CI API unavailable or permission denied.'); }
      if (remainingMs() <= 0) throw new Error('CI collection deadline reached.');
      return response;
    }, () => new Date(now()).toISOString());
    // Invalidate evidence if local task/head changed while requests were in flight.
    const after = snapshot();
    const afterTarget = ciTarget(after?.task);
    row.observations[row.observations.length - 1] = afterTarget && keyFor(afterTarget) === key && after.localHead === target.reviewedSha
      ? observation : unknown(target, now(), 'Task or local head changed during CI observation.');
    save(path, state);
    return { state: 'observed', attempts: row.attempts, nextAt: row.nextAt, observation: row.observations.at(-1) };
  } catch { return { state: 'error' }; }
  finally {
    if (owned) try { if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); } catch { /* Preserve ambiguous ownership. */ }
  }
}
