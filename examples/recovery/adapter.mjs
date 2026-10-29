#!/usr/bin/env node
// Fixture-specific launchd entry point. Never installs or controls a service.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, realpathSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const [configPath, mode] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.ok(['inspect','status','serve-once','run-once','serve'].includes(mode), 'Unsupported adapter mode');
const cfg = JSON.parse(readFileSync(configPath,'utf8'));
assert.equal(process.getuid(),cfg.uid,'Fixture belongs to another account');
assert.equal(realpathSync(cfg.root),cfg.root);
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
for (const required of [cfg.runner,cfg.environment]) assert.ok(cfg.files?.[required], `Missing required seal: ${required}`);
for (const [path, hash] of Object.entries(cfg.files)) assert.equal(digest(path),hash,`Fixture input changed: ${path}`);
const env = JSON.parse(readFileSync(cfg.environment,'utf8'));
// Entire environment is replaced; launchd/terminal credentials and BEN_* overrides cannot leak in.
env.HOME = cfg.osHome;
env.BEN_RUNNER_NO_REEXEC = '1';
if (mode === 'serve-once') env.BEN_RUNNER_SERVE_ONCE = '1';
if (existsSync(join(cfg.dir,'checkpoint.armed'))) {
  assert.ok(['active','publish:before-push','publish:after-push','publish:after-create'].includes(cfg.checkpoint));
  if (cfg.checkpoint === 'active') env.RECOVERY_ACTIVE_CHECKPOINT = join(cfg.dir,'active-entered.json');
  else env.BEN_RUNNER_PAUSE_AT = cfg.checkpoint;
}
const args = mode === 'status' ? ['status','--repo',cfg.repo,'--json'] : mode === 'run-once' ? ['run','--repo',cfg.repo,'--once'] : ['serve'];
if (mode === 'inspect') {
  console.log(JSON.stringify({uid:process.getuid(),node:cfg.node,runner:cfg.runner,cwd:cfg.repo,env},null,2));
} else {
  const child = spawn(cfg.node,[cfg.runner,...args],{cwd:cfg.repo,env,stdio:'inherit',detached:true});
  appendFileSync(join(cfg.dir,'adapter.jsonl'),JSON.stringify({at:new Date().toISOString(),mode,adapterPid:process.pid,childPid:child.pid})+'\n');
  let stopping = false, timer;
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid,signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    signalGroup(signal);
    timer = setTimeout(() => signalGroup('SIGKILL'),5000);
  };
  const term = () => stop('SIGTERM'), interrupt = () => stop('SIGINT');
  process.on('SIGTERM',term); process.on('SIGINT',interrupt);
  const cleanup = () => {
    clearTimeout(timer);
    if (stopping) signalGroup('SIGKILL');
    process.off('SIGTERM',term); process.off('SIGINT',interrupt);
  };
  child.on('error',e=>{cleanup();console.error(e.message);process.exitCode=1;});
  child.on('exit',(code,signal)=>{cleanup();process.exitCode=code ?? (signal ? 1 : 0);});
}
