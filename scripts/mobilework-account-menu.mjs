import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';

const blocked=message=>Object.assign(Error(message),{blocked:true});
export function balanceText(value){return new Intl.NumberFormat('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:2}).format(Math.round(value/10000*100)/100)+'万Token';}
export async function readAccountBalance(page){
 const result=await page.evaluate(()=>window.__MOBILEWORK__.invoke('account:fetchRemainTokenCount'));
 if(!result.ok||!Number.isFinite(result.balance))throw blocked('当前账户未取得有效用量余额');return result.balance;
}
export async function accountIdentity(page){
 const label=await page.locator('[data-testid="sidebar-account-footer"] button[data-sidebar="menu-button"][aria-haspopup="menu"]').innerText();return createHash('sha256').update(label.trim()).digest('hex');
}
export async function openAccountMenu(context){
 const {page,resources}=context;
 if(await page.getByRole('menu').filter({visible:true}).count())throw blocked('当前存在非本轮菜单，未直接覆盖');
 resources.accountMenuToken=randomUUID();await context.checkpointResources();await page.locator('[data-testid="sidebar-account-footer"] button[data-sidebar="menu-button"][aria-haspopup="menu"]').click();
 const menu=page.getByRole('menu').filter({visible:true});await menu.waitFor();await menu.evaluate((node,token)=>node.setAttribute('data-mw-account-menu',token),resources.accountMenuToken);return menu;
}
export async function closeAccountMenu(page,resources){
 if(!resources.accountMenuToken)return;
 const menu=page.locator('[data-mw-account-menu="'+resources.accountMenuToken+'"]');
 if(await menu.isVisible()){await menu.press('Escape');await menu.waitFor({state:'hidden'});}
 else if(await page.getByRole('menu').filter({visible:true}).count())throw blocked('账户菜单未完成本轮归属，保留现场');
 delete resources.accountMenuToken;
}
export async function readAccountSnapshot(context,name){
 return context.control.withUI(context.page,'VERIFYING',async()=>{
  const menu=await openAccountMenu(context),row=menu.getByRole('menuitem').filter({hasText:'用量余额'}),amount=row.getByText(/^-?[\d,.]+万Token$/);
  await amount.waitFor({state:'visible',timeout:30000});
  const balance=await readAccountBalance(context.page),display=await amount.innerText();
  context.assert(name+'显示真实当前余额格式',display===balanceText(balance),{display,expected:balanceText(balance)});
  await context.capture(name+'账户菜单用量余额');await closeAccountMenu(context.page,context.resources);await context.checkpointResources();
  return {balance,display,observedAt:new Date().toISOString(),identity:await accountIdentity(context.page)};
 });
}
export async function accountUsageFacts(identity,now=Date.now()){
 const file=process.env.MW_TEST_ACCOUNT_USAGE_FACTS;if(!file)return null;
 const data=JSON.parse(await fs.readFile(file,'utf8'));
 if(data.source!=='external-account-billing'||data.accountLabelSha256!==identity||!Number.isFinite(data.balance)||!Number.isFinite(Date.parse(data.observedAt))||Math.abs(now-Date.parse(data.observedAt))>600000)throw Error('独立账号账单来源、身份或十分钟内观测时效不匹配');return data;
}
export function billingDelta(before,after,entry){
 return entry.balanceBefore===before&&entry.balanceAfter===after&&entry.chargedTokens>0&&before-after===entry.chargedTokens&&Array.isArray(entry.requestIds)&&entry.requestIds.length>0;
}
