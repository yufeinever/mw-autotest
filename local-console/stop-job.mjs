import {connectClient} from './client-connection.mjs';
import {readEngineConnection,engineRequest} from './engine-client.mjs';
import {readSessionLog} from './session-log.mjs';
import {uniqueClientPage} from './client-page.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {closeOwnedNativeFolder,inspectClientNativeFolders,ownedNativeFolderExists} from '../scripts/mobilework-native-folder.mjs';
import {knowledgeClient,removeOwnedKnowledge,closeKnowledgeSettings} from '../scripts/mobilework-knowledge-api.mjs';
import {releaseExpertResources} from '../scripts/mobilework-expert-resources.mjs';
import {releaseToolResources} from '../scripts/mobilework-tool-resources.mjs';
import {releaseSkillResources} from '../scripts/mobilework-skill-resources.mjs';
import {inspectModuleHandoff} from '../scripts/mobilework-module-handoff.mjs';
import {releaseComposerResources,queuedRow} from '../scripts/mobilework-composer-resources.mjs';
import {releaseManagedSkills} from '../scripts/mobilework-module-resources.mjs';
import {releaseAccountLogout} from '../scripts/mobilework-account-logout.mjs';
import {resumeClientRestart} from '../scripts/mobilework-client-restart.mjs';
import {releaseSettingsPanel} from '../scripts/mobilework-account-settings.mjs';
import {snapshotDraft,clearOwnedDraft,clearSubmittedSelection,composerFieldOf} from '../scripts/mobilework-isolation.mjs';
import {adoptWorkspacePage,createdWorkspaceReady,workspaces,workspaceSessions} from '../scripts/mobilework-workspaces.mjs';
import {normalizeComposerText} from '../scripts/mobilework-composer.mjs';
import {adoptOwnedSession,adoptFailedWorkspaceSession,adoptExistingWorkspaceSession,adoptMissingSessionHome,confirmFailedBeforeSession,restoreFailedSubmissionPage,recoverJobPage,settleSession} from './task-recovery.mjs';
import {restoreModuleNavigation} from '../scripts/mobilework-module-navigation.mjs';
import {settleOwnedAutomation} from '../scripts/mobilework-automation-resources.mjs';
import {adoptCaseTaskDraft} from '../scripts/mobilework-case-library.mjs';
import {identifyKanbanTask} from '../scripts/mobilework-kanban.mjs';
import {settleRecordingResources} from '../scripts/mobilework-recording-workflow.mjs';
import {hasPermissionIdentity} from '../scripts/mobilework-run-policy.mjs';
import {rootSession,rootJobView,commitRootView} from './root-sessions.mjs';
import {ownedKnowledgeCandidate,sameKnowledgePath,sourceAdditionApplied} from '../scripts/mobilework-knowledge-resources.mjs';
const exec=promisify(execFile);
export async function cancelApprovalConsent(page,owned,{resolved=async()=>false}={}){
  if(page.url()!==owned.url)throw Error('完全访问确认页面不属于已登记的Session，保留现场');
  const dialogs=page.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true});
  const consent=dialogs.filter({has:page.getByRole('heading',{name:'确认开启完全访问权限',exact:true})});
  if(owned.phase==='prepared'&&await dialogs.count()===0)return;
  if(owned.phase==='confirming'&&await dialogs.count()===0&&await resolved())return;
  if(await dialogs.count()!==1||await consent.count()!==1)throw Error('完全访问确认结果尚未确认，保留现场');
  if(!await hasPermissionIdentity(page,owned))throw Error('完全访问确认与本轮审批请求不匹配，保留现场');
  const cancel=consent.getByRole('button',{name:'取消',exact:true});
  if(await cancel.count()!==1||await consent.getByRole('button',{name:'同意并开启',exact:true}).count()!==1)throw Error('完全访问确认控件不唯一，保留现场');
  await cancel.click();await consent.waitFor({state:'hidden'});
}
export async function settleStoppedConsent(page,job,owned,connection,checkpoint,{allowAbort=true}={}){
 const root=owned.rootKey?rootSession(job,owned.rootKey):null;
 if(root&&(root.id!==owned.sessionId||root.url!==owned.url||path.resolve(root.directory)!==path.resolve(owned.directory))||!root&&(job.sessionId!==owned.sessionId||job.sessionUrl!==owned.url))throw Error('完全访问确认不属于本轮停止的Session');
 const current=root?rootJobView(job,root):job;
 let settled;
 try{settled=await settleSession(page,current,connection,{allowAbort,checkpoint:async()=>{if(root)commitRootView(root,current);await checkpoint();}});}
 finally{if(root)commitRootView(root,current);await checkpoint();}
 return settled;
}
export async function releaseApprovalConsent(job,{allowAbort=false,checkpoint=async()=>{}}={}){
 const owned=job.approvalConsent;if(!owned)return;
 const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  await cancelApprovalConsent(page,owned,{resolved:async()=>{
   const connection=await readEngineConnection(page),query='?directory='+encodeURIComponent(owned.directory);
   const session=await engineRequest(connection,'/session/'+owned.sessionId+query);
   if(session.id!==owned.sessionId||path.resolve(session.directory)!==path.resolve(owned.directory))throw Error('完全访问确认所属Session目录已变化');
   if(allowAbort)return settleStoppedConsent(page,job,owned,connection,checkpoint);
   const root=owned.rootKey?rootSession(job,owned.rootKey):null;
   if((root||job).abortAcknowledged)return settleStoppedConsent(page,job,owned,connection,checkpoint,{allowAbort:false});
   const permissions=await engineRequest(connection,'/permission'+query);
   if(!Array.isArray(permissions))throw Error('审批列表格式无效');
   return !permissions.some(item=>item.id===owned.id&&item.sessionID===owned.sessionId);
  }});
  delete job.approvalConsent;await checkpoint();
 }finally{await browser.close();}
}
async function adoptRecordingSubmission(page,job,checkpoint){
 if(job.sessionId||!job.submissionPending)return;
 const owned=job.recordingResources,draft=job.ownedDraft,workspace=job.composerResources?.workspaceResources;
 if(!draft?.text||workspace?.existingTargetId!==owned.workspaceId||!Array.isArray(workspace.beforeSessionIds))throw Error('SOP待提交任务缺少完整草稿或会话基线，保留交接');
 const current=new URL(page.url()),origin=new URL(draft.url),route=current.hash.match(/^#\/workspace\/([^/]+)\/session\/(ses_[A-Za-z0-9]+)$/);
 if(!route||current.origin!==origin.origin||current.pathname!==origin.pathname||route[1]!==owned.workspaceId||workspace.beforeSessionIds.includes(route[2])||(job.completedSessions||[]).some(session=>session.id===route[2]))throw Error('SOP待提交页面尚未对应本轮新的阶段Session');
 const space=(await workspaces(page)).items.find(item=>item.id===owned.workspaceId),session=(await workspaceSessions(page,owned.workspaceId)).find(item=>item.id===route[2]);
 if(!space||!session||!path.isAbsolute(session.directory||'')||!Number.isFinite(session.time?.created)||session.time.created<Date.parse(job.startedAt))throw Error('SOP待提交Session的空间、目录或创建边界不符');
 const relative=path.relative(space.path,session.directory);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('SOP待提交Session不在本轮空间的独立任务目录');
 const data=await readSessionLog({sessionId:session.id,connection:await readEngineConnection(page)}),user=data.messages.find(message=>message.info?.role==='user');
 const text=(user?.parts||[]).filter(part=>part.type==='text').map(part=>part.text||'').join('');
 if(data.session.id!==session.id||path.resolve(data.session.directory).toLowerCase()!==path.resolve(session.directory).toLowerCase()||normalizeComposerText(text)!==normalizeComposerText(draft.text))throw Error('SOP待提交Session实际首条用户消息或目录与完整草稿不符');
 job.sessionId=session.id;job.sessionUrl=page.url();job.sessionDirectory=session.directory;job.submissionPending=false;job.submittedSelection=draft.selection;
 job.composerResources.url=job.sessionUrl;delete job.ownedDraft;
 job.recoveryAction='已按空间基线、实际任务目录及完整首条用户消息恢复SOP阶段提交，未重复发送';await checkpoint();
}
// SOP capture is independent from the console's evidence video. Keep this
// checkpoint until its recorder, late continuation and both Sessions settle.
export async function releaseSopRecording(job,{allowAbort=false,checkpoint=async()=>{}}={}){
 if(!job.recordingResources)return;
 const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  await adoptRecordingSubmission(page,job,checkpoint);
  const submittedSession=job.sessionId?{id:job.sessionId,url:job.sessionUrl}:null;
  const settled=await settleRecordingResources(page,job.recordingResources,{allowAbort,checkpoint,submittedSession,submissionPending:Boolean(job.submissionPending||job.pendingSubmission)});
  if(!settled?.ready||!job.recordingResources.cleanupComplete)throw Error('本轮SOP录制、续轮或回放资源尚未完成收尾');
  const session=[job.recordingResources.sourceSession,job.recordingResources.replaySession].find(session=>session?.id===job.sessionId);
  if(session?.sessionSettled){job.sessionSettled=true;if(session.abortAcknowledged)job.abortAcknowledged=true;}
  delete job.recordingResources;await checkpoint();
 }finally{await browser.close();}
}
export async function settleComposerSession(page,job,{allowAbort=false,checkpoint=async()=>{},connection}={}){
 if(!job.sessionId)return true;
 const current={sessionId:job.sessionId,abortAcknowledged:job.abortAcknowledged,recoveryAbortAttempted:job.recoveryAbortAttempted,...(job.sessionMissing&&job.sessionSettled?{sessionMissing:true,sessionSettled:true}:{})};
 const save=async()=>{
  for(const key of ['abortAcknowledged','recoveryAbortAttempted','sessionSettled','sessionMissing'])if(current[key]!==undefined)job[key]=current[key];
  await checkpoint();
 };
 try{return await settleSession(page,current,connection,{allowAbort,checkpoint:save});}
 finally{await save();}
}
export async function releaseComposer(job,{allowAbort=false,checkpoint=async()=>{}}={}){
 if(job.recordingResources)throw Error('本轮SOP录制尚未完成收尾，保留输入区及空间资源');
 if(job.expertResources)throw Error('本轮专家安装、召唤或历史尚未收尾，保留模块入口及输入区资源');
 if(!job.composerResources)return;
 const reconnected=await resumeClientRestart(job.composerResources,job.config,{checkpoint});
 const browser=reconnected?.browser||await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  await releaseAccountLogout(page,job.composerResources,{checkpoint});
  await releaseSettingsPanel(page,job.composerResources);
  await adoptFailedWorkspaceSession(page,job,{allowAbort,checkpoint});
  if(await adoptOwnedSession(page,job)){
   job.composerResources.url=job.sessionUrl;
   await checkpoint();
  }
  if(confirmFailedBeforeSession(job))await checkpoint();
  const failure=await restoreFailedSubmissionPage(page,job);
  if(!failure.ready)throw Error(failure.reason);
  const workspace=job.composerResources.workspaceResources;
  if(workspace?.existingTargetId){
   if(job.submissionPending&&!job.sessionId){
    if(!await adoptExistingWorkspaceSession(page,job))throw Error('本轮发送尚未确认Session归属，保留现场');
   }
   if(job.sessionId&&page.url()===job.sessionUrl&&new URL(page.url()).hash==='#/workspace/'+workspace.existingTargetId+'/session/'+job.sessionId){
    job.composerResources.url=job.sessionUrl;await checkpoint();
   }
  }
  if(job.composerResources.kanban?.task?.submitted){
   const task=job.composerResources.kanban.task,link=await identifyKanbanTask(page,job.composerResources);
   if(job.sessionId&&job.sessionId!==link.sessionId)throw Error('看板Session与调度登记不一致');
   task.sessionId=link.sessionId;job.sessionId=link.sessionId;job.sessionUrl=link.sessionUrl;job.submissionPending=false;
   job.composerResources.url=link.sessionUrl;delete job.composerResources.moduleNavigation;
   if(page.url()!==link.sessionUrl){await page.evaluate(url=>{location.hash=new URL(url).hash;},link.sessionUrl);await page.waitForURL(link.sessionUrl);}
   if(job.ownedDraft&&!job.ownedDraft.text&&!job.ownedDraft.skills.length&&!job.ownedDraft.selection.length)delete job.ownedDraft;
  }
  const automation=job.composerResources.automation;
  if(automation){
   const link=await settleOwnedAutomation(page,automation,{allowAbort});
   if(link){
    const current=new URL(automation.originUrl);current.hash='/workspace/'+link.workspaceId+'/session/'+link.sessionId;
    if(!job.sessionId){job.sessionId=link.sessionId;job.sessionUrl=current.href;job.sessionSettled=true;}
    if(page.url()===current.href){
     delete job.composerResources.moduleNavigation;job.composerResources.url=current.href;
     const draft=job.ownedDraft;
     if(draft?.url===automation.originUrl&&!draft.text&&!draft.skills.length&&!draft.selection.length)delete job.ownedDraft;
    }
   }
  }
  const caseDraft=await adoptCaseTaskDraft(page,job.composerResources);
  if(caseDraft){job.ownedDraft=caseDraft;job.composerResources.url=page.url();}
  if(job.composerResources.managedSkills?.pickerToken){
   await releaseManagedSkills(page,job.composerResources.managedSkills,{checkpoint});
   delete job.composerResources.managedSkills;await checkpoint();
  }
  // Referenced libraries remain available until this session has stopped.
  const deferredModule=Boolean(job.composerResources.knowledgeSelection||job.composerResources.kanban?.task?.submitted);
  if(!deferredModule)await restoreModuleNavigation(page,job.composerResources,{cdpPort:job.config.cdpPort});
  const adopted=await adoptWorkspacePage(page,job.composerResources);
  if(adopted){job.ownedDraft=adopted;job.composerResources.url=page.url();await checkpoint();}
  if(await adoptMissingSessionHome(page,job))await checkpoint();
  if(page.url()!==job.composerResources.url)throw Error('本轮输入区页面归属已变化，未清理');
  // The worker has exited. Settle its own session before restoring controls.
  if(job.sessionId){
   const settled=await settleComposerSession(page,job,{allowAbort,checkpoint});
   if(!settled)throw Error('本轮会话仍未结束，保留输入区资源并等待收尾');
  }
  // An acknowledged abort can leave its stale permission card in place of
  // the composer. Use the existing owned-session handoff before reading it.
  if(job.abortAcknowledged&&job.sessionSettled&&page.url()===job.sessionUrl&&await composerFieldOf(page).count()===0){
   const target=new URL(job.sessionUrl);target.hash=target.hash.replace(/\/session\/ses_[A-Za-z0-9]+$/,'/session');
   const handoff=await recoverJobPage(page,job);
   if(!handoff.ready||page.url()!==target.href)throw Error('停止后的审批页面尚未回到原空间空任务，保留输入区资源');
   job.composerResources.url=page.url();delete job.ownedDraft;await checkpoint();
  }
  for(const text of job.composerResources.queueTexts){
   const row=queuedRow(page,text);
   if(await row.count()>1)throw Error('排队消息不唯一，未清理');
   if(await row.count())await row.getByRole('button',{name:'删除排队消息',exact:true}).click();
  }
  if(deferredModule)await restoreModuleNavigation(page,job.composerResources,{modelSettled:Boolean(job.modelCompleted||job.sessionSettled),cdpPort:job.config.cdpPort});
  if(job.ownedDraft&&await composerFieldOf(page).count()===1){
   const actual=await snapshotDraft(page);
   if((actual.text||actual.skills.length||actual.selection.length)&&!await clearOwnedDraft(page,job.ownedDraft,job.config))throw Error('输入区收尾前草稿归属未确认');
   delete job.ownedDraft;
  }
  if(job.sessionSettled&&job.submittedSelection?.length&&page.url()===job.sessionUrl&&await composerFieldOf(page).count()===1){
   const actual=await snapshotDraft(page);
   if(actual.selection.length&&!await clearSubmittedSelection(page,{sessionId:job.sessionId,sessionUrl:job.sessionUrl,selection:job.submittedSelection},job.config))throw Error('提交后的专家选择或输入已变化，保留现场');
  }
  await releaseComposerResources(page,job.composerResources,{...job.config,checkpoint,checkpointPage:async()=>{job.composerResources.url=page.url();await checkpoint();},modelSettled:Boolean(job.sessionId&&(job.modelCompleted||job.sessionSettled))});delete job.composerResources;
 }finally{await browser.close();}
}
export async function releaseSkill(job){
 if(!job.skillResources)return;
 const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  if(await composerFieldOf(page).count()===1){
   const draft=await snapshotDraft(page);
   if((draft.text||draft.skills.length||draft.selection.length)&&!await clearOwnedDraft(page,job.ownedDraft,job.config))throw Error('技能资源收尾前草稿归属未确认');
  }
  await releaseSkillResources(page,job.skillResources);delete job.skillResources;
 }finally{await browser.close();}
}
export async function releaseTool(job){
 if(!job.toolResources)return;
 const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  if(await composerFieldOf(page).count()===1){
   const draft=await snapshotDraft(page);
   if(draft.text||draft.skills.length||draft.selection.length)throw Error('工具资源收尾前出现未知草稿或选择，保留现场');
  }
  const modal=page.locator('div[data-composer-toolbar-retain].fixed.inset-0').filter({visible:true});
  if(await modal.count()){
   if(await modal.count()!==1||!(await modal.innerText()).includes(job.toolResources.name))throw Error('工具收尾遇到未知弹窗，未操作');
   await modal.getByRole('button',{name:'取消',exact:true}).click();
  }
  await releaseToolResources(page,job.toolResources);
  await page.reload();delete job.toolResources;
 }finally{await browser.close();}
}
export async function releaseExpert(job,{checkpoint=async()=>{}}={}){
 if(job.recordingResources)throw Error('本轮SOP录制尚未完成收尾，保留专家资源及历史');
 if(!job.expertResources)return;
 const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  const handoff=job.expertResources.summonTarget&&job.composerResources?await inspectModuleHandoff(page,job.composerResources):null;
  if(handoff){
   job.ownedDraft=handoff;job.composerResources.url=handoff.url;
   delete job.composerResources.moduleNavigation;job.expertResources.summonTarget='';
   await checkpoint();
  }
  if(!job.expertResources.summonTarget&&job.sessionId&&page.url()===job.sessionUrl&&!await settleSession(page,{sessionId:job.sessionId,abortAcknowledged:job.abortAcknowledged}))throw Error('专家所属会话仍未结束，保留专家资源');
  if(!job.expertResources.summonTarget&&await composerFieldOf(page).count()===1){
   const draft=await snapshotDraft(page);
   if(draft.text||draft.skills.length||draft.selection.length){
    let cleared=await clearOwnedDraft(page,job.ownedDraft,job.config);
    if(!cleared&&job.sessionId){
     const current={sessionId:job.sessionId,abortAcknowledged:job.abortAcknowledged};
     if(await settleSession(page,current))cleared=await clearSubmittedSelection(page,{sessionId:job.sessionId,sessionUrl:job.sessionUrl,selection:job.submittedSelection},job.config);
    }
    if(!cleared)throw Error('专家资源收尾前草稿归属未确认，未提前卸载');
   }
   if(handoff)job.ownedDraft=await snapshotDraft(page);
  }
  await releaseExpertResources(page,job.expertResources,{draft:job.ownedDraft,config:job.config,checkpoint});delete job.expertResources;
  await checkpoint();
 }
 finally{await browser.close();}
}
export async function releaseNativeFolder(job){
 const libraries=[job.composerResources?.knowledgeCreation,job.composerResources?.knowledgeSecondaryCreation].filter(Boolean);
 const cancelPicking=(folder,includeSubmitted=false)=>{
  for(const owned of libraries)for(const operation of [owned.sourceAdd,owned.storageMove]){
   if(operation&&(operation.state==='picking'||includeSubmitted&&operation.state==='submitted')&&(!folder||sameKnowledgePath(operation.path||operation.to,folder)))operation.state='rejected';
  }
 };
 if(!job.nativeFolder){cancelPicking();return;}
 if(job.nativeFolder.phase==='opened'&&!await ownedNativeFolderExists(job.nativeFolder))job.nativeFolder.phase='confirming';
 if(['confirming','confirmed'].includes(job.nativeFolder.phase)){
  const owned=job.composerResources?.workspaceResources,target=owned?.target;
  const knowledge=libraries.filter(item=>[item.sourceAdd?.path,item.storageMove?.to].some(folder=>folder&&sameKnowledgePath(folder,job.nativeFolder.path)));
  const workspaceMatch=target?.path&&sameKnowledgePath(target.path,job.nativeFolder.path);
  const forms=[job.knowledge,...libraries].filter(item=>item&&!item.submitted&&[item.storageDir,item.sourceDir].some(folder=>folder&&sameKnowledgePath(folder,job.nativeFolder.path)));
  const skill=job.composerResources?.managedSkills;
  const skillMatch=skill?.pickerToken&&skill.importFolder&&sameKnowledgePath(skill.importFolder,job.nativeFolder.path);
  const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
  try{
   const page=uniqueClientPage(browser),native=await inspectClientNativeFolders(page);
   if(native.pid!==job.nativeFolder.pid)throw Error('原生目录窗口客户端进程已变化');
   if(await ownedNativeFolderExists(job.nativeFolder)){
    if(native.dialogs.length!==1||native.dialogs[0].hwnd!==job.nativeFolder.hwnd)throw Error('原生目录窗口归属不唯一');
    await closeOwnedNativeFolder(job.nativeFolder);cancelPicking(job.nativeFolder.path,true);delete job.nativeFolder;return;
   }
   if(native.dialogs.length)throw Error('存在其他原生目录窗口，保留现场');
   if(Number(Boolean(workspaceMatch))+knowledge.length+forms.length+Number(Boolean(skillMatch))!==1)throw Error('原生目录提交后的业务归属不唯一，保留本轮归属');
   if(skillMatch){
    if(new URL(page.url()).hash!=='#/experts/skills')throw Error('技能上传页面归属已变化');
    const heading=page.locator('[data-mw-skill-picker="'+skill.pickerToken+'"]');await heading.waitFor({state:'visible',timeout:10000});
    const modal=heading.locator('xpath=ancestor::div[.//button[normalize-space()="取消"] and .//button[normalize-space()="导入"]][1]');
    await modal.getByText(skill.ids[0],{exact:true}).waitFor({state:'visible',timeout:10000});
    delete job.nativeFolder;return;
   }
   const storage=job.composerResources?.systemStorage,panel=job.composerResources?.settingsPanel;
   if(workspaceMatch&&storage?.stage==='prepared'&&panel?.relocationToken&&sameKnowledgePath(storage.targetPath,job.nativeFolder.path)){
    if(page.url()!==panel.originUrl||!await page.locator('[data-mw-settings-panel="'+panel.token+'"]').isVisible())throw Error('默认空间设置面板归属不匹配');
    const dialog=page.getByRole('dialog',{name:'在新目录新建默认工作空间?',exact:true}).filter({visible:true});
    await dialog.waitFor({state:'visible',timeout:10000});
    if(await dialog.count()!==1)throw Error('默认空间确认框不唯一');
    await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-relocation',token),panel.relocationToken);
    await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
    delete job.nativeFolder;return;
   }
   if(forms.length){
    const form=forms[0],field=form.sourceDir&&sameKnowledgePath(form.sourceDir,job.nativeFolder.path)?'source':form===job.knowledge?'storage':'wiki';
    if(new URL(page.url()).hash!=='#/knowledge'||await page.getByRole('textbox',{name:'知识库名称',exact:true}).inputValue()!==form.name)throw Error('知识库创建表单归属不匹配');
    await page.waitForFunction(({field,folder})=>[...document.querySelectorAll('[data-knowledge-guide="'+field+'"] [title], [data-knowledge-guide="'+field+'"] p')].some(node=>(node.getAttribute('title')||node.textContent||'').replaceAll('\\','/').toLowerCase()===folder),{field,folder:job.nativeFolder.path.replaceAll('\\','/').toLowerCase()},{timeout:10000});
    delete job.nativeFolder;return;
   }
   if(knowledge.length){
    const record=knowledge[0],call=await knowledgeClient(page),item=await call('/knowledge/'+record.id);
    if(item.id!==record.id||!ownedKnowledgeCandidate([item],record))throw Error('本轮知识库身份或目录操作尚未确认');
    if(record.sourceAdd&&sameKnowledgePath(record.sourceAdd.path,job.nativeFolder.path)){
     if(!['submitted','completed'].includes(record.sourceAdd.state)||!sourceAdditionApplied(item,record.sourceAdd))throw Error('本轮源目录添加结果尚未确认');
     record.sourceAdd.state='completed';
    }else{
     if(!['submitted','completed'].includes(record.storageMove?.state)||!sameKnowledgePath(item.storage_dir,record.storageMove.to))throw Error('本轮存储迁移结果尚未确认');
     record.storageMove.state='completed';
    }
    delete job.nativeFolder;return;
   }
   const candidates=(await workspaces(page)).items.filter(item=>!owned.beforeIds.includes(item.id)&&item.name===target.name&&path.resolve(item.path).toLowerCase()===path.resolve(target.path).toLowerCase());
   if(candidates.length!==1||!await createdWorkspaceReady(page,candidates[0]))throw Error('本轮空间创建及页面切换尚未完成，保留本轮归属');
   const draft=await snapshotDraft(page);
   if(draft.text||draft.skills.length||draft.selection.length)throw Error('本轮空间出现未知输入，保留现场');
   delete job.nativeFolder;return;
  }finally{await browser.close();}
 }
 if(job.nativeFolder.phase&&job.nativeFolder.phase!=='opened')throw Error('原生文件夹窗口的打开或提交结果尚未确认，保留本轮归属');
 await closeOwnedNativeFolder(job.nativeFolder);
 cancelPicking(job.nativeFolder.path);
 delete job.nativeFolder;
}
export async function releaseKnowledge(job){
 if(!job.knowledge)return;
 const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  const owned=job.knowledge,call=await knowledgeClient(page);
  let item=owned.id?{id:owned.id,name:owned.name,storageDir:owned.storageDir}:null;
  if(!item&&owned.beforeIds){
   const deadline=Date.now()+(owned.submitted?15000:0);
   do{
    const candidate=ownedKnowledgeCandidate(await call('/knowledge/list'),{...owned,sourceDir:null});
    if(candidate){item={id:candidate.id,name:candidate.name,storageDir:candidate.storage_dir};break;}
    if(!owned.submitted)break;
    await page.waitForTimeout(200);
   }while(Date.now()<deadline);
   if(!item&&owned.submitted)throw Error('本轮知识库创建结果尚未确认，保留归属');
  }
  if(item){await closeKnowledgeSettings(page,item);await removeOwnedKnowledge(call,item);}
  delete job.knowledge;
 }finally{await browser.close();}
}
export async function killScript(job){
 if(!Number.isInteger(job.pid)||job.pid<=0)throw Error('没有可核实的脚本进程，不能强制结束未知进程');
 // Windows PowerShell defaults to a legacy code page when stdout is piped.
 // Node decodes UTF-8: Chinese project paths would otherwise fail identity checks.
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter "ProcessId=${job.pid}"; if($p){@{command=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`],{windowsHide:true,timeout:8000,encoding:'utf8'});
 if(!stdout.trim())return;
 const p=JSON.parse(stdout);
 const created=Date.parse(p.created),started=Date.parse(job.startedAt);
 if(!job.path||!p.command?.includes(job.path)||!Number.isFinite(created)||!Number.isFinite(started)||Math.abs(created-started)>15000)throw Error('进程身份核对不通过，未结束该进程（路径或启动时间不匹配）');
 await exec('taskkill.exe',['/PID',String(job.pid),'/T','/F'],{windowsHide:true,timeout:10000});
}
export async function stopSession(job,{connection,checkpoint=async()=>{}}={}){
 const id=job.result?.sessionId||job.sessionId||job.log?.match(/(?:任务已发送|续跑既有会话)\s+(ses_[A-Za-z0-9]+)/)?.[1];
 if(!id)return '未获取会话 ID，未操作客户端会话；请核对客户端';
 if(connection){
  const base=connection.baseUrl,headers={Authorization:'Basic '+btoa(connection.opencodeUsername+':'+connection.opencodePassword)};
  const get=await fetch(base+'/session/'+id,{headers,signal:AbortSignal.timeout(5000)});
  // A 404 means the session is already gone. Treat it as a confirmed stop so
  // a failed/blocked job cannot keep the scheduler lock forever after the
  // client has already removed the session.
  if(get.status===404){job.sessionSettled=true;job.sessionMissing=true;await checkpoint();return '客户端会话已不存在，确认停止 '+id;}
  if(!get.ok)throw Error('核对会话失败 HTTP '+get.status);
  const session=await get.json();if(session.id!==id)throw Error('会话 ID 不一致');
  if(job.recoveryAbortAttempted||job.abortAcknowledged)throw Error('本次会话已有停止尝试，等待实际终态');
  job.recoveryAbortAttempted=true;
  try{await checkpoint();}catch(error){job.recoveryAbortAttempted=false;throw error;}
  const response=await fetch(base+'/session/'+id+'/abort'+(session.directory?'?directory='+encodeURIComponent(session.directory):''),{method:'POST',headers,signal:AbortSignal.timeout(5000)});
  if(response.status===404){job.sessionSettled=true;job.sessionMissing=true;await checkpoint();return '客户端会话已不存在，确认停止 '+id;}
  if(!response.ok||await response.json()!==true)throw Error('客户端未确认停止本次会话');
  job.abortAcknowledged=true;await checkpoint();return '客户端已确认停止本次会话 '+id;
 }
 const browser=await connectClient(`http://127.0.0.1:${job.config.cdpPort||9223}`,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const page=uniqueClientPage(browser);
  if(!page)throw Error('未找到客户端主界面');
  return await stopSession(job,{connection:await readEngineConnection(page),checkpoint});
 }finally{await browser.close();}
}
export async function releaseOwnedLock(job,root){
 if(!Number.isInteger(job.pid)||job.pid<=0)return;
 const file=path.join(root,'runs','.client-case001.lock');
 try{const l=JSON.parse(await fs.readFile(file,'utf8'));if(l.pid!==job.pid)return;
  // Preserve existing evidence; expose it in the stopped run's report.
  const dir=await fs.realpath(l.dir),runs=await fs.realpath(path.join(root,'runs'));
  const rel=path.relative(runs,dir);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))return;
  job.reportPath=path.join(dir,'执行报告.md');
  try{job.result=JSON.parse(await fs.readFile(path.join(dir,'执行结果.json'),'utf8'));}catch{
   const files=await fs.readdir(dir);job.result={checks:[],evidence:files.filter(f=>f.endsWith('.png')).sort().map(f=>({step:path.basename(f,'.png'),screenshot:f}))};
  }
  await fs.unlink(file);
 }catch(e){if(e.code!=='ENOENT')throw e;}
}
