import fs from 'node:fs/promises';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {snapshotDraft,editorOf} from './mobilework-isolation.mjs';
import {reloadOwnedModule} from './mobilework-module-navigation.mjs';
import {normalizeComposerText} from './mobilework-composer.mjs';
import {selectModel} from './mobilework-run-policy.mjs';
import {readArtifact} from './client-case-checks.mjs';
import {finalAssistantText} from './client-case-runner.mjs';
import {previewTaskFile} from './mobilework-task-ui.mjs';
import {xmlText} from './client-message-display-steps.mjs';
import {runCaseMultiRootSteps} from './client-case-multi-root-steps.mjs';
import {caseCards,caseDialog,plainCaseText,normalizeCaseText,openOwnedCase,readCasePackage,observeCaseReplay,readCaseDetail,readCaseDocument,closeOwnedCaseReplay,readCaseFavorites,favoriteHashes,releaseCaseFavorites,adoptCaseTaskDraft,waitCaseCollection} from './mobilework-case-library.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
const taskTools=data=>data.messages.flatMap(m=>(m.parts||[]).filter(p=>p.type==='tool'));

// Switching a replay tab mounts the message before its full result is painted.
// Return the last actual text on timeout so the failing assertion keeps evidence.
async function readReplayText(message,expected){
 await message.waitFor({timeout:15000});
 const deadline=Date.now()+15000,target=plainCaseText(expected);let text;
 do{
  text=await message.innerText();
  if(plainCaseText(text).includes(target))return text;
  await message.page().waitForTimeout(100);
 }while(Date.now()<deadline);
 return text;
}

// Read mounted React props only to identify the real group/entry. All actions
// below use product controls, and all content checks use displayed DOM text.
function sameReplayValue(actual,expected){
 if(actual===expected)return true;
 if(actual===null||expected===null||typeof actual!=='object'||typeof expected!=='object'||Array.isArray(actual)!==Array.isArray(expected))return false;
 const keys=Object.keys(expected);
 return Object.keys(actual).length===keys.length&&keys.every(key=>Object.hasOwn(actual,key)&&sameReplayValue(actual[key],expected[key]));
}

async function replayGroupIds(group){
 return group.evaluate(node=>{
  let fiber=node[Object.keys(node).find(key=>key.startsWith('__reactFiber$'))];
  while(fiber){
   if(fiber.type?.name==='$er')return (fiber.memoizedProps.items||[]).map(item=>item.message.id);
   fiber=fiber.return;
  }
  return [];
 });
}

// Installed UHe/Wwr/QHe/$se: only an unambiguous packaged name is remapped.
// Ambiguous names remain their exact source URL in the product as well.
function replayPackFile(pack,sourcePath){
 const name=decodeURIComponent(new URL(sourcePath).pathname.split('/').filter(Boolean).at(-1));
 const preferred='result_file/'+name;
 const matches=pack.resourceFiles.includes(preferred)?[preferred]:pack.resourceFiles.filter(file=>file.endsWith('/'+name));
 const resourcePath=matches.length===1?matches[0]:null;
 return {sourcePath,resourcePath,path:resourcePath?new URL(resourcePath.split('/').map(encodeURIComponent).join('/'),pack.resourceBaseUrl).href:sourcePath,mapping:resourcePath?'pack-resource':matches.length?'product-keeps-ambiguous-source':'product-keeps-unmapped-source'};
}

async function inspectReplayFiles(group,pack,tool,record,usedFiles){
 const value=tool.input.output_paths??tool.input.output_path;
 const paths=Array.isArray(value)?value:[value];
 const {controls,entries}=await replayControls(group,'file');
 record.mode='file-card';record.fileCandidates=entries;record.files=[];record.reviewReasons=[];record.missingFields=[];
 for(const sourcePath of paths){
  const file=replayPackFile(pack,sourcePath);record.files.push(file);
  const matches=entries.filter(entry=>entry.path===file.path&&entry.callIds.includes(record.callId)&&!usedFiles.has(entry.path));
  if(matches.length!==1){record.reviewReasons.push('result_file真实文件入口缺失或不唯一：'+sourcePath);continue;}
  const entry=matches[0],card=controls.nth(entry.index);await card.scrollIntoViewIfNeeded();
  file.text=await card.innerText();file.visible=await card.isVisible();
  const name=decodeURIComponent(new URL(sourcePath).pathname.split('/').filter(Boolean).at(-1));
  if(!file.visible||!plainCaseText(file.text).includes(plainCaseText(name)))record.missingFields.push('文件卡可见文件名：'+sourcePath);
  usedFiles.add(entry.path);
 }
}

