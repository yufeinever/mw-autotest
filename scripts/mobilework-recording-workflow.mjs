import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
import {readSessionLog} from '../local-console/session-log.mjs';
import {buildTrace} from '../local-console/trace.mjs';
import {settleSession} from '../local-console/task-recovery.mjs';
import {readInstalledSkills,settleSkillReload} from './mobilework-skill-resources.mjs';
import {windowState} from './mobilework-window-close.mjs';

const exec=promisify(execFile),helper=name=>fileURLToPath(new URL(name,import.meta.url));
const blocked=message=>Object.assign(Error(message),{blocked:true});
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const sameOptionalPath=(a,b)=>a===null&&b===null||samePath(a,b);
const within=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stages=['starting','recording','stopping','processing','generating','generated','replaying','settled'];
// Installed recording-control-contract: Host invalidates startup after 75 s.
const recordingStartTimeoutMs=75000;
const requireValue=(condition,message)=>{if(!condition)throw blocked(message);};
const exactKeys=(value,keys)=>requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key)),'SOP归属包含未约定字段');
const absolute=value=>typeof value==='string'&&path.isAbsolute(value);

// Follow the current product service's config directory, without reading its
// environment or exporting its authentication. A newly started recording must
// still be found here with this job's exact Session and tool message.
export async function resolveRecordingRuntimeDbPath(page,{runtimeDbPath}={}){
 if(runtimeDbPath){
  requireValue(absolute(runtimeDbPath),'显式录制运行库路径必须为绝对路径');
  return {runtimeDbPath,source:'explicit'};
 }
 const info=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo'));
 const base=new URL(info.baseUrl);
 requireValue(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)&&!base.username&&!base.password,'录制路径读取仅允许当前本机产品服务');
 const response=await fetch(info.baseUrl.replace(/\/$/,'')+'/status',{headers:{Authorization:'Bearer '+(info.clientToken||info.ownerToken)},signal:AbortSignal.timeout(5000)});
 requireValue(response.ok,'读取当前产品服务配置路径失败 HTTP '+response.status);
 const {server}=await response.json(),configPath=server?.configPath;
 requireValue(absolute(configPath),'当前产品服务未返回绝对配置路径，未猜测录制运行库位置');
 return {runtimeDbPath:path.join(path.dirname(configPath),'runtime.sqlite'),source:'server-config-default',configPath};
}

