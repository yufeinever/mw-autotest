import fs from 'node:fs/promises';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {snapshotDraft,editorOf} from './mobilework-isolation.mjs';
import {reloadOwnedModule} from './mobilework-module-navigation.mjs';
import {normalizeComposerText} from './mobilework-composer.mjs';
import {selectModel} from './mobilework-run-policy.mjs';
import {readArtifact} from './client-case-checks.mjs';
import {finalAssistantText} from './client-case-runner.mjs';
import {previewTaskFile,matchToolDetailText} from './mobilework-task-ui.mjs';
import {xmlText} from './client-message-display-steps.mjs';
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

export async function verifyReplayMain(dialog,pack){
 const details=[];
 for(const [index,turn] of pack.caseJson.turns.entries()){
  const id=pack.caseJson.case.sessionId+'_m'+(index+1),message=dialog.locator('[data-message-id="'+id+'"]');
  await message.waitFor();const actual=await message.innerText();
  const missingText=turn.text&&!plainCaseText(actual).includes(plainCaseText(turn.text));
  const missingTools=(turn.tools||[]).filter(tool=>tool.name==='create_subagent'?!actual.includes(tool.input.name)&&!actual.includes(tool.input.role):tool.name==='result_file'?!actual.includes(tool.input.output_path.split('/').at(-1)):!actual.includes(tool.title||tool.name)).map(tool=>tool.name);
  details.push({index:index+1,id,missingText:Boolean(missingText),missingTools,text:actual});
 }
 return details;
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
 if(number===112){
  await save('并发需求冲突.json',{original:'两个案例同时做同款并行且互不干扰',constraint:'当前框架仅串行，前条和收尾完成后才能下一条',result:'REVIEW',implemented:false});
  throw review('原表112要求同时执行两个案例，与已确认的严格串行约束冲突；保留并发目标，未以串行通过替代，也未启动并发任务');
 }
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
 if(number===111){
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
 const data=getData(),children=await control.get('/session/'+getSessionId()+'/children'),parts=taskTools(data),assignments=parts.filter(p=>p.tool==='task'&&p.state?.metadata?.sessionId);
 await save('专家真实分派与子Session.json',{children,assignments});
 const expected=number===111?3:5,childIds=new Set(assignments.map(p=>p.state.metadata.sessionId));
 assert('本轮实际分派'+expected+'位专家独立子会话',children.length===expected&&childIds.size===expected&&children.every(child=>child.parentID===getSessionId()&&childIds.has(child.id)));
 for(const child of children){
  const messages=await control.get('/session/'+child.id+'/message');await save(child.id+'-session-log.json',{session:child,messages});outputs.push({name:'专家会话日志',path:child.id+'-session-log.json'});
  assert('专家子任务实际有完成回复：'+child.id,messages.some(m=>m.info?.role==='assistant'&&m.info.time?.completed&&!m.info.error&&(m.parts||[]).some(p=>p.type==='text'&&p.text.trim())));
 }
 const roles=number===111?['医疗健康营销合规','医疗客服','内容创作']:['医疗健康营销合规','医疗客服','内容创作','品牌','法务'];
 assert('真实分派覆盖原文指定角色职责',roles.every(role=>assignments.some(p=>JSON.stringify(p.state.input).includes(role))),assignments.map(p=>p.state.input));finish('真实专家分派及子Session完成');
 const report=await verifyLiveReport(context,data,roles);finish('本轮真实报告正文与业务目标');finish('报告实际预览及保存');await context.saveTrace();
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
  for(const tool of child.tools||[]){
   const trigger=message.getByText(tool.title||tool.name,{exact:true});
   if(await trigger.count()!==1)throw review('专家工具入口未唯一识别，未以工具名称存在冒充详情：'+child.sessionId+' '+tool.name);
   await trigger.click();const toolText=await dialog.innerText();
   const actual={tool:tool.name,input:tool.input||{},output:tool.output||'',text:toolText};toolDetails.push(actual);
   await fs.writeFile(path.join(dir,'全部子任务实际核对.json'),JSON.stringify(details,null,2));
   const matched=matchToolDetailText({tool:tool.name,state:{input:tool.input||{},output:tool.output||''}},toolText);
   assert('子任务工具详情与原包真实输入输出相符：'+(index+1)+' '+tool.name,Boolean(matched),{tool:tool.name});
  }
  if(!captured.has(child.subagentType)||index===children.length-1){await capture('分任务-'+(index+1)+'-'+child.subagentType);captured.add(child.subagentType);}
  await button(dialog,'返回主会话继续会话').click();
  await dialog.locator('[data-message-id="'+pack.caseJson.case.sessionId+'_m1"]').waitFor();
  assert('分任务返回后主会话正文恢复：'+(index+1),await dialog.locator('[data-message-id="'+child.sessionId+'_m1"]').count()===0);
 }
 remaining.delete('全部子任务真实切换及正文');remaining.delete('各专家悬停说明及工具输入输出');remaining.delete('逐项返回主任务');
}

async function verifyLiveReport(context,data,roles){
 const {dir,control,page,config,assert,capture,outputs}=context;
 const entries=await fs.readdir(control.directory,{recursive:true,withFileTypes:true});
 const candidates=entries.filter(entry=>entry.isFile()&&/\.(docx|md|txt|html|pdf)$/i.test(entry.name)&&/审查|合规|报告|compliance|report/i.test(entry.name)).map(entry=>path.relative(control.directory,path.join(entry.parentPath,entry.name)));
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
 const report=records.find(record=>record.referenced&&/安宁睡眠/.test(record.text)&&/风险/.test(record.text)&&/建议|替代/.test(record.text));
 assert('模型实际生成可读且有本轮工具来源的合规报告',Boolean(report),records.map(({relative,bytes,referenced})=>({relative,bytes,referenced})));
 const combined=report.text+'\n'+finalAssistantText(data);
 assert('最终报告覆盖素材事实及医疗营销边界',[/安宁睡眠/,/99\s*元|99元/,/风险/,/替代|改写/,/客服|接待|转诊/,/审核|审查/,/隐私|个人信息/,/不能替代|不替代|不构成.{0,8}诊断|不作.{0,6}诊断/,/不.{0,6}承诺|避免.{0,6}承诺|禁止.{0,6}承诺|不.{0,6}保证/].every(pattern=>pattern.test(combined)));
 assert('报告体现被分派专家的实际业务工作',roles.every(role=>role.includes('医疗健康')?/宣传|疗效|卖点/.test(report.text):role.includes('客服')?/客服|接待|转诊/.test(report.text):role.includes('内容')?/广告|短视频|落地页/.test(report.text):role==='品牌'?/品牌|语气|视觉/.test(report.text):/个人信息|消费者|广告法/.test(report.text)));
 await control.acquire(page,'EVIDENCE');await previewTaskFile(page,config,path.basename(report.relative),capture,['安宁睡眠']);
 const archive='交付-'+path.basename(report.relative);await fs.copyFile(path.join(control.directory,report.relative),path.join(dir,archive));outputs.push({name:'本轮合规报告',path:archive});
 assert('真实生成报告已保存且证据副本与原文件一致',(await fs.readFile(path.join(control.directory,report.relative))).equals(await fs.readFile(path.join(dir,archive))));
 await capture('做同款真实报告可预览且已保存');
 return report;
}
