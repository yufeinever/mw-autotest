import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import bundle from 'playwright-core/lib/utilsBundle';
import {connectClient} from './client-connection.mjs';
import {uniqueClientPage} from './client-page.mjs';
import {PageRecorder} from './recording.mjs';
import {createConsole} from './server.mjs';
import {describeResult} from './result-display.mjs';

const {ws:WS,wsServer:WSS}=bundle;
async function until(check){const end=Date.now()+8000;do{if(await check())return;await delay(40);}while(Date.now()<end);throw Error('fixture timeout');}

async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-connection-'));
 const file=path.join(dir,'MobileWork','resources','app-dist','index.html');
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'<h1>Client fixture</h1><iframe srcdoc="<p>Child frame</p>"></iframe>');
 const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
 const [port]=String(await fs.readFile(path.join(dir,'profile','DevToolsActivePort'))).split('\n');
 const main=context.pages()[0];await main.goto(pathToFileURL(file).href);
 const auxiliary=await context.newPage();await auxiliary.goto('about:blank');
 const upstream='http://127.0.0.1:'+port;
 const upstreamVersion=await fetch(upstream+'/json/version').then(r=>r.json());
 const sockets=new Set(),commands=[];
 const state={stall:false,mainCopies:1,ghost:true,detached:0};
 const relay=new WSS({noServer:true});
 const server=http.createServer(async(req,res)=>{
  let value=await fetch(upstream+req.url).then(r=>r.json());
  if(req.url==='/json/list'){
   const targets=value.filter(t=>t.url===main.url());
   value=value.filter(t=>t.url!==main.url());
   for(let i=0;i<state.mainCopies;i++)value.push({...targets[0],id:i?targets[0].id+'-duplicate':targets[0].id});
  }
  if(req.url==='/json/version')value={...value,webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
 });
 server.on('upgrade',(req,socket,head)=>relay.handleUpgrade(req,socket,head,client=>relay.emit('connection',client)));
 relay.on('connection',client=>{
  const remote=new WS(upstreamVersion.webSocketDebuggerUrl),queue=[];sockets.add(client);sockets.add(remote);
  client.on('message',data=>{
   const m=JSON.parse(data.toString());commands.push(m);
   if(state.stall)return;
   if(m.method==='Target.detachFromTarget'&&m.params.sessionId==='unloaded-host'){
    state.detached++;client.send(JSON.stringify({id:m.id,result:{}}));client.send(JSON.stringify({method:'Target.detachedFromTarget',params:{sessionId:'unloaded-host',targetId:'host'}}));return;
   }
   if(!m.sessionId&&m.method==='Target.setAutoAttach'&&m.params.autoAttach&&state.ghost){
    client.send(JSON.stringify({method:'Target.attachedToTarget',params:{sessionId:'unloaded-host',targetInfo:{targetId:'host',type:'page',url:'',title:'',attached:true},waitingForDebugger:false}}));
   }
   if(m.sessionId==='unloaded-host')return; // Deliberately nonresponsive native host.
   if(remote.readyState===WS.OPEN)remote.send(data.toString());else queue.push(data.toString());
  });
  remote.on('open',()=>{for(const data of queue)remote.send(data);});
  remote.on('message',data=>{if(client.readyState===WS.OPEN)client.send(data.toString());});
  client.on('close',()=>{sockets.delete(client);remote.terminate();});remote.on('close',()=>{sockets.delete(remote);client.close();});
  client.on('error',()=>remote.terminate());remote.on('error',()=>client.close());
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const s of sockets)s.terminate();await new Promise(r=>relay.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));await context.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,context,main,auxiliary,url:'http://127.0.0.1:'+server.address().port,port:server.address().port,state,sockets,commands};
}

test('target-scoped connection skips a stalled host, retains frames and recording, and releases resources',async t=>{
 const f=await fixture(t);let browser,recorder;
 try{
  browser=await connectClient(f.url,{timeout:5000});
  const page=uniqueClientPage(browser);assert.equal(browser.contexts()[0].pages().length,1);
  assert.equal(await page.getByRole('heading').innerText(),'Client fixture');
  assert.equal(await page.frameLocator('iframe').getByText('Child frame').innerText(),'Child frame');
  const auxiliary=await f.context.newPage();await auxiliary.goto('data:text/html,<h1>Unrelated</h1>');
  assert.equal(await uniqueClientPage(browser).getByRole('heading').innerText(),'Client fixture');
  assert.equal(browser.contexts()[0].pages().length,1);
  recorder=new PageRecorder({config:{enabled:true,resolution:'640x360',fps:10,bitrateKbps:300,maxSeconds:10},directory:path.join(f.dir,'recording'),cdpPort:f.port});
  await recorder.start();assert.equal(recorder.state.status,'RECORDING',recorder.state.error);
  await recorder.stop();assert.equal(recorder.state.status,'COMPLETED',recorder.state.error);
  assert.ok((await fs.stat(recorder.file)).size>0);
  await browser.close();browser=null;
  await until(()=>f.sockets.size===0);
  assert.equal(f.main.isClosed(),false);assert.equal(f.auxiliary.isClosed(),false);assert.equal(auxiliary.isClosed(),false);
  assert.ok(f.state.detached>=2);
  assert.equal(f.commands.some(m=>m.sessionId==='unloaded-host'),false);
  assert.ok(f.commands.filter(m=>m.method==='Target.setAutoAttach'&&!m.sessionId).every(m=>m.params.waitForDebuggerOnStart===false));
 }finally{await recorder?.stop();await browser?.close();}
});

