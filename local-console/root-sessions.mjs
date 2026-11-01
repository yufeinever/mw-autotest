import path from 'node:path';
import {normalizeComposerText} from '../scripts/mobilework-composer.mjs';

export {isRootSessionJob,hasUnresolvedRoots} from './root-session-state.mjs';
export function isRootOwnedPage(job,url){
 if(job.rootSessions?.some(root=>root.url===url))return true;
 const pending=job.pendingSubmission;if(!pending)return false;
 if(url===pending.originUrl)return true;
 const actual=new URL(url),origin=new URL(pending.originUrl);
 if(actual.origin!==origin.origin||actual.pathname!==origin.pathname||actual.search!==origin.search)return false;
 if(actual.hash==='#/session')return pending.state==='PREPARING'&&pending.preparingPage?.url===url&&pending.preparingPage.workspaceId===pending.workspaceId;
 if(actual.hash==='#/explore')return pending.resources?.moduleNavigation?.originUrl===pending.originUrl&&pending.resources.moduleNavigation.targetHash==='#/explore';
 const id=actual.hash.match(/^#\/workspace\/([^/]+)\/session\/(ses_[A-Za-z0-9]+)$/);
 return Boolean(pending.state==='SUBMITTING'&&id&&id[1]===pending.workspaceId&&!pending.beforeSessionIds.includes(id[2]));
}
export const rootSession=(job,key)=>{
 const root=job.rootSessions?.find(root=>root.key===key);
 if(!root)throw Error('本用例未登记根任务：'+key);
 return root;
};
export const allRootsCompleted=job=>!job.pendingSubmission&&job.expectedRootKeys.every(key=>job.rootSessions.some(root=>root.key===key&&root.modelCompleted));
export const allRootsSettled=job=>!job.pendingSubmission&&job.rootSessions.every(root=>root.modelCompleted||root.sessionSettled);

export function updateRootSummary(job){
 job.modelCompleted=allRootsCompleted(job);job.sessionSettled=allRootsSettled(job);
}

export function checkpointRootSubmission(job,submission){
 if(!['A','B'].includes(submission.key)||typeof submission.id!=='string'||!submission.id||!['PREPARING','PREPARED','SUBMITTING'].includes(submission.state))throw Error('根任务提交身份或阶段无效');
 const {draft,source}=submission;
 if(typeof submission.workspaceId!=='string'||!submission.workspaceId||typeof submission.originUrl!=='string'||typeof submission.expectedPrompt!=='string'||!submission.expectedPrompt)throw Error('案例根任务缺少原空间或原始提示词');
 if(submission.state==='PREPARING'&&draft!==null)throw Error('尚未观察到预填时不得合成草稿');
 if(submission.state!=='PREPARING'&&(!draft||draft.url!==submission.originUrl||typeof draft.text!=='string'||normalizeComposerText(draft.text)!==normalizeComposerText(submission.expectedPrompt)||!Array.isArray(draft.skills)||draft.skills.length||!Array.isArray(draft.selection)||draft.selection.length))throw Error('案例根任务缺少完整且无额外选择的真实预填');
 if(source?.kind!=='case-library'||typeof source.assetId!=='string'||!source.assetId||typeof source.title!=='string'||!source.title)throw Error('根任务缺少真实案例来源');
 if(new URL(submission.originUrl).hash!=='#/workspace/'+submission.workspaceId+'/session')throw Error('根任务提交原空间地址不符');
 if(!Array.isArray(submission.beforeSessionIds)||submission.beforeSessionIds.some(id=>!/^ses_[A-Za-z0-9]+$/.test(id)))throw Error('提交前会话基线无效');
 if(typeof submission.suspended!=='boolean'||submission.restoreDraft!==undefined&&typeof submission.restoreDraft!=='boolean')throw Error('根任务准备交接状态无效');
 if(submission.preparingPage){
  const entry=submission.preparingPage,current=new URL(entry.url),origin=new URL(submission.originUrl),d=entry.draft;
  if(entry.workspaceId!==submission.workspaceId||current.origin!==origin.origin||current.pathname!==origin.pathname||current.search!==origin.search||current.hash!=='#/session'||!d||d.url!==entry.url||d.text!==''||!Array.isArray(d.skills)||d.skills.length||!Array.isArray(d.selection)||d.selection.length)throw Error('新建任务入口缺原空间选择及真实空草稿核对');
 }
 if(submission.resumeUrl&&submission.resumeUrl!==submission.originUrl){const resume=new URL(submission.resumeUrl),origin=new URL(submission.originUrl);if(resume.origin!==origin.origin||resume.pathname!==origin.pathname||resume.search!==origin.search||!['#/explore','#/session'].includes(resume.hash)||resume.hash==='#/session'&&submission.preparingPage?.url!==submission.resumeUrl)throw Error('根任务准备恢复地址无效');}
 if(job.rootSessions?.some(root=>root.key===submission.key))throw Error('已提交根任务不得重新提交');
 const previous=job.pendingSubmission;
 if(previous){
  for(const key of ['id','key','workspaceId','originUrl'])if(previous[key]!==submission[key])throw Error('不得覆盖尚未确认的另一项提交');
  for(const key of ['source','expectedPrompt','beforeSessionIds'])if(JSON.stringify(previous[key])!==JSON.stringify(submission[key]))throw Error('不得替换已登记根任务提交来源');
  if(previous.draft&&JSON.stringify(previous.draft)!==JSON.stringify(draft))throw Error('不得替换已观察到的真实预填');
  if(['PREPARING','PREPARED','SUBMITTING'].indexOf(submission.state)<['PREPARING','PREPARED','SUBMITTING'].indexOf(previous.state))throw Error('根任务提交阶段不能倒退');
 }
 job.pendingSubmission={...previous,...structuredClone(submission)};job.pageTarget={kind:'preparing',key:submission.key};
 updateRootSummary(job);
}

export function registerRootSession(job,record){
 const pending=job.pendingSubmission;
 if(!pending||pending.state!=='SUBMITTING'||pending.id!==record.submissionId||pending.key!==record.key)throw Error('根任务登记缺少对应的真实提交');
 if(!/^ses_[A-Za-z0-9]+$/.test(record.id)||pending.beforeSessionIds.includes(record.id)||job.rootSessions.some(root=>root.id===record.id))throw Error('根任务不是本次新建的独立Session');
 const actual=new URL(record.url),origin=new URL(pending.originUrl);
 if(actual.origin!==origin.origin||actual.pathname!==origin.pathname||actual.search!==origin.search||actual.hash!=='#/workspace/'+pending.workspaceId+'/session/'+record.id||!path.isAbsolute(record.directory))throw Error('根任务URL、空间或真实任务目录不符');
 if(job.rootSessions.some(root=>path.resolve(root.directory)===path.resolve(record.directory)))throw Error('独立根任务不得共用实际任务目录');
 if(typeof record.firstUserMessageId!=='string'||!record.firstUserMessageId||record.evidence!=='任务-'+record.key)throw Error('根任务缺真实用户消息边界或独立证据目录');
 const resources=structuredClone(record.resources||{url:record.url,attachments:[],queueTexts:[],restorePermission:false});
 if(resources.url!==record.url||!Array.isArray(resources.attachments)||!Array.isArray(resources.queueTexts)||resources.workspaceResources||resources.homeModel)throw Error('根任务页面资源不得包含共享空间或模型基线');
 const root={key:record.key,id:record.id,url:record.url,directory:record.directory,workspaceId:pending.workspaceId,
  submissionId:pending.id,submittedText:pending.draft.text,firstUserMessageId:record.firstUserMessageId,source:pending.source,evidence:record.evidence,
  submittedAt:pending.submittedAt,modelCompleted:false,sessionSettled:false,cleanupComplete:false,resources};
 job.rootSessions.push(root);delete job.pendingSubmission;job.sessionId=root.id;job.sessionUrl=root.url;
 if(job.composerResources){job.composerResources.url=root.url;for(const key of ['caseTask','caseReplay','moduleNavigation'])delete job.composerResources[key];}
 job.pageTarget={kind:'root',key:root.key};job.submissionPending=false;delete job.ownedDraft;
 updateRootSummary(job);return root;
}

export function rootJobView(job,root){
 return {...job,rootSessionVersion:undefined,rootSessions:undefined,pendingSubmission:undefined,result:undefined,
  sessionId:root.id,sessionUrl:root.url,sessionDirectory:root.directory,modelCompleted:root.modelCompleted,sessionSettled:root.sessionSettled,
  abortAcknowledged:root.abortAcknowledged,sessionMissing:root.sessionMissing,recoveryAbortAttempted:root.recoveryAbortAttempted,
  ownedDraft:undefined,submissionPending:false,composerResources:root.resources};
}

export function commitRootView(root,view){
 for(const key of ['sessionSettled','abortAcknowledged','sessionMissing','recoveryAbortAttempted','recoveryAction'])if(view[key]!==undefined)root[key]=view[key];
 if(view.composerResources)root.resources=view.composerResources;else delete root.resources;
 if(root.sessionMissing&&root.sessionSettled&&root.resources?.url===root.url.slice(0,-('/'+root.id).length))root.cleanupUrl=root.resources.url;
}
