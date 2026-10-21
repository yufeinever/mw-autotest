import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole} from './server.mjs';
import {normalizeConfig} from './policy.mjs';
import {TaskScheduler} from './task-scheduler.mjs';
import {renderReport} from './report.mjs';
import {findScriptCase} from './detail-preview.mjs';

test('用例描述按完整路径映射，覆盖独立入口001/002并排除同名自定义脚本',()=>{
 const root='D:\\workspace\\Mobilework-test';
 for(const n of [1,2,16])assert.equal(findScriptCase({path:root+'/scripts/run-client-case'+String(n).padStart(3,'0')+'.mjs'},root)?.number,n);
 assert.equal(findScriptCase({path:'D:/other/run-client-case001.mjs',name:'日程管理'},root),null);
 assert.equal(findScriptCase({path:root+'/scripts/run-client-case001.mjs'},undefined),null);
});

test('旧并行参数归一为串行，等待模型与未完成交接均不能放行下条',()=>{
 assert.equal(normalizeConfig({executionStrategy:'parallel',maxParallel:16}).executionStrategy,'serial');
 assert.equal(normalizeConfig({executionStrategy:'parallel',maxParallel:16}).maxParallel,1);
 const scheduler=new TaskScheduler(),a={id:'a',status:'QUEUED',config:{executionStrategy:'parallel',maxParallel:16,cdpPort:9223}},b={...a,id:'b'};
 scheduler.enqueue(a,{cooperative:true,start:()=>{}});scheduler.enqueue(b,{cooperative:true,start:()=>{}});
 scheduler.acquire('a','PREPARING');scheduler.release('a',{url:'file:///MobileWork/resources/app-dist/index.html#/session/ses_a',sessionId:'ses_a'});
 assert.equal(b.status,'QUEUED');assert.equal(scheduler.nextStatus('a').ready,false);assert.throws(()=>scheduler.advance('a','b'),/取消并行/);
 a.status='BLOCKED';scheduler.finish('a',{unresolved:true});assert.equal(b.status,'QUEUED');
 scheduler.finish('a');assert.equal(b.status,'RUNNING');
});

test('源码接口只读已登记脚本且要求凭证，勾选批次按序号记录并禁用旧并行入口',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-source-ui-')),script=path.join(dir,'fixture.mjs');
 await fs.writeFile(script,'// MW_TEST_CONFIG_JSON\nconst text = "<script>test</script>";');
 const {server,url}=await createConsole({port:0,dataDir:dir});
 try{
  const state=await (await fetch(url+'/api/state')).json(),headers={'content-type':'application/json','x-console-token':state.token};
  const created=await (await fetch(url+'/api/scripts',{method:'POST',headers,body:JSON.stringify({name:'源码测试',path:script})})).json();
  const next=await (await fetch(url+'/api/state')).json(),registered=next.scripts.find(s=>s.path===script);assert.ok(registered,JSON.stringify(created));
  assert.equal((await fetch(url+'/api/scripts/'+registered.id+'/source')).status,403);
  const source=await (await fetch(url+'/api/scripts/'+registered.id+'/source',{headers})).json();assert.match(source.content,/<script>test/);
  assert.equal((await fetch(url+'/api/scripts/not-registered/source',{headers})).status,404);
  const ids=[next.scripts[2].id,next.scripts[0].id];
  const batch=await (await fetch(url+'/api/batches',{method:'POST',headers,body:JSON.stringify({mode:'selected',scriptIds:ids,config:{executionStrategy:'parallel',maxParallel:3}})})).json();
  const detail=await (await fetch(url+'/api/batches/'+batch.id)).json();
  assert.deepEqual(detail.entries.map(e=>e.number),[1,3]);assert.equal(detail.config.executionStrategy,'serial');
  assert.equal((await fetch(url+'/api/jobs/old/next',{method:'POST',headers,body:'{}'})).status,409);
 }finally{await new Promise(r=>server.close(r));}
});

async function withUI(run){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-usability-')),{server,url}=await createConsole({port:0,dataDir:dir});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],errors=[];
  const projectRoot='D:/workspace/Mobilework-test';
  const scripts=Array.from({length:8},(_,i)=>({id:'s'+(i+1),name:'用例 '+(i+1),path:i===6?'D:/custom/run-client-case007.mjs':projectRoot+'/scripts/run-client-case'+String(i+1).padStart(3,'0')+'.mjs',exists:true,integrated:true}));
  const jobs=scripts.map((s,i)=>({id:'j'+(i+1),scriptId:s.id,name:s.name,status:'PASS',sessionId:'ses_test',startedAt:'2026-10-22T01:00:00Z'}));
  const state={projectRoot,token:'test',config:normalizeConfig(),capabilities:{taskIsolation:2,taskScheduling:1,serialOnly:1,scriptSource:1,detailPreview:1},scripts,jobs,batches:[],active:0};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const req=route.request(),pathname=new URL(req.url()).pathname;
   if(pathname==='/api/state')return route.fulfill({json:state});
   if(pathname==='/api/cdp-config')return route.fulfill({json:{allowed:true,connected:true}});
   if(pathname.endsWith('/source'))return route.fulfill({json:{name:'源码',path:'fixture.mjs',content:'// <script>unsafe()</script>\nconsole.log("只读");'}});
   if(req.method()==='POST')requests.push({path:pathname,body:req.postDataJSON()});
   if(pathname==='/api/config')return route.fulfill({json:req.postDataJSON()});
   if(pathname==='/api/batches')return route.fulfill({status:201,json:{id:'batch'}});
   if(pathname==='/api/batches/batch/complete')return route.fulfill({json:{id:'batch'}});
   if(pathname==='/api/run')return route.fulfill({status:202,json:{id:'new-'+requests.length}});
   return route.fulfill({status:404,json:{error:'isolated'}});
  });
  await page.route('**/reports/*',route=>route.fulfill({contentType:'text/html',body:renderReport({...jobs[5],result:{checks:[],evidence:[]}})}));
  await page.goto(url);await page.locator('#scripts tr').last().waitFor();
  await run({page,requests,url});assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}

