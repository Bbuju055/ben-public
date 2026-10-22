import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  acquireLock,
  benHome,
  loadState,
  LockHeldError,
  newTaskState,
  releaseLock,
  saveState,
  statePath,
  taskDir,
} from '../src/orchestrator/state';
import { useTmpHome } from './helpers';

beforeEach(async () => {
  await useTmpHome();
});

test('saveState is atomic and round-trips', async () => {
  const state = newTaskState({ taskId: 't1', title: 'test', repoPath: '/nowhere', ceilingUsd: 25 });
  await saveState(state);
  const loaded = await loadState('t1');
  expect(loaded.taskId).toBe('t1');
  expect(loaded.phase).toBe('INTAKE');
  expect(loaded.budget.ceilingUsd).toBe(25);
  expect(existsSync(`${statePath('t1')}.tmp`)).toBe(false); // no partial writes left behind
  expect(taskDir('t1').startsWith(benHome())).toBe(true);
});

test('lock: a dead holder never blocks — the kernel released its flock', async () => {
  // a lock file left behind by a process that is certainly dead
  const proc = Bun.spawn(['true']);
  await proc.exited;
  await mkdir(join(benHome(), 'locks'), { recursive: true });
  await writeFile(join(benHome(), 'locks', 'ben--x.lock'), String(proc.pid));
  await acquireLock('ben/x'); // no steal needed: a dead pid's flock does not exist
  await acquireLock('ben/x'); // re-entrant for our own process
  await releaseLock('ben/x');
  await acquireLock('ben/x'); // and re-acquirable after release
  await releaseLock('ben/x');
});

test('lock: a live holder in another process blocks acquisition', async () => {
  await mkdir(join(benHome(), 'locks'), { recursive: true });
  const path = join(benHome(), 'locks', 'ben--y.lock');
  // a real second process takes the flock and holds it
  const holder = Bun.spawn([
    'bun', '-e',
    `import { dlopen, FFIType } from 'bun:ffi';
     import { openSync, writeSync } from 'node:fs';
     const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
       { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
     const fd = openSync(${JSON.stringify(path)}, 'a');
     if (libc.symbols.flock(fd, 2 | 4) !== 0) process.exit(3);
     writeSync(fd, String(process.pid));
     console.log('locked');
     setTimeout(() => process.exit(0), 8000);`,
  ], { stdout: 'pipe' });
  // wait until the child reports it holds the lock
  const reader = holder.stdout.getReader();
  await reader.read();
  try {
    expect(acquireLock('ben/y')).rejects.toThrow(LockHeldError);
  } finally {
    holder.kill();
    await holder.exited;
  }
  await acquireLock('ben/y'); // holder died → kernel released → acquirable immediately
  await releaseLock('ben/y');
});
