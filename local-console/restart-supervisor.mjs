import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const [portText,pidText,projectRoot,dataDir,previousInstance]=process.argv.slice(2);
const port=Number(portText),pid=Number(pidText);
if(!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(pid)||pid<1||!path.isAbsolute(projectRoot)||!path.isAbsolute(dataDir)||!previousInstance)process.exit(2);
const record=async(status,detail='')=>fs.writeFile(path.join(dataDir,'console-restart.json'),JSON.stringify({status,detail,time:new Date().toISOString()})).catch(()=>{});
const alive=()=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const listening=()=>new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});});
process.send?.({ready:true});
await record('waiting','等待旧控制台退出');
let deadline=Date.now()+30000;
while(Date.now()<deadline&&(alive()||await listening()))await delay(200);
if(alive()||await listening()){await record('error','旧控制台或端口未释放，未启动新进程');process.exit(1);}
const child=spawn(process.execPath,[path.join(projectRoot,'local-console','launch.mjs'),'--no-open'],{
 cwd:projectRoot,env:{...process.env,MW_CONSOLE_PORT:String(port)},detached:true,windowsHide:true,stdio:'ignore'
});
let spawnError;
child.on('error',error=>{spawnError=error;});child.unref();
deadline=Date.now()+30000;
while(Date.now()<deadline){
 if(spawnError){await record('error','启动新控制台失败：'+spawnError.message);process.exit(1);}
 try{
  const response=await fetch(`http://127.0.0.1:${port}/api/state`,{signal:AbortSignal.timeout(1000)}),state=await response.json();
  if(response.ok&&path.resolve(state.projectRoot).toLowerCase()===path.resolve(projectRoot).toLowerCase()&&state.instanceId&&state.instanceId!==previousInstance){await record('ready','新控制台已响应');process.exit(0);}
 }catch{}
 await delay(300);
}
await record('error','新控制台未通过实例检查，请检查18888端口和启动日志');process.exit(1);
