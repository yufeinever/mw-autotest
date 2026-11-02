import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
import {normalizeComposerText} from './mobilework-composer.mjs';
import {validateKanbanOperations,releaseKanbanOperations,finishKanbanRefresh} from './mobilework-kanban-operation-resources.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function openKanban(page){
 await page.getByRole('button',{name:'AI工作台: 智能组件 · 数据画布',exact:true}).filter({visible:true}).click();
 await page.waitForURL(url=>/^#\/kanban(?:\/[^/?]+)?$/.test(url.hash));
}

export function validateKanbanOwnership(value,previous){
 validateKanbanOperations(value,previous);
 if(!/^MW-Autotest-Kanban-(14[5-9]|15[0-9]|16[0-4])-[a-f0-9]{8}$/.test(value.title)||!Array.isArray(value.beforeIds)||!Array.isArray(value.beforeWidgetIds)||[...value.beforeIds,...value.beforeWidgetIds].some(id=>typeof id!=='string')||typeof value.submitted!=='boolean'||typeof value.pendingAdd!=='boolean'||typeof value.removing!=='boolean'||value.id!==null&&(typeof value.id!=='string'||value.beforeIds.includes(value.id))||value.dialogToken!==undefined&&!/^[a-f0-9-]{36}$/.test(value.dialogToken)||value.fullscreenBaseline!==undefined&&typeof value.fullscreenBaseline!=='boolean'||value.widgetIds!==undefined&&(!Array.isArray(value.widgetIds)||value.widgetIds.some(id=>typeof id!=='string'||value.beforeWidgetIds.includes(id)))||Object.keys(value).some(key=>!['title','beforeIds','beforeWidgetIds','submitted','id','pendingAdd','removing','dialogToken','fullscreenBaseline','widgetIds','previewToken','annotationToken','widgetTitle','widgetPending','createUI','draft','task','pin','library','refresh','mail'].includes(key)))throw Error('本轮看板资源归属无效');
 for(const key of ['previewToken','annotationToken'])if(value[key]!==undefined&&!/^[a-f0-9-]{36}$/.test(value[key]))throw Error('看板子弹框归属无效');
 if(value.widgetTitle!==undefined&&value.widgetTitle!==value.title.replace('Kanban','Widget')||value.widgetPending!==undefined&&typeof value.widgetPending!=='boolean'||value.createUI!==undefined&&typeof value.createUI!=='boolean'||value.draft!==undefined&&typeof value.draft!=='string')throw Error('看板组件或草稿归属无效');
 if(value.task){const task=value.task;if(!value.id||typeof task.originUrl!=='string'||!new URL(task.originUrl).hash.match(/^#\/workspace\/[^/]+\/session$/)||typeof task.prompt!=='string'||!task.prompt.includes(value.id)||typeof task.submitted!=='boolean'||task.sessionId!==null&&!/^ses_[A-Za-z0-9]+$/.test(task.sessionId)||Object.keys(task).some(key=>!['originUrl','prompt','submitted','sessionId'].includes(key)))throw Error('看板任务交接归属无效');}
 if(previous&&(['title','beforeIds','beforeWidgetIds'].some(key=>JSON.stringify(previous[key])!==JSON.stringify(value[key]))||previous.id&&previous.id!==value.id||previous.fullscreenBaseline!==undefined&&value.fullscreenBaseline!==undefined&&previous.fullscreenBaseline!==value.fullscreenBaseline||previous.removing&&!value.removing))throw Error('不能替换本轮看板基线或身份');
 if(previous?.task&&(!value.task||['originUrl','prompt'].some(key=>previous.task[key]!==value.task[key])||previous.task.sessionId&&previous.task.sessionId!==value.task.sessionId||previous.task.submitted&&!value.task.submitted))throw Error('不能替换本轮看板任务交接');
}

export async function kanbanClient(page){
 const info=await page.evaluate(()=>(window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__).invokeDesktop('openworkServerInfo'));
 const url=new URL(info.baseUrl);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('看板服务不是本机地址');
 const base=info.baseUrl.replace(/\/$/,''),headers={Authorization:'Bearer '+(info.ownerToken||info.clientToken),'content-type':'application/json',...(info.hostToken?{'X-OpenWork-Host-Token':info.hostToken}:{})};
 const request=async(route,{method='GET',body}={})=>{
  const response=await fetch(base+'/blueprint'+route,{method,headers,signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Object.assign(Error('看板接口失败 '+route+'：HTTP '+response.status),{status:response.status});
  return response.json();
 };
 return async(route,options={})=>{
  const result=await request(route,options);
  if((options.method||'GET')==='GET'&&result.page&&Array.isArray(result.items)&&!/[?&](limit|offset)=/.test(route)){
   let next=result.page.nextOffset;
   while(next!==undefined){const batch=await request(route+(route.includes('?')?'&':'?')+'offset='+next);result.items.push(...batch.items);next=batch.page.nextOffset;}
   result.page={total:result.items.length};
  }
  return result;
 };
}
export function ownedCanvasCandidate(items,owned){
 const matches=items.filter(item=>!owned.beforeIds.includes(item.canvasId)&&(item.title===owned.title||owned.createUI&&owned.id===item.canvasId&&item.title==='未命名看板')&&!item.builtin);
 if(matches.length>1)throw blocked('本轮看板唯一名称出现多个新ID，保留现场');
 const item=matches[0];if(owned.id&&item&&owned.id!==item.canvasId)throw blocked('本轮看板ID已变化，未清理');
 return item||null;
}
export function ownedCanvasWidgets(detail,widgets,owned){
 if(detail.canvas.canvasId!==owned.id||!ownedCanvasCandidate([detail.canvas],owned))throw blocked('本轮看板归属不匹配，未清理组件');
 const ids=[...new Set(detail.placements.map(item=>item.widgetId))];
 if(ids.some(id=>owned.beforeWidgetIds.includes(id))||ids.some(id=>!widgets.some(item=>item.widgetId===id&&!item.builtin&&(item.title==='番茄钟'||owned.widgetTitle&&item.title===owned.widgetTitle)&&(!item.events?.submit||owned.refresh?.widgetId===id&&owned.refresh?.bindingId===item.bindings?.main))))throw blocked('本轮看板存在未确认归属或含执行事件的组件，保留现场');
 return ids;
}
// The product's board composer sends automatically; it is not a prefilled
// standard composer. Recovery requires both the registered workspace and the
// actual first engine user message, never the route alone.
export async function identifyKanbanTask(page,resources,{connection}={}){
 const owned=resources?.kanban,task=owned?.task;if(!task?.submitted)return null;
 const origin=new URL(task.originUrl),current=new URL(page.url());
 const base=origin.hash,match=current.hash.match(/^(#\/workspace\/[^/]+\/session)\/(ses_[A-Za-z0-9]+)$/)||(task.sessionId&&current.hash==='#/kanban/'+owned.id?[base+'/'+task.sessionId,base,task.sessionId]:null);
 if(!match||match[1]!==base||current.origin!==origin.origin||current.pathname!==origin.pathname)throw blocked('看板自动发送尚未交接到本轮空间Session，未接管未知任务');
 if(task.sessionId&&task.sessionId!==match[2])throw blocked('看板任务Session已改变，保留现场');
 const engine=connection||await readEngineConnection(page),session=await engineRequest(engine,'/session/'+match[2]);
 const deadline=Date.now()+30000;let user;
 do{const messages=await engineRequest(engine,'/session/'+match[2]+'/message?directory='+encodeURIComponent(session.directory));user=messages.find(message=>message.info?.role==='user');if(user)break;await page.waitForTimeout(200);}while(Date.now()<deadline);
 const text=(user?.parts||[]).filter(part=>part.type==='text').map(part=>part.text||'').join('\n');
 if(!normalizeComposerText(text).includes(normalizeComposerText(task.prompt)))throw blocked('看板任务首条真实用户消息与完整登记指令不一致');
 origin.hash=base+'/'+match[2];return {sessionId:match[2],sessionUrl:origin.href,directory:session.directory};
}
export async function releaseKanbanResources(page,resources,{client=kanbanClient,modelSettled=false,endpoint}={}){
 const owned=resources.kanban;if(!owned)return;
 if(owned.task?.submitted&&(!owned.task.sessionId||!modelSettled))throw blocked('本轮看板模型任务尚未确认终态，保留组件与看板');
 const call=await client(page),deadline=Date.now()+(owned.submitted?15000:0);let canvas;
 await releaseKanbanOperations(page,owned,call,{endpoint});
 do{
  canvas=ownedCanvasCandidate((await call('/canvases')).items,owned);
  if(canvas||!owned.submitted||owned.removing)break;
  await page.waitForTimeout(200);
 }while(Date.now()<deadline);
 if(!canvas&&owned.submitted&&!owned.removing)throw blocked('本轮看板创建结果仍未确认，未放行下一条');
 for(const [key,attribute] of [['annotationToken','data-mw-kanban-annotation'],['previewToken','data-mw-kanban-preview'],['dialogToken','data-mw-kanban-dialog']])if(owned[key]){
  const dialog=page.locator('['+attribute+'="'+owned[key]+'"]');
  if(await dialog.count()){if(key==='annotationToken')await dialog.getByRole('button',{name:'取消',exact:true}).click();else await dialog.press('Escape');await dialog.waitFor({state:'hidden'});}
  delete owned[key];
 }
 if(canvas){
  owned.id=canvas.canvasId;
  let detail=await call('/canvases/'+encodeURIComponent(owned.id));
  if(owned.pendingAdd){
   const until=Date.now()+15000;
   while(!detail.placements.length&&Date.now()<until){await page.waitForTimeout(200);detail=await call('/canvases/'+encodeURIComponent(owned.id));}
   if(!detail.placements.length)throw blocked('组件添加结果未决，保留本轮看板，未删除未知孤立组件');
  }
  const widgets=(await call('/widgets')).items,ownedWidgetIds=ownedCanvasWidgets(detail,widgets,owned);
  // A fixture request may have created a widget before its placement. It has
  // an exact run-specific title registered before POST, so recover only that
  // identity; never sweep all widgets absent from the initial list.
  const orphans=owned.widgetTitle?widgets.filter(item=>!owned.beforeWidgetIds.includes(item.widgetId)&&item.title===owned.widgetTitle&&!ownedWidgetIds.includes(item.widgetId)):[];
  if(orphans.some(item=>item.builtin||item.events?.submit&&item.widgetId!==owned.refresh?.widgetId)||orphans.length>1)throw blocked('本轮孤立组件归属不唯一，保留现场');
  if(owned.widgetPending&&!ownedWidgetIds.length&&!orphans.length)throw blocked('本轮组件创建结果未决，保留恢复归属');
  if(owned.draft!==undefined){
   const returnUrl=page.url(),boardHash='#/kanban/'+owned.id;
   if(new URL(returnUrl).hash!==boardHash){
    if(!owned.task?.sessionId||!returnUrl.endsWith('/session/'+owned.task.sessionId))throw blocked('看板草稿所在页面已变化，保留现场');
    await page.evaluate(hash=>{location.hash=hash;},boardHash);await page.waitForURL(url=>url.hash===boardHash);
   }
   const editor=page.locator('textarea').filter({visible:true});
   if(await editor.count()===1){const current=await editor.inputValue();if(current&&current!==owned.draft)throw blocked('本轮看板出现未知新草稿，保留现场');}
   const clear=page.getByRole('button',{name:'清空批注',exact:true}).filter({visible:true});if(await clear.count())await clear.click();
   if(await editor.count()===1)await editor.fill('');
   if(page.url()!==returnUrl){await page.evaluate(url=>{location.hash=new URL(url).hash;},returnUrl);await page.waitForURL(returnUrl);}
   delete owned.draft;
  }
  if(owned.fullscreenBaseline!==undefined){
   if(new URL(page.url()).hash!=='#/kanban/'+owned.id)throw blocked('看板全屏所在页面已变化，保留现场');
   const name=owned.fullscreenBaseline?'全屏':'退出全屏',target=page.getByRole('button',{name,exact:true}).filter({visible:true});
   if(await target.count()){
    await target.click();await page.getByRole('button',{name:owned.fullscreenBaseline?'退出全屏':'全屏',exact:true}).filter({visible:true}).waitFor();
   }
   delete owned.fullscreenBaseline;
  }
  // The product removes unplaced widgets when deleting this disposable canvas.
  owned.widgetIds=[...ownedWidgetIds,...orphans.map(item=>item.widgetId)];owned.removing=true;await call('/canvases/'+encodeURIComponent(owned.id),{method:'DELETE'});
  if((await call('/canvases')).items.some(item=>item.canvasId===owned.id))throw blocked('本轮看板移除未确认');
  if((await call('/widgets')).items.some(item=>ownedWidgetIds.includes(item.widgetId)))throw blocked('本轮看板独占组件移除未确认，保留恢复归属');
  for(const item of orphans){
   const boards=(await call('/canvases')).items;
   for(const board of boards)if((await call('/canvases/'+encodeURIComponent(board.canvasId))).placements.some(p=>p.widgetId===item.widgetId))throw blocked('本轮孤立组件已被其他看板引用，保留现场');
   await call('/widgets/'+encodeURIComponent(item.widgetId),{method:'DELETE'});
  }
 }
 if(!canvas&&owned.removing&&owned.widgetIds?.length&&(await call('/widgets')).items.some(item=>owned.widgetIds.includes(item.widgetId)))throw blocked('看板已移除但本轮组件仍存在，未放行下一条');
 if(owned.task?.sessionId&&new URL(page.url()).hash==='#/kanban/'+owned.id){const url=new URL(owned.task.originUrl);url.hash+='/'+owned.task.sessionId;await page.evaluate(hash=>{location.hash=hash;},url.hash);await page.waitForURL(url.href);}
 await finishKanbanRefresh(owned,call);
 delete resources.kanban;
}
