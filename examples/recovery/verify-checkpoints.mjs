#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,renameSync,mkdirSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const root=process.argv[2], adapter=join(root,'adapter.mjs');
assert.equal(existsSync(join(root,'checkpoint-verification.json')),false,'Verification already completed; use a fresh fixture root');
writeFileSync(join(root,'checkpoint-verification.started.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()})+'\n',{flag:'wx'});
const fixtures=JSON.parse(readFileSync(join(root,'fixtures.json'),'utf8'));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const json=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const clean={PATH:'/usr/bin:/bin', GH_TOKEN:'POISON',OPENAI_API_KEY:'POISON',BEN_DRIVER_CLI:'/not-a-stub',BEN_RUNNER_HOME:'/wrong-home'};
const receipt={checks:[],checkpoints:[]};
function call(config,mode,expected=0) {
  const r=spawnSync(process.execPath,[adapter,config,mode],{env:clean,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  appendFileSync(join(root,'adapter-verification.txt'),`${mode} ${config}\n${r.stdout}${r.stderr}\nexit=${r.status}\n`);
  assert.ifError(r.error); assert.equal(r.status,expected,r.stderr+r.stdout); return r.stdout;
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const signal=(pid,sig)=>{assert.ok(Number.isInteger(pid)&&Math.abs(pid)>1);try{process.kill(pid,sig);}catch(e){if(e.code!=='ESRCH')throw e;}};
async function waitFor(predicate, label) {
  const end=Date.now()+45000;
  while(!predicate()){assert.ok(Date.now()<end,`Timed out: ${label}`); await delay(25);}
}
for(const f of fixtures) {
  const view=JSON.parse(call(f.config,'inspect'));
  assert.equal(view.env.GH_TOKEN,undefined);assert.equal(view.env.OPENAI_API_KEY,undefined);
  assert.equal(view.env.BEN_RUNNER_HOME,f.home);assert.ok(view.env.BEN_DRIVER_CLI.startsWith(root+'/bin/'));
  assert.equal(view.env.GIT_ALLOW_PROTOCOL,'file');
  if(['approval','budget','backoff','smoke'].includes(f.scenario)) {
    const task=readFileSync(join(f.repo,'.ben/task.json'),'utf8');
    const retries=read(join(f.repo,'.ben/runner/state.json')).retries;
    call(f.config,'serve-once');
    assert.equal(readFileSync(join(f.repo,'.ben/task.json'),'utf8'),task);
    assert.deepEqual(read(join(f.repo,'.ben/runner/state.json')).retries,retries);
  }
}
receipt.checks.push('all adapters discard hostile inherited credentials and BEN overrides','parked and delivered tasks unchanged under adapter supervision');
const base=read(fixtures[0].config);
for(const [name,cfg] of [ ['wrong-uid',{...base,uid:-1}], ['missing-input',{...base,files:{...base.files,[join(root,'missing-stub')]:'none'}}], ['changed-input',{...base,files:{...base.files,[base.environment]:'incorrect'}}], ['missing-seal',{...base,files:{}}] ]) {
  const p=join(root,name+'.json'); json(p,cfg);call(p,'serve-once',1);
}
call(fixtures[0].config,'install',1);
// Mutate only a disposable pinned code copy, then restore its original bytes.
const pinFile=Object.keys(base.files).find(p=>p.includes('/tasks/')&&p.endsWith('/runtime.json'));
assert.ok(pinFile,'task runtime pin must be sealed');
const pinnedRunner=join(read(pinFile).dir,'scripts/runner.mjs');
assert.ok(base.files[pinnedRunner],'executed pinned code must be sealed');
const original=readFileSync(pinnedRunner);
try {
  appendFileSync(pinnedRunner,'\n// deliberate offline integrity-test mutation\n');
  call(fixtures[0].config,'inspect',1);
} finally { writeFileSync(pinnedRunner,original); }
call(fixtures[0].config,'inspect');
receipt.checks.push('wrong account, missing seals, changed pinned runtime, missing/changed sealed input and unsupported install mode refused');
for(const f of fixtures.filter(f=>f.checkpoint)) {
  const dir=join(root,f.scenario), taskPath=join(f.repo,'.ben/task.json'),statePath=join(f.repo,'.ben/runner/state.json');
  const baseline=read(taskPath), limits=baseline.assignment.limits;
  const evidence=join(dir,'checkpoint-evidence');mkdirSync(evidence);
  writeFileSync(join(dir,'checkpoint.armed'),f.checkpoint+'\n',{flag:'wx'});
  const marker=f.checkpoint==='active'?join(dir,'active-entered.json'):join(f.repo,'.ben/.runner-paused-'+f.checkpoint.replaceAll(':','_'));
  assert.equal(existsSync(marker),false);
  const child=spawn(process.execPath,[adapter,f.config,'serve-once'],{env:clean,detached:true,stdio:['ignore','pipe','pipe']});
  let output='',runnerPid,actorPid,finished=false;
  child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{finished=true;resolve({code,signal});});});
  try {
    await waitFor(()=>existsSync(marker)||finished,'checkpoint marker');
    assert.ok(existsSync(marker),output);
    runnerPid=Number(readFileSync(join(f.repo,'.ben/runner.lock'),'utf8'));
    assert.ok(alive(runnerPid));
    if(f.checkpoint==='active') {
      actorPid=read(marker).pid;
      assert.equal(read(statePath).currentStretchPid,actorPid);assert.ok(alive(actorPid));
      const launches=readFileSync(join(dir,'driver.jsonl'),'utf8');
      call(f.config,'run-once',2);
      assert.equal(readFileSync(join(dir,'driver.jsonl'),'utf8'),launches,'second writer launched actor');
    } else assert.equal(Number(readFileSync(marker,'utf8')),runnerPid);
    json(join(evidence,'at-checkpoint.json'),{runnerPid,actorPid,task:read(taskPath),state:read(statePath),marker:readFileSync(marker,'utf8'),store:existsSync(join(dir,'gh-store.json'))?read(join(dir,'gh-store.json')):null});
    writeFileSync(join(evidence,'stretches-before.jsonl'),readFileSync(join(f.repo,'.ben/runner/stretches.jsonl')));
    // Kill only the runner we just observed owning this fresh fixture's lock.
    signal(runnerPid,'SIGKILL');
    await waitFor(()=>finished,'supervisor exits after interrupted worker');await done;
    if(actorPid) assert.ok(alive(actorPid),'active driver must survive the interrupted runner');
    renameSync(join(dir,'checkpoint.armed'),join(evidence,'checkpoint.disarmed'));
    // Preserve stale locks and markers. Production recovery must resolve ownership itself.
    call(f.config,'serve-once');
    const recovered=read(taskPath);
    if (['publish:before-push','publish:after-push'].includes(f.checkpoint)) {
      assert.equal(recovered.gate.kind,'pr-retry');
      assert.equal(recovered.pr,undefined);
      assert.equal((existsSync(join(dir,'gh-store.json')) ? read(join(dir,'gh-store.json')).prs : []).length,0);
      json(join(evidence,'human-retry-park.json'),recovered);
      const parked=readFileSync(taskPath,'utf8');
      call(f.config,'serve-once');assert.equal(readFileSync(taskPath,'utf8'),parked);
      // Explicit scripted operator action through the sequencer, never a state-file edit.
      const environment=JSON.parse(call(f.config,'inspect')).env;
      const answer=spawnSync(process.execPath,[join(root,'source/scripts/run.mjs'),'answer','--repo',f.repo,'--expect-gate',recovered.gate.id,'--choose','retry','--by','operator'],{cwd:f.repo,env:environment,encoding:'utf8',timeout:30000});
      writeFileSync(join(evidence,'scripted-retry.txt'),answer.stdout+answer.stderr);
      assert.ifError(answer.error);assert.equal(answer.status,0,answer.stderr+answer.stdout);
      call(f.config,'serve-once');
    }
    const after=read(taskPath);
    assert.ok(after.pr,'recovery did not deliver fake PR');
    assert.deepEqual(after.assignment.limits,limits);
    const prs=read(join(dir,'gh-store.json')).prs;
    assert.equal(prs.length,1);assert.equal(prs[0].headRefOid,after.pr.headSha);
    if(f.checkpoint==='publish:after-push') assert.match(readFileSync(join(f.repo,'.ben/runner/runner.log'),'utf8'),/push skipped/);
    if(f.checkpoint==='publish:after-create') assert.equal((after.prRetries??[]).length,0);
    const status=JSON.parse(call(f.config,'status'));
    assert.equal(status.sequencer.actors.filter(a=>a.kind==='approval').length,1);
    if(actorPid) {
      await waitFor(()=>!alive(actorPid),'orphan driver reaped');
      const rows=readFileSync(join(f.repo,'.ben/runner/stretches.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const old=read(join(evidence,'at-checkpoint.json')).state.currentStretch;
      assert.ok(rows.some(r=>r.type==='launched'&&r.id===old));
      assert.equal(rows.some(r=>r.type==='completed'&&r.id===old),false,'interrupted launch must not gain a fake completion');
      const {accountTotals}=await import(join(root,'source/scripts/runner.lib.mjs'));
      assert.ok(accountTotals(rows).cappedUsd>=rows.find(r=>r.type==='launched'&&r.id===old).capUsd);
    }
    const store=readFileSync(join(dir,'gh-store.json'),'utf8'),task=readFileSync(taskPath,'utf8'),actors=readFileSync(join(dir,'driver.jsonl'),'utf8');
    call(f.config,'serve-once');
    assert.equal(readFileSync(join(dir,'gh-store.json'),'utf8'),store);
    assert.equal(readFileSync(taskPath,'utf8'),task);assert.equal(readFileSync(join(dir,'driver.jsonl'),'utf8'),actors);
    assert.equal(existsSync(join(f.repo,'.ben/runner.lock')),false);
    json(join(evidence,'recovered.json'),{task:after,state:read(statePath),status,store:JSON.parse(store)});
    receipt.checkpoints.push({checkpoint:f.checkpoint,passed:true,runnerPid,actorPid,staleLocksRemovedByHarness:false});
  } finally {
    // Only known fixture-owned processes may be terminated; never touch another service.
    if(runnerPid&&alive(runnerPid)) signal(runnerPid,'SIGKILL');
    if(actorPid&&alive(actorPid)) signal(-actorPid,'SIGKILL');
    const ownedActor=read(statePath).currentStretchPid;
    if(ownedActor&&alive(ownedActor)) signal(-ownedActor,'SIGKILL');
    if(!finished) {
      child.kill('SIGTERM');
      await waitFor(()=>finished,'adapter shutdown');
      await done;
    }
    writeFileSync(join(evidence,'supervisor.txt'),output);
  }
}
json(join(root,'checkpoint-verification.json'),receipt);
console.log('Adapter and four checkpoint recovery drills passed offline. No OS transitions.');
