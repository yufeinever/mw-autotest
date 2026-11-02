import {isRootSessionJob,isRootOwnedPage,rootSession,checkpointRootSubmission,registerRootSession,updateRootSummary,hasUnresolvedRoots} from './root-sessions.mjs';
import {settleRootSessions} from './root-session-recovery.mjs';
import {validateEngineConnection} from './engine-client.mjs';
import {validateSystemSettings} from '../scripts/mobilework-system-settings.mjs';
import {validateSystemStorage} from '../scripts/mobilework-default-storage.mjs';
import {validateWindowClose} from '../scripts/mobilework-window-close.mjs';
import {validateInvalidDirectory} from '../scripts/mobilework-storage-probe.mjs';
import {validateAccountMemory} from '../scripts/mobilework-account-memory.mjs';
import {validateConversationSettings} from '../scripts/mobilework-conversation-settings.mjs';
import {validateClientRestart,verifyClientRestartPort} from '../scripts/mobilework-client-restart.mjs';
import {validateModuleHandoff} from '../scripts/mobilework-module-handoff.mjs';
import {validateRecordingResources,canAdvanceRecordingSession} from '../scripts/mobilework-recording-workflow.mjs';
import {connectClient} from './client-connection.mjs';
import {validateKanbanOwnership} from '../scripts/mobilework-kanban.mjs';
import {validateAccountNetwork} from '../scripts/mobilework-account-network.mjs';
import {validateAccountExternal} from '../scripts/mobilework-account-external.mjs';
import {validateAccountLogout} from '../scripts/mobilework-account-logout.mjs';
import {validateSettingsPanel} from '../scripts/mobilework-account-settings.mjs';
import {isClientPageUrl} from './client-page.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {normalizeConfig} from './policy.mjs';
import {normalizeEdition,editionLabels} from './client-edition.mjs';
import {readEnvironment} from './environment.mjs';
import {readModelOptions} from '../scripts/mobilework-run-policy.mjs';
import {renderReport} from './report.mjs';
import {saveClientModel} from './model-config.mjs';
import {readSessionLogFromPage} from './session-log.mjs';
import {readCdpConfig,enableCdpConfig} from './cdp-config.mjs';
import {probeCdp,restartClient} from './cdp-restart.mjs';
import {discoverClientCdpPort} from './cdp-port.mjs';
import {killScript,stopSession,releaseOwnedLock,releaseNativeFolder,releaseKnowledge,releaseExpert,releaseTool,releaseSkill,releaseComposer,releaseSopRecording} from './stop-job.mjs';
import {canStopJob} from './stop-all.mjs';
import {startRecording} from './recording.mjs';
import {recordingLocation,recordingLocations,openWindowsFolder} from './recording-storage.mjs';
import {withClientCases} from './case-registry.mjs';
import {clientCases} from '../scripts/client-case-catalog.mjs';
import {scriptSuite,scriptsInSuite,suiteLabels} from './script-groups.mjs';
import {permissionCases} from '../scripts/permission-case-catalog.mjs';
import {loadJobTrace,jobSessionId} from './trace-store.mjs';
import {renderTrace} from './trace.mjs';
import {observatoryDocument} from './observatory-view.mjs';
import {collectBatches,publicJob} from './batches.mjs';
import {TaskScheduler} from './task-scheduler.mjs';
import {recoverJob} from './task-recovery.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export const projectRoot=path.resolve(here,'..');
const extensions=new Set(['.mjs','.js','.cjs','.py','.ps1','.cmd','.bat']);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8','.png':'image/png','.txt':'text/plain; charset=utf-8','.log':'text/plain; charset=utf-8'};
export async function defaultConsoleDataDir(base=path.join(projectRoot,'runtime-config','test-console')){
 let pointer;
 try{pointer=JSON.parse(await fs.readFile(path.join(base,'current-store.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return base;throw e;}
 if(pointer.version!==1||typeof pointer.relativePath!=='string')throw Error('控制台数据目录指针无效');
 const target=path.resolve(base,pointer.relativePath),relative=path.relative(base,target);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('控制台数据目录必须位于 test-console 内');
 await fs.access(path.join(target,'settings.json'));return target;
}
export async function createConsole({port=18888,dataDir,modelReader,traceReader,cooperativeDetector,recovery=recoverJob,sessionStopper=stopSession,lockReleaser=job=>releaseOwnedLock(job,projectRoot),recorderFactory=startRecording,folderOpener=openWindowsFolder,cdpConfigFile,clientProbe=probeCdp,discoverPort=discoverClientCdpPort,verifyRestartPort=verifyClientRestartPort,composerReleaser=releaseComposer}={}){
 dataDir??=await defaultConsoleDataDir();
 await fs.mkdir(dataDir,{recursive:true});
 const settingsPath=path.join(dataDir,'settings.json');
 let state;
 try{state=JSON.parse(await fs.readFile(settingsPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={config:normalizeConfig(),scripts:[]};}
 state.scripts=withClientCases(state.scripts,projectRoot);
 state.config=normalizeConfig(state.config);
 const currentBuildInfo=()=>cdpConfigFile||readEnvironment(state.config.clientEdition).buildInfoPath;
 const jobs=[],batches=[];const active=new Set(),batchStarting=new Set(),taskTokens=new Map(),taskRuntimes=new Map();let readingModels=false,editingCdp=false,unlocking=false;
 const token=randomBytes(24).toString('hex');
 const persist=()=>fs.writeFile(settingsPath,JSON.stringify(state,null,2));
 await persist();
 const savedJobs=await fs.readdir(path.join(dataDir,'jobs')).catch(()=>[]);
 for(const name of savedJobs){try{const job=JSON.parse(await fs.readFile(path.join(dataDir,'jobs',name,'job.json'),'utf8'));if(['RUNNING','QUEUED'].includes(job.status)||job.finalizing){job.status='INTERRUPTED';job.error='控制台重启，未自动重跑；请核对客户端状态';delete job.finalizing;delete job.stopRequested;}jobs.push(job);}catch{}}
 for(const job of jobs)if(['STARTING','RECORDING','FINALIZING'].includes(job.recording?.status))job.recording={...job.recording,status:'INTERRUPTED',available:false,error:'控制台已重启，原录像未确认完整保存'};
 jobs.sort((a,b)=>(a.queuedAt||a.startedAt).localeCompare(b.queuedAt||b.startedAt));
 const batchDir=path.join(dataDir,'batches');await fs.mkdir(batchDir,{recursive:true});
 const writeBatch=async batch=>{const file=path.join(batchDir,batch.id+'.json'),temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(batch,null,2));await fs.rename(temp,file);};
 for(const name of await fs.readdir(batchDir)){
  if(!/^[\w-]+\.json$/.test(name))continue;
  const batch=JSON.parse(await fs.readFile(path.join(batchDir,name),'utf8'));
  if(batch.submission==='SUBMITTING'){batch.submission='INTERRUPTED';batch.error='控制台重启，批次提交已中断；未自动启动剩余脚本。';batch.submissionEndedAt=new Date().toISOString();await writeBatch(batch);}
  batches.push(batch);
 }
 const scriptInfo=async item=>{
  try{
   const real=await fs.realpath(item.path);const s=await fs.stat(real);
   if(!s.isFile()||!extensions.has(path.extname(real).toLowerCase()))throw Error('不支持的脚本文件');
   const content=await fs.readFile(real,'utf8');
   const permission=permissionCases.some(c=>real===path.join(projectRoot,c.entry));
   const integrated=!item.unavailable&&(permission||real===path.join(projectRoot,'scripts','run-client-case001.mjs')||/MW_TEST_CONFIG_JSON|mobilework-run-policy/.test(content));
   const cooperative=cooperativeDetector?cooperativeDetector(real):permission||clientCases.some(item=>path.resolve(projectRoot,item.entry)===real);
   return {...item,exists:true,integrated,cooperative};
  }catch(e){return {...item,exists:false,integrated:false,error:e.message};}
 };
 const jobWrites=new Map();
 const writeJob=job=>{
  const contents=JSON.stringify(job,null,2),file=path.join(dataDir,'jobs',job.id,'job.json');
  const write=(jobWrites.get(job.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const temp=file+'.tmp';await fs.writeFile(temp,contents);
   for(let attempt=0;;attempt++){
    try{await fs.rename(temp,file);return;}
    catch(error){
     // Windows can briefly deny replacing a file held by a reader. Preserve
     // the complete temporary record; persistent failures still reach caller.
     if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(error.code)||attempt===2)throw error;
     await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
    }
   }
  });
  jobWrites.set(job.id,write);return write;
 };
 const recordings=new Map(),recordingFinishes=new Map(),workers=new Map(),finalizations=new Map();
 const finishRecording=(job,reason)=>{
  if(recordingFinishes.has(job.id))return recordingFinishes.get(job.id);
  const pending=recordings.get(job.id);if(!pending)return Promise.resolve();
  const finishing=(async()=>{
   try{const recorder=await pending;await recorder?.stop(reason);}
   catch(error){job.recording={...job.recording,status:'ERROR',available:false,error:error.message};}
   finally{recordings.delete(job.id);recordingFinishes.delete(job.id);}
  })();
  recordingFinishes.set(job.id,finishing);return finishing;
 };
 const scheduler=new TaskScheduler({changed:job=>{writeJob(job).catch(()=>{});if(['FAIL','STOPPED'].includes(job.status))active.delete(job.id);}});
 const connectionChecks=new Map(),connectionStates=new Map();
 const checkConnection=(port,{cached=false,clientEdition=state.config.clientEdition}={})=>{
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('CDP端口无效');
  const key=port+':'+clientEdition;
  if(connectionChecks.has(key))return connectionChecks.get(key);
  const previous=connectionStates.get(port);
  if(cached&&previous?.clientEdition===clientEdition&&Date.now()-Date.parse(previous.checkedAt)<10000)return Promise.resolve(previous);
  const pending=Promise.resolve().then(()=>clientProbe(port,{clientEdition})).catch(()=>({connected:false,error:'MobileWork连接检查失败，请重新连接。'})).then(result=>{
   const current={...result,port,clientEdition,checkedAt:new Date().toISOString()};connectionStates.set(port,current);return current;
  }).finally(()=>connectionChecks.delete(key));
  connectionChecks.set(key,pending);return pending;
 };
 const requireConnection=async config=>{
  const port=config.cdpPort;
  if(scheduler.renderer(port).preparationError)throw Error('客户端准备失败，队列已暂停：'+scheduler.renderer(port).preparationError+'；处理后点击“检查连接 / 重新连接”继续。');
  if(scheduler.renderer(port).connectionError)throw Error('MobileWork连接中断，队列已暂停；请点击“检查连接 / 重新连接”后继续。');
  // While a managed task is running, do not attach an extra inspection client.
  // Every queued entry will still run a fresh check when it takes its turn.
  const running=jobs.find(j=>j.status==='RUNNING');
  if(running){if((running.config.clientEdition||'enterprise')!==config.clientEdition)throw Error('执行中不能切换客户端版本');return;}
  const result=await checkConnection(port,{clientEdition:config.clientEdition});
  if(!result.connected)throw Error(result.error||'MobileWork连接不可用，请重新连接。');
 };
 const recovering=new Map();
 const updateQueueHolds=()=>{
  for(const job of jobs.filter(j=>j.status==='QUEUED')){
   const holders=[...scheduler.unresolved()].map(id=>jobs.find(j=>j.id===id)).filter(Boolean);
   if(holders.length)job.queueHold=holders.map(j=>`${j.name}：${j.handoff?.reason||'客户端交接待恢复'}`).join('；');
   else if(scheduler.renderer(job.config.cdpPort).preparationError)job.queueHold='客户端准备失败，等待处理后重试：'+scheduler.renderer(job.config.cdpPort).preparationError;
   else if(scheduler.renderer(job.config.cdpPort).connectionError)job.queueHold='连接不可用，等待重新连接：'+scheduler.renderer(job.config.cdpPort).connectionError;
   else delete job.queueHold;
  }
 };
 const rootRuntimes=job=>{
  let runtime=taskRuntimes.get(job.id);
  if(!(runtime instanceof Map)){runtime=new Map();taskRuntimes.set(job.id,runtime);}
  return runtime;
 };
 const settleRoots=async(job,allowAbort)=>{
  const result=await settleRootSessions(job,{runtimes:rootRuntimes(job),allowAbort,checkpoint:()=>writeJob(job)});
  if(!result.ready)throw Error(result.reason);
  return result;
 };
 const resourceCleanupNames=['确认SOP录制及所属会话收尾','确认全部根任务及各自资源结束','关闭本轮原生文件夹窗口','核对并移除本轮知识库注册','恢复本轮专家资源与历史','恢复本轮工具配置','移除本轮新增技能','恢复本轮附件、排队消息与权限'];
 const canRecoverCleanup=job=>!(job.cleanupErrors||[]).some(error=>!resourceCleanupNames.some(name=>error.startsWith(name+'：')));
 const reconcileHandoff=async(job,{allowAbort=false}={})=>{
  if(unlocking)return false;
  if(recovering.has(job.id)){
   const ready=await recovering.get(job.id);
   if(!allowAbort)return ready;
  }
  if(!scheduler.reserveRecovery(job)){job.handoff={ready:false,reason:'等待其他任务交还页面，尚未检查交接'};job.schedulingHold=true;return false;}
  const pending=(async()=>{
  try{
   if(job.recoveryConnection)await verifyRestartPort(job,job.recoveryConnection.port);
   const target=job.recoveryConnection?new Proxy(job,{get:(object,key)=>key==='config'?{...object.config,cdpPort:object.recoveryConnection.port}:object[key]}):job;
   await releaseSopRecording(target,{allowAbort,checkpoint:()=>writeJob(job)});
   if(isRootSessionJob(job))await settleRoots(target,allowAbort);
   await releaseNativeFolder(target);
   await releaseKnowledge(target);
   await releaseExpert(target,{checkpoint:()=>writeJob(job)});
   await releaseTool(target);
   await releaseSkill(target);
   await composerReleaser(target,{allowAbort,checkpoint:()=>writeJob(job)});
   job.cleanupErrors=(job.cleanupErrors||[]).filter(error=>!resourceCleanupNames.some(name=>error.startsWith(name+'：')));
   job.handoff=await recovery(target,{connection:taskRuntimes.get(job.id),allowAbort,jobs,checkpoint:()=>writeJob(job)});
   if(job.handoff.ready&&job.handoff.url)scheduler.renderer(job.config.cdpPort).expectedUrl=job.handoff.url;
   job.schedulingHold=!job.handoff.ready;
   if(job.schedulingHold)job.error=(job.result?.error||job.error?.split('；页面交接：')[0]||'')+'；页面交接：'+job.handoff.reason;
   else {
    delete job.ownedDraft;
    if(job.error?.includes('；页面交接：'))job.error=job.error.split('；页面交接：')[0];
    if(!job.finalizing&&!job.stopRequested&&job.cleanupStage==='收尾待处理'){
     job.cleanupStage='收尾完成';job.handoffRecoveredAt=new Date().toISOString();
     // Clear only framework recovery wording, never the persisted business result.
     job.error=job.result?.error||job.error?.split('；后续排队暂停：')[0]||'';
     if(/^(会话是否结束尚未确认|业务已结束，页面交接尚未确认)$/.test(job.error))job.error='';
     const line='\n['+new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date())+'] 页面交接已恢复，收尾完成；保留原业务结果。\n';
     append(job,line);await fs.appendFile(path.join(dataDir,'jobs',job.id,'执行日志.txt'),line);
    }
   }
   await writeJob(job);return job.handoff.ready;
  }catch(e){job.handoff={ready:false,reason:e.message};job.schedulingHold=true;await writeJob(job);return false;}
  finally{recovering.delete(job.id);scheduler.releaseRecovery(job);}
  })();
  recovering.set(job.id,pending);return pending;
 };
 // Rebuild holds after a restart without resuming or rewriting historical runs.
 for(const job of jobs.filter(j=>j.isolationVersion===2&&!j.forcedUnlock&&(j.schedulingHold||j.recordingResources||j.status==='INTERRUPTED'&&(hasUnresolvedRoots(j)||j.sessionId||j.ownedDraft||j.submissionPending||j.nativeFolder||j.knowledge||j.expertResources||j.toolResources||j.skillResources||j.composerResources)))){scheduler.locations.set(job.id,job.config.cdpPort);scheduler.renderer(job.config.cdpPort).unresolved.add(job.id);job.schedulingHold=true;}
 const recoveryTimer=setInterval(async()=>{
  if(editingCdp)return;
  for(const job of jobs.filter(j=>j.isolationVersion===2&&j.schedulingHold&&!j.stopRequested&&!j.finalizing&&canRecoverCleanup(j))){
   if(editingCdp)break;
   if(await reconcileHandoff(job,{allowAbort:false})&&!job.finalizing&&!job.stopRequested){taskRuntimes.delete(job.id);scheduler.finish(job.id);}
  }
  updateQueueHolds();
 },5000);recoveryTimer.unref();
 const append=(job,text)=>{job.log=(job.log+text).slice(-120000);};
 // One owner performs process, evidence, recording and page cleanup. A stop
 // arriving during normal finalization joins this same promise and escalates
 // the session cleanup; it cannot release the scheduler a second time.
 const finalizeJob=(job,{exitCode,executionError}={})=>{
  if(finalizations.has(job.id))return finalizations.get(job.id);
  const previousStatus=job.status;
  job.finalizing=true;job.status='RUNNING';job.phase=job.stopRequested?'STOPPING':'FINALIZING';
  job.cleanupStartedAt=new Date().toISOString();job.cleanupErrors=[];
  active.add(job.id);
  const finishing=(async()=>{
   let outcome=exitCode===undefined?previousStatus:exitCode===0?'EXITED':exitCode===2?'BLOCKED':'FAIL';
   if(executionError){outcome='FAIL';job.error=executionError.message;}
   let confirmed=false,stopHandled=false,stopMessage='';
   const step=async(name,action)=>{
    job.cleanupStage=name;await writeJob(job).catch(()=>{});
    try{await action();return true;}
    catch(error){job.cleanupErrors.push(name+'：'+error.message);return false;}
   };
   const stopWorker=async()=>{
    if(job.pid&&!job.processExited){
     await killScript(job);
     const worker=workers.get(job.id);
     if(worker)await worker.closed;
     job.processExited=true;
    }
   };
   const stopClient=async()=>{
    stopHandled=true;job.phase='STOPPING';
    if(!await step('结束脚本进程',stopWorker))return false;
    try{
     await releaseSopRecording(job,{allowAbort:true,checkpoint:()=>writeJob(job)});
     if(isRootSessionJob(job)){await settleRoots(job,true);stopMessage='本用例全部根任务已确认结束';}
     else stopMessage=job.modelCompleted||job.sessionSettled?'本条会话已结束，核对页面交接':await sessionStopper(job,{connection:taskRuntimes.get(job.id)});
     if(job.sessionId&&!job.modelCompleted&&!job.sessionSettled)job.abortAcknowledged=true;
    }catch(error){stopMessage='会话停止未确认：'+error.message;return false;}
    const hasClientState=Boolean(job.recordingResources||hasUnresolvedRoots(job)||job.sessionId||job.ownedDraft||job.submissionPending);
    if(job.cooperative&&hasClientState){
     let ready;
     try{ready=await reconcileHandoff(job,{allowAbort:true});}
     catch(error){stopMessage+='；页面交接：'+error.message;return false;}
     if(!ready)stopMessage+='；页面交接：'+job.handoff?.reason;
     return ready;
    }
    return true;
   };
   try{
    if(job.stopRequested||executionError)await step('结束脚本进程',stopWorker);
    await step('归档执行证据',async()=>{
     const worker=workers.get(job.id);if(job.processExited&&worker)await worker.closed;
     const reportMatches=[...job.log.matchAll(/^报告：(.+)$/gm)];
     if(reportMatches.length){
      job.reportPath=reportMatches.at(-1)[1].trim();
      try{const result=JSON.parse(await fs.readFile(path.join(path.dirname(job.reportPath),'执行结果.json'),'utf8'));if(['PASS','FAIL','BLOCKED','RESUMED','CHECKED','REVIEW'].includes(result.result))outcome=result.result;job.result=result;}catch{}
     }
     job.sessionId??=jobSessionId(job);
    });
    const sopReady=await step('确认SOP录制及所属会话收尾',()=>releaseSopRecording(job,{allowAbort:job.stopRequested||['FAIL','BLOCKED','REVIEW'].includes(outcome),checkpoint:()=>writeJob(job)}));
    const rootsReady=sopReady&&(!isRootSessionJob(job)||await step('确认全部根任务及各自资源结束',()=>settleRoots(job,job.stopRequested||['FAIL','BLOCKED','REVIEW'].includes(outcome))));
    if(rootsReady){
    await step('关闭本轮原生文件夹窗口',()=>releaseNativeFolder(job));
    await step('核对并移除本轮知识库注册',()=>releaseKnowledge(job));
    const expertsReady=await step('恢复本轮专家资源与历史',()=>releaseExpert(job,{checkpoint:()=>writeJob(job)}));
    await step('恢复本轮工具配置',()=>releaseTool(job));
    await step('移除本轮新增技能',()=>releaseSkill(job));
    if(expertsReady)await step('恢复本轮附件、排队消息与权限',()=>releaseComposer(job,{allowAbort:job.stopRequested||['FAIL','BLOCKED','REVIEW'].includes(outcome),checkpoint:()=>writeJob(job)}));
    }
    await step('保存录像并断开录制连接',()=>finishRecording(job,job.stopRequested?'stopped':'completed'));
    if(job.stopRequested)confirmed=await stopClient();
    else{
     job.cleanupStage='核对会话及页面交接';await writeJob(job).catch(()=>{});
     const hasClientState=Boolean(job.recordingResources||hasUnresolvedRoots(job)||job.sessionId||job.ownedDraft||job.submissionPending);
     confirmed=job.cooperative&&hasClientState?await reconcileHandoff(job,{allowAbort:['FAIL','BLOCKED','REVIEW'].includes(outcome)}):!Boolean(job.sessionId&&!job.modelCompleted&&!job.sessionSettled);
    }
   }catch(error){job.cleanupErrors.push('收尾异常：'+error.message);}
   finally{
    // Even a report or client error must not leave the encoder, task token or
    // local script lock behind. Retain only a genuinely unresolved handoff.
    await finishRecording(job,job.stopRequested?'stopped':'completed');
    if(!job.pid||job.processExited)await step('释放本次脚本锁',()=>lockReleaser(job));
    if(job.stopRequested&&!stopHandled)confirmed=await stopClient();
    confirmed=confirmed&&!job.cleanupErrors.length;
    const final={schedulingHold:!confirmed,status:job.stopRequested?(confirmed?'STOPPED':'BLOCKED'):outcome,error:job.stopRequested?'用户强制停止。'+stopMessage:job.error,
     endedAt:new Date().toISOString(),phase:'FINISHED',cleanupStage:confirmed?'收尾完成':'收尾待处理'};
    if(!['PASS','FAIL','BLOCKED','RESUMED','CHECKED','REVIEW','EXITED','STOPPED'].includes(final.status))final.status='FAIL';
    if(job.cleanupErrors.length)final.error=(final.error||'')+'；'+job.cleanupErrors.join('；');
    if(!confirmed)final.error=(final.error||(job.modelCompleted||job.sessionSettled?'业务已结束，页面交接尚未确认':'会话是否结束尚未确认'))+'；后续排队暂停：'+(job.cleanupErrors.join('；')||job.handoff?.reason||stopMessage||'待核对本会话');
    job.cleanupStage='保存收尾记录';
    const line='\n['+new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date())+'] '+final.cleanupStage+(final.error?'：'+final.error:'')+'\n';
    append(job,line);
    try{await fs.appendFile(path.join(dataDir,'jobs',job.id,'执行日志.txt'),line);await writeJob({...job,...final,finalizing:false,stopRequested:false});}
    catch(error){final.schedulingHold=true;final.status='BLOCKED';final.cleanupStage='收尾待处理';job.cleanupErrors.push('保存收尾记录：'+error.message);final.error=job.cleanupErrors.join('；');}
    Object.assign(job,final);delete job.finalizing;delete job.stopRequested;
    active.delete(job.id);taskTokens.delete(job.id);workers.delete(job.id);
    if(!job.schedulingHold)taskRuntimes.delete(job.id);
    finalizations.delete(job.id);scheduler.finish(job.id,{unresolved:job.schedulingHold});updateQueueHolds();
   }
  })();
  finalizations.set(job.id,finishing);return finishing;
 };
 const makeCommand=file=>{
  const ext=path.extname(file).toLowerCase();
  if(['.mjs','.js','.cjs'].includes(ext))return [process.execPath,[file]];
  if(ext==='.py')return ['python',['-u',file]];
  if(ext==='.ps1')return ['powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file]];
  if(/["%!^&|<>\r\n]/.test(file))throw Error('批处理路径包含不支持的字符');
  return ['cmd.exe',['/d','/c',file]];
 };
 const safeConfig=config=>{const safe=structuredClone(config);if(safe.provider)delete safe.provider.key;return safe;};
 const createBatch=async body=>{
  const ids=body.scriptIds,mode=body.mode||'single';
  const suite=body.suite||scriptSuite(state.scripts.find(s=>s.id===ids?.[0]));
  if(!Object.hasOwn(suiteLabels,suite))throw Error('用例分类无效');
  const group=scriptsInSuite(state.scripts,suite),eligible=group.filter(s=>!s.unavailable);
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw Error('批次需要不重复的脚本 ID 列表');
  if(!['single','all','range','selected'].includes(mode)||mode==='single'&&ids.length!==1)throw Error('批次执行方式无效');
  const scripts=[];
  for(const id of ids){const index=group.findIndex(s=>s.id===id);if(index<0)throw Error('批次不能混合不同分类或不存在的脚本');const script=await scriptInfo(group[index]);if(!script.exists||!script.integrated)throw Error(script.unavailable||script.name+'：文件不存在或未接入参数');scripts.push({scriptId:id,name:script.name,path:script.path,number:index+1});}
  if(mode==='all'&&(ids.length!==eligible.length||scripts.some((s,i)=>s.scriptId!==eligible[i].id)))throw Error('全部执行必须包含当前分类的全部可执行脚本并按列表排序');
  if(mode==='range'&&scripts.some((s,i)=>s.number!==scripts[0].number+i))throw Error('范围执行序号必须连续并按列表排序');
  if(mode==='selected')scripts.sort((a,b)=>a.number-b.number);
  const startedAt=new Date().toISOString(),label=mode==='all'?'全部执行':mode==='range'?`序号 ${scripts[0].number}-${scripts.at(-1).number}`:mode==='selected'?'勾选序号 '+scripts.map(s=>s.number).join('、'):'单条执行';
  const stamp=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace(/\//g,'').replace(/:/g,'');
  const batch={id:randomUUID(),suite,name:stamp+' · '+suiteLabels[suite]+' · '+label,mode,scope:mode==='single'?`序号 ${scripts[0].number} · ${scripts[0].name}`:suiteLabels[suite]+' · '+label+`（${scripts.length} 条）`,startedAt,submission:'SUBMITTING',scripts,config:safeConfig(normalizeConfig(body.config))};
  await writeBatch(batch);batches.push(batch);return batch;
 };
 const batchDetail=id=>collectBatches(batches,jobs).find(b=>b.id===id);
 const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
   const expectedHost=`127.0.0.1:${server.address().port}`;
   if(req.headers.host!==expectedHost)return send(403,{error:'仅接受本机127.0.0.1访问'});
   if(req.headers.origin&&req.headers.origin!==`http://${expectedHost}`)return send(403,{error:'拒绝跨站请求'});
   res.setHeader('X-Content-Type-Options','nosniff');
   res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self'");
   const url=new URL(req.url,`http://${expectedHost}`);
   let body={};
   const controlMatch=url.pathname.match(/^\/api\/task-control\/([\w-]+)\/(acquire|release|is-managed|completed|checkpoint)$/);
   if(req.method!=='GET'){
    if(controlMatch){if(!taskTokens.has(controlMatch[1])||req.headers['x-task-token']!==taskTokens.get(controlMatch[1]))return send(403,{error:'任务调度凭证无效'});}
    else if(req.headers['x-console-token']!==token)return send(403,{error:'请求凭证无效，请刷新页面'});
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>(controlMatch?200000:20000))throw Error('请求过大');}
    body=raw?JSON.parse(raw):{};
   }
   if(req.method==='POST'&&controlMatch){
    const id=controlMatch[1],action=controlMatch[2],job=jobs.find(j=>j.id===id);
    if(!job||job.stopRequested||job.finalizing||job.status!=='RUNNING')return send(409,{error:'任务已结束或正在收尾'});
    if(action==='acquire')return send(200,scheduler.acquire(id,body.phase,{rootKey:body.rootKey,currentUrl:body.currentUrl}));
    if(action==='release'){
     if(isRootSessionJob(job)&&body.runtime){
      const root=rootSession(job,body.rootKey);validateEngineConnection(body.runtime);rootRuntimes(job).set(root.key,body.runtime);
     }
     scheduler.release(id,body);
     if(!isRootSessionJob(job)&&body.runtime)taskRuntimes.set(id,body.runtime);
     await writeJob(job);return send(200,{ok:true});
    }
    if(action==='completed'){
     if(isRootSessionJob(job)){
      const root=rootSession(job,body.rootKey);root.modelCompleted=true;root.completedAt=new Date().toISOString();updateRootSummary(job);
     }else job.modelCompleted=true;
     job.phase='VERIFYING';await writeJob(job);return send(200,{ok:true});
    }
    if(action==='checkpoint'){
     if(scheduler.renderer(job.config.cdpPort).owner!==id)throw Error('没有页面操作权，不得登记草稿');
     if(body.draft){const d=body.draft;if(typeof d.url!=='string'||!isClientPageUrl(d.url)||typeof d.text!=='string'||!Array.isArray(d.skills)||!Array.isArray(d.selection))throw Error('草稿归属格式无效');}
     if(body.rootSessionVersion===1){
      if(job.recordingResources)throw Error('SOP录制生命周期不使用多根任务集合');
      if(job.sessionId||job.submissionPending||job.rootSessionVersion)throw Error('只能在首个根任务提交前开启集合模式');
      job.rootSessionVersion=1;job.expectedRootKeys=['A','B'];job.rootSessions=[];
     }
     if(body.rootSubmission){
      if(!isRootSessionJob(job))throw Error('根任务集合模式尚未开启');
      checkpointRootSubmission(job,body.rootSubmission);
     }
     if(body.rootSession){
      if(!isRootSessionJob(job))throw Error('根任务集合模式尚未开启');
      validateEngineConnection(body.runtime);
      const root=registerRootSession(job,body.rootSession);
      rootRuntimes(job).set(root.key,body.runtime);
     }
     if(isRootSessionJob(job)&&body.sessionId)throw Error('集合模式须显式登记根任务，不接受单Session覆盖');
     if(Object.hasOwn(body,'recordingResources')){
      const owned=body.recordingResources;
      if(owned===null){
       if(job.recordingResources&&!job.recordingResources.cleanupComplete)throw Error('SOP录制及所属资源尚未确认收尾，不能移除归属');
       delete job.recordingResources;
      }else{
       if(isRootSessionJob(job)||owned.jobId!==job.id)throw Error('SOP录制必须属于本条串行用例');
       validateRecordingResources(owned,job.recordingResources);
       const sessionIds=new Set([job.sessionId,body.sessionId,...(job.completedSessions||[]).map(item=>item.id)]);
       for(const session of [owned.sourceSession,owned.replaySession])if(session&&!sessionIds.has(session.id))throw Error('SOP录制来源及回放必须是本用例已登记的阶段会话');
       job.recordingResources=structuredClone(owned);
      }
     }
     if(body.preparationError){
      if(job.sessionId||job.submissionPending||typeof body.preparationError!=='string'||body.preparationError.length>400)throw Error('初始化失败登记无效');
      job.preparationError=body.preparationError;scheduler.pausePreparation(job,body.preparationError);updateQueueHolds();
     }
     if(body.continuing===true){job.modelCompleted=false;job.sessionSettled=false;}
     if(Object.hasOwn(body,'composerResources')){
      const owned=body.composerResources;
      if(owned===null){if(isRootSessionJob(job))throw Error('集合共享资源只能在全部根收尾后由控制台释放');delete job.composerResources;}
      else{
       if(typeof owned.url!=='string'||!isClientPageUrl(owned.url)||!Array.isArray(owned.attachments)||!Array.isArray(owned.queueTexts)||typeof owned.restorePermission!=='boolean'||[...owned.attachments,...owned.queueTexts].some(value=>typeof value!=='string'||!value))throw Error('输入区资源归属格式无效');
       if(owned.url!==job.sessionUrl&&owned.url!==job.ownedDraft?.url&&owned.url!==body.draft?.url&&owned.url!==scheduler.renderer(job.config.cdpPort).expectedUrl&&owned.url!==job.composerResources?.url&&!(isRootSessionJob(job)&&isRootOwnedPage(job,owned.url)))throw Error('输入区资源页面归属不匹配');
       if(owned.taskPin){
        const pin=owned.taskPin;
        if(typeof pin.title!=='string'||!pin.title||typeof pin.baseline!=='boolean')throw Error('本轮置顶恢复归属无效');
        if(pin.workspaceId!==undefined){
         if(typeof pin.workspaceId!=='string'||!owned.workspaceResources?.target||owned.workspaceResources.beforeIds.includes(pin.workspaceId)||typeof pin.sessionId!=='string'||!/^ses_[A-Za-z0-9]+$/.test(pin.sessionId)||!pin.title.endsWith('-'+pin.workspaceId)||new URL(owned.url).hash!=='#/workspace/'+pin.workspaceId+'/session')throw Error('空间置顶任务缺本轮空间及Session归属');
        }else if(!job.sessionId)throw Error('本轮置顶恢复归属无效');
        if(job.composerResources?.taskPin&&JSON.stringify(job.composerResources.taskPin)!==JSON.stringify(pin))throw Error('不能替换本轮置顶恢复归属');
       }
       if(owned.personalization){
        if(typeof owned.personalization.showLoadingTips!=='boolean'||!['concise','rigorous','friendly'].includes(owned.personalization.agentTone))throw Error('个性化恢复基线无效');
        if(job.composerResources?.personalization&&JSON.stringify(job.composerResources.personalization)!==JSON.stringify(owned.personalization))throw Error('不能替换本轮个性化恢复基线');
       }
       if(owned.accountMenuToken&&(typeof owned.accountMenuToken!=='string'||!/^[\da-f-]{36}$/.test(owned.accountMenuToken)))throw Error('账户菜单归属无效');
       if(owned.accountObservation){if(typeof owned.accountObservation!=='string'||!/^[\da-f-]{36}$/.test(owned.accountObservation)||!owned.accountMenuToken)throw Error('账户余额观察归属无效');if(job.composerResources?.accountObservation&&job.composerResources.accountObservation!==owned.accountObservation)throw Error('不能替换本轮余额观察身份');}
       if(owned.accountNetwork)validateAccountNetwork(owned.accountNetwork,job.composerResources?.accountNetwork);
       if(owned.accountExternal)validateAccountExternal(owned.accountExternal,job.composerResources?.accountExternal);
       if(owned.systemSettings)validateSystemSettings(owned.systemSettings,job.composerResources?.systemSettings);
       if(owned.windowClose){if(owned.windowClose.originUrl!==owned.url)throw Error('关闭窗口恢复页面归属不匹配');validateWindowClose(owned.windowClose,job.composerResources?.windowClose);}
       if(owned.invalidDirectory){validateInvalidDirectory(owned.invalidDirectory,job.composerResources?.invalidDirectory);const relative=path.relative(path.join(projectRoot,'runs'),owned.invalidDirectory.path);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('拒写目录必须位于测试证据目录');}
       if(owned.accountMemory){validateAccountMemory(owned.accountMemory,job.composerResources?.accountMemory);const ids=new Set([job.sessionId,...(job.completedSessions||[]).map(item=>item.id)]);if(owned.accountMemory.sourceSessions.some(id=>!ids.has(id)))throw Error('记忆来源必须是本用例登记的阶段会话');}
       if(owned.systemStorage){if(!owned.workspaceResources)throw Error('存储恢复缺本轮空间归属');validateSystemStorage(owned.systemStorage,job.composerResources?.systemStorage);}
       if(owned.conversationSettings)validateConversationSettings(owned.conversationSettings,job.composerResources?.conversationSettings);
       if(owned.clientRestart){if(owned.clientRestart.originUrl!==owned.url||!(owned.systemSettings?.kind==='theme'||['maf','instruction'].includes(owned.conversationSettings?.kind)))throw Error('重启缺原页面或对应设置恢复归属');validateClientRestart(owned.clientRestart,job.composerResources?.clientRestart,job.config.clientEdition);}
       if(owned.accountLogout){if(owned.accountLogout.originUrl!==owned.url)throw Error('本轮登出恢复页面归属不匹配');validateAccountLogout(owned.accountLogout,job.composerResources?.accountLogout);}
       if(owned.settingsPanel){if(owned.settingsPanel.originUrl!==owned.url)throw Error('本轮设置页面归属不匹配');validateSettingsPanel(owned.settingsPanel,job.composerResources?.settingsPanel);}
       if(owned.messageObservation&&(typeof owned.messageObservation!=='string'||!/^[\da-f-]{36}$/.test(owned.messageObservation)))throw Error('消息观察归属无效');
       if(owned.clipboardOwner&&(typeof owned.clipboardOwner!=='string'||!/^[\da-f-]{36}$/.test(owned.clipboardOwner)))throw Error('剪贴板恢复归属无效');
       if(owned.todoObservation&&(typeof owned.todoObservation!=='string'||!/^[\da-f-]{36}$/.test(owned.todoObservation)))throw Error('待办观察归属无效');
       if(owned.workbenchFilter&&!['全部','待办','进行中','已完成'].includes(owned.workbenchFilter.baseline))throw Error('待办筛选恢复基线无效');
       if(owned.explorerWindow&&(!Number.isInteger(owned.explorerWindow.hwnd)||owned.explorerWindow.hwnd<=0||typeof owned.explorerWindow.path!=='string'||!path.isAbsolute(owned.explorerWindow.path)||owned.explorerWindow.reveal!==undefined&&typeof owned.explorerWindow.reveal!=='boolean'))throw Error('Explorer窗口归属无效');
       if(owned.previewFullscreen&&typeof owned.previewFullscreen.file!=='string')throw Error('全屏预览文件归属无效');
       if(owned.workbenchLayout&&(typeof owned.workbenchLayout.file!=='string'||typeof owned.workbenchLayout.expanded!=='boolean'))throw Error('侧栏布局恢复基线无效');
       if(owned.previewZoom&&(typeof owned.previewZoom.file!=='string'||!Number.isFinite(owned.previewZoom.value)||typeof owned.previewZoom.iframe!=='boolean'))throw Error('预览缩放恢复基线无效');
       if(owned.moduleNavigation){const value=owned.moduleNavigation;if(value.originUrl!==owned.url||!isClientPageUrl(value.originUrl)||!['#/experts/staff','#/experts','#/experts/skills','#/experts/experts','#/experts/connectors','#/automation','#/explore','#/knowledge','#/kanban'].includes(value.targetHash))throw Error('模块页面恢复归属无效');validateModuleHandoff(value,job.composerResources?.moduleNavigation);}
       if(owned.kanban){if(owned.moduleNavigation?.targetHash!=='#/kanban'&&!(owned.kanban.task?.sessionId&&owned.url.endsWith('/session/'+owned.kanban.task.sessionId)))throw Error('看板资源缺模块或真实Session归属');validateKanbanOwnership(owned.kanban,job.composerResources?.kanban);}
       if(owned.caseReplay){const value=owned.caseReplay,previous=job.composerResources?.caseReplay;if(owned.moduleNavigation?.targetHash!=='#/explore'||typeof value.title!=='string'||!value.title||typeof value.assetId!=='string'||!value.assetId||typeof value.opening!=='boolean'||value.observation!==undefined&&!/^__mwAutotestReplay_[\da-f-]{36}$/.test(value.observation)||Object.keys(value).some(key=>!['title','assetId','opening','observation'].includes(key)))throw Error('案例只读回放归属无效');if(previous&&(previous.title!==value.title||previous.assetId!==value.assetId||previous.observation&&previous.observation!==value.observation))throw Error('不能替换本轮案例回放归属');}
       if(owned.caseTask){
        const value=owned.caseTask,previous=job.composerResources?.caseTask;
        if(!isClientPageUrl(value.originUrl)||typeof value.workspaceId!=='string'||!value.workspaceId||new URL(value.originUrl).hash!=='#/workspace/'+value.workspaceId+'/session'||typeof value.title!=='string'||!value.title||typeof value.assetId!=='string'||!value.assetId||typeof value.prompt!=='string'||!value.prompt.trim()||value.editedPrompt!==null&&typeof value.editedPrompt!=='string'||Object.keys(value).some(key=>!['originUrl','workspaceId','title','assetId','prompt','editedPrompt'].includes(key)))throw Error('做同款预填交接归属无效');
        if(!previous&&(!owned.caseReplay||owned.caseReplay.assetId!==value.assetId||owned.caseReplay.title!==value.title||owned.moduleNavigation?.originUrl!==value.originUrl))throw Error('做同款交接必须来自本轮登记案例');
        if(previous&&(['originUrl','workspaceId','title','assetId','prompt'].some(key=>value[key]!==previous[key])||previous.editedPrompt&&previous.editedPrompt!==value.editedPrompt))throw Error('不能替换本轮做同款提示及页面归属');
       }
       for(const resourceKey of ['knowledgeCreation','knowledgeSecondaryCreation'])if(owned[resourceKey]){
        const value=owned[resourceKey],previous=job.composerResources?.[resourceKey];
        if(owned.moduleNavigation?.targetHash!=='#/knowledge'&&!owned.knowledgeSelection||typeof value.name!=='string'||!/^MW-Autotest-KB-(114|115|116|117|118|119|120|122|123|124|125|126|127|128|129|130|131|132|133|134|135|136|137|138|139|140|141|142|143|144)-[a-f0-9]{8}$/.test(value.name)||!Array.isArray(value.beforeIds)||value.beforeIds.some(id=>typeof id!=='string')||typeof value.storageDir!=='string'||!path.isAbsolute(value.storageDir)||value.sourceDir!==null&&(typeof value.sourceDir!=='string'||!path.isAbsolute(value.sourceDir))||typeof value.submitted!=='boolean'||value.renamedName!==undefined&&value.renamedName!==value.name+'-改名'||value.id!==undefined&&value.id!==null&&(typeof value.id!=='string'||value.beforeIds.includes(value.id))||value.removing!==undefined&&typeof value.removing!=='boolean'||value.previewTitle!==undefined&&(typeof value.previewTitle!=='string'||!value.previewTitle.trim())||value.dialogToken!==undefined&&!/^[a-f0-9-]{36}$/.test(value.dialogToken)||value.removing&&!value.id||Object.keys(value).some(key=>!['name','beforeIds','storageDir','sourceDir','submitted','renamedName','id','removing','dialogToken','previewTitle','previewWikiId','previewToken','graphToken','scheduleTime','storageMove','modelMenuToken'].includes(key)))throw Error('知识库创建前归属无效');
        if(value.previewWikiId!==undefined||value.previewToken!==undefined){
         if(typeof value.id!=='string'||!value.id||typeof value.previewWikiId!=='string'||!value.previewWikiId.trim()||!(/^[a-f0-9-]{36}$/).test(value.previewToken))throw Error('Wiki预览缺少本轮知识库ID或目标/token归属');
         if(previous?.previewWikiId&&(previous.previewWikiId!==value.previewWikiId||previous.previewToken!==value.previewToken))throw Error('不能替换未收尾的本轮Wiki预览归属');
        }
        if(value.modelMenuToken!==undefined&&!/^[a-f0-9-]{36}$/.test(value.modelMenuToken))throw Error('解析模型菜单归属无效');
        if(value.graphToken!==undefined&&!/^[a-f0-9-]{36}$/.test(value.graphToken)||value.scheduleTime!==undefined&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.scheduleTime))throw Error('本轮图谱或更新计划归属无效');
        if(previous?.graphToken&&value.graphToken&&previous.graphToken!==value.graphToken||previous?.scheduleTime&&value.scheduleTime&&previous.scheduleTime!==value.scheduleTime)throw Error('不能替换本轮图谱或计划归属');
        if(value.storageMove){
         const move=value.storageMove,old=previous?.storageMove,relative=typeof move.to==='string'?path.relative(value.storageDir,move.to):'';
         if(!value.id||value.sourceDir!==null||!value.name.startsWith('MW-Autotest-KB-141-')||move.from!==value.storageDir||typeof move.to!=='string'||!path.isAbsolute(move.to)||!relative||!relative.startsWith('..')&&!path.isAbsolute(relative)||!['picking','submitted','completed','rejected'].includes(move.state)||Object.keys(move).some(key=>!['from','to','state'].includes(key)))throw Error('本轮存储迁移归属无效');
         if(old&&(old.from!==move.from||old.to!==move.to||old.state!=='picking'&&move.state==='picking'||['completed','rejected'].includes(old.state)&&old.state!==move.state))throw Error('不能替换本轮存储迁移目标或撤回终态');
        }else if(previous?.storageMove)throw Error('不能丢弃本轮存储迁移归属');
        if(previous&&['name','beforeIds','storageDir','sourceDir','renamedName'].some(key=>JSON.stringify(previous[key])!==JSON.stringify(value[key])))throw Error('不能替换本轮知识库创建基线');
        if(previous?.id&&previous.id!==value.id||previous?.removing&&!value.removing)throw Error('不能替换本轮知识库ID或撤回移除归属');
       }
       if(owned.knowledgeSelection){
        const value=owned.knowledgeSelection,previous=job.composerResources?.knowledgeSelection;
        const libraries=[owned.knowledgeCreation,owned.knowledgeSecondaryCreation].filter(Boolean);
        if(!Array.isArray(value.items)||value.items.length<1||value.items.length>2||new Set(value.items.map(item=>item.id)).size!==value.items.length||value.items.some(item=>!libraries.some(lib=>lib.id===item.id&&lib.name===item.name))||Object.keys(value).some(key=>key!=='items'))throw Error('本轮知识库引用归属无效');
        if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('不能替换本轮知识库引用归属');
       }
       if(owned.caseFavorites){
        const value=owned.caseFavorites,previous=job.composerResources?.caseFavorites;
        if(typeof value.accountId!=='string'||!value.accountId||!Array.isArray(value.targets)||value.targets.length!==5||new Set(value.targets.map(item=>item.id)).size!==5||value.targets.some(item=>typeof item.id!=='string'||!item.id||typeof item.title!=='string'||!item.title||typeof item.category!=='string'||!item.category)||!value.beforeHashes||Object.values(value.beforeHashes).some(hash=>!/^[a-f0-9]{64}$/.test(hash))||value.targets.some(item=>Object.hasOwn(value.beforeHashes,item.id))||Object.keys(value).some(key=>!['accountId','targets','beforeHashes'].includes(key)))throw Error('本轮五项案例收藏归属无效');
        if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('不能替换本轮收藏基线');
       }
       if(owned.automation){
        const value=owned.automation,previous=job.composerResources?.automation;
        if(typeof value.accountId!=='string'||!Array.isArray(value.beforeIds)||value.beforeIds.some(id=>typeof id!=='string')||!Array.isArray(value.hashes)||value.hashes.some(item=>typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.hash))||!Array.isArray(value.names)||value.names.length!==2||value.names.some(name=>!/^MW-AUTOTEST-(098|099|100|101|102|103)-[a-f0-9]{8}(-改名)?$/.test(name))||!isClientPageUrl(value.originUrl)||value.id!==null&&typeof value.id!=='string'||typeof value.creating!=='boolean'||typeof value.runPending!=='boolean'||!Array.isArray(value.beforeSessions)||value.beforeSessions.some(id=>!/^ses_[A-Za-z0-9]+$/.test(id))||!Number.isFinite(value.runStartedAt)||Object.keys(value).some(key=>!['accountId','beforeIds','hashes','names','originUrl','id','creating','runPending','beforeSessions','runStartedAt'].includes(key)))throw Error('自动化计划恢复归属无效');
        if(previous&&(['accountId','beforeIds','hashes','names','originUrl'].some(key=>JSON.stringify(value[key])!==JSON.stringify(previous[key]))||previous.id&&previous.id!==value.id||previous.runStartedAt&&previous.runStartedAt!==value.runStartedAt))throw Error('不能替换本轮自动化基线或运行归属');
       }
       if(owned.managedSkills){const value=owned.managedSkills;if(typeof value.projectDir!=='string'||!path.isAbsolute(value.projectDir)||!Array.isArray(value.installedBefore)||!Array.isArray(value.ids)||value.ids.length!==2||value.ids.some(id=>typeof id!=='string'||!/^mw-autotest-(?:import|created)-[a-z0-9-]+$/.test(id))||typeof value.marker!=='string'||!/^MW-AUTOTEST-093-[a-z0-9-]+$/.test(value.marker)||typeof value.pending!=='boolean'||!['import','create'].includes(value.pendingKind))throw Error('本轮合成技能归属无效');const before=job.composerResources?.managedSkills;if(before&&(before.projectDir!==value.projectDir||before.marker!==value.marker||JSON.stringify(before.installedBefore)!==JSON.stringify(value.installedBefore)||JSON.stringify(before.ids)!==JSON.stringify(value.ids)))throw Error('不能替换本轮合成技能基线');}
       if(owned.customTool){const value=owned.customTool;if(typeof value.projectDir!=='string'||!path.isAbsolute(value.projectDir)||typeof value.workspaceId!=='string'||!value.workspaceId||typeof value.accountId!=='string'||!/^MW-AUTOTEST-095-[a-z0-9-]+$/.test(value.name)||value.renamed!==value.name+'-改名'||value.url!=='http://127.0.0.1:9/mw-autotest'||value.id!==null&&typeof value.id!=='string'||!value.accountHashes||!value.globalHashes||[...Object.values(value.accountHashes),...Object.values(value.globalHashes)].some(hash=>!/^[a-f0-9]{64}$/.test(hash)))throw Error('本轮自定义工具归属无效');const before=job.composerResources?.customTool;if(before&&(before.name!==value.name||before.workspaceId!==value.workspaceId||before.accountId!==value.accountId||JSON.stringify(before.accountHashes)!==JSON.stringify(value.accountHashes)||JSON.stringify(before.globalHashes)!==JSON.stringify(value.globalHashes)))throw Error('不能替换本轮自定义工具基线');}
       if(owned.toolSelection&&(owned.toolSelection.name!=='腾讯文档'||typeof owned.toolSelection.baseline!=='boolean'||job.composerResources?.toolSelection&&job.composerResources.toolSelection.baseline!==owned.toolSelection.baseline))throw Error('工具任务选择恢复基线无效');
       if(owned.workspaceResources){const value=owned.workspaceResources;if(!Array.isArray(value.beforeIds)||typeof value.previousId!=='string'||!Array.isArray(value.sidebar)||typeof value.sectionExpanded!=='boolean'||!value.storage||Object.keys(value.storage).some(key=>!['openwork.react.workspaceOrder','openwork.react.activeWorkspace','openwork.react.newTaskDraftWorkspace','openwork.react.newTaskHomepageWorkspace'].includes(key))||value.target&&(typeof value.target.name!=='string'||!value.target.name||value.target.path&&!path.isAbsolute(value.target.path))||value.existingTargetId&&(!value.beforeIds.includes(value.existingTargetId)||value.target)||value.beforeSessionIds&&(!value.existingTargetId||!Array.isArray(value.beforeSessionIds)||value.beforeSessionIds.some(id=>typeof id!=='string'||!/^ses_[A-Za-z0-9]+$/.test(id))))throw Error('工作空间恢复归属无效');if(job.composerResources?.workspaceResources&&JSON.stringify(job.composerResources.workspaceResources)!==JSON.stringify(value))throw Error('不能替换本轮空间恢复基线');}
       if(owned.homeModel&&(typeof owned.homeModel.restore!=='string'||!owned.homeModel.restore||owned.homeModel.restore.length>256||owned.homeModel.value!==null&&(Array.isArray(owned.homeModel.value)?owned.homeModel.value.length!==2||owned.homeModel.value.some(part=>typeof part!=='string'||!part||part.length>1024):typeof owned.homeModel.value!=='string'||owned.homeModel.value.length>2048)||job.composerResources?.homeModel&&JSON.stringify(job.composerResources.homeModel)!==JSON.stringify(owned.homeModel)))throw Error('首页模型恢复归属无效');
       const shared=isRootSessionJob(job)?Object.fromEntries(['workspaceResources','homeModel'].filter(key=>job.composerResources?.[key]).map(key=>[key,job.composerResources[key]])):{};
       job.composerResources={url:owned.url,attachments:owned.attachments,queueTexts:owned.queueTexts,restorePermission:owned.restorePermission,...Object.fromEntries(['accountMenuToken','accountObservation','accountNetwork','accountExternal','accountLogout','settingsPanel','systemSettings','systemStorage','windowClose','invalidDirectory','accountMemory','conversationSettings','clientRestart','homeModel','taskPin','personalization','messageObservation','clipboardOwner','subSessionView','todoObservation','workbenchFilter','explorerWindow','previewFullscreen','workbenchLayout','previewZoom','workspaceResources','moduleNavigation','managedSkills','customTool','toolSelection','automation','caseReplay','caseTask','caseFavorites','knowledgeCreation','knowledgeSecondaryCreation','knowledgeSelection','kanban'].filter(key=>owned[key]).map(key=>[key,owned[key]])),...shared};
      }
     }
     if(Object.hasOwn(body,'nativeFolder')){
      const native=body.nativeFolder;
      if(native===null)delete job.nativeFolder;
      else{
       if(!Number.isInteger(native.pid)||native.pid<=0||!Number.isInteger(native.hwnd)||native.hwnd<=0||typeof native.path!=='string'||!path.isAbsolute(native.path))throw Error('原生窗口归属格式无效');
       if(job.nativeFolder)throw Error('本任务已有未收尾的原生窗口');
       job.nativeFolder={pid:native.pid,hwnd:native.hwnd,path:native.path};
      }
     }
     if(Object.hasOwn(body,'knowledge')){
      const knowledge=body.knowledge;
      if(knowledge===null)delete job.knowledge;
      else{
       if(typeof knowledge.id!=='string'||!knowledge.id||typeof knowledge.name!=='string'||!knowledge.name.startsWith('MW-Autotest-KB-')||typeof knowledge.storageDir!=='string'||!path.isAbsolute(knowledge.storageDir))throw Error('知识库归属格式无效');
       if(job.knowledge)throw Error('本任务已有未收尾的知识库');
       job.knowledge={id:knowledge.id,name:knowledge.name,storageDir:knowledge.storageDir};
      }
     }
     if(Object.hasOwn(body,'skillResources')){
      const owned=body.skillResources;
      if(owned===null)delete job.skillResources;
      else{
       if(!['office办公助手','Office办公助手','数据分析'].includes(owned.targetName)||!Array.isArray(owned.installedBefore)||typeof owned.projectDir!=='string'||!path.isAbsolute(owned.projectDir)||typeof owned.pending!=='boolean'||owned.id!==null&&typeof owned.id!=='string')throw Error('技能安装归属格式无效');
       if(job.skillResources&&(job.skillResources.targetName!==owned.targetName||job.skillResources.projectDir!==owned.projectDir||JSON.stringify(job.skillResources.installedBefore)!==JSON.stringify(owned.installedBefore)))throw Error('不能替换技能安装基线');
       job.skillResources={targetName:owned.targetName,installedBefore:owned.installedBefore,projectDir:owned.projectDir,id:owned.id,pending:owned.pending};
      }
     }
     if(Object.hasOwn(body,'toolResources')){
      const owned=body.toolResources;
      if(owned===null)delete job.toolResources;
      else{
       if(!['百度地图','TradingAgents 投研'].includes(owned.name)||owned.sample!==(owned.name==='百度地图'?'1234':'123456')||typeof owned.workspaceId!=='string'||!owned.workspaceId||typeof owned.projectDir!=='string'||!path.isAbsolute(owned.projectDir)||typeof owned.accountId!=='string'||!Array.isArray(owned.baselineIds)||!Array.isArray(owned.disabledBefore)||typeof owned.connecting!=='boolean')throw Error('工具资源归属格式无效');
       if(job.toolResources&&(job.toolResources.name!==owned.name||job.toolResources.globalCustomHash!==owned.globalCustomHash||JSON.stringify(job.toolResources.accountBefore)!==JSON.stringify(owned.accountBefore)))throw Error('不能替换工具配置基线');
       if(!Array.isArray(owned.globalCustomKeys)||owned.accountBefore&&(Object.keys(owned.accountBefore).some(key=>!['keys','customHash','customKeys','connected','lifecycleState'].includes(key))||owned.accountBefore.keys.some(key=>!['custom','connected','lifecycleState'].includes(key))))throw Error('工具基线不能登记密钥或完整配置');
       job.toolResources={name:owned.name,sample:owned.sample,workspaceId:owned.workspaceId,projectDir:owned.projectDir,accountId:owned.accountId,id:owned.id,baselineIds:owned.baselineIds,disabledBefore:owned.disabledBefore,hadGlobal:owned.hadGlobal,globalCustomHash:owned.globalCustomHash,globalCustomKeys:owned.globalCustomKeys,accountBefore:owned.accountBefore,connecting:owned.connecting};
      }
     }
     if(Object.hasOwn(body,'expertResources')){
      const owned=body.expertResources;
      if(owned===null)delete job.expertResources;
      else{
       if(!Array.isArray(owned.installedBefore)||!Array.isArray(owned.touchedNames)||owned.touchedNames.some(name=>!['AIPPT专家','文档生成专家','流程录制专家'].includes(name))||(owned.recentBefore!==null&&typeof owned.recentBefore!=='string')||!['','AIPPT专家','文档生成专家','流程录制专家'].includes(owned.installTarget)||typeof owned.installPending!=='boolean')throw Error('专家资源归属格式无效');
       if(typeof owned.workspaceId!=='string'||!owned.workspaceId||!['','AIPPT专家','文档生成专家','流程录制专家'].includes(owned.summonTarget))throw Error('专家召唤归属格式无效');
       if(job.expertResources&&(job.expertResources.recentBefore!==owned.recentBefore||JSON.stringify(job.expertResources.installedBefore)!==JSON.stringify(owned.installedBefore)))throw Error('不能替换专家资源基线');
       job.expertResources=owned;
      }
     }
     if(body.draft===null)delete job.ownedDraft;
     else if(body.draft){const d=body.draft;job.ownedDraft=d;await fs.writeFile(path.join(dataDir,'jobs',job.id,'草稿归属.json'),JSON.stringify({at:new Date().toISOString(),jobId:job.id,draft:d},null,2));}
     if(body.submitting){if(isRootSessionJob(job))throw Error('根任务提交须先登记唯一pending来源');job.submissionPending=true;}
     if(body.nextSession===true){
      if(isRootSessionJob(job))throw Error('活跃根任务不走串行阶段newSession');
      if(job.recordingResources&&!canAdvanceRecordingSession(job.recordingResources))throw Error('本轮SOP录制、续轮或技能生成尚未确认完成，不能新建回放会话');
      // The immutable workspace baseline belongs to the whole case; completed
      // stage Sessions can share its isolated workspace until final cleanup.
      if(!job.sessionId||!job.modelCompleted||job.submissionPending||job.ownedDraft||job.composerResources?.attachments.length||job.composerResources?.queueTexts.length||job.composerResources?.restorePermission||['accountMenuToken','accountObservation','accountNetwork','accountExternal','accountLogout','settingsPanel','systemSettings','systemStorage','windowClose','invalidDirectory','clientRestart','homeModel','taskPin','messageObservation','clipboardOwner','subSessionView','todoObservation','workbenchFilter','explorerWindow','previewFullscreen','workbenchLayout','previewZoom','moduleNavigation','managedSkills','customTool','toolSelection','automation','caseReplay','caseTask','caseFavorites','knowledgeCreation','knowledgeSecondaryCreation','knowledgeSelection','kanban'].some(key=>job.composerResources?.[key]))throw Error('上一阶段会话或输入区资源未完成，不能新建阶段会话');
      (job.completedSessions||=[]).push({id:job.sessionId,url:job.sessionUrl,completedAt:new Date().toISOString()});
      delete job.sessionId;delete job.sessionUrl;delete job.submittedSelection;
      job.modelCompleted=false;job.sessionSettled=false;taskRuntimes.delete(job.id);
     }
     if(body.sessionId){if(!/^ses_[A-Za-z0-9]+$/.test(body.sessionId)||!body.sessionUrl?.endsWith('/session/'+body.sessionId)||job.sessionId&&job.sessionId!==body.sessionId)throw Error('会话登记不一致');job.sessionId=body.sessionId;job.sessionUrl=body.sessionUrl;job.submissionPending=false;if(job.ownedDraft)job.submittedSelection=job.ownedDraft.selection;delete job.ownedDraft;}
     if(isRootSessionJob(job)&&Object.hasOwn(body,'composerResources')&&body.composerResources){
      const {workspaceResources,homeModel,...local}=body.composerResources;
      if(job.pendingSubmission?.key===body.rootKey)job.pendingSubmission.resources=structuredClone(local);
      else if(body.rootKey)rootSession(job,body.rootKey).resources=structuredClone(local);
     }
     await writeJob(job);return send(200,{ok:true});
    }
    return send(200,{managed:jobs.some(j=>j.config.cdpPort===job.config.cdpPort&&(j.sessionUrl===body.url||j.rootSessions?.some(root=>root.url===body.url)))});
   }
   if(req.method==='GET'&&url.pathname==='/api/state'){updateQueueHolds();return send(200,{token,projectRoot,dataDir,capabilities:{executionBatches:1,taskScheduling:1,taskIsolation:2,serialOnly:1,scriptSuites:1,scriptSource:1,detailPreview:1,executeNext:0,recording:1,recordingFolders:1,clientReadiness:1,adaptiveCdp:1,clientEditions:1},config:state.config,scripts:await Promise.all(state.scripts.map(scriptInfo)),jobs:jobs.map(publicJob),batches:collectBatches(batches,jobs).map(({entries,...batch})=>batch),active:active.size,readingModels});}
   const recordingFolder=url.pathname.match(/^\/api\/jobs\/([\w-]+)\/recording-(locations|folder)$/);
   if(recordingFolder&&((req.method==='GET'&&recordingFolder[2]==='locations')||(req.method==='POST'&&recordingFolder[2]==='folder'))){
    if(req.headers['x-console-token']!==token)return send(403,{error:'请求凭证无效，请刷新页面'});
    const job=jobs.find(j=>j.id===recordingFolder[1]);if(!job)return send(404,{error:'运行记录不存在'});
    const info=await recordingLocations(job,{dataDir,runsDir:path.join(projectRoot,'runs')});
    if(req.method==='GET')return send(200,info);
    if(!['primary','report'].includes(body.location))return send(400,{error:'录像位置无效'});
    const target=info.locations.find(item=>item.key===body.location);
    if(!target?.directoryExists)return send(404,{error:'录像文件夹不存在或已被删除'});
    await folderOpener(target.directory);return send(200,{message:'已请求打开文件夹',directory:target.directory});
   }
   const sourceMatch=url.pathname.match(/^\/api\/scripts\/([\w-]+)\/source$/);
   if(req.method==='GET'&&sourceMatch){
    if(req.headers['x-console-token']!==token)return send(403,{error:'请求凭证无效，请刷新页面'});
    const script=state.scripts.find(s=>s.id===sourceMatch[1]);if(!script)return send(404,{error:'脚本未登记或已移除'});
    const real=await fs.realpath(script.path),stat=await fs.stat(real);
    if(!stat.isFile()||!extensions.has(path.extname(real).toLowerCase()))return send(400,{error:'不支持的脚本文件'});
    if(stat.size>1024*1024)return send(413,{error:'脚本超过1MB，请在本地编辑器查看'});
    return send(200,{name:script.name,path:real,content:await fs.readFile(real,'utf8')});
   }
   const nextMatch=url.pathname.match(/^\/api\/jobs\/([\w-]+)\/next$/);
   if(req.method==='POST'&&nextMatch){
    return send(409,{error:'已取消并行和执行下条，请等待当前用例及收尾完成'});
   }
   if(req.method==='POST'&&url.pathname==='/api/locks/release'){
    if(body.confirm!==true||!Array.isArray(body.jobIds)||!body.jobIds.length)return send(400,{error:'请先确认占锁任务和解除影响'});
    if(unlocking||recovering.size||batchStarting.size||readingModels||editingCdp||jobs.some(j=>j.status==='RUNNING'||(j.stopRequested&&!['STOPPED','BLOCKED','FAIL','PASS','REVIEW','CHECKED','EXITED'].includes(j.status)))||[...active].some(id=>jobs.find(j=>j.id===id)?.status!=='QUEUED'))return send(409,{error:'仍有执行、停止或恢复操作，请先强制停止全部并等待结束，再解除锁定'});
    const holders=jobs.filter(j=>j.schedulingHold);
    if(holders.length!==body.jobIds.length||holders.some(j=>!body.jobIds.includes(j.id)))return send(409,{error:'占锁任务已变化，请刷新后重新确认'});
    if(holders.some(j=>j.recordingResources))return send(409,{error:'SOP录制仍有未确认的生命周期，请先完成该任务的强制停止及恢复，不能仅解除调度锁'});
    for(const j of holders)if(Number.isInteger(j.pid)&&j.pid>0){
     try{process.kill(j.pid,0);return send(409,{error:'占锁记录的脚本PID仍存在，请先核实并停止脚本，未解除锁定'});}catch(e){if(e.code!=='ESRCH')return send(409,{error:'无法确认占锁脚本已经退出，未解除锁定'});}
    }
    unlocking=true;
    try{
     const at=new Date().toISOString(),queued=jobs.filter(j=>j.status==='QUEUED');
     // Cancel every queued entry before releasing any hold: never launch a
     // forgotten task as a side effect of this administrative operation.
     for(const j of queued){j.status='STOPPED';j.phase='FINISHED';j.endedAt=at;j.error='强制解除锁定时取消排队，未发送客户端任务';active.delete(j.id);}
     for(const j of queued){scheduler.finish(j.id);await writeJob(j);}
     for(const j of holders){
      const previousHandoff=j.handoff,previousSubmissionPending=Boolean(j.submissionPending);
      // Keep provenance for diagnosis, but never automatically reuse an archived
      // signature after release. Only the live task-owned draft may be cleared.
      if(j.ownedDraft)j.releasedDraft=structuredClone(j.ownedDraft);
      let clientRecovery={ready:false,reason:'没有本任务草稿归属，未清理客户端'};
      if(j.ownedDraft){
       try{clientRecovery=await recovery(j,{connection:taskRuntimes.get(j.id),allowAbort:false,jobs,checkpoint:()=>writeJob(j)});}
       catch(e){clientRecovery={ready:false,reason:e.message};}
      }
      j.forcedUnlock={at,previousHandoff,previousSubmissionPending,sessionStopped:false,clientRecovery};
      j.schedulingHold=false;j.submissionPending=false;
      j.handoff={...clientRecovery,releasedByUser:true,reason:clientRecovery.ready?'本次草稿及页面交接已核对，调度锁已解除':'调度锁已解除，但客户端尚未就绪：'+clientRecovery.reason};
      if(clientRecovery.ready&&clientRecovery.url)scheduler.renderer(j.config.cdpPort).expectedUrl=clientRecovery.url;
      // Do not let a future recovery clear the original draft after a forced release.
      delete j.ownedDraft;taskTokens.delete(j.id);taskRuntimes.delete(j.id);active.delete(j.id);
      const message='用户强制解除控制台调度锁；未停止MobileWork会话，原测试结论保留。';
      append(j,'\n['+at+'] '+message+'\n');await fs.appendFile(path.join(dataDir,'jobs',j.id,'执行日志.txt'),'\n['+at+'] '+message+'\n');
      await writeJob(j);scheduler.finish(j.id);
     }
     const notReady=holders.filter(j=>!j.handoff.ready);
     updateQueueHolds();return send(200,{message:`已解除 ${holders.length} 条调度锁，取消 ${queued.length} 条排队。`+(notReady.length?'客户端尚未就绪：'+notReady.map(j=>j.name+'：'+j.forcedUnlock.clientRecovery.reason).join('；'):'本次草稿及页面交接已核对。')+' 未终止客户端会话，未自动重发。',released:holders.length,cancelled:queued.length,clientReady:notReady.length===0});
    }finally{unlocking=false;}
   }
   if(req.method==='POST'&&unlocking)return send(409,{error:'正在解除调度锁，请稍后再试'});
   if(req.method==='POST'&&url.pathname==='/api/batches'){
    if(readingModels||editingCdp)return send(409,{error:'正在读取模型或重启客户端，请等待完成'});
    await requireConnection(normalizeConfig(body.config));
    const batch=await createBatch(body);return send(201,{id:batch.id});
   }
   const batchMatch=url.pathname.match(/^\/api\/batches\/([\w-]+)(\/complete)?$/);
   if(req.method==='GET'&&batchMatch&&!batchMatch[2]){const batch=batchDetail(batchMatch[1]);return batch?send(200,batch):send(404,{error:'执行批次不存在'});}
   if(req.method==='POST'&&batchMatch&&batchMatch[2]){
    const batch=batches.find(b=>b.id===batchMatch[1]);if(!batch)return send(404,{error:'执行批次不存在'});
    if([...batchStarting].some(key=>key.startsWith(batch.id+':')))return send(409,{error:'批次仍有脚本正在启动，请稍后完成提交'});
    if(batch.submission!=='SUBMITTING')return send(200,{id:batch.id});
    const safeError=String(body.error||'').slice(0,2000).replace(/\b(?:sk-|ghp_|cfat_)[A-Za-z0-9_-]{10,}/g,'[已隐藏Key]');
    batch.submission='SUBMITTED';batch.submissionEndedAt=new Date().toISOString();
    const count=jobs.filter(j=>j.batchId===batch.id).length;
    if(safeError||count!==batch.scripts.length)batch.error=safeError||`仅启动 ${count}/${batch.scripts.length} 条，剩余未执行。`;
    await writeBatch(batch);return send(200,{id:batch.id});
   }
   if(req.method==='POST'&&url.pathname==='/api/client-edition'){
    if(active.size||readingModels||editingCdp||batchStarting.size)return send(409,{error:'执行或排队期间不能切换客户端版本'});
    const edition=normalizeEdition(body.clientEdition);
    state.editionConfigs??={};state.editionConfigs[state.config.clientEdition]=state.config;
    state.config=normalizeConfig(state.editionConfigs[edition]||{...state.config,clientEdition:edition,model:'自动',provider:{},cdpPort:9223});
    await persist();return send(200,{config:state.config,label:editionLabels[edition]});
   }
   if(req.method==='POST'&&url.pathname==='/api/config'){
    if(editingCdp)return send(409,{error:'正在检查或重启客户端，请稍后保存配置'});
    const next=normalizeConfig(body);
    if(next.clientEdition!==state.config.clientEdition&&(active.size||readingModels||batchStarting.size))return send(409,{error:'执行或排队期间不能切换客户端版本'});
    state.config=next;state.editionConfigs??={};state.editionConfigs[next.clientEdition]=next;
    await persist();return send(200,state.config);
   }
   if(req.method==='GET'&&url.pathname==='/api/cdp-config'){
    const port=state.config.cdpPort||9223,busy=editingCdp||readingModels||jobs.some(j=>j.status==='RUNNING');
    const connection=busy?{...(connectionStates.get(port)||{connected:false,port}),busy:true}:await checkConnection(port,{cached:true});
    const renderer=scheduler.renderer(port);
     return send(200,{...await readCdpConfig(currentBuildInfo()),...connection,clientEdition:state.config.clientEdition,connectionError:connection.error,preparationError:renderer.preparationError,handoffPending:scheduler.unresolved().size,paused:Boolean(renderer.connectionError||renderer.preparationError||scheduler.unresolved().size),restarting:editingCdp});
   }
   if(req.method==='POST'&&url.pathname==='/api/cdp-check'){
    if(editingCdp||readingModels||jobs.some(j=>j.status==='RUNNING'))return send(409,{error:'正在执行或收尾，请等待完成后检查连接。'});
    editingCdp=true;
    try{
    if(body.resume===true&&recovering.size)await Promise.all([...recovering.values()]);
    let port=Number(body.port||state.config.cdpPort||9223),result=await checkConnection(port),autoSwitched=false;
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('CDP端口无效');
    const idle=!active.size&&!batchStarting.size&&!recovering.size&&!scheduler.entries.length&&![...scheduler.renderers.values()].some(r=>r.owner||r.waiting.length);
    if(!result.connected&&idle){
     const discovered=await discoverPort({clientEdition:state.config.clientEdition});
     if(discovered?.port&&discovered.port!==port){
      const candidate=await checkConnection(discovered.port);
      if(candidate.connected){port=discovered.port;result=candidate;if(!scheduler.unresolved().size){state.config.cdpPort=port;await persist();autoSwitched=true;}}
     }
    }
     if(result.connected&&body.resume===true){
      const holders=[...scheduler.unresolved()].map(id=>jobs.find(j=>j.id===id)).filter(Boolean);
      if(holders.some(job=>job.config.cdpPort!==port)){
       if(!idle||holders.length!==1)throw Error('仍有其他执行、排队或待交接任务，不能切换恢复端口');
       const discovered=await discoverPort({clientEdition:state.config.clientEdition});
       if(discovered?.port!==port)throw Error('新端口未确认属于唯一的 MobileWork 主进程');
       const job=holders[0];job.recoveryConnection=await verifyRestartPort(job,port);await writeJob(job);
      }
      for(const id of [...scheduler.unresolved()]){
       const job=jobs.find(j=>j.id===id);
       if(!job||job.finalizing||job.stopRequested||!canRecoverCleanup(job))continue;
       if(job.config.cdpPort!==port&&job.recoveryConnection?.port!==port)continue;
       if(await reconcileHandoff(job,{allowAbort:false})){taskRuntimes.delete(job.id);scheduler.finish(job.id);}
      }
      if(!scheduler.unresolved().size&&port!==state.config.cdpPort){state.config.cdpPort=port;await persist();autoSwitched=true;}
      scheduler.resumeConnection(port);
     }
     const renderer=scheduler.renderer(port);
     updateQueueHolds();return send(200,{...result,autoSwitched,preparationError:renderer.preparationError,handoffPending:scheduler.unresolved().size,paused:Boolean(renderer.connectionError||renderer.preparationError||scheduler.unresolved().size)});
    }finally{editingCdp=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/cdp-config/restart'){
    if(active.size||readingModels||editingCdp||batchStarting.size||recovering.size||scheduler.entries.length||[...scheduler.renderers.values()].some(r=>r.owner||r.waiting.length||r.unresolved.size))return send(409,{error:'控制台仍有执行、排队或待交接任务，请处理完成后重试'});
    editingCdp=true;
    try{const port=Number(body.port||state.config.cdpPort||9223);const result=await restartClient(path.join(dataDir,'cdp-backups'),port,{clientEdition:state.config.clientEdition});state.config.cdpPort=result.port;await persist();return send(200,result);}finally{editingCdp=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/cdp-config/enable'){
    if(active.size||readingModels||editingCdp)return send(409,{error:'控制台正在执行操作，请结束后重试'});
    editingCdp=true;
    try{return send(200,await enableCdpConfig(path.join(dataDir,'cdp-backups'),currentBuildInfo()));}finally{editingCdp=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/models/save'){
    if(active.size||readingModels||editingCdp)return send(409,{error:'客户端正在被操作，请稍后保存模型'});
    readingModels=true;
    try{const c=normalizeConfig({...state.config,...body});if(c.clientEdition!==state.config.clientEdition)throw Error('请先切换客户端版本，再保存该版模型');const result=await saveClientModel(c);state.config=normalizeConfig({...state.config,model:result.model,provider:{}});state.editionConfigs??={};state.editionConfigs[state.config.clientEdition]=state.config;await persist();return send(200,result);}finally{readingModels=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/scripts'){
    if(typeof body.path!=='string'||!path.isAbsolute(body.path))throw Error('请输入脚本的绝对路径');
    const file=await fs.realpath(body.path.trim().replace(/^"|"$/g,''));
    if(state.scripts.some(s=>s.path.toLowerCase()===file.toLowerCase()))throw Error('脚本已经添加');
    if(body.suite!==undefined&&!Object.hasOwn(suiteLabels,body.suite))throw Error('用例分类无效');
    const item={id:randomUUID(),name:String(body.name||path.basename(file)).slice(0,100),path:file,suite:body.suite||'functional'};
    const info=await scriptInfo(item);if(!info.exists)throw Error(info.error);
    state.scripts.push(item);await persist();return send(201,info);
   }
   const remove=url.pathname.match(/^\/api\/scripts\/([\w-]+)$/);
   if(req.method==='DELETE'&&remove){if(jobs.some(j=>j.scriptId===remove[1]&&active.has(j.id)))throw Error('运行中的脚本不能移除');state.scripts=state.scripts.filter(s=>s.id!==remove[1]);await persist();return send(200,{ok:true});}
   if(req.method==='GET'&&url.pathname==='/api/browse'){
    const dir=await fs.realpath(url.searchParams.get('path')||path.join(projectRoot,'scripts'));
    const entries=await fs.readdir(dir,{withFileTypes:true});
    return send(200,{path:dir,parent:path.dirname(dir),entries:entries.filter(e=>e.isDirectory()||extensions.has(path.extname(e.name).toLowerCase())).map(e=>({name:e.name,path:path.join(dir,e.name),directory:e.isDirectory()})).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,'zh-CN'))});
   }
   if(req.method==='POST'&&url.pathname==='/api/models'){
    if(active.size||readingModels||editingCdp)return send(409,{error:'有任务正在操作客户端，请稍后读取模型'});
    const c=normalizeConfig(body);readingModels=true;
    try{
     if(modelReader)return send(200,await modelReader(c));
     const browser=await connectClient(`http://127.0.0.1:${c.cdpPort}`,{timeout:8000,clientEdition:c.clientEdition});
     try{
      const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
      if(pages.length!==1)throw Error('没有唯一的MobileWork主界面');
      const page=pages[0];
      if(await page.getByRole('button',{name:/^(停止|允许一次|跳过)$/,exact:true}).filter({visible:true}).count())throw Error('MobileWork 正在运行或等待交互，请结束后读取模型');
      return send(200,await readModelOptions(page,c));
     }finally{await browser.close();}
    }finally{readingModels=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/run'){
    if(readingModels||editingCdp)return send(409,{error:'正在读取模型或重启客户端，请等待完成'});
    let batch,startKey,ownsStart=false,automaticBatch=false;
    try{
     const item=state.scripts.find(s=>s.id===body.scriptId);if(!item)throw Error('脚本不存在');
     const info=await scriptInfo(item);if(!info.exists)throw Error(info.error);
     const runArgs=body.args??[];
     if(!Array.isArray(runArgs)||runArgs.length>1||runArgs.some(a=>typeof a!=='string'||!/^--(?:check|fill-check|resume=ses_[A-Za-z0-9]+)$/.test(a))||runArgs.length&&!info.cooperative)throw Error('脚本执行参数无效');
     if(!info.integrated)throw Error('此脚本尚未接入参数协议，请先读取 MW_TEST_CONFIG_JSON 再执行');
     const config=normalizeConfig(body.config);
     if(!body.batchId)await requireConnection(config);
     else if(scheduler.renderer(config.cdpPort).connectionError)throw Error('MobileWork连接不可用，批次暂停，请重新连接后继续。');
     const savedConfig=safeConfig(config);
     if(body.batchId){batch=batches.find(b=>b.id===body.batchId);if(!batch)throw Error('执行批次不存在');if(batch.submission!=='SUBMITTING')throw Error('批次提交已结束，不得追加执行');if(!batch.scripts.some(s=>s.scriptId===item.id))throw Error('脚本不属于本执行批次');if(JSON.stringify(batch.config)!==JSON.stringify(savedConfig))throw Error('本次参数与批次参数快照不一致');}
     else{batch=await createBatch({scriptIds:[item.id],mode:'single',config});automaticBatch=true;}
     startKey=batch.id+':'+item.id;
     if(batchStarting.has(startKey)||jobs.some(j=>j.batchId===batch.id&&j.scriptId===item.id))throw Error('本批次已经提交此脚本，未重复执行');
     batchStarting.add(startKey);
     ownsStart=true;
     const job={id:randomUUID(),batchId:batch.id,suite:scriptSuite(item),scriptId:item.id,name:item.name,path:item.path,config:savedConfig,status:'QUEUED',phase:'QUEUED',queuedAt:new Date().toISOString(),startedAt:null,log:'',reportPath:null};
     const jobDir=path.join(dataDir,'jobs',job.id);await fs.mkdir(jobDir,{recursive:true});
     await fs.writeFile(path.join(jobDir,'运行配置.json'),JSON.stringify(savedConfig,null,2));
     const [command,argv]=makeCommand(item.path);argv.push(...runArgs);job.args=runArgs;job.cooperative=info.cooperative;if(info.cooperative)job.isolationVersion=2;
     jobs.push(job);active.add(job.id);await writeJob(job);
     scheduler.enqueue(job,{cooperative:info.cooperative,start:async()=>{
     try{
     await writeJob(job);
     if(job.stopRequested||job.status!=='RUNNING')return;
     job.phase='CHECKING_CONNECTION';await writeJob(job);
     const connection=await checkConnection(config.cdpPort,{clientEdition:config.clientEdition});
     if(job.stopRequested||job.status!=='RUNNING')return;
     if(!connection.connected){
      scheduler.waitForConnection(job,connection.error||'MobileWork连接不可用，请重新连接');
      const line='\n['+new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date())+'] 执行前连接检查失败：'+job.connectionWait.reason+'；脚本和录像未启动，等待重新连接。\n';
      append(job,line);await fs.appendFile(path.join(jobDir,'执行日志.txt'),line);await writeJob(job);updateQueueHolds();return;
     }
     job.phase='PREPARING';await writeJob(job);
     if(config.recording.enabled&&!runArgs.includes('--check')){
      const pending=recorderFactory({config:config.recording,directory:path.join(dataDir,'recordings',job.id),cdpPort:config.cdpPort,clientEdition:config.clientEdition,onChange:async metadata=>{
       const previous=job.recording?.status;job.recording={...metadata,storage:'recordings'};
       if(previous!==metadata.status){
        const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date());
        const message=`\n[${stamp}] 录像 ${metadata.status}${metadata.stopReason==='limit'?'：达到时长上限，用例继续执行':''}${metadata.error?'：'+metadata.error:''}\n`;
        append(job,message);await fs.appendFile(path.join(jobDir,'执行日志.txt'),message);
       }
       await fs.writeFile(path.join(jobDir,'录像信息.json'),JSON.stringify(job.recording,null,2));await writeJob(job);
      }}).catch(async error=>{job.recording={status:'ERROR',error:error.message};await writeJob(job);return null;});
      recordings.set(job.id,pending);await pending;
     }else job.recording={status:config.recording.enabled?'SKIPPED':'DISABLED',config:config.recording};
     if(job.stopRequested||job.status!=='RUNNING'){await finishRecording(job,'stopped');return;}
     const taskToken=randomBytes(24).toString('hex');taskTokens.set(job.id,taskToken);
     const child=spawn(command,argv,{cwd:projectRoot,windowsHide:true,shell:false,env:{...process.env,MW_CLIENT_EDITION:config.clientEdition,MW_TEST_CONFIG_JSON:JSON.stringify(config),MW_MODEL_CONFIG_JSON:JSON.stringify(config.provider),MW_CDP_PORT:String(config.cdpPort),MW_CONSOLE_JOB_ID:job.id,...(info.cooperative?{MW_TASK_CONTROL_URL:`http://${expectedHost}/api/task-control/${job.id}`,MW_TASK_CONTROL_TOKEN:taskToken}:{}),PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
     job.pid=child.pid;
     const decoders=[new StringDecoder('utf8'),new StringDecoder('utf8')];
     const logPath=path.join(jobDir,'执行日志.txt');let chain=Promise.resolve();
     const consume=text=>{if(config.provider?.key)text=text.split(config.provider.key).join('[已隐藏Key]');append(job,text);chain=chain.then(()=>fs.appendFile(logPath,text)).catch(()=>{});};
     child.stdout.on('data',b=>consume(decoders[0].write(b)));child.stderr.on('data',b=>consume(decoders[1].write(b)));
     child.on('error',e=>{job.error=e.message;consume('\n启动失败：'+e.message+'\n');});
     const closed=new Promise(resolve=>child.once('close',code=>{
      job.exitCode=code;job.processExited=true;
      consume(decoders.map(d=>d.end()).join(''));
      void chain.finally(()=>{resolve();if(!job.endedAt)void finalizeJob(job,{exitCode:code});});
     }));
     workers.set(job.id,{child,closed});await writeJob(job);
     }catch(error){await finalizeJob(job,{executionError:error});}
     }});
     if(automaticBatch){batch.submission='SUBMITTED';batch.submissionEndedAt=new Date().toISOString();await writeBatch(batch);}
     return send(202,{id:job.id,batchId:batch.id});
    }catch(e){if(automaticBatch&&batch){batch.submission='SUBMITTED';batch.submissionEndedAt=new Date().toISOString();batch.error=e.message;await writeBatch(batch);}throw e;}
    finally{if(ownsStart)batchStarting.delete(startKey);}
   }
   const stopMatch=url.pathname.match(/^\/api\/jobs\/([\w-]+)\/stop$/);
   if(req.method==='POST'&&stopMatch){
    const job=jobs.find(j=>j.id===stopMatch[1]);
    if(!job)return send(404,{error:'运行记录不存在'});
    if(finalizations.has(job.id)){
     if(job.cleanupStage!=='保存收尾记录'){job.stopRequested=true;job.phase='STOPPING';}
     await finalizations.get(job.id);return send(200,{message:job.error||'收尾完成',status:job.status});
    }
    if(!canStopJob(job))return send(409,{error:'该脚本和会话已结束且无待解除锁，不重复操作历史任务'});
    if(job.status==='QUEUED'){
     job.status='STOPPED';job.phase='FINISHED';job.endedAt=new Date().toISOString();job.error='用户取消排队，未启动脚本、未向客户端发送任务';active.delete(job.id);scheduler.finish(job.id);await writeJob(job);return send(200,{message:job.error});
    }
    job.stopRequested=true;
    await finalizeJob(job);return send(200,{message:job.error,status:job.status});
   }
   const jobMatch=url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
   const traceMatch=url.pathname.match(/^\/traces\/([\w-]+)(\/download|\/observatory)?$/);
   if(req.method==='GET'&&traceMatch){
    const job=jobs.find(j=>j.id===traceMatch[1]);if(!job)return send(404,{error:'运行记录不存在'});
    if(!traceMatch[2]){res.writeHead(302,{Location:'/?trace='+encodeURIComponent(job.id)});res.end();return;}
    let trace,error;
    try{trace=await loadJobTrace(job,traceReader||(async sessionId=>{
     const browser=await connectClient(`http://127.0.0.1:${job.config?.cdpPort||state.config.cdpPort||9223}`,{timeout:8000,clientEdition:job.config?.clientEdition});
     try{const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
      if(pages.length!==1)throw Error('没有唯一的 MobileWork 主界面');
      return await readSessionLogFromPage(pages[0],{sessionId,includeChildren:true});
     }finally{await browser.close();}
    }));}catch(e){error=e.message;}
    res.setHeader('Cache-Control','no-store');
    if(traceMatch[2]==='/observatory'){
     if(!trace)return send(400,{error});
     res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-downloads");
     res.setHeader('Content-Type','text/html; charset=utf-8');res.end(observatoryDocument(trace.observatory));return;
    }
    if(traceMatch[2]){
     if(!trace)return send(400,{error});
     res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${jobSessionId(job)}-trace.json"`);res.end(JSON.stringify(trace,null,2));return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(renderTrace(job,trace,error));return;
   }
   const reportMatch=url.pathname.match(/^\/reports\/([\w-]+)$/);
   if(req.method==='GET'&&reportMatch){const job=jobs.find(j=>j.id===reportMatch[1]);if(!job)return send(404,{error:'运行记录不存在'});res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(renderReport({...job,sessionId:jobSessionId(job)}));return;}
   const sessionMatch=url.pathname.match(/^\/sessions\/([^/]+)\/(download)$/);
   if(req.method==='GET'&&sessionMatch){
    const sessionId=decodeURIComponent(sessionMatch[1]);
    if(!/^ses_[A-Za-z0-9]+$/.test(sessionId))throw Error('会话 ID 无效');
    const browser=await connectClient(`http://127.0.0.1:${state.config.cdpPort||9223}`,{timeout:8000,clientEdition:state.config.clientEdition});
    try{
     const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
     if(pages.length!==1)throw Error('没有唯一的 MobileWork 主界面');
     const page=pages[0],base=page.url().split('#')[0];
     if(sessionMatch[2]==='download'){
      const data=await readSessionLogFromPage(page,{sessionId,includeChildren:true});
      res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Disposition',`attachment; filename="${sessionId}-session-log.json"`);res.end(JSON.stringify(data,null,2));return;
     }
    }finally{await browser.close();}
   }
   if(req.method==='GET'&&jobMatch){const job=jobs.find(j=>j.id===jobMatch[1]);if(!job)return send(404,{error:'运行记录不存在'});return send(200,job);}
   const artifact=url.pathname.match(/^\/artifacts\/([\w-]+)\/(.+)$/);
   const video=url.pathname.match(/^\/recordings\/([\w-]+)(\/download)?$/);
   if(req.method==='GET'&&video){
    const job=jobs.find(j=>j.id===video[1]);if(!job?.recording?.available)return send(404,{error:'本次尚无已保存录像'});
    const stored=await recordingLocation(job,dataDir);if(!stored.exists)return send(404,{error:'录像文件已被移动或删除，报告和日志仍保留'});
    const file=stored.file,stat=await fs.stat(file);
    res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','no-store');
    if(video[2])res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(job.name+'-'+job.id+'.mp4'));
    let start=0,end=stat.size-1;
    if(req.headers.range){
     const match=req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
     if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});return res.end();}
     if(!match[1])start=Math.max(0,stat.size-Number(match[2]));else {start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}
     if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});return res.end();}
     res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);
    }
    res.setHeader('Content-Length',end-start+1);const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
   }
   if(req.method==='GET'&&artifact){
    const job=jobs.find(j=>j.id===artifact[1]);if(!job?.reportPath)throw Error('报告尚未生成');
    const base=await fs.realpath(path.dirname(job.reportPath));
    const target=await fs.realpath(path.resolve(base,decodeURIComponent(artifact[2])));
    const relative=path.relative(base,target);if(relative.startsWith('..')||path.isAbsolute(relative))return send(403,{error:'文件不在报告目录内'});
    const ext=path.extname(target).toLowerCase();
    const downloads=['.pptx','.docx','.xlsx','.pdf','.csv','.doc','.xls','.ppt','.zip','.html','.svg','.mjs','.js','.yml','.yaml','.mmd','.markmap'];
    if(!['.md','.json','.png','.txt','.log',...downloads].includes(ext))throw Error('不支持的证据格式');
    if(downloads.includes(ext)){
     res.setHeader('Content-Type','application/octet-stream');
     res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(path.basename(target)));
    }else res.setHeader('Content-Type',mime[ext]);
    res.end(await fs.readFile(target));return;
   }
   const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
   if(req.method==='GET'&&assets[url.pathname]){const file=assets[url.pathname];res.setHeader('Content-Type',mime[path.extname(file)]);res.end(await fs.readFile(path.join(here,file)));return;}
   send(404,{error:'未找到入口'});
  }catch(e){send(400,{error:e.message});}
 });
 server.on('close',()=>{clearInterval(recoveryTimer);for(const job of jobs.filter(j=>recordings.has(j.id)))void finishRecording(job,'console-closed');});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {server,url:`http://127.0.0.1:${server.address().port}`,dataDir};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {url}=await createConsole({port:Number(process.env.MW_CONSOLE_PORT||18888)});
 console.log('MobileWork 测试控制台：'+url);
}
