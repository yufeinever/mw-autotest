import {showBrowserTrace} from './trace-browser.mjs';
import {scriptsInSuite,suiteLabels} from './script-groups.mjs';
import {showBatch} from './batch-browser.mjs';
import {installDetailPreview,findScriptCase} from './detail-preview.mjs';
import {canStopJob,stopAllJobs} from './stop-all.mjs';
import {collectBatches,batchLabels,batchResultClass,assertionRate,batchDate,phaseLabels} from './batches.mjs';
const params=new URLSearchParams(location.search),traceId=params.get('trace'),batchId=params.get('batch');
if(traceId){await showBrowserTrace(traceId);}else if(batchId){await showBatch(batchId);}else{
const $=s=>document.querySelector(s);
let token='',state,selectedJob,parentDir,initialized=false,historyPage=1,scriptPage=1,batchBusy=false;
const pendingScripts=new Set(),selectedScripts=new Set();
let activeSuite=localStorage.getItem('mw-script-suite')==='permission'?'permission':'functional';
const visibleScripts=()=>scriptsInSuite(state?.scripts||[],activeSuite);
const submissions=new Set();let stopAllBusy=false,stopGeneration=0;
const labels={QUEUED:'排队中',RUNNING:'执行中',PASS:'通过',FAIL:'失败',BLOCKED:'阻塞',EXITED:'已退出（未声明断言结果）',INTERRUPTED:'控制台已中断',CHECKED:'预检通过',RESUMED:'续跑完成'};
labels.STOPPED='已强制停止';
labels.REVIEW='已观察·待复核';
function notice(text,error=false){$('#message').textContent=text;$('#message').className=error?'error':'';}
async function api(url,data,method){const r=await fetch(url,{method:method||(data?'POST':'GET'),headers:{'Content-Type':'application/json','x-console-token':token},body:data?JSON.stringify(data):undefined});const j=await r.json();if(!r.ok)throw Error(j.error);return j;}
const preview=installDetailPreview(id=>findScriptCase(state?.scripts.find(script=>script.id===id),state?.projectRoot),()=>state?.capabilities?.detailPreview===1,{
 readLocations:async id=>{const current=state||await api('/api/state');if(current.capabilities?.recordingFolders!==1)throw Error('请在任务空闲时重启控制台，以启用录像文件夹入口');token=current.token;return api('/api/jobs/'+encodeURIComponent(id)+'/recording-locations');},
 readEvidence:async id=>{const job=await api('/api/jobs/'+encodeURIComponent(id));return {name:job.name,recording:job.recording,evidence:job.result?.evidence||[]};},
 openFolder:(id,location)=>api('/api/jobs/'+encodeURIComponent(id)+'/recording-folder',{location})
});
function recordingConfig(){return {enabled:$('#recordingEnabled').checked,resolution:$('#recordingResolution').value,fps:Number($('#recordingFps').value),bitrateKbps:Number($('#recordingBitrate').value),maxSeconds:Number($('#recordingMaxSeconds').value||180)};}
function syncRecording(){const c=recordingConfig();for(const id of ['recordingResolution','recordingFps','recordingBitrate','recordingMaxSeconds'])$('#'+id).disabled=!c.enabled;$('#recordingEstimate').textContent=c.enabled?`录满 ${c.maxSeconds} 秒约 ${(c.bitrateKbps*c.maxSeconds/8000).toFixed(1)} MB（按目标平均码率估算）。到时仅停止录像，用例继续执行。`:'录像已关闭。';}
for(const id of ['recordingEnabled','recordingResolution','recordingFps','recordingBitrate','recordingMaxSeconds'])$('#'+id).addEventListener('input',syncRecording);
function config(){const interval=$('#stepInterval').value.trim();return {recording:recordingConfig(),executionStrategy:'serial',maxParallel:1,question:$('[name=question]:checked').value,customText:$('#customText').value,approval:$('[name=approval]:checked').value,model:$('#model').value,cdpPort:Number($('#cdpPort').value),stepInterval:interval===''?0.5:Number(interval),provider:{url:$('#providerUrl').value,key:$('#providerKey').value,model:$('#providerModel').value,multimodal:$('#providerMulti').checked,inputTokens:Number($('#inputTokens').value),outputTokens:Number($('#outputTokens').value)}};}
function modelOption(name){if(![...$('#model').options].some(o=>o.value===name))$('#model').add(new Option(name,name));}
function syncCustom(){$('#customText').disabled=$('[name=question]:checked').value!=='custom';}
document.querySelectorAll('[name=question]').forEach(e=>e.onchange=syncCustom);
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
let cdpBusy=false;
async function refreshCdp(){
 try{const c=await api('/api/cdp-config');$('#cdpState').textContent=c.error||`客户端 ${c.version} · packagedCdpAllowed=${c.allowed}（${c.allowed?'配置已开启':'未开启，自动化连接可能阻塞'}）`;$('#cdpState').className=c.allowed===true?'result-pass':'result-fail';$('#enableCdp').disabled=cdpBusy||c.restarting||c.allowed!==false||!!state?.active||state?.readingModels;$('#restartCdp').disabled=cdpBusy||c.restarting||!!state?.active||state?.readingModels||c.allowed===null;$('#cdpConnection').textContent=`CDP 端口 ${c.port}：${c.connected?'已连接 MobileWork 主界面，可执行测试':'未连接，请点击一键启用并重启'}`;$('#cdpConnection').className=c.connected?'result-pass':'result-fail';}
 catch(e){$('#cdpState').textContent=e.message;$('#cdpState').className='result-fail';$('#enableCdp').disabled=true;}
}
$('#refreshCdp').onclick=refreshCdp;
$('#restartCdp').onclick=async()=>{cdpBusy=true;$('#restartCdp').disabled=true;$('#enableCdp').disabled=true;$('#cdpMessage').textContent='正在检查状态、修改配置并重启，请等待连接验证…';try{const r=await api('/api/cdp-config/restart',{port:Number($('#cdpPort').value)});$('#cdpMessage').textContent=`启动完成，CDP ${r.port} 已连接 MobileWork 主界面。`+(r.backup?' 配置备份：'+r.backup:'');}catch(e){$('#cdpMessage').textContent='未完成：'+e.message;}finally{cdpBusy=false;await refreshCdp();}};
$('#enableCdp').onclick=async()=>{cdpBusy=true;$('#enableCdp').disabled=true;try{const r=await api('/api/cdp-config/enable',{});$('#cdpMessage').textContent=r.changed?'已设为 true，备份：'+r.backup+'。请在当前任务结束后，以 CDP 启动配置重启客户端。':'已是 true，无需修改。';}catch(e){$('#cdpMessage').textContent=e.message;}finally{cdpBusy=false;await refreshCdp();}};
async function refresh(){
 state=await api('/api/state');token=state.token;
 if(!initialized){const c=state.config;$(`[name=question][value="${c.question}"]`).checked=true;$(`[name=approval][value="${c.approval}"]`).checked=true;$('#customText').value=c.customText;$('#cdpPort').value=c.cdpPort;$('#stepInterval').value=c.stepInterval??0.5;const v=c.recording||{};$('#recordingEnabled').checked=v.enabled??true;$('#recordingResolution').value=v.resolution||'960x540';$('#recordingFps').value=v.fps||30;$('#recordingBitrate').value=v.bitrateKbps||600;$('#recordingMaxSeconds').value=v.maxSeconds||180;syncRecording();if(c.model)modelOption(c.model);$('#model').value=c.model;const p=c.provider||{};$('#providerUrl').value=p.url||'';$('#providerKey').value=p.key||'';$('#providerModel').value=p.model||'';$('#providerMulti').checked=!!p.multimodal;$('#inputTokens').value=p.inputTokens||262144;$('#outputTokens').value=p.outputTokens||65536;syncCustom();initialized=true;}
 $('#connection').textContent=state.active?'脚本执行中':'本机服务已连接';$('#models').disabled=!!state.active||state.readingModels;
 if(state.capabilities?.taskIsolation!==2)batchNotice('任务隔离升级尚未加载：请先关闭旧控制台服务，再运行“启动测试平台.cmd”，仍使用18888端口；仅刷新页面不能升级服务。',true);
 if(state.capabilities?.serialOnly!==1)batchNotice('串行调度升级尚未加载，请在任务空闲后重启控制台，仍使用18888端口。',true);
 renderScripts();
 renderHistory();
}
function resultClass(status){return ['FAIL','BLOCKED','STOPPED','INTERRUPTED'].includes(status)?'result-fail':['PASS','CHECKED','RESUMED'].includes(status)?'result-pass':'';}
function batchNotice(text,error=false){const e=$('#batchMessage');e.hidden=false;e.textContent=text;e.className=error?'error':'';}
const logDialog=el('dialog',undefined,'execution-log-dialog'),logHeading=el('h2','执行日志'),logMeta=el('p'),logBody=el('pre'),logClose=el('button','关闭'),logRefresh=el('button','刷新日志'),logHeader=el('div',undefined,'heading'),logControls=el('div',undefined,'log-controls');
let logJobId=null,logRequest=0;
const unlockButton=el('button','强制解除锁定','danger'),lockState=el('p',undefined,'hint');unlockButton.id='forceUnlock';lockState.id='lockState';
$('#stopAll').after(unlockButton);$('#scriptSection .heading').after(lockState);
unlockButton.onclick=async()=>{
 await refresh();const holders=state.jobs.filter(j=>j.schedulingHold);
 if(!holders.length){batchNotice('当前没有调度锁，无需解除。');return;}
 const ids=holders.map(j=>j.id);
 if(!window.confirm('强制解除以下控制台调度锁？\n'+holders.map(j=>j.name+'：'+(j.handoff?.reason||j.error||'等待恢复')).join('\n')+'\n\n将取消尚未启动的排队任务，保留原报告和日志。核对后仅清理归属完整匹配的本次测试草稿；用户草稿和未知内容保留。不会终止MobileWork里的任务；解除后会分别报告调度锁与客户端就绪状态。'))return;
 unlockButton.disabled=true;
 try{const r=await api('/api/locks/release',{confirm:true,jobIds:ids});batchNotice(r.message);notice(r.message);}catch(e){batchNotice('解除未完成：'+e.message,true);}finally{await refresh();}
};
logHeading.id='executionLogTitle';logDialog.setAttribute('aria-labelledby',logHeading.id);logBody.tabIndex=0;
logControls.append(logRefresh,logClose);logHeader.append(logHeading,logControls);logDialog.append(logHeader,logMeta,logBody);document.body.append(logDialog);
logClose.onclick=()=>logDialog.close();logDialog.addEventListener('close',()=>{logJobId=null;logRequest++;});
async function readExecutionLog(){
 const id=logJobId,request=++logRequest;logBody.textContent='正在读取日志…';
 try{const job=await api('/api/jobs/'+encodeURIComponent(id));if(request!==logRequest||!logDialog.open)return;
  logHeading.textContent=job.name+' · 执行日志';logMeta.textContent=`开始：${batchDate(job.startedAt)}　结束：${batchDate(job.endedAt)}（北京时间） · ${labels[job.status]||job.status}`;
  logBody.textContent=job.log||job.error||'本次运行尚未产生执行日志。';
 }catch(e){if(request===logRequest&&logDialog.open)logBody.textContent='读取失败：'+e.message;}
}
logRefresh.onclick=readExecutionLog;
function showExecutionLog(job){logJobId=job.id;logHeading.textContent=job.name+' · 执行日志';logMeta.textContent='';logDialog.showModal();readExecutionLog();}
function renderScripts(){
 const scripts=visibleScripts();
 for(const tab of document.querySelectorAll('[data-suite]')){const on=tab.dataset.suite===activeSuite;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;tab.disabled=batchBusy||submissions.size>0;}
 $('#scriptPanel').setAttribute('aria-labelledby',activeSuite==='permission'?'permissionTab':'functionalTab');
 $('#suiteHint').textContent=activeSuite==='permission'?'先准备隔离材料，再观察问询、拦截与后续执行。权限卡固定拒绝并继续观察，不使用上方全局自动授权。待确认或需专用能力的场景不可执行。':'功能用例：验证业务回复、实际产物和 Skill 调用。';
 const holders=state.jobs.filter(j=>j.schedulingHold);
 const running=state.jobs.filter(j=>j.status==='RUNNING');
 lockState.textContent=running.length?'锁定 MW · '+running.map(j=>j.name).join('、')+' 正在执行，请勿手动操作 MobileWork。':holders.length?'调度已暂停 · '+holders.map(j=>j.name+'：'+(j.handoff?.reason||'等待恢复')).join('；'):'调度正常 · 无锁定';
 lockState.className=running.length?'mw-lock-banner':holders.length?'lock-warning':'hint';
 unlockButton.disabled=!holders.length||stopAllBusy||batchBusy||submissions.size>0||state.jobs.some(j=>j.status==='RUNNING'||j.stopRequested);
 const size=Number($('#scriptPageSize').value),total=scripts.length,pages=Math.max(1,Math.ceil(total/size));scriptPage=Math.max(1,Math.min(scriptPage,pages));
 const start=(scriptPage-1)*size;$('#scripts').replaceChildren();
 for(const [offset,script] of scripts.slice(start,start+size).entries()){
  const tr=el('tr');tr.dataset.scriptId=script.id;tr.dataset.scriptNumber=start+offset+1;
  const name=el('td'),title=el('button',script.name,'script-title script-source');title.title='查看用例描述';title.onclick=()=>preview.openScript(script);name.append(title);if(script.unavailable){const why=el('small',script.unavailable,'hint');why.style.display='block';name.append(why);}
  const job=state.jobs.filter(j=>j.scriptId===script.id).at(-1);
  if(state.jobs.some(j=>j.scriptId===script.id&&j.status==='RUNNING')){
   tr.classList.add('script-running');const locked=el('span','锁定 MW','mw-lock-badge');locked.title='自动化正在执行，请勿手动操作 MobileWork';name.append(locked);
  }
  const status=el('td'),statusText=job?job.status==='RUNNING'&&job.phase?phaseLabels[job.phase]||labels[job.status]:labels[job.status]||job.status:'未执行';
  status.append(el('span',statusText,'script-status '+resultClass(job?.status)));
  if(job?.finalizing&&job.cleanupStage)status.append(el('small',job.cleanupStage));
  if(job?.recording?.status==='RECORDING')status.append(el('small','● 录制中'));else if(job?.recording?.status==='FINALIZING')status.append(el('small','录像保存中'));else if(job?.recording?.status==='ERROR')status.append(el('small','录像失败：'+job.recording.error));
  if(job?.queueHold)status.append(el('small','等待恢复：'+job.queueHold));
  const number=el('td'),choice=el('input');choice.type='checkbox';choice.className='script-choice';choice.setAttribute('aria-label','选择用例 '+(start+offset+1)+' '+script.name);choice.checked=selectedScripts.has(script.id);
  choice.disabled=$('[name=selectionMode]:checked').value!=='selected'||batchBusy||!script.exists||!script.integrated;
  choice.onchange=()=>{if(choice.checked)selectedScripts.add(script.id);else selectedScripts.delete(script.id);renderScripts();};
  number.append(choice,document.createTextNode(String(start+offset+1).padStart(2,'0')));
  tr.append(number,name,el('td',!script.exists?'文件不存在':script.unavailable?'待条件':script.integrated?'已接入':'待接入',!script.exists?'result-fail':''),status);
  const recent=el('td',undefined,'script-recent'),actions=el('td'),actionGroup=el('div',undefined,'script-row-actions'),run=el('button','执行','primary'),stop=el('button','强制停止','danger'),remove=el('button','移除','script-remove');
  if(job){const failed=(job.result?.checks||[]).filter(c=>!c.pass);status.title=failed.map(c=>c.name).join('；')||job.result?.error||'';if(failed.length&&failed.every(c=>c.category==='skill-invocation'))status.append(el('small','Skill 调用断言未通过'));
   recent.append(el('span',job.startedAt?batchDate(job.startedAt):job.queuedAt?'排队于 '+batchDate(job.queuedAt):'时间未记录','script-time'));
   const evidence=el('div',undefined,'script-evidence'),report=el('a','截图报告','script-link'),video=el('button','录像','script-link'),log=el('button','执行日志','script-link');report.href='/reports/'+encodeURIComponent(job.id);evidence.append(report);
   video.disabled=!job.recording?.available;
   video.title=job.recording?.available?'播放或下载本次执行录像':({STARTING:'录像准备中',RECORDING:'录制中，保存后可查看',FINALIZING:'录像保存中',ERROR:'录像失败：'+(job.recording?.error||'请查看报告'),INTERRUPTED:'录像保存中断，请查看报告',DISABLED:'本次执行未开启录像'}[job.recording?.status]||'本次执行没有已保存的录像');
   video.onclick=()=>preview.openRecording(job);evidence.append(video);log.onclick=()=>showExecutionLog(job);evidence.append(log);
   if(job.sessionId||job.result?.sessionId){const traceLink=el('a','Trace 记录','script-link');traceLink.href='/?trace='+encodeURIComponent(job.id);evidence.append(traceLink);}recent.append(evidence);
  }else recent.append(el('span','—','hint'));
  tr.append(recent);
  run.disabled=state.capabilities?.serialOnly!==1||state.capabilities?.taskIsolation!==2||stopAllBusy||batchBusy||state.readingModels||cdpBusy||pendingScripts.has(script.id)||!script.exists||!script.integrated;
  run.onclick=()=>startScripts([script],'执行此脚本');
  stop.disabled=stopAllBusy||!job||!!job.stopRequested||!canStopJob(job);
  if(job?.stopRequested)stop.textContent='停止中…';
  stop.title='停止本次脚本进程及其会话，保留日志和截图';
  stop.onclick=async()=>{stop.disabled=true;try{const r=await api('/api/jobs/'+job.id+'/stop',{});notice(r.message);await refresh();}catch(e){notice(e.message,true);}};
  remove.disabled=!!state.active||batchBusy||pendingScripts.has(script.id);
  remove.onclick=async()=>{try{await api('/api/scripts/'+script.id,{},'DELETE');await refresh();}catch(e){notice(e.message,true);}};
  actionGroup.append(run,stop);
  actionGroup.append(remove);actions.prepend(actionGroup);tr.append(actions);
  ['序号','脚本','参数接入','最近结果','最近执行（北京时间）','操作'].forEach((label,i)=>tr.children[i].dataset.label=label);$('#scripts').append(tr);
 }
 if(!total){const tr=el('tr'),td=el('td','暂无脚本，请先添加。','hint');td.colSpan=6;tr.append(td);$('#scripts').append(tr);}
 $('#scriptPageInfo').textContent=`共 ${total} 条 · ${total?start+1:0}–${Math.min(start+size,total)} 条 · 第 ${scriptPage} / ${pages} 页`;
 $('#scriptPrevPage').disabled=scriptPage===1;$('#scriptNextPage').disabled=scriptPage===pages;
 const unavailable=state.capabilities?.serialOnly!==1||state.capabilities?.taskIsolation!==2||stopAllBusy||batchBusy||pendingScripts.size>0||state.readingModels||cdpBusy||!total;
 const selecting=$('[name=selectionMode]:checked').value==='selected';
 for(const id of selectedScripts)if(!scripts.some(s=>s.id===id&&s.exists&&s.integrated))selectedScripts.delete(id);
 $('#selectionControls').hidden=!selecting;$('#rangeControls').hidden=selecting;$('#scriptRange').disabled=selecting||batchBusy;
 $('#selectionCount').textContent=`已选 ${selectedScripts.size} 条（${suiteLabels[activeSuite]}全部分页）`;
 $('#runAll').disabled=unavailable||!scripts.some(s=>s.exists&&s.integrated);$('#runRange').disabled=unavailable||selecting;$('#runSelected').disabled=unavailable||!selecting||!selectedScripts.size;
 for(const id of ['selectAllScripts','invertScripts','clearScripts'])$('#'+id).disabled=!selecting||batchBusy;
 document.querySelectorAll('[name=selectionMode]').forEach(e=>e.disabled=batchBusy);
 $('#stopAll').disabled=stopAllBusy||(!submissions.size&&!state.jobs.some(canStopJob));
 $('#stopAll').textContent=stopAllBusy?'正在停止…':'强制停止全部';
}
async function startScripts(scripts,label,batch=false){
 if(activeSuite==='permission'&&state.capabilities?.scriptSuites!==1){batchNotice('用例分类升级尚未加载，请在空闲时重启18888控制台；未提交任务。',true);return;}
 if(config().recording.enabled&&state.capabilities?.recording!==1){batchNotice('录像功能尚未加载，请在空闲时重启控制台后执行。',true);return;}
 if(state.capabilities?.serialOnly!==1){batchNotice('请先在空闲时重启控制台加载串行调度，未提交任务。',true);return;}
 if(state.capabilities?.taskIsolation!==2){batchNotice('请先重启本项目18888控制台加载任务隔离升级，未提交新任务。',true);return;}
 if(state.capabilities?.taskScheduling!==1){batchNotice('当前服务尚未加载执行策略，请从“启动测试平台.cmd”打开新版控制台后执行。',true);return;}
 if(stopAllBusy||batchBusy||scripts.some(s=>pendingScripts.has(s.id)))return;
 const unavailable=scripts.filter(s=>!s.exists||!s.integrated);
 if(unavailable.length){batchNotice('未开始：以下脚本文件不存在或未接入参数：'+unavailable.map(s=>s.name).join('、'),true);return;}
 if(!scripts.length){batchNotice('没有可执行的脚本。',true);return;}
 const snapshot=structuredClone(config()),suite=activeSuite;let started=0,executionBatch;
 const generation=stopGeneration;let settle;
 const submission=new Promise(resolve=>settle=resolve);submissions.add(submission);
 const checkCancelled=()=>{if(generation!==stopGeneration)throw Error('已点击强制停止全部，取消剩余提交');};
 if(batch)batchBusy=true;for(const script of scripts)pendingScripts.add(script.id);renderScripts();
 batchNotice(`${label}：正在提交 0 / ${scripts.length} 条…`);
 try{
  await api('/api/config',snapshot);
  checkCancelled();
  executionBatch=await api('/api/batches',{suite,scriptIds:scripts.map(s=>s.id),mode:!batch?'single':label==='全部执行'?'all':label==='执行勾选'?'selected':'range',config:snapshot});
  for(const script of scripts){
   checkCancelled();
   const job=await api('/api/run',{scriptId:script.id,batchId:executionBatch.id,config:snapshot});selectedJob=job.id;started++;pendingScripts.delete(script.id);
   checkCancelled();
   batchNotice(`${label}：已提交 ${started} / ${scripts.length} 条…`);
  }
  await api('/api/batches/'+executionBatch.id+'/complete',{});
  checkCancelled();
  const text=`${label}：已加入队列 ${started} 条，按序号串行执行。执行结果请查看执行批次。`;batchNotice(text);notice(text);
 }catch(e){if(executionBatch)await api('/api/batches/'+executionBatch.id+'/complete',{error:e.message}).catch(()=>{});if(generation===stopGeneration){const text=`${label}未全部提交：已加入队列 ${started} / ${scripts.length} 条。${e.message}；未自动重试，请核对执行批次。`;batchNotice(text,true);notice(text,true);}}
 finally{for(const script of scripts)pendingScripts.delete(script.id);if(batch)batchBusy=false;submissions.delete(submission);settle();renderScripts();await refresh().catch(e=>notice('刷新失败：'+e.message,true));}
}
for(const tab of document.querySelectorAll('[data-suite]')){
 tab.onclick=()=>{if(batchBusy||submissions.size)return;activeSuite=tab.dataset.suite;localStorage.setItem('mw-script-suite',activeSuite);scriptPage=1;selectedScripts.clear();$('#scriptRange').value='';$('#batchMessage').hidden=true;renderScripts();};
 tab.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const next=document.querySelector('[data-suite="'+(tab.dataset.suite==='functional'?'permission':'functional')+'"]');next.click();next.focus();}};
}
$('#scriptPageSize').onchange=()=>{scriptPage=1;renderScripts();};$('#scriptPrevPage').onclick=()=>{scriptPage--;renderScripts();};$('#scriptNextPage').onclick=()=>{scriptPage++;renderScripts();};
$('#runAll').onclick=()=>startScripts(visibleScripts().filter(s=>!s.unavailable),'全部执行',true);
 document.querySelectorAll('[name=selectionMode]').forEach(e=>e.onchange=()=>{selectedScripts.clear();$('#scriptRange').value='';renderScripts();});
 $('#selectAllScripts').onclick=()=>{for(const s of visibleScripts())if(s.exists&&s.integrated)selectedScripts.add(s.id);renderScripts();};
 $('#invertScripts').onclick=()=>{for(const s of visibleScripts())if(s.exists&&s.integrated){if(selectedScripts.has(s.id))selectedScripts.delete(s.id);else selectedScripts.add(s.id);}renderScripts();};
 $('#clearScripts').onclick=()=>{selectedScripts.clear();renderScripts();};
 $('#runSelected').onclick=()=>startScripts(visibleScripts().filter(s=>selectedScripts.has(s.id)),'执行勾选',true);