test('missing or duplicate main page fails closed; handshake timeout and upstream disconnect release sockets',async t=>{
 const f=await fixture(t);
 f.state.mainCopies=0;await assert.rejects(connectClient(f.url),/唯一.*0个/);assert.equal(f.sockets.size,0);
 f.state.mainCopies=2;await assert.rejects(connectClient(f.url),/唯一.*2个/);assert.equal(f.sockets.size,0);
 f.state.mainCopies=1;f.state.stall=true;
 await assert.rejects(connectClient(f.url,{timeout:700}),/超时|Timeout/);await until(()=>f.sockets.size===0);
 f.state.stall=false;const browser=await connectClient(f.url,{timeout:4000});
 const disconnected=new Promise(r=>browser.once('disconnected',r));
 for(const socket of f.sockets)socket.terminate();await disconnected;await until(()=>f.sockets.size===0);
 assert.equal(f.main.isClosed(),false);
});

test('manual reconnect retains a failed handoff, then releases it and continues queued work without rewriting business results',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-handoff-')),id='prior-handoff';
 await fs.mkdir(path.join(dir,'jobs',id),{recursive:true});
 const result={result:'FAIL',checks:[{name:'original check',pass:false}]};
 await fs.writeFile(path.join(dir,'jobs',id,'job.json'),JSON.stringify({id,name:'previous',status:'FAIL',phase:'FINISHED',isolationVersion:2,config:{cdpPort:9223},schedulingHold:true,modelCompleted:true,processExited:true,cleanupErrors:[],cleanupStage:'收尾待处理',startedAt:new Date().toISOString(),result,handoff:{ready:false,reason:'fixture connection timeout'},error:'业务已结束，页面交接尚未确认；后续排队暂停：fixture connection timeout'}));
 let ready=false;
 const app=await createConsole({port:0,dataDir:dir,clientProbe:async()=>({connected:true}),recovery:async()=>({ready,reason:ready?'':'fixture not ready'})});
 let browser;
 t.after(async()=>{await browser?.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const read=route=>fetch(app.url+route).then(r=>r.json());
 const {token}=await read('/api/state');
 const post=async(route,body={})=>{const r=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
 const file=path.join(dir,'queued.mjs');await fs.writeFile(file,"console.log('MW_TEST_CONFIG_JSON fixture finished');");
 const script=await post('/api/scripts',{name:'queued fixture',path:file});
 const next=await post('/api/run',{scriptId:script.id,config:{recording:{enabled:false}}});
 const held=await post('/api/cdp-check',{resume:true});assert.equal(held.connected,true);assert.equal(held.paused,true);assert.equal(held.handoffPending,1);
 assert.equal((await read('/api/jobs/'+next.id)).status,'QUEUED');
 assert.match(describeResult((await read('/api/state')).jobs.find(j=>j.id===id)).action,/重新连接/);
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.goto(app.url);await page.getByRole('button',{name:'检查连接 / 重新连接',exact:true}).click();
 await until(async()=>(await page.locator('#cdpMessage').innerText()).includes('队列继续暂停'));
 if(process.env.MW_TEST_SCREENSHOT){await fs.mkdir(path.dirname(process.env.MW_TEST_SCREENSHOT),{recursive:true});await page.screenshot({path:process.env.MW_TEST_SCREENSHOT,fullPage:true});}
 ready=true;await page.getByRole('button',{name:'检查连接 / 重新连接',exact:true}).click();
 await until(async()=>(await read('/api/jobs/'+next.id)).phase==='FINISHED');
 const done=(await read('/api/state')).jobs.find(j=>j.id===id);
 assert.equal(done.schedulingHold,false);assert.equal(done.cleanupStage,'收尾完成');assert.equal(done.status,'FAIL');assert.deepEqual(done.result,result);
 assert.equal((await read('/api/state')).active,0);
 assert.match(await fs.readFile(path.join(dir,'jobs',id,'执行日志.txt'),'utf8'),/页面交接已恢复/);
});
