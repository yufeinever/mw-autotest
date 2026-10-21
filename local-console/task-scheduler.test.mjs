import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskScheduler} from './task-scheduler.mjs';
import {normalizeConfig} from './policy.mjs';
import {createConsole,projectRoot} from './server.mjs';
import http from 'node:http';
import {pathToFileURL} from 'node:url';

const tick=()=>new Promise(r=>setImmediate(r));
const job=(id,strategy='parallel',port=9223,maxParallel=2)=>({id,status:'QUEUED',config:normalizeConfig({executionStrategy:strategy,maxParallel,cdpPort:port})});
const base='file:///MobileWork/resources/app-dist/index.html#/workspace/demo/session/';
const handoff=(s,id)=>{assert.equal(s.acquire(id,'PREPARING').granted,true);s.release(id,{url:base+'ses_'+id,sessionId:'ses_'+id});};

test('停止后重新执行：最后任务退出后新任务不继承旧页面，串行队列也能推进',()=>{
 for(const queued of [false,true]){
  const s=new TaskScheduler(),a=job('stopA','serial'),b=job('restartB','serial');
  s.enqueue(a,{cooperative:true,start:()=>{}});handoff(s,a.id);
  if(queued)s.enqueue(b,{cooperative:true,start:()=>{}});
  a.status='STOPPED';s.finish(a.id);
  if(!queued)s.enqueue(b,{cooperative:true,start:()=>{}});
  assert.equal(b.status,'RUNNING');
  assert.deepEqual(s.acquire(b.id,'PREPARING'),{granted:true,expectedUrl:null});
 }
});

test('停止后重新执行：未确认停止的会话保留页面保护，恢复后串行推进',()=>{
 const s=new TaskScheduler(),a=job('A'),b=job('B'),queued=job('C');
 for(const j of [a,b,queued])s.enqueue(j,{cooperative:true,start:()=>{}});
 handoff(s,'A');assert.equal(b.status,'QUEUED');
 queued.status='STOPPED';s.finish('C');
 s.finish('A',{unresolved:true});
 assert.equal(b.status,'QUEUED');assert.equal(s.renderer(9223).expectedUrl,base+'ses_A');
 b.status='STOPPED';s.finish('B');
 const next=job('next');s.enqueue(next,{cooperative:true,start:()=>{}});assert.equal(next.status,'QUEUED');
 const other=job('other','serial',9224);s.enqueue(other,{cooperative:true,start:()=>{}});handoff(s,'other');
 s.finish('A');assert.equal(next.status,'QUEUED','另一客户端用例也须串行');s.finish('other');assert.equal(next.status,'RUNNING');assert.equal(s.acquire('next','PREPARING').expectedUrl,null);
 assert.equal(s.renderer(9224).expectedUrl,null,'最后任务结束后清理本端口状态');
});

test('停止后重新执行：真实服务停止已登记会话的脚本后无需重启即可再次执行',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-stop-reexecute-')),fixture=path.join(dir,'cooperative.mjs');
 const aborted=[];
 const engine=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/session/status'){res.end('{}');return;}
  if(['/permission','/question'].includes(pathname)){res.end('[]');return;}
  const match=new URL(req.url,'http://localhost').pathname.match(/^\/session\/(ses_\w+)(\/abort)?$/);
  if(!match){res.statusCode=404;res.end('{}');return;}
  if(match[2]){aborted.push(match[1]);res.end('true');return;}
  res.end(JSON.stringify({id:match[1],directory:dir}));
 });
 await new Promise(r=>engine.listen(0,'127.0.0.1',r));
 const controlUrl=pathToFileURL(path.join(projectRoot,'scripts','mobilework-task-control.mjs')).href;
 await fs.writeFile(fixture,`// MW_TEST_CONFIG_JSON: isolated scheduler fixture; no MobileWork access.
import {createTaskControl} from ${JSON.stringify(controlUrl)};
const control=createTaskControl();
const sessionId='ses_fixture'+process.pid;
const page={url:()=>${JSON.stringify(base)}+sessionId};
await control.begin(page,{openComposer:false});
await control.checkpointDraft({url:page.url(),text:'fixture prompt',skills:[],selection:[{item:'expert',exit:'退出「模拟专家」'}]});
await control.registerSession(page,sessionId);
control.connection={baseUrl:'http://127.0.0.1:${engine.address().port}',opencodeUsername:'fixture',opencodePassword:'fixture'};
await control.release(page);
console.log('READY '+sessionId);
setInterval(()=>{},1000);
`);
 const {settleSession}=await import('./task-recovery.mjs');
 const app=await createConsole({port:0,dataDir:path.join(dir,'console'),cooperativeDetector:p=>p===fixture,recovery:async(job,{connection})=>({ready:await settleSession(null,job,connection),reason:'隔离模拟页面已交接'})});
 let token;const ids=[];
 const state=async()=>await(await fetch(app.url+'/api/state')).json();
 const post=async(route,body)=>{const r=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
 try{
  token=(await state()).token;
  const script=await post('/api/scripts',{name:'停止后重新执行隔离验证',path:fixture});
  for(let n=0;n<2;n++){
   const run=await post('/api/run',{scriptId:script.id,config:{executionStrategy:'serial'}});ids.push(run.id);
   let current;
   for(let i=0;i<100;i++){
    current=(await state()).jobs.find(j=>j.id===run.id);
    if(current.phase==='WAITING_MODEL'||!['RUNNING','QUEUED'].includes(current.status))break;
    await new Promise(r=>setTimeout(r,100));
   }
   assert.equal(current.status,'RUNNING');assert.ok(current.sessionId,'后续任务通过页面核对并登记独立会话');
   assert.deepEqual(current.submittedSelection,[{item:'expert',exit:'退出「模拟专家」'}]);assert.equal(current.ownedDraft,undefined);
   await post('/api/jobs/'+run.id+'/stop',{});
   const stopped=(await state()).jobs.find(j=>j.id===run.id);
   assert.equal(stopped.status,'STOPPED');assert.equal(stopped.schedulingHold,false);
   assert.ok(aborted.includes(current.sessionId));
  }
  assert.equal((await state()).active,0);assert.equal(aborted.length,2);
 }finally{
  for(const j of (await state()).jobs.filter(j=>ids.includes(j.id)&&['RUNNING','QUEUED','BLOCKED'].includes(j.status)))await post('/api/jobs/'+j.id+'/stop',{});
  await new Promise(r=>app.server.close(r));await new Promise(r=>engine.close(r));
 }
});

