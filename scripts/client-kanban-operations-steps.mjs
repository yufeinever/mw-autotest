import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepare} from './client-kanban-steps.mjs';
import {kanbanRefreshCode,kanbanRefreshSchema,openOwnedWidgetPin,releaseKanbanOperations} from './mobilework-kanban-operation-resources.mjs';
import {runMailDashboardSteps} from './client-mail-dashboard-steps.mjs';
import {runMailWorkflowSteps} from './client-mail-workflow-steps.mjs';
import {runWeatherSteps} from './client-weather-steps.mjs';

const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
const blocked=message=>Object.assign(Error(message),{blocked:true});
const inputSchema={type:'object',properties:{},additionalProperties:false};
const cardOf=frame=>frame.locator('xpath=ancestor::div[div[contains(concat(" ",normalize-space(@class)," ")," widget-card-header ")]][1]');

async function until(context,read,ready,description,timeout=30000){
 const end=Date.now()+timeout;let value;
 do{value=await read();if(ready(value))return value;await context.page.waitForTimeout(200);}while(Date.now()<end);
 throw blocked(description);
}

async function fixture(context,{call,canvas}){
 const owned=context.resources.kanban;owned.widgetTitle=owned.title.replace('Kanban','Widget');
 owned.refresh={title:owned.title+'-刷新',beforeIds:(await call('/automations')).items.map(item=>item.automationId),submitted:false,automationId:null,widgetId:null,bindingId:null};await context.checkpointResources();
 const refresh=owned.refresh;refresh.submitted=true;await context.checkpointResources();
 const created=await call('/automations',{method:'POST',body:{title:refresh.title,description:'MobileWork自动化测试刷新任务，仅服务于本轮看板组件。',trigger:{kind:'manual'},input:{kind:'json',schema:inputSchema,defaultInput:{}},execution:{kind:'code',runtime:'python',entryRef:{kind:'path',base:'automation',path:'automation.py'}},result:{kind:'artifact',schema:kanbanRefreshSchema}}});
 refresh.automationId=created.automation.automationId;await context.checkpointResources();
 await call('/automations/'+refresh.automationId+'/code',{method:'PUT',body:{content:kanbanRefreshCode}});
 owned.widgetPending=true;await context.checkpointResources();
 const widget=await call('/widgets',{method:'POST',body:{title:owned.widgetTitle,slots:{main:{kind:'json',schema:kanbanRefreshSchema}}}});
 refresh.widgetId=widget.widgetId;owned.widgetIds=[widget.widgetId];owned.widgetPending=false;await context.checkpointResources();
 const html='<!doctype html><html><head><meta charset="utf-8"></head><body><h1>'+owned.widgetTitle+'</h1><output id="stamp">尚未刷新</output><script>window.DaimonWidget.onDataChange(function(data){document.getElementById("stamp").textContent=data.main?data.main.stamp:"尚未刷新";});</script></body></html>';
 await call('/widgets/'+widget.widgetId+'/page',{method:'PUT',body:{html}});
 await call('/widgets/'+widget.widgetId,{method:'PATCH',body:{events:{submit:{schema:inputSchema}}}});
 const binding=await call('/bindings',{method:'POST',body:{automationId:refresh.automationId,widgetId:widget.widgetId}});refresh.bindingId=binding.bindingId;await context.checkpointResources();
 const placement=await call('/canvases/'+canvas.canvasId+'/placements',{method:'POST',body:{widgetId:widget.widgetId,layout:{mode:'free',x:10,y:10,w:420,h:260}}});
 // Reload the disposable canvas through the product; API setup is a fixture,
 // never evidence that its drag/refresh/create UI works.
 await context.page.reload({waitUntil:'commit',timeout:30000});await context.page.waitForURL(url=>url.hash==='#/kanban/'+canvas.canvasId);
 const frame=context.page.locator('iframe[data-widget-id="'+widget.widgetId+'"]').filter({visible:true});await frame.contentFrame().locator('#stamp').waitFor();
 await save(context,'组件操作独立预存材料',{canvasId:canvas.canvasId,widgetId:widget.widgetId,automationId:refresh.automationId,bindingId:refresh.bindingId,placement,code:kanbanRefreshCode,source:'正常本地接口准备的无联网/文件读取Python刷新fixture，不是被测操作结果'});
 context.remaining.delete('安全刷新组件及本轮绑定材料');return {widget,frame};
}

