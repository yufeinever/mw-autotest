import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {recoverJobPage,failedBeforeSession} from './task-recovery.mjs';
import {createConsole} from './server.mjs';
import {normalizeConfig} from './policy.mjs';

const error='客户端工作区准备失败：专家安装失败(MW105050909)；未创建Session';
const failure=()=>({submissionPending:true,result:{result:'BLOCKED',error,events:[{step:'BLOCKED',detail:error}]}});

test('创建会话前失败解除待提交标记，未知发送仍保护，用户草稿不清理',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent('<div contenteditable="true"></div>');
 const job=failure();assert.equal(failedBeforeSession(job),true);
 assert.equal((await recoverJobPage(page,job)).ready,true);assert.equal(job.submissionPending,false);
 const unknown={submissionPending:true};assert.equal((await recoverJobPage(page,unknown)).ready,false);
 const changed=failure();await page.locator('[contenteditable]').fill('用户的新草稿');
 assert.equal((await recoverJobPage(page,changed)).ready,false);
 assert.equal(await page.locator('[contenteditable]').innerText(),'用户的新草稿');
 assert.equal(failedBeforeSession({...failure(),sessionId:'ses_known'}),false);
});

test('强制停止释放已证失败任务锁，强制解锁取消队列并在重启后保持，拒绝活进程',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-lock-recovery-')),config=normalizeConfig();
 const records=[{id:'failed',...failure(),status:'BLOCKED',cooperative:true,isolationVersion:2,schedulingHold:true},
  {id:'unknown',status:'BLOCKED',cooperative:true,isolationVersion:2,schedulingHold:true,submissionPending:true},
  {id:'live',status:'BLOCKED',cooperative:true,isolationVersion:2,schedulingHold:true,pid:process.pid}];
 for(const j of records){const d=path.join(dir,'jobs',j.id);await fs.mkdir(d,{recursive:true});await fs.writeFile(path.join(d,'job.json'),JSON.stringify({...j,name:j.id,config,log:'',startedAt:'2026-10-21T08:03:20Z'}));}
 let app=await createConsole({port:0,dataDir:dir,recovery:async j=>({ready:failedBeforeSession(j),reason:'fixture'})});
 t.after(async()=>{await new Promise(r=>app.server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 let state=await(await fetch(app.url+'/api/state')).json();
 const post=(route,body)=>fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':state.token},body:JSON.stringify(body)});
 assert.equal((await post('/api/jobs/failed/stop',{})).status,200);
 state=await(await fetch(app.url+'/api/state')).json();assert.equal(state.jobs.find(j=>j.id==='failed').status,'STOPPED');assert.equal(state.jobs.find(j=>j.id==='failed').schedulingHold,false);
 assert.equal((await post('/api/locks/release',{confirm:true,jobIds:['unknown','live']})).status,409);
 // End the fixture's live process claim without terminating any process.
 await new Promise(r=>app.server.close(r));const livePath=path.join(dir,'jobs/live/job.json');const live=JSON.parse(await fs.readFile(livePath));delete live.pid;await fs.writeFile(livePath,JSON.stringify(live));
 app=await createConsole({port:0,dataDir:dir,recovery:async()=>({ready:false,reason:'fixture'})});state=await(await fetch(app.url+'/api/state')).json();
 const queued=await(await post('/api/run',{scriptId:state.scripts[0].id,config})).json();assert.ok(queued.id);
 assert.equal((await post('/api/locks/release',{confirm:true,jobIds:['unknown']})).status,409);
 const response=await post('/api/locks/release',{confirm:true,jobIds:['unknown','live']});assert.equal(response.status,200);assert.equal((await response.json()).cancelled,1);
 state=await(await fetch(app.url+'/api/state')).json();assert.equal(state.active,0);assert.equal(state.jobs.find(j=>j.id===queued.id).status,'STOPPED');assert.ok(state.jobs.find(j=>j.id==='unknown').forcedUnlock);assert.equal(state.jobs.find(j=>j.id==='unknown').status,'BLOCKED');
 await new Promise(r=>app.server.close(r));app=await createConsole({port:0,dataDir:dir,recovery:async()=>({ready:false})});state=await(await fetch(app.url+'/api/state')).json();assert.ok(state.jobs.every(j=>!j.schedulingHold));
});
