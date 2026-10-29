import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const adapter = fileURLToPath(new URL('./adapter.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'timed out'); await delay(20); }
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ben-adapter-review-')));
  const runner = join(root, 'runner.mjs'), environment = join(root, 'environment.json');
  writeFileSync(environment, '{}');
  writeFileSync(runner, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'child.pid'))},String(process.pid));
process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(join(root, 'stopped'))},'stopped');process.exit(0);});
setInterval(()=>{},1000);
`);
  const files = Object.fromEntries([runner, environment].map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));
  const config = join(root, 'adapter.json');
  writeFileSync(config, JSON.stringify({ root, dir: root, repo: root, osHome: root, uid: process.getuid(), node: process.execPath, runner, environment, files }));
  return {root, config, runner};
}
test('adapter forwards SIGTERM and waits for its supervised child', async () => {
  const f = fixture();
  const proc = spawn(process.execPath, [adapter, f.config, 'serve'], {stdio:'ignore'});
  const done = new Promise(resolve => proc.once('exit', resolve));
  let childPid;
  try {
    await until(() => existsSync(join(f.root,'child.pid')));
    childPid = Number(readFileSync(join(f.root,'child.pid'),'utf8'));
    proc.kill('SIGTERM'); await done;
    await delay(50);
    assert.equal(alive(childPid), false, 'adapter exited while its child remained alive');
    assert.ok(existsSync(join(f.root,'stopped')));
  } finally {
    if (childPid && alive(childPid)) process.kill(childPid,'SIGKILL');
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
});

test('adapter rejects a config that omits required seals before spawning', async () => {
  const f = fixture();
  const cfg = JSON.parse(readFileSync(f.config,'utf8'));
  cfg.files = {};
  writeFileSync(f.config,JSON.stringify(cfg));
  const proc = spawn(process.execPath,[adapter,f.config,'serve'],{stdio:'ignore'});
  const code = await new Promise(resolve=>proc.once('exit',resolve));
  assert.equal(code,1);
  assert.equal(existsSync(join(f.root,'child.pid')),false);
});

test('adapter escalates shutdown when its child ignores SIGTERM', async () => {
  const f = fixture();
  writeFileSync(f.runner, `import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>{});
writeFileSync(${JSON.stringify(join(f.root,'child.pid'))},String(process.pid));
setInterval(()=>{},1000);
`);
  const cfg=JSON.parse(readFileSync(f.config,'utf8'));
  cfg.files[f.runner]=createHash('sha256').update(readFileSync(f.runner)).digest('hex');
  writeFileSync(f.config,JSON.stringify(cfg));
  const proc=spawn(process.execPath,[adapter,f.config,'serve'],{stdio:'ignore'});
  const done=new Promise(resolve=>proc.once('exit',resolve));
  let childPid;
  try {
    await until(()=>existsSync(join(f.root,'child.pid')));
    childPid=Number(readFileSync(join(f.root,'child.pid'),'utf8'));
    proc.kill('SIGTERM');
    const code=await done;
    assert.equal(code,1);
    assert.equal(alive(childPid),false);
  } finally {
    if(childPid&&alive(childPid)) process.kill(childPid,'SIGKILL');
    if(proc.exitCode===null&&proc.signalCode===null) proc.kill('SIGKILL');
  }
});

for (const marker of ['checkpoint-verification.json','checkpoint-verification.started.json']) {
  test(`verifier refuses a reused root (${marker}) before touching fixtures`, async () => {
    const f=fixture();
    writeFileSync(join(f.root,marker),'historical evidence');
    const verify=fileURLToPath(new URL('./verify-checkpoints.mjs',import.meta.url));
    const proc=spawn(process.execPath,[verify,f.root],{stdio:['ignore','ignore','pipe']});
    let error='';proc.stderr.on('data',v=>error+=v);
    const code=await new Promise(resolve=>proc.once('exit',resolve));
    assert.equal(code,1);
    assert.match(error,marker==='checkpoint-verification.json'?/Verification already completed/:/EEXIST/);
    assert.equal(readFileSync(join(f.root,marker),'utf8'),'historical evidence');
    assert.equal(existsSync(join(f.root,'adapter.jsonl')),false);
  });
}
