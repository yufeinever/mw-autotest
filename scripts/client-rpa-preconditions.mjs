import fs from 'node:fs/promises';
import path from 'node:path';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

// These entries preserve the original business goal. Employee lifecycle actions
// require a disposable self-created employee and an identified executor first.
export async function runRpaPreconditions(context){
 const {page,dir,resources,remaining,capture,assert,checkpointPage,checkpointResources}=context;
 const original=await snapshotDraft(page);
 if(original.text||original.skills.length||original.selection.length)throw blocked('RPA入口预检前输入区未清空，保留当前输入');
 resources.moduleNavigation={originUrl:original.url,targetHash:'#/experts/staff'};await checkpointResources();
 try{
  await page.getByRole('button',{name:'专家工作区: 专家 / 技能 / 工具',exact:true}).click();
  await page.getByRole('button',{name:'RPA流程助手',exact:true}).click();
  await page.getByRole('tab',{name:'我的数智员工',exact:true}).waitFor();
  await page.getByRole('tab',{name:'我的数智员工',exact:true}).click();
  const type=page.getByRole('combobox').filter({hasText:/单智能体员工|RPA数智员工/});
  await type.click();await page.getByRole('option',{name:'RPA数智员工',exact:true}).click();
  const scope=page.locator('.mw-staff-content');
  await scope.getByText(/^加载中\.\.\.$/).first().waitFor({state:'hidden',timeout:45000});
  const text=await scope.innerText(),cards=await scope.locator('.mw-staff-card-grid > div').allTextContents();
  await fs.writeFile(path.join(dir,'RPA前置条件观察.json'),JSON.stringify({at:new Date().toISOString(),url:page.url(),type:await type.innerText(),text,cards,missing:['可丢弃且明确归属本轮的自建RPA员工','员工任务执行记录及可观测详情','已登录且可用的本机磐匠执行器'],implemented:'真实入口、RPA筛选和列表观察；启动与生命周期步骤待测试资源及归属接入'},null,2));
  await capture('RPA员工列表实际状态');
  assert('已进入我的员工并选择RPA类型',(await type.innerText()).includes('RPA数智员工'));
  remaining.delete('真实RPA员工入口与列表');
  throw blocked('RPA列表已读取；尚未配置可丢弃自建员工及已登录执行器的本轮资源归属，不能启动、冻结或离职现有员工。原表后续业务步骤保留待实现。');
 }catch(error){
  await capture('RPA前置检查现场');throw error;
 }finally{
  await restoreModuleNavigation(page,resources);await checkpointPage();
 }
}
