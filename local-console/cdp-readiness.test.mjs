import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {probeCdp} from './cdp-readiness.mjs';
import {createConsole} from './server.mjs';

async function until(read){
 const deadline=Date.now()+12000;
 do{const result=await read();if(result)return result;await delay(40);}while(Date.now()<deadline);
 throw Error('隔离检查等待超时');
}
async function fixture(t,clientProbe){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-ready-'));
 const file=path.join(dataDir,'build.json');await fs.writeFile(file,JSON.stringify({version:'fixture',packagedCdpAllowed:true}));
 let recordings=0;
 const app=await createConsole({port:0,dataDir,cdpConfigFile:file,clientProbe,recorderFactory:async()=>{recordings++;return {stop:async()=>{}};}});
 const read=route=>fetch(app.url+route).then(r=>r.json()),state=await read('/api/state');
 const post=async(route,body={})=>{
  const response=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':state.token},body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 };
 const add=async(name,source)=>{
  const filename=path.join(dataDir,name+'.mjs');await fs.writeFile(filename,'// MW_TEST_CONFIG_JSON\n'+source);
  return (await post('/api/scripts',{name,path:filename})).data;
 };
 t.after(async()=>{
  const jobs=(await read('/api/state')).jobs;
  for(const job of [...jobs.filter(j=>j.status==='QUEUED'),...jobs.filter(j=>j.status==='RUNNING')])await post('/api/jobs/'+job.id+'/stop');
  await new Promise(resolve=>app.server.close(resolve));
 });
 return {...app,read,post,add,recordings:()=>recordings};
}

test('连接探针检查真实页面响应并释放连接，初始化错误不能冒充可用',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<main>readiness fixture</main>');
  let closed=0;
  const connect=async()=>({contexts:()=>[{pages:()=>[{url:()=> 'mobilework-shell://app/index.html',evaluate:fn=>page.evaluate(fn)}]}],close:async()=>{closed++;}});
  const ready=await probeCdp(9223,{connect});assert.equal(ready.connected,true);assert.equal(closed,1);assert.ok(ready.checkedAt);
  const failed=await probeCdp(9223,{connect:async()=>{throw Error('browserType.connectOverCDP: Timeout 7000ms exceeded.\nsecret-websocket-id');}});
  assert.equal(failed.connected,false);assert.match(failed.error,/重新连接/);assert.doesNotMatch(failed.error,/secret-websocket-id/);
 }finally{await browser.close();}
});

test('连接失败不建批次不启动，批次中断保留队列，页面重连后按序接续',async t=>{
 let ready=false;
 const app=await fixture(t,async()=>({connected:ready,error:ready?null:'连接不可用，请重新连接'}));
 const release=path.join(app.dataDir,'release');
 const first=await app.add('first',`import fs from 'node:fs';console.log('first started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('first done');}},30);`);
 const second=await app.add('second','console.log("second executed");');
 const third=await app.add('third','console.log("third executed");');
 const config={recording:{enabled:false}};
 const batchBody={scriptIds:[first.id,second.id,third.id],suite:'functional',mode:'selected',config};
 assert.equal((await app.post('/api/batches',batchBody)).status,400);
 assert.equal((await app.post('/api/run',{scriptId:first.id,config})).status,400);
 let state=await app.read('/api/state');assert.equal(state.jobs.length,0);assert.equal(state.batches.length,0);assert.equal(app.recordings(),0);
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(6000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(app.url);await page.getByRole('button',{name:'检查连接 / 重新连接',exact:true}).waitFor();
 await page.getByRole('button',{name:'检查连接 / 重新连接',exact:true}).click();
 await until(async()=>(await page.locator('#cdpMessage').innerText()).includes('连接不可用'));
 ready=true;
 const batch=(await app.post('/api/batches',batchBody)).data;
 const a=(await app.post('/api/run',{scriptId:first.id,batchId:batch.id,config})).data;
 await until(async()=>(await app.read('/api/jobs/'+a.id)).log?.includes('first started'));
 const b=(await app.post('/api/run',{scriptId:second.id,batchId:batch.id,config})).data;
 const c=(await app.post('/api/run',{scriptId:third.id,batchId:batch.id,config})).data;
 await app.post('/api/batches/'+batch.id+'/complete');
 ready=false;await fs.writeFile(release,'finish');
 await until(async()=>(await app.read('/api/jobs/'+b.id)).phase==='WAITING_CONNECTION');
 state=await app.read('/api/state');
 for(const id of [b.id,c.id]){const job=state.jobs.find(j=>j.id===id);assert.equal(job.status,'QUEUED');assert.equal(job.pid,undefined);assert.equal(job.startedAt,null);}
 assert.equal(app.recordings(),0);
 const failed=await app.post('/api/cdp-check',{port:9223,resume:true});assert.equal(failed.data.connected,false);
 ready=true;
 // Background GET may refresh readiness, but must never resume queued work.
 await app.post('/api/cdp-check',{port:9223,resume:false});
 await app.read('/api/cdp-config');assert.equal((await app.read('/api/jobs/'+b.id)).status,'QUEUED');
 await page.reload();await page.locator('#scriptPageSize').selectOption('50');
 const row=page.locator('#scripts tr').filter({has:page.getByRole('button',{name:'second',exact:true})});
 assert.equal(await row.locator('.script-status').innerText(),'等待连接');
 assert.equal(await page.locator('#connection').innerText(),'等待 MobileWork 连接');
 await page.locator('#cdpConnection').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(app.dataDir,'连接检查界面.png')});
 await until(async()=>!(await page.locator('#refreshCdp').isDisabled()));
 // The initial GET must finish before the explicit reconnect handler runs.
 await until(async()=>(await page.locator('#cdpConnection').innerText()).includes('队列仍暂停'));
 await page.getByRole('button',{name:'检查连接 / 重新连接',exact:true}).click();
 await until(async()=>(await app.read('/api/jobs/'+c.id)).phase==='FINISHED');
 state=await app.read('/api/state');assert.equal(state.active,0);assert.ok(state.jobs.every(j=>j.status==='EXITED'&&!j.schedulingHold));
 const doneB=state.jobs.find(j=>j.id===b.id),doneC=state.jobs.find(j=>j.id===c.id);
 assert.ok(Date.parse(doneB.endedAt)<=Date.parse(doneC.startedAt));assert.deepEqual(errors,[]);
 console.log('UI evidence: '+path.join(app.dataDir,'连接检查界面.png'));
});

test('强停检查连接中的任务不会延迟启动脚本或录像，等待队列可取消',async t=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});let checks=0;
 t.after(()=>release({connected:true}));
 const app=await fixture(t,async()=>++checks===1?{connected:true}:waiting);
 const script=await app.add('cancel','console.log("must not execute");');
 const config={recording:{enabled:true}};
 const a=(await app.post('/api/run',{scriptId:script.id,config})).data;
 await until(async()=>(await app.read('/api/jobs/'+a.id)).phase==='CHECKING_CONNECTION');
 const b=(await app.post('/api/run',{scriptId:script.id,config})).data;
 await app.post('/api/jobs/'+b.id+'/stop');
 await app.post('/api/jobs/'+a.id+'/stop');release({connected:true});
 await until(async()=>!(await app.read('/api/state')).active);
 const state=await app.read('/api/state');assert.equal(state.jobs.length,2);
 assert.ok(state.jobs.every(j=>j.status==='STOPPED'&&!j.pid));assert.equal(app.recordings(),0);
 for(const job of state.jobs)assert.doesNotMatch((await app.read('/api/jobs/'+job.id)).log,/must not execute/);
});
