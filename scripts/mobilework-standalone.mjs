import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function dispatchStandalone({number,args=[],config}){
 if(process.env.MW_TASK_CONTROL_URL&&process.env.MW_TASK_CONTROL_TOKEN)return false;
 const base='http://127.0.0.1:'+Number(process.env.MW_CONSOLE_PORT||18888);
 const state=async()=>{const r=await fetch(base+'/api/state',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('控制台状态不可用');return r.json();};
 let s,lastConnectionError;try{s=await state();}catch(error){
  lastConnectionError=error;
  const child=spawn(process.execPath,[path.join(root,'local-console/launch.mjs'),'--no-open'],{cwd:root,detached:true,stdio:'ignore',windowsHide:true});child.unref();
  for(let n=0;n<40;n++){await delay(250);try{s=await state();break;}catch(error){lastConnectionError=error;}}
 }
 if(!s||path.resolve(s.projectRoot||'').toLowerCase()!==root.toLowerCase())throw Error('未连接到本项目控制台，未直接操作客户端；请启动18888测试平台'+(lastConnectionError?'；连接原因：'+(lastConnectionError.cause?.code||lastConnectionError.cause?.message||lastConnectionError.message):''));
 if(s.capabilities?.taskIsolation!==2)throw Error('控制台需重启加载任务隔离升级，未绕过调度执行');
 if(s.capabilities?.serialOnly!==1)throw Error('控制台需在空闲后重启加载串行调度，未向旧服务提交任务');
 const script=s.scripts.find(x=>path.resolve(x.path)===path.join(root,'scripts',`run-client-case${String(number).padStart(3,'0')}.mjs`));
 if(!script)throw Error('控制台缺少本条脚本入口');
 const response=await fetch(base+'/api/run',{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:JSON.stringify({scriptId:script.id,args,config})});
 const created=await response.json();if(!response.ok)throw Error(created.error);
 console.log('已通过统一调度执行：'+base+'/reports/'+created.id);
 let previous='';
 for(;;){
  const r=await fetch(base+'/api/jobs/'+created.id,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('读取调度任务失败');const job=await r.json();
  if(job.log&&job.log!==previous){process.stdout.write(job.log.startsWith(previous)?job.log.slice(previous.length):job.log);previous=job.log;}
  if(!['QUEUED','RUNNING'].includes(job.status)){
   console.log('执行结果：'+job.status+(job.error?'；'+job.error:''));
   process.exitCode=['PASS','CHECKED','RESUMED'].includes(job.status)?0:job.status==='BLOCKED'?2:1;return true;
  }
  if(job.queueHold)throw Error('任务已排队但客户端待恢复：'+job.queueHold+'；可在控制台取消或等待恢复');
  await delay(1000);
 }
}
