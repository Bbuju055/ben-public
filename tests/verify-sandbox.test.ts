import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execArgv, type ExecResult } from '../src/lib/exec';
import { gateWrapperArgv, renderGateProfile } from '../scripts/runner.lib.mjs';
import { makeFixtureRepo, makeTmpDir } from './helpers';

// Command isolation: with the command wrapper set, every gate/criterion
// command runs under a per-command Seatbelt profile. A command that writes to
// any protected path FAILS while the referee still records the red result; a
// command writing into BEN_SCRATCH_DIR sees its files promoted by the referee
// alone; wrapper-less runs are byte-identical to before (the existing suite).

const VERIFY = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));
const BEN = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const sandboxAvailable = existsSync('/usr/bin/sandbox-exec');
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function fixture(): Promise<{ repo: string; S: string; wrapper: string; runnerHome: string; mirror: string; home: string }> {
  const repo = realpathSync(await makeFixtureRepo());
  const S = join(repo, '.ben');
  mkdirSync(join(S, 'evidence'), { recursive: true });
  const runnerHome = realpathSync(await makeTmpDir('runner-home-'));
  const mirror = join(runnerHome, 'mirrors', 'o-r.git');
  mkdirSync(mirror, { recursive: true });
  // Seed synthetic credentials: denial must not depend on the operator's ~/.ssh.
  const home = join(runnerHome, 'operator home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'canary'), 'synthetic credential canary');
  const profilePath = join(runnerHome, 'gate-profile.sb');
  await writeFile(profilePath, renderGateProfile({ repo, runnerHome, benDir: BEN, home }));
  return { repo, S, wrapper: JSON.stringify(gateWrapperArgv(profilePath)), runnerHome, mirror, home };
}

function verify(S: string, args: string[], env: Record<string, string>): Promise<ExecResult> {
  return execArgv(['node', VERIFY, ...args], { cwd: S, timeoutMs: 120_000, env });
}

test.skipIf(!sandboxAvailable)('a gate command writing to any protected path fails under the profile while the referee records the red result', async () => {
  const { repo, S, wrapper, runnerHome, mirror, home } = await fixture();
  expect(await readFile(join(home, '.ssh', 'canary'), 'utf8')).toBe('synthetic credential canary');
  const gates: Record<string, string> = {
    ledger: `echo x >> ${shellQuote(join(S, 'ledger.jsonl'))}`,
    approval: `node -e ${shellQuote(`require("fs").writeFileSync(${JSON.stringify(join(S, 'approval.json'))},"{}")`)}`,
    evidence: `echo x > ${shellQuote(join(S, 'evidence/criteria-matrix.json'))}`,
    taskjson: `echo x > ${shellQuote(join(S, 'task.json'))}`,
    benscripts: `echo x > ${shellQuote(join(BEN, 'scripts/.d9-probe'))}`,
    runnerhome: `echo x > ${shellQuote(join(runnerHome, '.d9-probe'))}`,
    mirror: `echo x > ${shellQuote(join(mirror, '.d9-probe'))}`,
    gitconfig: `cd ${shellQuote(repo)} && git config d9.probe 1`,
    githooks: `echo x > ${shellQuote(join(repo, '.git/hooks/pre-commit'))}`,
    gitinfo: `echo x > ${shellQuote(join(repo, '.git/info/exclude'))}`,
    dotclaude: `mkdir -p ${shellQuote(join(repo, '.claude'))} && echo x > ${shellQuote(join(repo, '.claude/settings.local.json'))}`,
    outside: `echo x > ${shellQuote(join(home, '.d9-probe-outside'))}`,
    credread: `ls ${shellQuote(join(home, '.ssh'))}`,
    ok: `echo fine > ${shellQuote(join(repo, 'allowed.txt'))}`,
  };
  await writeFile(join(S, 'gates.json'), JSON.stringify(gates));
  const r = await verify(S, ['gates', S, '--repo', repo, '--cap', '1'], { BEN_COMMAND_WRAPPER: wrapper });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toStartWith('Gates failed — raw evidence below');
  for (const name of Object.keys(gates).filter((n) => n !== 'ok')) {
    expect(r.stdout).toContain(`### gate: ${name} (exit`);
    const evidence = await readFile(join(S, 'evidence', `gate-${name}-r1.txt`), 'utf8');
    expect(evidence).toMatch(/Operation not permitted|operation not permitted|EPERM|could not write config/i);
  }
  expect(r.stdout).not.toContain('### gate: ok');
  // nothing protected was actually written
  expect(existsSync(join(S, 'ledger.jsonl'))).toBe(false);
  expect(existsSync(join(S, 'approval.json'))).toBe(false);
  expect(existsSync(join(S, 'task.json'))).toBe(false);
  expect(existsSync(join(S, 'evidence', 'criteria-matrix.json'))).toBe(false);
  expect(existsSync(join(BEN, 'scripts', '.d9-probe'))).toBe(false);
  expect(existsSync(join(runnerHome, '.d9-probe'))).toBe(false);
  expect(existsSync(join(mirror, '.d9-probe'))).toBe(false);
  expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
  expect(existsSync(join(repo, '.claude', 'settings.local.json'))).toBe(false);
  expect(existsSync(join(home, '.d9-probe-outside'))).toBe(false);
  expect(await readFile(join(repo, '.git', 'config'), 'utf8')).not.toContain('d9');
  // the allowed write inside the tree landed; the referee's own evidence landed
  expect(await readFile(join(repo, 'allowed.txt'), 'utf8')).toBe('fine\n');
  expect(existsSync(join(S, 'evidence', 'gate-ok-r1.txt'))).toBe(true);
});

test.skipIf(!sandboxAvailable)('network is denied unless the task granted it; localhost stays usable', async () => {
  const { repo, S, wrapper, runnerHome } = await fixture();
  await writeFile(
    join(S, 'gates.json'),
    JSON.stringify({
      net: 'curl -sS -m 5 https://example.com',
      local: `node -e 'require("http").createServer((q,s)=>s.end("hi")).listen(0,"127.0.0.1",function(){const p=this.address().port;require("http").get("http://127.0.0.1:"+p,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{console.log("got "+d);process.exit(d==="hi"?0:1)})})})'`,
    }),
  );
  const denied = await verify(S, ['gates', S, '--repo', repo, '--cap', '1'], { BEN_COMMAND_WRAPPER: wrapper });
  expect(denied.exitCode).toBe(1);
  expect(denied.stdout).toContain('### gate: net (exit');
  expect(denied.stdout).not.toContain('### gate: local');
  // the task-granted profile (all-or-nothing at this layer) lets the same command through
  const granted = join(runnerHome, 'gate-profile-net.sb');
  await writeFile(granted, renderGateProfile({ repo, runnerHome, benDir: BEN, allowNetwork: true }));
  await writeFile(join(S, 'gates.json'), JSON.stringify({ net: "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com | grep -q 200" }));
  const ok = await verify(S, ['gates', S, '--repo', repo, '--cap', '1'], { BEN_COMMAND_WRAPPER: JSON.stringify(gateWrapperArgv(granted)) });
  expect(ok.exitCode).toBe(0);
});

test.skipIf(!sandboxAvailable)('a command writing into BEN_SCRATCH_DIR sees its regular files promoted by the referee; symlinks and exec bits never survive', async () => {
  const { repo, S, wrapper } = await fixture();
  await writeFile(
    join(S, 'criteria.json'),
    JSON.stringify({
      taskId: 'T1',
      criteria: [
        {
          id: 'C1',
          statement: 'a screenshot lands in evidence',
          verification: {
            method: 'command',
            command: `printf PNG > "$BEN_SCRATCH_DIR/shot.png" && mkdir -p "$BEN_SCRATCH_DIR/sub" && printf '#!/bin/sh\\necho pwned' > "$BEN_SCRATCH_DIR/sub/run.sh" && chmod +x "$BEN_SCRATCH_DIR/sub/run.sh" && ln -s /etc/passwd "$BEN_SCRATCH_DIR/link" && test -n "$BEN_SCRATCH_DIR" && test -z "$GH_TOKEN" && [ "$GIT_CONFIG_GLOBAL" = /dev/null ]`,
          },
        },
      ],
    }),
  );
  const r = await verify(S, ['criteria', S, '--repo', repo, '--cap', '1'], { BEN_COMMAND_WRAPPER: wrapper, GH_TOKEN: 'secret-token' });
  expect(r.exitCode).toBe(0);
  const art = join(S, 'evidence', 'artifacts', 'criteria-C1-r1');
  expect(await readFile(join(art, 'shot.png'), 'utf8')).toBe('PNG');
  expect(existsSync(join(art, 'sub', 'run.sh'))).toBe(true);
  expect(existsSync(join(art, 'link'))).toBe(false); // symlink skipped, never dereferenced
  const mode = (await import('node:fs')).statSync(join(art, 'sub', 'run.sh')).mode & 0o777;
  expect(mode & 0o111).toBe(0); // exec bits stripped
  const evidence = await readFile(join(S, 'evidence', 'criteria-C1-r1.txt'), 'utf8');
  expect(evidence).toContain('--- artifacts promoted from BEN_SCRATCH_DIR ---');
  expect(evidence).toContain('shot.png (3 bytes)');
  expect(evidence).toContain('sub/run.sh');
});

test('a malformed wrapper is a usage error, never a silent unwrapped run', async () => {
  const { S, repo } = await fixture();
  await writeFile(join(S, 'gates.json'), JSON.stringify({ ok: 'true' }));
  const bad = await verify(S, ['gates', S, '--repo', repo, '--command-wrapper', 'not-json'], {});
  expect(bad.exitCode).toBe(3);
  expect(bad.stderr).toContain('JSON array');
  const empty = await verify(S, ['gates', S, '--repo', repo, '--command-wrapper', '[]'], {});
  expect(empty.exitCode).toBe(3);
  // a wrapper that cannot spawn is a recorded red result with the reason, not a pass
  await writeFile(join(S, 'gates.json'), JSON.stringify({ ok: 'true' }));
  const missing = await verify(S, ['gates', S, '--repo', repo, '--cap', '1', '--command-wrapper', JSON.stringify(['/nonexistent/wrapper'])], {});
  expect(missing.exitCode).toBe(1);
  expect(missing.stdout).toContain('isolation wrapper failed to spawn');
});

test.skipIf(!sandboxAvailable)('per-command scratch: through runner.mjs gate-wrap a command may write ONLY its own BEN_SCRATCH_DIR — a sibling scratch dir and every other .ben path are refused', async () => {
  const { repo, S, runnerHome } = await fixture();
  const RUNNER = fileURLToPath(new URL('../scripts/runner.mjs', import.meta.url));
  const template = join(runnerHome, 'gate-profile.template.sb');
  await writeFile(template, renderGateProfile({ repo, runnerHome, benDir: BEN }).replace(`(allow file-write* (subpath "${join(S, 'evidence', 'scratch')}"))`, '(allow file-write* (subpath "__SCRATCH__"))'));
  mkdirSync(join(S, 'evidence', 'scratch', 'other-r9'), { recursive: true });
  const wrapper = JSON.stringify([process.execPath, RUNNER, 'gate-wrap', template, '--']);
  await writeFile(
    join(S, 'gates.json'),
    JSON.stringify({
      own: 'printf shot > "$BEN_SCRATCH_DIR/own.png"',
      sibling: `printf x > ${shellQuote(join(S, 'evidence', 'scratch', 'other-r9', 'leak.txt'))}`,
      ledger: `echo x >> ${shellQuote(join(S, 'ledger.jsonl'))}`,
    }),
  );
  const r = await verify(S, ['gates', S, '--repo', repo, '--cap', '1'], { BEN_COMMAND_WRAPPER: wrapper, BEN_RUNNER_HOME: runnerHome });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain('### gate: sibling (exit');
  expect(r.stdout).toContain('### gate: ledger (exit');
  expect(r.stdout).not.toContain('### gate: own');
  expect(existsSync(join(S, 'evidence', 'scratch', 'other-r9', 'leak.txt'))).toBe(false);
  expect(existsSync(join(S, 'ledger.jsonl'))).toBe(false);
  expect(await readFile(join(S, 'evidence', 'artifacts', 'gate-own-r1', 'own.png'), 'utf8')).toBe('shot');
  // the rendered per-command profiles live under the runner home, never in the repo
  expect(existsSync(join(runnerHome, 'profiles'))).toBe(true);
});

test('untrusted gate names and criterion ids cannot escape evidence/ — labels are opaque and containment is enforced before any trusted rm', async () => {
  const { repo, S, wrapper } = await fixture();
  const victim = join(repo, 'victim-dir');
  mkdirSync(victim, { recursive: true });
  await writeFile(join(victim, 'keep.txt'), 'keep');
  await writeFile(join(S, 'gates.json'), JSON.stringify({ 'x/../../../../victim-dir': 'echo x > "$BEN_SCRATCH_DIR/out.txt"', ok: 'true' }));
  const r = await verify(S, ['gates', S, '--repo', repo, '--cap', '1'], { BEN_COMMAND_WRAPPER: wrapper });
  expect(r.exitCode).toBe(0);
  expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('keep'); // nothing outside evidence/ was removed or written
  const evidence = (await import('node:fs')).readdirSync(join(S, 'evidence'));
  expect(evidence.some((f) => f.startsWith('gate-x_.._.._.._.._victim-dir-r1'))).toBe(true);
  expect(existsSync(join(S, 'evidence', 'artifacts', 'gate-x_.._.._.._.._victim-dir-r1', 'out.txt'))).toBe(true);
  expect(existsSync(join(repo, 'victim-dir-r1'))).toBe(false);
});
