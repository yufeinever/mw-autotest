import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createConsole,projectRoot} from './server.mjs';
import http from 'node:http';
import {settleSession,adoptMissingSessionHome} from './task-recovery.mjs';
import {settleComposerSession} from './stop-job.mjs';
import {chromium} from 'playwright-core';

async function fakeEngine(t,handler){
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');handler(new URL(req.url,'http://local').pathname,req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 return {baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'test',opencodePassword:'test'};
}
test('已登记空首页的删除会话先核对真实404再交接',async t=>{
 let missing=false;
 const connection=await fakeEngine(t,(route,req,res)=>{
  if(route==='/session/ses_deleted'&&missing){res.statusCode=404;return res.end('{}');}
  res.end(JSON.stringify({id:'ses_deleted',directory:'test-dir'}));
 });
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();
 await page.addInitScript(info=>{window.__MOBILEWORK_ELECTRON__={invokeDesktop:async()=>info};window.__MOBILEWORK__={invoke:async()=>({models:[]})};},connection);
 await page.route('http://isolated.local/**',route=>route.fulfill({contentType:'text/html',body:'<div contenteditable="true"></div>'}));
 await page.goto('http://isolated.local/#/workspace/test/session');
 const job={sessionId:'ses_deleted',sessionUrl:page.url()+'/ses_deleted',sessionDirectory:'test-dir',modelCompleted:true,composerResources:{url:page.url()}};
 assert.equal(await adoptMissingSessionHome(page,job),false);
 missing=true;await page.locator('[contenteditable]').fill('user draft');assert.equal(await adoptMissingSessionHome(page,job),false);
 await page.locator('[contenteditable]').fill('');assert.equal(await adoptMissingSessionHome(page,job),true);
 assert.equal(await settleComposerSession(page,job),true);assert.equal(job.sessionMissing,true);assert.equal(job.sessionSettled,true);
});
test('停止确认和尝试状态跨收尾轮保存，不重复发送abort',async t=>{
 let aborts=0,idle=false;const checkpoints=[];
 const connection=await fakeEngine(t,(route,req,res)=>{
  if(route==='/session/ses_own')return res.end(JSON.stringify({id:'ses_own',directory:'test-dir'}));
  if(route==='/session/ses_own/abort'){aborts++;return res.end('true');}
  if(route==='/session/status')return res.end(JSON.stringify(idle?{}:{ses_own:{type:'busy'}}));
  if(route==='/permission'||route==='/question')return res.end('[]');
  res.statusCode=404;res.end('{}');
 });
 const job={sessionId:'ses_own'};const options={connection,allowAbort:true,checkpoint:async()=>checkpoints.push({...job})};
 assert.equal(await settleComposerSession(null,job,options),false);
 assert.equal(job.abortAcknowledged,true);assert.equal(job.recoveryAbortAttempted,true);assert.equal(checkpoints.at(-1).abortAcknowledged,true);
 assert.equal(await settleComposerSession(null,job,options),false);assert.equal(aborts,1);
 idle=true;assert.equal(await settleComposerSession(null,job,options),true);assert.equal(job.sessionSettled,true);assert.equal(aborts,1);
});
test('失败收尾只abort本条会话，等状态和待审批清空后才交接',async t=>{
 let aborted=false,polls=0;const calls=[];
 const connection=await fakeEngine(t,(route,req,res)=>{
  calls.push(route);
  if(route==='/session/ses_own')return res.end(JSON.stringify({id:'ses_own',directory:'test-dir'}));
  if(route==='/session/ses_own/abort'){aborted=true;return res.end('true');}
  if(route==='/session/status'){polls++;return res.end(JSON.stringify({ses_other:{type:'busy'},...(aborted&&polls>2?{}:{ses_own:{type:'busy'}})}));}
  if(route==='/permission')return res.end(JSON.stringify(aborted?[]:[{id:'p',sessionID:'ses_own'}]));
  if(route==='/question')return res.end('[]');
  res.statusCode=404;res.end('{}');
 });
 const job={sessionId:'ses_own'};
 assert.equal(await settleSession(null,job,connection,{allowAbort:true}),true);
 assert.ok(polls>2);assert.equal(job.sessionSettled,true);assert.equal(calls.filter(x=>x.endsWith('/abort')).length,1);assert.ok(!calls.some(x=>x.includes('ses_other')));
});
test('停止请求失败后保留尝试状态，不重复发送',async t=>{
 let aborts=0;const checkpoints=[];
 const connection=await fakeEngine(t,(route,req,res)=>{
  if(route==='/session/ses_own')return res.end(JSON.stringify({id:'ses_own',directory:'test-dir'}));
  if(route==='/session/ses_own/abort'){aborts++;res.statusCode=503;return res.end('{}');}
  if(route==='/session/status')return res.end(JSON.stringify({ses_own:{type:'busy'}}));
  if(route==='/permission'||route==='/question')return res.end('[]');
  res.statusCode=404;res.end('{}');
 });
 const job={sessionId:'ses_own'},options={connection,allowAbort:true,checkpoint:async()=>checkpoints.push({...job})};
 await assert.rejects(()=>settleComposerSession(null,job,options),/HTTP 503/);
 assert.equal(checkpoints[0].recoveryAbortAttempted,true);assert.equal(job.abortAcknowledged,undefined);
 assert.equal(await settleComposerSession(null,job,options),false);assert.equal(aborts,1);
});
test('停止前保存失败时不发送且允许后续重新停止',async t=>{
 let aborts=0,idle=false,checkpoints=0;
 const connection=await fakeEngine(t,(route,req,res)=>{
  if(route==='/session/ses_own')return res.end(JSON.stringify({id:'ses_own',directory:'test-dir'}));
  if(route==='/session/ses_own/abort'){aborts++;idle=true;return res.end('true');}
  if(route==='/session/status')return res.end(JSON.stringify(idle?{}:{ses_own:{type:'busy'}}));
  if(route==='/permission'||route==='/question')return res.end('[]');
  res.statusCode=404;res.end('{}');
 });
 const job={sessionId:'ses_own'},options={connection,allowAbort:true,checkpoint:async()=>{if(++checkpoints===1)throw Error('checkpoint failed');}};
 await assert.rejects(()=>settleComposerSession(null,job,options),/checkpoint failed/);
 assert.equal(aborts,0);assert.equal(job.recoveryAbortAttempted,false);
 assert.equal(await settleComposerSession(null,job,options),true);assert.equal(aborts,1);
});
test('审批接口400时暂停，不把abort或状态缺失冒充安全交接',async t=>{
 let aborts=0;
 const connection=await fakeEngine(t,(route,req,res)=>{
  if(route==='/session/ses_own')return res.end(JSON.stringify({id:'ses_own',directory:'test-dir'}));
  if(route.endsWith('/abort')){aborts++;return res.end('true');}
  if(route==='/permission'){res.statusCode=400;return res.end('{}');}
  res.end(route==='/question'?'[]':'{}');
 });
 await assert.rejects(()=>settleSession(null,{sessionId:'ses_own'},connection,{allowAbort:true}),/HTTP 400/);assert.equal(aborts,0);
});
test('没有已绑定引擎且页面属于其他会话时，不停止其他会话',async()=>{
 let evaluated=false;
 await assert.rejects(()=>settleSession({url:()=>'/session/ses_other',evaluate:()=>{evaluated=true;}},{sessionId:'ses_own'},null,{allowAbort:true}),/未操作其他会话/);
 assert.equal(evaluated,false);
});
test('已识别补丁序列化400：核对归属后停止，用独立状态确认空闲',async t=>{
 let aborted=false,polls=0;
 const connection=await fakeEngine(t,(route,req,res)=>{
  if(route==='/session/ses_own')return res.end(JSON.stringify({id:'ses_own',directory:'test-dir'}));
  if(route.endsWith('/abort')){aborted=true;return res.end('true');}
  if(route==='/permission'){res.statusCode=400;return res.end(JSON.stringify({data:{message:'Expected JSON value: filePath patch'}}));}
  if(route==='/question')return res.end('[]');
  if(route==='/session/status'){polls++;return res.end(JSON.stringify(aborted&&polls>2?{}:{ses_own:{type:'busy'}}));}
  res.statusCode=404;res.end('{}');
 });
 const job={sessionId:'ses_own'};assert.equal(await settleSession(null,job,connection,{allowAbort:true}),true);assert.equal(aborted,true);assert.ok(polls>2);assert.equal(job.sessionSettled,true);
});

