import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {connectClient} from '../local-console/client-connection.mjs';
import {uniqueClientPage,isClientPageUrl} from '../local-console/client-page.mjs';
import {requestClientQuit} from '../local-console/cdp-restart.mjs';
import {probeCdp} from '../local-console/cdp-readiness.mjs';
import {readEnvironment} from '../local-console/environment.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
const exec=promisify(execFile),blocked=message=>Object.assign(Error(message),{blocked:true});
export async function clientProcess(pid){
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`],{windowsHide:true});return stdout.trim()?JSON.parse(stdout):null;
}
export async function browserPid(page){const session=await page.context().browser().newBrowserCDPSession();try{return (await session.send('SystemInfo.getProcessInfo')).processInfo.find(item=>item.type==='browser').id;}finally{await session.detach();}}
export function validateClientRestart(value,previous,edition=process.env.MW_CLIENT_EDITION){
 const allowed=(edition?[edition]:['enterprise','public']).map(key=>path.resolve(readEnvironment(key).clientExecutable).toLowerCase());
 if(!/^[a-f0-9-]{36}$/.test(value.owner)||!Number.isInteger(value.oldPid)||value.oldPid<=0||!allowed.includes(path.resolve(value.executable).toLowerCase())||!isClientPageUrl(value.originUrl)||!['quitting','launching','launched'].includes(value.stage)||Object.keys(value).some(key=>!['owner','oldPid','executable','originUrl','stage'].includes(key)))throw Error('客户端正常重启归属无效');
 if(previous&&(['owner','oldPid','executable','originUrl'].some(key=>value[key]!==previous[key])||['quitting','launching','launched'].indexOf(value.stage)<['quitting','launching','launched'].indexOf(previous.stage)))throw Error('不能替换客户端重启身份或回退阶段');
}
export async function verifyClientRestartPort(job,port,{connect=connectClient,pidOf=browserPid,processInfo=clientProcess}={}){
 const owned=job.composerResources?.clientRestart,previous=job.recoveryConnection;
 if(owned){validateClientRestart(owned,undefined,job.config?.clientEdition);if(owned.stage!=='launched')throw blocked('原任务尚未确认启动新客户端，不能切换恢复端口');}
 if(!owned&&!previous)throw blocked('原任务没有客户端重启归属，不能切换恢复端口');
 const source=owned||previous;
 const browser=await connect('http://127.0.0.1:'+port,{timeout:10000,clientEdition:job.config?.clientEdition});
 try{
  const page=uniqueClientPage(browser),newPid=await pidOf(page),process=await processInfo(newPid);
  if(newPid===source.oldPid||!process||path.resolve(process.ExecutablePath).toLowerCase()!==path.resolve(source.executable).toLowerCase()||previous&&(previous.port!==port||previous.newPid!==newPid))throw blocked('新端口未确认属于原任务重启后的客户端进程');
  if(!previous&&page.url()!==source.originUrl)throw blocked('新客户端页面与原任务重启前页面不一致，未切换恢复端口');
  return {port,owner:source.owner,oldPid:source.oldPid,newPid,executable:source.executable,originUrl:source.originUrl};
 }finally{await browser.close();}
}
async function launch(executable,port){await new Promise((resolve,reject)=>{const child=spawn(executable,[],{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,OPENWORK_ELECTRON_REMOTE_DEBUG_PORT:String(port)}});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});}
export async function resumeClientRestart(resources,config,{checkpoint=async()=>{},processInfo=clientProcess,start=launch,probe=probeCdp,connect=connectClient,pidOf=browserPid,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeout=60000}={}){
 const owned=resources.clientRestart;if(!owned)return null;validateClientRestart(owned,undefined,config.clientEdition);
 if(owned.stage==='quitting'){
  const deadline=Date.now()+timeout;while(await processInfo(owned.oldPid)){if(Date.now()>deadline)throw blocked('正常退出尚未完成，未强杀客户端或重复启动');await wait(250);}
  owned.stage='launching';await checkpoint();await start(owned.executable,config.cdpPort);owned.stage='launched';await checkpoint();
 }
 const deadline=Date.now()+timeout;while(!(await probe(config.cdpPort,{clientEdition:config.clientEdition})).connected){if(Date.now()>deadline)throw blocked('本轮客户端重启尚未开放CDP；未重复启动，请完成客户端启动后恢复收尾');await wait(250);}
 const browser=await connect('http://127.0.0.1:'+config.cdpPort,{timeout:10000,clientEdition:config.clientEdition});
 try{
  const page=uniqueClientPage(browser),newPid=await pidOf(page),process=await processInfo(newPid);
  if(newPid===owned.oldPid||!process||path.resolve(process.ExecutablePath).toLowerCase()!==path.resolve(owned.executable).toLowerCase())throw blocked('CDP未确认是本轮重启的新MobileWork进程');
  await page.getByRole('button',{name:'运行任务',exact:true}).filter({visible:true}).waitFor({timeout:90000});
  if(page.url()!==owned.originUrl){
   const texts=await page.locator('[contenteditable="true"]').filter({visible:true}).allTextContents();if(texts.some(text=>text.trim()))throw blocked('重启后发现未知草稿，未覆盖页面');
   await page.evaluate(url=>{location.hash=new URL(url).hash;},owned.originUrl);await page.waitForURL(owned.originUrl);
  }
  const proof={oldPid:owned.oldPid,newPid,normalQuit:true,newMainProcess:true};delete resources.clientRestart;await checkpoint();return {browser,page,proof};
 }catch(error){await browser.close();throw error;}
}
export async function restartOwnedClient(context){
 const {page,resources,config}=context,connection=await readEngineConnection(page),states=await engineRequest(connection,'/session/status');
 if(Object.values(states).some(state=>state.type!=='idle')||(await page.locator('[contenteditable="true"]').filter({visible:true}).allTextContents()).some(text=>text.trim())||await page.getByRole('dialog').filter({visible:true}).count())throw blocked('重启前仍有任务、草稿或弹框，未退出客户端');
 if(!await page.evaluate(()=>typeof (window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__)?.shell?.quit==='function'))throw blocked('当前版本缺正常退出接口，未用强杀替代重启');
 const pid=await browserPid(page),process=await clientProcess(pid);
 const owned={owner:randomUUID(),oldPid:pid,executable:process.ExecutablePath,originUrl:page.url(),stage:'quitting'};validateClientRestart(owned);resources.clientRestart=owned;await context.checkpointResources();
 await requestClientQuit(true,()=>connectClient('http://127.0.0.1:'+config.cdpPort,{timeout:5000}));
 const next=await resumeClientRestart(resources,config,{checkpoint:context.checkpointResources});await context.replaceClient(next);context.page=next.page;return next.proof;
}