function validateSession(value){
 exactKeys(value,['id','directory','parentId','abortAcknowledged','sessionSettled','sessionMissing','recoveryAbortAttempted']);
 requireValue(/^ses_[A-Za-z0-9]+$/.test(value.id)&&absolute(value.directory),'SOP Session或实际目录无效');
}
function validateProcess(value){
 exactKeys(value,['pid','created','executable']);
 requireValue(Number.isInteger(value.pid)&&value.pid>0&&Number.isFinite(Date.parse(value.created))&&absolute(value.executable),'SOP进程身份无效');
}
// Only redacted, durable identities cross the controller checkpoint boundary.
export function validateRecordingResources(value,previous){
 exactKeys(value,['version','jobId','workspaceId','projectDir','runtimeDbPath','startedAt','stage','submissionAttempted','sourceSession','sourceContextMessageId','startOutcome','client','clientWindow','baselineRecordingIds','skillBaseline','recording','hostStopMessageId','generationIntent','generatedSkill','replaySession','childSessions','calculator','artifactSettled','continuationSettled','cleanupComplete']);
 requireValue(value.version===1&&typeof value.jobId==='string'&&value.jobId&&typeof value.workspaceId==='string'&&value.workspaceId&&absolute(value.projectDir)&&absolute(value.runtimeDbPath)&&Number.isFinite(Date.parse(value.startedAt))&&stages.includes(value.stage),'SOP初始归属或阶段无效');
 requireValue(['pending','started','not-started'].includes(value.startOutcome)&&Array.isArray(value.baselineRecordingIds)&&value.baselineRecordingIds.every(id=>typeof id==='string')&&Array.isArray(value.skillBaseline)&&value.skillBaseline.every(id=>typeof id==='string'),'SOP启动或技能基线无效');
 for(const key of ['submissionAttempted','artifactSettled','continuationSettled','cleanupComplete'])requireValue(typeof value[key]==='boolean','SOP终态标记无效');
 validateProcess(value.client);
 exactKeys(value.clientWindow,['hwnd','pid']);requireValue(Number.isInteger(value.clientWindow.hwnd)&&value.clientWindow.hwnd>0&&value.clientWindow.pid===value.client.pid,'SOP主窗口归属无效');
 for(const name of ['sourceSession','replaySession'])if(value[name]!==null)validateSession(value[name]);
 requireValue(Array.isArray(value.childSessions),'SOP子Session归属无效');for(const session of value.childSessions)validateSession(session);
 for(const name of ['sourceContextMessageId','hostStopMessageId'])requireValue(value[name]===null||typeof value[name]==='string'&&value[name].length>0,'SOP工具message归属无效');
 if(value.generationIntent){
  const intent=value.generationIntent;exactKeys(intent,['id','skillsRoot','archiveDirectory','startedAt','absentBefore','cleanupComplete']);
  requireValue(typeof intent.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(intent.id)&&!value.skillBaseline.includes(intent.id)&&absolute(intent.skillsRoot)&&absolute(intent.archiveDirectory)&&Number.isFinite(Date.parse(intent.startedAt))&&intent.absentBefore===true&&typeof intent.cleanupComplete==='boolean','SOP生成目标意图无效');
 }
 if(value.recording){
  const recording=value.recording;exactKeys(recording,['recordingId','sopId','createdAt','stepInfoFilePath','recorder','port','packageRoot','packageVersion','apiSha256']);
  requireValue(typeof recording.recordingId==='string'&&recording.recordingId&&typeof recording.sopId==='string'&&recording.sopId&&Number.isFinite(recording.createdAt)&&(recording.stepInfoFilePath===null||absolute(recording.stepInfoFilePath))&&recording.port===18002,'SOP录制绑定无效');
  if(recording.recorder)validateProcess(recording.recorder);
  if(recording.packageRoot!==null)requireValue(absolute(recording.packageRoot)&&typeof recording.packageVersion==='string'&&/^[a-f0-9]{64}$/.test(recording.apiSha256),'SOP实际组件来源无效');
 }
 if(value.generatedSkill){
  const skill=value.generatedSkill;exactKeys(skill,['id','path','installRoot','archivePath','files','recordingId','sopId','generationMessageId','generationCallId','delivered','removed']);
  requireValue(typeof skill.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(skill.id)&&absolute(skill.path)&&absolute(skill.installRoot)&&samePath(skill.path,path.join(skill.installRoot,skill.id))&&absolute(skill.archivePath)&&!value.skillBaseline.includes(skill.id)&&skill.recordingId===value.recording?.recordingId&&skill.sopId===value.recording?.sopId&&Array.isArray(skill.files)&&skill.files.length>0&&typeof skill.generationMessageId==='string'&&typeof skill.generationCallId==='string'&&typeof skill.delivered==='boolean'&&typeof skill.removed==='boolean'&&value.generationIntent?.id===skill.id&&samePath(value.generationIntent.skillsRoot,skill.installRoot),'SOP生成技能来源无效');
  for(const file of skill.files){exactKeys(file,['path','sha256']);requireValue(typeof file.path==='string'&&!path.isAbsolute(file.path)&&!file.path.split(/[\\/]/).includes('..')&&/^[a-f0-9]{64}$/.test(file.sha256),'SOP生成技能材料无效');}
 }
 if(value.calculator){
  const calculator=value.calculator;exactKeys(calculator,['baselineHwnds','hwnd','pid','created','openPending','closed','additionalWindows']);
  requireValue(Array.isArray(calculator.baselineHwnds)&&calculator.baselineHwnds.every(Number.isInteger)&&typeof calculator.openPending==='boolean'&&typeof calculator.closed==='boolean'&&Array.isArray(calculator.additionalWindows),'计算器基线无效');
  if(calculator.hwnd!==null)requireValue(Number.isInteger(calculator.hwnd)&&calculator.hwnd>0&&!calculator.baselineHwnds.includes(calculator.hwnd)&&Number.isInteger(calculator.pid)&&Number.isFinite(Date.parse(calculator.created)),'计算器窗口归属无效');
  for(const window of calculator.additionalWindows){exactKeys(window,['hwnd','pid','created','closed']);requireValue(Number.isInteger(window.hwnd)&&window.hwnd>0&&!calculator.baselineHwnds.includes(window.hwnd)&&window.hwnd!==calculator.hwnd&&Number.isInteger(window.pid)&&Number.isFinite(Date.parse(window.created))&&typeof window.closed==='boolean','回放新增计算器归属无效');}
 }
 if(value.cleanupComplete)requireValue(value.stage==='settled'&&(value.startOutcome==='not-started'||value.artifactSettled&&value.continuationSettled)&&(!value.generationIntent||value.generationIntent.cleanupComplete)&&(!value.generatedSkill||value.generatedSkill.removed)&&(!value.calculator||value.calculator.closed&&value.calculator.additionalWindows.every(window=>window.closed)),'SOP未完成收尾，不能移除归属');
 if(previous){
  for(const key of ['version','jobId','workspaceId','projectDir','runtimeDbPath','startedAt','client','clientWindow','baselineRecordingIds','skillBaseline'])requireValue(JSON.stringify(value[key])===JSON.stringify(previous[key]),'不能替换SOP原始基线：'+key);
  for(const key of ['sourceSession','replaySession'])if(previous[key])requireValue(value[key]?.id===previous[key].id&&samePath(value[key]?.directory,previous[key].directory),'不能替换SOP所属Session');
  if(previous.sourceContextMessageId)requireValue(value.sourceContextMessageId===previous.sourceContextMessageId,'不能替换SOP启动message');
  if(previous.generationIntent)for(const key of ['id','skillsRoot','archiveDirectory','startedAt','absentBefore'])requireValue(value.generationIntent?.[key]===previous.generationIntent[key],'不能替换SOP生成目标意图');
  if(previous.calculator){
   requireValue(JSON.stringify(value.calculator?.baselineHwnds)===JSON.stringify(previous.calculator.baselineHwnds),'不能替换计算器原窗口基线');
   if(previous.calculator.hwnd)for(const key of ['hwnd','pid','created'])requireValue(value.calculator?.[key]===previous.calculator[key],'不能替换录制源计算器窗口');
   for(const window of previous.calculator.additionalWindows)requireValue(value.calculator.additionalWindows.some(next=>next.hwnd===window.hwnd&&next.pid===window.pid&&next.created===window.created&&(!window.closed||next.closed)),'不能丢弃已归属的回放计算器窗口');
  }
  if(previous.recording){for(const key of ['recordingId','sopId','createdAt'])requireValue(value.recording?.[key]===previous.recording[key],'不能替换SOP实际绑定');if(previous.recording.stepInfoFilePath)requireValue(value.recording?.stepInfoFilePath===previous.recording.stepInfoFilePath,'不能替换SOP步骤路径');}
  if(previous.generatedSkill)for(const key of ['id','path','installRoot','archivePath','files','recordingId','sopId','generationMessageId','generationCallId','delivered'])requireValue(JSON.stringify(value.generatedSkill?.[key])===JSON.stringify(previous.generatedSkill[key]),'不能替换本轮生成技能');
  if(previous.submissionAttempted)requireValue(value.submissionAttempted,'不能撤销SOP实际提交意图');
  if(previous.startOutcome==='started')requireValue(value.startOutcome==='started','不能把已启录改成未启录');
  if(previous.cleanupComplete)requireValue(value.cleanupComplete,'不能撤销已完成SOP收尾');
 }
 return value;
}

