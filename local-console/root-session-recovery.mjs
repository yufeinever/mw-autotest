import path from 'node:path';
import {connectClient} from './client-connection.mjs';
import {uniqueClientPage} from './client-page.mjs';
import {readEngineConnection} from './engine-client.mjs';
import {readSessionLog} from './session-log.mjs';
import {settleSession,recoverJobPage,adoptMissingSessionHome} from './task-recovery.mjs';
import {releaseComposer} from './stop-job.mjs';
import {inspectPageHandoff,snapshotDraft,clearOwnedDraft,modalDialogs} from '../scripts/mobilework-isolation.mjs';
import {normalizeComposerText} from '../scripts/mobilework-composer.mjs';
import {caseDialog,closeOwnedCaseReplay,adoptCaseTaskDraft} from '../scripts/mobilework-case-library.mjs';
import {restoreModuleNavigation} from '../scripts/mobilework-module-navigation.mjs';
import {registerRootSession,rootJobView,commitRootView,updateRootSummary,isRootOwnedPage} from './root-sessions.mjs';

// Match the submitted draft without inventing separators between product parts.
const matchingText=(log,text)=>log.messages.find(message=>message.info?.role==='user'&&normalizeComposerText(message.parts.filter(part=>part.type==='text').map(part=>part.text||'').join(''))===normalizeComposerText(text));

async function navigateOwned(page,job,url){
 if(page.url()===url)return;
 let current=job.rootSessions.find(root=>root.url===page.url()||root.cleanupUrl===page.url());
 if(!current){
  const missing=job.rootSessions.find(root=>root.sessionMissing&&root.sessionSettled&&page.url()===root.url.slice(0,-('/'+root.id).length));
  if(missing){const view=rootJobView(job,missing);if(await adoptMissingSessionHome(page,view)){commitRootView(missing,view);current=missing;}}
 }
 const known=current||page.url()===job.composerResources?.url||isRootOwnedPage(job,page.url());
 if(!known)throw Error('根任务交接前当前页不属本用例，未切换未知页面');
 if(new URL(page.url()).hash==='#/session'&&job.pendingSubmission){
  const selected=await page.evaluate(()=>localStorage.getItem('openwork.react.newTaskDraftWorkspace'));
  if(selected!==job.pendingSubmission.workspaceId)throw Error('新任务准备入口的实际工作空间已改变，保留现场');
 }
 const handoff=await inspectPageHandoff(page,{allowRunning:Boolean(current)});
 if(!handoff.ready)throw Error(handoff.reason);
 await page.evaluate(url=>{location.hash=new URL(url).hash;},url);await page.waitForURL(url);
}

async function cancelPrepared(page,job,pending,checkpoint){
 const resources=pending.resources;
 if(!resources)throw Error('根任务准备阶段缺少持久资源归属');
 // A suspended owned dialog/draft was deliberately unmounted before the
 // coordinator focused another root. Re-enter only its registered route.
 if(pending.suspended)await navigateOwned(page,job,pending.resumeUrl||pending.originUrl);
 if((job.rootSessions.some(root=>root.url===page.url()||root.cleanupUrl===page.url())||new URL(page.url()).hash==='#/session')&&!resources.moduleNavigation&&!resources.caseTask)await navigateOwned(page,job,pending.originUrl);
 if(new URL(page.url()).hash==='#/explore'){
  if(resources.moduleNavigation?.originUrl!==pending.originUrl||resources.moduleNavigation.targetHash!=='#/explore')throw Error('未提交根任务案例模块归属不符');
  const dialogs=await modalDialogs(page).count(),replay=resources.caseReplay;
  if(dialogs&&(dialogs!==1||replay?.assetId!==pending.source.assetId||replay.title!==pending.source.title||await caseDialog(page,replay.title).count()!==1))throw Error('未提交根任务存在未知弹框，保留现场');
  // opening:true can outlive its unmounted modal. Absence is observed on
  // this exact owned module, so do not wait for an imaginary new dialog.
  if(replay){replay.opening=false;await closeOwnedCaseReplay(page,resources);}
  delete resources.caseTask;
  await restoreModuleNavigation(page,resources,{cdpPort:job.config.cdpPort});
 }else if(resources.caseTask&&!pending.suspended){
  await adoptCaseTaskDraft(page,resources,{finish:false});
 }
 if(page.url()!==pending.originUrl)throw Error('未提交根任务没有恢复到原空间空页');
 const draft=await snapshotDraft(page);
 if(draft.text||draft.skills.length||draft.selection.length){
  if(normalizeComposerText(draft.text)!==normalizeComposerText(pending.expectedPrompt)||draft.skills.length||draft.selection.length)throw Error('未提交根任务草稿与原案例不符，保留现场');
  if(!await clearOwnedDraft(page,draft,job.config))throw Error('未提交根任务草稿清理未确认');
 }
 if(!(await inspectPageHandoff(page)).ready)throw Error('未提交根任务空页尚未交接');
 if(job.composerResources){job.composerResources.url=pending.originUrl;for(const key of ['caseTask','caseReplay','moduleNavigation'])delete job.composerResources[key];}
 delete job.pendingSubmission;job.submissionPending=false;updateRootSummary(job);await checkpoint();
}

