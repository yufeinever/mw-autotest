import {readEngineConnection,engineRequest} from './engine-client.mjs';
import {isClientPageUrl,uniqueClientPage} from './client-page.mjs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {enableCdpConfig} from './cdp-config.mjs';
import {testEnvironment} from './environment.mjs';
const exec=promisify(execFile);
const executable=testEnvironment.clientExecutable;
const ps=async script=>(await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000})).stdout.trim();
export async function probeCdp(port=9223){
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('CDP端口无效');
 try{const r=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1200)});const rows=await r.json();return {connected:r.ok&&Array.isArray(rows)&&rows.filter(x=>x.type==='page'&&isClientPageUrl(x.url)).length===1,port};}catch{return {connected:false,port};}
}
async function processes(){
 const escaped=executable.replaceAll("'","''");
 const raw=await ps(`@(Get-CimInstance Win32_Process -Filter "Name='MobileWork.exe'" | Where-Object { $_.ExecutablePath -eq '${escaped}' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId) | ConvertTo-Json -Compress`);
 return raw?[JSON.parse(raw)].flat().map(p=>p.ProcessId):[];
}
async function assertIdle(port){
 if((await probeCdp(port)).connected){
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000});
  try{const page=uniqueClientPage(browser);
   const busy=await page.evaluate(async()=>{
    const buttons=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>(b.getAttribute('aria-label')||b.textContent).trim());
    const draft=[...document.querySelectorAll('[contenteditable="true"]')].some(e=>e.getClientRects().length&&e.innerText.trim());
    return draft||buttons.some(b=>['停止','允许一次','跳过'].includes(b));
   });
   const states=await engineRequest(await readEngineConnection(page),'/session/status');
   if(busy||Object.values(states).some(s=>s.type!=='idle'))throw Error('客户端存在运行任务、待处理交互或未发送草稿，请处理后再重启');
  }finally{await browser.close();}return;
 }
 // CDP is off: use the application's local UI bridge, never assume idle from a closed port.
 const d=JSON.parse(await fs.readFile(testEnvironment.discoveryPath,'utf8'));
 if(typeof d?.baseUrl!=='string'||!d.baseUrl.trim())throw Error('客户端本地接口尚未就绪，无法核实空闲；未退出客户端');
 const r=await fetch(d.baseUrl.replace(/\/$/,'')+'/snapshot',{headers:{Authorization:'Bearer '+d.token},signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('无法检查客户端状态，请先手动完全退出客户端，再点击按钮启动');
 const s=await r.json(),stop=s.actions?.find(a=>a.id==='composer.stop'),send=s.actions?.find(a=>a.id==='composer.send');
 if(!s.ok||!stop||!send||s.busyActionId||stop.disabled!==true||send.disabled!==true)throw Error('客户端有任务或草稿，或无法确认空闲；请处理后再重试');
}
export async function restartFlow({checkIdle,enable,close,launch,probe,wait=ms=>new Promise(r=>setTimeout(r,ms)),attempts=40}){
 await checkIdle();const config=await enable();if(config?.allowed!==true)throw Error('CDP 配置核对失败：packagedCdpAllowed 未确认是 true，未退出或启动客户端');await close();await launch();
 for(let i=0;i<attempts;i++){const state=await probe();if(state.connected)return {...config,...state,restarted:true};await wait(500);}
 throw Error('客户端已启动，但未能连接 CDP 主界面。请检查客户端启动提示后刷新状态；未强制结束新进程');
}
export async function requestClientQuit(connected,connect){
 if(!connected)throw Error('配置已启用，但当前客户端没有开启 CDP，无法自动正常退出。请右键系统托盘中的 MobileWork 图标选择“退出”（不是关闭窗口），然后再次点击“一键启用并重启”；按钮将自动带 CDP 参数启动。');
 const browser=await connect();
 try{
  const page=uniqueClientPage(browser);
  if(!page)throw Error('未找到 MobileWork 主界面，未执行退出');
  await page.evaluate(()=>{
   if(typeof window.__OPENWORK_ELECTRON__?.shell?.quit!=='function')throw Error('当前版本没有正常退出接口');
   // Let evaluation return before shutdown disconnects the CDP transport.
   setTimeout(()=>window.__OPENWORK_ELECTRON__.shell.quit(),100);
  });
 }finally{await browser.close();}
}
export async function restartClient(backupDir,port=9223){
 await probeCdp(port);let ids=[];
 return restartFlow({
  checkIdle:async()=>{ids=await processes();if(ids.length>1)throw Error('存在多个客户端主进程，无法安全重启');if(ids.length)await assertIdle(port);},
  enable:()=>enableCdpConfig(backupDir),
  close:async()=>{if(!ids.length)return;await assertIdle(port);
   const id=ids[0];await requestClientQuit((await probeCdp(port)).connected,()=>chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000}));
   for(let i=0;i<40;i++){if(!(await processes()).includes(id))return;await new Promise(r=>setTimeout(r,500));}
   throw Error('已请求正常退出，但客户端仍在后台运行，请从托盘退出后重试；未强制终止进程');
  },
  launch:()=>new Promise((resolve,reject)=>{const child=spawn(executable,[],{detached:true,stdio:'ignore',windowsHide:false,env:{...process.env,OPENWORK_ELECTRON_REMOTE_DEBUG_PORT:String(port)}});child.once('error',()=>reject(Error('无法启动 MobileWork，请检查安装路径')));child.once('spawn',()=>{child.unref();resolve();});}),
  probe:()=>probeCdp(port)
 });
}
