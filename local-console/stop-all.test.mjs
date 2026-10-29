import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole,projectRoot} from './server.mjs';
import {normalizeConfig} from './policy.mjs';
import {stopAllJobs} from './stop-all.mjs';

test('停止全部先清队列；失败会话继续报告失败，其他任务仍停止且不改历史',async()=>{
 const jobs=[{id:'running',status:'RUNNING'},{id:'queued',status:'QUEUED'},
  {id:'blocked',status:'BLOCKED',sessionId:'ses_owned'},{id:'old',status:'PASS',sessionId:'ses_old'}];
 const calls=[];
 const api=async(route)=>{
  if(route==='/api/state')return {jobs:structuredClone(jobs)};
  const id=route.split('/')[3];calls.push(id);
  if(id==='blocked'){jobs[2].error='客户端未确认停止会话';return {message:jobs[2].error};}
  jobs.find(j=>j.id===id).status='STOPPED';return {message:'已停止'};
 };
 const result=await stopAllJobs(api);
 assert.deepEqual(calls,['queued','running','blocked']);assert.equal(result.stopped,2);
 assert.deepEqual(result.remaining,[{id:'blocked',name:'blocked',message:'客户端未确认停止会话'}]);
 assert.equal(jobs[3].status,'PASS');
});

test('批量提交期间停止全部，停止已提交任务且不再提交下一条',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-stop-all-submit-'));
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir:dir});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 let release;
 try{
  const scripts=Array.from({length:3},(_,i)=>({id:'script-'+i,name:'隔离脚本'+i,path:'D:/mock.mjs',exists:true,integrated:true}));
  const state={token:'mock',capabilities:{taskScheduling:1,taskIsolation:2,clientReadiness:1},config:normalizeConfig(),scripts,jobs:[],active:0};
  const page=await browser.newPage(),runs=[],stops=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  let entered;const inFlight=new Promise(r=>entered=r);
  await page.route('**/api/**',async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   if(p==='/api/state')return route.fulfill({json:state});
   if(p==='/api/cdp-config')return route.fulfill({json:{allowed:true,connected:true,port:9223}});
   if(p==='/api/config')return route.fulfill({json:req.postDataJSON()});
   if(p==='/api/batches')return route.fulfill({json:{id:'batch'}});
   if(p==='/api/batches/batch/complete')return route.fulfill({json:{}});
   if(p==='/api/run'){
    runs.push(req.postDataJSON());await new Promise(r=>{release=r;entered();});
    state.jobs.push({id:'inflight',name:'隔离脚本0',status:'RUNNING',pid:123});state.active=1;
    return route.fulfill({json:{id:'inflight'}});
   }
   if(p==='/api/jobs/inflight/stop'){stops.push(p);state.jobs[0].status='STOPPED';state.active=0;return route.fulfill({json:{message:'已停止'}});}
   throw Error('不应访问真实客户端：'+p);
  });
  await page.goto(url);await page.getByText('本机服务已连接',{exact:true}).waitFor();
  assert.equal(await page.locator('#stopAll').isDisabled(),true);
  await page.locator('#runAll').click();await inFlight;
  await page.locator('#stopAll').click();assert.equal(await page.locator('#stopAll').innerText(),'正在停止…');
  release();await page.locator('#batchMessage').getByText(/全部停止处理完成/).waitFor();
  assert.equal(runs.length,1);assert.equal(stops.length,1);
  assert.equal(await page.locator('#stopAll').isDisabled(),true);assert.equal(await page.locator('#runAll').isEnabled(),true);
  assert.deepEqual(errors,[]);
 }finally{release?.();await browser.close();await new Promise(r=>server.close(r));}
});

test('页面停止全部真实隔离脚本，排队任务不启动并保留停止日志',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-stop-all-process-'));
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const state=await(await fetch(url+'/api/state')).json();const ids=[];
 const post=async(route,body)=>{const r=await fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':state.token},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;};
 try{
  const script=await post('/api/scripts',{path:path.join(projectRoot,'local-console','fixtures','long-running.mjs'),name:'停止全部隔离脚本'});
  for(let i=0;i<2;i++)ids.push((await post('/api/run',{scriptId:script.id,config:{executionStrategy:'serial'}})).id);
  const page=await browser.newPage();
  await page.route('**/api/cdp-config',route=>route.fulfill({json:{allowed:true,connected:false,port:9223}}));
  await page.goto(url);await page.getByText('脚本执行中',{exact:true}).waitFor();
  await page.waitForFunction(async()=>{const s=await(await fetch('/api/state')).json();return s.jobs.some(j=>j.status==='RUNNING'&&j.pid);});
  await page.locator('#stopAll').click();
  await page.locator('#batchMessage').getByText(/全部停止处理完成：已停止 2 条/).waitFor({timeout:20000});
  const final=await(await fetch(url+'/api/state')).json(),jobs=ids.map(id=>final.jobs.find(j=>j.id===id));
  assert.equal(final.active,0);assert.ok(jobs.every(j=>j.status==='STOPPED'&&j.endedAt));
  assert.equal(jobs[1].startedAt,null);assert.equal(jobs[1].pid,undefined);
  assert.throws(()=>process.kill(jobs[0].pid,0));
  assert.match(await fs.readFile(path.join(dataDir,'jobs',ids[0],'执行日志.txt'),'utf8'),/用户强制停止/);
  assert.equal(await page.locator('#stopAll').isDisabled(),true);
 }finally{
  const current=await(await fetch(url+'/api/state')).json();
  for(const id of [...ids].reverse())if(current.jobs.some(j=>j.id===id&&['RUNNING','QUEUED'].includes(j.status)))await post('/api/jobs/'+id+'/stop',{});
  await browser.close();await new Promise(r=>server.close(r));
 }
});
