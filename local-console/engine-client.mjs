// Credentials stay in the Node process; renderer origins never issue engine HTTP requests.
export async function readEngineConnection(page){
 const info=await page.evaluate(async()=>{
  const i=await window.__OPENWORK_ELECTRON__.invokeDesktop('engineInfo');
  const redactionSecrets=[];
  try{const data=await window.__MOBILEWORK__.invoke('models:list');for(const m of data.models||[])if(m.apiKey)redactionSecrets.push(m.apiKey);}catch{}
  return {baseUrl:i?.baseUrl,opencodeUsername:i?.opencodeUsername,opencodePassword:i?.opencodePassword,redactionSecrets};
 });
 validateEngineConnection(info);return info;
}
export function validateEngineConnection(info){
 let url;try{url=new URL(info?.baseUrl);}catch{throw Error('客户端引擎尚未就绪：缺少有效引擎地址');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw Error('拒绝非本机引擎地址');
 return url;
}
export async function engineRequest(info,route,{method='GET',timeoutMs=15000}={}){
 validateEngineConnection(info);
 if(!route.startsWith('/')||route.startsWith('//'))throw Error('引擎接口路径无效');
 const response=await fetch(info.baseUrl.replace(/\/$/,'')+route,{method,redirect:'error',headers:{Authorization:'Basic '+Buffer.from(info.opencodeUsername+':'+info.opencodePassword).toString('base64')},signal:AbortSignal.timeout(timeoutMs)});
 if(!response.ok)throw Error('引擎接口请求失败：HTTP '+response.status);
 return response.json();
}
