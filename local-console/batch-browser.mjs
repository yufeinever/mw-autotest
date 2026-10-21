import {batchLabels,batchResultClass,assertionRate,batchDate,phaseLabels} from './batches.mjs';
import {approvalLabels} from './policy.mjs';
import {canStopJob} from './stop-all.mjs';
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
const link=(text,href)=>{const a=el('a',text);a.href=href;return a;};
export async function showBatch(id){
 document.title='执行批次详情 · MobileWork';
 const main=document.querySelector('main');main.className='batch-detail';main.replaceChildren();
 const header=el('header'),heading=el('div');heading.append(el('small','MOBILEWORK · EXECUTION BATCH'),el('h1','执行批次详情'));
 header.className='detail-return';header.append(heading,link('返回执行批次','/#batchSection'));main.append(header);
 const error=el('p',undefined,'result-fail'),content=el('div');error.setAttribute('role','status');main.append(error,content);
 let stopped=false,fingerprint;window.addEventListener('pagehide',()=>stopped=true,{once:true});
 async function refresh(){
  if(stopped)return;
  try{
   if(!/^[\w-]+$/.test(id))throw Error('执行批次 ID 无效');
   const response=await fetch('/api/batches/'+encodeURIComponent(id),{cache:'no-store'}),batch=await response.json();
   if(!response.ok)throw Error(batch.error||'读取执行批次失败');error.textContent='';
   const nextFingerprint=JSON.stringify(batch);if(nextFingerprint===fingerprint)return;
   const expanded=new Set([...content.querySelectorAll('details[open]')].map(e=>e.dataset.expansionKey));
   const summary=el('section'),top=el('div',undefined,'heading');top.append(el('h2',batch.name),el('span',batchLabels[batch.status]||batch.status,'badge '+batchResultClass(batch.status)));summary.append(top);
   summary.append(el('p','批次 ID：'+batch.id),el('p','范围：'+batch.scope),el('p',`开始：${batchDate(batch.startedAt)}　结束：${batchDate(batch.endedAt)}（北京时间）`));
   if(batch.config)summary.append(el('p','执行策略：'+(batch.config.executionStrategy==='parallel'?`任务并行 · 最多 ${batch.config.maxParallel||3} 个任务`:'串行执行')+`　排队 ${batch.queued||0} 条　执行中 ${batch.running} 条`));
   const metrics=el('div',undefined,'batch-metrics');
   for(const [name,value] of [['计划用例',batch.total],['已登记',batch.launched],['已结束',batch.finished],['通过',batch.counts.PASS||0],['失败 / 阻塞',(batch.counts.FAIL||0)+(batch.counts.BLOCKED||0)],['断言通过率',assertionRate(batch.checks)]]){const metric=el('div');metric.append(el('small',name),el('strong',String(value)));metrics.append(metric);}
   summary.append(metrics);
   if(batch.note)summary.append(el('p',batch.note,'hint'));if(batch.error)summary.append(el('p','批次提交未完成：'+batch.error,'result-fail'));
   summary.append(el('p',`未执行 ${batch.counts.NOT_RUN||0} 条 · 停止 ${batch.counts.STOPPED||0} 条 · 中断 ${batch.counts.INTERRUPTED||0} 条 · ${batch.checks.missing} 条尚无断言；汇总只统计已经产生的断言。`,'hint'));
   const parameters=el('details'),parameterTitle=el('summary','本批次执行参数');parameters.dataset.expansionKey='parameters';parameters.append(parameterTitle);
   const c=batch.config;if(c){parameters.append(el('p',`选项：${{first:'第一项',second:'第二项',custom:'自定义'}[c.question]||c.question}　审批：${approvalLabels[c.approval]||c.approval}　模型：${c.model||'沿用客户端当前模型'}　CDP：${c.cdpPort}`));if(c.question==='custom')parameters.append(el('p','自定义回答：'+c.customText));}else parameters.append(el('p','历史记录的参数分别保存在各用例报告中。'));
   summary.append(parameters);
   const section=el('section');section.append(el('h2','用例执行明细'),el('p','查看报告可展开过程、截图与断言；Session 日志和 Trace 按对应会话保留。','hint'));
   const scroll=el('div',undefined,'table batch-case-table'),table=el('table'),thead=el('thead'),head=el('tr');
   for(const name of ['序号','用例','开始 / 结束','执行结果','断言通过率','详情'])head.append(el('th',name));thead.append(head);table.append(thead);
   const tbody=el('tbody');tbody.id='batchCaseRows';
   for(const entry of batch.entries){
    const job=entry.job,status=job?.status||'NOT_RUN',tr=el('tr');tr.dataset.jobId=job?.id||'';
    const name=el('td',entry.name);name.title=entry.path||'';
    tr.append(el('td',String(entry.number).padStart(2,'0')),name,el('td',job?batchDate(job.startedAt)+'\n'+batchDate(job.endedAt):'—'),el('td',(batchLabels[status]||status)+(status==='RUNNING'&&job.phase?'\n'+(phaseLabels[job.phase]||job.phase):''),batchResultClass(status)));
    const checks=job?.result?.checks||[],rate=el('td',assertionRate({total:checks.length,passed:checks.filter(c=>c.pass===true).length}));
    if(checks.some(c=>c.pass!==true))rate.className='result-fail';tr.append(rate);
    const actions=el('td');if(job){actions.append(link('查看报告','/reports/'+encodeURIComponent(job.id)),link('Trace 记录','/?trace='+encodeURIComponent(job.id)));if(job.sessionId)actions.append(link('下载 Session 日志','/sessions/'+encodeURIComponent(job.sessionId)+'/download'));else actions.append(el('span','未获取会话 ID','hint'));}
    else actions.append(el('span','尚未启动','hint'));
    if(job&&!job.stopRequested&&canStopJob(job)){
     const stop=el('button',job.status==='QUEUED'?'取消排队':'强制停止','result-fail');
     stop.onclick=async()=>{stop.disabled=true;try{
      const stateResponse=await fetch('/api/state'),state=await stateResponse.json();
      const response=await fetch('/api/jobs/'+encodeURIComponent(job.id)+'/stop',{method:'POST',headers:{'content-type':'application/json','x-console-token':state.token},body:'{}'}),result=await response.json();
      if(!response.ok)throw Error(result.error);await refresh();
     }catch(e){error.textContent=e.message;stop.disabled=false;}};
     actions.append(stop);
    }
    if(job?.error)actions.append(el('p',job.error,'result-fail'));
    if(job?.queueHold)actions.append(el('p','等待客户端恢复：'+job.queueHold,'result-fail'));
    if(job?.handoff)actions.append(el('p','页面交接：'+job.handoff.reason,job.handoff.ready?'':'result-fail'));
    const failed=checks.filter(c=>c.pass!==true);if(failed.length){const details=el('details'),label=el('summary',`失败断言 ${failed.length} 项`,'result-fail');details.dataset.expansionKey='checks-'+job.id;details.append(label);for(const check of failed)details.append(el('p',check.name+(check.actual!==undefined?' · '+(typeof check.actual==='string'?check.actual:JSON.stringify(check.actual)):''),'result-fail'));actions.append(details);}
    tr.append(actions);tbody.append(tr);
   }
   table.append(tbody);scroll.append(table);section.append(scroll);content.replaceChildren(summary,section);
   for(const details of content.querySelectorAll('details'))details.open=expanded.has(details.dataset.expansionKey);fingerprint=nextFingerprint;
  }catch(e){error.textContent=e.message;}
 }
 await refresh();const timer=setInterval(refresh,2000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
