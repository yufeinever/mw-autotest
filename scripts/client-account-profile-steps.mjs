import fs from 'node:fs/promises';
import path from 'node:path';
import {openAccountMenu,closeAccountMenu} from './mobilework-account-menu.mjs';
import {openAccountSettings,openAccountLogoutConfirmation,releaseSettingsPanel,readAccountProfileMatch,readAccountSession} from './mobilework-account-settings.mjs';
import {prepareAccountLogout,waitAccountSignedOut,releaseAccountLogout} from './mobilework-account-logout.mjs';
import {prepareAccountExternal,observeAccountExternal,releaseAccountExternal} from './mobilework-account-external.mjs';
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
export async function runAccountProfileSteps(context){
 return context.control.withUI(context.page,'VERIFYING',async()=>{
  if(context.number===172){
   const menu=await openAccountMenu(context);await menu.waitFor();const facts=await readAccountProfileMatch(context.page,{menuToken:context.resources.accountMenuToken});
   for(const key of ['signedIn','footerName','footerAvatar','menuName','menuAvatar'])context.assert('当前账户身份与头像核对：'+key,facts[key]);
   await save(context,'头像菜单真实身份一致性',facts);await context.capture('头像菜单当前用户名与头像');await closeAccountMenu(context.page,context.resources);await context.checkpointResources();context.remaining.delete('头像菜单与实际登录身份及头像一致');return;
  }
  if(context.number===173){
   const owned=await prepareAccountLogout(context),menu=await openAccountMenu(context),row=menu.getByRole('menuitem',{name:'登出',exact:true});await row.waitFor();
   const color=await row.evaluate(element=>({actual:getComputedStyle(element).color,marked:element.className.includes('--mw-error')}));context.assert('真实菜单登出入口具有危险操作标识',color.marked,{color:color.actual});await context.capture('专用测试账户登出前');
   owned.stage='submitted';await context.checkpointResources();await row.click();
   const signedOut=await waitAccountSignedOut(context.page,{checkpoint:context.checkpointResources});owned.stage='signed-out';await context.checkpointResources();
   context.assert('登出后正常认证接口为空且账户入口消失',!signedOut.signedIn&&await context.page.locator('[data-testid="sidebar-account-footer"]').isVisible()===false);
   await save(context,'本轮真实登出结果',{signedOut:true,accountIdSha256:owned.accountIdSha256,confirmation:'当前头像菜单直接登出，无二次确认'});await context.capture('登出后真实登录界面');context.remaining.delete('专用账号真实菜单登出及登录态清除');
   await releaseAccountLogout(context.page,context.resources,{checkpoint:context.checkpointResources});await closeAccountMenu(context.page,context.resources);await context.checkpointResources();context.assert('恢复原专用账号且页面可继续执行',!(context.resources.accountLogout));await context.capture('原专用测试账户已恢复');context.remaining.delete('通过正常短信登录恢复原账号并确认交接');return;
  }
  const before=await readAccountSession(context.page),panel=await openAccountSettings(context);
  if(context.number===174){
   const dialog=await openAccountLogoutConfirmation(context);await context.capture('设置账户真实登出二次确认');await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});delete context.resources.settingsPanel.logoutToken;await context.checkpointResources();
   const after=await readAccountSession(context.page);context.assert('取消登出后同账号在线有效且仍在原页面',before.signedIn&&after.signedIn&&before.accountIdSha256===after.accountIdSha256&&after.validation==='valid'&&context.page.url()===context.resources.settingsPanel.originUrl);
   context.assert('取消仅关闭确认框且保留账户设置',await panel.isVisible()&&await panel.getByRole('button',{name:'退出登录',exact:true}).isVisible());await save(context,'登出取消身份及入口范围',{sameAccount:before.accountIdSha256===after.accountIdSha256,validation:after.validation,originalMenuHasConfirmation:false,optimizedEntry:'设置/账户管理/退出登录'});await context.capture('取消登出后保持账户设置与登录');context.remaining.delete('真实设置登出确认取消且同账号保持登录');
  }else if(context.number===175){
   const facts=await readAccountProfileMatch(context.page,{settingsToken:context.resources.settingsPanel.token});
   for(const key of ['signedIn','settingsName','settingsAvatar','accountSelected'])context.assert('账户管理真实面板核对：'+key,facts[key]);
   for(const name of ['退出登录','我的用量'])context.assert('账户管理普通操作入口可用：'+name,await panel.getByRole('button',{name,exact:true}).isEnabled());await save(context,'设置账户面板真实身份与入口',facts);await context.capture('账户管理真实资料与操作入口');context.remaining.delete('设置账户管理选中及当前资料与操作入口');
  }else if(context.number===176){
   const owned=await prepareAccountExternal(context,'/agentCenter/myUsage');await context.capture('设置账户我的用量真实入口');owned.submitted=true;await context.checkpointResources();await panel.getByRole('button',{name:'我的用量',exact:true}).click();
   const facts=await observeAccountExternal(context);await save(context,'设置账户用量系统浏览器结果',facts);await releaseAccountExternal(context.resources);await context.checkpointResources();context.remaining.delete('设置我的用量系统浏览器跳转与实际业务页');
  }else throw Error('账户资料步骤只支持172～176');
  await releaseSettingsPanel(context.page,context.resources);await context.checkpointResources();
 });
}
