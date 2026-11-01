import {connectClientWidgetPin} from '../local-console/client-connection.mjs';
import {releaseMailOperations} from './mobilework-mail-operations.mjs';
import {diskScanCode} from './mobilework-efficiency.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
export const kanbanRefreshSchema={type:'object',properties:{stamp:{type:'string'}},required:['stamp'],additionalProperties:false};
export const kanbanRefreshCode='def run(ctx):\n    return {"artifact": {"stamp": "MW-refresh-" + ctx["runId"]}}\n';
export const refreshCodeFor=value=>value.kind==='disk'?diskScanCode:kanbanRefreshCode;

export function validateKanbanOperations(value,previous){
 const pin=value.pin;
 if(pin&&(!value.widgetIds?.includes(pin.widgetId)||pin.canvasId!==value.id||typeof pin.confirmed!=='boolean'||Object.keys(pin).some(key=>!['widgetId','canvasId','confirmed'].includes(key))))throw Error('桌面组件归属无效');
 if(previous?.pin&&pin&&['widgetId','canvasId'].some(key=>previous.pin[key]!==pin[key]))throw Error('不能替换桌面组件身份');
 const library=value.library;
 if(library&&(library.title!==value.title.replace('Kanban','Library')||!Array.isArray(library.beforeIds)||typeof library.submitted!=='boolean'||library.id!==null&&(typeof library.id!=='string'||library.beforeIds.includes(library.id))||Object.keys(library).some(key=>!['title','beforeIds','submitted','id'].includes(key))))throw Error('本轮组件库归属无效');
 if(previous?.library&&library&&(['title','beforeIds'].some(key=>JSON.stringify(previous.library[key])!==JSON.stringify(library[key]))||previous.library.id&&library.id!==previous.library.id))throw Error('不能替换组件库基线');
 const refresh=value.refresh;
 if(refresh&&(!Array.isArray(refresh.beforeIds)||refresh.title!==value.title+'-刷新'||typeof refresh.submitted!=='boolean'||['automationId','widgetId','bindingId'].some(key=>refresh[key]!==null&&typeof refresh[key]!=='string')||refresh.automationId&&refresh.beforeIds.includes(refresh.automationId)||Object.keys(refresh).some(key=>!['kind','title','beforeIds','submitted','automationId','widgetId','bindingId'].includes(key))))throw Error('本轮刷新任务归属无效');
 if(refresh?.kind!==undefined&&refresh.kind!=='disk')throw Error('未知刷新任务类型');
 if(previous?.refresh&&refresh&&(['kind','title','beforeIds'].some(key=>JSON.stringify(previous.refresh[key])!==JSON.stringify(refresh[key]))||['automationId','widgetId','bindingId'].some(key=>previous.refresh[key]&&previous.refresh[key]!==refresh[key])))throw Error('不能替换刷新任务身份');
 const mail=value.mail;
 if(mail&&(!value.beforeWidgetIds.includes(mail.widgetId)||!Array.isArray(mail.modals)||mail.modals.some(key=>!['list','detail','body','compose'].includes(key))||['summaryPending','draftPending'].some(key=>mail[key]!==undefined&&typeof mail[key]!=='boolean')||Object.keys(mail).some(key=>!['widgetId','modals','summaryPending','draftPending','send','reminder'].includes(key))))throw Error('邮箱组件弹框归属无效');
 if(previous?.mail&&mail&&previous.mail.widgetId!==mail.widgetId)throw Error('不能替换邮箱组件身份');
 if(mail?.send){
  const s=mail.send;if(!Array.isArray(s.beforeIds)||!s.recipient||!s.subject.startsWith('MW-Autotest-Mail-160-')||!s.marker||!Number.isFinite(s.startedAt)||Object.keys(s).some(k=>!['beforeIds','recipient','subject','marker','startedAt'].includes(k)))throw Error('本轮专用发信归属无效');
  if(previous?.mail?.send&&JSON.stringify(previous.mail.send)!==JSON.stringify(s))throw Error('不能替换未决发信身份');
 }
 if(mail?.reminder){
  const r=mail.reminder;if(r.disposable!==true||!r.id||!r.sourceMailId||!r.title||!Number.isFinite(r.startMs)||r.beforeLead!==5||![5,15,30,60].includes(r.lastLead)||![15,30,60].includes(r.proposedLead)||Object.keys(r).some(k=>!['id','sourceMailId','title','startMs','disposable','beforeLead','lastLead','proposedLead'].includes(k)))throw Error('本轮测试提醒归属无效');
  if(previous?.mail?.reminder&&['id','sourceMailId','title','startMs','disposable','beforeLead'].some(k=>previous.mail.reminder[k]!==r[k]))throw Error('不能替换专用测试会议身份');
 }
}

export async function openOwnedWidgetPin(endpoint,owned){
 const browser=await connectClientWidgetPin(endpoint,{timeout:15000,widgetPin:owned.pin});
 const hash='#/widget-pin/'+owned.pin.canvasId+'/'+owned.pin.widgetId;
 const pages=browser.contexts().flatMap(context=>context.pages()).filter(page=>new URL(page.url()).hash===hash);
 if(pages.length!==1){await browser.close();throw blocked('本轮桌面组件页面身份不唯一');}
 return {browser,page:pages[0]};
}

