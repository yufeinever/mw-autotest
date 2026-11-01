import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {identifyKanbanTask,releaseKanbanResources,validateKanbanOwnership} from './mobilework-kanban.mjs';

test('看板自动发送核对空间和真实首条指令，等待用户消息落库且不接管其他Session',async()=>{
 const task={originUrl:'file:///MobileWork/index.html#/workspace/own/session',prompt:'请在canvasId：own-board创建独立测试计数器',submitted:true,sessionId:null},owned={title:'MW-Autotest-Kanban-149-01234567',beforeIds:[],beforeWidgetIds:[],submitted:true,id:'own-board',pendingAdd:false,removing:false,task};
 validateKanbanOwnership(owned);let reads=0,text=task.prompt,current='file:///MobileWork/index.html#/workspace/own/session/ses_own';
 const server=http.createServer((request,response)=>{
  response.setHeader('Content-Type','application/json');
  if(request.url==='/session/ses_own'){response.end(JSON.stringify({id:'ses_own',directory:'D:/fixture'}));return;}
  if(request.url.startsWith('/session/ses_own/message?')){reads++;response.end(JSON.stringify(reads===1?[]:[{info:{role:'user'},parts:[{type:'text',text}]}]));return;}
  response.writeHead(404);response.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connection={baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'fixture',opencodePassword:'synthetic'},page={url:()=>current,waitForTimeout:async()=>{}};
 try{
  const link=await identifyKanbanTask(page,{kanban:owned},{connection});assert.equal(link.sessionId,'ses_own');assert.equal(reads,2);assert.equal(link.sessionUrl,current);
  task.sessionId='ses_own';current='file:///MobileWork/index.html#/kanban/own-board';assert.equal((await identifyKanbanTask(page,{kanban:owned},{connection})).sessionId,'ses_own');
  current='file:///MobileWork/index.html#/workspace/other/session/ses_own';await assert.rejects(identifyKanbanTask(page,{kanban:owned},{connection}),/未接管未知任务/);
  current='file:///MobileWork/index.html#/workspace/own/session/ses_other';await assert.rejects(identifyKanbanTask(page,{kanban:owned},{connection}),/Session已改变/);
  current=link.sessionUrl;text='其他人的相似计数器任务';await assert.rejects(identifyKanbanTask(page,{kanban:owned},{connection}),/完整登记指令不一致/);
  assert.throws(()=>validateKanbanOwnership({...owned,task:{...task,prompt:task.prompt+'替换'}},owned),/不能替换/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('看板AI模型未结束禁止删除，终态仅清理本轮静态组件及独立孤立材料',async()=>{
 const canvas={canvasId:'own-board',title:'MW-Autotest-Kanban-150-01234567'},title=canvas.title.replace('Kanban','Widget');
 const owned={title:canvas.title,beforeIds:['user-board'],beforeWidgetIds:['user-widget'],submitted:true,id:canvas.canvasId,pendingAdd:false,removing:false,widgetTitle:title,widgetPending:true,task:{originUrl:'file:///MobileWork/index.html#/workspace/own/session',prompt:'修改own-board',submitted:true,sessionId:'ses_own'}};
 validateKanbanOwnership(owned);const resources={kanban:owned},events=[];let deleted=false,orphanDeleted=false;
 const client=async()=>async(route,options={})=>{
  events.push(route+':'+(options.method||'GET'));
  if(route==='/canvases')return {items:[{canvasId:'user-board',title:'用户看板'},...deleted?[]:[canvas]]};
  if(route==='/canvases/user-board')return {canvas:{canvasId:'user-board'},placements:[{widgetId:'user-widget'}]};
  if(route==='/widgets')return {items:[{widgetId:'user-widget',title:'用户组件'},...deleted?[]:[{widgetId:'own-widget',title}],...orphanDeleted?[]:[{widgetId:'own-orphan',title}]]};
  if(route==='/canvases/own-board'&&options.method==='DELETE'){deleted=true;return {};}
  if(route==='/canvases/own-board')return {canvas,placements:[{widgetId:'own-widget'}]};
  if(route==='/widgets/own-orphan'&&options.method==='DELETE'){orphanDeleted=true;return {};}
  throw Error('越界请求：'+route);
 };
 const page={url:()=> 'file:///MobileWork/index.html#/workspace/own/session/ses_own'};
 await assert.rejects(releaseKanbanResources(page,resources,{client}),/模型任务尚未确认终态/);assert.deepEqual(events,[]);
 await releaseKanbanResources(page,resources,{client,modelSettled:true});assert.equal(resources.kanban,undefined);assert.equal(deleted,true);assert.equal(orphanDeleted,true);assert.ok(!events.includes('/widgets/user-widget:DELETE'));assert.ok(!events.includes('/canvases/user-board:DELETE'));
});
