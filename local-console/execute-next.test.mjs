import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {TaskScheduler} from './task-scheduler.mjs';
import {createConsole,projectRoot} from './server.mjs';
import {verifyNextSession} from './execute-next.mjs';

const base='file:///MobileWork/resources/app-dist/index.html#/workspace/demo/session/';
const makeJob=id=>({id,status:'QUEUED',config:{cdpPort:9223,executionStrategy:'serial',maxParallel:3}});
const handoff=(s,id)=>{assert.equal(s.acquire(id,'PREPARING').granted,true);s.release(id,{url:base+'ses_'+id,sessionId:'ses_'+id});};
test('手动放行仅下一条，保留当前运行及串行策略，去重并遵守页面锁及容量',async()=>{
 const s=new TaskScheduler(),started=[];const jobs=['a','b','c','d'].map(makeJob);
 for(const j of jobs)s.enqueue(j,{cooperative:true,start:()=>started.push(j.id)});
 await delay(0);assert.deepEqual(started,['a']);assert.equal(s.nextStatus('a').ready,false);
 handoff(s,'a');assert.equal(s.nextStatus('a').nextId,'b');
 s.acquire('a','INTERACTING');assert.throws(()=>s.advance('a','b'),/客户端正在/);s.release('a',{url:base+'ses_a',sessionId:'ses_a'});
 s.renderer(9223).unresolved.add('blocked');assert.equal(s.nextStatus('a').ready,false);s.renderer(9223).unresolved.clear();
 s.advance('a','b');await delay(0);assert.deepEqual(started,['a','b']);assert.equal(jobs[0].status,'RUNNING');assert.equal(jobs[0].config.executionStrategy,'serial');
 assert.throws(()=>s.advance('a','c'),/已经执行下条/);handoff(s,'b');await delay(0);assert.deepEqual(started,['a','b']);
 s.advance('b','c');handoff(s,'c');await delay(0);assert.deepEqual(started,['a','b','c']);assert.equal(s.nextStatus('c').ready,false);
 jobs[0].status='PASS';s.finish('a');assert.equal(s.nextStatus('c').ready,true);
 jobs[2].stopRequested=true;assert.equal(s.nextStatus('c').ready,false);delete jobs[2].stopRequested;
 s.entries.find(e=>e.job.id==='d').cooperative=false;assert.match(s.nextStatus('c').reason,/未接入/);
});

