import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {createConsole} from './server.mjs';

test('受控重启：鉴权、忙碌状态及并发请求',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-console-restart-'));
 let finishModel,modelStarted,finishRestart,restartStarted,shutdowns=0;
 const modelPending=new Promise(resolve=>{finishModel=resolve;}),modelEntered=new Promise(resolve=>{modelStarted=resolve;});
 const restartPending=new Promise(resolve=>{finishRestart=resolve;}),restartEntered=new Promise(resolve=>{restartStarted=resolve;});
 const {server,url}=await createConsole({port:0,dataDir:dir,modelReader:async()=>{modelStarted();await modelPending;return {models:[]};},restartCoordinator:async()=>{restartStarted();await restartPending;return {shutdown(){shutdowns++;}};}});
 try{
  const state=await(await fetch(url+'/api/state')).json();assert.equal(state.capabilities.consoleRestart,1);assert.ok(state.instanceId);
  const post=(route,token=state.token)=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:'{}'});
  assert.equal((await post('/api/console/restart','wrong')).status,403);
  const model=post('/api/models');await modelEntered;
  assert.equal((await post('/api/console/restart')).status,409);finishModel();assert.equal((await model).status,200);
  const restart=post('/api/console/restart');await restartEntered;
  assert.equal((await post('/api/config')).status,409);assert.equal((await post('/api/console/restart')).status,409);
  finishRestart();const response=await restart;assert.equal(response.status,202);assert.equal((await response.json()).instanceId,state.instanceId);
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(shutdowns,1);
 }finally{finishModel();finishRestart();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});

test('重启按钮在真实页面显示且空闲时可用',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-console-restart-ui-'));
 const {server,url}=await createConsole({port:0,dataDir:dir,clientProbe:async()=>({connected:false})});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});await page.goto(url);
  const button=page.getByRole('button',{name:'重启测试控制台'});await button.waitFor();await page.waitForFunction(()=>!document.querySelector('#restartConsole').disabled);
  assert.equal(await button.getAttribute('title'),'重启测试控制台');
  await page.route('**/api/console/restart',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'存在待恢复锁'})}));
  await button.click();await page.getByText('未能重启测试控制台：存在待恢复锁').waitFor();assert.equal(await button.isEnabled(),true);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});

test('独立进程释放端口后由新实例接管', {timeout:20000},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-console-supervisor-'));
 const fixture=fileURLToPath(new URL('./restart-test-fixture.mjs',import.meta.url));
 await fs.mkdir(path.join(dir,'local-console'));
 await fs.copyFile(fixture,path.join(dir,'local-console','launch.mjs'));
 const child=spawn(process.execPath,[fixture],{windowsHide:true,stdio:['ignore','ignore','inherit','ipc'],env:{...process.env,MW_RESTART_TEST_ROOT:dir,MW_RESTART_TEST_DATA:dir,MW_RESTART_TEST_MODULE:pathToFileURL(fileURLToPath(new URL('./console-restart.mjs',import.meta.url))).href}});
 let port,newPid;
 try{
  port=await new Promise((resolve,reject)=>{child.once('message',m=>resolve(m.port));child.once('error',reject);child.once('exit',code=>reject(Error('旧测试服务提前退出 '+code)));});
  const base=`http://127.0.0.1:${port}`;
  assert.equal(await(await fetch(base+'/restart')).text(),'restarting');
  let state;
  for(let i=0;i<60;i++){
   await new Promise(resolve=>setTimeout(resolve,150));
   try{state=await(await fetch(base+'/api/state',{signal:AbortSignal.timeout(500)})).json();if(state.instanceId==='new-instance')break;}catch{}
  }
  assert.equal(state?.instanceId,'new-instance');assert.notEqual(state.pid,child.pid);newPid=state.pid;
  let record;
  for(let i=0;i<20;i++){
   record=JSON.parse(await fs.readFile(path.join(dir,'console-restart.json'),'utf8'));
   if(record.status==='ready')break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(record.status,'ready');
 }finally{
  if(port)await fetch(`http://127.0.0.1:${port}/stop`,{signal:AbortSignal.timeout(1000)}).catch(()=>{});
  if(child.exitCode===null)child.kill();
  if(newPid)for(let i=0;i<30;i++){try{process.kill(newPid,0);await new Promise(resolve=>setTimeout(resolve,100));}catch{break;}}
  await fs.rm(dir,{recursive:true,force:true,maxRetries:30,retryDelay:100});
 }
});
