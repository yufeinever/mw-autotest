import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createConsole,projectRoot} from './server.mjs';
import http from 'node:http';
import {settleSession} from './task-recovery.mjs';

async function fakeEngine(t,handler){
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');handler(new URL(req.url,'http://local').pathname,req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 return {baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'test',opencodePassword:'test'};
}
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
 const app=await createConsole({port:0,dataDir:dir,cooperativeDetector:()=>true,recovery:async()=>{calls++;return {ready,reason:ready?'恢复完成':'模拟残留草稿'};}});
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
