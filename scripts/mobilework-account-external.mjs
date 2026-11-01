import {connectAccountExternal,isAccountExternalUrl} from '../local-console/client-connection.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});
export function validateAccountExternal(value,previous){
 const endpoint=new URL(value.endpoint),origin=new URL(value.origin);
 if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password||origin.origin!==value.origin||!['http:','https:'].includes(origin.protocol)||!['/agentCenter/myUsage','/operationsMgr/productAnalysis','/p/portal/manual'].includes(value.route)||!Array.isArray(value.beforeIds)||value.beforeIds.some(id=>typeof id!=='string')||typeof value.submitted!=='boolean'||value.targetId!==null&&(typeof value.targetId!=='string'||value.beforeIds.includes(value.targetId))||Object.keys(value).some(key=>!['endpoint','origin','route','beforeIds','submitted','targetId'].includes(key)))throw Error('系统浏览器外链归属无效');
 if(previous&&(['endpoint','origin','route','beforeIds'].some(key=>JSON.stringify(previous[key])!==JSON.stringify(value[key]))||previous.targetId&&previous.targetId!==value.targetId||previous.submitted&&!value.submitted))throw Error('不能替换本轮系统浏览器外链身份');
}
export async function accountBrowserTargets(endpoint){
 const response=await fetch(new URL('/json/list',endpoint),{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw blocked('系统浏览器CDP页面列表不可用');return response.json();
}
export function ownedAccountTarget(targets,owned){
 const candidates=targets.filter(target=>target.type==='page'&&!owned.beforeIds.includes(target.id)&&(!owned.targetId||target.id===owned.targetId)&&isAccountExternalUrl(target.url,owned));
 if(candidates.length>1)throw blocked('出现多个同目标系统浏览器新页面，未接管未知标签');return candidates[0]||null;
}
export async function prepareAccountExternal(context,route){
 const endpoint=process.env.MW_TEST_SYSTEM_BROWSER_CDP_ENDPOINT;if(!endpoint)throw blocked('系统默认浏览器未配置MW_TEST_SYSTEM_BROWSER_CDP_ENDPOINT，无法真实验证外链页面；未点击跳转');
 const portal=await context.page.evaluate(async()=>{const {portal}=await window.__OPENWORK_ELECTRON__.invokeDesktop('runtimeEndpoints');return portal;});
 // Validate the configured local endpoint before issuing any discovery request.
 const owned={endpoint:new URL(endpoint).href,origin:new URL(portal).origin,route,beforeIds:[],submitted:false,targetId:null};validateAccountExternal(owned);
 owned.beforeIds=(await accountBrowserTargets(owned.endpoint)).map(target=>target.id);context.resources.accountExternal=owned;await context.checkpointResources();return owned;
}
export async function observeAccountExternal(context,{timeout=45000}={}){
 const owned=context.resources.accountExternal,end=Date.now()+timeout;let target;
 do{target=ownedAccountTarget(await accountBrowserTargets(owned.endpoint),owned);if(target)break;await context.page.waitForTimeout(200);await context.checkpointResources();}while(Date.now()<end);
 if(!target)throw blocked('系统浏览器未出现本轮预期外链页面；保留未决跳转归属');
 owned.targetId=target.id;await context.checkpointResources();
 const browser=await connectAccountExternal(owned.endpoint,{timeout:10000,external:{...owned}});
 try{
  const pages=browser.contexts().flatMap(context=>context.pages()).filter(page=>isAccountExternalUrl(page.url(),owned));if(pages.length!==1)throw blocked('外链页面连接后身份不唯一');
  const page=pages[0];await page.locator('body').waitFor();
  const facts=await waitAccountExternalPage(page,owned,{timeout});
  context.assert('系统浏览器实际到达本轮目标路由',isAccountExternalUrl(page.url(),owned));
  await context.captureBrowser(page,owned.route==='/agentCenter/myUsage'?'系统浏览器我的用量实际页面':'系统浏览器管理概览实际页面');
  context.assert('目标页面加载结束并展示对应实际业务区域',facts.ready);
  return {origin:owned.origin,route:owned.route,...facts,targetId:owned.targetId};
 }finally{await browser.close();}
}
export async function waitAccountExternalPage(page,owned,{timeout=30000}={}){
 const handle=await page.waitForFunction(route=>{
  const visible=element=>element.getBoundingClientRect().height>0;
  const region=document.querySelector('main,[role="main"]')||document.body,text=region.innerText.trim();
  const busy=[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible)||/^(加载中|正在加载|Loading)[.\s…]*$/i.test(text);
  const failed=/^(404|403|502|503|无法访问此网站|无法访问此页面|页面加载失败|请先登录|登录已过期)/.test(text)||[...document.querySelectorAll('input[type="password"]')].some(visible);
  const business=route==='/agentCenter/myUsage'?/用量|Token|token|消耗|使用量/:/概览|产品分析|统计|管理控制台/;
  const ready=document.readyState==='complete'&&!busy&&!failed&&text.length>30&&business.test(text);
  return failed||ready?{ready,failed,bodyLength:text.length}:false;
 },owned.route,{timeout});
 try{if(!isAccountExternalUrl(page.url(),owned))throw blocked('外链等待期间目标身份已变化，未采集页面');return await handle.jsonValue();}finally{await handle.dispose();}
}
export async function releaseAccountExternal(resources,{targets=accountBrowserTargets,connect=connectAccountExternal}={}){
 const owned=resources.accountExternal;if(!owned)return;validateAccountExternal(owned);
 if(!owned.submitted){delete resources.accountExternal;return;}
 const all=await targets(owned.endpoint);
 if(owned.targetId&&!all.some(target=>target.id===owned.targetId)){delete resources.accountExternal;return;}
 const target=ownedAccountTarget(all,owned);if(!target)throw blocked('本轮外链跳转仍未确认或标签已离开目标，保留系统浏览器');
 owned.targetId=target.id;const browser=await connect(owned.endpoint,{timeout:10000,external:{...owned}});
 try{const pages=browser.contexts().flatMap(context=>context.pages()).filter(page=>isAccountExternalUrl(page.url(),owned));if(pages.length!==1)throw blocked('本轮外链收尾页面身份不唯一');await pages[0].close();}
 finally{await browser.close();}
 if((await targets(owned.endpoint)).some(target=>target.id===owned.targetId))throw blocked('本轮外链标签关闭未确认');delete resources.accountExternal;
}
