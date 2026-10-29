#!/usr/bin/env node
// Preparation only: no launchctl, service installation, or OS transitions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, realpathSync, symlinkSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = process.argv[2];
assert.equal(process.argv.length, 3, 'Usage: node examples/recovery/prepare.mjs NEW_ABSOLUTE_DIRECTORY');
assert.ok(destination?.startsWith('/'), 'Use an absolute, persistent directory in the isolated test account');
// Exclusive creation: never reuse, reset, or delete an earlier experiment.
mkdirSync(destination, { mode: 0o700 });
const root = realpathSync(destination);
const transcript = join(root, 'transcript.txt');
writeFileSync(join(root, 'prepare-source.mjs'), readFileSync(fileURLToPath(import.meta.url)));
writeFileSync(join(root, 'README.md'), readFileSync(new URL('./README.md', import.meta.url)));
for (const name of ['adapter.mjs','adapter.test.mjs','verify-checkpoints.mjs']) writeFileSync(join(root,name),readFileSync(new URL('./'+name,import.meta.url)));
const clean = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', LANG: 'en_US.UTF-8' };
function command(exe, args, cwd = root, env = clean) {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  appendFileSync(transcript, `${JSON.stringify([exe, ...args])}\n${r.stdout ?? ''}${r.stderr ?? ''}\nexit=${r.status}\n`);
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim();
}
const sha = command('/usr/bin/git', ['rev-parse', 'HEAD'], source);
const tree = command('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], source);
command('/usr/bin/git', ['archive', '--format=tar', '--output=' + join(root, 'source.tar'), sha], source);
const runtime = join(root, 'source'); mkdirSync(runtime);
command('/usr/bin/tar', ['-xf', join(root, 'source.tar'), '-C', runtime]);
const bin = join(root, 'bin'); mkdirSync(bin);
symlinkSync(process.execPath, join(bin, 'node'));
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function shim(name, script) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  return path;
}
const stubs = join(runtime, 'tests/runner-stubs');
const driver = shim('claude', join(stubs, 'driver.mjs'));
const gh = shim('gh', join(stubs, 'gh.mjs'));
const codex = shim('codex', join(stubs, 'codex.mjs'));
const reviewerScript = join(root, 'reviewer.mjs');
writeFileSync(reviewerScript, `import {writeFileSync} from 'node:fs';\nconst a=process.argv.slice(2), i=a.indexOf('-o');\nif(i<0 || !a[i+1]) process.exit(64);\nwriteFileSync(a[i+1], JSON.stringify({verdict:'GO',blockers:[]}));\n`);
const reviewer = shim('reviewer', reviewerScript);
const handler = join(root, 'actor.mjs');
writeFileSync(handler, `import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
export async function handle(instruction, ctx) {
  if (/Write the plan artifacts/.test(instruction)) {
    if (ctx.env.RECOVERY_SCENARIO === 'backoff') return {isError:true,text:'503 overloaded'};
    const s=join(ctx.cwd,'.ben');
    for (const [name, data] of Object.entries({
      'plan.md':'# Plan\\nAdd subtract per brief.md.\\n',
      'criteria.json':JSON.stringify({taskId:'recovery',criteria:[{id:'C1',statement:'subtract works',verification:{method:'command',command:'node --test'}}]}),
      'promises.json':'[]','plan-files.json':'["subtract.mjs"]','gates.json':'{"test":"node --test"}'
    })) writeFileSync(join(s,name),data);
    return {cost:ctx.env.RECOVERY_SCENARIO === 'budget' ? 1 : 0.11};
  }
  if (/Implement the plan and commit|No commits|You finished without committing|verify commits/.test(instruction)) {
    if (ctx.env.RECOVERY_ACTIVE_CHECKPOINT) {
      writeFileSync(ctx.env.RECOVERY_ACTIVE_CHECKPOINT,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
      await new Promise((_,reject)=>setTimeout(()=>reject(new Error('active checkpoint timed out')),60000));
    }
    writeFileSync(join(ctx.cwd,'subtract.mjs'),'export const subtract = (a,b) => a-b;\\n');
    execFileSync('git',['add','subtract.mjs'],{cwd:ctx.cwd});
    execFileSync('git',['commit','-qm','Implement scripted subtraction'],{cwd:ctx.cwd});
  }
  return {cost:0.02,text:'scripted actor'};
}
`);
const json = (p,v) => writeFileSync(p, JSON.stringify(v,null,2)+'\n');
const read = p => JSON.parse(readFileSync(p,'utf8'));
const runner = join(runtime, 'scripts/runner.mjs');
const fixtures = [];
for (const scenario of ['approval', 'budget', 'backoff', 'runnable', 'smoke', 'active', 'before-push', 'after-push', 'after-create']) {
  const dir = join(root, scenario); mkdirSync(dir);
  const repo = join(dir,'repo'), home = join(dir,'runner-home'), remote = join(dir,'remote.git');
  for (const p of [repo,home,remote]) mkdirSync(p);
  const env = { ...clean, PATH: bin + ':/usr/bin:/bin', TMPDIR: dir,
    BEN_RUNNER_HOME:home, BEN_DRIVER_CLI:driver, BEN_GH_CLI:gh, BEN_CODEX_CLI:codex,
    BEN_REVIEWER_CLI_REAL:reviewer, BEN_STUB_DRIVER_HANDLER:handler,
    BEN_STUB_DRIVER_LOG:join(dir,'driver.jsonl'), BEN_STUB_GH_LOG:join(dir,'gh.jsonl'),
    BEN_STUB_GH_STORE:join(dir,'gh-store.json'), BEN_STUB_REMOTE:remote,
    BEN_RUNNER_NO_PROBE:'1', BEN_RUNNER_SERVICE_CHILD:'1', BEN_RUNNER_BACKOFF_MS:'86400000',
    RECOVERY_SCENARIO:scenario, GIT_CONFIG_GLOBAL:join(home,'gitconfig') };
  json(join(dir,'environment.json'),env);
  const git = (...a) => command('/usr/bin/git',a,repo,env);
  command('/usr/bin/git',['init','--bare','-q','-b','main',remote]);
  git('init','-q','-b','main'); git('config','user.name','operator'); git('config','user.email','operator@example.invalid');
  writeFileSync(join(repo,'subtract.mjs'),'export const subtract = (a,b) => a+b;\n');
  writeFileSync(join(repo,'subtract.test.mjs'),"import {test} from 'node:test'; import assert from 'node:assert/strict'; import {subtract} from './subtract.mjs'; test('subtract',()=>assert.equal(subtract(5,2),3));\n");
  git('add','.'); git('commit','-qm','Initialize disposable recovery fixture');
  git('remote','add','origin','https://github.com/o/r.git');
  writeFileSync(join(home,'gitconfig'),`[url ${JSON.stringify(remote)}]\n\tinsteadOf = https://github.com/o/r.git\n`);
  command('/usr/bin/git',['push','-q',remote,'main'],repo,env);
  const ben = args => command(process.execPath,[runner,...args],repo,env);
  ben(['assign','--repo',repo,'--inline', ...(scenario==='budget'?['--usd','0.5']:[]), 'Add subtract per the existing subtraction test']);
  const taskPath = join(repo,'.ben/task.json'), statePath = join(repo,'.ben/runner/state.json');
  const task = read(taskPath);
  if (scenario === 'backoff') assert.ok(read(statePath).retries['driver-transient'].nextAt > Date.now());
  else assert.equal(task.gate.kind, scenario === 'budget' ? 'limit' : 'approval');
  const checkpoint = scenario === 'active' ? 'active' : ['before-push','after-push','after-create'].includes(scenario) ? 'publish:'+scenario : null;
  if (['runnable','smoke'].includes(scenario) || checkpoint) {
    command(process.execPath,[join(runtime,'scripts/run.mjs'),'answer','--repo',repo,'--expect-gate',task.gate.id,'--choose','approve','--by','operator'],repo,env);
  }
  json(join(home,'registry.json'),{repos:[repo]});
  if (scenario !== 'runnable' && !checkpoint) {
    const before = readFileSync(taskPath,'utf8');
    const retryBefore = scenario === 'backoff' ? JSON.stringify(read(statePath).retries) : null;
    command(process.execPath,[runner,'serve'],repo,{...env,BEN_RUNNER_SERVE_ONCE:'1'});
    if (scenario === 'smoke') {
      assert.ok(read(taskPath).pr, 'offline smoke must deliver a fake PR');
      const store = read(env.BEN_STUB_GH_STORE);
      assert.equal(store.prs.length, 1);
      const beforeStore = readFileSync(env.BEN_STUB_GH_STORE,'utf8');
      const beforeTask = readFileSync(taskPath,'utf8');
      const beforeActors = readFileSync(env.BEN_STUB_DRIVER_LOG,'utf8');
      command(process.execPath,[runner,'serve'],repo,{...env,BEN_RUNNER_SERVE_ONCE:'1'});
      assert.equal(readFileSync(env.BEN_STUB_GH_STORE,'utf8'),beforeStore);
      assert.equal(readFileSync(taskPath,'utf8'),beforeTask);
      assert.equal(readFileSync(env.BEN_STUB_DRIVER_LOG,'utf8'),beforeActors);
      json(join(dir,'fake-publication.json'),store);
    } else {
      assert.equal(readFileSync(taskPath,'utf8'),before,'parked task changed');
      if (retryBefore) assert.equal(JSON.stringify(read(statePath).retries),retryBefore);
    }
  }
  assert.equal(existsSync(join(repo,'.ben/runner.lock')),false,'runner must release its lock');
  for (const row of readFileSync(env.BEN_STUB_DRIVER_LOG,'utf8').trim().split('\n').map(JSON.parse)) {
    assert.equal(row.env.GH_TOKEN,null);
  }
  json(join(dir,'baseline-task.json'),read(taskPath));
  json(join(dir,'baseline-runner.json'),read(statePath));
  json(join(dir,'status.json'),JSON.parse(ben(['status','--repo',repo,'--json'])));
  const osHome = join(dir,'os-home'); mkdirSync(osHome);
  const environment = join(dir,'environment.json');
  const sealed = [environment, join(home,'registry.json'), join(home,'gitconfig'), handler, reviewerScript, driver, gh, codex, reviewer, join(root,'adapter.mjs')];
  for (const name of ['driver.mjs','gh.mjs','codex.mjs']) sealed.push(join(stubs,name));
  // Seal the complete captured runtime; never depend on the mutable source checkout.
  for (const folder of ['scripts','prompts','schemas','references']) for (const name of Object.keys(hashes(join(runtime,folder)))) sealed.push(join(runtime,folder,name));
  sealed.push(join(runtime,'SKILL.md'),process.execPath,join(bin,'node'));
  // Trusted children execute the per-task pin, not necessarily the source snapshot.
  const pinFiles = readdirSync(join(home,'tasks')).map(key=>join(home,'tasks',key,'runtime.json')).filter(existsSync);
  assert.equal(pinFiles.length,1,'Expected exactly one task runtime pin');
  for (const pinFile of pinFiles) {
    sealed.push(pinFile);
    const pinned = read(pinFile).dir;
    assert.ok(pinned.startsWith(home+'/runtime/'));
    for (const name of Object.keys(hashes(pinned))) sealed.push(join(pinned,name));
  }
  const files = Object.fromEntries(sealed.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
  const config = join(dir,'adapter.json');
  json(config,{root,dir,repo,osHome,environment,node:process.execPath,runner,uid:process.getuid(),checkpoint,files});
  const xml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const label = 'com.ben.recovery.' + createHash('sha256').update(dir).digest('hex').slice(0,12);
  writeFileSync(join(dir,'service-preview.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[process.execPath,join(root,'adapter.mjs'),config,'serve'].map(v=>'<string>'+xml(v)+'</string>').join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(dir,'service.out'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir,'service.err'))}</string>
</dict></plist>
`);
  command('/usr/bin/plutil',['-lint',join(dir,'service-preview.plist')]);
  fixtures.push({scenario,repo,home,remote,config,checkpoint,state:scenario==='smoke'?'fake PR delivered':scenario});
}
function hashes(dir, prefix='') {
  const entries = {};
  for(const name of readdirSync(dir).sort()) {
    const p=join(dir,name), key=prefix+name, st=lstatSync(p);
    if(st.isDirectory()) Object.assign(entries,hashes(p,key+'/'));
    else if(st.isFile() || st.isSymbolicLink()) entries[key]=createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return entries;
}
json(join(root,'fixtures.json'),fixtures);
command(process.execPath,[join(root,'verify-checkpoints.mjs'),root]);
json(join(root,'manifest.json'),{createdAt:new Date().toISOString(),sourceSha:sha,sourceTree:tree,node:process.version,root,fixtures,checks:['scripted assignment','approval and budget parks unchanged after one-shot serve','retry deadline unchanged after one-shot serve','approved runnable fixture retained','offline one-shot serve delivered exactly one fake PR; repeat did not relaunch or mutate it'],notTested:['installed service environment','sleep/wake','logout/login','reboot'],files:hashes(root)});
console.log(`Prepared and checked ${root}\nNo service installed; no OS transition performed.`);
