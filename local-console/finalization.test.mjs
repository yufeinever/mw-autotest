import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {createConsole} from './server.mjs';
import {stopSession,releaseOwnedLock} from './stop-job.mjs';
import {recoverJobPage} from './task-recovery.mjs';
import {PageRecorder,recordingFile} from './recording.mjs';

const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
async function until(check){
 const deadline=Date.now()+15000;
 do{const result=await check();if(result)return result;await delay(40);}while(Date.now()<deadline);
 throw Error('隔离场景等待超时');
}
async function fixture(t,options={}){
 const dataDir=options.dataDir||await fs.mkdtemp(path.join(os.tmpdir(),'mw-finalize-'));
 const app=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir,...options});
 const state=await fetch(app.url+'/api/state').then(r=>r.json());
 const read=route=>fetch(app.url+route).then(r=>r.json());
 const post=async(route,body={})=>{
  const r=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':state.token},body:JSON.stringify(body)});
  const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;
 };
 const script=async(name,content)=>{
  const file=path.join(dataDir,name+'.mjs');
  await fs.writeFile(file,'// MW_TEST_CONFIG_JSON\n'+content);
  return post('/api/scripts',{path:file,name});
 };
 const run=(s,config={recording:{enabled:false}})=>post('/api/run',{scriptId:s.id,config});
 const job=id=>read('/api/jobs/'+id);
 t.after(async()=>{
  const current=await read('/api/state');
  // Cancel queue first; only stop this fixture's own runners.
  for(const j of [...current.jobs].sort((a,b)=>Number(b.status==='QUEUED')-Number(a.status==='QUEUED'))){
   if(['RUNNING','QUEUED'].includes(j.status))await post('/api/jobs/'+j.id+'/stop');
  }
  await new Promise(resolve=>app.server.close(resolve));
 });
 return {...app,read,post,script,run,job};
}

test('删除Session的停止收尾保留用户草稿，清空后解锁并执行下一条',async t=>{
 const engine=http.createServer((req,res)=>{res.writeHead(404,{'content-type':'application/json'});res.end('{}');});
 await new Promise(resolve=>engine.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>engine.close(resolve)));
 const connection={baseUrl:'http://127.0.0.1:'+engine.address().port,opencodeUsername:'fixture',opencodePassword:'synthetic'};
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(3000);
 await page.route('http://isolated.local/**',route=>route.fulfill({contentType:'text/html',body:'<div contenteditable="true">user draft</div>'}));
 await page.goto('http://isolated.local/#/workspace/test/session/ses_deleted');
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-deleted-finalize-'));
 const previous={id:'deleted',name:'deleted fixture',status:'BLOCKED',sessionId:'ses_deleted',schedulingHold:true,isolationVersion:2,cooperative:true,config:{cdpPort:1},startedAt:new Date().toISOString(),log:''};
 await fs.mkdir(path.join(dataDir,'jobs',previous.id),{recursive:true});
 await fs.writeFile(path.join(dataDir,'jobs',previous.id,'job.json'),JSON.stringify(previous));
 const app=await fixture(t,{dataDir,sessionStopper:(job)=>stopSession(job,{connection}),recovery:job=>recoverJobPage(page,job,{connection})});
 const next=await app.script('next','console.log("next executed");');
 const queued=await app.run(next,{cdpPort:1,recording:{enabled:false}});
 await app.post('/api/jobs/deleted/stop');
 let job=await app.job('deleted');
 assert.equal(job.status,'BLOCKED');assert.equal(job.sessionSettled,true);assert.equal(job.schedulingHold,true);
 assert.equal(await page.locator('[contenteditable]').innerText(),'user draft');
 assert.equal((await app.job(queued.id)).status,'QUEUED');
 await page.locator('[contenteditable]').fill('');
 await app.post('/api/jobs/deleted/stop');
 job=await app.job('deleted');assert.equal(job.status,'STOPPED');assert.equal(job.schedulingHold,false);
 await until(async()=>{const j=await app.job(queued.id);return j.phase==='FINISHED'&&j;});
 const state=await app.read('/api/state');assert.equal(state.active,0);assert.equal(state.jobs.some(j=>j.schedulingHold),false);
 assert.match((await app.job(queued.id)).log,/next executed/);
});

