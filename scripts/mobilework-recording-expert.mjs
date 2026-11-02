import fs from 'node:fs/promises';
import path from 'node:path';
import {readExpertCatalog,releaseExpertResources,waitForExpertInstall} from './mobilework-expert-resources.mjs';
import {openExpertWorkspace,searchMarketCard,readExpertSummonPrompt} from './mobilework-market-ui.mjs';
import {snapshotDraft,clearOwnedDraft,clearSubmittedSelection} from './mobilework-isolation.mjs';
import {settleSession} from '../local-console/task-recovery.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';
import {inspectModuleHandoff} from './mobilework-module-handoff.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

// The caller supplies the actual recording scenario; installation and draft
// ownership share the same scheduler checkpoints as the existing expert cases.
export async function withMarketExpert(context,targetName,run){
 const {page,config,control,resources,checkpointPage,checkpointResources,checkpointExpertResources,getOwnedDraft,capture,log,dir}=context;
 const catalog=await readExpertCatalog(page),matching=catalog.filter(e=>e.name===targetName);
 if(matching.length>1)throw blocked(targetName+'目录不唯一，未选择不确定目标');
 const owned={installedBefore:catalog.map(e=>e.id),recentBefore:await page.evaluate(()=>localStorage.getItem('mobilework.recentExperts')),touchedNames:[targetName],installTarget:'',installPending:false,workspaceId:page.url().match(/\/workspace\/([^/]+)/)[1],summonTarget:''};
 const checkpoint=()=>checkpointExpertResources(owned);
 const acceptSummon=async()=>{
  const draft=await inspectModuleHandoff(page,resources);
  if(!draft)throw blocked('专家召唤未匹配登记交接，保留归属');
  const {moduleNavigation,...nextResources}=resources;
  await checkpointPage(draft,{composerResources:{...nextResources,url:draft.url},expertResources:{...owned,summonTarget:''}});
  delete resources.moduleNavigation;owned.summonTarget='';return draft;
 };
 let failure,submittedSelection;
 await checkpoint();
 try{
  await openExpertWorkspace(context,{section:'专家',targetHash:'#/experts/experts',handoff:{kind:'expert',value:targetName,workspaceId:owned.workspaceId}});
  const target=await searchMarketCard(page,targetName);await target.hover();await capture(targetName+'市场入口');
  if(!matching.length){
   owned.installTarget=targetName;owned.installPending=true;await checkpoint();
   await target.getByRole('button',{name:'召唤',exact:true}).click();
   await waitForExpertInstall(page,owned);
   owned.installPending=false;await checkpoint();await capture(targetName+'实际安装完成');
  }
  const prompt=await readExpertSummonPrompt(target,targetName);
  await fs.writeFile(path.join(dir,'专家召唤预填依据.json'),JSON.stringify({...prompt,note:'依据当前市场卡preset及正常资产详情解析产品预填；安装包expert.json的default_prompt/quick_prompts不等同于此调用的camelCase字段。'},null,2));
  resources.moduleNavigation.handoff.expectedText=prompt.expectedText;await checkpointResources();
  owned.summonTarget=targetName;await checkpoint();
  await target.hover();await target.locator('button[aria-label="召唤"]:not([aria-busy="true"]):not([disabled])').click();
  await page.waitForURL(url=>url.hash==='#/session'||url.hash==='#/workspace/'+owned.workspaceId+'/session',{timeout:60000,waitUntil:'commit'});
  const draft=await acceptSummon();
  submittedSelection=draft.selection;
  await capture('本轮'+targetName+'已召唤');
  await run({catalog:await readExpertCatalog(page),draft,installedByRun:Boolean(owned.installTarget)});
 }catch(error){failure=error;await capture(targetName+'异常现场').catch(e=>log('异常截图失败',e.message));}
 finally{
  try{
   await context.settleOwnedRecording?.();
   if(owned.installPending){await waitForExpertInstall(page,owned);owned.installPending=false;await checkpoint();}
   if(owned.summonTarget)await acceptSummon();
   if(!owned.summonTarget){
    if(control.sessionId&&page.url()===control.sessionUrl&&!await settleSession(page,{sessionId:control.sessionId}))throw blocked('专家所属会话仍未结束，保留专家资源');
    await restoreModuleNavigation(page,resources);
    const draft=await snapshotDraft(page);
    if(draft.text||draft.skills.length||draft.selection.length){
     let cleared=await clearOwnedDraft(page,getOwnedDraft(),config);
     if(!cleared&&control.sessionId&&await settleSession(page,{sessionId:control.sessionId}))cleared=await clearSubmittedSelection(page,{sessionId:control.sessionId,sessionUrl:control.sessionUrl,selection:submittedSelection},config);
     if(!cleared)throw blocked('本轮'+targetName+'草稿与预登记内容不符，保留现场');
     await checkpointPage();
    }
   }
   await releaseExpertResources(page,owned,{draft:getOwnedDraft(),config,checkpoint});await checkpointExpertResources(null);
   await checkpointPage();
  }catch(error){log(targetName+'收尾未完成',error.message);if(failure)failure.message+='；收尾：'+error.message;else failure=error;}
 }
 if(failure)throw failure;
}

export const withRecordingExpert=(context,run)=>withMarketExpert(context,'流程录制专家',run);
