import {uniqueClientPage} from './client-page.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
const exec=promisify(execFile);
async function bounded(promise,ms){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('客户端停止接口响应超时')),ms);})]);}
 finally{clearTimeout(timer);}
}
export async function killScript(job){
 if(!Number.isInteger(job.pid)||job.pid<=0)throw Error('没有可核实的脚本进程，不能强制结束未知进程');
 // Windows PowerShell defaults to a legacy code page when stdout is piped.
 // Node decodes UTF-8: Chinese project paths would otherwise fail identity checks.
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter "ProcessId=${job.pid}"; if($p){@{command=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`],{windowsHide:true,timeout:8000,encoding:'utf8'});
 if(!stdout.trim())return;
 const p=JSON.parse(stdout);
 const created=Date.parse(p.created),started=Date.parse(job.startedAt);
 if(!job.path||!p.command?.includes(job.path)||!Number.isFinite(created)||!Number.isFinite(started)||Math.abs(created-started)>15000)throw Error('进程身份核对不通过，未结束该进程（路径或启动时间不匹配）');
 await exec('taskkill.exe',['/PID',String(job.pid),'/T','/F'],{windowsHide:true,timeout:10000});
}
export async function stopSession(job,{connection}={}){
 const id=job.result?.sessionId||job.sessionId||job.log?.match(/(?:任务已发送|续跑既有会话)\s+(ses_[A-Za-z0-9]+)/)?.[1];
 if(!id)return '未获取会话 ID，未操作客户端会话；请核对客户端';
 if(connection){
  const base=connection.baseUrl,headers={Authorization:'Basic '+btoa(connection.opencodeUsername+':'+connection.opencodePassword)};
  const get=await fetch(base+'/session/'+id,{headers,signal:AbortSignal.timeout(5000)});if(!get.ok)throw Error('核对会话失败 HTTP '+get.status);
  const session=await get.json();if(session.id!==id)throw Error('会话 ID 不一致');
  const response=await fetch(base+'/session/'+id+'/abort'+(session.directory?'?directory='+encodeURIComponent(session.directory):''),{method:'POST',headers,signal:AbortSignal.timeout(5000)});
  if(!response.ok||await response.json()!==true)throw Error('客户端未确认停止本次会话');return '客户端已确认停止本次会话 '+id;
 }
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${job.config.cdpPort||9223}`,{timeout:5000});
 try{
  const page=uniqueClientPage(browser);
  if(!page)throw Error('未找到客户端主界面');
  await bounded(page.evaluate(async id=>{
   const i=await window.__OPENWORK_ELECTRON__.invokeDesktop('engineInfo');
   if(typeof i?.baseUrl!=='string'||!i.baseUrl.trim())throw Error('客户端引擎尚未就绪：缺少引擎地址，未确认会话停止');
   const base=i.baseUrl.replace(/\/$/,''),headers={Authorization:'Basic '+btoa(i.opencodeUsername+':'+i.opencodePassword)};
   const get=await fetch(base+'/session/'+id,{headers,signal:AbortSignal.timeout(5000)});
   if(!get.ok)throw Error('核对会话失败 HTTP '+get.status);
   const s=await get.json();if(s.id!==id)throw Error('会话 ID 不一致');
   const r=await fetch(base+'/session/'+id+'/abort'+(s.directory?'?directory='+encodeURIComponent(s.directory):''),{method:'POST',headers,signal:AbortSignal.timeout(5000)});
   if(!r.ok||await r.json()!==true)throw Error('客户端未确认停止会话');
  },id),15000);
  return '客户端已确认停止本次会话 '+id;
 }finally{await browser.close();}
}
export async function releaseOwnedLock(job,root){
 const file=path.join(root,'runs','.client-case001.lock');
 try{const l=JSON.parse(await fs.readFile(file,'utf8'));if(l.pid!==job.pid)return;
  // Preserve existing evidence; expose it in the stopped run's report.
  const dir=await fs.realpath(l.dir),runs=await fs.realpath(path.join(root,'runs'));
  const rel=path.relative(runs,dir);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))return;
  job.reportPath=path.join(dir,'执行报告.md');
  try{job.result=JSON.parse(await fs.readFile(path.join(dir,'执行结果.json'),'utf8'));}catch{
   const files=await fs.readdir(dir);job.result={checks:[],evidence:files.filter(f=>f.endsWith('.png')).sort().map(f=>({step:path.basename(f,'.png'),screenshot:f}))};
  }
  await fs.unlink(file);
 }catch(e){if(e.code!=='ENOENT')throw e;}
}