async function dragAndResize(context,{call,canvas},{widget,frame}){
 const page=context.page,card=cardOf(frame),header=card.locator('.widget-card-header');
 const read=()=>call('/canvases/'+canvas.canvasId),find=value=>value.placements.find(item=>item.widgetId===widget.widgetId);
 const before=find(await read());await header.scrollIntoViewIfNeeded();const box=await header.boundingBox();
 context.assert('拖动柄真实可见',!!box);await page.mouse.move(box.x+30,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+100,box.y+box.height/2+45,{steps:12});await page.mouse.up();
 const moved=find(await until(context,read,value=>{const p=find(value);return p.layout.x!==before.layout.x||p.layout.y!==before.layout.y;},'拖动后实际布局未持久化'));
 const resize=card.locator('xpath=../..').locator('.cursor-nwse-resize');await resize.scrollIntoViewIfNeeded();const edge=await resize.boundingBox();
 context.assert('右下缩放控件唯一且可见',await resize.count()===1&&!!edge);await page.mouse.move(edge.x+edge.width/2,edge.y+edge.height/2);await page.mouse.down();await page.mouse.move(edge.x+edge.width/2+60,edge.y+edge.height/2+45,{steps:12});await page.mouse.up();
 const resized=find(await until(context,read,value=>{const p=find(value);return p.layout.w!==moved.layout.w||p.layout.h!==moved.layout.h;},'缩放后实际布局未持久化'));
 await page.reload({waitUntil:'commit',timeout:30000});await frame.contentFrame().locator('#stamp').waitFor();context.assert('拖动缩放重载后同placement布局保留',JSON.stringify(find(await read()).layout)===JSON.stringify(resized.layout)&&resized.mountId===before.mountId);
 await save(context,'拖动缩放真实持久化',{before,moved,resized});await context.capture('组件拖动与缩放');context.remaining.delete('真实拖动缩放及布局持久化');
}

