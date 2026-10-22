import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { runE2e } from '../src/gates/e2e';
import { makeTmpDir } from './helpers';

const REPO_ROOT = join(import.meta.dir, '..');
const FIXTURE = join(REPO_ROOT, 'fixtures/e2e-app');

// browsers live inside the repo — never a machine-global install
process.env.PLAYWRIGHT_BROWSERS_PATH = join(REPO_ROOT, '.playwright-browsers');

test(
  'e2e criterion runs Playwright headless and lands screenshots + video in the artifacts dir',
  async () => {
    // Choose a fresh port; the unique response also prevents an unrelated server
    // from satisfying this run if another process wins the short bind race.
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = reservation.port;
    await reservation.stop(true);
    const url = `http://127.0.0.1:${port}`;
    const greeting = `hello-${randomUUID()}`;
    const artifactsDir = join(await makeTmpDir('ben-e2e-'), 'C1');
    const result = await runE2e({
      command: `BEN_E2E_URL=${url} BEN_E2E_GREETING=${greeting} "${join(REPO_ROOT, 'node_modules/.bin/playwright')}" test`,
      cwd: FIXTURE,
      artifactsDir,
      // exec lets the helper terminate the server itself, not just its shell.
      server: { serverCommand: `BEN_E2E_PORT=${port} BEN_E2E_GREETING=${greeting} exec bun server.ts`, readyUrl: url },
      timeoutMs: 120_000,
    });

    expect(result.exitCode).toBe(0);
    const files = (await readdir(artifactsDir, { recursive: true })).map(String);
    expect(files.some((f) => f.endsWith('.png'))).toBe(true); // screenshots
    expect(files.some((f) => f.endsWith('.webm'))).toBe(true); // the green run's video
    expect(await fetch(url).then(() => true, () => false)).toBe(false); // server was reaped
  },
  { timeout: 180_000 },
);

test('a server that never comes up fails with evidence instead of hanging', async () => {
  const artifactsDir = join(await makeTmpDir('ben-e2e-dead-'), 'C1');
  const result = await runE2e({
    command: 'true',
    cwd: FIXTURE,
    artifactsDir,
    server: { serverCommand: 'sleep 600', readyUrl: 'http://127.0.0.1:1/' },
    timeoutMs: 10_000,
    readyTimeoutMs: 3_000,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('never became ready');
}, { timeout: 90_000 });
