import {buildTrace,redactTrace,traceRuleVersion} from './trace.mjs';
import {getClientCase} from '../scripts/client-case-catalog.mjs';

export const jobSessionId=job=>job.result?.sessionId||job.sessionId||[...(job.log||'').matchAll(/(?:任务已发送|续跑既有会话)\s+(ses_[A-Za-z0-9]+)/g)].at(-1)?.[1];
// Shared by the HTTP endpoint and browser. Neither path changes prior verdicts.
export async function loadTraceData(job,{readSaved,readLive}){
 const sessionId=jobSessionId(job);
 if(!sessionId)throw Error(job.status==='RUNNING'?'任务尚未取得会话 ID，请稍后刷新':'本次运行没有取得会话 ID，无法生成 Trace；执行日志和已有报告仍保留');
 if(!/^ses_[A-Za-z0-9]+$/.test(sessionId))throw Error('会话 ID 无效');
 let definition;
 const number=Number(job.result?.caseId?.match(/^MW-CLIENT-(\d{3})$/)?.[1]||String(job.path||'').split(/[\\/]/).at(-1).match(/^run-client-case(\d{3})\.mjs$/)?.[1]);
 if(number>=1&&number<=16)definition=getClientCase(number);
 const expectedSkills=definition?.skills||job.result?.trace?.expectedSkills||[],caseId=definition?.id||job.result?.caseId;
 let diskError;
 if(job.reportPath){
  if(job.result?.trace?.path==='trace.json')try{
   const trace=await readSaved('trace.json');
   if(trace.format!=='mobilework-trace'||trace.sessionId!==sessionId||trace.ruleVersion!==traceRuleVersion||!Array.isArray(trace.events)||!Array.isArray(trace.checks)||!trace.summary)throw Error('Trace 格式、版本或会话归属不匹配');
   return redactTrace({...trace,origin:'run-snapshot'});
  }catch(e){diskError=e.message;}
  try{
   const data=await readSaved(sessionId+'-session-log.json');
   if(data.sessionId!==sessionId)throw Error('历史日志会话 ID 不匹配');
   return buildTrace(data,{expectedSkills,caseId,origin:'saved-session',collectionError:diskError||(!data.childrenCollected?'历史快照未采集子会话；本页仅核验已有记录':null)});
  }catch(e){diskError=e.message;}
 }
 const data=await readLive(sessionId);
 if(data.sessionId!==sessionId)throw Error('实时日志会话 ID 不匹配');
 return buildTrace(data,{expectedSkills,caseId,origin:'live-session',collectionError:diskError&&'原快照无法读取，已回读实时会话：'+diskError||(!data.childrenCollected?'实时日志接口未采集子会话；本页仅核验已有记录':null)});
}
