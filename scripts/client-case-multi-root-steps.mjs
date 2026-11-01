import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {snapshotDraft,editorOf,modalDialogs} from './mobilework-isolation.mjs';
import {normalizeComposerText} from './mobilework-composer.mjs';
import {selectModel} from './mobilework-run-policy.mjs';
import {workspaceSessions} from './mobilework-workspaces.mjs';
import {caseCards,caseDialog,openOwnedCase,readCasePackage,adoptCaseTaskDraft} from './mobilework-case-library.mjs';
import {readArtifact} from './client-case-checks.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';
import {xmlText} from './client-message-display-steps.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const tools=log=>[log,...(log.children||[])].flatMap(item=>(item.messages||[]).flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool').map(part=>({...part,sourceSessionId:item.sessionId}))));
const textOf=message=>(message.parts||[]).filter(part=>part.type==='text').map(part=>part.text||'').join('\n');
const hash=value=>createHash('sha256').update(value).digest('hex');

function toolObject(part){
 if(typeof part.state.output==='object')return part.state.output;
 try{return JSON.parse(part.state.output);}catch{return null;}
}

// Share URLs carry access tokens. Keep an irreversible reference plus the
// successful run/company linkage, never the token or the complete share URL.
function shareFacts(log){
 return tools(log).filter(part=>part.state?.status==='completed'&&/tradingagents_(?:export_report_html|create_share_link)$/.test(part.tool)).map(part=>{
  const output=toolObject(part),url=output?.share_url||output?.html_url;
  return {tool:part.tool,callId:part.callID,sessionId:part.sourceSessionId,inputRunId:part.state.input?.run_id,runId:output?.run_id,company:output?.company,htmlPath:output?.html_path,
   parsed:Boolean(output),shareReturned:typeof url==='string'&&/^(?:https?:\/\/[^/]+)?\/share\/[A-Za-z0-9_-]+$/.test(url),shareReferenceHash:typeof url==='string'?hash(url):null};
 });
}

