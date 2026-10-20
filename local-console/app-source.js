import {showBrowserTrace} from './trace-browser.mjs';
import {showBatch} from './batch-browser.mjs';
import {canStopJob,stopAllJobs} from './stop-all.mjs';
import {collectBatches,batchLabels,batchResultClass,assertionRate,batchDate,phaseLabels} from './batches.mjs';
const params=new URLSearchParams(location.search),traceId=params.get('trace'),batchId=params.get('batch');
if(traceId){await showBrowserTrace(traceId);}else if(batchId){await showBatch(batchId);}else{
const $=s=>document.querySelector(s);
let token='',state,selectedJob,parentDir,initialized=false,historyPage=1,scriptPage=1,batchBusy=false;
const pendingScripts=new Set();
const submissions=new Set();let stopAllBusy=false,stopGeneration=0;
const labels={QUEUED:'排队中',RUNNING:'执行中',PASS:'通过',FAIL:'失败',BLOCKED:'阻塞',EXITED:'已退出（未声明断言结果）',INTERRUPTED:'控制台已中断',CHECKED:'预检通过',RESUMED:'续跑完成'};
labels.STOPPED='已强制停止';
function notice(text,error=false){$('#message').textContent=text;$('#message').className=error?'error':'';}
async function api(url,data,method){const r=await fetch(url,{method:method||(data?'POST':'GET'),headers:{'Content-Type':'application/json','x-console-token':token},body:data?JSON.stringify(data):undefined});const j=await r.json();if(!r.ok)throw Error(j.error);return j;}
function config(){return {executionStrategy:$('[name=executionStrategy]:checked').value,maxParallel:Number($('#maxParallel').value),question:$('[name=question]:checked').value,customText:$('#customText').value,approval:$('[name=approval]:checked').value,model:$('#model').value,cdpPort:Number($('#cdpPort').value),provider:{url:$('#providerUrl').value,key:$('#providerKey').value,model:$('#providerModel').value,multimodal:$('#providerMulti').checked,inputTokens:Number($('#inputTokens').value),outputTokens:Number($('#outputTokens').value)}};}
function modelOption(name){if(![...$('#model').options].some(o=>o.value===name))$('#model').add(new Option(name,name));}
function syncCustom(){$('#customText').disabled=$('[name=question]:checked').value!=='custom';}
function syncStrategy(){const parallel=$('[name=executionStrategy]:checked').value==='parallel';$('#maxParallel').disabled=!parallel;$('#strategyHint').textContent=parallel?'依次提交独立任务，不等上一条模型处理结束即可提交下一条；弹窗、审批与截图按会话轮流处理。自定义脚本未接入任务调度时依次执行。':'上一条用例结束后再执行下一条。';}
document.querySelectorAll('[name=executionStrategy]').forEach(e=>e.onchange=syncStrategy);
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
 if(!initialized){$(`[name=executionStrategy][value="${state.config.executionStrategy==='parallel'?'parallel':'serial'}"]`).checked=true;$('#maxParallel').value=state.config.maxParallel||3;syncStrategy();}
 await refreshCdp();
 if(!initialized){const c=state.config;$(`[name=question][value="${c.question}"]`).checked=true;$(`[name=approval][value="${c.approval}"]`).checked=true;$('#customText').value=c.customText;$('#cdpPort').value=c.cdpPort;if(c.model)modelOption(c.model);$('#model').value=c.model;const p=c.provider||{};$('#providerUrl').value=p.url||'';$('#providerKey').value=p.key||'';$('#providerModel').value=p.model||'';$('#providerMulti').checked=!!p.multimodal;$('#inputTokens').value=p.inputTokens||262144;$('#outputTokens').value=p.outputTokens||65536;syncCustom();initialized=true;}
 $('#connection').textContent=state.active?'脚本执行中':'本机服务已连接';$('#models').disabled=!!state.active||state.readingModels;
 renderScripts();
 renderHistory();
}
function resultClass(status){return ['FAIL','BLOCKED','STOPPED','INTERRUPTED'].includes(status)?'result-fail':['PASS','CHECKED','RESUMED'].includes(status)?'result-pass':'';}
function batchNotice(text,error=false){const e=$('#batchMessage');e.hidden=false;e.textContent=text;e.className=error?'error':'';}
function renderScripts(){
 const size=Number($('#scriptPageSize').value),total=state.scripts.length,pages=Math.max(1,Math.ceil(total/size));scriptPage=Math.max(1,Math.min(scriptPage,pages));
 const start=(scriptPage-1)*size;$('#scripts').replaceChildren();
 for(const [offset,script] of state.scripts.slice(start,start+size).entries()){
  const tr=el('tr');tr.dataset.scriptId=script.id;tr.dataset.scriptNumber=start+offset+1;
  const name=el('td'),title=el('span',script.name,'script-title');title.title=script.path;name.append(title);
  const job=state.jobs.filter(j=>j.scriptId===script.id).at(-1);
  tr.append(el('td',String(start+offset+1).padStart(2,'0')),name,el('td',!script.exists?'文件不存在':script.integrated?'已接入':'待接入',!script.exists?'result-fail':''),el('td',job?job.status==='RUNNING'&&job.phase?phaseLabels[job.phase]||labels[job.status]:labels[job.status]||job.status:'未执行',resultClass(job?.status)));
  const actions=el('td'),run=el('button','执行','primary'),stop=el('button','强制停止','result-fail'),remove=el('button','移除');
  run.disabled=stopAllBusy||batchBusy||state.readingModels||cdpBusy||pendingScripts.has(script.id)||!script.exists||!script.integrated;
  run.onclick=()=>startScripts([script],'执行此脚本');
  stop.disabled=stopAllBusy||!job||!!job.stopRequested||!(job.status==='QUEUED'||(['RUNNING','INTERRUPTED','BLOCKED'].includes(job.status))&&(job.pid||job.sessionId||job.result?.sessionId));
  stop.title='停止本次脚本进程及其会话，保留日志和截图';
  stop.onclick=async()=>{stop.disabled=true;try{const r=await api('/api/jobs/'+job.id+'/stop',{});notice(r.message);await refresh();}catch(e){notice(e.message,true);}};
  remove.disabled=!!state.active||batchBusy||pendingScripts.has(script.id);
  remove.onclick=async()=>{try{await api('/api/scripts/'+script.id,{},'DELETE');await refresh();}catch(e){notice(e.message,true);}};
  actions.append(run,stop,remove);tr.append(actions);$('#scripts').append(tr);
 }
 if(!total){const tr=el('tr'),td=el('td','暂无脚本，请先添加。','hint');td.colSpan=5;tr.append(td);$('#scripts').append(tr);}
 $('#scriptPageInfo').textContent=`共 ${total} 条 · ${total?start+1:0}–${Math.min(start+size,total)} 条 · 第 ${scriptPage} / ${pages} 页`;
 $('#scriptPrevPage').disabled=scriptPage===1;$('#scriptNextPage').disabled=scriptPage===pages;
 $('#runAll').disabled=$('#runRange').disabled=stopAllBusy||batchBusy||pendingScripts.size>0||state.readingModels||cdpBusy||!total;
 $('#stopAll').disabled=stopAllBusy||(!submissions.size&&!state.jobs.some(canStopJob));
 $('#stopAll').textContent=stopAllBusy?'正在停止…':'强制停止全部';
}
async function startScripts(scripts,label,batch=false){
 if(state.capabilities?.taskScheduling!==1){batchNotice('当前服务尚未加载执行策略，请从“启动测试平台.cmd”打开新版控制台后执行。',true);return;}
 if(stopAllBusy||batchBusy||scripts.some(s=>pendingScripts.has(s.id)))return;
 const unavailable=scripts.filter(s=>!s.exists||!s.integrated);
 if(unavailable.length){batchNotice('未开始：以下脚本文件不存在或未接入参数：'+unavailable.map(s=>s.name).join('、'),true);return;}
 if(!scripts.length){batchNotice('没有可执行的脚本。',true);return;}
 const snapshot=structuredClone(config());let started=0,executionBatch;
 const generation=stopGeneration;let settle;
 const submission=new Promise(resolve=>settle=resolve);submissions.add(submission);
 const checkCancelled=()=>{if(generation!==stopGeneration)throw Error('已点击强制停止全部，取消剩余提交');};
 if(batch)batchBusy=true;for(const script of scripts)pendingScripts.add(script.id);renderScripts();
 batchNotice(`${label}：正在提交 0 / ${scripts.length} 条…`);
 try{
  await api('/api/config',snapshot);
  checkCancelled();
  executionBatch=await api('/api/batches',{scriptIds:scripts.map(s=>s.id),mode:!batch?'single':label==='全部执行'?'all':'range',config:snapshot});
  for(const script of scripts){
   checkCancelled();
   const job=await api('/api/run',{scriptId:script.id,batchId:executionBatch.id,config:snapshot});selectedJob=job.id;started++;pendingScripts.delete(script.id);
   checkCancelled();
   batchNotice(`${label}：已提交 ${started} / ${scripts.length} 条…`);
  }
  await api('/api/batches/'+executionBatch.id+'/complete',{});
  checkCancelled();
  const text=`${label}：已加入队列 ${started} 条，按${snapshot.executionStrategy==='parallel'?'任务并行':'串行'}策略执行。执行结果请查看执行批次。`;batchNotice(text);notice(text);
 }catch(e){if(executionBatch)await api('/api/batches/'+executionBatch.id+'/complete',{error:e.message}).catch(()=>{});if(generation===stopGeneration){const text=`${label}未全部提交：已加入队列 ${started} / ${scripts.length} 条。${e.message}；未自动重试，请核对执行批次。`;batchNotice(text,true);notice(text,true);}}
 finally{for(const script of scripts)pendingScripts.delete(script.id);if(batch)batchBusy=false;submissions.delete(submission);settle();renderScripts();await refresh().catch(e=>notice('刷新失败：'+e.message,true));}
}
$('#scriptPageSize').onchange=()=>{scriptPage=1;renderScripts();};$('#scriptPrevPage').onclick=()=>{scriptPage--;renderScripts();};$('#scriptNextPage').onclick=()=>{scriptPage++;renderScripts();};
$('#runAll').onclick=()=>startScripts([...state.scripts],'全部执行',true);
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
 if(!match||!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<1||last<first||last>state.scripts.length){batchNotice(`请输入有效序号 m-n：1 ≤ m ≤ n ≤ ${state.scripts.length}，例如 3-8。`,true);return;}
 startScripts(state.scripts.slice(first-1,last),`执行序号 ${first}-${last}`,true);
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
$('#addForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/scripts',{name:$('#scriptName').value,path:$('#scriptPath').value});$('#addDialog').close();$('#addForm').reset();scriptPage=Math.ceil((state.scripts.length+1)/Number($('#scriptPageSize').value));await refresh();notice('脚本已添加。');}catch(err){$('#dialogError').textContent=err.message;}};
await refresh().catch(e=>notice(e.message,true));setInterval(()=>refresh().catch(e=>{$('#connection').textContent='服务连接断开';notice(e.message,true);}),2000);
}
