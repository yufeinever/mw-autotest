import {connectClient} from './client-connection.mjs';
import {uniqueClientPage} from './client-page.mjs';

const bounded=(promise,ms,message)=>{
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
};

// Use the same attachment path as runners and recording. A listening port or
// a target list alone cannot prove Playwright can initialize the application.
export async function probeCdp(port=9223,{connect=()=>connectClient(`http://127.0.0.1:${port}`,{timeout:7000})}={}){
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('CDP端口无效');
 const started=Date.now();let browser,stage='连接客户端',error='';
 try{
  browser=await connect();stage='识别主页面';
  const page=uniqueClientPage(browser);stage='检查页面响应';
  const ready=await bounded(page.evaluate(()=>({ready:document.readyState,body:Boolean(document.body)})),2500,'主页面响应超时');
  if(!ready?.body||!['interactive','complete'].includes(ready.ready))throw Error('MobileWork主页面尚未加载完成');
 }catch(cause){
  // Playwright errors contain websocket identifiers and verbose protocol logs.
  const detail=String(cause.message||cause).split(/\r?\n/)[0].slice(0,220);
  error=`${stage}失败：${detail}。请确认MobileWork已打开并启用CDP，处理客户端异常后点击“检查连接 / 重新连接”。`;
 }finally{
  if(browser)try{await bounded(browser.close(),2000,'检查连接释放超时');}
  catch{error||='连接检查结束，但释放检查连接未确认，请重新连接。';}
 }
 return {connected:!error,port,checkedAt:new Date().toISOString(),elapsedMs:Date.now()-started,stage:error?stage:'主页面可用',error:error||null};
}