export async function releaseKanbanOperations(page,owned,call,{endpoint}={}){
 if(owned.mail)await releaseMailOperations(page,owned.mail);
 if(owned.mail?.modals.length){
  const iframe=page.locator('iframe[data-widget-id="'+owned.mail.widgetId+'"]').filter({visible:true});
  if(await iframe.count()!==1)throw blocked('本轮邮箱弹框所在组件已离开，保留现场');
  const frame=iframe.contentFrame();
  if(owned.mail.summaryPending){
   const text=(await frame.locator('#d-summary').innerText()).trim();
   if(!await frame.locator('#detail-modal').isVisible()||!text||text.includes('生成中'))throw blocked('本轮邮件AI分析尚未终态，保留弹框及恢复归属');
   delete owned.mail.summaryPending;
  }
  for(const key of ['compose','body','detail','list'])if(owned.mail.modals.includes(key)&&await frame.locator('#'+key+'-modal').isVisible())await frame.locator('#'+(key==='compose'?'c-cancel':key+'-close')).click();
  for(const key of owned.mail.modals)if(await frame.locator('#'+key+'-modal').isVisible())throw blocked('本轮邮箱弹框关闭未确认');
  owned.mail.modals=[];
 }
 if(owned.pin){
  const connection=endpoint||process.env.MW_CDP_ENDPOINT;
  if(!connection)throw blocked('缺少本轮桌面组件CDP地址，未关闭其他窗口');
  const targets=await (await fetch(connection+'/json/list')).json(),hash='#/widget-pin/'+owned.pin.canvasId+'/'+owned.pin.widgetId;
  if(!targets.some(target=>target.type==='page'&&URL.canParse(target.url)&&new URL(target.url).hash===hash)&&owned.pin.confirmed)delete owned.pin;
  else{
   const pin=await openOwnedWidgetPin(connection,owned);
   try{await Promise.all([pin.page.waitForEvent('close',{timeout:15000}),pin.page.getByRole('button',{name:'取消固定',exact:true}).click()]);}
   finally{await pin.browser.close();}
   delete owned.pin;
  }
 }
 if(owned.library?.submitted){
  const matches=(await call('/library')).items.filter(item=>!owned.library.beforeIds.includes(item.libraryId)&&item.title===owned.library.title);
  if(matches.length>1||matches.some(item=>owned.library.id&&item.libraryId!==owned.library.id||!item.html.includes(owned.widgetTitle)))throw blocked('组件库快照归属不匹配，保留现场');
  if(!matches.length&&!owned.library.id)throw blocked('组件库添加结果仍未确认');
  for(const item of matches)await call('/library/'+item.libraryId,{method:'DELETE'});
  if((await call('/library')).items.some(item=>matches.some(match=>match.libraryId===item.libraryId)))throw blocked('本轮组件库快照移除未确认');
  delete owned.library;
 }
 if(owned.refresh?.submitted){
  const refresh=owned.refresh,matches=(await call('/automations')).items.filter(item=>!refresh.beforeIds.includes(item.automationId)&&item.title===refresh.title);
  if(!matches.length&&refresh.automationId&&refresh.widgetId&&!(await call('/widgets')).items.some(item=>item.widgetId===refresh.widgetId)&&!(await call('/bindings')).items.some(item=>item.automationId===refresh.automationId)){delete owned.refresh;return;}
  if(matches.length!==1||refresh.automationId&&matches[0].automationId!==refresh.automationId)throw blocked('刷新任务创建或归属未确认');
  const automation=matches[0];
  if(automation.trigger.kind!=='manual'||automation.execution.kind!=='code'||automation.execution.runtime!=='python')throw blocked('本轮刷新任务定义已变化');
  const code=await call('/automations/'+automation.automationId+'/code');
  if(code.content!==refreshCodeFor(refresh))throw blocked('本轮刷新任务代码已变化，未自动清理');
  if(refresh.widgetId){
   const bindings=(await call('/bindings')).items.filter(item=>item.widgetId===refresh.widgetId||item.automationId===automation.automationId);
   if(bindings.length>1||bindings.some(item=>item.widgetId!==refresh.widgetId||item.automationId!==automation.automationId||refresh.bindingId&&item.bindingId!==refresh.bindingId))throw blocked('刷新绑定存在其他资源引用，保留现场');
   if(bindings.length)refresh.bindingId=bindings[0].bindingId;
  }
  let runs=(await call('/automations/'+automation.automationId+'/runs')).items;
  if(runs.some(run=>['running','queued'].includes(run.status))){
   await call('/automations/'+automation.automationId+'/cancel',{method:'POST',body:{}});
   const deadline=Date.now()+30000;
   do{runs=(await call('/automations/'+automation.automationId+'/runs')).items;if(!runs.some(run=>['running','queued'].includes(run.status)))break;await page.waitForTimeout(200);}while(Date.now()<deadline);
   if(runs.some(run=>['running','queued'].includes(run.status)))throw blocked('本轮刷新任务仍未停止，保留看板');
  }
  refresh.automationId=automation.automationId;
 }
}

export async function finishKanbanRefresh(owned,call){
 if(!owned.refresh?.automationId)return;
 const id=owned.refresh.automationId;
 if((await call('/bindings')).items.some(item=>item.automationId===id))throw blocked('刷新任务仍有绑定，保留本轮任务');
 if((await call('/automations')).items.some(item=>item.automationId===id))await call('/automations/'+id,{method:'DELETE'});
 if((await call('/automations')).items.some(item=>item.automationId===id))throw blocked('本轮刷新任务删除未确认');
 delete owned.refresh;
}
