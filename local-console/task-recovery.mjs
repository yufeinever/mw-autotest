import {connectClient} from './client-connection.mjs';
import {isClientPageUrl} from './client-page.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {inspectPageHandoff,snapshotDraft,composerFieldOf} from '../scripts/mobilework-isolation.mjs';
import {normalizeComposerText} from '../scripts/mobilework-composer.mjs';
import {workspaces,workspaceSessions} from '../scripts/mobilework-workspaces.mjs';
import {readEngineConnection,engineRequest} from './engine-client.mjs';
import {waitStep} from '../scripts/mobilework-run-policy.mjs';

// Only the runner's explicit pre-session failure is evidence that submission
// did not reach the model. A timeout, empty session ID or clean page is not.
export function failedBeforeSession(job){
 const r=job.result;
 return Boolean(job.submissionPending&&!job.sessionId&&!r?.sessionId&&r?.result==='BLOCKED'&&
  typeof r.error==='string'&&r.error.startsWith('客户端工作区准备失败：')&&
  r.events?.some(e=>e.step==='BLOCKED'&&typeof e.detail==='string'&&
   e.detail.startsWith('客户端工作区准备失败：')&&e.detail.endsWith('；未创建Session')&&
   (e.detail===r.error||r.error.startsWith(e.detail+'；'))));
}

export function confirmFailedBeforeSession(job){
 if(!failedBeforeSession(job))return false;
 job.submissionPending=false;
 job.submissionFailureConfirmed=true;
 job.recoveryAction='原报告确认创建Session前工作区准备失败，撤销本次待提交标记；未停止其他会话';
 return true;
}

export async function restoreFailedSubmissionPage(page,job){
 const origin=job.ownedDraft?.url||job.composerResources?.url;
 if(job.submissionFailureConfirmed&&origin){
  if(page.url()!==origin)return {ready:false,reason:'失败页面归属已变化，保留现场'};
  const body=await page.locator('body').innerText();
  if(body.includes('工作区准备失败')){
   if(await page.getByRole('dialog').filter({visible:true}).count())return {ready:false,reason:'失败页仍有弹窗，保留现场'};
   const back=page.getByRole('button',{name:'返回编辑',exact:true}).filter({visible:true});
   if(await back.count()!==1)return {ready:false,reason:'请在客户端返回编辑，未找到唯一返回入口'};
   await waitStep(page,job.config||{});await back.click({timeout:3000});
   await page.locator('[contenteditable="true"]').filter({visible:true}).waitFor({timeout:5000});
  }
  if(await page.locator('[contenteditable="true"]').filter({visible:true}).count()!==1)return {ready:false,reason:'失败页面尚未恢复到唯一编辑区'};
 }
 return {ready:true};
}

