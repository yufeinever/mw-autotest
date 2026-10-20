import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole,projectRoot} from './server.mjs';
import {killScript,releaseOwnedLock} from './stop-job.mjs';
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