// The owner is proved from the real Nir, never from whole-dialog text.
// Renderer-specific checks follow installed Bnr/ynr/knr/xze/Pnr contracts.
async function inspectReplayTool(dialog,sessionId,tool,entry,trigger,record){
 const page=dialog.page(),normalized=value=>String(value).replace(/\s+/g,'');
 record.callId=entry.callId;record.entryLabel=entry.label;record.mode='tool-detail';
 record.reviewReasons=[];record.missingFields=[];record.notDisplayed=[];
 await trigger.scrollIntoViewIfNeeded();await trigger.click();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const detail=await replayDetail(dialog,sessionId,entry.callId);
 if(!detail||!await detail.isVisible())record.reviewReasons.push('点击后未取得本Session、本toolCallId的唯一可见详情：'+entry.callId);
 else{
  const text=await detail.innerText();record.text=text;
  const input=tool.input||{},output=typeof tool.output==='string'?tool.output:JSON.stringify(tool.output??'');
  const field=(key,value)=>{if(value!==undefined&&!normalized(text).includes(normalized(value)))record.missingFields.push(key);};
  if(tool.name==='create_subagent'){
   for(const key of ['name','role','motto'])field('input.'+key,input[key]);
   record.notDisplayed=['input.id','output'];
  }else if(tool.name==='read'){
   const result=(/<content>([\s\S]*?)<\/content>/.exec(output)?.[1]??output).trim();
   field('output.content',result);record.notDisplayed=Object.keys(input).map(key=>'input.'+key);
  }else if(tool.name==='edit'){
   for(const key of ['filePath','oldString','newString'])field('input.'+key,input[key]);
   record.notDisplayed=['output',...Object.keys(input).filter(key=>!['filePath','oldString','newString'].includes(key)).map(key=>'input.'+key)];
  }else if(tool.name==='grep'||tool.name==='glob'){
   field('input.pattern',input.pattern);field('input.path',input.path);field('output',output);
   record.notDisplayed=Object.keys(input).filter(key=>!['pattern','path'].includes(key)).map(key=>'input.'+key);
  }else{
   const parameters=detail.getByText('输入',{exact:true}).locator('xpath=..').locator(':scope > pre').filter({visible:true});
   if(await parameters.count()!==1)record.reviewReasons.push('当前工具详情未展示唯一输入块：'+entry.callId);
   else{
    record.displayedInput=JSON.parse(await parameters.innerText());
    if(!sameReplayValue(record.displayedInput,input))record.missingFields.push('input');
   }
   if(output)field('output',output);
  }
 }
 const closed=await closeReplayTool(dialog);record.detailClosed=closed===1;
 if(closed!==1)record.unavailable='工具详情没有唯一正常关闭入口，后续未继续观察';
}


async function replayControls(scope,kind){
 const selector=kind==='file'?'div.cursor-pointer[data-slot="tooltip-trigger"]':'button';
 const controls=scope.locator(selector);
 const entries=await controls.evaluateAll((nodes,kind)=>nodes.flatMap((node,index)=>{
  let fiber=node[Object.keys(node).find(key=>key.startsWith('__reactFiber$'))];
  if(kind==='cluster'){
   // x7t returns this button directly. Component identity is stable; its
   // memoizedProps.expanded on a cached/alternate fiber is not DOM state.
   if(fiber?.type!=='button'||fiber.stateNode!==node||fiber.return?.type?.name!=='x7t')return [];
   const content=node.nextElementSibling;
   const known=!content||content.tagName==='DIV'&&content.classList.contains('space-y-2')&&content.classList.contains('pl-[19px]');
   const mounted=Boolean(content),visible=Boolean(content&&content.getClientRects().length&&getComputedStyle(content).visibility!=='hidden');
   return [{index,label:node.innerText,state:!known?'unknown':!mounted?'collapsed':visible?'expanded':'hidden',contentMounted:mounted,contentVisible:visible}];
  }
  while(fiber){
   const name=fiber.type?.name,props=fiber.memoizedProps;
   if(kind==='tool'&&name==='DH')return [{index,callId:props.part.toolCallId,name:props.part.toolName,input:props.part.input,label:node.innerText}];
   if(kind==='file'&&name==='oQ'){
    const path=props.path;let owner=fiber.return;
    while(owner&&owner.type?.name!=='$er'){
     if(owner.type?.name==='Uer'){
      const rows=owner.memoizedProps.rows.filter(row=>row.kind==='file'&&row.path===path);
      return [{index,path,label:node.innerText,callIds:rows.map(row=>row.sourcePart.toolCallId),sourceStepIndices:rows.map(row=>row.sourceStepIndex)}];
     }
     owner=owner.return;
    }
    return [];
   }
   // Never attribute a feedback/outer group button to a different entry.
   if(name==='$er')break;
   fiber=fiber.return;
  }
  return [];
 }),kind);
 return {controls,entries};
}

async function openReplayClusters(group,observations){
 for(;;){
  const {controls,entries}=await replayControls(group,'cluster');
  const unknown=entries.find(entry=>!['collapsed','expanded'].includes(entry.state));
  if(unknown){observations.push({observed:unknown});return '真实工具簇内容DOM状态不可确认：'+unknown.label;}
  const closed=entries.find(entry=>entry.state==='collapsed');
  if(!closed)observations.push({observed:entries});
  if(!closed)return null;
  const trigger=controls.nth(closed.index);
  await trigger.scrollIntoViewIfNeeded();await trigger.click();
  const after=await replayControls(group,'cluster');
  const current=after.entries.find(entry=>entry.index===closed.index);
  observations.push({before:closed,after:current||null});
  if(current?.state!=='expanded')return '真实工具簇点击后内容DOM未展开：'+closed.label;
 }
}

async function replayDetail(dialog,sessionId,callId){
 const roots=dialog.locator('aside div');
 const indices=await roots.evaluateAll((nodes,{sessionId,callId})=>nodes.flatMap((element,index)=>{
  // Installed Nir directly returns <div><Bnr .../></div> when its tool
  // exists. Identify that actual host and its owner, not a descendant's
  // nearest Nir ancestor or an assumed composite child.stateNode.
  const host=element[Object.keys(element).find(key=>key.startsWith('__reactFiber$'))],owner=host?.return;
  return host?.type==='div'&&host.stateNode===element&&owner?.type?.name==='Nir'&&owner.memoizedProps.sessionId===sessionId&&owner.memoizedProps.toolCallId===callId?[index]:[];
 }),{sessionId,callId});
 return indices.length===1?roots.nth(indices[0]):null;
}