test('跨页勾选、全选反选与范围互斥，部分用例按原顺序串行提交',async()=>withUI(async({page,requests})=>{
 assert.equal(await page.locator('[name=executionStrategy],#maxParallel,.execute-next').count(),0);
 await page.locator('#scripts .script-choice').nth(1).check();await page.locator('#scriptNextPage').click();await page.locator('#scripts .script-choice').nth(1).check();
 assert.match(await page.locator('#selectionCount').innerText(),/已选 2 条/);
 await page.locator('#runSelected').click();await page.getByText(/执行勾选：已加入队列 2 条/).first().waitFor();
 assert.deepEqual(requests.filter(r=>r.path==='/api/run').map(r=>r.body.scriptId),['s2','s7']);
 assert.ok(requests.filter(r=>r.path==='/api/run').every(r=>r.body.config.executionStrategy==='serial'&&r.body.config.maxParallel===1));
 await page.locator('#selectAllScripts').click();assert.match(await page.locator('#selectionCount').innerText(),/已选 8 条/);
 await page.locator('#invertScripts').click();assert.match(await page.locator('#selectionCount').innerText(),/已选 0 条/);
 await page.locator('#scripts .script-choice').first().check();await page.locator('[name=selectionMode][value=range]').check();
 assert.equal(await page.locator('#scripts .script-choice').first().isDisabled(),true);assert.equal(await page.locator('#selectionControls').isVisible(),false);
 await page.locator('#scriptRange').fill('3-4');await page.locator('#runRange').click();await page.getByText(/执行序号 3-4：已加入队列 2 条/).first().waitFor();
 assert.deepEqual(requests.filter(r=>r.path==='/api/run').slice(-2).map(r=>r.body.scriptId),['s3','s4']);
 await page.locator('[name=selectionMode][value=selected]').check();assert.equal(await page.locator('#scriptRange').inputValue(),'');
 assert.match(await page.locator('#selectionCount').innerText(),/已选 0 条/);
}));

test('报告和Trace加载中可立即返回，保留页码勾选滚动；脚本名展示用例描述',async()=>withUI(async({page,url,requests})=>{
 await page.locator('#scriptNextPage').click();await page.locator('#scripts .script-choice').first().check();await page.locator('#stepInterval').fill('1.7');
 await page.locator('#scripts tr').first().scrollIntoViewIfNeeded();
 const position=await page.evaluate(()=>{window.retainedList=true;return scrollY;});
 await page.locator('#scripts tr').first().getByRole('link',{name:'截图报告'}).click();
 await page.frameLocator('.detail-preview iframe').getByRole('heading',{name:'测试用例执行报告'}).waitFor();
 await page.frameLocator('.detail-preview iframe').getByRole('link',{name:'返回脚本列表'}).click();
 await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 assert.equal(await page.evaluate(()=>window.retainedList),true);assert.equal(await page.locator('#stepInterval').inputValue(),'1.7');
 assert.equal(await page.locator('#scripts tr').first().getAttribute('data-script-number'),'6');assert.equal(await page.locator('#scripts .script-choice').first().isChecked(),true);
 assert.ok(Math.abs(await page.evaluate(()=>scrollY)-position)<5);
 await page.locator('#scripts .script-title').first().click();await page.locator('.case-description').getByRole('heading',{name:'代码开发02-CI/CD流水线'}).waitFor();
 assert.match(await page.locator('.case-description').innerText(),/MW-CLIENT-006/);
 assert.equal(await page.locator('.case-description dd').filter({hasText:/^github$/}).count(),1);
 assert.equal(await page.locator('.detail-preview-body script').count(),0);
 await page.goBack();await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 await page.locator('#scripts .script-title').nth(1).click();await page.getByText('此脚本尚未关联用例描述。当前支持项目内置的前16条用例。').waitFor();
 await page.goBack();await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 assert.deepEqual(requests,[]);
 let release;await page.route(url+'/?trace=*',async route=>{await new Promise(r=>release=r);await route.abort().catch(()=>{});});
 await page.locator('#scripts tr').first().getByRole('link',{name:'Trace 记录'}).click();
 await page.waitForFunction(()=>document.querySelector('.detail-preview').open);
 await page.getByRole('button',{name:'关闭 · 返回列表',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);release?.();
 assert.equal(await page.evaluate(()=>window.retainedList),true);
}));
