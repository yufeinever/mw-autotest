import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {kanbanClient,openKanban,ownedCanvasCandidate,ownedCanvasWidgets} from './mobilework-kanban.mjs';

const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const review=message=>Object.assign(Error(message),{review:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));

export async function openCanvas(context,canvas){
 await button(context.page,canvas.title).click();await context.page.waitForURL(url=>url.hash==='#/kanban/'+canvas.canvasId);
 // A route change alone precedes the asynchronous currentCanvas load.
 if(canvas.placements?.length===0)await context.page.getByText('看板是展示小组件的地方',{exact:true}).waitFor();
 else if(!canvas.builtin)await button(context.page,'组件库').waitFor();
 await button(context.page,canvas.title).waitFor();
}
export async function prepare(context){
 const call=await kanbanClient(context.page),before=(await call('/canvases')).items,widgets=(await call('/widgets')).items;
 const title='MW-Autotest-Kanban-'+context.number+'-'+randomUUID().slice(0,8);
 context.resources.moduleNavigation={originUrl:context.page.url(),targetHash:'#/kanban'};
 context.resources.kanban={title,beforeIds:before.map(item=>item.canvasId),beforeWidgetIds:widgets.map(item=>item.widgetId),submitted:false,id:null,pendingAdd:false,removing:false};await context.checkpointResources();
 // This empty canvas is a fixture. It is not evidence for the create-canvas case.
 context.resources.kanban.submitted=true;await context.checkpointResources();
 const result=await call('/canvases',{method:'POST',body:{title}}),canvas=ownedCanvasCandidate((await call('/canvases')).items,context.resources.kanban);
 context.assert('准备独立无组件看板且身份对应真实创建请求',!!canvas&&canvas.canvasId===result.canvasId);context.resources.kanban.id=canvas.canvasId;await context.checkpointResources();
 await openKanban(context.page);
 await button(context.page,'新建看板').waitFor();await openCanvas(context,{...canvas,placements:[]});
 await save(context,'本轮看板资源基线',{beforeIds:context.resources.kanban.beforeIds,beforeWidgetIds:context.resources.kanban.beforeWidgetIds,canvas});context.remaining.delete('独立看板及模块归属准备');
 return {call,canvas,before};
}
async function switchTabs(context,{call,canvas,before}){
 const expected=['邮箱工作台','效率工具'],records=[],gaps=[];
 for(const title of expected){
  const matches=before.filter(item=>item.title===title);
  if(matches.length!==1)throw review('原表内置看板未唯一提供：'+title+'；不重置播种或创建伪内置看板');
  if(!matches[0].builtin)gaps.push(title+'实际存在，但接口未标记builtin，内置身份待确认');
  const detail=await call('/canvases/'+encodeURIComponent(matches[0].canvasId));await openCanvas(context,{...matches[0],placements:detail.placements});
  const actual=await context.page.locator('iframe[data-widget-id]').filter({visible:true}).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-widget-id')));
  const expectedIds=detail.placements.map(item=>item.widgetId).sort();
  await context.page.waitForFunction(ids=>JSON.stringify([...document.querySelectorAll('iframe[data-widget-id]')].filter(node=>node.getClientRects().length).map(node=>node.getAttribute('data-widget-id')).sort())===JSON.stringify(ids),expectedIds);
  context.assert('原表目标看板真实切换并加载对应组件：'+title,detail.canvas.canvasId===matches[0].canvasId&&expectedIds.length>0);records.push({title,canvasId:detail.canvas.canvasId,builtin:matches[0].builtin===true,expectedIds,initialObserved:actual});await save(context,'内置及自定义Tab真实切换',records);await context.capture('看板切换-'+title);
 }
 context.remaining.delete('内置看板切换与真实组件对应');
 await openCanvas(context,{...canvas,placements:[]});context.assert('自定义看板切换显示本轮真实空态',await context.page.getByText('看板是展示小组件的地方',{exact:true}).isVisible());await context.capture('本轮自定义看板空态');context.remaining.delete('自定义Tab切换及空态');
 const tab=button(context.page,canvas.title).locator('..');await button(tab,'看板操作').click();
 const menu=context.page.getByRole('menu').filter({visible:true});await menu.waitFor();context.resources.kanban.dialogToken=randomUUID();await menu.evaluate((node,token)=>node.setAttribute('data-mw-kanban-dialog',token),context.resources.kanban.dialogToken);await context.checkpointResources();const items=await menu.getByRole('menuitem').allTextContents();await save(context,'实际页签操作及原表关闭要求',{items,requested:'关闭已打开页签，不删除看板'});await context.capture('当前版本页签菜单');await menu.press('Escape');await menu.waitFor({state:'hidden'});delete context.resources.kanban.dialogToken;await context.checkpointResources();
 // The shipped UI has rename/delete only. Never treat destructive deletion as
 // closing a tab, nor operate another user's boards to manufacture a result.
 throw review([...gaps,'原表目标与自定义看板切换已覆盖；当前版本仅有重命名/删除，看板关闭页签入口缺失，原目标保留待产品确认'].join('；'));
}
async function widgets(context,{call,canvas}){
 const {page,resources}=context;await button(page,'组件库').click();
 const dialog=page.getByRole('dialog',{name:'组件模板库',exact:true}).filter({visible:true});await dialog.waitFor();
 resources.kanban.dialogToken=randomUUID();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-kanban-dialog',token),resources.kanban.dialogToken);await context.checkpointResources();
 const title=dialog.getByText('番茄钟',{exact:true});await title.waitFor();
 if(await title.count()!==1)throw review('安全的番茄钟模板未唯一提供，未选择可能执行真实业务的其他组件');
 const card=title.locator('xpath=../..');await button(card,'选择').click();await dialog.getByRole('checkbox').filter({visible:true}).evaluateAll(nodes=>nodes.filter(node=>node.getAttribute('aria-checked')==='true').length).then(count=>context.assert('组件库真实选中单个安全模板',count===1));
 resources.kanban.pendingAdd=true;await context.checkpointResources();await button(dialog,'添加到当前看板').click();await dialog.waitFor({state:'hidden'});delete resources.kanban.dialogToken;await context.checkpointResources();
 let detail=await call('/canvases/'+encodeURIComponent(canvas.canvasId));
 const widgets=(await call('/widgets')).items,ids=ownedCanvasWidgets(detail,widgets,resources.kanban);
 context.assert('组件库在本轮看板真实生成一个新组件及placement',ids.length===1&&detail.placements.length===1);resources.kanban.pendingAdd=false;resources.kanban.widgetIds=ids;await context.checkpointResources();
 const frame=page.locator('iframe[data-widget-id="'+ids[0]+'"]');await frame.waitFor();
 await frame.contentFrame().getByText('开始',{exact:true}).waitFor();
 context.assert('新组件iframe真实展示可操作计时内容',await frame.contentFrame().getByText('开始',{exact:true}).isVisible());await save(context,'组件库真实添加结果',{canvas:detail,widgetIds:ids});await context.capture('本轮看板真实新增番茄钟');context.remaining.delete('组件库真实选择添加及正文展示');
 for(const name of ['编辑','整理','刷新','更多'])context.assert('底部工具栏真实可用：'+name,await button(page,name).isVisible());
 const edit=button(page,'编辑');await edit.click();context.assert('编辑进入实际批注模式',(await edit.getAttribute('class')).includes('text-white'));await context.capture('本轮看板编辑模式');await edit.click();context.assert('退出编辑模式恢复正常',(await edit.getAttribute('class')).includes('text-dls-text-secondary'));
 // Arrange is a legitimate no-op for a single already arranged component.
 await button(page,'整理').click();detail=await call('/canvases/'+encodeURIComponent(canvas.canvasId));context.assert('整理后组件数量身份保持且布局有效',detail.placements.length===1&&detail.placements[0].widgetId===ids[0]&&detail.placements[0].layout.w>0&&detail.placements[0].layout.h>0);
 const [refreshed]=await Promise.all([page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/blueprint/canvases/'+canvas.canvasId),button(page,'刷新').click()]);context.assert('工具栏刷新真实读取本轮看板',refreshed.ok());await frame.contentFrame().getByText('开始',{exact:true}).waitFor();
 const full=await button(page,'退出全屏').count()===1;resources.kanban.fullscreenBaseline=full;await context.checkpointResources();const before=await frame.boundingBox();
 await button(page,full?'退出全屏':'全屏').click();await button(page,full?'全屏':'退出全屏').waitFor();await context.capture('看板真实全屏切换');
 context.assert('全屏切换后组件仍可见且画布有效',!!before&&!!await frame.boundingBox());await button(page,full?'全屏':'退出全屏').click();await button(page,full?'退出全屏':'全屏').waitFor();delete resources.kanban.fullscreenBaseline;await context.checkpointResources();
 await button(page,'更多').click();const menu=page.getByRole('menu').filter({visible:true});await menu.waitFor();context.assert('更多展示真实网格及自由布局',await menu.getByRole('menuitem',{name:'网格',exact:true}).isVisible()&&await menu.getByRole('menuitem',{name:'自由',exact:true}).isVisible());await context.capture('看板更多布局入口');await menu.press('Escape');await menu.waitFor({state:'hidden'});
 context.remaining.delete('编辑整理刷新全屏及更多真实工具栏');
 await save(context,'看板工具栏原表差异',{actual:['编辑','整理','刷新','全屏','更多'],sourceDescription:'编辑、组件库、刷新、全屏、更多',sourceSteps:'编辑、整理、刷新、全屏、更多',libraryLocation:'右上组件库',arrangeScope:'单组件整理允许真实无变化，不冒充多组件重排'});
}
export async function runKanbanSteps(context){
 const fixture=await prepare(context);
 if(context.number===145)return switchTabs(context,fixture);
 return widgets(context,fixture);
}
