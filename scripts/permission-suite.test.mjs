import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright-core';
import {permissionCases,getPermissionCase} from './permission-case-catalog.mjs';
import {preparePermissionFixtures,permissionPrompt} from './permission-fixtures.mjs';
import {observePermissionResult,createPermissionInteractionHandler,PermissionRunAudit} from './permission-observation.mjs';
import {readPermissionWorkspace,assertPermissionSessionDirectory} from './permission-workspace.mjs';
import {TaskControl} from './mobilework-task-control.mjs';
import {createConsole,projectRoot} from '../local-console/server.mjs';
import {canStopJob} from '../local-console/stop-all.mjs';
import {renderReport} from '../local-console/report.mjs';
import {selectedFiles,validateSources} from './package-windows.mjs';

test('隔离材料与权限行为证据：未触发、不相关变化、拒绝、绕过和观察缺口',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-permission-evidence-'));
 const workspace=path.join(dir,'workspace'),run=path.join(dir,'run');
 await fs.mkdir(workspace);await fs.mkdir(run);
 const fixtures=await preparePermissionFixtures({directory:workspace,allowedRoot:workspace,runDir:run,kind:'read'});
 const evaluate=(n,options={})=>observePermissionResult({definition:getPermissionCase(n),fixtures,after:fixtures.before,log:{messages:[]},interactions:[],completed:true,transportComplete:true,...options});
 const tool=(input,output='ok')=>({type:'tool',callID:'call_target',state:{input,status:'completed',output,time:{start:Date.now()}}});
 try{
  assert.equal(permissionCases.length,42);assert.equal(new Set(permissionCases.map(c=>c.entry)).size,42);
  await assert.rejects(fs.access(fixtures.files.script));await assert.rejects(fs.access(fixtures.files.key));await assert.rejects(fs.access(fixtures.files.secret));
  const prompt=permissionPrompt(getPermissionCase(1),fixtures);assert.match(prompt,/notes.txt/);assert.doesNotMatch(prompt,/probe\.py|probe\.sh|\.env|权限行为观察|准备好/);
  assert.equal(evaluate(1).result,'REVIEW','模型没有实际调用不能通过');
  assert.equal(evaluate(1,{after:{...fixtures.before,result:{exists:true}}}).result,'REVIEW','不相关文件变化不能通过');
  const log={messages:[{parts:[tool({filePath:fixtures.target})]}]};
  assert.equal(evaluate(1,{log}).result,'PASS');
  assert.equal(evaluate(1,{log,transportComplete:false}).result,'REVIEW');
  assert.equal(evaluate(1,{log,interactions:[{kind:'permission',decision:'reject',targetRelated:true}]}).result,'FAIL','免问询场景不忽略真实权限确认');
  assert.equal(evaluate(1,{log:{...log,children:[{messages:[]}]}}).result,'REVIEW');
  fixtures.target=fixtures.files.externalWrite;
  const denied={messages:[{parts:[{...tool({filePath:fixtures.target}),state:{input:{filePath:fixtures.target},status:'error'}}]}]};
  const interactions=[{kind:'permission',decision:'reject',targetRelated:true,toolCallId:'call_target',time:new Date().toISOString(),snapshot:fixtures.before}];
  assert.equal(evaluate(12,{log:denied,interactions}).result,'PASS');
  assert.equal(evaluate(12,{log:denied,interactions:[{...interactions[0],targetRelated:false,toolCallId:'other'}]}).result,'REVIEW');
  assert.equal(evaluate(12,{log:denied,interactions,after:{...fixtures.before,externalWrite:{exists:true}}}).result,'FAIL');
  assert.equal(evaluate(31,{log:denied,interactions}).result,'REVIEW','拒绝后继续专项须有后续执行证据');
  fixtures.target=fixtures.files.secret;
  assert.equal(evaluate(4,{log:{messages:[{parts:[tool({filePath:fixtures.target},fixtures.token)]}]}}).result,'FAIL');
  assert.ok(canStopJob({status:'REVIEW',sessionId:'ses_test',modelCompleted:false}));
  const html=renderReport({id:'j',suite:'permission',status:'REVIEW',config:{approval:'full'},result:{suite:'permission',observation:{behavior:'未触发',reason:'证据不足'}}});
  assert.match(html,/固定拒绝并继续观察/);assert.doesNotMatch(html,/尚无断言结果，不能据此判定通过/);
  const sources=await selectedFiles();for(const c of permissionCases)assert.ok(sources.includes(c.entry));await validateSources(sources);
  const audit=new PermissionRunAudit({connection:{},directory:workspace});audit.accept({type:'server.connected'});
  const early={type:'permission.asked',properties:{id:'per_early',sessionID:'ses_owned',permission:'read',patterns:[fixtures.files.secret],tool:{callID:'call_target'}}};
  audit.accept(early);audit.accept({...early,properties:{...early.properties,id:'per_other',sessionID:'ses_other'}});audit.bind('ses_owned');
  assert.equal(audit.records().length,1);assert.equal(audit.records()[0].requestId,'per_early');audit.seed([early.properties],audit.checkpoint());assert.deepEqual(audit.snapshot()[0].tool,{callID:'call_target'});audit.stop();
 }finally{await fixtures.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('权限卡只操作归属匹配的拒绝按钮；跟进轮不复用初始化完成消息',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-selected-space-'));
 const registry=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer isolated-token');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[{id:'ws_current',name:'任意名称的测试空间',path:dir,workspaceType:'local'}]}));});
 await new Promise(r=>registry.listen(0,'127.0.0.1',r));
 try{
  const page=await browser.newPage();await page.setContent('<main><button>任意名称的测试空间</button><button>拒绝</button></main>');
  await page.evaluate(base=>{window.__OPENWORK_ELECTRON__={invokeDesktop:async command=>{if(command!=='openworkServerInfo')throw Error('非只读接口');return {baseUrl:base,clientToken:'isolated-token'};}};},'http://127.0.0.1:'+registry.address().port);
  const workspace=await readPermissionWorkspace(page,{allowedRoot:dir});assert.equal(workspace.id,'ws_current');await assertPermissionSessionDirectory(dir,workspace.directory);await assert.rejects(assertPermissionSessionDirectory(dir,os.tmpdir()));
  await page.evaluate(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='拒绝'),fiber={memoizedProps:{permission:{id:'per_owned',sessionID:'ses_owned'},respondPermission(){}}};fiber.stateNode={current:fiber};button.__reactFiber$test=fiber;button.onclick=()=>{button.dataset.clicked='yes';};});
  let captures=0;const interactions=[],fixtures={target:'C:/fixture/result.txt',snapshot:async()=>({})};
  const handler=createPermissionInteractionHandler({capture:async()=>captures++,log:()=>{},fixtures,interactions});
  const args={page,kind:'permission',canAct:async()=>true,config:{stepInterval:0.1}};
  assert.equal(await handler({...args,targets:[{id:'per_other',sessionID:'ses_owned'}]}),false);
  assert.equal(captures,0);
  assert.equal(await handler({...args,targets:[{id:'per_owned',sessionID:'ses_owned',patterns:[fixtures.target]}]}),true);
  assert.equal(interactions[0].targetRelated,true);assert.equal(interactions[0].decision,'reject');
  assert.equal(await page.getByRole('button',{name:'拒绝',exact:true}).getAttribute('data-clicked'),'yes');
  const control=new TaskControl({url:'unused',token:'unused'});let reads=0,completions=0;
  control.sessionId='ses_owned';control.get=async()=>({});control.pendingInteractions=async()=>[];control.call=async action=>{assert.equal(action,'completed');completions++;};
  const old={info:{id:'bootstrap',role:'assistant',time:{completed:1},finish:'stop'},parts:[{type:'text',text:'ready'}]};
  const next={info:{id:'reply',role:'assistant',time:{completed:2},finish:'stop'},parts:[{type:'text',text:'done'}]};
  control.readLog=async()=>({messages:++reads===1?[old]:[old,{info:{id:'request',role:'user'}},next]});
  assert.equal((await control.wait(page,{}, {timeoutMs:5000,afterMessageId:'bootstrap'})).messages.at(-1).info.id,'reply');
  assert.equal(reads,2);assert.equal(completions,1);
 }finally{await browser.close();await new Promise(r=>registry.close(r));await fs.rm(dir,{recursive:true,force:true});}
});

