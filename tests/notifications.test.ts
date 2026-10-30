import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { notificationEvent, reconcileNotifications, commandSink, type NotificationEvent } from '../scripts/notifications.mjs';

const repo = '/disposable/repo';
const parked = (id = 'gate-1', kind = 'approval', owner = 'human') => ({ status: {
  task: { assignmentId: 'assignment-1', title: 'PRIVATE TITLE' },
  waiting: { state: 'current', kind, owner, gateId: id, question: 'PRIVATE PROMPT' },
}, runnerState: {} });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ben-notifications-'));
  writeFileSync(join(home, 'notifications.json'), JSON.stringify({enabled:true, argv:[process.execPath]}));
  const dir = join(home, 'notifications', createHash('sha256').update(repo).digest('hex'));
  return { home, dir, path: join(dir,'outbox.json') };
}
const read = (p: string) => JSON.parse(readFileSync(p,'utf8'));

test('notification audit: parks, limits, supervisor stops, needs-you, abandonment and completion; stale/model/transient states are silent', () => {
  for (const [gate, kind] of [['approval','park'],['limit','limit'],['supervisor-stop','stop'],['stop','stop'],['pr-branch-conflict','stop'],['pr-head-mismatch','stop'],['pr-migration','stop'],['manual-criterion','park']]) {
    const s=parked('g',gate);expect(notificationEvent(repo,s.status,s.runnerState)?.kind).toBe(kind);
  }
  const s=parked();
  expect(notificationEvent(repo,{...s.status,abandoned:true})?.reason).toBe('abandoned');
  expect(notificationEvent(repo,s.status,{needsYou:{at:'time',summary:'PRIVATE ERROR'}})?.kind).toBe('stop');
  expect(notificationEvent(repo,{task:{assignmentId:'a',pr:{url:'https://github.com/o/r/pull/1',headSha:'abc'}}})?.kind).toBe('complete');
  expect(notificationEvent(repo,{...s.status,waiting:{...s.status.waiting,state:'stale'}})).toBeNull();
  expect(notificationEvent(repo,parked('g','inspection','model').status)).toBeNull();
  expect(notificationEvent(repo,{task:s.status.task},{retries:{driver:{nextAt:999}}})).toBeNull();
  expect(JSON.stringify(notificationEvent(repo,s.status,{needsYou:{at:'time',summary:'PRIVATE ERROR'}}))).not.toContain('PRIVATE');
});

test('disabled notifications do not observe state, invoke a sink or create an outbox', () => {
  const home=mkdtempSync(join(tmpdir(),'ben-notify-off-'));
  const result=reconcileNotifications({home,repo,snapshot:()=>{throw new Error('must not observe');},send:()=>{throw new Error('must not send');}});
  expect(result.state).toBe('disabled');expect(existsSync(join(home,'notifications'))).toBe(false);
});

test('stable identity deduplicates across restarts; new gates, assignments and delivery heads produce new IDs', () => {
  const f=fixture();const sent:NotificationEvent[]=[];
  const run=(s:any)=>reconcileNotifications({...f,repo,snapshot:()=>s,send:(_,e)=>{sent.push(e);return true;}});
  run(parked());run(parked());expect(sent).toHaveLength(1);
  run(parked('gate-2'));expect(sent).toHaveLength(2);
  const next=parked('gate-2');next.status.task.assignmentId='assignment-2';run(next);expect(sent).toHaveLength(3);
  for(const sha of ['aaa','aaa','bbb'])run({status:{task:{assignmentId:'a',pr:{url:'https://github.com/o/r/pull/1',headSha:sha}}}});
  expect(sent).toHaveLength(5);expect(new Set(sent.map(e=>e.id)).size).toBe(5);
});

test('failed delivery persists bounded backoff before the sink; restart respects the exact deadline', () => {
  const f=fixture();let time=1000,calls=0;
  const run=()=>reconcileNotifications({...f,repo,snapshot:()=>parked(),now:()=>time,send:()=>{
    calls++;const row=read(f.path).items[0];expect(row.attempts).toBe(calls);expect(row.nextAt).toBeGreaterThan(time);return false;
  }});
  run();const deadline=read(f.path).items[0].nextAt;
  run();expect(calls).toBe(1);expect(read(f.path).items[0].nextAt).toBe(deadline);
  for(let i=0;i<4;i++){time=read(f.path).items[0].nextAt;run();}
  expect(read(f.path).items[0].state).toBe('exhausted');time+=1e9;run();expect(calls).toBe(5);
});

test('ambiguous acknowledgement retries the same ID; delivery can succeed without duplicate sink effects', () => {
  const f=fixture();let time=1000;const seen=new Set<string>();let calls=0;
  const run=()=>reconcileNotifications({...f,repo,snapshot:()=>parked(),now:()=>time,send:(_,e)=>{
    seen.add(e.id);calls++;if(calls===1)throw new Error('receipt lost');return true;
  }});
  run();time=read(f.path).items[0].nextAt;expect(run().state).toBe('delivered');run();
  expect(calls).toBe(2);expect(seen.size).toBe(1);
});

test('answered or replaced gates supersede pending alerts; unavailable observations do not discard them', () => {
  const f=fixture();let calls=0;
  const run=(s:any,time=1000)=>reconcileNotifications({...f,repo,snapshot:()=>s,now:()=>time,send:()=>{calls++;return false;}});
  run(parked());run(undefined,999999);expect(read(f.path).items[0].state).toBe('pending');
  run({status:{task:parked().status.task,waiting:{state:'answered'}}},999999);
  expect(read(f.path).items[0].state).toBe('superseded');expect(calls).toBe(1);
  run(parked('new'),999999);expect(calls).toBe(2);
});

