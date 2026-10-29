import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {createConsole} from './server.mjs';

async function until(read){
 const deadline=Date.now()+12000;
 do{const value=await read();if(value)return value;await delay(40);}while(Date.now()<deadline);
 throw Error('等待隔离任务超时');
}
test('初始化失败保留结果并暂停队列，页面提示具体原因，取消后新执行不继承暂停',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-prepare-')),release=path.join(dir,'release');
 const configFile=path.join(dir,'build.json');await fs.writeFile(configFile,JSON.stringify({version:'fixture',packagedCdpAllowed:true}));
 const app=await createConsole({port:0,dataDir:path.join(dir,'data'),cdpConfigFile:configFile,clientProbe:async()=>({connected:true}),cooperativeDetector:()=>true});
 const read=route=>fetch(app.url+route).then(r=>r.json()),state=await read('/api/state');
 const post=async(route,body={})=>{
  const response=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':state.token},body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 };
 t.after(async()=>{for(const job of (await read('/api/state')).jobs.filter(j=>['QUEUED','RUNNING'].includes(j.status)))await post('/api/jobs/'+job.id+'/stop');await new Promise(r=>app.server.close(r));});
 const add=async(name,code)=>{const file=path.join(dir,name+'.mjs');await fs.writeFile(file,'// MW_TEST_CONFIG_JSON\n'+code);return (await post('/api/scripts',{name,path:file})).data;};
 const report=path.join(dir,'执行报告.md');await fs.writeFile(report,'# 隔离初始化失败');await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify({result:'BLOCKED',error:'模型准备失败：缺少配置模型'}));
 const a=await add('准备失败夹具',`import fs from 'node:fs';
 const call=(action,body)=>fetch(process.env.MW_TASK_CONTROL_URL+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-task-token':process.env.MW_TASK_CONTROL_TOKEN},body:JSON.stringify(body)}).then(r=>{if(!r.ok)throw Error('控制请求失败');return r.json();});
 await call('acquire',{phase:'PREPARING'});console.log('fixture ready');
 while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));
 await call('checkpoint',{preparationError:'模型准备失败：缺少配置模型'});console.log('报告：'+${JSON.stringify(report)});`);
 const b=await add('不得自动启动','console.log("started after explicit new request");');
 const config={recording:{enabled:false}},first=(await post('/api/run',{scriptId:a.id,config})).data;
 await until(async()=>(await read('/api/jobs/'+first.id)).log.includes('fixture ready'));
 const second=(await post('/api/run',{scriptId:b.id,config})).data;
 await fs.writeFile(release,'finish');await until(async()=>(await read('/api/jobs/'+first.id)).phase==='FINISHED');
 const paused=await read('/api/jobs/'+second.id);assert.equal(paused.status,'QUEUED');assert.equal(paused.phase,'WAITING_CLIENT');assert.equal(paused.pid,undefined);
 assert.equal((await read('/api/jobs/'+first.id)).status,'BLOCKED');
 const checked=await post('/api/cdp-check',{resume:false});assert.equal(checked.data.connected,true);assert.equal(checked.data.paused,true);assert.match(checked.data.preparationError,/缺少配置模型/);
 assert.equal((await post('/api/run',{scriptId:b.id,config})).status,400);
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1400,height:950}});await page.goto(app.url);
 await until(async()=>(await page.locator('#cdpConnection').innerText()).includes('客户端准备失败'));
 assert.equal(await page.locator('#connection').innerText(),'等待客户端准备');
 await page.locator('#cdpConnection').scrollIntoViewIfNeeded();const screenshot=path.join(dir,'客户端准备失败.png');await page.screenshot({path:screenshot});console.log('UI evidence: '+screenshot);
 await post('/api/jobs/'+second.id+'/stop');assert.equal((await read('/api/state')).active,0);
 assert.equal((await read('/api/cdp-config')).paused,false);
 const fresh=await post('/api/run',{scriptId:b.id,config});assert.equal(fresh.status,202);
 await until(async()=>(await read('/api/jobs/'+fresh.data.id)).phase==='FINISHED');
 const final=await read('/api/state');assert.equal(final.active,0);assert.ok(final.jobs.every(j=>!j.schedulingHold));
 assert.equal(final.jobs.find(j=>j.id===second.id).status,'STOPPED');
 assert.equal(final.jobs.find(j=>j.id===fresh.data.id).status,'EXITED');
});