export function redactRootEvidence(value){
 if(Array.isArray(value))return value.map(redactRootEvidence);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(?:token|clawToken)$/i.test(key)?'[REDACTED]':redactRootEvidence(item)]));
 if(typeof value!=='string')return value;
 return value.replace(/(\/share\/)[A-Za-z0-9_-]+/g,'$1[REDACTED]').replace(/("(?:token|clawToken)"\s*:\s*")[^"]+("?)/gi,'$1[REDACTED]$2');
}

// Called by the business path and the runner's exception path. Snapshot the
// already observed root first; collection failures must not erase its identity.
export async function archiveRootEvidence(task,context){
 const {dir,number,checks,log,outputs}=context,target=path.join(dir,task.evidence);
 await fs.mkdir(target,{recursive:true});
 await fs.writeFile(path.join(target,'根任务归属.json'),JSON.stringify({key:task.key,id:task.id,directory:task.directory,url:task.url,source:task.source,firstUserMessageId:task.firstUserMessageId,completed:task.completed,result:task.result,error:task.error},null,2));
 if(task.evidenceStored)return task.trace;
 if(task.data)await fs.writeFile(path.join(target,'异常或终态已观察快照.json'),JSON.stringify(redactRootEvidence(task.data),null,2));
 task.trace=await saveRunTrace({page:context.page,sessionId:task.id,number,dir:target,checks,log,readLog:async()=>{
  const actual=await task.control.readLog(true,{maxSessions:512,timeoutMs:180000});
  task.shareFacts=shareFacts(actual);task.evidenceLog=redactRootEvidence(actual);
  await fs.writeFile(path.join(target,'HTML与分享实际工具归属.json'),JSON.stringify(task.shareFacts,null,2));
  return task.evidenceLog;
 }});
 if(task.trace.error)throw blocked(task.key+'根日志/Trace保存失败：'+task.trace.error);
 task.evidenceStored=true;
 outputs.push({name:'任务'+task.key+' Session日志',path:task.evidence+'/'+task.id+'-session-log.json'},{name:'任务'+task.key+' Trace',path:task.evidence+'/trace.json'});
 return task.trace;
}

async function verifyMedicalRoot(context,task,verifyMedicalReport){
 const {assert}=context,data=task.evidenceLog,logs=[data,...(data.children||[])],assignments=tools(data).filter(part=>part.tool==='task'&&part.state?.metadata?.sessionId);
 const direct=(data.children||[]).filter(child=>child.session.parentID===task.id),ids=new Set(assignments.map(part=>part.state.metadata.sessionId));
 assert('任务A真实分派原文五位专家',direct.length===5&&direct.every(child=>ids.has(child.sessionId)));
 const roles=['医疗健康营销合规','医疗客服','内容创作','品牌','法务'];
 assert('任务A实际分派覆盖五项业务职责',roles.every(role=>assignments.some(part=>JSON.stringify(part.state.input).includes(role))));
 for(const child of direct)assert('任务A专家实际完成：'+child.sessionId,child.messages.some(message=>message.info?.role==='assistant'&&message.info.time?.completed&&!message.info.error&&textOf(message).trim()));
 if(data.traceErrors?.length)throw review('任务A子日志采集不完整：'+data.traceErrors.join('；'));
 await context.group.withRootUI(task.key,'EVIDENCE',async control=>{
  await verifyMedicalReport({...context,dir:path.join(context.dir,task.evidence),control,capture:step=>context.capture('任务A-'+step,'A'),outputs:context.rootOutputs(task)},data,roles);
 });
 return {sessions:logs.length};
}

async function readStockArtifacts(task){
 const entries=await fs.readdir(task.directory,{recursive:true,withFileTypes:true}),records=[];
 for(const entry of entries.filter(entry=>entry.isFile()&&/\.(?:md|html|txt|docx)$/i.test(entry.name))){
  const relative=path.relative(task.directory,path.join(entry.parentPath,entry.name)),bytes=await readArtifact(task.directory,relative,{binary:true});
  const text=/\.docx$/i.test(relative)?xmlText(strFromU8(unzipSync(bytes)['word/document.xml'])):bytes.toString('utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ');
  records.push({relative,bytes,text});
 }
 return records;
}

async function verifyStockRoot(context,task,prompt){
 const {assert,dir,outputs}=context,stocks=[...prompt.matchAll(/^\d+\.\s+(\d{6}\.(?:SH|SZ))\s+([^\r\n]+)$/gm)].map(([,code,name])=>({code,name:name.trim()}));
 assert('任务B保持原文二十只目标股票及完整要求',stocks.length===20&&new Set(stocks.map(stock=>stock.code)).size===20);
 const logs=task.evidenceLog,records=await readStockArtifacts(task),parts=tools(logs),completed=parts.filter(part=>part.state?.status==='completed'),sourceText=JSON.stringify(completed),missing=[],details=[],chosen=new Set();
 if(logs.traceErrors?.length)missing.push('原生递归日志存在采集上限/错误：'+logs.traceErrors.join('；'));
 const domains=[/财务|盈利|估值|资产|fundamental/i,/新闻|公告|政策|消息|news/i,/情绪|舆情|市场预期|sentiment/i,/技术|均线|支撑|趋势|technical/i,/仓位|止损|止盈|买入|卖出|执行计划|交易计划/];
 for(const stock of stocks){
  const identity=text=>text.includes(stock.code)||text.includes(stock.name);
  const children=(logs.children||[]).filter(child=>{
   const input=textOf(child.messages.find(message=>message.info?.role==='user')||{});
   return identity(input)&&stocks.filter(other=>input.includes(other.code)||input.includes(other.name)).length===1;
  });
  const finished=children.filter(child=>child.messages.some(message=>message.info?.role==='assistant'&&message.info.time?.completed&&!message.info.error&&textOf(message).trim()));
  if(!finished.length)missing.push(stock.code+'缺可观察的独立分析子Session及完成回复');
  const report=records.find(record=>identity(record.relative+'\n'+record.text.split('\n').slice(0,6).join('\n'))&&domains.every(pattern=>pattern.test(record.text))&&sourceText.includes(path.basename(record.relative)));
  if(!report)missing.push(stock.code+'缺当前根可读、工具有来源且覆盖四类研判和交易计划的个股报告');else chosen.add(report);
  const exported=(task.shareFacts||[]).find(fact=>/export_report_html$/.test(fact.tool)&&fact.company===stock.code&&fact.runId&&fact.runId===fact.inputRunId&&fact.htmlPath);
  if(!exported)missing.push(stock.code+'缺真实HTML导出返回与本股票run_id关联');
  const shared=exported&&(task.shareFacts||[]).find(fact=>/create_share_link$/.test(fact.tool)&&fact.runId===exported.runId&&fact.inputRunId===exported.runId&&fact.shareReturned);
  if(!shared)missing.push(stock.code+'缺本股票run_id对应的成功分享工具返回');
  let html=exported&&records.find(record=>record.relative.replaceAll('\\','/')===exported.htmlPath.replaceAll('\\','/'));
  if(html&&identity(html.text)&&/\.html$/i.test(html.relative))chosen.add(html);
  else{html=null;missing.push(stock.code+'导出HTML未在本根实际目录取得可读正文，不能把工具返回路径当文件验证');}
  details.push({stock,independentSessions:finished.map(child=>child.sessionId),report:report?.relative||null,html:html?.relative||null,exported:exported||null,shared:shared||null});
 }
 const summary=records.find(record=>/\.md$/i.test(record.relative)&&stocks.every(stock=>record.text.includes(stock.code)||record.text.includes(stock.name))&&/比较|对比|综合|配置|排序|comparison|summary/i.test(record.text)&&sourceText.includes(path.basename(record.relative)));
 if(!summary)missing.push('缺本轮工具有来源、覆盖全部20股票的综合对比Markdown');else chosen.add(summary);
 await fs.writeFile(path.join(dir,task.evidence,'二十股票业务核验.json'),JSON.stringify({stocks,details,summary:summary?.relative||null,missing},null,2));
 for(const record of chosen){
  const archive=path.join(task.evidence,'产物',record.relative),destination=path.join(dir,archive);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,record.bytes);
  outputs.push({name:'任务B实际产物 '+record.relative,path:archive.replaceAll('\\','/')});
 }
 if(missing.length)throw review('任务B完整原需求仍有未取得的业务证据，见二十股票业务核验.json；'+missing.slice(0,3).join('；'));
 assert('任务B二十股票独立分析、个股报告与HTML均为本轮真实产物',details.length===20&&details.every(item=>item.independentSessions.length&&item.report&&item.html));
 assert('任务B二十股票成功分享均有真实工具返回与独立run_id',new Set(details.map(item=>item.exported.runId)).size===20&&details.every(item=>item.shared));
 assert('任务B综合Markdown与全部二十股票对应',Boolean(summary));
}

