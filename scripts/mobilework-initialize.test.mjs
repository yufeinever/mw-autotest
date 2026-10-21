import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {TaskControl} from './mobilework-task-control.mjs';
import {initializeTestPage} from './mobilework-initialize.mjs';
import {readComposerState} from './mobilework-composer.mjs';
import {selectionState} from './mobilework-isolation.mjs';

async function setup(t){
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();
 await page.setContent('<style>[data-composer-toolbar-item] [role=button]{visibility:hidden}[data-composer-toolbar-item]:hover [role=button]{visibility:visible}</style><button id="new">新建任务</button><button>日常办公</button><div contenteditable="true">原来的草稿</div><div data-composer-toolbar-item="expert">专家<span role="button" aria-label="退出「专家」" onclick="this.parentElement.remove()">退出</span></div>');
 await page.locator('#new').evaluate(el=>{window.newCount=0;el.onclick=()=>{window.newCount++;location.hash='/workspace/test/session';document.querySelector('[contenteditable]').innerHTML='首页恢复的文字<span contenteditable="false"><button data-skill-remove="sdd">×</button>技能</span>';document.querySelector('#stop')?.remove();};});
 return page;
}
test('每个新脚本获得操作权后初始化，清空旧草稿和首页恢复内容，预检续跑不清空',async t=>{
 const page=await setup(t),events=[];
 for(let i=0;i<2;i++){
  const control=new TaskControl({url:'fixture',token:'fixture',log:(...args)=>events.push(args)});
  control.call=async action=>{if(action==='acquire'){assert.equal(await page.evaluate(()=>window.newCount),i);return {granted:true};}return {};};
  await control.begin(page,{stepInterval:0.1});
  assert.equal((await readComposerState(page.locator('[contenteditable]'))).text,'');assert.deepEqual(await selectionState(page),[]);
  await page.locator('[contenteditable]').fill('下一条执行前残留');
 }
 assert.equal(await page.evaluate(()=>window.newCount),2);
 const readOnly=new TaskControl({url:'fixture',token:'fixture'});readOnly.call=async()=>({granted:true});
 await readOnly.begin(page,{openComposer:false});assert.equal(await page.locator('[contenteditable]').innerText(),'下一条执行前残留');
 assert.equal(events.filter(e=>e[0]==='执行前初始化完成').length,2);
});
test('运行中任务、审批、准备中或弹窗阻塞初始化，不清空不点击新建',async t=>{
 const page=await setup(t);
 for(const content of ['<button>停止</button>','<button>允许一次</button>','<div role="dialog">确认</div>','<p>第 1 步，共 5 步：准备工作区</p>']){
  await page.evaluate(html=>{const e=document.createElement('section');e.id='obstacle';e.innerHTML=html;document.body.append(e);},content);
  await assert.rejects(()=>initializeTestPage(page,{stepInterval:0.1}),/执行前初始化失败/);
  assert.equal(await page.locator('[contenteditable]').innerText(),'原来的草稿');assert.equal(await page.evaluate(()=>window.newCount),0);
  await page.locator('#obstacle').evaluate(e=>e.remove());
 }
});
test('已确认失败页返回编辑；调度内并行会话可离开但不点击停止',async t=>{
 const page=await setup(t);
 await page.evaluate(()=>{document.querySelector('[contenteditable]').hidden=true;const e=document.createElement('section');e.id='failed';e.innerHTML='工作区准备失败<button onclick="document.querySelector(\'[contenteditable]\').hidden=false;this.parentElement.remove()">返回编辑</button>';document.body.append(e);});
 await initializeTestPage(page,{stepInterval:0.1});assert.equal(await page.evaluate(()=>window.newCount),1);
 await page.evaluate(()=>{location.hash='/workspace/test/session/ses_managed';const e=document.createElement('button');e.id='stop';e.textContent='停止';e.onclick=()=>{window.aborted=true;};document.body.append(e);});
 const control=new TaskControl({url:'fixture',token:'fixture'});control.call=async action=>action==='is-managed'?{managed:true}:{granted:true};
 await control.begin(page,{stepInterval:0.1});assert.equal(await page.evaluate(()=>window.aborted),undefined);assert.equal(await page.evaluate(()=>window.newCount),2);
});