async function closeReplayTool(dialog){
 const close=button(dialog,'关闭侧边栏').filter({visible:true}),count=await close.count();
 if(count===1){await close.click();await close.waitFor({state:'hidden'});}
 return count;
}

export async function verifyReplayMain(dialog,pack){
 const turns=pack.caseJson.turns,sessionId=pack.caseJson.case.sessionId,page=dialog.page();
 const details=turns.map((turn,index)=>({index:index+1,id:sessionId+'_m'+(index+1),role:turn.role,missingText:false,missingTools:[],reviewReasons:[],tools:[]}));
 const finalize=()=>details.map(item=>({...item,status:item.reviewReasons.length?'REVIEW':item.missingText||item.missingTools.length?'FAIL':'PASS'}));
 const unavailable=reason=>details.map(item=>({...item,status:'REVIEW',reviewReasons:[...item.reviewReasons,reason]}));
 // Shipped ybr sets role="dialog", aria-modal=true, aria-label=e.title
 // directly. This attribute contract comes from its source, not getByRole.
 if(await dialog.count()!==1||await dialog.getAttribute('aria-label')!==pack.caseJson.case.title)return unavailable('精确案例dialog与原包标题不一致');
 const mainInput=dialog.locator('[data-message-role="user"][data-message-id="'+sessionId+'_m1"]');
 if(await mainInput.count()!==1||!await mainInput.isVisible())return unavailable('当前显示的不是原包主会话，未接管子任务或其他Session');
 const groups=dialog.locator('div.group\\/message-group'),mapped=[];
 for(let index=0;index<await groups.count();index++)mapped.push({index,ids:await replayGroupIds(groups.nth(index))});
 const usedCalls=new Set(),usedFiles=new Set(),offsets=new Map();
 for(const item of details){
  const turn=turns[item.index-1];let scope,key,group;
  if(turn.role==='user'){
   scope=dialog.locator('[data-message-role="user"][data-message-id="'+item.id+'"]');key=item.id;
   if(await scope.count()!==1){item.reviewReasons.push('源user消息没有唯一真实容器');continue;}
   item.mapping={kind:'message',messageId:item.id};
  }else{
   const matches=mapped.filter(entry=>entry.ids.includes(item.id));
   if(matches.length!==1){item.reviewReasons.push('源assistant turn没有唯一实际合并组');continue;}
   const actual=matches[0];group=groups.nth(actual.index);
   item.mapping={kind:'assistant-group',groupIndex:actual.index,sourceMessageIds:actual.ids};
   if(actual.ids.some(id=>!details.some(source=>source.id===id))){item.reviewReasons.push('实际分组混有不属于当前原包的消息');continue;}
   const processExpand=button(group,'展开执行过程');
   if(await processExpand.count()===1){
    if(await processExpand.getAttribute('aria-expanded')!=='false'){item.reviewReasons.push('过程开关状态不可确认');continue;}
    await processExpand.scrollIntoViewIfNeeded();await processExpand.click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   }
   const clusterObservations=[];item.mapping.clusters=clusterObservations;
   const clusterIssue=await openReplayClusters(group,clusterObservations);
   if(clusterIssue){item.reviewReasons.push(clusterIssue);continue;}
   const own=group.locator('[data-message-role="assistant"][data-message-id="'+item.id+'"]');
   if(await own.count()===1&&await own.isVisible()){
    scope=own;key=item.id;item.mapping.area='message';
   }else{
    const expand=button(group,'展开执行过程'),collapse=button(group,'收起执行过程');
    if(await expand.count()===1){
     if(await expand.getAttribute('aria-expanded')!=='false'){item.reviewReasons.push('过程开关状态不可确认');continue;}
     await expand.scrollIntoViewIfNeeded();await expand.click();
    }
    if(await collapse.count()!==1||await collapse.getAttribute('aria-expanded')!=='true'){item.reviewReasons.push('实际过程区未展开');continue;}
    scope=collapse.locator('xpath=../following-sibling::div');
    if(await scope.count()!==1){item.reviewReasons.push('实际展开过程区不唯一');continue;}
    await scope.waitFor({state:'visible'});
    key='group:'+actual.index+':process';item.mapping.area='merged-process';
   }
  }
  // Read only markdown blocks in the selected message/process area. Tool
  // panels, child tabs and the case description cannot satisfy turn text.
  const blocks=turn.role==='user'?[await scope.innerText()]:await scope.locator('.markdown-content').filter({visible:true}).allInnerTexts();
  const text=blocks.join('\n'),normalized=plainCaseText(text),expected=plainCaseText(turn.text||''),start=offsets.get(key)||0;
  const position=expected?normalized.indexOf(expected,start):start;
  item.text=text;item.mapping.textOffset=position;
  item.missingText=Boolean(expected&&position<0);
  if(position>=0)offsets.set(key,position+expected.length);
  if(!turn.tools?.length)continue;
  for(const [toolIndex,tool] of turn.tools.entries()){
   const record={index:toolIndex+1,name:tool.name};item.tools.push(record);
   record.callId=item.id+'_call'+(toolIndex+1);
   if(tool.name==='result_file'){
    await inspectReplayFiles(group,pack,tool,record,usedFiles);
    item.reviewReasons.push(...record.reviewReasons);
    if(record.reviewReasons.length||record.missingFields.length)item.missingTools.push(tool.name);
    continue;
   }
   const {controls,entries}=await replayControls(scope,'tool');
   const matches=entries.filter(entry=>entry.callId===record.callId&&entry.name===tool.name&&sameReplayValue(entry.input||{},tool.input||{})&&!usedCalls.has(entry.callId));
   if(matches.length!==1){item.reviewReasons.push('真实工具详情入口缺失或不唯一：'+tool.name+' turn '+item.index);item.missingTools.push(tool.name);continue;}
   const entry=matches[0];await inspectReplayTool(dialog,sessionId,tool,entry,controls.nth(entry.index),record);
   usedCalls.add(entry.callId);item.reviewReasons.push(...record.reviewReasons);
   if(record.reviewReasons.length||record.missingFields.length)item.missingTools.push(tool.name);
   if(record.unavailable)return unavailable(record.unavailable);
  }
 }
 return finalize();
}

