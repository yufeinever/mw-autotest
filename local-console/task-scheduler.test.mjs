import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskScheduler} from './task-scheduler.mjs';
import {normalizeConfig} from './policy.mjs';
import {createConsole,projectRoot} from './server.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
const job=(id,strategy='parallel',port=9223,maxParallel=2)=>({id,status:'QUEUED',config:normalizeConfig({executionStrategy:strategy,maxParallel,cdpPort:port})});
const base='file:///MobileWork/resources/app-dist/index.html#/workspace/demo/session/';
const handoff=(s,id)=>{assert.equal(s.acquire(id,'PREPARING').granted,true);s.release(id,{url:base+'ses_'+id,sessionId:'ses_'+id});};

test('串行等待前条结束；并行按顺序提交、等待模型重叠、限制任务数',async()=>{
 for(const strategy of ['serial','parallel']){
  const s=new TaskScheduler(),started=[];
  for(const id of ['A','B','C'])s.enqueue(job(id,strategy),{cooperative:true,start:()=>started.push(id)});
  await tick();assert.deepEqual(started,['A']);handoff(s,'A');await tick();
  assert.deepEqual(started,strategy==='serial'?['A']:['A','B']);
  if(strategy==='serial'){s.finish('A');await tick();assert.deepEqual(started,['A','B']);}
  handoff(s,'B');await tick();assert.deepEqual(started,['A','B'],'串行前条未结束/并行达到上限时，第三条仍排队');
  s.finish(strategy==='serial'?'B':'A');await tick();assert.deepEqual(started,['A','B','C']);
 }
});

test('页面操作轮流进行，交互完成交还页面；不同客户端不互相阻塞',async()=>{
 const s=new TaskScheduler();for(const id of ['A','B'])s.enqueue(job(id),{cooperative:true,start:()=>{}});
 handoff(s,'A');handoff(s,'B');
 assert.equal(s.acquire('A','INTERACTING').granted,true);assert.equal(s.acquire('B','EVIDENCE').granted,false);
 s.release('A',{url:base+'ses_A',sessionId:'ses_A'});
 assert.equal(s.acquire('B','EVIDENCE').granted,true);assert.equal(s.acquire('A','INTERACTING').granted,false);
 const c=job('C','serial',9224);s.enqueue(c,{cooperative:true,start:()=>{}});assert.equal(c.status,'RUNNING');
 s.finish('B');assert.equal(s.acquire('A','INTERACTING').granted,true);
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
