import {readExpertCatalog,releaseExpertResources} from './mobilework-expert-resources.mjs';
import {openExpertWorkspace,searchMarketCard} from './mobilework-market-ui.mjs';
import {snapshotDraft,clearOwnedDraft} from './mobilework-isolation.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';
import {inspectModuleHandoff} from './mobilework-module-handoff.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

// The caller supplies the actual recording scenario; installation and draft
// ownership share the same scheduler checkpoints as the existing expert cases.
export async function withMarketExpert(context,targetName,run){
 const {page,control,resources,checkpointPage,capture,log}=context;
 const catalog=await readExpertCatalog(page),matching=catalog.filter(e=>e.name===targetName);
 if(matching.length>1)throw blocked(targetName+'目录不唯一，未选择不确定目标');
 const owned={installedBefore:catalog.map(e=>e.id),recentBefore:await page.evaluate(()=>localStorage.getItem('mobilework.recentExperts')),touchedNames:[targetName],installTarget:'',installPending:false,workspaceId:page.url().match(/\/workspace\/([^/]+)/)[1],summonTarget:''};
 const checkpoint=()=>control.call('checkpoint',{expertResources:owned});
 let failure;
 await checkpoint();
 try{
  await openExpertWorkspace(context,{section:'专家',targetHash:'#/experts/experts',handoff:{kind:'expert',value:targetName,workspaceId:owned.workspaceId}});
  const target=await searchMarketCard(page,targetName);await target.hover();await capture(targetName+'市场入口');
  if(!matching.length){
   owned.installTarget=targetName;owned.installPending=true;await checkpoint();
   await target.getByRole('button',{name:'召唤',exact:true}).click();
   const deadline=Date.now()+90000;let installed;
   while(Date.now()<deadline){
    installed=(await readExpertCatalog(page)).find(e=>e.name===targetName&&!owned.installedBefore.includes(e.id));
    if(installed)break;
    await page.waitForTimeout(500);
   }
   if(!installed)throw blocked(targetName+'市场安装未结束，保留安装归属，不重复点击');
   await target.getByText('已安装',{exact:true}).waitFor();
   owned.installPending=false;await checkpoint();await capture(targetName+'实际安装完成');
  }
  owned.summonTarget=targetName;await checkpoint();
  await target.hover();await target.locator('button[aria-label="召唤"]:not([aria-busy="true"]):not([disabled])').click();
  await page.waitForURL(url=>url.hash==='#/session'||url.hash==='#/workspace/'+owned.workspaceId+'/session',{timeout:60000,waitUntil:'commit'});
  const draft=await inspectModuleHandoff(page,resources);
  if(!draft)throw blocked('专家召唤未匹配登记交接');
  if(draft.selection.length!==1||draft.selection[0].exit!=='退出「'+targetName+'」')throw blocked(targetName+'召唤后未唯一匹配当前输入区选择');
  delete resources.moduleNavigation;await checkpointPage(draft);
  owned.summonTarget='';await checkpoint();
  await capture('本轮'+targetName+'已召唤');
  await run({catalog:await readExpertCatalog(page),draft,installedByRun:Boolean(owned.installTarget)});
 }catch(error){failure=error;await capture(targetName+'异常现场').catch(e=>log('异常截图失败',e.message));}
 finally{
  try{
   if(owned.summonTarget){
    const draft=await inspectModuleHandoff(page,resources);
    if(!draft)throw blocked('本轮专家召唤仍未交接，保留归属');
    delete resources.moduleNavigation;await checkpointPage(draft);
    owned.summonTarget='';await checkpoint();
   }
   if(!owned.summonTarget){
    await restoreModuleNavigation(page,resources);
    const draft=await snapshotDraft(page);
    if(draft.selection.length===1&&draft.selection[0].exit==='退出「'+targetName+'」'){
     await control.checkpointDraft(draft);
     if(!await clearOwnedDraft(page,draft))throw blocked('本轮'+targetName+'草稿收尾未确认');
    }
   }
   await releaseExpertResources(page,owned);await control.call('checkpoint',{expertResources:null});
   await checkpointPage();
  }catch(error){log(targetName+'收尾未完成',error.message);if(failure)failure.message+='；收尾：'+error.message;else failure=error;}
 }
 if(failure)throw failure;
}

export const withRecordingExpert=(context,run)=>withMarketExpert(context,'流程录制专家',run);