test('正常结束等待录像收尾，录像异常独立记录并自动放行下一条',async t=>{
 const finishing=gate(),entered=gate();let starts=0,stops=0;
 t.after(()=>finishing.release());
 const app=await fixture(t,{recorderFactory:async({onChange})=>{
  starts++;await onChange({status:'RECORDING'});
  return {stop:async()=>{stops++;await onChange({status:'FINALIZING'});entered.release();await finishing.promise;throw Error('fixture encoder failure');}};
 }});
 const script=await app.script('normal','console.log("normal completed");');
 const first=await app.run(script,{recording:{enabled:true}});
 await entered.promise;
 const next=await app.run(script);
 try{
  const job=await app.job(first.id);assert.equal(job.status,'RUNNING');assert.equal(job.phase,'FINALIZING');assert.equal(job.endedAt,undefined);
  assert.equal((await app.job(next.id)).status,'QUEUED');assert.equal(starts,1);
 }finally{finishing.release();}
 await until(async()=>{const j=await app.job(next.id);return j.phase==='FINISHED';});
 const done=await app.job(first.id);
 assert.equal(done.status,'EXITED');assert.equal(done.recording.status,'ERROR');assert.match(done.recording.error,/fixture encoder failure/);
 assert.equal(done.schedulingHold,false);assert.equal(stops,1);assert.equal((await app.read('/api/state')).active,0);
});

test('录制启动期间重复强停只收尾一次，页面停止中直到下一条可运行',async t=>{
 const opening=gate(),entered=gate(),saving=gate(),saveEntered=gate();let stops=0;
 t.after(()=>{opening.release();saving.release();});
 const app=await fixture(t,{recorderFactory:async({onChange})=>{
  entered.release();await opening.promise;
  return {stop:async()=>{stops++;await onChange({status:'FINALIZING'});saveEntered.release();await saving.promise;await onChange({status:'COMPLETED',available:true});}};
 }});
 const script=await app.script('startup','console.log("script ran");');
 const nextScript=await app.script('after-startup','console.log("next ran");');
 const first=await app.run(script,{recording:{enabled:true}});await entered.promise;
 const next=await app.run(nextScript);
 const stop1=app.post('/api/jobs/'+first.id+'/stop');
 await until(async()=>(await app.job(first.id)).phase==='STOPPING');
 const stop2=app.post('/api/jobs/'+first.id+'/stop');
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(5000);
 // This UI check uses a separate console and never probes the real client.
 await page.route('**/api/cdp-config',route=>route.fulfill({json:{allowed:true,connected:true,port:1,version:'fixture'}}));
 try{
  await page.goto(app.url);await page.locator('#scriptPageSize').selectOption('50');
  const row=page.locator('#scripts tr').filter({has:page.getByRole('button',{name:'startup',exact:true})});
  const batch=await app.read('/api/batches/'+first.batchId);
  assert.equal(batch.status,'RUNNING');assert.equal(batch.finished,0);
  assert.equal((await app.job(first.id)).phase,'STOPPING');assert.equal((await app.job(first.id)).pid,undefined);
  assert.equal((await app.job(next.id)).status,'QUEUED');
  opening.release();await saveEntered.promise;
  const current=await app.job(first.id);assert.equal(current.status,'RUNNING');assert.equal(current.stopRequested,true);
  assert.equal(await row.count(),1);
  assert.equal(await row.locator('.script-status').innerText(),'停止中');
  assert.equal(await row.getByRole('button',{name:'停止中…',exact:true}).isDisabled(),true);
  await page.screenshot({path:path.join(app.dataDir,'停止收尾界面.png')});
 }finally{opening.release();saving.release();}
 await Promise.all([stop1,stop2]);
 await until(async()=>(await app.job(next.id)).phase==='FINISHED');
 const stopped=await app.job(first.id);assert.equal(stopped.status,'STOPPED');assert.equal(stopped.phase,'FINISHED');assert.equal(stopped.pid,undefined);
 assert.doesNotMatch(stopped.log,/script ran/);assert.equal(stops,1);
 assert.equal((await app.read('/api/state')).active,0);
});

