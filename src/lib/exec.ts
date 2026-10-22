export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface ExecOpts {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

async function run(argv: string[], opts: ExecOpts): Promise<ExecResult> {
  const started = Date.now();
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(9);
    } catch {
      // already gone
    }
  }, opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut };
}

/** Run a shell command line (via /bin/sh -c). Hard kill -9 on timeout. */
export function exec(cmd: string, opts: ExecOpts): Promise<ExecResult> {
  return run(['/bin/sh', '-c', cmd], opts);
}

/** Run an argv directly, no shell — for prompts and other args that must not be shell-interpreted. */
export function execArgv(argv: string[], opts: ExecOpts): Promise<ExecResult> {
  return run(argv, opts);
}