async function verifyCaseFile(context,dialog,pack,{compare}={}){
 const {page,dir,assert,capture}=context;
 const filePath=pack.resourceFiles.find(name=>name.endsWith('/compliance-review-report.docx'));
 if(!filePath)throw blocked('当前医疗案例包缺少最终Word资源，未替换产物');
 const name=path.basename(filePath),url=new URL(filePath.split('/').map(encodeURIComponent).join('/'),pack.resourceBaseUrl).href;
 const actual=await readCaseDocument(page,url);await fs.writeFile(path.join(dir,name),actual.bytes);
 const card=dialog.locator('div.cursor-pointer[data-slot="tooltip-trigger"]').filter({has:page.getByText(name,{exact:true})});
 await card.click();const host=dialog.locator('aside').filter({has:page.locator('.mw-docx-host')}).locator('.mw-docx-host');
 await host.getByText(actual.facts[0],{exact:false}).first().waitFor({timeout:60000});const text=await host.innerText();
 await fs.writeFile(path.join(dir,'最终报告预览正文.txt'),text);
 assert('回放最终报告真实预览对应原文件首中末段',actual.facts.every(fact=>normalizeCaseText(text).includes(normalizeCaseText(fact))),actual.facts);
 if(compare)assert('从头回放产物与原案例效果文档正文一致',normalizeCaseText(actual.paragraphs.join('\n'))===normalizeCaseText(compare.paragraphs.join('\n')));
 await capture('回放最终报告正文核对');return actual;
}