async function engineFixture(){
 const data={permissions:[],questions:[],type:'busy',aborted:[],calls:[]};
 // Track all sessions, so overlapping requests don't make the fake engine
 // depend on whichever session happened to be queried most recently.
 const sessions=new Set();const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://local');data.calls.push(u.pathname);res.setHeader('content-type','application/json');
  if(u.pathname==='/session/status')return res.end(JSON.stringify(Object.fromEntries([...sessions].map(id=>[id,{type:data.type}]))));
  if(u.pathname==='/permission')return res.end(JSON.stringify(data.permissions));
  if(u.pathname==='/question')return res.end(JSON.stringify(data.questions));
  const m=u.pathname.match(/^\/session\/(ses_\w+)(\/abort)?$/);
  if(m){sessions.add(m[1]);if(m[2]){data.aborted.push(m[1]);data.type='idle';return res.end('true');}return res.end(JSON.stringify({id:m[1],directory:'fixture-workspace'}));}
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {server,data,connection:{baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'fixture',opencodePassword:'fixture'}};
}
test('执行下条前读取真实会话状态，拒绝审批、提问及已空闲，不停止模型',async t=>{
 const engine=await engineFixture();t.after(()=>new Promise(r=>engine.server.close(r)));const job={sessionId:'ses_a'};
 await verifyNextSession(job,engine.connection);
 engine.data.permissions=[{sessionID:'ses_a'}];await assert.rejects(()=>verifyNextSession(job,engine.connection),/审批或回答/);
 engine.data.permissions=[];engine.data.questions=[{sessionID:'ses_a'}];await assert.rejects(()=>verifyNextSession(job,engine.connection),/审批或回答/);
 engine.data.questions=[];engine.data.type='idle';await assert.rejects(()=>verifyNextSession(job,engine.connection),/已空闲/);
 assert.deepEqual(engine.data.aborted,[]);
});
test('HTTP执行下条复用队列，无队列新建相邻脚本，重复点击不重发，结果分别保留',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-next-')),engine=await engineFixture(),fixture=path.join(dir,'runner.mjs');
 const controlUrl=pathToFileURL(path.join(projectRoot,'scripts/mobilework-task-control.mjs')).href;
 await fs.writeFile(fixture,`// MW_TEST_CONFIG_JSON isolated test
import {createTaskControl} from ${JSON.stringify(controlUrl)};
const control=createTaskControl(),sessionId='ses_fixture'+process.pid;let currentUrl=${JSON.stringify(base)};const page={url:()=>currentUrl};
const call=control.call.bind(control);control.call=async(action,body)=>{const r=await call(action,body);if(action==='acquire'&&r.granted&&r.expectedUrl)currentUrl=r.expectedUrl;return r;};
await control.begin(page,{openComposer:false});currentUrl=${JSON.stringify(base)}+sessionId;await control.registerSession(page,sessionId);
control.connection=${JSON.stringify(engine.connection)};await control.release(page);console.log('READY');setInterval(()=>{},1000);`);
 const second=path.join(dir,'second.mjs'),third=path.join(dir,'third.mjs');await fs.copyFile(fixture,second);await fs.copyFile(fixture,third);
 const app=await createConsole({port:0,dataDir:path.join(dir,'console'),cooperativeDetector:p=>[fixture,second,third].includes(p),recovery:async()=>({ready:true})});
 const state=async()=>await(await fetch(app.url+'/api/state')).json();const token=(await state()).token;
 const post=(route,body={})=>fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:JSON.stringify(body)});
 const ready=async id=>{for(let i=0;i<100;i++){const j=(await state()).jobs.find(j=>j.id===id);if(j?.phase==='WAITING_MODEL')return j;await delay(50);}throw Error('fixture did not release renderer');};
 try{
  const scripts=[];for(const file of [fixture,second,third])scripts.push(await(await post('/api/scripts',{path:file,name:path.basename(file)})).json());
  const a=await(await post('/api/run',{scriptId:scripts[0].id,config:{}})).json();await ready(a.id);
  const b=await(await post('/api/run',{scriptId:scripts[1].id,config:{}})).json();assert.equal((await state()).jobs.find(j=>j.id===b.id).status,'QUEUED');
  let r=await post('/api/jobs/'+a.id+'/next');assert.equal(r.status,200);assert.equal((await r.json()).id,b.id);await ready(b.id);
  r=await post('/api/jobs/'+a.id+'/next');assert.equal(r.status,200);assert.equal((await r.json()).id,b.id);assert.equal((await state()).jobs.length,2);
  r=await post('/api/jobs/'+b.id+'/next');assert.equal(r.status,200);const c=await r.json();await ready(c.id);
  const after=await state();assert.equal(after.jobs.length,3);assert.ok(after.jobs.every(j=>j.status==='RUNNING'));assert.equal(after.jobs.find(j=>j.id===a.id).manualNext.jobId,b.id);assert.equal(after.jobs.find(j=>j.id===c.id).scriptId,scripts[2].id);assert.deepEqual(engine.data.aborted,[]);
  assert.equal((await(await fetch(app.url+'/api/jobs/'+a.id)).json()).log.includes('当前任务继续运行'),true);
 }finally{
  for(const j of (await state()).jobs.filter(j=>['RUNNING','QUEUED'].includes(j.status)))await post('/api/jobs/'+j.id+'/stop');
  await new Promise(r=>app.server.close(r));await new Promise(r=>engine.server.close(r));await fs.rm(dir,{recursive:true,force:true});
 }
});
