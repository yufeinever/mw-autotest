import {isClientPageUrl} from './client-page.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {chromium} from 'playwright-core';
import {normalizeConfig} from './policy.mjs';
import {readModelOptions} from '../scripts/mobilework-run-policy.mjs';
import {renderReport} from './report.mjs';
import {saveClientModel} from './model-config.mjs';
import {readSessionLog} from './session-log.mjs';
import {readCdpConfig,enableCdpConfig,buildInfoPath} from './cdp-config.mjs';
import {probeCdp,restartClient} from './cdp-restart.mjs';
import {killScript,stopSession,releaseOwnedLock} from './stop-job.mjs';
import {canStopJob} from './stop-all.mjs';
import {startRecording} from './recording.mjs';
import {recordingLocation,recordingLocations,openWindowsFolder} from './recording-storage.mjs';
import {withClientCases} from './case-registry.mjs';
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
export async function createConsole({port=18888,dataDir,modelReader,traceReader,cooperativeDetector,recovery=recoverJob,recorderFactory=startRecording,folderOpener=openWindowsFolder,cdpConfigFile=buildInfoPath}={}){
 dataDir??=await defaultConsoleDataDir();
 await fs.mkdir(dataDir,{recursive:true});
 const settingsPath=path.join(dataDir,'settings.json');
 let state;
 try{state=JSON.parse(await fs.readFile(settingsPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={config:normalizeConfig(),scripts:[]};}
 state.scripts=withClientCases(state.scripts,projectRoot);
 state.config=normalizeConfig(state.config);
 const jobs=[],batches=[];const active=new Set(),batchStarting=new Set(),taskTokens=new Map(),taskRuntimes=new Map();let readingModels=false,editingCdp=false,unlocking=false;
 const token=randomBytes(24).toString('hex');
 const persist=()=>fs.writeFile(settingsPath,JSON.stringify(state,null,2));
 await persist();
 const savedJobs=await fs.readdir(path.join(dataDir,'jobs')).catch(()=>[]);
 for(const name of savedJobs){try{const job=JSON.parse(await fs.readFile(path.join(dataDir,'jobs',name,'job.json'),'utf8'));if(['RUNNING','QUEUED'].includes(job.status)){job.status='INTERRUPTED';job.error='控制台重启，未自动重跑；请核对客户端状态';}jobs.push(job);}catch{}}
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
   const integrated=real===path.join(projectRoot,'scripts','run-client-case001.mjs')||/MW_TEST_CONFIG_JSON|mobilework-run-policy/.test(content);
   const cooperative=cooperativeDetector?cooperativeDetector(real):real.startsWith(path.join(projectRoot,'scripts')+path.sep)&&/^run-client-case(?:00[1-9]|01[0-6])\.mjs$/.test(path.basename(real));
   return {...item,exists:true,integrated,cooperative};
  }catch(e){return {...item,exists:false,integrated:false,error:e.message};}
 };
 const jobWrites=new Map();
 const writeJob=job=>{
  const contents=JSON.stringify(job,null,2),file=path.join(dataDir,'jobs',job.id,'job.json');
  const write=(jobWrites.get(job.id)||Promise.resolve()).catch(()=>{}).then(async()=>{const temp=file+'.tmp';await fs.writeFile(temp,contents);await fs.rename(temp,file);});
  jobWrites.set(job.id,write);return write;
 };
 const recordings=new Map();
 const finishRecording=async(job,reason)=>{
  const pending=recordings.get(job.id);
  if(pending){const recorder=await pending;await recorder?.stop(reason);recordings.delete(job.id);}
 };
 const scheduler=new TaskScheduler({changed:job=>{writeJob(job).catch(()=>{});if(['FAIL','STOPPED'].includes(job.status))active.delete(job.id);}});
 const recovering=new Set();
 const updateQueueHolds=()=>{
  for(const job of jobs.filter(j=>j.status==='QUEUED')){
   const holders=[...scheduler.renderer(job.config.cdpPort).unresolved].map(id=>jobs.find(j=>j.id===id)).filter(Boolean);
   if(holders.length)job.queueHold=holders.map(j=>`${j.name}：${j.handoff?.reason||'客户端交接待恢复'}`).join('；');
   else delete job.queueHold;
  }
 };
 const reconcileHandoff=async(job,{allowAbort=false}={})=>{
  if(unlocking)return false;
  if(recovering.has(job.id))return false;
  if(!scheduler.reserveRecovery(job)){job.handoff={ready:false,reason:'等待其他任务交还页面，尚未检查交接'};job.schedulingHold=true;return false;}
  recovering.add(job.id);
  try{
   job.handoff=await recovery(job,{connection:taskRuntimes.get(job.id),allowAbort,jobs});
   if(job.handoff.ready&&job.handoff.url)scheduler.renderer(job.config.cdpPort).expectedUrl=job.handoff.url;
   job.schedulingHold=!job.handoff.ready;
   if(job.schedulingHold)job.error=(job.result?.error||job.error?.split('；页面交接：')[0]||'')+'；页面交接：'+job.handoff.reason;
   else {delete job.ownedDraft;if(job.error?.includes('；页面交接：'))job.error=job.error.split('；页面交接：')[0];}
   await writeJob(job);return job.handoff.ready;
  }catch(e){job.handoff={ready:false,reason:e.message};job.schedulingHold=true;await writeJob(job);return false;}
  finally{recovering.delete(job.id);scheduler.releaseRecovery(job);}
 };
 // Rebuild holds after a restart without resuming or rewriting historical runs.
 for(const job of jobs.filter(j=>j.isolationVersion===2&&!j.forcedUnlock&&(j.schedulingHold||j.status==='INTERRUPTED'&&(j.sessionId||j.ownedDraft||j.submissionPending)))){scheduler.locations.set(job.id,job.config.cdpPort);scheduler.renderer(job.config.cdpPort).unresolved.add(job.id);job.schedulingHold=true;}
 const recoveryTimer=setInterval(async()=>{
  for(const job of jobs.filter(j=>j.isolationVersion===2&&j.schedulingHold&&!j.stopRequested)){
   if(await reconcileHandoff(job,{allowAbort:false}))scheduler.finish(job.id);
  }
  updateQueueHolds();
 },5000);recoveryTimer.unref();
 const append=(job,text)=>{job.log=(job.log+text).slice(-120000);};
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
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw Error('批次需要不重复的脚本 ID 列表');
  if(!['single','all','range','selected'].includes(mode)||mode==='single'&&ids.length!==1)throw Error('批次执行方式无效');
  const scripts=[];
  for(const id of ids){const index=state.scripts.findIndex(s=>s.id===id);if(index<0)throw Error('批次包含不存在的脚本');const script=await scriptInfo(state.scripts[index]);if(!script.exists||!script.integrated)throw Error(script.name+'：文件不存在或未接入参数');scripts.push({scriptId:id,name:script.name,path:script.path,number:index+1});}
  if(mode==='all'&&(ids.length!==state.scripts.length||scripts.some((s,i)=>s.scriptId!==state.scripts[i].id)))throw Error('全部执行必须包含当前全部脚本并按列表排序');
  if(mode==='range'&&scripts.some((s,i)=>s.number!==scripts[0].number+i))throw Error('范围执行序号必须连续并按列表排序');
  if(mode==='selected')scripts.sort((a,b)=>a.number-b.number);
  const startedAt=new Date().toISOString(),label=mode==='all'?'全部执行':mode==='range'?`序号 ${scripts[0].number}-${scripts.at(-1).number}`:mode==='selected'?'勾选序号 '+scripts.map(s=>s.number).join('、'):'单条执行';
  const stamp=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace(/\//g,'').replace(/:/g,'');
  const batch={id:randomUUID(),name:stamp+' · '+label,mode,scope:mode==='single'?`序号 ${scripts[0].number} · ${scripts[0].name}`:label+`（${scripts.length} 条）`,startedAt,submission:'SUBMITTING',scripts,config:safeConfig(normalizeConfig(body.config))};
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
    if(!job||job.stopRequested||job.status!=='RUNNING')return send(409,{error:'任务已结束或正在停止'});
    if(action==='acquire')return send(200,scheduler.acquire(id,body.phase));
    if(action==='release'){scheduler.release(id,body);if(body.runtime)taskRuntimes.set(id,body.runtime);await writeJob(job);return send(200,{ok:true});}
    if(action==='completed'){job.modelCompleted=true;job.phase='VERIFYING';await writeJob(job);return send(200,{ok:true});}
    if(action==='checkpoint'){
     if(scheduler.renderer(job.config.cdpPort).owner!==id)throw Error('没有页面操作权，不得登记草稿');
     if(body.draft){const d=body.draft;if(typeof d.url!=='string'||!isClientPageUrl(d.url)||typeof d.text!=='string'||!Array.isArray(d.skills)||!Array.isArray(d.selection))throw Error('草稿归属格式无效');job.ownedDraft=d;await fs.writeFile(path.join(dataDir,'jobs',job.id,'草稿归属.json'),JSON.stringify({at:new Date().toISOString(),jobId:job.id,draft:d},null,2));}
     if(body.submitting)job.submissionPending=true;
     if(body.sessionId){if(!/^ses_[A-Za-z0-9]+$/.test(body.sessionId)||!body.sessionUrl?.endsWith('/session/'+body.sessionId)||job.sessionId&&job.sessionId!==body.sessionId)throw Error('会话登记不一致');job.sessionId=body.sessionId;job.sessionUrl=body.sessionUrl;job.submissionPending=false;if(job.ownedDraft)job.submittedSelection=job.ownedDraft.selection;delete job.ownedDraft;}
     await writeJob(job);return send(200,{ok:true});
    }
    return send(200,{managed:jobs.some(j=>j.sessionUrl===body.url&&j.config.cdpPort===job.config.cdpPort)});
   }
   if(req.method==='GET'&&url.pathname==='/api/state'){updateQueueHolds();return send(200,{token,projectRoot,dataDir,capabilities:{executionBatches:1,taskScheduling:1,taskIsolation:2,serialOnly:1,scriptSource:1,detailPreview:1,executeNext:0,recording:1,recordingFolders:1},config:state.config,scripts:await Promise.all(state.scripts.map(scriptInfo)),jobs:jobs.map(publicJob),batches:collectBatches(batches,jobs).map(({entries,...batch})=>batch),active:active.size,readingModels});}
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
    if(unlocking||recovering.size||batchStarting.size||readingModels||editingCdp||jobs.some(j=>j.status==='RUNNING'||j.stopRequested)||[...active].some(id=>jobs.find(j=>j.id===id)?.status!=='QUEUED'))return send(409,{error:'仍有执行、停止或恢复操作，请先强制停止全部并等待结束，再解除锁定'});
    const holders=jobs.filter(j=>j.schedulingHold);
    if(holders.length!==body.jobIds.length||holders.some(j=>!body.jobIds.includes(j.id)))return send(409,{error:'占锁任务已变化，请刷新后重新确认'});
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
       try{clientRecovery=await recovery(j,{connection:taskRuntimes.get(j.id),allowAbort:false,jobs});}
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
   if(req.method==='POST'&&url.pathname==='/api/config'){state.config=normalizeConfig(body);await persist();return send(200,state.config);}
   if(req.method==='GET'&&url.pathname==='/api/cdp-config')return send(200,{...await readCdpConfig(cdpConfigFile),...await probeCdp(state.config.cdpPort||9223),restarting:editingCdp});
   if(req.method==='POST'&&url.pathname==='/api/cdp-config/restart'){
    if(active.size||readingModels||editingCdp)return send(409,{error:'控制台正在执行操作，请结束后重试'});
    editingCdp=true;
    try{const port=Number(body.port||state.config.cdpPort||9223);const result=await restartClient(path.join(dataDir,'cdp-backups'),port);state.config.cdpPort=port;await persist();return send(200,result);}finally{editingCdp=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/cdp-config/enable'){
    if(active.size||readingModels||editingCdp)return send(409,{error:'控制台正在执行操作，请结束后重试'});
    editingCdp=true;
    try{return send(200,await enableCdpConfig(path.join(dataDir,'cdp-backups'),cdpConfigFile));}finally{editingCdp=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/models/save'){
    if(active.size||readingModels||editingCdp)return send(409,{error:'客户端正在被操作，请稍后保存模型'});
    readingModels=true;
    try{const result=await saveClientModel(body);state.config=normalizeConfig({...state.config,model:result.model,provider:{}});await persist();return send(200,result);}finally{readingModels=false;}
   }
   if(req.method==='POST'&&url.pathname==='/api/scripts'){
    if(typeof body.path!=='string'||!path.isAbsolute(body.path))throw Error('请输入脚本的绝对路径');
    const file=await fs.realpath(body.path.trim().replace(/^"|"$/g,''));
    if(state.scripts.some(s=>s.path.toLowerCase()===file.toLowerCase()))throw Error('脚本已经添加');
    const item={id:randomUUID(),name:String(body.name||path.basename(file)).slice(0,100),path:file};
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
     const browser=await chromium.connectOverCDP(`http://127.0.0.1:${c.cdpPort}`,{timeout:8000});
     try{
      const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
      if(pages.length!==1)throw Error('没有唯一的MobileWork主界面');
      const page=pages[0];
      if(await page.getByRole('button',{name:'停止',exact:true}).filter({visible:true}).count())throw Error('MobileWork 正在运行，请结束后读取模型');
      return send(200,await readModelOptions(page));
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
     const savedConfig=safeConfig(config);
     if(body.batchId){batch=batches.find(b=>b.id===body.batchId);if(!batch)throw Error('执行批次不存在');if(batch.submission!=='SUBMITTING')throw Error('批次提交已结束，不得追加执行');if(!batch.scripts.some(s=>s.scriptId===item.id))throw Error('脚本不属于本执行批次');if(JSON.stringify(batch.config)!==JSON.stringify(savedConfig))throw Error('本次参数与批次参数快照不一致');}
     else{batch=await createBatch({scriptIds:[item.id],mode:'single',config});automaticBatch=true;}
     startKey=batch.id+':'+item.id;
     if(batchStarting.has(startKey)||jobs.some(j=>j.batchId===batch.id&&j.scriptId===item.id))throw Error('本批次已经提交此脚本，未重复执行');
     batchStarting.add(startKey);
     ownsStart=true;
     const job={id:randomUUID(),batchId:batch.id,scriptId:item.id,name:item.name,path:item.path,config:savedConfig,status:'QUEUED',phase:'QUEUED',queuedAt:new Date().toISOString(),startedAt:null,log:'',reportPath:null};
     const jobDir=path.join(dataDir,'jobs',job.id);await fs.mkdir(jobDir,{recursive:true});
     await fs.writeFile(path.join(jobDir,'运行配置.json'),JSON.stringify(savedConfig,null,2));
     const [command,argv]=makeCommand(item.path);argv.push(...runArgs);job.args=runArgs;job.cooperative=info.cooperative;if(info.cooperative)job.isolationVersion=2;
     jobs.push(job);active.add(job.id);await writeJob(job);
     scheduler.enqueue(job,{cooperative:info.cooperative,start:async()=>{
     await writeJob(job);
     if(job.stopRequested||job.status!=='RUNNING')return;
     if(config.recording.enabled&&!runArgs.includes('--check')){
      const pending=recorderFactory({config:config.recording,directory:path.join(dataDir,'recordings',job.id),cdpPort:config.cdpPort,onChange:async metadata=>{
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
     const child=spawn(command,argv,{cwd:projectRoot,windowsHide:true,shell:false,env:{...process.env,MW_TEST_CONFIG_JSON:JSON.stringify(config),MW_MODEL_CONFIG_JSON:JSON.stringify(config.provider),MW_CDP_PORT:String(config.cdpPort),MW_CONSOLE_JOB_ID:job.id,...(info.cooperative?{MW_TASK_CONTROL_URL:`http://${expectedHost}/api/task-control/${job.id}`,MW_TASK_CONTROL_TOKEN:taskToken}:{}),PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
     job.pid=child.pid;await writeJob(job);
     const decoders=[new StringDecoder('utf8'),new StringDecoder('utf8')];
     const logPath=path.join(jobDir,'执行日志.txt');let chain=Promise.resolve();
     const consume=text=>{if(config.provider?.key)text=text.split(config.provider.key).join('[已隐藏Key]');append(job,text);chain=chain.then(()=>fs.appendFile(logPath,text)).catch(()=>{});};
     child.stdout.on('data',b=>consume(decoders[0].write(b)));child.stderr.on('data',b=>consume(decoders[1].write(b)));
     child.on('error',e=>{job.error=e.message;consume('\n启动失败：'+e.message+'\n');});
     child.on('close',async code=>{
      consume(decoders.map(d=>d.end()).join(''));await chain;
      if(job.stopRequested||job.endedAt)return;
      job.exitCode=code;job.endedAt=new Date().toISOString();
      job.status=code===0?'EXITED':code===2?'BLOCKED':'FAIL';
      const reportMatches=[...job.log.matchAll(/^报告：(.+)$/gm)];
      if(reportMatches.length){
       job.reportPath=reportMatches.at(-1)[1].trim();
       try{const result=JSON.parse(await fs.readFile(path.join(path.dirname(job.reportPath),'执行结果.json'),'utf8'));if(['PASS','FAIL','BLOCKED','RESUMED','CHECKED'].includes(result.result))job.status=result.result;job.result=result;}catch{}
      }
      job.sessionId??=jobSessionId(job);
      await finishRecording(job,'completed');
      job.phase='VERIFYING';
      const unresolved=info.cooperative?!await reconcileHandoff(job,{allowAbort:['FAIL','BLOCKED'].includes(job.status)}):Boolean(job.sessionId&&!job.modelCompleted);
      job.phase='FINISHED';
      if(unresolved){job.schedulingHold=true;job.error=(job.result?.error||job.error||'会话是否结束尚未确认')+'；后续排队暂停：'+(job.handoff?.reason||'待核对本会话');}
      await writeJob(job).catch(()=>{});active.delete(job.id);taskTokens.delete(job.id);scheduler.finish(job.id,{unresolved});updateQueueHolds();
     });
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
    if(job.stopRequested)return send(409,{error:'正在停止，请等待'});
    const failedWithLiveSession=Boolean(job.schedulingHold);
    if(!canStopJob(job))return send(409,{error:'该脚本和会话已结束且无待解除锁，不重复操作历史任务'});
    if(job.status==='QUEUED'){
     job.status='STOPPED';job.phase='FINISHED';job.endedAt=new Date().toISOString();job.error='用户取消排队，未启动脚本、未向客户端发送任务';active.delete(job.id);scheduler.finish(job.id);await writeJob(job);return send(200,{message:job.error});
    }
    active.add(job.id);job.stopRequested=true;
    try{if(job.status!=='BLOCKED'&&!failedWithLiveSession&&job.pid)await killScript(job);}catch(e){delete job.stopRequested;active.delete(job.id);throw e;}
    try{
     const disk=await fs.readFile(path.join(dataDir,'jobs',job.id,'执行日志.txt'),'utf8').catch(()=>job.log);job.log=disk;
     let message,confirmed=false;try{message=job.modelCompleted||job.sessionSettled?'本条会话已结束，核对页面交接':await stopSession(job,{connection:taskRuntimes.get(job.id)});confirmed=true;if(job.sessionId&&!job.modelCompleted&&!job.sessionSettled)job.abortAcknowledged=true;}catch(e){message='脚本已停止，但会话停止未确认：'+e.message+'；请在客户端核对';}
     if(confirmed&&job.cooperative){confirmed=await reconcileHandoff(job);if(!confirmed)message+='；页面交接：'+job.handoff?.reason;}
     if(job.status!=='BLOCKED')await releaseOwnedLock(job,projectRoot).catch(e=>{message+='；执行锁处理失败：'+e.message;});
     job.schedulingHold=!confirmed;job.status=confirmed?'STOPPED':'BLOCKED';job.endedAt=new Date().toISOString();job.error='用户强制停止。'+message;
     append(job,'\n'+job.error+'\n');
     await fs.appendFile(path.join(dataDir,'jobs',job.id,'执行日志.txt'),'\n'+job.error+'\n');
     delete job.stopRequested;
     await writeJob(job);return send(200,{message:job.error});
    }finally{await finishRecording(job,'stopped').catch(()=>{});active.delete(job.id);taskTokens.delete(job.id);scheduler.finish(job.id,{unresolved:Boolean(job.schedulingHold)});delete job.stopRequested;await writeJob(job);}
   }
   const jobMatch=url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
   const traceMatch=url.pathname.match(/^\/traces\/([\w-]+)(\/download|\/observatory)?$/);
   if(req.method==='GET'&&traceMatch){
    const job=jobs.find(j=>j.id===traceMatch[1]);if(!job)return send(404,{error:'运行记录不存在'});
    if(!traceMatch[2]){res.writeHead(302,{Location:'/?trace='+encodeURIComponent(job.id)});res.end();return;}
    let trace,error;
    try{trace=await loadJobTrace(job,traceReader||(async sessionId=>{
     const browser=await chromium.connectOverCDP(`http://127.0.0.1:${job.config?.cdpPort||state.config.cdpPort||9223}`,{timeout:8000});
     try{const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
      if(pages.length!==1)throw Error('没有唯一的 MobileWork 主界面');
      return await pages[0].evaluate(readSessionLog,{sessionId,includeChildren:true});
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
   if(req.method==='GET'&&reportMatch){const job=jobs.find(j=>j.id===reportMatch[1]);if(!job)return send(404,{error:'运行记录不存在'});res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(renderReport({...job,sessionId:job.result?.sessionId||job.log?.match(/(?:任务已发送|续跑既有会话)\s+(ses_[A-Za-z0-9]+)/)?.[1]}));return;}
   const sessionMatch=url.pathname.match(/^\/sessions\/([^/]+)\/(download)$/);
   if(req.method==='GET'&&sessionMatch){
    const sessionId=decodeURIComponent(sessionMatch[1]);
    if(!/^ses_[A-Za-z0-9]+$/.test(sessionId))throw Error('会话 ID 无效');
    const browser=await chromium.connectOverCDP(`http://127.0.0.1:${state.config.cdpPort||9223}`,{timeout:8000});
    try{
     const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
     if(pages.length!==1)throw Error('没有唯一的 MobileWork 主界面');
     const page=pages[0],base=page.url().split('#')[0];
     if(sessionMatch[2]==='download'){
      const data=await page.evaluate(readSessionLog,{sessionId,includeChildren:true});
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
    const downloads=['.pptx','.zip','.html','.svg','.mjs','.js','.yml','.yaml','.mmd'];
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
