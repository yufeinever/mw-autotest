// Reuse the identity-checked per-job stop API, including on running consoles.
export function canStopJob(job){
 return Boolean(job.schedulingHold)||['QUEUED','RUNNING'].includes(job.status)||
  (job.status==='FAIL'&&job.schedulingHold&&!job.modelCompleted&&Boolean(job.sessionId||job.result?.sessionId))||
  (['BLOCKED','INTERRUPTED'].includes(job.status)&&!job.modelCompleted&&
   Boolean(job.sessionId||job.result?.sessionId||job.schedulingHold||job.status==='INTERRUPTED'&&job.pid));
}
export async function stopAllJobs(api,progress=()=>{}){
 const initial=await api('/api/state'),targets=initial.jobs.filter(canStopJob),errors=new Map();
 const stop=async job=>{
  if(job.stopRequested)return;
  try{await api('/api/jobs/'+encodeURIComponent(job.id)+'/stop',{});}catch(e){errors.set(job.id,e.message);}
 };
 // Cancel the entire queue before stopping workers, so worker completion
 // cannot release the next queued task as a consequence of this operation.
 const queued=targets.filter(j=>j.status==='QUEUED');
 progress(`正在取消 ${queued.length} 条排队任务…`);
 await Promise.all(queued.map(stop));
 const current=await api('/api/state');
 const ids=new Set(targets.map(j=>j.id));
 const uncancelled=current.jobs.filter(j=>ids.has(j.id)&&j.status==='QUEUED');
 if(uncancelled.length)return {total:targets.length,stopped:current.jobs.filter(j=>ids.has(j.id)&&j.status==='STOPPED').length,
  remaining:current.jobs.filter(j=>ids.has(j.id)&&canStopJob(j)).map(j=>({id:j.id,name:j.name||j.id,message:errors.get(j.id)||'排队取消尚未完成，为避免启动下一条，暂未停止执行中的任务，请重试'}))};
 const running=current.jobs.filter(j=>ids.has(j.id)&&canStopJob(j)&&j.status!=='QUEUED');
 progress(`正在停止 ${running.length} 条执行中或待处理会话任务…`);
 await Promise.all(running.map(stop));
 const final=await api('/api/state');
 const remaining=final.jobs.filter(j=>ids.has(j.id)&&canStopJob(j));
 const stopped=final.jobs.filter(j=>ids.has(j.id)&&j.status==='STOPPED').length;
 return {total:targets.length,stopped,remaining:remaining.map(j=>({id:j.id,name:j.name||j.id,message:errors.get(j.id)||j.error||'停止尚未确认'}))};
}