async function refresh(context,{call},{widget,frame}){
 const owned=context.resources.kanban,card=cardOf(frame);await button(card,'组件操作').click();
 const [response]=await Promise.all([context.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/blueprint/widgets/'+widget.widgetId+'/emit'),context.page.getByRole('menuitem',{name:'刷新',exact:true}).click()]);
 context.assert('刷新按钮真实提交本轮组件emit',response.ok());const emitted=await response.json();
 context.assert('刷新实际运行属于本轮automation及binding',emitted.automationId===owned.refresh.automationId&&emitted.bindingId===owned.refresh.bindingId&&typeof emitted.runId==='string');
 const route='/automations/'+emitted.automationId+'/runs/'+emitted.runId;
 const run=await until(context,()=>call(route),value=>!['queued','running'].includes(value.status),'刷新Python任务未终态',60000);
 await save(context,'组件刷新实际任务',{emitted,run,logs:await call(route+'/logs')});context.assert('刷新真实Python执行成功',run.status==='succeeded');
 const artifact=await call(route+'/artifact'),value=JSON.parse(artifact.content),stamp='MW-refresh-'+emitted.runId;context.assert('真实刷新产物包含本轮runId',value.stamp===stamp);
 await frame.contentFrame().locator('#stamp').filter({hasText:stamp}).waitFor();context.assert('真实产物经宿主数据桥更新iframe',await frame.contentFrame().locator('#stamp').innerText()===stamp);
 await context.capture('真实刷新数据回显');context.remaining.delete('真实刷新任务产物及组件回显');return stamp;
}

async function enlargeAndPin(context,{canvas},{widget,frame},stamp){
 const owned=context.resources.kanban,card=cardOf(frame);await button(card,'放大').click();
 const dialog=context.page.getByRole('dialog',{name:owned.widgetTitle,exact:true});await dialog.waitFor();owned.previewToken=randomUUID();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-kanban-preview',token),owned.previewToken);await context.checkpointResources();
 await dialog.locator('iframe').contentFrame().locator('#stamp').filter({hasText:stamp}).waitFor();await context.capture('同组件放大显示真实数据');await dialog.press('Escape');await dialog.waitFor({state:'hidden'});delete owned.previewToken;await context.checkpointResources();
 owned.pin={canvasId:canvas.canvasId,widgetId:widget.widgetId,confirmed:false};await context.checkpointResources();await button(card,'钉到桌面').click();
 const connection='http://127.0.0.1:'+context.config.cdpPort,pin=await openOwnedWidgetPin(connection,owned);
 try{owned.pin.confirmed=true;await context.checkpointResources();await pin.page.locator('iframe').contentFrame().locator('#stamp').filter({hasText:stamp}).waitFor();await context.captureBrowser(pin.page,'独立桌面组件同数据');context.assert('固定到桌面为本轮独立组件窗口',new URL(pin.page.url()).hash==='#/widget-pin/'+canvas.canvasId+'/'+widget.widgetId);}
 finally{await pin.browser.close();}
 // Shared normal/stop cleanup closes only this exact owned pinned window.
 await releaseKanbanOperations(context.page,owned,await import('./mobilework-kanban.mjs').then(m=>m.kanbanClient(context.page)),{endpoint:connection});await context.checkpointResources();
 context.assert('取消固定已关闭本轮桌面窗口',!owned.pin);context.remaining.delete('放大固定及取消固定同组件身份');
}

async function libraryAndRemove(context,{call,canvas},{widget,frame}){
 const owned=context.resources.kanban;owned.library={title:owned.title.replace('Kanban','Library'),beforeIds:(await call('/library')).items.map(item=>item.libraryId),submitted:false,id:null};await context.checkpointResources();
 await button(cardOf(frame),'组件操作').click();await context.page.getByRole('menuitem',{name:'添加到组件库',exact:true}).click();
 const dialog=context.page.getByRole('dialog',{name:'添加到组件库',exact:true});await dialog.waitFor();owned.dialogToken=randomUUID();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-kanban-dialog',token),owned.dialogToken);await context.checkpointResources();
 await dialog.getByPlaceholder('组件名称',{exact:true}).fill(owned.library.title);owned.library.submitted=true;await context.checkpointResources();await button(dialog,'确定').click();await dialog.waitFor({state:'hidden'});delete owned.dialogToken;
 const matches=(await call('/library')).items.filter(item=>item.title===owned.library.title&&!owned.library.beforeIds.includes(item.libraryId));context.assert('实际组件库新快照唯一且保存本轮HTML',matches.length===1&&matches[0].html.includes(owned.widgetTitle));owned.library.id=matches[0].libraryId;await context.checkpointResources();
 await button(context.page,'组件库').click();const library=context.page.getByRole('dialog',{name:'组件模板库',exact:true});await library.waitFor();owned.dialogToken=randomUUID();await library.evaluate((node,token)=>node.setAttribute('data-mw-kanban-dialog',token),owned.dialogToken);await context.checkpointResources();await library.getByText(owned.library.title,{exact:true}).waitFor();await context.capture('组件库真实新增快照');await library.press('Escape');await library.waitFor({state:'hidden'});delete owned.dialogToken;await context.checkpointResources();
 await button(cardOf(frame),'组件操作').click();await context.page.getByRole('menuitem',{name:'从看板移除',exact:true}).click();
 await until(context,()=>call('/canvases/'+canvas.canvasId),value=>!value.placements.some(item=>item.widgetId===widget.widgetId),'从看板移除未实际完成');await frame.waitFor({state:'hidden'});
 context.assert('移除独占组件且组件库快照仍保留',!(await call('/widgets')).items.some(item=>item.widgetId===widget.widgetId)&&(await call('/library')).items.some(item=>item.libraryId===owned.library.id));
 await save(context,'组件库及移除结果',{libraryId:owned.library.id,widgetId:widget.widgetId,sourceDifference:'先加入组件库再移除，避免原步骤先移除后无法操作；钉到桌面为独立窗口，不是下载文件'});await context.capture('组件移除后看板空态');context.remaining.delete('先保存组件库后移除及独占资源结果');
}

export async function runKanbanOperationsSteps(context){
 const prepared=await prepare(context);
 if(context.number===161)return runWeatherSteps(context,prepared);
 if(context.number>=157)return runMailWorkflowSteps(context,prepared);
 if(context.number>=153)return runMailDashboardSteps(context,prepared);
 const material=await fixture(context,prepared);await dragAndResize(context,prepared,material);const stamp=await refresh(context,prepared,material);await enlargeAndPin(context,prepared,material,stamp);await libraryAndRemove(context,prepared,material);
}
