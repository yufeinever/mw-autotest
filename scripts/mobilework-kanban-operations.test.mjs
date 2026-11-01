import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseKanbanResources,validateKanbanOwnership} from './mobilework-kanban.mjs';
import {kanbanRefreshCode} from './mobilework-kanban-operation-resources.mjs';
import {validateMailBaseline,disposablePendingMail,priorityForFacts} from './mobilework-mail-baseline.mjs';

test('刷新收尾停止本轮运行后清理独占资源，保留用户库和跨资源绑定',async()=>{
 const title='MW-Autotest-Kanban-152-01234567',widgetTitle=title.replace('Kanban','Widget');
 const owned={title,widgetTitle,beforeIds:['user-board'],beforeWidgetIds:['user-widget'],submitted:true,id:'canvas_own',pendingAdd:false,removing:false,widgetIds:['widget_own'],library:{title:title.replace('Kanban','Library'),beforeIds:['library_user'],submitted:true,id:'library_own'},refresh:{title:title+'-刷新',beforeIds:['automation_user'],submitted:true,automationId:'automation_own',widgetId:'widget_own',bindingId:'binding_own'}};
 validateKanbanOwnership(owned);let running=true,removed=false,library=true,foreign=false,code=kanbanRefreshCode;const writes=[];
 const call=async(route,{method='GET'}={})=>{
  if(method!=='GET')writes.push([method,route]);
  if(route==='/library')return {items:[{libraryId:'library_user',title:'用户模板'},...library?[{libraryId:'library_own',title:owned.library.title,html:'<h1>'+widgetTitle+'</h1>'}]:[]]};
  if(route==='/library/library_own'&&method==='DELETE'){library=false;return {};}
  if(route==='/automations')return {items:[{automationId:'automation_user'},...removed?[]:[{automationId:'automation_own',title:title+'-刷新',trigger:{kind:'manual'},execution:{kind:'code',runtime:'python'}}]]};
  if(route==='/automations/automation_own/code')return {content:code};
  if(route==='/automations/automation_own/runs')return {items:[{status:running?'running':'cancelled'}]};
  if(route==='/automations/automation_own/cancel'){running=false;return {};}
  if(route==='/bindings')return {items:removed?[]:[{bindingId:'binding_own',automationId:'automation_own',widgetId:foreign?'widget_user':'widget_own'}]};
  if(route==='/canvases')return {items:[{canvasId:'user-board',title:'用户板'},...removed?[]:[{canvasId:'canvas_own',title}]]};
  if(route==='/widgets')return {items:[{widgetId:'user-widget',title:'用户组件'},...removed?[]:[{widgetId:'widget_own',title:widgetTitle,events:{submit:{}},bindings:{main:'binding_own'}}]]};
  if(route==='/canvases/canvas_own'&&method==='DELETE'){assert.equal(running,false);removed=true;return {};}
  if(route==='/canvases/canvas_own')return {canvas:{canvasId:'canvas_own',title},placements:[{widgetId:'widget_own'}]};
  throw Error('越界操作 '+route);
 };
 const page={url:()=> 'file:///MobileWork/index.html#/kanban/canvas_own',waitForTimeout:async()=>{}};
 // Do not destroy either endpoint if the supposedly owned binding moved.
 foreign=true;await assert.rejects(releaseKanbanResources(page,{kanban:structuredClone(owned)},{client:async()=>call}),/其他资源引用/);assert.equal(removed,false);
 foreign=false;library=true;code='其他代码';await assert.rejects(releaseKanbanResources(page,{kanban:structuredClone(owned)},{client:async()=>call}),/代码已变化/);assert.equal(removed,false);
 code=kanbanRefreshCode;library=true;const resources={kanban:structuredClone(owned)};await releaseKanbanResources(page,resources,{client:async()=>call});assert.equal(resources.kanban,undefined);assert.equal(removed,true);assert.equal(library,false);assert.ok(writes.every(([,route])=>!route.includes('user')));
 // Product cascade may have removed the widget/automation before retrying cleanup.
 await releaseKanbanResources(page,{kanban:{...structuredClone(owned),removing:true,library:undefined}},{client:async()=>call});
 assert.throws(()=>validateKanbanOwnership({...owned,pin:{canvasId:'canvas_user',widgetId:'widget_own',confirmed:true}}),/归属/);
});

test('独立邮箱基线拒绝旧日期，未授权邮件不参与变更，优先级按独立业务事实',()=>{
 const now=Date.parse('2026-11-01T10:00:00+08:00'),mail={id:'mail_test',title:'可丢弃测试邮件',priority:'high',disposable:false,receivedAt:'2026-11-01',status:'pending',actionable:true,asap:true};
 const baseline={source:'external-test-mailbox',observedAt:new Date(now).toISOString(),summary:{receivedToday:1,pending:1,handledThisWeek:0},messages:[mail]};
 assert.equal(validateMailBaseline(baseline,now),baseline);assert.throws(()=>validateMailBaseline({...baseline,observedAt:'2026-10-31T10:00:00+08:00'},now),/当天/);assert.throws(()=>validateMailBaseline({...baseline,source:'dashboard-api'},now),/独立/);
 assert.equal(disposablePendingMail(baseline,[mail]),null);mail.disposable=true;assert.equal(disposablePendingMail(baseline,[mail]),mail);assert.equal(disposablePendingMail(baseline,[{...mail,title:'其他邮件'}]),null);
 assert.equal(priorityForFacts(mail,now),'high');assert.equal(priorityForFacts({...mail,asap:false,deadlineMs:now+86400000},now),'medium');assert.equal(priorityForFacts({...mail,actionable:false},now),'low');assert.equal(priorityForFacts({...mail,asap:false,deadlineMs:Date.parse('2026-11-01T23:59:59+08:00')},now),'high');
});