test('强停真实脚本进程树后保存录像和证据，释放本次文件锁并启动下一条',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:640,height:360}});await page.setContent('<h1>Isolated recording</h1>');
 const connect=async()=>({contexts:()=>[{pages:()=>[{url:()=> 'mobilework-shell://app/index.html',context:()=>({newCDPSession:()=>page.context().newCDPSession(page)})}]}],close:async()=>{}});
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-tree-finalize-'));
 const evidence=path.join(dataDir,'runs','evidence');await fs.mkdir(evidence,{recursive:true});
 await fs.writeFile(path.join(evidence,'fixture.png'),'preserved screenshot');
 const lock=path.join(dataDir,'runs','.client-case001.lock'),pidFile=path.join(dataDir,'child-pid.json');
 const childFile=path.join(dataDir,'child.mjs');await fs.writeFile(childFile,'setInterval(()=>{},1000);');
 let recorder;
 const app=await fixture(t,{dataDir,lockReleaser:job=>releaseOwnedLock(job,dataDir),recorderFactory:async options=>{
  recorder=new PageRecorder({...options,connect});await recorder.start();return recorder;
 }});
 const script=await app.script('tree',`import fs from 'node:fs';import {spawn} from 'node:child_process';
const child=spawn(process.execPath,[${JSON.stringify(childFile)}],{windowsHide:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid}));
fs.writeFileSync(${JSON.stringify(lock)},JSON.stringify({pid:process.pid,dir:${JSON.stringify(evidence)}}));
console.log('tree ready');setInterval(()=>{},1000);`);
 const nextScript=await app.script('after-tree','console.log("next after stopped tree");');
 const first=await app.run(script,{recording:{resolution:'640x360',fps:15,bitrateKbps:400,maxSeconds:20}});
 const running=await until(async()=>{const j=await app.job(first.id);if(j.recording?.status==='ERROR')throw Error(j.recording.error);return j.log?.includes('tree ready')&&j;});
 const child=JSON.parse(await fs.readFile(pidFile,'utf8'));
 const next=await app.run(nextScript);
 await app.post('/api/jobs/'+first.id+'/stop');
 const stopped=await app.job(first.id);
 assert.equal(stopped.status,'STOPPED');assert.equal(stopped.recording.status,'COMPLETED',stopped.recording.error);
 assert.equal(stopped.recording.available,true);assert.ok((await fs.stat(path.join(dataDir,'recordings',first.id,recordingFile))).size>0);
 assert.throws(()=>process.kill(running.pid,0));assert.throws(()=>process.kill(child.pid,0));
 assert.notEqual(recorder.encoder.exitCode,null);assert.equal(recorder.timer._destroyed,true);
 await assert.rejects(fs.access(lock),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(evidence,'fixture.png'),'utf8'),'preserved screenshot');
 assert.equal(stopped.result.evidence.length,1);assert.match(stopped.log,/用户强制停止/);
 await until(async()=>(await app.job(next.id)).phase==='FINISHED');
 assert.match((await app.job(next.id)).log,/next after stopped tree/);assert.equal((await app.read('/api/state')).active,0);
});

test('正常收尾中转强停遇引擎500不误放行，恢复后可再次停止并接续队列',async t=>{
 const entered=gate(),saving=gate();let broken=true,aborts=0,stops=0;
 t.after(()=>saving.release());
 const engine=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(broken){res.statusCode=500;return res.end('{}');}
  const route=new URL(req.url,'http://localhost').pathname;
  if(route.endsWith('/abort')){aborts++;return res.end('true');}
  if(route==='/session/status')return res.end('{}');
  res.end(JSON.stringify({id:'ses_fixture',directory:'C:/isolated-fixture'}));
 });
 await new Promise(resolve=>engine.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>engine.close(resolve)));
 const connection={baseUrl:'http://127.0.0.1:'+engine.address().port,opencodeUsername:'fixture',opencodePassword:'synthetic'};
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent('<div contenteditable="true"></div>');
 const app=await fixture(t,{cooperativeDetector:()=>true,sessionStopper:job=>stopSession(job,{connection}),
  recovery:(job,options)=>recoverJobPage(page,job,{...options,connection}),
  recorderFactory:async()=>({stop:async()=>{stops++;entered.release();await saving.promise;}})
 });
 const firstScript=await app.script('has-session','console.log("任务已发送 ses_fixture");');
 const nextScript=await app.script('after-retry','console.log("retry succeeded");');
 const first=await app.run(firstScript,{recording:{enabled:true}});await entered.promise;
 const next=await app.run(nextScript);
 const stop=app.post('/api/jobs/'+first.id+'/stop');
 try{
  await until(async()=>(await app.job(first.id)).phase==='STOPPING');
  assert.equal((await app.job(next.id)).status,'QUEUED');
 }finally{saving.release();}
 await stop;
 const blocked=await app.job(first.id);assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.schedulingHold,true);
 assert.match(blocked.error,/500/);assert.equal(aborts,0);assert.equal((await app.job(next.id)).status,'QUEUED');
 broken=false;await app.post('/api/jobs/'+first.id+'/stop');
 const done=await app.job(first.id);assert.equal(done.status,'STOPPED');assert.equal(done.schedulingHold,false);assert.equal(done.sessionSettled,true);
 await until(async()=>(await app.job(next.id)).phase==='FINISHED');
 assert.equal(aborts,1);assert.equal(stops,1);assert.equal((await app.read('/api/state')).active,0);
});
