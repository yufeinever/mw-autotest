import {randomUUID} from 'node:crypto';
import {openAccountMenu,closeAccountMenu} from './mobilework-account-menu.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});
export const settingsPanel=(page,owned)=>page.locator('[data-mw-settings-panel="'+owned.token+'"]');
export function validateSettingsPanel(value,previous){
 const tokens=['logoutToken','relocationToken','memoryToken','mafToken','auditToken','auditDetailToken','shortcutToken'];
 if(!/^[a-f0-9-]{36}$/.test(value.token)||typeof value.originUrl!=='string'||!['account','system','memory','models','personalization','security','software','help'].includes(value.section)||Object.keys(value).some(key=>!['token','originUrl','section','auditKind',...tokens].includes(key))||tokens.some(key=>value[key]!==undefined&&!/^[a-f0-9-]{36}$/.test(value[key]))||(value.auditKind!==undefined&&!['行为审计','会话审计'].includes(value.auditKind)))throw Error('本轮设置面板归属无效');
 if(previous&&(previous.token!==value.token||previous.originUrl!==value.originUrl||previous.section!==value.section||['auditKind',...tokens].some(key=>previous[key]&&value[key]&&previous[key]!==value[key])))throw Error('不能替换本轮设置入口或确认框身份');
}
export const openAccountSettings=context=>openSettings(context,'account');
export async function openSettings(context,section='account'){
 if(await context.page.getByRole('dialog').filter({visible:true}).count())throw blocked('已有未归属弹框，未覆盖打开设置');
 const owned={token:randomUUID(),originUrl:context.page.url(),section};context.resources.settingsPanel=owned;await context.checkpointResources();
 const menu=await openAccountMenu(context);await menu.getByRole('menuitem',{name:'设置',exact:true}).click();
 const panel=context.page.getByRole('dialog',{name:'设置',exact:true}).filter({visible:true});await panel.waitFor();await panel.evaluate((element,token)=>element.setAttribute('data-mw-settings-panel',token),owned.token);
 await context.checkpointResources();
 await panel.getByRole('button',{name:{account:'账户管理',system:'系统设置',memory:'记忆',models:'模型',personalization:'个性化',security:'安全与审计',software:'软件配置',help:'帮助与反馈'}[section],exact:true}).click();
 const ready={account:['button','退出登录'],system:['slider','字体大小'],memory:['switch','自动生成记忆'],models:['switch','MAF防火墙'],personalization:['combobox','基本风格和语调'],security:['switch','Guard安全拦截'],software:['button','复制版本'],help:['button','打开']}[section];await panel.getByRole(ready[0],{name:ready[1],exact:true}).waitFor();return panel;
}
export async function openAccountLogoutConfirmation(context){
 const owned=context.resources.settingsPanel,panel=settingsPanel(context.page,owned);owned.logoutToken=randomUUID();await context.checkpointResources();
 await panel.getByRole('button',{name:'退出登录',exact:true}).click();
 const dialog=context.page.getByRole('dialog',{name:'确认登出',exact:true}).filter({visible:true});await dialog.waitFor();await dialog.evaluate((element,token)=>element.setAttribute('data-mw-settings-logout',token),owned.logoutToken);return dialog;
}
export async function releaseSettingsPanel(page,resources){
 const owned=resources.settingsPanel;if(!owned)return;validateSettingsPanel(owned);
 const panel=settingsPanel(page,owned);
 if(owned.auditDetailToken){
  const detail=page.locator('[data-mw-settings-audit-detail="'+owned.auditDetailToken+'"]');
  if(await detail.isVisible()){await detail.getByRole('button',{name:'close',exact:true}).click();await detail.waitFor({state:'hidden'});}
  else if(await page.getByRole('dialog').filter({visible:true,has:page.getByText('记录原文',{exact:true})}).count())throw blocked('审计详情尚未归属，保留现场');
  delete owned.auditDetailToken;
 }
 if(owned.auditToken){
  const audit=page.locator('[data-mw-settings-audit="'+owned.auditToken+'"]');
  if(await audit.isVisible()){await audit.getByRole('button',{name:'close',exact:true}).click();await audit.waitFor({state:'hidden'});}
  else if(await page.getByRole('dialog',{name:owned.auditKind,exact:true}).filter({visible:true}).count())throw blocked('审计面板尚未归属，保留现场');
  delete owned.auditToken;delete owned.auditKind;
 }
 for(const [key,attribute,title,close] of [['memoryToken','data-mw-settings-memory','管理记忆','关闭'],['mafToken','data-mw-settings-maf','你确定关闭MAF防火墙吗？','取消'],['shortcutToken','data-mw-settings-shortcut','快捷键设置','取消']]){
  if(!owned[key])continue;
  const dialog=page.locator('['+attribute+'="'+owned[key]+'"]');
  if(await dialog.isVisible()){await dialog.getByRole('button',{name:close,exact:true}).click();await dialog.waitFor({state:'hidden'});}
  else if(await page.getByRole('dialog',{name:title,exact:true}).filter({visible:true}).count())throw blocked('本轮'+title+'尚未归属，保留现场');
  delete owned[key];
 }
 if(owned.relocationToken){
  const dialog=page.locator('[data-mw-settings-relocation="'+owned.relocationToken+'"]');
  if(await dialog.isVisible()){const cancel=dialog.getByRole('button',{name:'取消',exact:true});if(!await cancel.isEnabled())throw blocked('本轮默认空间创建仍在执行，保留现场');await cancel.click();await dialog.waitFor({state:'hidden'});}
  else if(await page.getByRole('dialog',{name:'在新目录新建默认工作空间?',exact:true}).filter({visible:true}).count())throw blocked('默认空间确认尚未归属，保留现场');
  delete owned.relocationToken;
 }
 if(owned.logoutToken){
  const dialog=page.locator('[data-mw-settings-logout="'+owned.logoutToken+'"]');
  if(await dialog.isVisible()){if(await dialog.locator('[aria-busy="true"]').count())throw blocked('本轮登出确认仍在执行，保留现场');await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});}
  else if(await page.getByRole('dialog',{name:'确认登出',exact:true}).filter({visible:true}).count())throw blocked('登出确认框尚未完成归属，未操作未知弹框');
  delete owned.logoutToken;
 }
 if(await panel.isVisible()){await panel.getByRole('button',{name:'关闭设置',exact:true}).click();await panel.waitFor({state:'hidden'});}
 else if(await page.getByRole('dialog',{name:'设置',exact:true}).filter({visible:true}).count())throw blocked('设置面板归属未确认，保留现场');
 delete resources.settingsPanel;await closeAccountMenu(page,resources);
}
export async function readAccountSession(page){
 return page.evaluate(async()=>{
  const data=await window.__MOBILEWORK__.invoke('auth:current'),id=data.account?.id;
  const fingerprint=id?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(id))))).map(value=>value.toString(16).padStart(2,'0')).join(''):null;
  return {signedIn:!!id,accountIdSha256:fingerprint,validation:data.oidcValidation||null};
 });
}
export async function readAccountProfileMatch(page,{menuToken,settingsToken}={}){
 return page.evaluate(async({menuToken,settingsToken})=>{
  const data=await window.__MOBILEWORK__.invoke('auth:current'),account=data.account;if(!account?.id)return {signedIn:false};
  const avatar=JSON.parse(localStorage.getItem('mobilework.account.avatar.'+account.id)||'null'),custom=typeof avatar==='string'&&avatar.startsWith('data:image/'),glyph=Array.from(account.displayName.trim()||account.username.trim())[0]||'?';
  const footer=document.querySelector('[data-testid="sidebar-account-footer"] button[data-sidebar="menu-button"][aria-haspopup="menu"]');
  const menu=menuToken?document.querySelector('[data-mw-account-menu="'+menuToken+'"]'):null,header=menu?.querySelector('div.relative.z-20');
  const panel=settingsToken?document.querySelector('[data-mw-settings-panel="'+settingsToken+'"]'):null,card=panel?.querySelector('main button[aria-label="修改头像"]')?.parentElement;
  const avatarMatches=root=>{
   if(!root)return false;const image=root.querySelector('img');
   if(custom)return !!image&&image.getAttribute('src')===avatar&&image.complete&&image.naturalWidth>0;
   const target=[...root.querySelectorAll('span[style]')].find(element=>/^(32|50)px$/.test(element.style.width));return !image&&target?.textContent===glyph;
  };
  const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(account.id))))).map(value=>value.toString(16).padStart(2,'0')).join('');
  return {signedIn:true,accountIdSha256:id,avatarKind:custom?'custom-image':'name-glyph',footerName:footer?.querySelector('span.truncate')?.textContent===account.displayName,footerAvatar:avatarMatches(footer),...(menuToken?{menuName:header?.querySelector('span.truncate')?.textContent===account.displayName,menuAvatar:avatarMatches(header)}:{}),...(settingsToken?{settingsName:card?.querySelector('span.truncate')?.textContent===account.displayName,settingsAvatar:avatarMatches(card),accountSelected:[...panel.querySelectorAll('nav button')].some(button=>button.textContent==='账户管理'&&button.className.includes('mw-settings-nav-active'))}:{})};
 },{menuToken,settingsToken});
}
