import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole,projectRoot} from './server.mjs';
import {withClientCases} from './case-registry.mjs';
import {scriptEdition,scriptsInSuite} from './script-groups.mjs';
import {findScriptCase} from './detail-preview.mjs';
import {normalizeConfig} from './policy.mjs';

test('旧脚本迁移保留ID及顺序，公众版不复用政企业务定义',()=>{
 const legacy={id:'legacy',name:'原名',path:path.join(projectRoot,'scripts/run-client-case001.mjs')};
 const custom={id:'public-custom',name:'公众版自定义',path:path.join(os.tmpdir(),'public-custom.mjs'),clientEdition:'public'};
 const scripts=withClientCases([legacy,custom],projectRoot);
 assert.equal(scripts[0].id,'legacy');assert.equal(scripts[0].name,'原名');assert.equal(scriptEdition(scripts[0]),'enterprise');
 assert.equal(scriptsInSuite(scripts,'functional','enterprise').length,203);
 assert.deepEqual(scriptsInSuite(scripts,'functional','public').map(s=>s.id),['public-custom']);
 assert.ok(findScriptCase(scripts[0],projectRoot));
 assert.equal(findScriptCase({...scripts[0],clientEdition:'public'},projectRoot),null);
 assert.deepEqual(withClientCases(scripts,projectRoot),scripts,'重复启动不重新生成ID或覆盖归属');
});

test('实际控制台页面切版、独立新增、跨版API拦截及历史保留',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-script-editions-'));
 const legacy={id:'legacy',name:'政企测试入口',path:path.join(projectRoot,'local-console/fixture-script.mjs')};
 const publicPath=path.join(dir,'public-fixture.mjs');
 await fs.writeFile(publicPath,'// MW_TEST_CONFIG_JSON: isolated registration fixture, never executed\n');
 await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify({config:normalizeConfig(),scripts:[legacy]}));
 for(const [id,edition,startedAt,status] of [['old-enterprise','enterprise','2026-11-01T00:00:00Z','PASS'],['old-public','public','2026-11-01T01:00:00Z','FAIL']]){
  const jobDir=path.join(dir,'jobs',id);await fs.mkdir(jobDir,{recursive:true});
  await fs.writeFile(path.join(jobDir,'job.json'),JSON.stringify({id,scriptId:legacy.id,name:legacy.name,path:legacy.path,status,config:normalizeConfig({clientEdition:edition}),startedAt,endedAt:startedAt,log:'历史记录保留'}));
 }
 let probes=0;
 const app=await createConsole({port:0,dataDir:dir,discoverPort:async()=>null,clientProbe:async()=>{probes++;return {connected:true};}});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/cdp-config',r=>r.fulfill({json:{allowed:true,connected:true,port:9223,version:'isolated-fixture'}}));
  await page.goto(app.url);await page.getByText('本机服务已连接',{exact:true}).waitFor();
  assert.equal(await page.locator('#scriptEditionBadge').textContent(),'政企版');
  assert.match(await page.locator('#scriptPageInfo').textContent(),/共 204 条/);
  assert.match(await page.locator('[data-script-id="legacy"]').textContent(),/通过/);
  assert.doesNotMatch(await page.locator('[data-script-id="legacy"]').textContent(),/失败/,'另一版历史不作为本版最近结果');
  await page.locator('[name=selectionMode][value=selected]').check();await page.locator('#selectAllScripts').click();
  assert.match(await page.locator('#selectionCount').textContent(),/已选 [1-9]/);
  const switchTo=async label=>{
   await page.getByRole('radio',{name:label,exact:true}).check();
   await page.getByText('已切换到'+label+'，执行前将核对实际连接。',{exact:true}).waitFor();
  };
  await switchTo('公众版');
  assert.equal(await page.locator('#scriptEditionBadge').textContent(),'公众版');
  assert.match(await page.locator('#scripts').textContent(),/公众版暂无独立功能用例脚本/);
  assert.match(await page.locator('#selectionCount').textContent(),/已选 0 条/);
  assert.equal(await page.locator('#runAll').isDisabled(),true);
  assert.equal(await page.locator('#runSelected').isDisabled(),true);
  let state=await (await fetch(app.url+'/api/state')).json();
  const post=async(url,body)=>{const r=await fetch(app.url+url,{method:'POST',headers:{'content-type':'application/json','x-console-token':state.token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const before=probes;
  for(const [url,body] of [['/api/run',{scriptId:'legacy',config:state.config}],['/api/batches',{scriptIds:['legacy'],mode:'single',config:state.config}],['/api/run',{scriptId:'legacy',config:normalizeConfig()}]]){
   const r=await post(url,body);assert.equal(r.status,400);assert.match(r.body.error,/不能在公众版执行|客户端版本已变化/);
  }
  assert.equal(probes,before,'跨版在连接和任务创建前拦截');
  await page.locator('#add').click();await page.locator('#scriptName').fill('公众版独立登记验证');await page.locator('#scriptPath').fill(publicPath);
  await page.locator('#addForm button[type=submit]').click();
  await page.getByText('脚本已添加到公众版 · 功能用例。',{exact:true}).waitFor();
  assert.match(await page.locator('#scriptPageInfo').textContent(),/共 1 条/);
  state=await (await fetch(app.url+'/api/state')).json();const added=state.scripts.find(s=>s.path===publicPath);
  assert.equal(added.clientEdition,'public');
  const batch=await post('/api/batches',{scriptIds:[added.id],mode:'all',config:state.config});assert.equal(batch.status,201,'全部执行只校验当前版列表');
  const detail=await (await fetch(app.url+'/api/batches/'+batch.body.id)).json();assert.equal(detail.config.clientEdition,'public');assert.equal(detail.scripts.length,1);
  await post('/api/batches/'+batch.body.id+'/complete',{});
  const evidence=path.join(projectRoot,'runs/script-editions-regression');await fs.mkdir(evidence,{recursive:true});
  await page.locator('#scriptSection').screenshot({path:path.join(evidence,'public.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('#scriptSection').screenshot({path:path.join(evidence,'public-mobile.png')});
  assert.equal(await page.locator('#scriptEditionBadge').evaluate(e=>e.getBoundingClientRect().right<=innerWidth),true);
  await page.setViewportSize({width:1440,height:1000});await switchTo('政企版');
  assert.doesNotMatch(await page.locator('#scripts').textContent(),/公众版独立登记验证/);
  await page.locator('#scriptSection').screenshot({path:path.join(evidence,'enterprise.png')});
  const duplicate=await post('/api/scripts',{name:'不能共享入口',path:publicPath});assert.equal(duplicate.status,400);assert.match(duplicate.body.error,/脚本已经添加/);
  const saved=JSON.parse(await fs.readFile(path.join(dir,'settings.json'),'utf8'));assert.equal(saved.scripts.find(s=>s.id==='legacy').clientEdition,'enterprise');assert.equal(saved.scripts.find(s=>s.id===added.id).clientEdition,'public');
  state=await (await fetch(app.url+'/api/state')).json();assert.equal(state.jobs.length,2);assert.equal(state.active,0);assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(resolve=>app.server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});