export async function runCaseMultiRootSteps(context,items,{verifyMedicalReport}){
 const {page,dir,resources,config,assert,capture,checkpointResources,checkpointPage,remaining,definition,createRootGroup}=context;
 const find=title=>{const matches=items.filter(item=>item.title===title);if(matches.length!==1)throw blocked('112真实案例未唯一找到：'+title);return matches[0];};
 const targets={A:find('医疗健康营销合规审查'),B:find('百家企业大规模蜂群对比分析')},packs={};
 for(const key of ['A','B']){
  packs[key]=await readCasePackage(page,targets[key].assetId);
  if(!packs[key].caseJson.case.prompt?.trim())throw blocked('112案例'+key+'缺原始完整提示词');
  await fs.writeFile(path.join(dir,'任务'+key+'-原始完整提示词.txt'),packs[key].caseJson.case.prompt);
 }
 const origin=resources.moduleNavigation.originUrl,workspaceId=new URL(origin).hash.match(/^#\/workspace\/([^/]+)\/session$/)?.[1];
 if(!workspaceId)throw blocked('112案例原入口缺独立工作空间');
 const promptA=packs.A.caseJson.case.prompt.trim(),promptB=packs.B.caseJson.case.prompt.trim(),beforeA=(await workspaceSessions(page,workspaceId)).map(session=>session.id);
 const dialog=await openOwnedCase(context,targets.A);
 resources.caseTask={originUrl:origin,workspaceId,title:targets.A.title,assetId:targets.A.assetId,prompt:promptA,editedPrompt:null};await checkpointResources();
 await button(dialog,'做同款').click();await page.waitForURL(origin,{timeout:60000});
 const actualA=await adoptCaseTaskDraft(page,resources,{finish:false});await checkpointPage(actualA);
 assert('任务A做同款保留完整原始预填',normalizeComposerText(actualA.text)===normalizeComposerText(promptA));
 await selectModel(page,config.model||'自动',config);
 const group=createRootGroup();
 const rootOutputs=task=>({push(...items){for(const item of items)context.outputs.push({...item,name:'任务'+task.key+' '+item.name,path:task.evidence+'/'+item.path});}});
 const work={...context,group,rootOutputs};
 await group.prepare({key:'A',source:{kind:'case-library',assetId:targets.A.assetId,title:targets.A.title},workspaceId,originUrl:origin,expectedPrompt:promptA,beforeSessionIds:beforeA,resources},async()=>{
  await group.checkpointResources(resources);await capture('任务A完整预填发送前','A');await group.clickPending(()=>button(page,'运行任务').click());
 });
 const bResources={url:origin,attachments:[],queueTexts:[],restorePermission:false};let bPrepared=false;
 const advance=async()=>{
  if(!group.tasks.some(task=>task.key==='A'))return false;
  if(!bPrepared){
   const beforeB=(await workspaceSessions(page,workspaceId)).map(session=>session.id);
   await group.prepare({key:'B',source:{kind:'case-library',assetId:targets.B.assetId,title:targets.B.title},workspaceId,originUrl:origin,expectedPrompt:promptB,beforeSessionIds:beforeB,resources:bResources},async control=>{
    await control.assertNoDraft(page);const fresh=button(page,'新建任务');if(await fresh.isVisible())await fresh.click({timeout:1500});
   });bPrepared=true;return false;
  }
  if(!group.pending)return group.tasks.some(task=>task.key==='B');
  if(group.pending.state==='SUBMITTING')return true;
  return group.withPendingUI('PREPARING',async control=>{
   const hash=new URL(page.url()).hash;
   if(page.url()===group.tasks.find(task=>task.key==='A').url){
    await control.assertNoDraft(page);const fresh=button(page,'新建任务');if(await fresh.isVisible())await fresh.click({timeout:1500});return false;
   }
   if(hash==='#/session'){
    if(!await editorOf(page).count())return false;
    const actual=await snapshotDraft(page),selected=await page.evaluate(()=>localStorage.getItem('openwork.react.newTaskDraftWorkspace'));
    if(actual.text||actual.skills.length||actual.selection.length||selected!==workspaceId)throw blocked('112新任务实际空间/空草稿不属于本轮，未覆盖');
    await page.evaluate(url=>{location.hash=new URL(url).hash;},origin);return false;
   }
   if(page.url()===origin){
    if(!await editorOf(page).count())return false;
    const actual=await snapshotDraft(page);
    if(normalizeComposerText(actual.text)===normalizeComposerText(promptB)&&!actual.skills.length&&!actual.selection.length){
     bResources.url=origin;await group.checkpointResources(bResources);
     assert('任务B做同款保留二十股票完整原始预填',true);
     await capture('任务B完整原文预填发送前','B');await group.clickPending(()=>button(page,'运行任务').click({timeout:1500}));return true;
    }
    if(bResources.caseTask&&!actual.skills.length&&!actual.selection.length&&normalizeComposerText(promptB).startsWith(normalizeComposerText(actual.text)))return false;
    if(actual.text||actual.skills.length||actual.selection.length)throw blocked('112任务B预填与登记的完整案例不一致');
    if(bResources.caseTask)return false; // The real Do Same handoff is still loading.
    bResources.moduleNavigation={originUrl:origin,targetHash:'#/explore'};await group.checkpointResources(bResources);
    const entry=button(page,'案例库: 实例与回放');if(await entry.isVisible())await entry.click({timeout:1500});return false;
   }
   if(hash!=='#/explore')throw blocked('112任务B准备页离开本轮精确路由');
   if(bResources.caseTask)return false; // Do Same was already clicked once.
   const modal=caseDialog(page,targets.B.title),dialogs=modalDialogs(page);
   if(await dialogs.count()){
    if(await dialogs.count()!==1||!await modal.isVisible()||bResources.caseReplay?.assetId!==targets.B.assetId)throw blocked('112任务B遇到不属于本轮案例的弹框');
    const same=button(modal,'做同款');
    if(!await same.isVisible()||!await same.isEnabled())return false;
    bResources.caseReplay.opening=false;
    bResources.caseTask={originUrl:origin,workspaceId,title:targets.B.title,assetId:targets.B.assetId,prompt:promptB,editedPrompt:null};await group.checkpointResources(bResources);
    await same.click({timeout:1500});return false;
   }
   const search=page.getByPlaceholder('请输入关键词查询',{exact:true}).filter({visible:true});
   if(!await search.isVisible())return false;
   if(await search.inputValue()!==targets.B.title){await search.fill(targets.B.title);return false;}
   const card=caseCards(page).filter({has:page.getByText(targets.B.title,{exact:true})});
   if(await card.count()!==1||!await card.isVisible())return false;
   bResources.caseReplay={title:targets.B.title,assetId:targets.B.assetId,opening:true};await group.checkpointResources(bResources);await card.click({timeout:1500});return false;
  });
 };
 const overlap=[];let registrationChecked=false;
 await group.wait({timeoutMs:definition.timeoutMs,advance,onSample:async sample=>{
  await fs.appendFile(path.join(dir,'两根实际执行采样.jsonl'),JSON.stringify(sample)+'\n');
  if(!registrationChecked&&group.tasks.length===2){
   const actualDirectories=await Promise.all(group.tasks.map(task=>fs.realpath(task.directory)));
   assert('112两条案例实际创建不同根Session与任务目录',new Set(group.tasks.map(task=>task.id)).size===2&&new Set(actualDirectories.map(directory=>directory.toLowerCase())).size===2);
   registrationChecked=true;remaining.delete('两根真实Session与目录隔离');remaining.delete('两个真实案例完整来源及预填');
  }
  if(['A','B'].every(key=>sample.roots.some(root=>root.key===key&&root.state==='busy'))){
   overlap.push(sample);
   if(overlap.length===1){
    await fs.writeFile(path.join(dir,'实际运行重叠证据.json'),JSON.stringify({observed:true,samples:[sample],scope:'首次实际重叠样本；完整采样见两根实际执行采样.jsonl'},null,2));
    assert('112实际采样观察两根模型同时busy',true);remaining.delete('模型实际运行重叠');
   }
  }
 },onRootComplete:async task=>{
  await fs.writeFile(path.join(dir,task.evidence,'模型实际终态.json'),JSON.stringify({key:task.key,id:task.id,result:task.result,error:task.error,observedAt:new Date().toISOString()},null,2));
 }});
 await fs.writeFile(path.join(dir,'实际运行重叠证据.json'),JSON.stringify({observed:overlap.length>0,samples:overlap},null,2));
 const problems=[];
 for(const task of group.tasks){
  try{
   await archiveRootEvidence(task,{...context,checks:context.checks});
   if(task.result==='FAIL')throw Error('模型执行失败：'+JSON.stringify(task.error));
   if(task.key==='A'){await verifyMedicalRoot(work,task,verifyMedicalReport);remaining.delete('医疗五专家及真实合规报告');}
   else{await verifyStockRoot(work,task,promptB);remaining.delete('二十股票独立分析及报告');remaining.delete('个股HTML与综合summary');remaining.delete('真实分享行为及来源');}
   task.result='PASS';
  }catch(error){task.result=error.review?'REVIEW':error.blocked?'BLOCKED':'FAIL';task.error=error.message;problems.push({key:task.key,result:task.result,error});}
 }
 if(group.tasks.every(task=>task.evidenceStored))remaining.delete('各根日志Trace归档');
 if(!overlap.length)problems.push({key:'group',result:'REVIEW',error:review('未观察到两根真实执行时段重叠；不能用各自完成冒充同时运行')});
 await fs.writeFile(path.join(dir,'两项业务独立结论.json'),JSON.stringify({roots:group.tasks.map(({key,id,result,error})=>({key,id,result,error})),overlap:{result:overlap.length?'PASS':'REVIEW',observed:overlap.length>0,error:overlap.length?null:'未观察到两根真实执行时段重叠'}},null,2));
 if(problems.length){const selected=problems.find(item=>item.result==='BLOCKED')||problems.find(item=>item.result==='FAIL')||problems[0];throw selected.error;}
 remaining.delete('原表两个案例真实并行与各自产物');
}
