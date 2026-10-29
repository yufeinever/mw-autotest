import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole,projectRoot} from './server.mjs';
import {killScript,releaseOwnedLock} from './stop-job.mjs';
import {canStopJob} from './stop-all.mjs';

test('已收尾历史阻塞记录不再进入停止全部，直接停止也不重建页面锁',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-settled-history-'));
 const job={id:'settled-history',status:'BLOCKED',sessionId:'ses_history',sessionSettled:true,schedulingHold:false,isolationVersion:2,cooperative:true,startedAt:new Date().toISOString(),config:{cdpPort:1},log:'original evidence',handoff:{ready:true}};
 assert.equal(canStopJob(job),false);
 assert.equal(canStopJob({...job,schedulingHold:true}),true,'仍有真实交接锁时允许收尾');
 assert.equal(canStopJob({...job,sessionSettled:false}),true,'未结束会话仍可停止');
 await fs.mkdir(path.join(dataDir,'jobs',job.id),{recursive:true});
 await fs.writeFile(path.join(dataDir,'jobs',job.id,'job.json'),JSON.stringify(job));
 let recoveries=0;
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir,recovery:async()=>{recoveries++;return {ready:false};}});
 try{
  const s=await fetch(url+'/api/state').then(r=>r.json());
  const r=await fetch(url+'/api/jobs/'+job.id+'/stop',{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:'{}'});
  assert.equal(r.status,409);
  const current=await fetch(url+'/api/jobs/'+job.id).then(r=>r.json());
  assert.equal(current.status,'BLOCKED');assert.equal(current.schedulingHold,false);
  assert.equal(current.log,'original evidence');assert.equal(recoveries,0);
 }finally{await new Promise(r=>server.close(r));}
});

test('FAIL会话及页面交接保护可收尾，已结束且无交接保护不能再停止',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-failed-live-'));
 const job={id:'failed-live',status:'FAIL',schedulingHold:true,sessionId:'ses_isolated',startedAt:new Date().toISOString(),config:{cdpPort:1},log:''};
 assert.equal(canStopJob(job),true);assert.equal(canStopJob({...job,modelCompleted:true}),true);assert.equal(canStopJob({...job,modelCompleted:true,schedulingHold:false}),false);assert.equal(canStopJob({...job,schedulingHold:false}),false);
 await fs.mkdir(path.join(dataDir,'jobs',job.id),{recursive:true});await fs.writeFile(path.join(dataDir,'jobs',job.id,'job.json'),JSON.stringify(job));
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir});
 try{
  const s=await fetch(url+'/api/state').then(r=>r.json());
  const r=await fetch(url+'/api/jobs/'+job.id+'/stop',{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:'{}'});
  assert.equal(r.status,200,'不能以脚本已结束为由拒绝清理未完成会话');
  const current=await fetch(url+'/api/jobs/'+job.id).then(r=>r.json());
  assert.equal(current.status,'BLOCKED');assert.equal(current.schedulingHold,true,'未连接隔离客户端，不能伪造停止成功');
 }finally{await new Promise(r=>server.close(r));}
});

test('准备阶段未登记Session的阻塞任务可停止并释放调度锁',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-no-session-stop-'));
 const job={id:'no-session-hold',status:'BLOCKED',schedulingHold:true,pid:999999,path:path.join(projectRoot,'scripts','run-client-case001.mjs'),startedAt:new Date().toISOString(),config:{cdpPort:1},cooperative:true,log:'准备阶段未登记Session'};
 await fs.mkdir(path.join(dataDir,'jobs',job.id),{recursive:true});await fs.writeFile(path.join(dataDir,'jobs',job.id,'job.json'),JSON.stringify(job));
 const {server,url}=await createConsole({port:0,dataDir});
 try{
  const s=await fetch(url+'/api/state').then(r=>r.json());
  const r=await fetch(url+'/api/jobs/'+job.id+'/stop',{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:'{}'});
  assert.equal(r.status,200);
  const current=await fetch(url+'/api/jobs/'+job.id).then(r=>r.json());
  assert.equal(current.status,'STOPPED');assert.equal(current.schedulingHold,false);assert.match(current.error,/未获取会话 ID/);
 }finally{await new Promise(r=>server.close(r));}
});

test('只释放本次执行锁，并保留截图供报告读取',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-stop-lock-')),dir=path.join(root,'runs','本次执行');
 await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'1018-1600-01-现场.png'),'evidence');
 const lock=path.join(root,'runs','.client-case001.lock');await fs.writeFile(lock,JSON.stringify({pid:123,dir}));
 await releaseOwnedLock({pid:999},root);assert.ok(await fs.stat(lock));
 const job={pid:123};await releaseOwnedLock(job,root);assert.equal(job.result.evidence.length,1);
 assert.equal(await fs.readFile(path.join(dir,'1018-1600-01-现场.png'),'utf8'),'evidence');
 await assert.rejects(()=>fs.stat(lock),{code:'ENOENT'});
});
test('拒绝无 PID 和无关进程',async()=>{
 await assert.rejects(()=>killScript({}),/进程/);
 await assert.rejects(()=>killScript({pid:process.pid,path:'NOT-THE-TEST-RUNNER',startedAt:new Date().toISOString()}),/身份/);
});
test('通过页面停止真实隔离脚本，保留日志、结束时间、报告并释放运行位',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-stop-'));
 const {server,url}=await createConsole({port:0,dataDir});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 let jobId,token;
 try{
  let s=await(await fetch(url+'/api/state')).json();
  const post=(route,data)=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:JSON.stringify(data)});
  const script=await(await post('/api/scripts',{path:path.join(projectRoot,'local-console','fixtures','long-running.mjs'),name:'停止测试'})).json();
  const job=await(await post('/api/run',{scriptId:script.id,config:{}})).json();
  jobId=job.id;token=s.token;
  const page=await browser.newPage();await page.goto(url);
  await page.locator('#scriptPageSize').selectOption('50');
  const row=page.locator('#scripts tr').filter({hasText:'停止测试'});
  await row.getByRole('button',{name:'强制停止',exact:true}).click();
  await page.locator('#historyRows').getByText('已强制停止',{exact:true}).waitFor();
  s=await(await fetch(url+'/api/state')).json();const stopped=s.jobs.find(j=>j.id===job.id);
  assert.equal(s.active,0);assert.equal(stopped.status,'STOPPED');assert.ok(stopped.endedAt);
  assert.throws(()=>process.kill(stopped.pid,0));
  assert.match(await fs.readFile(path.join(dataDir,'jobs',job.id,'执行日志.txt'),'utf8'),/用户强制停止/);
  assert.match(await(await fetch(url+'/reports/'+job.id)).text(),/已强制停止/);
  assert.equal((await post('/api/jobs/'+job.id+'/stop',{})).status,409);
 }finally{
  if(jobId){const current=await(await fetch(url+'/api/state')).json();if(current.jobs.find(j=>j.id===jobId)?.status==='RUNNING')await fetch(url+'/api/jobs/'+jobId+'/stop',{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:'{}'});}
  await browser.close();await new Promise(r=>server.close(r));
 }
});