export async function runCaseLibraryTaskSteps(context,items){
 const {number,page,resources,dir,remaining,assert,capture,checkpointResources,checkpointPage,send,config,control,getData,getSessionId,outputs,definition}=context;
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)),finish=step=>remaining.delete(step);
 if(number===112)return runCaseMultiRootSteps(context,items,{verifyMedicalReport:verifyLiveReport});
 if(number===108){
  const before=await readCaseFavorites(page),beforeCount=Object.values(before.value).filter(v=>v?.favorite).length;
  const targets=items.filter(item=>!Object.hasOwn(before.value,item.id)&&items.filter(other=>other.title===item.title).length===1).slice(0,5);
  if(targets.length!==5)throw blocked('当前没有5个从未登记且标题唯一的目标案例，保留已有收藏');
  // Count the real Favorites view before mutation, including expired entries.
  await button(page,'我的收藏').click();
  await page.waitForFunction(count=>document.querySelectorAll('.mw-case-card').length===count,beforeCount,{timeout:60000});
  assert('收藏前实际列表数量与账号登记一致',await caseCards(page).count()===beforeCount,beforeCount);await capture('收藏前列表基线');
  await button(page,'返回').click();await waitCaseCollection(page,items);
  resources.caseFavorites={accountId:before.accountId,beforeHashes:favoriteHashes(before.value),targets:targets.map(({id,title,category})=>({id,title,category}))};await checkpointResources();
  await save('五个目标及收藏基线.json',{beforeCount,...resources.caseFavorites});finish('五项独立收藏前置及数量');
  for(const target of targets){
   const card=caseCards(page).filter({has:page.getByText(target.title,{exact:true})});
   await card.scrollIntoViewIfNeeded();await button(card,'收藏').click();await button(card,'取消收藏').waitFor();
   await page.waitForFunction(async id=>{const invoke=window.__MOBILEWORK__.invoke,auth=await invoke('auth:current');return (await invoke('store:read',{accountId:auth.account.id,path:'explore/registry.json',fallback:{}})).value[id]?.favorite===true;},target.id);
  }
  finish('五项真实星标及持久化');await capture('五个案例已收藏');
  await button(page,'我的收藏').click();await page.waitForFunction(count=>document.querySelectorAll('.mw-case-card').length===count,beforeCount+5,{timeout:60000});
  for(const target of targets){const card=caseCards(page).filter({has:page.getByText(target.title,{exact:true})});await card.scrollIntoViewIfNeeded();assert('收藏页真实显示目标及已收藏状态：'+target.title,await card.count()===1&&await button(card,'取消收藏').count()===1&&await card.locator('img').getAttribute('alt')===target.title);}
  const after=await readCaseFavorites(page);await save('收藏后实际列表与登记.json',{count:await caseCards(page).count(),titles:await caseCards(page).locator('img').evaluateAll(ns=>ns.map(n=>n.alt)),hashes:favoriteHashes(after.value)});
  assert('收藏总数恰好增加五且原有登记不变',Object.values(after.value).filter(v=>v?.favorite).length===beforeCount+5&&Object.entries(resources.caseFavorites.beforeHashes).every(([id,hash])=>favoriteHashes(after.value)[id]===hash));
  finish('我的收藏完整目标及数量');await capture('我的收藏五项及数量');
  await releaseCaseFavorites(page,resources.caseFavorites);delete resources.caseFavorites;await checkpointResources();
  await reloadOwnedModule(page,resources);await button(page,'我的收藏').click();await page.waitForFunction(count=>document.querySelectorAll('.mw-case-card').length===count,beforeCount,{timeout:60000});
  assert('恢复后原收藏数量和原登记保持',JSON.stringify(favoriteHashes((await readCaseFavorites(page)).value))===JSON.stringify(favoriteHashes(before.value)));finish('本轮新增收藏恢复及原有保护');return;
 }
 const title=number===110?'百家企业大规模蜂群对比分析':'医疗健康营销合规审查',targets=items.filter(item=>item.title===title);
 if(targets.length!==1)throw blocked('原表案例未唯一找到：'+title);
 const target=targets[0],pack=await readCasePackage(page,target.assetId),dialog=await openOwnedCase(context,target);
 await save('真实案例回放包.json',pack);finish('本轮真实案例与原包');
 if(number===107||number===110){
  await button(dialog,'案例回放').click();let count=0;
  const replay=await observeCaseReplay(dialog,{timeoutMs:definition.timeoutMs,onObserver:async key=>{resources.caseReplay.observation=key;await checkpointResources();},onSample:async sample=>{
   await fs.appendFile(path.join(dir,'回放逐步采样.jsonl'),JSON.stringify(sample)+'\n');
   if(count++===0)await capture('从头回放初始过程');
  }});await save('回放真实完成与采样.json',replay);
  const details=await verifyReplayMain(dialog,pack);await save('主回放逐轮原包核对.json',details);
  if(details.some(item=>item.status==='REVIEW'))throw review('主回放实际展示存在未确认项，详见主回放逐轮原包核对.json');
  assert('回放真实完成且原包主消息与执行记录完整',replay.endedAt>=replay.startedAt&&details.every(item=>!item.missingText&&item.missingTools.length===0),details.filter(item=>item.missingText||item.missingTools.length));
  // Length must change during this same run; preloaded final content is not a replay.
  const lengths=replay.samples.map(s=>s.messages.reduce((sum,m)=>sum+m.text.length,0));
  assert('从头回放期间实际观察到逐步内容增长',lengths.length>1&&lengths.some(n=>n<lengths.at(-1)),lengths);finish('从头逐步加载及真实终态');finish('主回放完整内容');
  await capture('案例回放真实终态');
  if(number===107){
   const detail=await readCaseDetail(page,target.assetId),value=detail.caseDetail.resultFileDownloadUrl,url=Array.isArray(value)?value[0]:value;
   if(!url)throw blocked('原案例没有效果文档，无法对照回放产物');
   const original=await readCaseDocument(page,url);await fs.writeFile(path.join(dir,'原案例效果报告.docx'),original.bytes);
   await verifyCaseFile(context,dialog,pack,{compare:original});finish('回放产物与原案例文档一致');
  }else await inspectAllReplayChildren(context,dialog,pack);
  await closeOwnedCaseReplay(page,resources);await checkpointResources();finish('只读回放公共收尾');return;
 }
 // Do Same is a real product handoff. Register both possible drafts before
 // clicking/editing so abnormal exit and forced stop use this same ownership.
 const prompt=pack.caseJson.case.prompt?.trim();if(!prompt)throw blocked('原案例缺少做同款提示词');
 const origin=resources.moduleNavigation.originUrl,workspaceId=new URL(origin).hash.match(/^#\/workspace\/([^/]+)\/session$/)?.[1];
 if(!workspaceId)throw blocked('做同款原任务页不是独立空白Session入口');
 resources.caseTask={originUrl:origin,workspaceId,title,assetId:target.assetId,prompt,editedPrompt:null};await checkpointResources();
 await button(dialog,'做同款').click();await page.waitForURL(url=>url.hash==='#/workspace/'+workspaceId+'/session',{timeout:60000});
 const originalDraft=await adoptCaseTaskDraft(page,resources,{finish:false});await checkpointPage(originalDraft);
 assert('做同款真实预填与原案例完整提示词相同',normalizeComposerText(originalDraft.text)===normalizeComposerText(prompt));
 await save('做同款实际原始预填.json',originalDraft);await capture('做同款真实预填');finish('做同款真实跳转与原文预填');
 let submitted=prompt;
 if(number===113){
  submitted=prompt+'\n\n本条用例的交付格式要求：请将上述完整合规审查报告直接生成为可编辑的Word（.docx）文件，并作为真实交付文件供预览和保存。';
  resources.caseTask.editedPrompt=submitted;await checkpointResources();
  await editorOf(page).fill(submitted);const edited=await snapshotDraft(page);await checkpointPage(edited);
  assert('113完整原文保留且Word交付要求实际写入草稿',normalizeComposerText(edited.text)===normalizeComposerText(submitted));
  await save('Word交付要求后的真实预填.json',edited);await capture('113原文追加Word交付格式');finish('Word初版交付格式准备');
 }else if(number===111){
  const split=prompt.indexOf('\n\n机构：');if(split<0)throw blocked('原案例素材结构已变化，未覆盖成无关提示词');
  const head=prompt.slice(0,split),lines=head.split('\n'),experts=lines.filter(line=>/^\d+\.\s*@/.test(line));
  if(experts.length!==5)throw blocked('原案例不是预期五位专家，保留预填等待复核');
  const chosen=experts.slice(0,3);submitted=[lines[0],...chosen,'本次仅由以上3位专家分别通过真实子会话协作；不召唤其他专家，也不要仅在主回复中模拟角色。'].join('\n\n')+prompt.slice(split);
  resources.caseTask.editedPrompt=submitted;await checkpointResources();
  await editorOf(page).fill(submitted);const edited=await snapshotDraft(page);await checkpointPage(edited);
  assert('真实编辑只保留三位专家并保留机构素材及业务约束',normalizeComposerText(edited.text)===normalizeComposerText(submitted)&&edited.text.endsWith(prompt.slice(split))&&!edited.text.includes(experts[3])&&!edited.text.includes(experts[4]));
  await save('三专家修改后的真实预填.json',edited);await capture('做同款减少为三位专家');finish('五专家改三且保留业务素材');
 }
 delete resources.caseTask;await checkpointResources();
 await selectModel(page,config.model||'自动',config);
 await send(submitted,{prefilled:true});finish('原预填真实提交及模型终态');
 const data=getData();
 const roles=number===111?['医疗健康营销合规','医疗客服','内容创作']:['医疗健康营销合规','医疗客服','内容创作','品牌','法务'];
 if(number!==113){
  const children=await control.get('/session/'+getSessionId()+'/children'),parts=taskTools(data),assignments=parts.filter(p=>p.tool==='task'&&p.state?.metadata?.sessionId);
  await save('专家真实分派与子Session.json',{children,assignments});
  const expected=number===111?3:5,childIds=new Set(assignments.map(p=>p.state.metadata.sessionId));
  assert('本轮实际分派'+expected+'位专家独立子会话',children.length===expected&&childIds.size===expected&&children.every(child=>child.parentID===getSessionId()&&childIds.has(child.id)));
  for(const child of children){
   const messages=await control.get('/session/'+child.id+'/message');await save(child.id+'-session-log.json',{session:child,messages});outputs.push({name:'专家会话日志',path:child.id+'-session-log.json'});
   assert('专家子任务实际有完成回复：'+child.id,messages.some(m=>m.info?.role==='assistant'&&m.info.time?.completed&&!m.info.error&&(m.parts||[]).some(p=>p.type==='text'&&p.text.trim())));
  }
  assert('真实分派覆盖原文指定角色职责',roles.every(role=>assignments.some(p=>JSON.stringify(p.state.input).includes(role))),assignments.map(p=>p.state.input));finish('真实专家分派及子Session完成');
 }
 const report=await verifyLiveReport(context,data,roles,number===113?{extension:'.docx'}:{});finish('本轮真实报告正文与业务目标');finish('报告实际预览及保存');await context.saveTrace();
 if(number===113)await runReportFollowups(context,report);
}

