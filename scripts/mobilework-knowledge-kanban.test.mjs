import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {previewBrowserOptions} from '../local-console/environment.mjs';
import {stableParseModelMenu} from './mobilework-knowledge-settings.mjs';
import {dismissOwnedKnowledgeDialog} from './mobilework-knowledge-resources.mjs';
import {validateKanbanOwnership,ownedCanvasCandidate,ownedCanvasWidgets,releaseKanbanResources} from './mobilework-kanban.mjs';

test('解析模型异步列表替换后按唯一身份读取，重名不混淆且重复身份暴露',async()=>{
 const browser=await chromium.launch(previewBrowserOptions());
 try{
  const page=await browser.newPage();await page.setContent('<div id="menu"></div>');
  await page.evaluate(()=>{
   window.renderModels=(ids)=>{
    const root=document.querySelector('#menu');root.replaceChildren();
    for(const [index,id] of ids.entries()){
     if(index===1){const label=document.createElement('div');label.textContent='自定义模型';root.append(label);}
     const button=document.createElement('button'),span=document.createElement('span');span.className='truncate';span.textContent='同名模型';button.append(span);button.__reactFiber$fixture={key:JSON.stringify(id)};root.append(button);
    }
   };
   renderModels([['official','old']]);
   setTimeout(()=>renderModels([['official','new/model'],['personal','new/model']]),220);
  });
  const menu=page.locator('#menu'),started=Date.now(),sample=await stableParseModelMenu(page,menu);
  try{
   assert.ok(Date.now()-started>=1100);
   assert.deepEqual(await sample.evaluate(value=>value.models),[{id:'official/new/model',title:'同名模型',custom:false},{id:'personal/new/model',title:'同名模型',custom:true}]);
   assert.equal(await sample.evaluate(value=>value.elements.every(element=>element.isConnected)),true);
  }finally{await sample.dispose();}
  await page.evaluate(()=>renderModels([['same','id'],['same','id']]));
  await assert.rejects(stableParseModelMenu(page,menu),error=>error.review&&/唯一身份/.test(error.message));
 }finally{await browser.close();}
});

test('解析模型异常收尾只关闭本轮菜单并保留未知窗口',async()=>{
 const events=[],owned={modelMenuToken:'owned-model-menu'};
 const page={locator:selector=>{assert.equal(selector,'[data-mw-parse-model-owner="owned-model-menu"]');return {count:async()=>1,press:async key=>events.push(key),waitFor:async state=>events.push(state.state)};}};
 await dismissOwnedKnowledgeDialog(page,owned);assert.deepEqual(events,['Escape','hidden']);assert.equal(owned.modelMenuToken,undefined);
 await dismissOwnedKnowledgeDialog({locator:()=>{throw Error('不应寻找未知菜单');}},{});
});

test('看板恢复拒绝旧ID、改名替换、既有组件及带执行事件的模板',()=>{
 const owned={title:'MW-Autotest-Kanban-146-01234567',beforeIds:['user-board'],beforeWidgetIds:['user-widget'],submitted:true,id:'own-board',pendingAdd:true,removing:false};
 const canvas={canvasId:'own-board',title:owned.title},detail={canvas,placements:[{widgetId:'own-widget'}]},widgets=[{widgetId:'own-widget',title:'番茄钟'}];
 validateKanbanOwnership(owned);assert.equal(ownedCanvasCandidate([canvas],owned),canvas);assert.deepEqual(ownedCanvasWidgets(detail,widgets,owned),['own-widget']);
 assert.equal(ownedCanvasCandidate([{...canvas,canvasId:'user-board'}],owned),null);
 assert.throws(()=>ownedCanvasCandidate([{...canvas,canvasId:'other'}],owned),/ID已变化/);
 assert.throws(()=>ownedCanvasCandidate([canvas,{...canvas,canvasId:'duplicate'}],owned),/多个新ID/);
 assert.throws(()=>validateKanbanOwnership({...owned,beforeIds:[]},owned),/替换本轮/);
 assert.throws(()=>validateKanbanOwnership({...owned,id:'user-board'}),/归属无效/);
 assert.throws(()=>ownedCanvasWidgets({...detail,canvas:{...canvas,builtin:true}},widgets,owned),/归属不匹配/);
 assert.throws(()=>ownedCanvasWidgets({canvas,placements:[{widgetId:'user-widget'}]},[{widgetId:'user-widget',title:'番茄钟'}],owned),/未确认归属/);
 assert.throws(()=>ownedCanvasWidgets(detail,[{...widgets[0],events:{submit:{}}}],owned),/执行事件/);
});

test('组件添加未决不删除，恢复后先还原全屏再仅移除本轮看板',async()=>{
 const owned={title:'MW-Autotest-Kanban-146-01234567',beforeIds:['user-board'],beforeWidgetIds:['user-widget'],submitted:true,id:'own-board',pendingAdd:true,removing:false,fullscreenBaseline:false};
 const resources={kanban:owned},events=[],user={canvasId:'user-board',title:'用户看板'},canvas={canvasId:'own-board',title:owned.title};let placed=false,deleted=false,fullscreen=true;
 const client=async()=>async(route,options={})=>{
  events.push(route+':'+(options.method||'GET'));
  if(route==='/canvases')return {items:deleted?[user]:[user,canvas]};
  if(route==='/widgets')return {items:deleted?[{widgetId:'user-widget',title:'用户组件'}]:[{widgetId:'user-widget',title:'用户组件'},{widgetId:'own-widget',title:'番茄钟'}]};
  if(route==='/canvases/own-board'&&options.method==='DELETE'){assert.equal(fullscreen,false);deleted=true;return {canvasId:owned.id};}
  if(route==='/canvases/own-board')return {canvas,placements:placed?[{widgetId:'own-widget'}]:[]};
  throw Error('不应访问其他看板'+route);
 };
 const page={url:()=> 'file:///MobileWork/index.html#/kanban/own-board',waitForTimeout:async()=>{throw Object.assign(Error('模拟强停打断未决观察'),{stopped:true});},getByRole:(role,{name})=>({filter:()=>({count:async()=>name==='退出全屏'&&fullscreen?1:0,click:async()=>{events.push('还原全屏');fullscreen=false;},waitFor:async()=>{assert.equal(fullscreen,false);}})})};
 await assert.rejects(releaseKanbanResources(page,resources,{client}),error=>error.stopped);assert.equal(deleted,false);assert.equal(resources.kanban,owned);
 placed=true;await releaseKanbanResources(page,resources,{client});assert.equal(resources.kanban,undefined);assert.equal(deleted,true);assert.ok(events.indexOf('还原全屏')<events.indexOf('/canvases/own-board:DELETE'));assert.ok(!events.some(event=>event.includes('/canvases/user-board')));
});
