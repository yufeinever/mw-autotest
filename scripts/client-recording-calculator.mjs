import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {withRecordingExpert} from './mobilework-recording-expert.mjs';
import {workspaces,workspaceSessions,prepareWorkspaceResources} from './mobilework-workspaces.mjs';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {selectSlashSkill} from './mobilework-skill-resources.mjs';
import {buildTrace,redactTrace} from '../local-console/trace.mjs';
import {resolveRecordingRuntimeDbPath,prepareRecordingResources,refreshRecordingBinding,observeRecordingSettlement,prepareSkillGeneration,recordGeneratedSkill,inspectCalculator} from './mobilework-recording-workflow.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const toolParts=data=>[data,...(data.children||[])].flatMap(session=>session.messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool').map(part=>({...part,messageId:message.info.id}))));
const displayValue=value=>String(value).replace(/^[^\d+-]*/, '').replace(/[\s,，]/g,'');

async function installedContract(entry){
 // The public catalog exposes kind/slug; packagePath is main-process internal.
 const root=path.join(os.homedir(),'.mobilework','experts',entry.kind,entry.slug);
 const manifest=JSON.parse(await fs.readFile(path.join(root,'expert.json'),'utf8'));
 if(manifest.slug!=='cmjt-record-replay')throw blocked('实际安装录制专家身份不匹配');
 const needed=['SKILL.md','references/draft-generation.md','references/replay-task.md','references/skill-template.md'];
 const files=[];
 for(const relative of needed){
  const file=path.join(root,'.opencode/skills/cmjt-record-replay-runtime',relative),bytes=await fs.readFile(file);
  files.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 return {assetId:entry.assetId,packageVersion:entry.packageVersion,manifestVersion:manifest.version,files};
}

function recordedCalculatorSequence(artifact,calculation){
 if(!Array.isArray(artifact.steps))return {complete:false,matched:[],encoding:'unrecognized steps schema',observedCharacters:0};
 // recorder-api.md documents action/input; draft-generation documents windowName.
 // Do not infer injected keyboard events from UIA click names or nonempty steps.
 const matched=artifact.steps.flatMap((step,index)=>
  step.windowName===calculation.window.title&&step.action==='输入文本'&&typeof step.input==='string'
   ?[{sourceStep:index+1,input:step.input}]:[]);
 const recorded=matched.map(step=>step.input).join('');
 // Actual hotkey/Enter encoding is not yet sampled. A different encoding stays REVIEW;
 // extend this from the real first recording, never invent event aliases to pass.
 return {complete:recorded==='123456789-1=',matched:matched.map(({sourceStep,input})=>({sourceStep,inputLength:input.length})),encoding:'documented text-input events for actual Calculator title',observedCharacters:recorded.length};
}

async function selectGeneratedSkill(context,id){
 const {page,fill,assert,capture}=context;
 await fill('/');
 const search=page.locator('input[placeholder="输入名称搜索..."]').filter({visible:true});await search.waitFor();await search.fill(id);
 const menu=search.locator('xpath=../../..').getByRole('presentation'),element=await menu.elementHandle();
 try{await page.waitForFunction(node=>node.isConnected&&!node.textContent.includes('正在加载命令与技能…')&&(node.querySelectorAll('button').length>0||node.textContent.trim()==='未找到命令或技能。'),element,{timeout:45000});}
 finally{await element.dispose();}
 const options=menu.getByRole('button').filter({visible:true}),empty=menu.getByText('未找到命令或技能。',{exact:true});
 if(await empty.isVisible())throw blocked('本轮录制技能已安装，但产品斜线菜单没有该技能');
 if(await options.count()!==1)throw review('本轮录制技能菜单候选不能唯一对应');
 await selectSlashSkill(context,options,id);
 assert('新Session真实选中本轮录制生成Skill',(await snapshotDraft(page)).skills.includes(id));
 await capture('本轮生成技能已选择');
}

export async function runCalculatorRecordingSteps(context){
 const {number,page,control,config,dir,remaining,outputs,checks,assert,capture,send,newSession,jobId,resources,checkpointResources,checkpointRecordingResources}=context;
 const save=async(name,value)=>{await fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));outputs.push({name,path:name});};
 const workspaceId=new URL(page.url()).hash.match(/\/workspace\/([^/]+)/)?.[1];
 const workspace=(await workspaces(page)).items.find(item=>item.id===workspaceId);
 if(!workspace)throw blocked('未确认录制所属工作空间');
 const runtime=await resolveRecordingRuntimeDbPath(page);
 await save('录制运行库定位依据.json',runtime);
 // This installed creator pool is verified on this host; recordGeneratedSkill
 // cross-checks the actual delivery against this root before accepting it.
 const skillsRoot=path.join(os.homedir(),'.mobilework','skills');
 await fs.access(path.join(skillsRoot,'mobilework-skill-creator','SKILL.md'));
 resources.workspaceResources=await prepareWorkspaceResources(page,{existingTargetId:workspaceId,beforeSessionIds:(await workspaceSessions(page,workspaceId)).map(session=>session.id)});await checkpointResources();
 let sourceReview='';
 await withRecordingExpert(context,async({catalog,installedByRun})=>{
  const entries=catalog.filter(entry=>entry.id==='installed:cmjt-record-replay'&&entry.name==='流程录制专家');
  assert('通过真实市场安装或复用并召唤录制专家',entries.length===1,{installedByRun});
  await save('实际录制专家合同.json',await installedContract(entries[0]));
  if(number===87)remaining.delete('真实录制专家安装及召唤');
  const owned=await prepareRecordingResources(page,{jobId,workspaceId,projectDir:workspace.path,runtimeDbPath:runtime.runtimeDbPath});
  const checkpoint=()=>checkpointRecordingResources(owned);
  const id=number===90?'win-calculator-subtract-one':'mw-calculator-'+jobId.replace(/[^a-z0-9]/gi,'').slice(0,14).toLowerCase();
  if(owned.skillBaseline.includes(id))throw blocked('本轮目标Skill已存在；保留原技能，未覆盖来源不明的fixture');
  await checkpoint();
  await inspectCalculator(owned,{action:'Baseline',checkpoint});
  await send('开始录制我的操作。本轮测试标识：'+jobId+'。',{wait:false});
  owned.sourceSession={id:control.sessionId,directory:control.directory};await checkpoint();
  const observe=async()=>{
   const {binding}=await refreshRecordingBinding(page,owned,{checkpoint});
   if(binding&&owned.startOutcome==='started'){
    await observeRecordingSettlement(owned);await checkpoint();
   }
  };
  await control.wait(page,config,{timeoutMs:context.definition.timeoutMs,capture,observe});
  await refreshRecordingBinding(page,owned,{checkpoint});
  assert('本Session真实录制启动工具成功且绑定已登记',owned.startOutcome==='started'&&owned.stage==='recording'&&Boolean(owned.recording?.recorder));
  await control.acquire(page,'PREPARING');
  await inspectCalculator(owned,{action:'Open',checkpoint});
  const calculation=await inspectCalculator(owned,{action:'CalculateKeys',checkpoint});
  await save('录制阶段计算器控件结果.json',calculation);
  assert('录制阶段实际计算器结果为123456788',displayValue(calculation.display)==='123456788');
  await capture('录制演示后客户端状态');
  await send('请结束当前录制并等待真实步骤处理结束。先不要生成、安装、覆盖或回放Skill；我要先核对本轮真实录制步骤是否完整。不得创建任何技能目录。',{continuing:true,waitOptions:{observe}});
  await refreshRecordingBinding(page,owned,{checkpoint});
  const settlement=await observeRecordingSettlement(owned);await checkpoint();
  assert('录制产物及本Session续轮均真实完成',settlement.artifactSettled&&settlement.continuationSettled);
  const artifactBytes=await fs.readFile(owned.recording.stepInfoFilePath),artifact=JSON.parse(artifactBytes.toString('utf8'));
  await save('实际录制步骤.json',{sourcePath:owned.recording.stepInfoFilePath,sourceSha256:createHash('sha256').update(artifactBytes).digest('hex'),artifact:redactTrace(artifact)});
  const sequence=recordedCalculatorSequence(artifact,calculation);
  await save('真实录制步骤覆盖.json',{recordingId:owned.recording.recordingId,sopId:owned.recording.sopId,total:Array.isArray(artifact.steps)?artifact.steps.length:null,...sequence});
  if(!sequence.complete)throw review('真实事件未完整证明计算器键盘操作；须按实际录制的按键事件结构核对，不以显示正确或steps非空替代');
  if(number===87)remaining.delete('真实桌面计算操作录制');
  else remaining.delete('独立桌面录制材料及来源');
  await prepareSkillGeneration(owned,{id,skillsRoot,archiveDirectory:path.join(dir,'本轮生成Skill'),checkpoint});
  await send('本轮真实录制步骤已核对。现在请按这些步骤生成并安装计算器技能，机器ID为'+id+'。保持键盘逐位输入1至9、减1、等号的业务顺序及实际最终状态验证。经mobilework-skill-creator生成、校验并安装读回，再用result_file登记SKILL.md及去敏台账。本源会话不执行回放；我会在独立新会话复用已生成技能。仅使用可丢弃的计算器窗口，不操作其他应用或用户资料。',{continuing:true,waitOptions:{observe}});
  const source=await control.readLog(true),tools=toolParts(source);
  if(source.collection?.truncated||source.traceErrors?.length)sourceReview='源Session及子任务证据采集不完整';
  const deliveries=tools.filter(tool=>tool.tool==='result_file'&&tool.state?.status==='completed').flatMap(tool=>{
   const paths=tool.state.input?.output_paths;
   return (Array.isArray(paths)?paths:[]).filter(file=>typeof file==='string'&&path.basename(file)==='SKILL.md'&&path.basename(path.dirname(file))===id).map(file=>({tool,file}));
  });
  if(deliveries.length!==1)throw review('本Session已安装Skill交付入口缺失或不唯一');
  const [{tool,file}]=deliveries;
  await recordGeneratedSkill(page,owned,{id,skillPath:path.dirname(file),skillsRoot,archiveDirectory:path.join(dir,'本轮生成Skill'),generationMessageId:tool.messageId,generationCallId:tool.callID,checkpoint});
  outputs.push({name:'本轮真实生成Skill副本',path:'本轮生成Skill/SKILL.md'});
  const sourceTrace=buildTrace(source,{expectedSkills:['mobilework-skill-creator'],caseId:context.definition.id,origin:'run-snapshot'});
  await save('录制生成Skill调用Trace.json',sourceTrace);checks.push(...sourceTrace.checks);
  assert('本Session真实使用Skill创建器生成技能',sourceTrace.checks.every(item=>item.pass));
  const runtimeTrace=buildTrace(source,{expectedSkills:['cmjt-record-replay-runtime'],caseId:context.definition.id,origin:'run-snapshot'});
  const runtimeInvoked=runtimeTrace.checks.every(item=>item.pass);
  await save('录制专家运行时调用证据.json',{trace:runtimeTrace,independentInvocationProven:runtimeInvoked,note:'专家运行时可由产品托管注入；没有独立skill调用证据时保留REVIEW，继续核对真实录制及回放业务'});
  if(!runtimeInvoked)sourceReview+=(sourceReview?'；':'')+'录制专家运行时独立Skill调用证据不足';
  if(number===87)remaining.delete('实际生成Skill及来源');
  else remaining.delete('真实已安装技能前置');
  await control.acquire(page,'PREPARING');
  const reset=await inspectCalculator(owned,{action:'Reset',checkpoint});
  assert('回放前真实计算器已清零，避免旧结果假阳性',displayValue(reset.display)==='0');
  const beforeReplay=await inspectCalculator(owned,{action:'Inventory'});
  if(beforeReplay.unowned.length)throw review('回放开始前出现基线外未归属的计算器，保留现场');
  await newSession();
  if(number===90)await selectGeneratedSkill(context,id);
  await send((number===87?'请读取并调用已安装Skill的完整路径 '+path.join(owned.generatedSkill.path,'SKILL.md')+'。':'请调用已选中的录制Skill。')+'现在明确授权一次完整回放：Windows计算器，逐位输入123456789，减1并按等号，最后读取本次实际显示。请按技能主路径实际执行，桌面操作使用cmjt-desktop-auto；不重新录制、生成或创建其他任务。只操作当前可丢弃计算器窗口；实际工具不可用时如实停止。',{wait:false});
  owned.replaySession={id:control.sessionId,directory:control.directory};owned.stage='replaying';await checkpoint();
  let replayWindow=owned.calculator.hwnd;
  const observeReplayWindows=async()=>{
   const inventory=await inspectCalculator(owned,{action:'Inventory'});
   if(inventory.unowned.length>1)throw review('回放产生多个尚未唯一交接的计算器，保留窗口归属等待核对');
   if(inventory.unowned.length){
    const adopted=await inspectCalculator(owned,{action:'Adopt',window:inventory.unowned[0],checkpoint});
    replayWindow=adopted.hwnd;
   }
  };
  await control.wait(page,config,{timeoutMs:context.definition.timeoutMs,capture,observe:observeReplayWindows});
  await observeReplayWindows();
  const replay=await control.readLog(true);
  if(replay.collection?.truncated||replay.traceErrors?.length)throw review('回放真实子任务证据采集不完整，不能判定全部Skill调用');
  const replayTrace=buildTrace(replay,{expectedSkills:[id,'cmjt-desktop-auto'],caseId:context.definition.id,origin:'run-snapshot'});
  await save('独立回放Skill调用Trace.json',replayTrace);checks.push(...replayTrace.checks);
  assert('新Session真实加载生成Skill并使用桌面回放能力',replayTrace.checks.every(item=>item.pass));
  if(number===90)remaining.delete('新Session选择并调用录制技能');
  const actual=await inspectCalculator(owned,{action:'Inspect',hwnd:replayWindow,checkpoint});await save('独立回放计算器实际结果.json',actual);
  assert('独立回放后的真实计算器结果为123456788',displayValue(actual.display)==='123456788');
  await capture('独立回放后客户端状态');
  if(number===87)remaining.delete('完整路径回放与真实计算结果');
  else remaining.delete('真实桌面回放及计算器结果');
  // withRecordingExpert finally settles SOP/source/replay before expert release.
 });
 if(number===90)remaining.delete('本Session调用Trace及收尾');
 if(sourceReview)throw review(sourceReview+'；实际录制、生成及独立回放业务已继续观察，详见分项证据');
}