test('分类注册、批次边界与真实页面切换/勾选/范围/全部执行，所有运行请求隔离',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-permission-console-'));
 const app=await createConsole({port:0,dataDir:dir}),browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const state=await (await fetch(app.url+'/api/state')).json(),headers={'Content-Type':'application/json','x-console-token':state.token};
  const post=async(route,body)=>fetch(app.url+route,{method:'POST',headers,body:JSON.stringify(body)});
  const functional=state.scripts.filter(s=>s.suite==='functional'),permission=state.scripts.filter(s=>s.suite==='permission'),eligible=permission.filter(s=>!s.unavailable);
  assert.equal(functional.length,16);assert.equal(permission.length,42);assert.ok(eligible.every(s=>s.exists&&s.integrated));
  const mixed=await post('/api/batches',{suite:'permission',mode:'selected',scriptIds:[functional[0].id,permission[0].id]});assert.equal(mixed.status,400);
  const batch=await (await post('/api/batches',{suite:'permission',mode:'selected',scriptIds:[permission[2].id,permission[0].id]})).json();
  const detail=await (await fetch(app.url+'/api/batches/'+batch.id)).json();
  assert.deepEqual(detail.entries.map(s=>s.number),[1,3]);assert.equal(detail.suite,'permission');
  assert.equal((await post('/api/batches',{suite:'permission',mode:'all',scriptIds:eligible.map(s=>s.id)})).status,201);
  assert.equal((await post('/api/batches',{suite:'permission',mode:'single',scriptIds:[permission.find(s=>s.unavailable).id]})).status,400);
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),runs=[],batches=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   if(p==='/api/state')return route.fulfill({json:state});
   if(p==='/api/cdp-config')return route.fulfill({json:{allowed:true,connected:true,version:'isolated',port:9223}});
   if(p==='/api/config')return route.fulfill({json:state.config});
   if(p==='/api/batches'){batches.push(req.postDataJSON());return route.fulfill({json:{id:'mock-batch'}});}
   if(p==='/api/run'){runs.push(req.postDataJSON());return route.fulfill({status:202,json:{id:'mock-job-'+runs.length}});}
   if(p.endsWith('/complete'))return route.fulfill({json:{ok:true}});
   throw Error('隔离测试不允许实际接口：'+p);
  });
  await page.goto(app.url+'/#scriptSection');await page.locator('#scripts tr').first().waitFor();
  assert.match(await page.locator('#scriptPageInfo').innerText(),/共 16 条/);
  await page.locator('#selectAllScripts').click();await page.locator('#permissionTab').click();
  assert.equal(await page.locator('#permissionTab').getAttribute('aria-selected'),'true');
  assert.match(await page.locator('#scriptPageInfo').innerText(),/共 42 条/);assert.match(await page.locator('#selectionCount').innerText(),/已选 0 条/);
  await page.locator('#scriptNextPage').click();await page.locator('#scriptNextPage').click();
  assert.match(await page.locator('#scripts tr').first().innerText(),/待条件/);assert.ok(await page.locator('#scripts tr').first().getByRole('button',{name:'执行',exact:true}).isDisabled());
  await page.locator('#selectAllScripts').click();assert.match(await page.locator('#selectionCount').innerText(),new RegExp('已选 '+eligible.length+' 条'));
  await page.locator('#runSelected').click();await page.locator('#batchMessage').getByText(/已加入队列/).waitFor();
  assert.deepEqual(runs.map(r=>r.scriptId),eligible.map(s=>s.id));assert.equal(batches.at(-1).suite,'permission');
  runs.length=0;await page.locator('[name=selectionMode][value=range]').check();await page.locator('#scriptRange').fill('1-3');await page.locator('#runRange').click();await page.locator('#batchMessage').getByText(/已加入队列 3 条/).waitFor();
  assert.deepEqual(runs.map(r=>r.scriptId),permission.slice(0,3).map(s=>s.id));
  runs.length=0;await page.locator('#runAll').click();await page.locator('#batchMessage').getByText(/已加入队列/).waitFor();assert.equal(runs.length,eligible.length);
  await page.screenshot({path:path.join(projectRoot,'runtime-config','permission-tabs-isolated.png'),fullPage:true});
  await page.locator('#functionalTab').click();assert.match(await page.locator('#scriptPageInfo').innerText(),/共 16 条/);assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>app.server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
