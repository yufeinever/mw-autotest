import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readSessionLog} from '../local-console/session-log.mjs';
import {buildTrace,traceRuleVersion} from '../local-console/trace.mjs';
import {getClientCase} from './client-case-catalog.mjs';
import {toObservatory} from '../local-console/observatory-data.mjs';

// Always runs before the final result is persisted, including blocked/failed sessions.
export async function saveRunTrace({page,sessionId,number,dir,checks,log=()=>{},readLog}){
 const definition=getClientCase(number);
 try{
  const data=readLog?await readLog(true):await page.evaluate(readSessionLog,{sessionId,includeChildren:true});
  if(data.sessionId!==sessionId)throw Error('Trace返回的会话ID与本次执行不一致');
  await fs.writeFile(path.join(dir,sessionId+'-session-log.json'),JSON.stringify(data,null,2));
  const trace=buildTrace(data,{expectedSkills:definition.skills,caseId:definition.id,origin:'run-snapshot'});
  trace.observatory=toObservatory(trace,data);
  trace.sourceSha256=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  await fs.writeFile(path.join(dir,'trace.json'),JSON.stringify(trace,null,2));
  checks.push(...trace.checks);
  log('Trace 已留存',trace.summary.tools+' 次工具调用；Skill '+trace.summary.passed+'/'+trace.summary.total);
  return {path:'trace.json',ruleVersion:traceRuleVersion,expectedSkills:definition.skills,summary:trace.summary,warnings:trace.warnings};
 }catch(e){
  checks.push({name:'Trace 与 Skill 调用证据可读取',category:'skill-invocation',ruleVersion:traceRuleVersion,pass:false,actual:e.message});
  log('Trace 采集失败',e.message);
  return {ruleVersion:traceRuleVersion,expectedSkills:definition.skills,error:e.message};
 }
}
