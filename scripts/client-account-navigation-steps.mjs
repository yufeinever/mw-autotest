import fs from 'node:fs/promises';
import path from 'node:path';
import {openAccountMenu,closeAccountMenu,readAccountBalance,balanceText,accountIdentity,accountUsageFacts} from './mobilework-account-menu.mjs';
import {readAccountPrincipal,requireAccountRole,startAccountObservation,readAccountObservation,releaseAccountObservation,refreshObservationFacts,manualRefreshChange} from './mobilework-account-observation.mjs';
import {prepareAccountExternal,observeAccountExternal,releaseAccountExternal} from './mobilework-account-external.mjs';
import {applyAccountNetworkFault,releaseAccountNetwork} from './mobilework-account-network.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true}),review=message=>Object.assign(Error(message),{review:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
async function loadedBalance(menu){const row=menu.getByRole('menuitem').filter({hasText:'用量余额'});await row.getByText(/^-?[\d,.]+万Token$/).waitFor();return row;}
async function manualRefresh(context,networkFailure){
 const menu=await openAccountMenu(context),row=await loadedBalance(menu),before=await row.getByText(/^-?[\d,.]+万Token$/).innerText();
 const baseline=networkFailure?null:{identity:await accountIdentity(context.page),before:await readAccountBalance(context.page),observedAt:Date.now()};
 if(networkFailure)await applyAccountNetworkFault(context);
 const owner=await startAccountObservation(context),clickedAt=Date.now();await row.getByRole('button').click();
 const end=Date.now()+30000;let samples,facts;
 do{samples=await readAccountObservation(context.page,owner);facts=refreshObservationFacts(samples);if(facts.settled)break;await context.page.waitForTimeout(100);await context.checkpointResources();}while(Date.now()<end);
 await save(context,'手动刷新实际状态变化',{before,samples,networkFailure});await context.capture(networkFailure?'账户刷新故障后的真实提示':'账户手动刷新实际结果');
 if(!facts.started)throw review('未完整观察到本轮刷新加载过程，不能将旧余额当本次请求结果');
 context.assert('余额刷新结束后菜单保持可用且有重试按钮',facts.settled&&await row.getByRole('button').count()===1);
 if(networkFailure){
  if(!facts.failed)throw review('临时客户端门户规则已建立，但未观察到实际余额刷新失败；可能存在代理或不同网络路径，未将未触发当通过');
  context.assert('真实网络故障给出明确失败提示且保留原余额',facts.last.display===before&&facts.failed);
  await releaseAccountNetwork(context.resources);await context.checkpointResources();
  await releaseAccountObservation(context.page,context.resources);await context.checkpointResources();
  // Retry through the product after removing the fault, rather than fabricating success.
  const recoveryOwner=await startAccountObservation(context);await row.getByRole('button').click();
  const recoveryEnd=Date.now()+30000;let recovery;
  do{recovery=refreshObservationFacts(await readAccountObservation(context.page,recoveryOwner));if(recovery.settled)break;await context.page.waitForTimeout(100);await context.checkpointResources();}while(Date.now()<recoveryEnd);
  const raw=await readAccountBalance(context.page);context.assert('恢复网络后真实重试成功展示当前余额',recovery.settled&&!recovery.failed&&recovery.last.display===balanceText(raw));await context.capture('网络恢复后真实重试');await save(context,'网络恢复重试',{recovery,raw});
  context.remaining.delete('受控客户端网络故障及真实提示与重试');
 }else{
  context.assert('本轮正常手动刷新无失败提示',!facts.failed);const raw=await readAccountBalance(context.page);context.assert('手动刷新显示当前接口格式化余额',facts.last.display===balanceText(raw));
  context.remaining.delete('真实手动刷新加载终态及当前余额');
  const fact=await accountUsageFacts(baseline.identity),changed=manualRefreshChange(fact,{...baseline,after:raw,clickedAt});
  await save(context,'手动刷新独立变更核对',{...baseline,after:raw,clickedAt,changed,refresh:fact?.refresh?{balanceBefore:fact.refresh.balanceBefore,balanceAfter:fact.refresh.balanceAfter,changedAt:fact.refresh.changedAt}:null});
  if(!changed)throw review('真实手动刷新已完成，但缺菜单加载后、点击前的独立云端余额变更事实；不追加消耗任务制造变化');
  if(before===facts.last.display)throw review('独立云端变更已核对，但万Token精度未呈现变化');
  context.remaining.delete('余额变更后刷新与独立云端事实一致');
 }
}
async function externalNavigation(context,admin){
 if(admin)requireAccountRole(await readAccountPrincipal(context.page),'admin');
 const owned=await prepareAccountExternal(context,admin?'/operationsMgr/productAnalysis':'/agentCenter/myUsage'),menu=await openAccountMenu(context);
 const row=admin?menu.getByRole('menuitem',{name:'管理控制台',exact:true}):await loadedBalance(menu);await row.waitFor();await context.capture(admin?'管理员管理控制台真实入口':'用量余额真实跳转入口');
 owned.submitted=true;await context.checkpointResources();await row.click();await menu.waitFor({state:'hidden'});await closeAccountMenu(context.page,context.resources);await context.checkpointResources();
 const result=await observeAccountExternal(context);await save(context,'系统浏览器外链真实结果',result);await releaseAccountExternal(context.resources);await context.checkpointResources();
 context.remaining.delete(admin?'管理员真实入口与系统浏览器概览':'用量余额系统浏览器跳转及实际页面');
}
export async function runAccountNavigationSteps(context){
 return context.control.withUI(context.page,'VERIFYING',async()=>{
  if(context.number===167)return externalNavigation(context,false);
  if(context.number===168||context.number===169){await manualRefresh(context,context.number===169);await releaseAccountObservation(context.page,context.resources);await closeAccountMenu(context.page,context.resources);await context.checkpointResources();return;}
  if(context.number===170)return externalNavigation(context,true);
  if(context.number!==171)throw Error('账户导航步骤只支持167～171');
  const principal=await readAccountPrincipal(context.page);requireAccountRole(principal,'user');const menu=await openAccountMenu(context);
  context.assert('普通用户菜单不展示管理控制台',await menu.getByRole('menuitem',{name:'管理控制台',exact:true}).count()===0);
  for(const name of ['用量余额','设置','帮助与反馈'])context.assert('普通用户保留正常入口：'+name,await menu.getByRole('menuitem').filter({hasText:name}).count()===1);
  await save(context,'普通用户真实角色及菜单范围',{role:principal.role,validation:principal.validation,adminEntry:false});await context.capture('普通用户账户菜单无管理入口');await closeAccountMenu(context.page,context.resources);await context.checkpointResources();context.remaining.delete('真实普通用户身份与管理入口不可见');
 });
}
