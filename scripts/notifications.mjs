// Optional operator notifications. These observations never authorize task work.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_ATTEMPTS = 5;
const RETRY_MS = 60_000;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
}

/** Payloads deliberately omit prompts, error output, gate packets and task titles. */
export function notificationEvent(repo, status, runnerState = {}) {
  const task = status?.task;
  const assignmentId = typeof task?.assignmentId === 'string' ? task.assignmentId : 'unreadable';
  const gate = status?.waiting;
  let kind, identity, reason;
  if (status?.abandoned) {
    kind = 'stop'; identity = 'abandoned'; reason = 'abandoned';
  } else if (task?.pr?.headSha && task?.pr?.url) {
    kind = 'complete'; identity = `${task.pr.url}:${task.pr.headSha}`; reason = 'ready-for-review';
  } else if (runnerState.needsYou) {
    kind = 'stop'; identity = `needs-you:${runnerState.needsYou.at ?? hash(JSON.stringify(runnerState.needsYou))}`; reason = 'needs-you';
  } else if (gate?.state === 'current' && ['human', 'playbook'].includes(gate.owner) && gate.gateId) {
    kind = gate.kind === 'limit' ? 'limit' : ['supervisor-stop','stop','pr-branch-conflict','pr-head-mismatch','pr-migration'].includes(gate.kind) ? 'stop' : 'park';
    identity = gate.gateId; reason = gate.kind;
  } else return null;
  return { version: 1, id: hash(JSON.stringify([repo, assignmentId, kind, identity])), kind, reason, repo, assignmentId,
    ...(kind === 'complete' ? { prUrl: task.pr.url, reviewedSha: task.pr.headSha } : {}),
    ...(gate?.state === 'current' && kind !== 'complete' && !runnerState.needsYou ? { gateId: gate.gateId } : {}) };
}

function configFor(home) {
  const path = join(home, 'notifications.json');
  if (!existsSync(path)) return null;
  const config = read(path);
  if (config.enabled !== true) return null;
  if (!Array.isArray(config.argv) || config.argv.length === 0 || !config.argv.every(v => typeof v === 'string' && !v.includes('\0')) || !isAbsolute(config.argv[0])) {
    throw new Error('notifications.json needs an absolute executable and argv array');
  }
  return config;
}
function acquire(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Serialize stale-lock reclamation and re-read ownership under that guard.
      // Otherwise two observers can both delete what was one dead owner's lock.
      const guard = path + '.reclaim';
      let fd;
      try {
        fd = openSync(guard, 'wx', 0o600);
        writeFileSync(fd, String(process.pid));
        if (!existsSync(path)) continue;
        const owner = readFileSync(path, 'utf8');
        const pid = Number(owner);
        if (!/^[1-9][0-9]*$/.test(owner) || !Number.isSafeInteger(pid) || pid > 0x7fffffff) return false;
        try { process.kill(pid, 0); return false; }
        catch (err) { if (err.code !== 'ESRCH') return false; }
        unlinkSync(path);
      } catch (err) {
        if (err.code === 'EEXIST') return false;
        throw err;
      } finally {
        if (fd !== undefined) { closeSync(fd); unlinkSync(guard); }
      }
    }
  }
  return false;
}
function validate(state) {
  if (state.version !== 1 || !Array.isArray(state.items)) throw new Error('invalid notification outbox');
  const ids = new Set();
  for (const row of state.items) {
    if (!row.event || !/^[a-f0-9]{64}$/.test(row.event.id) || ids.has(row.event.id) ||
        !['pending','delivered','exhausted','superseded'].includes(row.state) ||
        !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > MAX_ATTEMPTS ||
        !Number.isFinite(row.nextAt)) throw new Error('invalid notification outbox row');
    ids.add(row.event.id);
  }
}
export function commandSink(config, event) {
  // No shell, inherited credentials, or task-provided command. Exit zero acknowledges.
  const result = spawnSync(config.argv[0], config.argv.slice(1), {
    input: JSON.stringify(event) + '\n', encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
    cwd: '/', env: { PATH: '/usr/bin:/bin', BEN_NOTIFICATION_ID: event.id },
    stdio: ['pipe','ignore','ignore'], detached: true,
  });
  // A sink is a bounded one-shot operation, not a background worker.
  if (result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') return false; }
  }
  return !result.error && result.status === 0;
}

/** One bounded delivery attempt per observation; lock and state live outside the target repo. */
export function reconcileNotifications({ home, repo, snapshot, now = Date.now, send = commandSink }) {
  let lock, owned = false;
  try {
    const config = configFor(home);
    if (!config) return { state: 'disabled' };
    const dir = join(home, 'notifications', hash(repo));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = join(dir, 'lock');
    if (!(owned = acquire(lock))) return { state: 'busy' };
    const path = join(dir, 'outbox.json');
    const state = existsSync(path) ? read(path) : { version: 1, items: [] };
    validate(state); // Preserve corrupt evidence; never reset and redeliver it.
    const current = snapshot();
    // An unavailable observation cannot invalidate an earlier pending event.
    if (current === undefined) return { state: 'unavailable' };
    const event = notificationEvent(repo, current.status, current.runnerState);
    const time = now();
    let changed = false;
    for (const row of state.items) {
      if (row.state === 'pending' && row.event.id !== event?.id) { row.state = 'superseded'; changed = true; }
    }
    let row = state.items.find(r => r.event.id === event?.id);
    if (event && !row) {
      row = { event: { ...event, observedAt: new Date(time).toISOString() }, state: 'pending', attempts: 0, nextAt: time };
      state.items.push(row); changed = true;
    }
    if (row?.state === 'superseded') {
      row.state = row.attempts >= MAX_ATTEMPTS ? 'exhausted' : 'pending';
      changed = true;
    }
    if (changed) save(path, state);
    if (!row || row.state !== 'pending' || row.nextAt > time) return { state: row?.state ?? 'idle' };
    if (row.attempts >= MAX_ATTEMPTS) { row.state = 'exhausted'; save(path, state); return { state: row.state }; }
    // Reserve the attempt and its deadline before calling the sink. A crash may replay
    // the same ID; sinks must deduplicate it (exactly-once delivery is not promised).
    row.attempts++;
    row.nextAt = time + RETRY_MS * 2 ** (row.attempts - 1);
    save(path, state);
    let delivered = false;
    try { delivered = send(config, { ...event, observedAt: row.event.observedAt }) === true; } catch { /* delivery failure */ }
    if (delivered) row.state = 'delivered';
    else if (row.attempts === MAX_ATTEMPTS) row.state = 'exhausted';
    save(path, state);
    return { state: row.state, attempts: row.attempts, nextAt: row.nextAt };
  } catch {
    // Sink output/config errors may contain secrets. Keep diagnostics generic.
    return { state: 'error' };
  } finally {
    if (owned) {
      try { if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); } catch { /* preserve ambiguous ownership */ }
    }
  }
}
