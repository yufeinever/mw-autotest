import {connectAccountExternal,isAccountExternalUrl} from '../local-console/client-connection.mjs';
import {accountBrowserTargets,ownedAccountTarget,validateAccountExternal} from './mobilework-account-external.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const route='/p/portal/manual';

export async function prepareHelpExternal(context){
 const endpoint=process.env.MW_TEST_SYSTEM_BROWSER_CDP_ENDPOINT;
 if(!endpoint)throw blocked('系统默认浏览器未配置本机CDP，无法核对帮助文档；未点击外链');
 const domain=await context.page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('portalBaseDomainName'));
 if(typeof domain!=='string'||!domain.trim())throw blocked('客户端未配置帮助文档门户地址');
 const origin=new URL(domain.trim().replace(/\/+$/,'')+':9070').origin;
 const owned={endpoint:new URL(endpoint).href,origin,route,beforeIds:[],submitted:false,targetId:null};
 validateAccountExternal(owned);
 owned.beforeIds=(await accountBrowserTargets(owned.endpoint)).map(target=>target.id);
 context.resources.accountExternal=owned;await context.checkpointResources();return owned;
}

export async function observeHelpExternal(context,{timeout=45000}={}){
 const owned=context.resources.accountExternal,end=Date.now()+timeout;let target;
 do{target=ownedAccountTarget(await accountBrowserTargets(owned.endpoint),owned);if(target)break;await context.page.waitForTimeout(200);}while(Date.now()<end);
 if(!target)throw blocked('未发现本轮帮助文档系统浏览器页面，保留未决外链归属');
 owned.targetId=target.id;await context.checkpointResources();
 const browser=await connectAccountExternal(owned.endpoint,{timeout:10000,external:{...owned}});
 try{
  const pages=browser.contexts().flatMap(item=>item.pages()).filter(page=>isAccountExternalUrl(page.url(),owned));
  if(pages.length!==1)throw blocked('本轮帮助文档页面归属不唯一');
  const page=pages[0];
  const factsHandle=await page.waitForFunction(()=>{
   const body=document.body,visible=element=>!!(element.offsetWidth||element.offsetHeight||element.getClientRects().length);
   if(!body||document.readyState!=='complete')return false;
   const text=body.innerText.trim(),headings=[...document.querySelectorAll('h1,h2,[role="heading"]')].filter(visible).map(element=>element.innerText.trim());
   const failed=/^(404|403|500|502|503|无法访问此网站|无法访问此页面|页面加载失败|This site can.t be reached)/i.test(text)||headings.some(value=>/^(404|403|500|502|503)(\s|$)/.test(value));
   const authRequired=[...document.querySelectorAll('input[type="password"]')].some(visible)||headings.some(value=>/^(请登录|登录后继续|登录已过期)$/.test(value));
   if(!failed&&!authRequired&&(text.length<30||/^(加载中|正在加载|Loading)[.\s…]*$/i.test(text)))return false;
   const content=[...document.querySelectorAll('article,[role="article"],.markdown-body,[class*="markdown"],main')].filter(visible).map(element=>element.innerText.trim());
   const labels=[...document.querySelectorAll('a,button,[role="link"],[role="button"],h1,h2,h3,h4')].filter(visible).map(element=>element.innerText.trim());
   const matches=expression=>labels.some(text=>expression.test(text));
   return {failed,authRequired,bodyLength:text.length,contentLength:Math.max(0,...content.map(value=>value.length)),categories:{'新手指南':matches(/新手|入门|快速开始/),'专家配置':matches(/专家/),'自动化':matches(/自动化/),'连接器':matches(/连接器|MCP/i)}};
  },null,{timeout});
  const facts=await factsHandle.jsonValue();await factsHandle.dispose();
  if(facts.authRequired||facts.failed)return facts;
  const url=new URL(page.url());
  if(!isAccountExternalUrl(page.url(),owned)||url.search||url.hash!=='#'+route)throw blocked('帮助页地址含查询参数或目标已变化，未采集页面');
  const region=page.locator('main,article,[role="article"]').filter({visible:true}).first();
  const evidence=await region.count()?region:page.locator('body');
  const hasSensitiveText=await evidence.evaluate(element=>/https?:\/\/\S*\?\S*|\b(?:access_token|refresh_token|id_token|api_key|authorization)\s*[:=]/i.test(element.innerText));
  if(hasSensitiveText)throw blocked('帮助页可见内容包含查询串或授权字段，未采集页面');
  await context.captureElement(evidence,'帮助文档实际内容');
  return facts;
 }finally{await browser.close();}
}