async function processInfo(owned,action){
 const args=['-Action',action,'-ClientPid',String(owned.client.pid)];
 if(owned.recording?.recorder)args.push('-RecorderPid',String(owned.recording.recorder.pid));
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',helper('mobilework-recording-process.ps1'),...args],{windowsHide:true,encoding:'utf8'});
 const result=JSON.parse(stdout);
 for(const key of ['client',...(owned.recording?.recorder&&result.recorder?['recorder']:[])]){
  const expected=key==='client'?owned.client:owned.recording.recorder,actual=result[key];
  requireValue(actual.pid===expected.pid&&actual.created===expected.created&&samePath(actual.executable,expected.executable),'SOP进程创建时间或路径已变化，未接管');
 }
 return result;
}
async function database(owned,action,argument=''){
 const {stdout}=await exec(process.env.MW_PYTHON||'python',[helper('mobilework-recording-binding.py'),owned.runtimeDbPath,action,typeof argument==='string'?argument:JSON.stringify(argument)],{windowsHide:true,encoding:'utf8'});
 return JSON.parse(stdout);
}
async function sourceLog(connection,owned,{includeChildren=false}={}){
 requireValue(owned.sourceSession,'SOP源Session尚未交接，保留启动意图');
 const data=await readSessionLog({sessionId:owned.sourceSession.id,connection,includeChildren});
 if(includeChildren)requireValue(!data.collection.truncated&&!data.traceErrors.length,'SOP生成来源的真实子任务证据不完整');
 requireValue(samePath(data.session.directory,owned.sourceSession.directory),'SOP源Session真实目录已变化');return data;
}
const tools=data=>[data,...(data.children||[])].flatMap(log=>log.messages.filter(message=>message.info?.role==='assistant'&&message.info.sessionID===log.sessionId).flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool').map(part=>({messageId:message.info.id,callId:part.callID,tool:part.tool,state:part.state}))));
const recordingTool=(data,name)=>tools(data).filter(tool=>tool.tool===name);

export async function prepareRecordingResources(page,{jobId,workspaceId,projectDir,runtimeDbPath}){
 const cdp=await page.context().browser().newBrowserCDPSession();let pid;
 try{pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(process=>process.type==='browser')?.id;}finally{await cdp.detach();}
 requireValue(Number.isInteger(pid),'未确认MobileWork主进程');
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',helper('mobilework-recording-process.ps1'),'-Action','Client','-ClientPid',String(pid)],{windowsHide:true,encoding:'utf8'});
 const {client}=JSON.parse(stdout),windows=(await windowState(pid)).windows;
 requireValue(windows.length===1,'MobileWork真实主窗口不唯一');
 const owned={version:1,jobId,workspaceId,projectDir,runtimeDbPath,startedAt:new Date().toISOString(),stage:'starting',submissionAttempted:false,sourceSession:null,sourceContextMessageId:null,startOutcome:'pending',client,clientWindow:{pid,hwnd:windows[0].hwnd},baselineRecordingIds:[],skillBaseline:await readInstalledSkills(page,projectDir),recording:null,hostStopMessageId:null,generationIntent:null,generatedSkill:null,replaySession:null,childSessions:[],calculator:null,artifactSettled:false,continuationSettled:false,cleanupComplete:false};
 const baseline=await database(owned,'baseline');requireValue(!baseline.active.length,'已有活动SOP录制，未发送本轮开始指令');owned.baselineRecordingIds=baseline.ids;
 requireValue(!(await processInfo(owned,'Probe')).recorder,'18002存在未结束录制器，未发送本轮开始指令');
 return validateRecordingResources(owned);
}

export async function refreshRecordingBinding(page,owned,{checkpoint=async()=>{}}={}){
 const connection=await readEngineConnection(page),data=await sourceLog(connection,owned);
 const candidates=(await database(owned,'discover',{workspaceId:owned.workspaceId,sessionId:owned.sourceSession.id})).filter(row=>!owned.baselineRecordingIds.includes(row.recordingId));
 requireValue(candidates.length<=1,'本Session产生多条新录制，不能猜测本轮归属');
 if(!candidates.length)return {data,binding:null};
 const binding=candidates[0],starts=recordingTool(data,'recording_start').filter(tool=>tool.messageId===binding.sourceContextMessageId);
 requireValue(starts.length===1&&binding.createdAt>=Date.parse(owned.startedAt),'产品绑定未对应本Session真实recording_start工具');
 if(owned.sourceContextMessageId)requireValue(owned.sourceContextMessageId===binding.sourceContextMessageId,'产品绑定启动message已变化');
 owned.sourceContextMessageId=binding.sourceContextMessageId;
 if(!owned.recording){
  owned.recording={recordingId:binding.recordingId,sopId:binding.sopId,createdAt:binding.createdAt,stepInfoFilePath:binding.stepInfoFilePath,recorder:null,port:18002,packageRoot:null,packageVersion:null,apiSha256:null};await checkpoint();
 }else{
  requireValue(owned.recording.recordingId===binding.recordingId&&owned.recording.sopId===binding.sopId&&(!owned.recording.stepInfoFilePath||sameOptionalPath(owned.recording.stepInfoFilePath,binding.stepInfoFilePath)),'已登记录制绑定发生变化');
  if(!owned.recording.stepInfoFilePath&&binding.stepInfoFilePath)owned.recording.stepInfoFilePath=binding.stepInfoFilePath;
 }
 const start=starts[0];
 if(start.state?.status==='completed'){
  requireValue(absolute(binding.stepInfoFilePath),'启录工具已完成但产品步骤路径尚未持久化');
  owned.startOutcome='started';
  if(binding.status==='active'&&!owned.recording.recorder){
   const actual=await processInfo(owned,'Recorder'),manifest=JSON.parse(await fs.readFile(path.join(actual.packageRoot,'manifest.json'),'utf8'));
   const api=await fs.readFile(path.join(actual.packageRoot,'recorder-api.md'));
   requireValue(manifest.platform==='win32'&&manifest.arch==='x64','实际录制包平台不匹配');
   Object.assign(owned.recording,{recorder:actual.recorder,packageRoot:actual.packageRoot,packageVersion:manifest.packageVersion,apiSha256:sha(api)});
  }
  if(owned.stage==='starting')owned.stage=binding.status==='completed'?'processing':'recording';
 }
 if(binding.stopMessageId){
  const stop=recordingTool(data,'recording_stop').find(tool=>tool.messageId===binding.stopMessageId);
  requireValue(stop,'产品stop claim未对应本Session真实recording_stop工具');
  owned.hostStopMessageId=binding.stopMessageId;
 }
 await checkpoint();return {data,binding};
}

async function readBinding(owned){
 const binding=await database(owned,'binding',owned.recording.recordingId),recording=owned.recording;
 requireValue(binding.workspaceId===owned.workspaceId&&binding.sessionId===owned.sourceSession.id&&binding.sourceContextMessageId===owned.sourceContextMessageId&&binding.sopId===recording.sopId&&binding.createdAt===recording.createdAt&&sameOptionalPath(binding.stepInfoFilePath,recording.stepInfoFilePath),'持久录制绑定与本轮归属不一致');return binding;
}
async function recorderRequest(owned,route,body){
 const response=await fetch('http://127.0.0.1:18002'+route,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 requireValue(response.ok,'录制器接口HTTP '+response.status);
 const value=await response.json();requireValue(value.code===200,'录制器接口业务码 '+value.code);
 const data=value.data,recording=owned.recording;
 requireValue(data.status!=='idle','活动绑定却返回idle，不能当作本轮停止成功');
 requireValue(data.recordingId===recording.recordingId&&data.sopId===recording.sopId&&samePath(data.stepInfoFilePath,recording.stepInfoFilePath),'录制器接口返回了其他录制绑定');return data;
}
export async function requestRecordingStop(page,owned,{checkpoint=async()=>{}}={}){
 requireValue(owned.startOutcome==='started'&&owned.recording,'没有真实成功启录证据，未调用本地stop');
 const data=await sourceLog(await readEngineConnection(page),owned),binding=await readBinding(owned);
 requireValue(recordingTool(data,'recording_start').some(tool=>tool.messageId===owned.sourceContextMessageId&&tool.state?.status==='completed'),'真实启录工具未完成');
 if(binding.status==='completed')return {status:'completed',recordingId:binding.recordingId};
 requireValue(binding.status==='active'&&!binding.terminalCauseCode,'本轮录制已进入其他终态');
 await processInfo(owned,'Recorder');
 const before=await recorderRequest(owned,'/record_status');
 if(['finishing','processing','completed'].includes(before.status))return before;
 requireValue(['readyRecord','recording','pause'].includes(before.status),'录制器状态不支持正常停止');
 owned.stage='stopping';await checkpoint();
 const result=await recorderRequest(owned,'/stop_record',{sopId:owned.recording.sopId});
 requireValue(['finishing','processing','completed'].includes(result.status),'本轮正常停止尚未确认');
 owned.stage='processing';await checkpoint();return result;
}

export async function observeRecordingSettlement(owned){
 const binding=await readBinding(owned),callbackReceived=binding.deliveries.length>0;
 const callbackSettled=callbackReceived&&binding.deliveries.every(delivery=>['accepted','cancelled'].includes(delivery.status));
 const continuationSuppressed=!callbackReceived&&Boolean(owned.hostStopMessageId)&&binding.stopMessageId===owned.hostStopMessageId;
 const continuationSettled=callbackSettled||continuationSuppressed;
 let artifactSettled=false,hasRecordedSteps=false;
 if(binding.status==='completed'&&Number.isFinite(binding.artifactCompletedAt)&&!binding.terminalCauseCode){
  const file=await fs.lstat(owned.recording.stepInfoFilePath);requireValue(file.isFile()&&!file.isSymbolicLink(),'本轮步骤路径不是普通录制材料');
  const artifact=JSON.parse(await fs.readFile(owned.recording.stepInfoFilePath,'utf8'));
  artifactSettled=artifact.record_status==='finished'&&artifact.step_handle_status==='finished'&&artifact.pending_step_count===0;
  hasRecordedSteps=Array.isArray(artifact.steps)&&artifact.steps.length>0;
 }
 owned.artifactSettled=artifactSettled;owned.continuationSettled=continuationSettled;
 return {artifactSettled,hasRecordedSteps,callbackReceived,callbackSettled,continuationSuppressed,continuationSettled,binding};
}
export function canAdvanceRecordingSession(owned){
 return Boolean(owned&&!owned.cleanupComplete&&owned.startOutcome==='started'&&owned.artifactSettled&&owned.continuationSettled&&owned.generatedSkill?.delivered&&!owned.generatedSkill.removed&&['generated','replaying'].includes(owned.stage));
}

async function exists(file){try{return await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function prepareSkillGeneration(owned,{id,skillsRoot,archiveDirectory,checkpoint=async()=>{}}){
 requireValue(!owned.generationIntent&&owned.artifactSettled&&owned.continuationSettled,'生成意图已存在或录制尚未处理完成');
 requireValue(typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)&&!owned.skillBaseline.includes(id)&&absolute(skillsRoot)&&absolute(archiveDirectory)&&within(path.resolve(helper('../runs')),archiveDirectory),'生成目标或证据目录无效');
 requireValue(!await exists(path.join(skillsRoot,id)),'生成目标目录已有内容，未覆盖原技能');
 owned.generationIntent={id,skillsRoot,archiveDirectory,startedAt:new Date().toISOString(),absentBefore:true,cleanupComplete:false};owned.stage='generating';await checkpoint();return owned.generationIntent;
}

async function skillFiles(directory,prefix=''){
 const files=[];
 for(const item of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){
  requireValue(!item.isSymbolicLink(),'本轮生成技能含链接，未归属清理');const relative=path.join(prefix,item.name);
  if(item.isDirectory())files.push(...await skillFiles(directory,relative));else{requireValue(item.isFile(),'技能含非普通文件');files.push({path:relative,sha256:sha(await fs.readFile(path.join(directory,relative)))});}
 }return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function recordGeneratedSkill(page,owned,{id,skillPath,skillsRoot,archiveDirectory,generationMessageId,generationCallId,checkpoint=async()=>{}}){
 requireValue(owned.artifactSettled&&owned.continuationSettled,'录制处理及续轮未确认，未接纳生成技能');
 requireValue(!owned.skillBaseline.includes(id)&&(await readInstalledSkills(page,owned.projectDir)).includes(id),'生成技能不是本轮实际新增目录');
 requireValue(owned.generationIntent?.id===id&&samePath(owned.generationIntent.skillsRoot,skillsRoot)&&samePath(owned.generationIntent.archiveDirectory,archiveDirectory),'生成物没有匹配发送前登记的明确目标');
 requireValue(absolute(skillsRoot)&&samePath(skillPath,path.join(skillsRoot,id)),'生成技能未对应本轮明确的安装根');
 const runs=path.resolve(helper('../runs'));requireValue(absolute(archiveDirectory)&&within(runs,archiveDirectory),'生成技能副本须保留在本项目运行证据目录');
 const real=await fs.realpath(skillPath);requireValue(samePath(real,skillPath)&&path.basename(real)===id,'生成技能目录身份不匹配');
 const stat=await fs.lstat(real);requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'生成技能目录不是普通目录');
 const data=await sourceLog(await readEngineConnection(page),owned,{includeChildren:true}),tool=tools(data).find(tool=>tool.messageId===generationMessageId&&tool.callId===generationCallId&&tool.state?.status==='completed');
 requireValue(tool,'生成技能缺本Session实际已完成工具调用');
 requireValue(tool.tool==='result_file'&&Array.isArray(tool.state.input?.output_paths)&&tool.state.input.output_paths.some(file=>samePath(file,path.join(real,'SKILL.md'))),'真实result_file未登记本轮已安装SKILL.md');
 requireValue(tools(data).some(item=>item.tool==='read'&&item.state?.status==='completed'&&samePath(item.state.input?.filePath,owned.recording.stepInfoFilePath)),'生成前缺本Session真实步骤材料读取证据');
 const creator=buildTrace(data,{expectedSkills:['mobilework-skill-creator']});requireValue(creator.checks.every(check=>check.pass),'生成缺实际mobilework-skill-creator成功调用证据');
 const files=await skillFiles(real);requireValue(files.some(file=>file.path==='SKILL.md'),'本轮生成目录没有SKILL.md');
 await fs.mkdir(archiveDirectory,{recursive:true});
 for(const file of files){const target=path.join(archiveDirectory,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(real,file.path),target);}
 owned.generatedSkill={id,path:real,installRoot:skillsRoot,archivePath:archiveDirectory,files,recordingId:owned.recording.recordingId,sopId:owned.recording.sopId,generationMessageId,generationCallId,delivered:true,removed:false};owned.stage='generated';await checkpoint();return owned.generatedSkill;
}

export async function inspectCalculator(owned,{action='Inspect',hwnd,window,checkpoint=async()=>{}}={}){
 const invoke=async(args)=>{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',helper('mobilework-calculator.ps1'),...args],{windowsHide:true,encoding:'utf8'});return JSON.parse(stdout);};
 if(action==='Baseline'){
  requireValue(!owned.calculator,'计算器基线已登记');const before=await invoke(['-Action','Baseline']);
  owned.calculator={baselineHwnds:before.windows.map(window=>window.hwnd),hwnd:null,pid:null,created:null,openPending:false,closed:false,additionalWindows:[]};await checkpoint();return before;
 }
 requireValue(owned.calculator,'尚无本轮计算器基线');
 if(action==='Inventory'||action==='Adopt'){
  const inventory=await invoke(['-Action','Baseline']),known=[owned.calculator.hwnd,...owned.calculator.additionalWindows.map(item=>item.hwnd)];
  const unowned=inventory.windows.filter(item=>!owned.calculator.baselineHwnds.includes(item.hwnd)&&!known.includes(item.hwnd));
  if(action==='Inventory')return {...inventory,unowned};
  requireValue(owned.replaySession||owned.calculator.openPending,'只有本轮待交接启动/回放才能登记新增窗口');
  requireValue(unowned.length===1&&(!window||unowned[0].hwnd===window.hwnd&&unowned[0].pid===window.pid&&unowned[0].created===window.created),'新增计算器不能唯一对应本轮回放/启动');
  const actual=unowned[0],identity={hwnd:actual.hwnd,pid:actual.pid,created:actual.created};
  if(owned.calculator.openPending&&!owned.calculator.hwnd)Object.assign(owned.calculator,identity,{openPending:false});
  else owned.calculator.additionalWindows.push({...identity,closed:false});
  await checkpoint();return actual;
 }
 if(action==='Open'){
  requireValue(!owned.calculator.hwnd&&!owned.calculator.openPending,'本轮计算器已启动或交接未决，不重复启动');
  owned.calculator.openPending=true;await checkpoint();
  const actual=await invoke(['-Action','Open','-Baseline',JSON.stringify(owned.calculator.baselineHwnds)]);
  Object.assign(owned.calculator,{hwnd:actual.hwnd,pid:actual.pid,created:actual.created,openPending:false});await checkpoint();return actual;
 }
 requireValue(owned.calculator.hwnd&&!owned.calculator.openPending,'计算器窗口尚未唯一交接');
 const target=hwnd&&hwnd!==owned.calculator.hwnd?owned.calculator.additionalWindows.find(item=>item.hwnd===hwnd):owned.calculator;
 requireValue(target,'未登记该计算器窗口，不处理未知HWND');
 const result=await invoke(['-Action',action,'-Hwnd',String(target.hwnd),'-PidValue',String(target.pid),'-Created',target.created]);
 if(action==='Close'){requireValue(result.closed,'计算器仍在关闭中，保留本轮窗口归属');target.closed=true;await checkpoint();}
 return result;
}

async function recoverPendingGeneration(page,owned,connection,checkpoint){
 const added=(await readInstalledSkills(page,owned.projectDir)).filter(id=>!owned.skillBaseline.includes(id));
 requireValue(added.every(id=>id===owned.generationIntent?.id),'SOP期间出现未归属的新技能，不能仅因预定目标为空就释放空间/专家');
 const intent=owned.generationIntent;if(!intent||owned.generatedSkill||intent.cleanupComplete)return;
 const target=path.join(intent.skillsRoot,intent.id),actual=await exists(target),data=await sourceLog(connection,owned,{includeChildren:true}),calls=tools(data);
 const installs=calls.filter(tool=>tool.tool==='bash'&&String(tool.state?.input?.command||'').includes('scripts.install_skill'));
 if(!actual){
  requireValue(!installs.length,'生成安装曾启动但预定目标不存在，须核对实际安装/暂存去向后再释放');
  intent.cleanupComplete=true;await checkpoint();return;
 }
 requireValue(actual.isDirectory()&&!actual.isSymbolicLink()&&samePath(await fs.realpath(target),target),'未交付生成目标目录身份不明确');
 const files=await skillFiles(target);
 const delivered=calls.filter(tool=>tool.tool==='result_file'&&tool.state?.status==='completed'&&tool.state.input?.output_paths?.some(file=>samePath(file,path.join(target,'SKILL.md'))));
 if(delivered.length===1){
  await recordGeneratedSkill(page,owned,{id:intent.id,skillPath:target,skillsRoot:intent.skillsRoot,archiveDirectory:intent.archiveDirectory,generationMessageId:delivered[0].messageId,generationCallId:delivered[0].callId,checkpoint});return;
 }
 // The real creator's install command returns this JSON receipt before
 // result_file. Check its exact destination AND each installed file hash.
 const installed=installs.filter(tool=>tool.state?.status==='completed').map(tool=>{
  const text=String(tool.state.output||'').trim();if(!text.startsWith('{'))return null;
  return {tool,receipt:JSON.parse(text)};
 }).filter(item=>item?.receipt.status==='pass'&&item.receipt.skill===intent.id&&samePath(item.receipt.destination,target));
 requireValue(installed.length===1,'生成目标已出现但未取得唯一真实写入/安装凭据，保留目标及专家/空间，不泛删新增技能');
 const receipt=installed[0].receipt;
 requireValue(receipt.backup===null&&files.length===Object.keys(receipt.files).length&&files.every(file=>receipt.files[file.path.replaceAll('\\','/')]===file.sha256||receipt.files[file.path]===file.sha256),'未交付安装产物与真实回执/原目录基线不匹配');
 requireValue(buildTrace(data,{expectedSkills:['mobilework-skill-creator']}).checks.every(check=>check.pass),'未交付安装缺本Session真实creator调用');
 await fs.mkdir(intent.archiveDirectory,{recursive:true});
 for(const file of files){const archive=path.join(intent.archiveDirectory,file.path);await fs.mkdir(path.dirname(archive),{recursive:true});await fs.copyFile(path.join(target,file.path),archive);}
 owned.generatedSkill={id:intent.id,path:target,installRoot:intent.skillsRoot,archivePath:intent.archiveDirectory,files,recordingId:owned.recording.recordingId,sopId:owned.recording.sopId,generationMessageId:installed[0].tool.messageId,generationCallId:installed[0].tool.callId,delivered:false,removed:false};await checkpoint();
}

async function settleOwnedSessions(page,owned,connection,{allowAbort,checkpoint}){
 const roots=[owned.sourceSession,owned.replaySession].filter(Boolean);
 for(const root of roots){
  const data=await readSessionLog({sessionId:root.id,connection,includeChildren:true});
  requireValue(samePath(data.session.directory,root.directory)&&!data.collection.truncated&&!data.traceErrors.length,'SOP所属Session或子任务未完整核实');
  for(const child of data.children){
   const existing=owned.childSessions.find(session=>session.id===child.sessionId);
   if(existing)requireValue(samePath(existing.directory,child.session.directory)&&existing.parentId===child.session.parentID,'SOP子Session归属变化');
   else owned.childSessions.push({id:child.sessionId,directory:child.session.directory,parentId:child.session.parentID});
  }
 }
 await checkpoint();
 for(const session of [...roots,...owned.childSessions]){
  // A startup abort may precede a late finish continuation. Re-read actual
  // state even when this identity had been idle in an earlier cycle.
  const job={sessionId:session.id,directory:session.directory};
  const ready=await settleSession(page,job,connection,{allowAbort});
  for(const key of ['abortAcknowledged','sessionSettled','sessionMissing','recoveryAbortAttempted'])if(job[key]!==undefined)session[key]=job[key];
  await checkpoint();requireValue(ready,'SOP所属Session或真实子任务仍在运行/等待交互：'+session.id);
 }
 // After aborting the parent, re-read once: children created during handoff
 // must enter the next existing controller cycle, never escape this barrier.
 for(const root of roots){
  const after=await readSessionLog({sessionId:root.id,connection,includeChildren:true});
  requireValue(!after.collection.truncated&&!after.traceErrors.length&&after.children.every(child=>owned.childSessions.some(session=>session.id===child.sessionId)),'SOP停止期间出现尚未交接的真实子任务');
 }
}

// A single existing controller/recovery cycle invokes this function. No new
// polling loop, start request, synthetic callback, or silent process kill.
export async function settleRecordingResources(page,owned,{allowAbort=false,checkpoint=async()=>{},submittedSession=null,submissionPending=true}={}){
 validateRecordingResources(owned);
 if(owned.cleanupComplete)return {ready:true};
 const connection=await readEngineConnection(page);
 const sourceHandoff=!owned.sourceSession&&owned.stage==='starting';
 const replayHandoff=owned.sourceSession&&!owned.replaySession&&['generated','replaying'].includes(owned.stage)&&submittedSession?.id!==owned.sourceSession.id;
 if((sourceHandoff||replayHandoff)&&submittedSession){
  const hash='#/workspace/'+owned.workspaceId+'/session/'+submittedSession.id;
  requireValue(page.url()===submittedSession.url&&new URL(submittedSession.url).hash===hash,'SOP启动提交尚未与登记Session唯一交接');
  const session=await engineRequest(connection,'/session/'+submittedSession.id);requireValue(session.id===submittedSession.id&&absolute(session.directory),'SOP启动Session实际目录无效');
  owned[sourceHandoff?'sourceSession':'replaySession']={id:session.id,directory:session.directory};
  if(replayHandoff)owned.stage='replaying';
  await checkpoint();
 }
 requireValue(!(replayHandoff&&submissionPending&&!submittedSession),'SOP回放仍在提交交接，保留技能及所属资源');
 if(!owned.sourceSession){
  requireValue(!owned.submissionAttempted&&!submissionPending&&!submittedSession,'SOP尚在提交交接，不能清除启动意图');
  const baseline=await database(owned,'baseline');requireValue(baseline.ids.every(id=>owned.baselineRecordingIds.includes(id))&&!baseline.active.length,'准备阶段出现新录制绑定，不能当作尚未提交清除');
  requireValue(!(await processInfo(owned,'Probe')).recorder,'准备阶段存在未归属录制器，保留现场');
  requireValue(!owned.generationIntent,'尚未提交但已有生成意图，保留不一致归属');
  if(owned.calculator){requireValue(!owned.calculator.hwnd&&!owned.calculator.openPending&&!owned.calculator.additionalWindows.length,'尚未提交但原生计算器已启动，保留本轮窗口归属');owned.calculator.closed=true;}
  owned.startOutcome='not-started';owned.stage='settled';owned.cleanupComplete=true;await checkpoint();return {ready:true};
 }
 const {data,binding}=await refreshRecordingBinding(page,owned,{checkpoint});
 if(owned.startOutcome!=='started'){
  const starts=recordingTool(data,'recording_start'),running=starts.some(tool=>!['completed','error'].includes(tool.state?.status));
  if(allowAbort&&running){
   const job={sessionId:owned.sourceSession.id,...owned.sourceSession};await settleSession(page,job,connection,{allowAbort:true});
   for(const key of ['abortAcknowledged','sessionSettled','recoveryAbortAttempted'])if(job[key]!==undefined)owned.sourceSession[key]=job[key];await checkpoint();
   throw blocked('已请求停止启动回合，仍等待真实启录工具/产品绑定终态，未放行');
  }
  requireValue(!running&&!starts.some(tool=>tool.state?.status==='completed'),'录制启动尚未确认完成，保留现场');
  // Host's verified recording_start contract is 75 s. An engine abort can
  // stop waiting before Host work returns; wait out that actual startup
  // bound, then re-observe, rather than treating the tool error as no start.
  for(const start of starts)requireValue(Number.isFinite(start.state?.time?.end)&&Date.now()>=start.state.time.end+recordingStartTimeoutMs,'启录调用已中断，仍在产品75秒启动取消边界内，保留晚到绑定观察');
  requireValue(!binding||['aborted','expired'].includes(binding.status),'产品仍保留启动录制绑定，不能只中止模型后放行');
  requireValue(!(await processInfo(owned,'Probe')).recorder,'未成功启录但派生录制器仍存活，保留现场');
  if(binding){const actual=await readBinding(owned);requireValue(actual.deliveries.every(delivery=>['accepted','cancelled'].includes(delivery.status)),'失败启录仍有未决finish交付');}
  // A terminal source turn plus no binding/process is the negative proof;
  // an empty list while the model is still running is not.
  await settleOwnedSessions(page,owned,connection,{allowAbort,checkpoint});
  const after=await refreshRecordingBinding(page,owned,{checkpoint});
  requireValue(owned.startOutcome!=='started'&&(!after.binding||['aborted','expired'].includes(after.binding.status))&&!recordingTool(after.data,'recording_start').some(tool=>!['error'].includes(tool.state?.status)),'启动收尾期间出现晚到录制，继续按真实绑定处理');
  for(const start of recordingTool(after.data,'recording_start'))requireValue(Number.isFinite(start.state?.time?.end)&&Date.now()>=start.state.time.end+recordingStartTimeoutMs,'启动收尾期间出现刚结束的启录调用，继续观察产品75秒取消边界');
  requireValue(!(await processInfo(owned,'Probe')).recorder,'启动收尾期间出现晚到录制进程，保留归属');
  owned.startOutcome='not-started';
 }else{
  requireValue(binding&&!binding.terminalCauseCode&&['active','completed'].includes(binding.status),'已启录但产品终态异常，不能伪装处理完成');
  if(binding.status==='active')await requestRecordingStop(page,owned,{checkpoint});
  const settlement=await observeRecordingSettlement(owned);await checkpoint();
  requireValue(settlement.artifactSettled&&settlement.continuationSettled,'SOP材料或真实finish续轮尚未收尾，保留归属');
  await settleOwnedSessions(page,owned,connection,{allowAbort,checkpoint});
 }
 await recoverPendingGeneration(page,owned,connection,checkpoint);
 if(owned.calculator){
  const inventory=await inspectCalculator(owned,{action:'Inventory'});
  if(inventory.unowned.length)await inspectCalculator(owned,{action:'Adopt',checkpoint});
  requireValue(!owned.calculator.openPending,'计算器启动窗口尚未唯一交接，保留原生归属');
  if(owned.calculator.hwnd&&!owned.calculator.closed)await inspectCalculator(owned,{action:'Close',checkpoint});
  for(const window of owned.calculator.additionalWindows)if(!window.closed)await inspectCalculator(owned,{action:'Close',hwnd:window.hwnd,checkpoint});
  if(!owned.calculator.hwnd)owned.calculator.closed=true;
 }
 if(owned.generatedSkill&&!owned.generatedSkill.removed){
  const skill=owned.generatedSkill,installed=await readInstalledSkills(page,owned.projectDir);
  requireValue(!owned.skillBaseline.includes(skill.id),'不能移除用户原技能');
  if(installed.includes(skill.id)||await exists(skill.path)){
   requireValue(JSON.stringify(await skillFiles(skill.archivePath))===JSON.stringify(skill.files),'生成技能证据副本不完整，未移除原产物');
   requireValue(samePath(await fs.realpath(skill.path),skill.path)&&JSON.stringify(await skillFiles(skill.path))===JSON.stringify(skill.files),'本轮生成技能已变化，保留文件待确认');
   const result=await page.evaluate(({projectDir,id})=>window.__MOBILEWORK__.invoke('engine:removeSkill',{projectDir,id}),{projectDir:owned.projectDir,id:skill.id});requireValue(result.ok,'本轮生成技能卸载失败');
   await settleSkillReload(page,{waitForPrompt:true});requireValue(!(await readInstalledSkills(page,owned.projectDir)).includes(skill.id)&&!await exists(skill.path),'生成技能卸载尚未确认');
  }
  skill.removed=true;await checkpoint();
 }
 if(owned.generationIntent){owned.generationIntent.cleanupComplete=true;await checkpoint();}
 await processInfo(owned,'Client');
 const windows=(await windowState(owned.client.pid,{hwnd:owned.clientWindow.hwnd})).windows;
 requireValue(windows.length===1&&windows[0].visible&&!windows[0].minimized,'产品录制结束后的真实主窗口尚未恢复');
 owned.stage='settled';owned.cleanupComplete=true;await checkpoint();return {ready:true};
}
