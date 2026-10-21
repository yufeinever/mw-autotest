import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {appendComposerText,readComposerState} from './mobilework-composer.mjs';
import {snapshotDraft,inspectPageHandoff} from './mobilework-isolation.mjs';
import {TaskScheduler} from '../local-console/task-scheduler.mjs';
import {recoverJobPage} from '../local-console/task-recovery.mjs';
import {dispatchStandalone} from './mobilework-standalone.mjs';

const fixture='<style>.chip:hover [data-skill-chip-icon]{display:none}</style><div contenteditable="true"><span contenteditable="false" class="chip"><span data-skill-chip-icon>S</span><button data-skill-remove="sdd">×</button><span data-skill-chip-label>sdd</span></span> 帮我实现需求。</div>';
async function setup(t){const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.setContent(fixture);return page;}
const config={cdpPort:9223,executionStrategy:'serial',maxParallel:3};

test('追加后异常可清理本条草稿，下一条独立运行且图标悬停不影响校验',async t=>{
 const page=await setup(t),editor=page.locator('[contenteditable="true"]');
 const before=await readComposerState(editor);let owned=await snapshotDraft(page,editor);
 await page.locator('.chip').hover();assert.deepEqual(await readComposerState(editor),before);
 const insert=page.keyboard.insertText.bind(page.keyboard);
 page.keyboard.insertText=async text=>{await insert(text);throw Error('注入：输入完成后传输中断');};
 await assert.rejects(()=>appendComposerText(editor,'独立材料',{onDraft:async next=>{owned={...owned,...next};}}),/传输中断/);
 const outcome=await recoverJobPage(page,{ownedDraft:owned});assert.equal(outcome.ready,true);
 assert.equal((await readComposerState(editor)).text,'');
 page.keyboard.insertText=insert;
 await editor.fill('下一条原提示词');const result=await appendComposerText(editor,'下一条材料');
 assert.equal(result.text,'下一条原提示词\n下一条材料');assert.ok(!result.text.includes('独立材料'));
});

test('用户修改草稿时保留并暂停队列，人工恢复后再启动下一条',async t=>{
 const page=await setup(t),editor=page.locator('[contenteditable="true"]');let owned=await snapshotDraft(page,editor);
 await appendComposerText(editor,'自动化材料',{onDraft:async next=>{owned={...owned,...next};}});
 await page.keyboard.insertText('用户新写的内容');
 const scheduler=new TaskScheduler(),started=[];
 const first={id:'first',status:'QUEUED',config},second={id:'second',status:'QUEUED',config};
 scheduler.enqueue(first,{cooperative:true,start:()=>started.push('first')});
 scheduler.enqueue(second,{cooperative:true,start:()=>started.push('second')});await new Promise(r=>setImmediate(r));
 const handoff=await inspectPageHandoff(page,{owned});assert.equal(handoff.ready,false);
 scheduler.finish(first.id,{unresolved:true});assert.deepEqual(started,['first']);assert.equal(second.status,'QUEUED');
 assert.match((await readComposerState(editor)).text,/用户新写的内容/);
 await editor.fill('');assert.equal((await inspectPageHandoff(page,{owned})).ready,true);
 scheduler.finish(first.id);await new Promise(r=>setImmediate(r));assert.deepEqual(started,['first','second']);
});

test('独立入口将原参数交给同项目调度器，不自行连接客户端',async t=>{
 const requests=[],root=path.resolve('.');
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/state')return res.end(JSON.stringify({projectRoot:root,capabilities:{taskIsolation:2},token:'fixture-token',scripts:[{id:'case5',path:path.join(root,'scripts/run-client-case005.mjs')}]}));
  if(req.url==='/api/run'){let text='';for await(const chunk of req)text+=chunk;requests.push(JSON.parse(text));assert.equal(req.headers['x-console-token'],'fixture-token');return res.end(JSON.stringify({id:'fixture-job'}));}
  if(req.url==='/api/jobs/fixture-job')return res.end(JSON.stringify({status:'CHECKED',log:'隔离预检完成\n'}));
  res.statusCode=404;res.end('{}');
 });
 // Windows may allocate a low ephemeral port prohibited by fetch. Confirm
 // the fixture transport before dispatch can attempt to launch a real service.
 for(;;){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await fetch('http://127.0.0.1:'+server.address().port+'/api/state');break;}
  catch(error){await new Promise(r=>server.close(r));if(error.cause?.message!=='bad port')throw error;}
 }
 t.after(()=>new Promise(r=>server.close(r)));
 const old=process.env.MW_CONSOLE_PORT,oldCode=process.exitCode;process.env.MW_CONSOLE_PORT=String(server.address().port);
 try{assert.equal(await dispatchStandalone({number:5,args:['--fill-check'],config}),true);assert.deepEqual(requests,[{scriptId:'case5',args:['--fill-check'],config}]);}
 finally{if(old===undefined)delete process.env.MW_CONSOLE_PORT;else process.env.MW_CONSOLE_PORT=old;process.exitCode=oldCode;}
});
test('会话确认停止后退出残留审批，存在用户草稿时仍不切走',async t=>{
 const page=await setup(t);
 await page.route('http://isolated.local/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<button onclick="location.hash=\'/workspace/test/session\'">新建任务</button><button onclick="window.approved=true">允许一次</button><div contenteditable="true"></div>'}));
 await page.goto('http://isolated.local/#/workspace/test/session/ses_stopped');
 const job={sessionId:'ses_stopped',abortAcknowledged:true,sessionSettled:true};
 await page.locator('[contenteditable]').fill('用户保留的文字');
 assert.equal((await recoverJobPage(page,job)).ready,false);assert.match(page.url(),/ses_stopped$/);
 await page.locator('[contenteditable]').fill('');
 // Model the actual client's navigation removing the old session card.
 await page.getByRole('button',{name:'新建任务',exact:true}).evaluate(button=>{button.onclick=()=>{document.querySelectorAll('button')[1].remove();location.hash='/workspace/test/session';};});
 assert.equal((await recoverJobPage(page,job)).ready,true);assert.ok(!page.url().endsWith('ses_stopped'));assert.equal(await page.evaluate(()=>window.approved),undefined);
});

test('完成会话仅退出已登记的专家选择，用户改选或草稿仍保留',async t=>{
 const page=await setup(t);
 await page.route('http://isolated.local/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<button id="new">新建任务</button><div data-composer-toolbar-item="expert"><span role="button" aria-label="退出「测试专家」">专家</span></div><div contenteditable="true"></div>'}));
 await page.goto('http://isolated.local/#/workspace/test/session/ses_done');
 await page.locator('#new').evaluate(button=>{button.onclick=()=>{document.querySelector('[data-composer-toolbar-item]').remove();location.hash='/workspace/test/session';};});
 const job={sessionId:'ses_done',modelCompleted:true,submittedSelection:[{item:'expert',exit:'退出「测试专家」'}]};
 await page.locator('[contenteditable]').fill('用户草稿');assert.equal((await recoverJobPage(page,job)).ready,false);
 await page.locator('[contenteditable]').fill('');
 await page.locator('[role="button"]').evaluate(el=>el.setAttribute('aria-label','退出「用户改选」'));assert.equal((await recoverJobPage(page,job)).ready,false);assert.ok(page.url().endsWith('ses_done'));
 await page.locator('[role="button"]').evaluate(el=>el.setAttribute('aria-label','退出「测试专家」'));
 assert.equal((await recoverJobPage(page,job)).ready,true);assert.ok(!page.url().endsWith('ses_done'));
});
