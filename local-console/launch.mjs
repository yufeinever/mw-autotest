import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConsole,projectRoot} from './server.mjs';
export async function launchConsole({port=Number(process.env.MW_CONSOLE_PORT||18888),openBrowser=true,create=createConsole}={}){
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('控制台端口必须为1～65535');
  const url='http://127.0.0.1:'+port;let existing,occupied;
  try{const r=await fetch(url+'/api/state',{signal:AbortSignal.timeout(700)});const s=await r.json();occupied=s;if(r.ok&&s.projectRoot&&path.resolve(s.projectRoot).toLowerCase()===projectRoot.toLowerCase()&&s.capabilities?.executionBatches===1&&s.capabilities?.taskScheduling===1)existing=s;}catch{}
  let app;
  if(!existing)try{app=await create({port});}catch(e){
   if(e.code==='EADDRINUSE')throw Error(`固定端口 ${port} 已被占用，未自动换端口。`+(occupied?.projectRoot&&path.resolve(occupied.projectRoot).toLowerCase()===projectRoot.toLowerCase()?'同项目旧服务需要在任务结束后正常关闭，再重新启动；原数据目录保持不变。':'请核对占用程序，未停止其他服务。'));
   throw e;
  }
  console.log('MobileWork 测试控制台：'+url);
  console.log(existing?'此目录的控制台已经运行。':'请保留此窗口；关闭窗口会停止本次控制台。');
  if(openBrowser)spawn('cmd.exe',['/d','/c','start','',url],{windowsHide:true,stdio:'ignore'}).unref();
  return {...app,url,existing:Boolean(existing)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.some(a=>!['--check','--no-open'].includes(a)))throw Error('参数支持 --check、--no-open');
 if(args.includes('--check')){const {runPackageCheck}=await import('../scripts/check-package.mjs');process.exitCode=await runPackageCheck();}
 else try{await launchConsole({openBrowser:!args.includes('--no-open')});}catch(e){console.error('控制台启动失败：'+e.message);process.exitCode=1;}
}
