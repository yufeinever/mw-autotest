import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright-core';
import {summarizeBatch,collectBatches} from './batches.mjs';
import {createConsole,projectRoot} from './server.mjs';

const plan={id:'batch-a',name:'范围测试',startedAt:'2026-10-20T01:00:00Z',submission:'SUBMITTED',submissionEndedAt:'2026-10-20T01:00:01Z',scripts:[{scriptId:'a',number:1},{scriptId:'b',number:2}]};
const job=(scriptId,status,batchId='batch-a')=>({id:batchId+'-'+scriptId,batchId,scriptId,status,startedAt:'2026-10-20T01:00:00Z',endedAt:status==='RUNNING'?null:'2026-10-20T01:01:00Z',result:{checks:['PASS','CHECKED','FAIL'].includes(status)?[{name:'实际断言',pass:status!=='FAIL'}]:[]}});
test('批次汇总按批次隔离，只计实际断言，未执行、预检及退出不冒充通过',()=>{
 const pending=summarizeBatch(plan,[job('a','PASS'),job('b','FAIL','other')]);assert.equal(pending.status,'BLOCKED');assert.equal(pending.counts.NOT_RUN,1);assert.equal(pending.checks.total,1);assert.equal(pending.checks.missing,1);assert.equal(pending.total,2);
 const fail=summarizeBatch(plan,[job('a','PASS'),job('b','FAIL')]);assert.equal(fail.status,'FAIL');assert.equal(fail.checks.passed,1);assert.equal(fail.checks.failed,1);
 assert.equal(summarizeBatch(plan,[job('a','PASS'),job('b','PASS')]).status,'PASS');
 const contradictory=job('b','PASS');contradictory.result.checks[0].pass=false;assert.equal(summarizeBatch(plan,[job('a','PASS'),contradictory]).status,'FAIL');
 assert.equal(summarizeBatch(plan,[job('a','PASS'),job('b','CHECKED')]).status,'CHECKED');
 assert.equal(summarizeBatch(plan,[job('a','PASS'),job('b','EXITED')]).status,'EXITED');
 assert.equal(summarizeBatch(plan,[job('a','PASS'),job('b','STOPPED')]).status,'STOPPED');
 const running=summarizeBatch(plan,[job('a','PASS'),job('b','RUNNING')]);assert.equal(running.status,'RUNNING');assert.equal(running.endedAt,null);assert.equal(running.finished,1);
 const legacy=[{...job('old','FAIL'),batchId:undefined},{...job('old2','PASS'),batchId:undefined}];const copy=JSON.stringify(legacy);
 const all=collectBatches([plan],[job('a','PASS'),...legacy]);assert.equal(all.length,2);assert.equal(all.find(b=>b.id==='legacy-history').total,2);assert.equal(JSON.stringify(legacy),copy);
});

