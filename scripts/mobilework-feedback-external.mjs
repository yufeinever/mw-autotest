import {connectAccountExternal,isAccountExternalUrl} from '../local-console/client-connection.mjs';
import {accountBrowserTargets,ownedAccountTarget,validateAccountExternal} from './mobilework-account-external.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const route='/pjcustomer/pjcust/order/billoflading.html';

export async function prepareFeedbackExternal(context){
 const endpoint=process.env.MW_TEST_SYSTEM_BROWSER_CDP_ENDPOINT,expected=process.env.MW_TEST_FEEDBACK_ORIGIN;
 if(!endpoint)throw blocked('系统默认浏览器未配置本机CDP，未点击意见反馈');
 if(!expected||!URL.canParse(expected))throw blocked('未配置可确认的反馈页面origin（MW_TEST_FEEDBACK_ORIGIN），未点击意见反馈');
 const origin=new URL(expected);
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw blocked('反馈页面origin必须是无路径和凭证的HTTP(S)地址');
 const owned={endpoint:new URL(endpoint).href,origin:origin.origin,route,beforeIds:[],submitted:false,targetId:null};
 validateAccountExternal(owned);
 owned.beforeIds=(await accountBrowserTargets(owned.endpoint)).map(target=>target.id);
 context.resources.accountExternal=owned;await context.checkpointResources();return owned;
}

export async function connectFeedbackExternal(context,{timeout=45000}={}){
 const owned=context.resources.accountExternal,end=Date.now()+timeout;let target;
 do{target=ownedAccountTarget(await accountBrowserTargets(owned.endpoint),owned);if(target)break;await context.page.waitForTimeout(200);}while(Date.now()<end);
 if(!target)throw blocked('未发现本轮反馈目标页面；保留未决外链归属');
 owned.targetId=target.id;await context.checkpointResources();
 const browser=await connectAccountExternal(owned.endpoint,{timeout:10000,external:{...owned}});
 const pages=browser.contexts().flatMap(item=>item.pages()).filter(page=>isAccountExternalUrl(page.url(),owned));
 if(pages.length!==1){await browser.close();throw blocked('本轮反馈页面归属不唯一');}
 return {browser,page:pages[0]};
}