async function readLiveWord(context,relative){
 const bytes=await readArtifact(context.control.directory,relative,{binary:true}),entries=unzipSync(bytes),xml=strFromU8(entries['word/document.xml']);
 const paragraphs=[...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map(value=>xmlText(value[0])).filter(value=>value.trim());
 return {relative,bytes,paragraphs,text:paragraphs.join('\n')};
}

async function runReportFollowups(context,initial){
 const {page,dir,control,send,getData,getSessionId,assert,remaining,config,capture,outputs}=context,sessionId=getSessionId();
 if(path.extname(initial.relative).toLowerCase()!=='.docx')throw blocked('原表追问要求Word，初版未生成Word，保留实际报告并等待复核');
 const archive=async(label,document)=>{
  const name=label+'-'+path.basename(document.relative);await fs.writeFile(path.join(dir,name),document.bytes);outputs.push({name:label+'真实Word',path:name});
  await fs.writeFile(path.join(dir,label+'正文.json'),JSON.stringify({relative:document.relative,paragraphs:document.paragraphs},null,2));
  const trace=await context.saveTrace();if(trace.error)throw blocked('追问阶段日志Trace未保存：'+trace.error);
  await fs.copyFile(path.join(dir,'trace.json'),path.join(dir,label+'-trace.json'));
  await fs.copyFile(path.join(dir,sessionId+'-session-log.json'),path.join(dir,label+'-session-log.json'));
 };
 const original=await readLiveWord(context,initial.relative);await archive('初版',original);remaining.delete('独立做同款初版及阶段证据');
 const title='安宁睡眠中心报告文件第一版',target=title+'.docx';
 await send('请修改本任务已生成的Word报告 '+initial.relative+'：将交付文件名改为“'+target+'”，文档内主标题及对应标题字段改为“'+title+'”。保留既有合规分析、素材事实和风险建议，不另建无关报告。',{continuing:true});
 assert('标题修改追问仍属于本条原Session',getSessionId()===sessionId);
 const revised=await readLiveWord(context,target);await archive('改标题后',revised);
 assert('真实Word文件名和文档主标题按追问修改',path.basename(revised.relative)===target&&normalizeCaseText(revised.paragraphs[0])===normalizeCaseText(title));
 assert('标题修改后原机构及素材事实保留',/安宁睡眠/.test(revised.text)&&/99\s*元/.test(revised.text)&&/风险/.test(revised.text));
 await control.acquire(page,'EVIDENCE');await previewTaskFile(page,config,target,capture,[title]);remaining.delete('同Session追问修改真实Word标题');
 await send('继续在本任务的“'+target+'”中增量补充一个明确标注的“产后人群专属客服话术”章节，包含关怀接待、需求了解、风险提示和转诊建议。不要覆盖或重写现有报告内容，保留已改主标题及原合规结论，不作诊断或疗效保证；将新增内容保存到这份Word。',{continuing:true});
 const final=await readLiveWord(context,target);await archive('增量补充后',final);
 assert('增量后原Word全部段落仍保留',revised.paragraphs.every(paragraph=>normalizeCaseText(final.text).includes(normalizeCaseText(paragraph))));
 assert('新增章节有产后客服业务内容及医疗边界',/产后/.test(final.text)&&/客服|话术/.test(final.text)&&/接待|您好|理解|关怀/.test(final.text)&&/转诊|就医|医生/.test(final.text)&&final.paragraphs.length>revised.paragraphs.length);
 await control.acquire(page,'EVIDENCE');await previewTaskFile(page,config,target,capture,['产后']);await capture('Word追问增量内容已保存');
 assert('两次追问与完成记录在同一真实Session',getSessionId()===sessionId&&getData().messages.filter(message=>message.info?.role==='user').length>=3);
 remaining.delete('增量章节与既有内容保留');remaining.delete('三阶段文件日志及真实预览');
}

async function inspectAllReplayChildren(context,dialog,pack){
 const {page,dir,assert,capture,remaining}=context,children=pack.caseJson.turns.flatMap(turn=>turn.subagents||[]),details=[],captured=new Set();
 const main=dialog.locator('.scrollbar-pills button').filter({hasText:'主会话'}),tabs=dialog.locator('.scrollbar-pills button');
 assert('主任务及原包全部子任务入口存在',children.length>1&&await main.count()===1&&await tabs.count()===children.length+1,{expectedChildren:children.length,actualTabs:await tabs.count()});
 await main.hover();await page.waitForFunction(id=>document.getElementById(id)?.getAttribute('aria-describedby'),await main.getAttribute('id'));
 const mainTip=await main.getAttribute('aria-describedby');
 if(!mainTip)throw review('主任务悬停未取得真实tooltip关联');
 await page.locator('[id="'+mainTip+'"]').waitFor();assert('主任务悬停展示说明',(await page.locator('[id="'+mainTip+'"]').innerText()).includes('主会话'));
 for(const [index,child] of children.entries()){
  const tab=tabs.nth(index+1);await tab.scrollIntoViewIfNeeded();
  assert('子任务顺序与原包真实角色及任务对应：'+(index+1),(await tab.innerText()).includes(child.subagentType)&&(await tab.innerText()).includes(child.description));
  await tab.hover();await page.waitForFunction(id=>document.getElementById(id)?.getAttribute('aria-describedby'),await tab.getAttribute('id'));
  const tipId=await tab.getAttribute('aria-describedby');
  if(!tipId)throw review('子任务悬停未取得真实tooltip关联：'+child.description);
  const tip=page.locator('[id="'+tipId+'"]');await tip.waitFor();const tooltip=await tip.innerText();
  assert('专家说明含真实角色和原委派内容：'+(index+1),[child.subagentType,child.description,child.prompt||child.description].every(text=>plainCaseText(tooltip).includes(plainCaseText(text))));
  if(!child.result)throw review('原包子任务缺少结果正文，不能证明切换内容完整：'+child.sessionId);
  await tab.click();const message=dialog.locator('[data-message-id="'+child.sessionId+'_m1"]');
  const text=await readReplayText(message,child.result),toolDetails=[];
  details.push({index:index+1,sessionId:child.sessionId,role:child.subagentType,task:child.description,tooltip,text,tools:toolDetails});
  await fs.writeFile(path.join(dir,'全部子任务实际核对.json'),JSON.stringify(details,null,2));
  assert('切换后为对应子Session实际正文：'+(index+1),plainCaseText(text).includes(plainCaseText(child.result)));
  const groups=dialog.locator('div.group\\/message-group'),mapped=[];
  for(let at=0;at<await groups.count();at++)if((await replayGroupIds(groups.nth(at))).includes(child.sessionId+'_m1'))mapped.push(at);
  if(mapped.length!==1)throw review('子Session没有唯一实际合并组：'+child.sessionId);
  const group=groups.nth(mapped[0]),expand=button(group,'展开执行过程');
  if(await expand.count()===1){
   if(await expand.getAttribute('aria-expanded')!=='false')throw review('子任务过程开关状态不可确认：'+child.sessionId);
   await expand.scrollIntoViewIfNeeded();await expand.click();
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  const clusters=[],clusterIssue=await openReplayClusters(group,clusters);
  details.at(-1).clusters=clusters;
  if(clusterIssue)throw review(clusterIssue);
  const usedFiles=new Set();
  for(const [toolIndex,tool] of (child.tools||[]).entries()){
   const actual={index:toolIndex+1,tool:tool.name,callId:child.sessionId+'_m1_call'+(toolIndex+1)};toolDetails.push(actual);
   if(tool.name==='result_file')await inspectReplayFiles(group,pack,tool,actual,usedFiles);
   else{
    const callId=child.sessionId+'_m1_call'+(toolIndex+1);
    const {controls,entries}=await replayControls(group,'tool');
    const matches=entries.filter(entry=>entry.callId===callId&&entry.name===tool.name&&sameReplayValue(entry.input||{},tool.input||{}));
    actual.candidates=entries;
    if(matches.length!==1)throw review('子任务工具入口未按真实callId、名称和完整输入唯一识别：'+callId);
    const entry=matches[0];await inspectReplayTool(dialog,child.sessionId,tool,entry,controls.nth(entry.index),actual);
   }
   await fs.writeFile(path.join(dir,'全部子任务实际核对.json'),JSON.stringify(details,null,2));
   if(actual.unavailable)throw review(actual.unavailable);
   if(actual.reviewReasons.length)throw review(actual.reviewReasons.join('；'));
   assert('子任务实际可见工具字段与原包相符：'+(index+1)+' '+tool.name,actual.missingFields.length===0,{callId:actual.callId,missingFields:actual.missingFields,notDisplayed:actual.notDisplayed||[]});
  }
  if(!captured.has(child.subagentType)||index===children.length-1){await capture('分任务-'+(index+1)+'-'+child.subagentType);captured.add(child.subagentType);}
  await button(dialog,'返回主会话继续会话').click();
  await dialog.locator('[data-message-id="'+pack.caseJson.case.sessionId+'_m1"]').waitFor();
  assert('分任务返回后主会话正文恢复：'+(index+1),await dialog.locator('[data-message-id="'+child.sessionId+'_m1"]').count()===0);
 }
 remaining.delete('全部子任务真实切换及正文');remaining.delete('各专家悬停说明及工具输入输出');remaining.delete('逐项返回主任务');
}

async function verifyLiveReport(context,data,roles,{extension}={}){
 const {dir,control,page,config,assert,capture,outputs}=context;
 const entries=await fs.readdir(control.directory,{recursive:true,withFileTypes:true});
 const candidates=entries.filter(entry=>entry.isFile()&&(extension?path.extname(entry.name).toLowerCase()===extension:/\.(docx|md|txt|html|pdf)$/i.test(entry.name)&&/审查|合规|报告|compliance|report/i.test(entry.name))).map(entry=>path.relative(control.directory,path.join(entry.parentPath,entry.name)));
 const toolText=JSON.stringify(taskTools(data).filter(p=>p.state?.status==='completed')),records=[];
 for(const relative of candidates){
  const bytes=await readArtifact(control.directory,relative,{binary:true}),ext=path.extname(relative).toLowerCase();let text;
  if(ext==='.docx')text=xmlText(strFromU8(unzipSync(bytes)['word/document.xml']));
  else if(ext==='.pdf'){
   const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});
   try{const pdf=await task.promise,parts=[];for(let i=1;i<=pdf.numPages;i++)parts.push((await (await pdf.getPage(i)).getTextContent()).items.map(p=>p.str).join(' '));text=parts.join('\n');}finally{await task.destroy();}
  }else text=bytes.toString('utf8').replace(/<[^>]+>/g,' ');
  records.push({relative,text,bytes:bytes.length,referenced:toolText.includes(path.basename(relative))});
 }
 await fs.writeFile(path.join(dir,'本轮候选报告实际正文.json'),JSON.stringify(records,null,2));
 const report=records.find(record=>(!extension||path.extname(record.relative).toLowerCase()===extension)&&record.referenced&&/安宁睡眠/.test(record.text)&&/风险/.test(record.text)&&/建议|替代/.test(record.text));
 assert(extension?'模型实际生成可读且有本轮工具来源的Word合规报告':'模型实际生成可读且有本轮工具来源的合规报告',Boolean(report),records.map(({relative,bytes,referenced})=>({relative,bytes,referenced})));
 const combined=extension?report.text:report.text+'\n'+finalAssistantText(data);
 assert('最终报告覆盖素材事实及医疗营销边界',[/安宁睡眠/,/99\s*元|99元/,/风险/,/替代|改写/,/客服|接待|转诊/,/审核|审查/,/隐私|个人信息/,/不能替代|不替代|不构成.{0,8}诊断|不作.{0,6}诊断/,/不.{0,6}承诺|避免.{0,6}承诺|禁止.{0,6}承诺|不.{0,6}保证/].every(pattern=>pattern.test(combined)));
 assert(context.number===113?'Word报告覆盖原案例角色职责对应的业务内容':'报告体现被分派专家的实际业务工作',roles.every(role=>role.includes('医疗健康')?/宣传|疗效|卖点/.test(report.text):role.includes('客服')?/客服|接待|转诊/.test(report.text):role.includes('内容')?/广告|短视频|落地页/.test(report.text):role==='品牌'?/品牌|语气|视觉/.test(report.text):/个人信息|消费者|广告法/.test(report.text)));
 await control.acquire(page,'EVIDENCE');await previewTaskFile(page,config,path.basename(report.relative),capture,['安宁睡眠']);
 const archive='交付-'+path.basename(report.relative);await fs.copyFile(path.join(control.directory,report.relative),path.join(dir,archive));outputs.push({name:'本轮合规报告',path:archive});
 assert('真实生成报告已保存且证据副本与原文件一致',(await fs.readFile(path.join(control.directory,report.relative))).equals(await fs.readFile(path.join(dir,archive))));
 await capture('做同款真实报告可预览且已保存');
 return report;
}