test('真实批次接口、并行隔离、详情页面、失败断言、落盘恢复与旧记录归档',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-batches-test-')),dataDir=path.join(dir,'console');
 const previous=process.env.MW_FIXTURE_DIR;process.env.MW_FIXTURE_DIR=dir;
 let app=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir}),browser;
 try{
  let token=(await(await fetch(app.url+'/api/state')).json()).token;
  const post=async(route,body)=>{const response=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const read=async route=>(await fetch(app.url+route)).json();
  const ids=[];for(const name of ['甲','乙']){const file=path.join(dir,name+'.mjs');await fs.copyFile(path.join(projectRoot,'local-console','fixture-script.mjs'),file);const item=await post('/api/scripts',{name:'批次脚本'+name,path:file});assert.equal(item.status,201);ids.push(item.body.id);}
  const sensitive='only-fixture-secret-123456';const redacted=await post('/api/batches',{scriptIds:[ids[0]],mode:'single',config:{provider:{key:sensitive}}});assert.equal(redacted.status,201);
  assert.ok(!(await fs.readFile(path.join(dataDir,'batches',redacted.body.id+'.json'),'utf8')).includes(sensitive));
  assert.ok(!JSON.stringify(await read('/api/batches/'+redacted.body.id)).includes(sensitive));await post('/api/batches/'+redacted.body.id+'/complete',{});
  assert.equal((await post('/api/batches',{scriptIds:[ids[0],ids[0]],mode:'range'})).status,400);
  assert.equal((await post('/api/batches',{scriptIds:[ids[1],ids[0]],mode:'range'})).status,400);
  const config={question:'second',approval:'session',model:'批次模型'};
  const batch=(await post('/api/batches',{scriptIds:ids,mode:'range',config})).body;
  assert.equal((await post('/api/run',{scriptId:ids[0],batchId:batch.id,config:{question:'first'}})).status,400);
  assert.equal((await post('/api/run',{scriptId:'missing',batchId:batch.id,config})).status,400);
  const first=await post('/api/run',{scriptId:ids[0],batchId:batch.id,config});assert.equal(first.status,202);
  assert.equal((await post('/api/run',{scriptId:ids[0],batchId:batch.id,config})).status,400,'同批不重复启动');
  const concurrent=await post('/api/run',{scriptId:ids[0],config:{question:'first'}});assert.equal(concurrent.status,202);assert.notEqual(concurrent.body.batchId,batch.id,'同脚本并行进入不同批次');
  await post('/api/batches/'+batch.id+'/complete',{error:'模拟中途提交失败'});
  assert.equal((await post('/api/run',{scriptId:ids[1],batchId:batch.id,config})).status,400,'完成提交后不能追加');
  for(let i=0;i<80;i++){if(!(await read('/api/state')).active)break;await new Promise(r=>setTimeout(r,100));}
  let detail=await read('/api/batches/'+batch.id);assert.equal(detail.status,'BLOCKED');assert.equal(detail.total,2);assert.equal(detail.launched,1);assert.equal(detail.counts.NOT_RUN,1);assert.equal(detail.entries[0].job.config.question,'second');
  assert.equal((await read('/api/batches/'+concurrent.body.batchId)).status,'PASS');
  // Test data only: model an existing failed assertion, without changing product reports.
  const file=path.join(dataDir,'jobs',first.body.id,'job.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));saved.status='FAIL';saved.result.checks.push({name:'预期Skill调用缺失',pass:false,actual:'<script>unsafe</script>'});await fs.writeFile(file,JSON.stringify(saved));
  const old={...job('old','FAIL'),id:'legacy-one',name:'旧失败用例',batchId:undefined};await fs.mkdir(path.join(dataDir,'jobs',old.id));await fs.writeFile(path.join(dataDir,'jobs',old.id,'job.json'),JSON.stringify(old));
  const unfinished=(await post('/api/batches',{scriptIds:[ids[1]],mode:'single',config})).body;
  await new Promise(r=>app.server.close(r));app=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir});token=(await read('/api/state')).token;
  detail=await read('/api/batches/'+batch.id);assert.equal(detail.status,'FAIL');assert.equal(detail.checks.failed,1);
  const interrupted=await read('/api/batches/'+unfinished.id);assert.equal(interrupted.status,'INTERRUPTED');assert.equal(interrupted.counts.NOT_RUN,1);
  const state=await read('/api/state');assert.equal(state.jobs.length,3);assert.equal(state.batches.filter(b=>b.legacy).length,1);assert.equal(state.batches.find(b=>b.legacy).total,1);
  assert.equal((await fetch(app.url+'/api/batches/missing')).status,404);
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/cdp-config',r=>r.fulfill({json:{allowed:true,connected:true,port:9223,version:'mock'}}));
  await page.goto(app.url);await page.getByRole('heading',{name:'03 / 执行批次',exact:true}).waitFor();
  assert.equal(await page.locator('#historyRows tr').count(),5);assert.equal(await page.locator('#historyRows').getByRole('link',{name:'查看报告',exact:true}).count(),0);
  await page.locator('#historyRows tr').filter({has:page.locator('a[href="/?batch='+batch.id+'"]')}).getByRole('link',{name:'查看批次',exact:true}).click();
  await page.getByRole('heading',{name:'执行批次详情',exact:true}).waitFor();await page.locator('#batchCaseRows tr').first().waitFor();
  assert.equal(await page.locator('#batchCaseRows tr').count(),2);assert.match(await page.locator('#batchCaseRows').innerText(),/未执行/);
  await page.getByText('失败断言 1 项',{exact:true}).click();assert.equal(await page.locator('.batch-case-table .result-fail').filter({hasText:'预期Skill调用缺失'}).count(),1);assert.equal(await page.locator('script:not([src])').count(),0);
  await page.waitForResponse(r=>r.url()===app.url+'/api/batches/'+batch.id);assert.equal(await page.locator('details[open] summary').filter({hasText:'失败断言'}).count(),1,'轮询不收起已展开的失败断言');
  assert.equal(await page.getByRole('link',{name:'Trace 记录',exact:true}).count(),1);assert.equal(await page.getByRole('link',{name:'查看报告',exact:true}).count(),1);
  await page.reload();await page.locator('#batchCaseRows tr').first().waitFor();assert.equal(await page.locator('#batchCaseRows tr').count(),2);
  await page.getByRole('link',{name:'返回执行批次',exact:true}).click();await page.locator('#historyRows').getByText('历史执行记录',{exact:true}).waitFor();assert.deepEqual(errors,[]);
  const frozen=interrupted.submissionEndedAt;await new Promise(r=>app.server.close(r));app=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir});assert.equal((await read('/api/batches/'+unfinished.id)).submissionEndedAt,frozen,'中断时间只记录一次');
 }finally{
  if(browser)await browser.close();if(app.server.listening)await new Promise(r=>app.server.close(r));
  if(previous===undefined)delete process.env.MW_FIXTURE_DIR;else process.env.MW_FIXTURE_DIR=previous;
 }
});
