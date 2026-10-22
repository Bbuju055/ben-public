import { join } from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec, type ExecResult } from '../lib/exec';

export interface E2eServer {
  serverCommand: string;
  readyUrl: string;
}

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;

async function waitReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(READY_POLL_MS);
  }
  return false;
}

/**
 * Start the app from the worktree, wait for it, run the Playwright command,
 * kill the server, and collect screenshots/video/trace into artifactsDir.
 * A server that never comes up is a failure with the server log as evidence — not a hang.
 */
export async function runE2e(opts: {
  command: string;
  cwd: string;
  artifactsDir: string;
  server: E2eServer;
  timeoutMs: number;
  readyTimeoutMs?: number;
}): Promise<ExecResult> {
  await mkdir(opts.artifactsDir, { recursive: true });
  const serverLog = join(opts.artifactsDir, 'server.log');
  const server = Bun.spawn(['/bin/sh', '-c', `${opts.server.serverCommand} > ${JSON.stringify(serverLog)} 2>&1`], {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const ready = await waitReady(opts.server.readyUrl, readyTimeoutMs);
    if (!ready) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `server never became ready at ${opts.server.readyUrl}; server log: ${serverLog}`,
        durationMs: readyTimeoutMs,
        timedOut: false,
      };
    }
    return await exec(opts.command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  } finally {
    try {
      server.kill();
      const graceful = Promise.race([server.exited, Bun.sleep(5_000).then(() => 'timeout' as const)]);
      if ((await graceful) === 'timeout') server.kill(9);
    } catch {
      // already dead
    }
    // Playwright writes screenshots/video/trace under test-results/ in the cwd
    const testResults = join(opts.cwd, 'test-results');
    if (existsSync(testResults)) {
      await cp(testResults, opts.artifactsDir, { recursive: true, force: true });
    }
  }
}
