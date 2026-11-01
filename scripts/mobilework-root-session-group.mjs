import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {TaskControl} from './mobilework-task-control.mjs';
import {PermissionEvents} from './mobilework-permission-events.mjs';
import {readEngineConnection} from '../local-console/engine-client.mjs';
import {readSessionLog} from '../local-console/session-log.mjs';
import {snapshotDraft,editorOf,clearOwnedDraft,inspectPageHandoff,modalDialogs} from './mobilework-isolation.mjs';
import {normalizeComposerText} from './mobilework-composer.mjs';
import {caseDialog} from './mobilework-case-library.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const localResources=resources=>{
 const {workspaceResources,homeModel,...local}=resources;
 return structuredClone(local);
};
const userText=message=>message.parts.filter(part=>part.type==='text').map(part=>part.text||'').join('\n');

// One coordinator, one awaited UI action at a time. Root controls share the
// existing job owner/token, while connections and event caches stay separate.
export class RootSessionGroup {
 constructor({control,page,config,dir,capture,log=()=>{}}){
  Object.assign(this,{control,page,config,dir,capture,log});
  this.tasks=[];this.pending=null;this.activeControl=null;this.currentRootKey=null;
  this.uiControl=null;this.enabled=false;this.rotation=0;
 }
 _newControl(key){
  const control=this.tasks.length||this.enabled?new TaskControl({url:this.control.url,token:this.control.token,log:this.log}):this.control;
  control.rootKey=key;return control;
 }
 _submission(){
  const {id,key,state,workspaceId,originUrl,source,expectedPrompt,draft,beforeSessionIds,submittedAt,suspended,resumeUrl,restoreDraft,preparingPage}=this.pending;
  return {id,key,state,workspaceId,originUrl,source,expectedPrompt,draft,beforeSessionIds,submittedAt,suspended,resumeUrl,restoreDraft,preparingPage};
 }
 async _checkpointPreparingPage(){
  const pending=this.pending;
  if(!pending||new URL(this.page.url()).hash!=='#/session')return;
  if(pending.state!=='PREPARING')throw blocked('已观察预填或尝试提交后不能交接通用新任务入口');
  const workspaceId=await this.page.evaluate(()=>localStorage.getItem('openwork.react.newTaskDraftWorkspace'));
  const draft=await snapshotDraft(this.page),current=new URL(draft.url),origin=new URL(pending.originUrl);
  if(current.origin!==origin.origin||current.pathname!==origin.pathname||current.search!==origin.search||workspaceId!==pending.workspaceId||draft.text||draft.skills.length||draft.selection.length||await modalDialogs(this.page).count())throw blocked('新建任务入口的原空间、空草稿或选择未核对，保留现场');
  pending.preparingPage={url:draft.url,workspaceId,draft};
  await pending.control.call('checkpoint',{rootSubmission:this._submission()});
 }
 async _with(control,phase,action,{focus=false}={}){
  if(this.uiControl){
   if(this.uiControl!==control)throw Error('任务组持权callback不能嵌套切换另一根任务');
   return action(control);
  }
  this.uiControl=control;this.activeControl=control;this.currentRootKey=control.rootKey;
  try{
   await control.acquire(this.page,phase);
   if(focus)await control.focus(this.page);
   return await action(control);
  }finally{
   try{if(control.held&&!control.faulted){if(this.pending?.control===control)await this._checkpointPreparingPage();await control.release(this.page,phase==='EVIDENCE'?'VERIFYING':'WAITING_MODEL');}}
   finally{this.uiControl=null;this.activeControl=null;}
  }
 }
 async prepare(spec,action=async()=>{}){
  if(this.pending||this.tasks.some(root=>root.key===spec.key))throw Error('根任务准备阶段已存在或已提交');
  const control=this._newControl(spec.key);
  this.pending={...spec,id:randomUUID(),state:'PREPARING',draft:null,control,suspended:false,submittedAt:null};
  return this._with(control,'PREPARING',async()=>{
   await control.call('checkpoint',{...this.enabled?{}:{rootSessionVersion:1},rootSubmission:this._submission(),composerResources:spec.resources});this.enabled=true;
   if(this.page.url()===spec.originUrl){
    const draft=await snapshotDraft(this.page);
    if(normalizeComposerText(draft.text)===normalizeComposerText(spec.expectedPrompt))await this._markPrepared(draft);
    else if(draft.text||draft.skills.length||draft.selection.length)throw blocked('准备新根任务时发现未登记草稿，保留现场');
   }
   return action(control);
  });
 }
 async _markPrepared(draft){
  const pending=this.pending;
  if(draft.url!==pending.originUrl||normalizeComposerText(draft.text)!==normalizeComposerText(pending.expectedPrompt)||draft.skills.length||draft.selection.length)throw blocked('当前真实预填与已登记案例来源不一致');
  pending.draft=draft;pending.state='PREPARED';
  await pending.control.call('checkpoint',{rootSubmission:this._submission()});
 }
 async checkpointResources(resources){
  if(!this.uiControl)throw Error('根任务资源只能在当前串行UI步骤中登记');
  await this.activeControl.call('checkpoint',{composerResources:resources});
  if(this.pending?.control===this.activeControl)this.pending.resources=resources;
  else this.tasks.find(root=>root.control===this.activeControl).resources=localResources(resources);
 }
 async _restorePending(){
  if(!this.pending.suspended)return;
  const handoff=await inspectPageHandoff(this.page,{allowRunning:true});
  if(!handoff.ready)throw blocked(handoff.reason);
  const target=this.pending.resumeUrl||this.pending.originUrl;
  await this.page.evaluate(url=>{location.hash=new URL(url).hash;},target);
  await this.page.waitForURL(target);
  if(new URL(target).hash==='#/session')await this._checkpointPreparingPage();
  if(!this.pending.restoreDraft){this.pending.suspended=false;await this.pending.control.call('checkpoint',{rootSubmission:this._submission()});return;}
  const editor=editorOf(this.page);await editor.waitFor();
  const current=await snapshotDraft(this.page);
  if(current.text||current.skills.length||current.selection.length)throw blocked('恢复本轮案例预填前存在其他草稿，未覆盖');
  await editor.fill(this.pending.draft.text);
  const restored=await snapshotDraft(this.page);
  if(normalizeComposerText(restored.text)!==normalizeComposerText(this.pending.draft.text)||restored.skills.length||restored.selection.length)throw blocked('本轮案例预填恢复不符');
  this.pending.suspended=false;await this.pending.control.call('checkpoint',{rootSubmission:this._submission()});
 }
 async withPendingUI(phase,action){
  if(!this.pending)throw Error('当前没有已登记的根任务准备阶段');
  return this._with(this.pending.control,phase,async control=>{await this._restorePending();return action(control);});
 }
 async clickPending(submit){
  if(this.uiControl!==this.pending?.control||this.pending.state==='SUBMITTING')throw Error('根任务已提交或未持有对应准备页，不重复发送');
  const draft=await snapshotDraft(this.page);
  if(this.pending.state==='PREPARING')await this._markPrepared(draft);
  else if(draft.url!==this.pending.originUrl||normalizeComposerText(draft.text)!==normalizeComposerText(this.pending.draft.text)||draft.skills.length||draft.selection.length)throw blocked('当前真实预填与已登记案例来源不一致');
  this.pending.state='SUBMITTING';this.pending.submittedAt=new Date().toISOString();
  await this.activeControl.call('checkpoint',{rootSubmission:this._submission()});
  await submit();
 }
 async observePending(){
  const pending=this.pending;
  if(!pending||pending.state!=='SUBMITTING')return null;
  const current=new URL(this.page.url()),origin=new URL(pending.originUrl),route=current.hash.match(/^#\/workspace\/([^/]+)\/session\/(ses_[A-Za-z0-9]+)$/);
  if(!route)return null;
  if(current.origin!==origin.origin||current.pathname!==origin.pathname||route[1]!==pending.workspaceId||pending.beforeSessionIds.includes(route[2]))throw blocked('待提交根任务跳转未对应本轮独立新Session');
  return this._with(pending.control,'PREPARING',async control=>{
   const connection=await readEngineConnection(this.page),data=await readSessionLog({sessionId:route[2],connection});
   const user=data.messages.find(message=>message.info?.role==='user'&&normalizeComposerText(userText(message))===normalizeComposerText(pending.draft.text));
   if(!user)return null;
   if(!data.session.directory)throw blocked('新根任务没有真实任务目录');
   Object.assign(control,{sessionId:route[2],sessionUrl:this.page.url(),directory:data.session.directory,connection});
   const root={key:pending.key,id:route[2],url:control.sessionUrl,workspaceId:pending.workspaceId,directory:control.directory,
    submissionId:pending.id,submittedText:pending.draft.text,firstUserMessageId:user.info.id,source:pending.source,evidence:'任务-'+pending.key,
    resources:localResources({...pending.resources,url:control.sessionUrl}),control,data:null,result:null,error:null,completed:false,
    observed:new Map(),permissionErrorSince:null};
   for(const key of ['caseTask','caseReplay','moduleNavigation'])delete root.resources[key];
   await fs.mkdir(path.join(this.dir,root.evidence),{recursive:true});
   const {key,id,url,directory,submissionId,firstUserMessageId,evidence,resources}=root;
   await control.call('checkpoint',{rootSession:{key,id,url,directory,submissionId,firstUserMessageId,evidence,resources},runtime:connection});
   pending.resources.url=root.url;
   for(const key of ['caseTask','caseReplay','moduleNavigation'])delete pending.resources[key];
   this.tasks.push(root);this.pending=null;
   control.permissionEvents=new PermissionEvents({connection,directory:root.directory,sessionId:root.id});
   await control.permissionEvents.start();
   return root;
  });
 }
 async withRootUI(key,phase,action){
  const root=this.tasks.find(root=>root.key===key);if(!root)throw Error('根任务未登记：'+key);
  if(!await this._suspendPending())throw blocked('案例准备弹框或待提交尚未交接，未切换根任务');
  return this._with(root.control,phase,action,{focus:true});
 }
 async _suspendPending(){
  const pending=this.pending;
  if(!pending||pending.suspended)return true;
  if(pending.state==='SUBMITTING')return false;
  const dialogs=await modalDialogs(this.page).count();
  if(dialogs){
   const replay=pending.resources.caseReplay;
   if(dialogs!==1||new URL(this.page.url()).hash!=='#/explore'||replay?.assetId!==pending.source.assetId||replay.title!==pending.source.title)throw blocked('准备阶段出现未登记案例弹框，保留现场');
   await this._with(pending.control,'PREPARING',async()=>{
    const dialog=caseDialog(this.page,replay.title);
    if(await dialog.count()!==1)throw blocked('本轮案例详情弹框不唯一');
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'hidden'});
    replay.opening=true;await this.checkpointResources(pending.resources);
   });
  }
  if(this.page.url()!==pending.originUrl){
   if(this.tasks.some(root=>root.url===this.page.url()))return true;
   const hash=new URL(this.page.url()).hash;
   if(hash==='#/session')await this._with(pending.control,'PREPARING',()=>this._checkpointPreparingPage());
   else if(hash!=='#/explore'||pending.resources.moduleNavigation?.targetHash!=='#/explore')throw blocked('准备阶段页面未登记，保留现场');
   return this._with(pending.control,'PREPARING',async()=>{
    pending.resumeUrl=this.page.url();pending.restoreDraft=false;pending.suspended=true;
    await pending.control.call('checkpoint',{rootSubmission:this._submission()});return true;
   });
  }
  return this._with(pending.control,'PREPARING',async()=>{
   const actual=await snapshotDraft(this.page);
   if(actual.text||actual.skills.length||actual.selection.length){
    if(pending.state==='PREPARING')await this._markPrepared(actual);
    if(normalizeComposerText(actual.text)!==normalizeComposerText(pending.draft.text)||actual.skills.length||actual.selection.length)throw blocked('准备页草稿不再属于本轮案例，保留现场');
    if(!await clearOwnedDraft(this.page,pending.draft,this.config))throw blocked('本轮案例预填暂停未确认');
    pending.restoreDraft=true;
   }else pending.restoreDraft=false;
   pending.resumeUrl=this.page.url();pending.suspended=true;
   await pending.control.call('checkpoint',{rootSubmission:this._submission()});return true;
  });
 }
 async _sample(root){
  const startedAt=new Date().toISOString();
  try{
   const [states,pending]=await Promise.all([root.control.get('/session/status'),root.control.pendingInteractions()]);
   root.permissionErrorSince=null;
   return {root,state:states[root.id]?.type||'idle',pending,startedAt,endedAt:new Date().toISOString()};
  }catch(error){
   if(!error.patchPermissionError)throw error;
   root.permissionErrorSince??=Date.now();
   if(Date.now()-root.permissionErrorSince>=15000)throw blocked(root.key+'审批列表持续不可解析，保留全根任务收尾');
   return {root,state:'unknown',pending:[],startedAt,endedAt:new Date().toISOString()};
  }
 }
 _reconcile(root,pending){
  const keys=new Set(pending.map(item=>item.key));
  for(const key of root.observed.keys())if(!keys.has(key))root.observed.delete(key);
  for(const item of pending)if(!root.observed.has(item.key))root.observed.set(item.key,{since:Date.now(),clicked:false});
 }
 async wait({timeoutMs,advance,onSample=async()=>{},onRootComplete=async()=>{}}){
  const deadline=Date.now()+timeoutMs;let preparationDone=!advance;
  while(Date.now()<deadline){
   await this.observePending();
   const samples=await Promise.all(this.tasks.filter(root=>!root.completed).map(root=>this._sample(root)));
   await onSample({at:new Date().toISOString(),roots:samples.map(({root,state,pending,startedAt,endedAt})=>({key:root.key,id:root.id,directory:root.directory,state,startedAt,endedAt,pending:pending.map(({kind,id})=>({kind,id}))}))});
   const requests=samples.filter(sample=>sample.pending.length);
   let handled=false;
   if(requests.length&&await this._suspendPending()){
    const sample=requests[this.rotation++%requests.length],{root,pending}=sample;
    this._reconcile(root,pending);
    await this.withRootUI(root.key,'INTERACTING',control=>control.handlePendingInteractions(this.page,this.config,{
     capture:step=>this.capture(step,root.key),log:this.log,observed:root.observed,reconcile:latest=>this._reconcile(root,latest)}));
    handled=true;
   }
   for(const {root,state,pending} of samples){
    if(state!=='idle'||pending.length)continue;
    const data=await root.control.readLog(),last=data.messages.at(-1);
    if(last?.info?.role!=='assistant'||!last.info.error&&(!last.info.time?.completed||last.info.finish==='tool-calls'||last.parts.some(part=>part.type==='tool'&&!['completed','error'].includes(part.state?.status))))continue;
    root.data=data;root.completed=true;root.result=last.info.error?'FAIL':'COMPLETED';root.error=last.info.error||null;
    await root.control.call('completed',{lastMessageId:last.info.id});
    await onRootComplete(root);
   }
   if(!handled&&!preparationDone)preparationDone=await advance();
   if(preparationDone&&!this.pending&&this.tasks.length&&this.tasks.every(root=>root.completed))return this.tasks;
   await delay(1000);
  }
  throw blocked('本用例多根任务等待超时；保留所有根及待提交归属供统一停止');
 }
 async close(){
  for(const control of new Set([this.control,...this.tasks.map(root=>root.control),...this.pending?[this.pending.control]:[]])){
   control.permissionEvents?.stop();
   if(control.held&&!control.faulted)await control.release(this.page,'VERIFYING');
  }
 }
}
