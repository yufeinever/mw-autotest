import fs from 'node:fs/promises';
import path from 'node:path';
import {loadTraceData} from './trace-data.mjs';
import {toObservatory} from './observatory-data.mjs';
export {jobSessionId} from './trace-data.mjs';

export async function loadJobTrace(job,readLive){
 const readSaved=async name=>{
  const root=await fs.realpath(path.dirname(job.reportPath)),file=await fs.realpath(path.join(root,name)),relative=path.relative(root,file);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Trace 文件不在报告目录内');
  if((await fs.stat(file)).size>50000000)throw Error('Trace 文件超过读取上限');
  return JSON.parse(await fs.readFile(file,'utf8'));
 };
 const trace=await loadTraceData(job,{readSaved,readLive});
 if(!trace.observatory){let source;try{source=await readSaved(trace.sessionId+'-session-log.json');}catch{}trace.observatory=toObservatory(trace,source);}
 return trace;
}