test('串行与旧并行参数均等待前条结束后按顺序推进',async()=>{
 for(const strategy of ['serial','parallel']){
  const s=new TaskScheduler(),started=[];
  for(const id of ['A','B','C'])s.enqueue(job(id,strategy),{cooperative:true,start:()=>started.push(id)});
  await tick();assert.deepEqual(started,['A']);handoff(s,'A');await tick();
  assert.deepEqual(started,['A']);
  s.finish('A');await tick();assert.deepEqual(started,['A','B']);
  handoff(s,'B');await tick();assert.deepEqual(started,['A','B'],'串行前条未结束/并行达到上限时，第三条仍排队');
  s.finish('B');await tick();assert.deepEqual(started,['A','B','C']);
 }
});

test('交还页面不会提前放行排队任务，不同客户端也只运行一条',async()=>{
 const s=new TaskScheduler();for(const id of ['A','B'])s.enqueue(job(id),{cooperative:true,start:()=>{}});
 handoff(s,'A');
 assert.equal(s.acquire('A','INTERACTING').granted,true);assert.throws(()=>s.acquire('B','EVIDENCE'),/没有在执行/);
 s.release('A',{url:base+'ses_A',sessionId:'ses_A'});
 const c=job('C','serial',9224);s.enqueue(c,{cooperative:true,start:()=>{}});assert.equal(c.status,'QUEUED');
 s.finish('A');handoff(s,'B');assert.equal(s.acquire('B','EVIDENCE').granted,true);
 s.finish('B');assert.equal(c.status,'RUNNING');
});

test('未接入分阶段调度的自定义脚本不会与其他脚本抢页面；取消排队与未结束会话暂停',async()=>{
 const s=new TaskScheduler(),started=[];
 const a=job('A'),b=job('B'),c=job('C');
 s.enqueue(a,{start:()=>started.push('A')});s.enqueue(b,{cooperative:true,start:()=>started.push('B')});s.enqueue(c,{cooperative:true,start:()=>started.push('C')});
 await tick();assert.deepEqual(started,['A']);b.status='STOPPED';s.finish('B');s.finish('A',{unresolved:true});await tick();assert.deepEqual(started,['A']);
 s.finish('A');await tick();assert.deepEqual(started,['A','C']);assert.throws(()=>s.acquire('B','PREPARING'),/没有在执行/);
});

test('策略非法参数拒绝，旧配置默认串行，排队不计为已完成',()=>{
 assert.equal(normalizeConfig().executionStrategy,'serial');assert.throws(()=>normalizeConfig({executionStrategy:'race'}),/策略/);
 for(const maxParallel of [0,17,1.5,'invalid'])assert.throws(()=>normalizeConfig({maxParallel}),/并行/);
});

test('真实服务把脚本排队，排队可取消且没有PID，服务重启不补跑',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-scheduler-http-'));
 let app=await createConsole({port:0,dataDir:dir});
 try{
  const s=await(await fetch(app.url+'/api/state')).json(),token=s.token;
  const post=async(route,body)=>{const r=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
  const script=await post('/api/scripts',{name:'隔离排队',path:path.join(projectRoot,'local-console','fixtures','long-running.mjs')});
  const one=await post('/api/run',{scriptId:script.id,config:{}}),two=await post('/api/run',{scriptId:script.id,config:{}});
  let state=await(await fetch(app.url+'/api/state')).json();const queued=state.jobs.find(j=>j.id===two.id);
  assert.equal(queued.status,'QUEUED');assert.equal(queued.startedAt,null);assert.equal(queued.pid,undefined);
  const batch=state.batches.find(b=>b.id===two.batchId);assert.equal(batch.finished,0);assert.equal(batch.queued,1);
  await post('/api/jobs/'+two.id+'/stop',{});state=await(await fetch(app.url+'/api/state')).json();assert.equal(state.jobs.find(j=>j.id===two.id).status,'STOPPED');
  await post('/api/jobs/'+one.id+'/stop',{});
  const interrupted={...queued,id:'queued-restart',status:'QUEUED'};
  await fs.mkdir(path.join(dir,'jobs',interrupted.id));await fs.writeFile(path.join(dir,'jobs',interrupted.id,'job.json'),JSON.stringify(interrupted));
  await new Promise(r=>app.server.close(r));app=await createConsole({port:0,dataDir:dir});
  const after=await(await fetch(app.url+'/api/state')).json();assert.equal(after.active,0);assert.equal(after.jobs.find(j=>j.id===interrupted.id).status,'INTERRUPTED');
 }finally{if(app.server.listening)await new Promise(r=>app.server.close(r));}
});
