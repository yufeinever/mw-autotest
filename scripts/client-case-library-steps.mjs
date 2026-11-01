import fs from 'node:fs/promises';
import path from 'node:path';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {caseDialog,caseCards,caseTitles,normalizeCaseText,readCaseAssets,visibleCaseAssets,caseListSignature,waitCaseCollection,readCaseDetail,readCaseDocument,closeOwnedCaseReplay,readCasePackage,observeCaseReplay} from './mobilework-case-library.mjs';
import {runCaseLibraryTaskSteps,verifyReplayMain} from './client-case-library-task-steps.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const search=page=>page.locator('input[placeholder="请输入关键词查询"]');

export async function runCaseLibrarySteps(context){
 const {number,page,resources,dir,remaining,assert,capture,checkpointResources}=context;
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)),finish=step=>remaining.delete(step);
 const draft=await snapshotDraft(page);
 if(draft.text||draft.skills.length||draft.selection.length)throw blocked('案例库检查前存在未知草稿，保留现场');
 const baseline=await readCaseAssets(page),items=visibleCaseAssets(baseline);
 await save('案例库完整分页基线.json',baseline);
 resources.moduleNavigation={originUrl:draft.url,targetHash:'#/explore'};await checkpointResources();
 await button(page,'案例库: 实例与回放').click();await page.waitForURL(url=>url.hash==='#/explore');await search(page).waitFor();
 await button(page,'全部').waitFor();await button(page,'全部').click();await search(page).fill('');
 await waitCaseCollection(page,items);await capture('案例库全部真实案例');finish('完整列表与真实加载');
 if(number===104){
  const categories=['营销服务','经营管理','网络运营','通用领域'];
  for(const category of categories){
   if(!items.some(item=>item.category===category))throw blocked('当前资产库缺少原表领域测试数据：'+category);
   await button(page,category).waitFor();
  }
  assert('全部及原表四个领域入口真实存在',true);finish('领域分类入口');
  for(const category of categories){
   await button(page,category).click();const expected=items.filter(item=>item.category===category),actual=await waitCaseCollection(page,expected);
   for(let index=0;index<expected.length;index++){
    await caseCards(page).nth(index).locator('img').scrollIntoViewIfNeeded();
    await page.waitForFunction(index=>document.querySelectorAll('.mw-case-card img')[index]?.complete,index,{timeout:15000});
   }
   const cards=await caseCards(page).evaluateAll(nodes=>nodes.map(node=>({title:node.querySelector('img')?.alt,cover:!!node.querySelector('img')?.complete&&node.querySelector('img').naturalWidth>0,text:node.innerText})));
   assert(category+'全部卡片匹配该领域且封面实际加载',cards.length===expected.length&&cards.every(card=>card.cover&&card.text.includes(card.title)),{expected:expected.map(i=>i.title),actual,cards});
   await save(category+'领域核对.json',{expected,actual,cards});await capture(category+'领域完整列表');
  }
  finish('四领域完整集合与卡片');
 }else if(number===105){
  const keyword='医疗健康',expected=items.filter(item=>(item.title+item.description+item.tags.join('')).toLowerCase().includes(keyword.toLowerCase()));
  if(!expected.some(item=>item.title==='医疗健康营销合规审查'))throw blocked('原表已知案例未上架，缺少搜索前提');
  await search(page).fill(keyword);const actual=await waitCaseCollection(page,expected);
  assert('搜索值回显且仅保留完整匹配集合',await search(page).inputValue()===keyword&&actual.length===expected.length,{expected,actual});
  await save('关键词搜索核对.json',{keyword,expected,actual});await capture('案例库医疗健康搜索结果');finish('关键词筛选与排除不匹配');
  await search(page).fill('');await waitCaseCollection(page,items);assert('清空搜索恢复全部案例',await search(page).inputValue()==='');await capture('清空搜索恢复全部案例');finish('清空搜索恢复全量');
 }else if(number>=107){
  await runCaseLibraryTaskSteps(context,items);
 }else if(number===106){
  const title='医疗健康营销合规审查',matches=items.filter(item=>item.title===title);
  if(matches.length!==1)throw blocked('原表目标案例未唯一找到，未替换其他案例');
  const target=matches[0],detail=await readCaseDetail(page,target.assetId);
  const resultUrl=Array.isArray(detail.caseDetail.resultFileDownloadUrl)?detail.caseDetail.resultFileDownloadUrl[0]:detail.caseDetail.resultFileDownloadUrl;
  if(!resultUrl)throw blocked('目标案例未配置实际效果预览文件');
  const preview=await readCaseDocument(page,resultUrl);await fs.writeFile(path.join(dir,'案例效果预览原文件.docx'),preview.bytes);
  await save('案例详情及预览正文依据.json',{detail,facts:preview.facts});
  if(await page.getByRole('dialog').count())throw blocked('存在未知弹窗，未登记为本轮回放');
  resources.caseReplay={title,assetId:target.assetId,opening:true};await checkpointResources();
  await caseCards(page).filter({has:page.getByText(title,{exact:true})}).click();
  const dialog=caseDialog(page,title);await dialog.waitFor({timeout:90000});resources.caseReplay.opening=false;await checkpointResources();
  const aside=dialog.getByRole('complementary',{name:'案例详情',exact:true});await aside.waitFor();
  await aside.getByText(detail.description,{exact:true}).waitFor();
  const asideText=await aside.innerText();
  assert('案例详情名称简介及标签来自真实资产',asideText.includes(title)&&asideText.includes(detail.description)&&(detail.tags||[]).every(tag=>asideText.includes(tag)));finish('真实案例详情');
  const host=dialog.locator('.mw-docx-host');await host.getByText(preview.facts[0],{exact:false}).first().waitFor({timeout:60000});
  const content=await host.innerText();await fs.writeFile(path.join(dir,'实际效果预览正文.txt'),content);
  assert('效果预览正文涵盖原文件首中末核心段落',preview.facts.every(fact=>normalizeCaseText(content).includes(normalizeCaseText(fact))),{facts:preview.facts});await capture('案例实际效果预览正文');finish('实际产物效果正文');
  const pack=await readCasePackage(page,target.assetId),turns=pack.caseJson.turns;
  await save('本轮案例原始回放依据.json',{case:pack.caseJson.case,turns,resourceFiles:pack.resourceFiles});
  await button(dialog,'案例回放').click();
  const readonly='现在是案例回放，输入框无法输入内容，您可以使用右上角「做同款」来创建新任务。';await dialog.getByText(readonly,{exact:true}).waitFor();
  assert('回放提示和输入只读控件一致',await dialog.locator('textarea:not([disabled]),input:not([disabled]),[contenteditable="true"]').count()===0);finish('回放只读输入');
  const replay=await observeCaseReplay(dialog,{timeoutMs:context.definition.timeoutMs,onObserver:async key=>{resources.caseReplay.observation=key;await checkpointResources();},onSample:sample=>fs.appendFile(path.join(dir,'案例回放逐步采样.jsonl'),JSON.stringify(sample)+'\n')});
  const details=await verifyReplayMain(dialog,pack);await save('案例回放实际记录核对.json',{replay,details});
  assert('回放主会话全部文本及执行记录完整展示',details.every(item=>!item.missingText&&!item.missingTools.length),details.filter(item=>item.missingText||item.missingTools.length));await capture('案例主会话与真实执行记录');finish('完整回放文本与工具记录');
  // The shipped client opens final files in the internal side panel. Verify
  // actual document contents there rather than requiring an obsolete OS window.
  const filePath=pack.resourceFiles.find(file=>file.endsWith('/compliance-review-report.docx'));
  if(!filePath)throw blocked('真实案例包缺少原表最终文件');
  const name=filePath.split('/').at(-1),fileUrl=new URL(filePath.split('/').map(encodeURIComponent).join('/'),pack.resourceBaseUrl).href;
  const file=await readCaseDocument(page,fileUrl);await fs.writeFile(path.join(dir,name),file.bytes);
  const fileCard=dialog.locator('div.cursor-pointer[data-slot="tooltip-trigger"]').filter({has:page.getByText(name,{exact:true})});
  await fileCard.click();
  const finalHost=dialog.locator('aside').filter({has:page.locator('.mw-docx-host')}).locator('.mw-docx-host');
  await finalHost.getByText(file.facts[0],{exact:false}).first().waitFor({timeout:60000});const finalContent=await finalHost.innerText();
  await save('最终文件实际预览核对.json',{name,facts:file.facts,text:finalContent});
  assert('最终文件真实入口打开且首中末正文对应文件',file.facts.every(fact=>normalizeCaseText(finalContent).includes(normalizeCaseText(fact))),{name,facts:file.facts});await capture('案例最终Word文件实际预览');finish('最终文件入口与实际正文');
  await closeOwnedCaseReplay(page,resources);await checkpointResources();finish('只读回放关闭与缓存收尾');
 }
 const after=await readCaseAssets(page);await save('案例库结束分页核对.json',after);
 if(caseListSignature(after)!==caseListSignature(baseline))throw review('资产列表在观察期间发生变化，保留前后集合待复核');
}