test('服务端交接失败保留后续排队，复查恢复后自动继续且历史结果不变',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-isolation-'));
 const old=process.env.MW_FIXTURE_DIR;process.env.MW_FIXTURE_DIR=dir;
 let ready=false,calls=0;
 const app=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir:dir,cooperativeDetector:()=>true,recovery:async()=>{calls++;return {ready,reason:ready?'恢复完成':'模拟残留草稿'};}});
 t.after(async()=>{await new Promise(r=>app.server.close(r));if(old===undefined)delete process.env.MW_FIXTURE_DIR;else process.env.MW_FIXTURE_DIR=old;});
 const s=await (await fetch(app.url+'/api/state')).json();
 const api=async(route,body)=>{const r=await fetch(app.url+route,body?{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:JSON.stringify(body)}:{});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
 const script=await api('/api/scripts',{name:'隔离模拟',path:path.join(projectRoot,'local-console/fixture-script.mjs')});
 const state=await api('/api/state'),item=state.scripts.find(x=>x.path.endsWith('fixture-script.mjs'));assert.ok(item,JSON.stringify(script));
 const first=await api('/api/run',{scriptId:item.id,config:{}}),second=await api('/api/run',{scriptId:item.id,config:{}});
 const until=async predicate=>{for(let i=0;i<120;i++){const s=await api('/api/state');if(predicate(s))return s;await delay(100);}throw Error('等待模拟状态超时');};
 let current=await until(s=>s.jobs.find(j=>j.id===first.id)?.schedulingHold);
 assert.equal(current.jobs.find(j=>j.id===second.id).status,'QUEUED');
 assert.match(current.jobs.find(j=>j.id===second.id).queueHold,/模拟残留草稿/);
 ready=true;
 current=await until(s=>s.jobs.find(j=>j.id===second.id)?.status==='PASS'&&!s.active);
 assert.equal(current.jobs.find(j=>j.id===first.id).status,'PASS');assert.ok(calls>=3);
 assert.equal(current.jobs.find(j=>j.id===first.id).schedulingHold,false);
});