$('#stopAll').onclick=async()=>{
 if(stopAllBusy)return;
 stopAllBusy=true;stopGeneration++;renderScripts();batchNotice('正在取消后续提交并停止全部任务…');
 try{
  // Wait for any already-sent run request to return its job ID, while the
  // generation check prevents submitting the next script.
  await Promise.allSettled([...submissions]);
  const result=await stopAllJobs(api,text=>batchNotice(text));
  const text=result.remaining.length?`已停止 ${result.stopped} 条，仍有 ${result.remaining.length} 条未确认停止：`+result.remaining.map(j=>j.name+'：'+j.message).join('；'):
   result.total?`全部停止处理完成：已停止 ${result.stopped} 条，其余任务已结束。日志和截图已保留。`:'当前没有需要停止的任务，后续提交已取消。';
  batchNotice(text,!!result.remaining.length);notice(text,!!result.remaining.length);
 }catch(e){batchNotice('全部停止未完成：'+e.message+'。请核对执行批次后重试。',true);notice(e.message,true);}
 finally{stopAllBusy=false;await refresh().catch(e=>notice(e.message,true));renderScripts();}
};
$('#runRange').onclick=()=>{
 const text=$('#scriptRange').value.trim(),match=text.match(/^(\d+)\s*[-–—～~]\s*(\d+)$/);
 const first=Number(match?.[1]),last=Number(match?.[2]);
 if(!match||!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<1||last<first||last>visibleScripts().length){batchNotice(`请输入有效序号 m-n：1 ≤ m ≤ n ≤ ${visibleScripts().length}，例如 3-8。`,true);return;}
 startScripts(visibleScripts().slice(first-1,last),`执行序号 ${first}-${last}`,true);
};
$('#scriptRange').onkeydown=e=>{if(e.key==='Enter'&&!$('#runRange').disabled){e.preventDefault();$('#runRange').click();}};
function renderHistory(){
 const batches=state.batches||collectBatches([],state.jobs),size=Number($('#pageSize').value),pages=Math.max(1,Math.ceil(batches.length/size));historyPage=Math.min(historyPage,pages);
 $('#historyRows').replaceChildren();
 for(const batch of batches.slice((historyPage-1)*size,historyPage*size)){
  const tr=el('tr');tr.dataset.batchId=batch.id;
  const name=el('td'),a=el('a',batch.name);a.href='/?batch='+encodeURIComponent(batch.id);name.append(a,el('small',batch.scope));
  tr.append(name,el('td',batchDate(batch.startedAt)),el('td',batchDate(batch.endedAt)),el('td',`${batch.finished}/${batch.total} 已结束`),el('td',batchLabels[batch.status]||batch.status,batchResultClass(batch.status)),el('td',assertionRate(batch.checks),batch.checks.failed?'result-fail':''));
  const actions=el('td'),detail=el('a','查看批次');detail.href=a.href;actions.append(detail);tr.append(actions);$('#historyRows').append(tr);
 }
 if(!batches.length){const tr=el('tr'),td=el('td','暂无执行批次，执行脚本后将在此显示。','hint');td.colSpan=7;tr.append(td);$('#historyRows').append(tr);}
 $('#pageInfo').textContent=`共 ${batches.length} 个批次 · 第 ${historyPage} / ${pages} 页`;$('#prevPage').disabled=historyPage===1;$('#nextPage').disabled=historyPage===pages;
}
$('#pageSize').onchange=()=>{historyPage=1;renderHistory();};$('#prevPage').onclick=()=>{historyPage--;renderHistory();};$('#nextPage').onclick=()=>{historyPage++;renderHistory();};
$('#saveModel').onclick=async()=>{const b=$('#saveModel');b.disabled=true;$('#modelMessage').textContent='正在保存到 MobileWork…';try{const result=await api('/api/models/save',{...config(),question:'first'});modelOption(result.model);$('#model').value=result.model;$('#providerKey').value='';$('#providerUrl').value='';$('#providerModel').value='';$('#modelMessage').textContent='已保存到 MobileWork 并核对参数，已选中 '+result.model;notice('模型已保存到 MobileWork。');}catch(e){$('#modelMessage').textContent=e.message;}finally{b.disabled=false;}};
$('#save').onclick=async()=>{try{await api('/api/config',config());notice('配置已保存，下次执行时使用。');}catch(e){notice(e.message,true);}};
$('#models').onclick=async()=>{const b=$('#models');b.disabled=true;try{const selected=$('#model').value;const data=await api('/api/models',{...config(),question:'first'});$('#model').replaceChildren(new Option('沿用客户端当前模型',''));for(const m of data.models){const o=new Option(m.name+(m.selected?'（当前）':''),m.name);o.disabled=m.disabled;$('#model').add(o);}if(selected){modelOption(selected);$('#model').value=selected;}notice('已读取客户端当前可用模型。');}catch(e){notice('读取模型失败：'+e.message,true);}finally{b.disabled=false;}};
$('#add').onclick=()=>{$('#dialogError').textContent='';$('#addDialog').showModal();};$('#cancel').onclick=()=>$('#addDialog').close();
async function browse(dir){try{const data=await api('/api/browse'+(dir?'?path='+encodeURIComponent(dir):''));parentDir=data.parent;$('#browser').hidden=false;$('#browsePath').value=data.path;$('#files').replaceChildren();for(const entry of data.entries){const b=el('button',(entry.directory?'文件夹 · ':'脚本 · ')+entry.name);b.type='button';b.onclick=()=>entry.directory?browse(entry.path):($('#scriptPath').value=entry.path);$('#files').append(b);}}catch(e){$('#dialogError').textContent=e.message;}}
$('#browse').onclick=()=>browse();$('#go').onclick=()=>browse($('#browsePath').value);$('#up').onclick=()=>browse(parentDir);
$('#addForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/scripts',{name:$('#scriptName').value,path:$('#scriptPath').value,suite:activeSuite});$('#addDialog').close();$('#addForm').reset();scriptPage=Math.ceil((visibleScripts().length+1)/Number($('#scriptPageSize').value));await refresh();notice('脚本已添加到'+suiteLabels[activeSuite]+'。');}catch(err){$('#dialogError').textContent=err.message;}};
await refresh().catch(e=>notice(e.message,true));refreshCdp();setInterval(refreshCdp,15000);
let refreshing=false;setInterval(async()=>{if(refreshing)return;refreshing=true;try{await refresh();}catch(e){$('#connection').textContent='服务连接断开';notice(e.message,true);}finally{refreshing=false;}},2000);
}
