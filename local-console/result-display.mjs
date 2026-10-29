import {batchLabels,phaseLabels} from './batches.mjs';

export const resultGuide='通过：本次业务断言通过；失败：断言不满足或执行出错；阻塞：前置条件或执行环境不满足，无法完成验证；已停止：执行被停止，不代表功能失败。录像单独记录，不改变业务结果。';
export function describeResult(job){
 const status=job?.status||'NOT_RUN',recording=job?.recording;
 const active=['RUNNING','QUEUED'].includes(status);
 const label=active&&job.phase?(phaseLabels[job.phase]||batchLabels[status]):(batchLabels[status]||status);
 const explanation={PASS:'本次业务断言通过。',FAIL:'业务断言不满足或执行出错，请结合报告判断。',BLOCKED:'验证未完成；需先处理前置条件或执行环境问题。',STOPPED:'执行已停止，不作为功能失败结论。',INTERRUPTED:'执行中断，结果可能不完整。',REVIEW:'已记录行为，仍需人工复核。',CHECKED:'仅完成检查，不代表业务验收通过。',RESUMED:'续跑已结束，请结合报告核对业务断言。',EXITED:'执行已结束，尚无明确业务判定。'}[status]||'';
 const reason=['FAIL','BLOCKED','INTERRUPTED','STOPPED','REVIEW'].includes(status)?String(job?.result?.error||job?.error||''):'';
 const firstFrame=/首帧|first frame/i.test(recording?.error||'');
 const videoWarning=['ERROR','INTERRUPTED'].includes(recording?.status);
 const videoLabel=({STARTING:'录像：准备中',RECORDING:'录像：录制中',FINALIZING:'录像：保存中',COMPLETED:'录像：已保存',ERROR:'录像：失败 · 证据不完整',INTERRUPTED:'录像：中断 · 证据不完整',DISABLED:'录像：未开启',SKIPPED:'录像：本次不录制'}[recording?.status])||(recording?.available?'录像：已保存':job?'录像：无记录':'');
 const videoHint=videoWarning?(firstFrame?'采集首帧超时。最小化或收至托盘可能影响采集；请保持 MobileWork 窗口展开后重试，具体原因仍需核对。':'请查看录像错误和执行日志。')+' 录像异常不改变业务结果，可结合截图、日志和断言核验。':'';
 const tone=['FAIL'].includes(status)?'result-fail':['BLOCKED','INTERRUPTED','REVIEW'].includes(status)?'result-warning':['PASS'].includes(status)?'result-pass':'';
 return {label,explanation,reason,tone,videoLabel,videoWarning,videoHint,videoError:String(recording?.error||'')};
}

export function appendResultDescription(container,job){
 const d=describeResult(job);
 const add=(tag,text,cls)=>{const node=document.createElement(tag);node.textContent=text;node.className=cls;container.append(node);return node;};
 container.classList.add('execution-result');
 const badge=add('span','业务：'+d.label,'script-status '+d.tone);badge.title=d.explanation;
 if(d.explanation)add('small',d.explanation,'result-explanation');
 if(d.reason)add('small','原因：'+d.reason,'result-reason '+d.tone);
 if(d.videoLabel)add('small',d.videoLabel,'recording-result '+(d.videoWarning?'result-warning':'hint'));
 if(d.videoWarning){
  const details=add('details','','recording-diagnostic'),summary=document.createElement('summary');summary.textContent='录像原因与处理建议';details.append(summary);
  const body=document.createElement('p');body.textContent=(d.videoError?d.videoError+'。':'')+d.videoHint;details.append(body);
 }
}