function sessionRoute(value){
 const text=String(value||'');
 const match=text.match(/^(.*\/session)(?:\/(ses_[A-Za-z0-9]+))?(?:[/?#]|$)/);
 return match?{base:match[1],id:match[2]||null}:null;
}

// The client can navigate to a real Session before the runner observes the
// URL change. Recover only when the page remains in the same workspace and
// still contains the exact owned submission text; never infer from a bare
// Session URL or from a similar task title.
export async function adoptOwnedSession(page,job){
 if(job.sessionId||!job.ownedDraft?.url||typeof job.ownedDraft.text!=='string'||!job.ownedDraft.text)return false;
 const current=sessionRoute(page.url()),draft=sessionRoute(job.ownedDraft.url);
 if(!current?.id||!draft||current.base!==draft.base)return false;
 const body=await page.locator('body').innerText();
 const normalize=value=>String(value).replace(/\s+/g,' ').trim();
 if(!normalize(body).includes(normalize(job.ownedDraft.text)))return false;
 job.sessionId=current.id;job.sessionUrl=page.url();job.submissionPending=false;
 return true;
}

// Reconcile a missing task only on its exact, empty workspace home and in
// its recorded task directory. A different page or a user draft is preserved.
export async function adoptMissingSessionHome(page,job){
 const owned=job.composerResources,id=job.sessionId;
 if(!id||!(job.modelCompleted||job.sessionMissing&&job.sessionSettled)||!job.sessionUrl?.endsWith('/session/'+id)||owned?.url!==job.sessionUrl)return false;
 const home=job.sessionUrl.slice(0,-('/'+id).length);
 if(page.url()!==home)return false;
 const directory=job.sessionDirectory||job.result?.sessions?.find(item=>item.id===id)?.directory;
 if(!directory)return false;
 const connection=await readEngineConnection(page);
 const response=await fetch(connection.baseUrl.replace(/\/$/,'')+'/session/'+id+'?directory='+encodeURIComponent(directory),{
  headers:{Authorization:'Basic '+btoa(connection.opencodeUsername+':'+connection.opencodePassword)},redirect:'error',signal:AbortSignal.timeout(5000)
 });
 if(response.status!==404)return false;
 const draft=await snapshotDraft(page);
 if(draft.url!==home||draft.text||draft.skills.length||draft.selection.length||!(await inspectPageHandoff(page)).ready)return false;
 owned.url=home;job.ownedDraft=draft;
 job.sessionMissing=true;job.sessionSettled=true;
 job.recoveryAction='已核对本轮Session在原任务目录返回404、同空间空首页及无弹框，继续原资源收尾；历史结果不变';
 return true;
}

export async function adoptExistingWorkspaceSession(page,job){
 const workspace=job.composerResources?.workspaceResources;
 if(job.sessionId||!job.submissionPending||!workspace?.existingTargetId||!Array.isArray(workspace.beforeSessionIds)||!job.ownedDraft?.text)return false;
 const current=page.url().match(/\/workspace\/([^/]+)\/session\/(ses_[A-Za-z0-9]+)$/);
 if(!current||current[1]!==workspace.existingTargetId||workspace.beforeSessionIds.includes(current[2]))return false;
 const space=(await workspaces(page)).items.find(item=>item.id===workspace.existingTargetId);
 const session=(await workspaceSessions(page,workspace.existingTargetId)).find(item=>item.id===current[2]);
 if(!space||!session?.directory||!Number.isFinite(session.time?.created)||!Number.isFinite(Date.parse(job.startedAt))||session.time.created<Date.parse(job.startedAt))return false;
 const relative=path.relative(space.path,session.directory);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return false;
 const connection=await readEngineConnection(page);
 const messages=await engineRequest(connection,'/session/'+session.id+'/message?directory='+encodeURIComponent(session.directory));
 const text=messages.filter(message=>message.info?.role==='user').flatMap(message=>(message.parts||[]).filter(part=>part.type==='text').map(part=>part.text||'')).join('\n');
 if(!normalizeComposerText(text).includes(normalizeComposerText(job.ownedDraft.text)))return false;
 return adoptOwnedSession(page,job);
}

// A failed send can leave a newly created Session behind the progress panel.
// Its normal "enter task" action proves the link, even when no user message
// reached the engine. Restrict this recovery to this job's isolated workspace.
export async function adoptFailedWorkspaceSession(page,job,{allowAbort=false,checkpoint=async()=>{}}={}){
 const owned=job.ownedDraft,workspace=job.composerResources?.workspaceResources;
 if(!allowAbort||job.sessionId||!job.submissionPending||!owned?.text||!workspace?.target||page.url()!==owned.url)return false;
 const failed=page.getByRole('alert').filter({visible:true,hasText:'消息未能发送'});
 const enter=failed.getByRole('button',{name:'进入任务',exact:true});
 if(await failed.count()!==1||await enter.count()!==1)return false;
 const actual=await snapshotDraft(page,composerFieldOf(page));
 if(normalizeComposerText(actual.text)!==normalizeComposerText(owned.text)||JSON.stringify(actual.skills)!==JSON.stringify(owned.skills)||JSON.stringify(actual.selection)!==JSON.stringify(owned.selection))return false;
 const matches=(await workspaces(page)).items.filter(item=>!workspace.beforeIds.includes(item.id)&&item.name===workspace.target.name);
 if(matches.length!==1||!page.url().endsWith('/workspace/'+matches[0].id+'/session'))return false;
 const completed=new Set((job.completedSessions||[]).map(s=>s.id));
 const sessions=(await workspaceSessions(page,matches[0].id)).filter(s=>!completed.has(s.id)&&s.time?.created>=Date.parse(job.startedAt));
 if(sessions.length!==1)return false;
 const session=sessions[0],relative=path.relative(matches[0].path,session.directory);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return false;
 const connection=await readEngineConnection(page),messages=await engineRequest(connection,'/session/'+session.id+'/message?directory='+encodeURIComponent(session.directory));
 if(messages.length){
  const text=messages.filter(m=>m.info.role==='user').flatMap(m=>m.parts.filter(p=>p.type==='text').map(p=>p.text)).join('\n');
  if(normalizeComposerText(text)!==normalizeComposerText(owned.text))return false;
 }
 const target=owned.url+'/'+session.id;
 await enter.click();await page.waitForURL(target,{waitUntil:'commit'});
 job.sessionId=session.id;job.sessionUrl=target;job.submissionPending=false;
 job.composerResources.url=target;delete job.ownedDraft;
 job.recoveryAction='发送失败面板进入本轮独立空间的新任务，已核对Session、目录及消息归属；未重复发送';
 await checkpoint();return true;
}

export async function settleSession(page,job,connection,{allowAbort=false}={}){
 if(!job.sessionId)return !job.submissionPending;
 if(job.modelCompleted||job.sessionSettled)return true;
 if(!connection){
  // A default workspace or another task's page is not evidence of this
  // session's engine. Never abort using whichever engine happens to be open.
  if(!page.url().endsWith('/session/'+job.sessionId))throw Error('尚未取得本会话引擎连接，未操作其他会话');
  const info=await page.evaluate(()=>(window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__).invokeDesktop('engineInfo'));
  connection={baseUrl:info?.baseUrl,opencodeUsername:info?.opencodeUsername,opencodePassword:info?.opencodePassword};
 }
 if(!connection.baseUrl)throw Error('本会话引擎未就绪');
 const base=connection.baseUrl.replace(/\/$/,''),headers={Authorization:'Basic '+btoa(connection.opencodeUsername+':'+connection.opencodePassword)};
 const request=async(route,method='GET')=>{
  const r=await fetch(base+route,{method,headers,signal:AbortSignal.timeout(5000)});
  if(!r.ok){
   let message='';try{message=(await r.json())?.data?.message||'';}catch{}
   throw Object.assign(Error('核对本会话接口失败 HTTP '+r.status),{status:r.status,patchPermissionError:route.startsWith('/permission?')&&r.status===400&&/Expected JSON value/.test(message)&&/filePath/.test(message)&&/patch/.test(message)});
  }return r.json();
 };
 let session;
 try{session=await request('/session/'+job.sessionId);}
 catch(error){
  if(error.status!==404)throw error;
  job.sessionSettled=true;job.sessionMissing=true;
  job.recoveryAction='本任务Session已不存在，继续核对页面交接';return true;
 }
 if(session.id!==job.sessionId||!session.directory)throw Error('会话归属核对失败');
 const query='?directory='+encodeURIComponent(session.directory);
 const stopped=async()=>{
  const status=await request('/session/status'+query);
  if(!status||typeof status!=='object'||Array.isArray(status))throw Error('会话运行状态格式异常');
  return (status[job.sessionId]?.type||'idle')==='idle';
 };
 // After an acknowledged abort, the independent runtime state is the stop
 // proof. A broken permission-list serializer must not keep dead work alive.
 if(job.abortAcknowledged){if(await stopped()){job.sessionSettled=true;return true;}return false;}
 const state=async()=>{
  const [status,permissions,questions]=await Promise.all(['/session/status','/permission','/question'].map(r=>request(r+query)));
  if(!Array.isArray(permissions)||!Array.isArray(questions))throw Error('会话交互数据格式异常');
  return (status[job.sessionId]?.type||'idle')==='idle'&&![...permissions,...questions].some(q=>q.sessionID===job.sessionId);
 };
 let idle=false;
 try{idle=await state();}catch(e){if(!allowAbort||!e.patchPermissionError)throw e;}
 if(idle){
  if(job.abortAcknowledged){job.sessionSettled=true;return true;}
  const messages=await request('/session/'+job.sessionId+'/message'+query);
  const last=messages.at(-1);
  if(last?.info?.role==='assistant'&&(last.info.error||last.info.time?.completed&&last.info.finish&&last.info.finish!=='tool-calls')){
   job.sessionSettled=true;return true;
  }
 }
 if(!allowAbort||job.recoveryAbortAttempted)return false;
 job.recoveryAbortAttempted=true;
 if(await request('/session/'+job.sessionId+'/abort'+query,'POST')!==true)throw Error('客户端未确认停止本会话');
 job.abortAcknowledged=true;
 for(let i=0;i<10;i++){
  if(await stopped()){job.sessionSettled=true;job.recoveryAction='已停止本条关联会话并确认空闲；原用例结果不变';return true;}
  await delay(300);
 }
 return false;
}

export async function recoverJobPage(page,job,{connection,allowAbort=false,otherManagedSession=false}={}){
 await adoptOwnedSession(page,job);
 confirmFailedBeforeSession(job);
 if(!await settleSession(page,job,connection,{allowAbort}))return {ready:false,reason:job.submissionPending&&!job.sessionId?'发送已尝试但Session归属未确认，暂停后续任务':'本条会话尚未确认结束'};
 const failure=await restoreFailedSubmissionPage(page,job);
 if(!failure.ready)return failure;
 let handoff=await inspectPageHandoff(page,{owned:job.ownedDraft,allowRunning:otherManagedSession,stepInterval:job.config?.stepInterval});
 // Some clients leave the permission card rendered after an acknowledged
 // abort. Only leave that exact, independently confirmed stopped session.
 // Never click its stale approval or navigate away from a user draft/modal.
 const staleApproval=handoff.reason==='当前页面仍有运行任务或交互'&&(job.abortAcknowledged||job.sessionMissing)&&job.sessionSettled;
 const ownSelection=handoff.reason==='输入区仍有专家或团队选择，不能交接'&&job.submittedSelection?.length&&(job.modelCompleted||job.sessionSettled);
 if(!handoff.ready&&(staleApproval||ownSelection)&&page.url().endsWith('/session/'+job.sessionId)){
  await waitStep(page,job.config||{});
  const clean=await inspectPageHandoff(page,{allowRunning:staleApproval,allowedSelection:job.submittedSelection||[]});
  if(clean.ready){
   const button=page.getByRole('button',{name:'新建任务',exact:true}).filter({visible:true});
   if(await button.count()===1){await button.click({timeout:3000});await page.waitForURL(url=>!url.toString().endsWith('/session/'+job.sessionId),{timeout:5000});handoff=await inspectPageHandoff(page);job.recoveryAction=ownSelection?'确认本会话完成后退出本次专家选择页面，未更改其他会话':'确认本会话停止后退出残留审批页面，未点击旧审批';}
  }
 }
 return {...handoff,url:page.url()};
}
export async function recoverJob(job,{connection,allowAbort=false,jobs=[],checkpoint=async()=>{}}={}){
 if(job.rootSessionVersion===1){
  const {settleRootSessions}=await import('./root-session-recovery.mjs');
  return settleRootSessions(job,{runtimes:connection instanceof Map?connection:new Map(),allowAbort,checkpoint});
 }

 const browser=await connectClient('http://127.0.0.1:'+job.config.cdpPort,{timeout:5000,clientEdition:job.config.clientEdition});
 try{
  const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
  if(pages.length!==1)throw Error('未找到唯一客户端主界面');
  const page=pages[0],otherManagedSession=jobs.some(j=>j.id!==job.id&&j.status==='RUNNING'&&j.sessionUrl===page.url());
  page.setDefaultTimeout(5000);
  return await recoverJobPage(page,job,{connection,allowAbort,otherManagedSession});
 }finally{await browser.close();}
}
