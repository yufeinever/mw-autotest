export const batchLabels={SUBMITTING:'提交中',RUNNING:'执行中',PASS:'通过',FAIL:'失败',BLOCKED:'阻塞',STOPPED:'已强制停止',INTERRUPTED:'已中断',CHECKED:'检查完成（含预检）',RESUMED:'续跑完成',EXITED:'已结束（含未判定）',NOT_RUN:'未执行'};
batchLabels.REVIEW='已观察·待复核';
export const batchResultClass=status=>['FAIL','BLOCKED','STOPPED','INTERRUPTED'].includes(status)?'result-fail':['PASS','CHECKED','RESUMED'].includes(status)?'result-pass':'';
export const assertionRate=checks=>checks.total?`${checks.passed}/${checks.total}（${Math.round(100*checks.passed/checks.total)}%）`:'—';
export const batchDate=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—';
batchLabels.QUEUED='排队中';
export const phaseLabels={QUEUED:'排队中',CHECKING_CONNECTION:'检查连接',WAITING_CONNECTION:'等待连接',PREPARING:'提交任务',WAITING_MODEL:'等待模型',INTERACTING:'处理交互',EVIDENCE:'记录截图',VERIFYING:'核验结果',FINALIZING:'收尾中',STOPPING:'停止中',FINISHED:'已结束'};
export function publicJob({log,ownedDraft,releasedDraft,...job}){return {...job,sessionId:job.result?.sessionId||job.sessionId||log?.match(/(?:任务已发送|续跑既有会话)\s+(ses_[A-Za-z0-9]+)/)?.[1]};}
export function summarizeBatch(batch,jobs){
 const own=jobs.filter(j=>batch.legacy?!j.batchId:j.batchId===batch.id);
 const entries=batch.legacy?own.map((job,i)=>({scriptId:job.scriptId,name:job.name,path:job.path,number:i+1,job:publicJob(job)})):batch.scripts.map(script=>({...script,job:own.find(j=>j.scriptId===script.scriptId)?publicJob(own.find(j=>j.scriptId===script.scriptId)):null}));
 const launched=entries.filter(e=>e.job),running=launched.filter(e=>e.job.status==='RUNNING').length,queued=launched.filter(e=>e.job.status==='QUEUED').length,finished=launched.length-running-queued;
 const counts={};for(const entry of entries){const s=entry.job?.status||'NOT_RUN';counts[s]=(counts[s]||0)+1;}
 const checks={total:0,passed:0,failed:0,missing:0};
 for(const entry of entries){const list=entry.job?.result?.checks||[];checks.total+=list.length;checks.passed+=list.filter(c=>c.pass===true).length;checks.failed+=list.filter(c=>c.pass!==true).length;if(!list.length)checks.missing++;}
 let status;
 if(batch.submission==='SUBMITTING')status='SUBMITTING';
 else if(!running&&entries.some(e=>e.job?.queueHold))status='BLOCKED';
 else if(running||queued)status='RUNNING';
 else if(counts.FAIL||checks.failed)status='FAIL';
 else if(batch.submission==='INTERRUPTED'||counts.INTERRUPTED)status='INTERRUPTED';
 else if(batch.error||counts.BLOCKED||counts.NOT_RUN)status='BLOCKED';
 else if(counts.STOPPED)status='STOPPED';
 else if(entries.length&&counts.PASS===entries.length)status='PASS';
 else if(counts.REVIEW)status='REVIEW';
 else if(counts.EXITED||!entries.length||launched.some(e=>!['PASS','CHECKED','RESUMED'].includes(e.job.status)))status='EXITED';
 else if(counts.CHECKED)status='CHECKED';else status='RESUMED';
 const times=[batch.submissionEndedAt,...own.map(j=>j.endedAt)].filter(Boolean).sort();
 const endedAt=['SUBMITTING','RUNNING'].includes(status)?null:times.at(-1)||null;
 return {...batch,status,endedAt,total:entries.length,launched:launched.length,finished,running,queued,counts,checks,entries};
}
export function collectBatches(batches,jobs){
 const result=batches.map(b=>summarizeBatch(b,jobs));
 const legacy=jobs.filter(j=>!j.batchId);
 if(legacy.length)result.push(summarizeBatch({id:'legacy-history',name:'历史执行记录',mode:'archive',legacy:true,submission:'SUBMITTED',startedAt:[...legacy].map(j=>j.startedAt).sort()[0],scope:'历史归档 · 原记录无批次信息',note:'旧记录未记录执行批次，集中归档展示；不推断同一次执行，不改写原用例结果。'},legacy));
 return result.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id));
}