async function recoverPending(page,job,runtimes,checkpoint){
 const pending=job.pendingSubmission;if(!pending)return;
 if(pending.state!=='SUBMITTING')return cancelPrepared(page,job,pending,checkpoint);
 const current=new URL(page.url()),origin=new URL(pending.originUrl),id=current.hash.match(/^#\/workspace\/([^/]+)\/session\/(ses_[A-Za-z0-9]+)$/);
 if(!id||current.origin!==origin.origin||current.pathname!==origin.pathname||id[1]!==pending.workspaceId||pending.beforeSessionIds.includes(id[2]))throw Error('已尝试提交的根任务尚未确认唯一新Session，未重发');
 const connection=await readEngineConnection(page),data=await readSessionLog({sessionId:id[2],connection});
 const user=matchingText(data,pending.draft.text);
 if(!user||!data.session.directory)throw Error('待提交根任务真实用户消息或目录与登记来源不符');
 const {caseTask,caseReplay,moduleNavigation,...resources}=pending.resources;
 const root=registerRootSession(job,{key:pending.key,id:id[2],url:page.url(),directory:data.session.directory,
  submissionId:pending.id,firstUserMessageId:user.info.id,evidence:'任务-'+pending.key,resources:{...resources,url:page.url()}});
 runtimes.set(root.key,connection);await checkpoint();
}

async function rootConnection(page,job,root,runtimes){
 if(runtimes.has(root.key))return runtimes.get(root.key);
 await navigateOwned(page,job,root.url);
 const connection=await readEngineConnection(page),query='?directory='+encodeURIComponent(root.directory);
 const response=await fetch(connection.baseUrl.replace(/\/$/,'')+'/session/'+root.id+query,{
  headers:{Authorization:'Basic '+Buffer.from(connection.opencodeUsername+':'+connection.opencodePassword).toString('base64')},redirect:'error',signal:AbortSignal.timeout(5000)
 });
 if(response.status===404){root.sessionMissing=true;root.sessionSettled=true;runtimes.set(root.key,connection);return connection;}
 if(!response.ok)throw Error('重建根任务接口失败 HTTP '+response.status);
 const actual=await response.json();
 if(actual.id!==root.id||path.resolve(actual.directory)!==path.resolve(root.directory))throw Error('重建根任务连接的ID或目录不符');
 const log=await readSessionLog({sessionId:root.id,connection});
 if(!matchingText(log,root.submittedText))throw Error('重建根任务连接未核对真实提交输入');
 runtimes.set(root.key,connection);return connection;
}

// One finalization owner attempts every root before releasing any shared
// resource. Failure in A never short-circuits B's stop acknowledgement.
export async function settleRootSessions(job,{runtimes=new Map(),allowAbort=false,checkpoint=async()=>{}}={}){
 const browser=await connectClient('http://127.0.0.1:'+job.config.cdpPort,{timeout:5000,clientEdition:job.config.clientEdition}),errors=[];
 try{
  const page=uniqueClientPage(browser);page.setDefaultTimeout(5000);
  try{await recoverPending(page,job,runtimes,checkpoint);}catch(error){errors.push('待提交任务：'+error.message);}
  for(const root of job.rootSessions){
   if(root.modelCompleted||root.sessionSettled)continue;
   try{
    const connection=await rootConnection(page,job,root,runtimes),view=rootJobView(job,root);
    const settled=await settleSession(page,view,connection,{allowAbort});
    commitRootView(root,view);updateRootSummary(job);await checkpoint();
    if(!settled)errors.push(root.key+'：根任务尚未确认结束');
   }catch(error){errors.push(root.key+'：'+error.message);}
  }
  updateRootSummary(job);await checkpoint();
  if(errors.length||job.pendingSubmission||!job.sessionSettled)return {ready:false,reason:errors.join('；')||'全部根任务尚未确认结束'};
  for(const root of job.rootSessions){
   if(root.cleanupComplete)continue;
   try{
    if(root.resources){
     await rootConnection(page,job,root,runtimes);
     if(root.sessionMissing&&page.url()===root.url.slice(0,-('/'+root.id).length)){const view=rootJobView(job,root);if(await adoptMissingSessionHome(page,view))commitRootView(root,view);}
     await navigateOwned(page,job,root.cleanupUrl||root.url);
     const view=rootJobView(job,root);
     await releaseComposer(view,{allowAbort:false,checkpoint:async()=>{commitRootView(root,view);await checkpoint();}});
     commitRootView(root,view);
    }
    root.cleanupComplete=true;await checkpoint();
   }catch(error){errors.push(root.key+'资源：'+error.message);}
  }
  if(errors.length)return {ready:false,reason:errors.join('；')};
  // Reuse the old narrowly scoped stale-approval exit only after this exact
  // root has independent abort/missing and settled evidence.
  const current=job.rootSessions.find(root=>root.url===page.url()||root.cleanupUrl===page.url());
  if(current){
   const view=rootJobView(job,current),handoff=await recoverJobPage(page,view,{connection:runtimes.get(current.key),allowAbort:false});
   commitRootView(current,view);await checkpoint();
   if(!handoff.ready)return handoff;
   if(page.url()!==current.url&&job.composerResources?.url===current.url)job.composerResources.url=page.url();
  }
  if(job.composerResources?.url&&page.url()!==job.composerResources.url){
   const handoff=await inspectPageHandoff(page);
   if(!handoff.ready)return handoff;
   await page.evaluate(url=>{location.hash=new URL(url).hash;},job.composerResources.url);await page.waitForURL(job.composerResources.url);
  }
  if(job.composerResources){
   const {workspaceResources,homeModel,url}=job.composerResources;
   job.composerResources={url,attachments:[],queueTexts:[],restorePermission:false,...workspaceResources?{workspaceResources}:{},...homeModel?{homeModel}:{}};
  }
  const finalHandoff=await inspectPageHandoff(page);if(!finalHandoff.ready)return {...finalHandoff,url:page.url()};
  await checkpoint();return {ready:true,url:page.url(),reason:'全部根任务及各自资源已结束'};
 }finally{await browser.close();}
}