test('malformed config/outbox and ambiguous/live locks preserve evidence and never send', () => {
  const f=fixture();let calls=0;
  const run=()=>reconcileNotifications({...f,repo,snapshot:()=>parked(),send:()=>{calls++;return true;}});
  mkdirSync(f.dir,{recursive:true});
  for(const lock of ['', 'not-a-pid', String(process.pid)]) {
    writeFileSync(join(f.dir,'lock'),lock);expect(run().state).toBe('busy');expect(readFileSync(join(f.dir,'lock'),'utf8')).toBe(lock);
  }
  // Separate fresh fixture for damaged state, so the ambiguous lock is preserved.
  const damaged=fixture();mkdirSync(damaged.dir,{recursive:true});writeFileSync(damaged.path,'{broken');
  expect(reconcileNotifications({...damaged,repo,snapshot:()=>parked(),send:()=>{calls++;return true;}}).state).toBe('error');
  expect(readFileSync(damaged.path,'utf8')).toBe('{broken');expect(calls).toBe(0);
  writeFileSync(join(damaged.home,'notifications.json'),JSON.stringify({enabled:true,argv:['relative-command']}));
  expect(reconcileNotifications({...damaged,repo,snapshot:()=>parked()}).state).toBe('error');
});

test('notification lock excludes another observer while the first sink executes', () => {
  const f=fixture();const second: ReturnType<typeof reconcileNotifications>[]=[];
  const result=reconcileNotifications({...f,repo,snapshot:()=>parked(),send:()=>{
    second.push(reconcileNotifications({...f,repo,snapshot:()=>parked(),send:()=>{throw new Error('duplicate sink');}}));return true;
  }});
  expect(result.state).toBe('delivered');expect(second[0]).toEqual({state:'busy'});
});

test('command sink sends JSON over stdin without a shell or inherited credentials; timeout and nonzero exit fail', () => {
  const f=fixture();const sink=join(f.home,'sink.mjs'), output=join(f.home,'received.json');
  writeFileSync(sink,`import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify({payload:JSON.parse(readFileSync(0,'utf8')),env:process.env,argv:process.argv.slice(2)}));`);
  const event=notificationEvent(repo,parked().status)!;
  const old=process.env.GH_TOKEN;process.env.GH_TOKEN='fake-secret-sentinel';
  try {expect(commandSink({argv:[process.execPath,sink,'$(never-run)']},event)).toBe(true);}finally{if(old===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=old;}
  expect(read(output).payload.id).toBe(event.id);expect(read(output).env.GH_TOKEN).toBeUndefined();expect(read(output).argv).toEqual(['$(never-run)']);
  expect(commandSink({argv:[process.execPath,'-e','process.exit(1)']},event)).toBe(false);
  expect(commandSink({argv:[process.execPath,'-e','setInterval(()=>{},1000)']},event)).toBe(false);
},10000);

test('a crashed dispatcher leaves its reserved attempt; two replacement processes reclaim the stale lock without duplicate delivery', async () => {
  const f=fixture();const script=join(f.home,'dispatcher.mjs');
  const modulePath=new URL('../scripts/notifications.mjs',import.meta.url).href;
  const delivered=join(f.home,'delivered.jsonl');
  writeFileSync(script,`import {reconcileNotifications} from ${JSON.stringify(modulePath)};
import {appendFileSync} from 'node:fs';
const crash=process.argv[2]==='crash';
const result=reconcileNotifications({home:${JSON.stringify(f.home)},repo:${JSON.stringify(repo)},snapshot:()=>(${JSON.stringify(parked())}),now:()=>crash?1000:999999,
send:(_,event)=>{if(crash)process.exit(17);appendFileSync(${JSON.stringify(delivered)},event.id+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);return true;}});
console.log(JSON.stringify(result));`);
  const launch=(mode:string)=>Bun.spawn([process.execPath,script,mode],{stdout:'pipe',stderr:'pipe'});
  const dead=launch('crash');expect(await dead.exited).toBe(17);
  expect(read(f.path).items[0]).toMatchObject({state:'pending',attempts:1,nextAt:61000});
  const before=read(f.path).items[0].event.id;
  const workers=[launch('recover'),launch('recover')];
  expect(await Promise.all(workers.map(w=>w.exited))).toEqual([0,0]);
  expect(readFileSync(delivered,'utf8').trim().split('\n')).toEqual([before]);
  expect(read(f.path).items[0]).toMatchObject({state:'delivered',attempts:2});
});

test('a temporarily stale gate that becomes current again resumes its pending alert without resetting retry accounting', () => {
  const f=fixture();let calls=0;
  const observe=(snapshot:any,time:number,success=false)=>reconcileNotifications({...f,repo,snapshot:()=>snapshot,now:()=>time,send:()=>{calls++;return success;}});
  observe(parked(),1000);
  const first=read(f.path).items[0];
  observe({status:{...parked().status,waiting:{state:'stale'}}},2000);
  expect(read(f.path).items[0].state).toBe('superseded');
  observe(parked(),3000);
  expect(calls).toBe(1);
  expect(read(f.path).items[0]).toMatchObject({state:'pending',attempts:1,nextAt:first.nextAt});
  expect(observe(parked(),first.nextAt,true).state).toBe('delivered');
  expect(calls).toBe(2);expect(read(f.path).items[0].event.id).toBe(first.event.id);
});
