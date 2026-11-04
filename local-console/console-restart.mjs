import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const supervisor=fileURLToPath(new URL('./restart-supervisor.mjs',import.meta.url));
export async function prepareConsoleRestart({port,projectRoot,dataDir,instanceId}){
 const child=spawn(process.execPath,[supervisor,String(port),String(process.pid),projectRoot,dataDir,instanceId],{
  cwd:projectRoot,detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']
 });
 try{
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('重启守护进程启动超时')),5000);
   child.once('message',message=>{clearTimeout(timer);message?.ready?resolve():reject(Error('重启守护进程未就绪'));});
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('exit',()=>{clearTimeout(timer);reject(Error('重启守护进程提前退出'));});
  });
 }catch(error){child.kill();throw error;}
 child.disconnect();child.unref();
 return {shutdown(server){server.close();server.closeIdleConnections?.();}};
}
