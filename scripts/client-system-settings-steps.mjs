import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openAccountSettings,openSettings,openAccountLogoutConfirmation,releaseSettingsPanel,readAccountSession} from './mobilework-account-settings.mjs';
import {prepareAccountLogout,waitAccountSignedOut,releaseAccountLogout,readLoggedOutFiles} from './mobilework-account-logout.mjs';
import {prepareSystemSettings,chooseTheme,chooseFont,readTheme,readTypography,systemTheme,releaseSystemSettings} from './mobilework-system-settings.mjs';
import {restartOwnedClient} from './mobilework-client-restart.mjs';
import {prepareSystemStorage,settleSystemStorage} from './mobilework-default-storage.mjs';
import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {chooseWorkspace} from './mobilework-workspaces.mjs';
const review=message=>Object.assign(Error(message),{review:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
export async function runSystemSettingsSteps(context){
 const {number,resources,remaining,control}=context,finish=step=>remaining.delete(step);
 if(number===177)return control.withUI(context.page,'INTERACTING',async()=>{
  const owned=await prepareAccountLogout(context);await openAccountSettings(context);const dialog=await openAccountLogoutConfirmation(context);await context.capture('设置退出登录真实确认');
  owned.stage='submitted';await context.checkpointResources();await dialog.getByRole('button',{name:'确认登出',exact:true}).click();await waitAccountSignedOut(context.page,{checkpoint:context.checkpointResources});owned.stage='signed-out';await context.checkpointResources();
  const files=await readLoggedOutFiles(context.page);await save(context,'设置登出与本地身份清理',files);await context.capture('设置登出后的真实登录界面');for(const [name,cleared] of Object.entries(files))context.assert('登出本地身份已清除：'+name,cleared);finish('真实设置确认登出及登录态和本地身份清除');
  await releaseSettingsPanel(context.page,resources);await context.checkpointResources();await releaseAccountLogout(context.page,resources,{checkpoint:context.checkpointResources});await context.checkpointResources();context.assert('原专用测试账号与输入页已正常恢复',!resources.accountLogout);finish('正常认证恢复原专用账号及页面交接');
 });
 if(number===178){
  await context.send('请直接回复一段中文用于本次字号检查：青禾项目正在进行界面可读性验证。不要使用工具，不要生成文件。');
  return control.withUI(context.page,'VERIFYING',async()=>{
   await prepareSystemSettings(context,'font');let panel=await openSettings(context,'system');await chooseFont(context.page,panel,1);await releaseSettingsPanel(context.page,resources);await context.checkpointResources();
   const before=await readTypography(context.page,context.getSessionId());panel=await openSettings(context,'system');const beforeSettings=await readTypography(context.page,context.getSessionId());before.items.settings=beforeSettings.items.settings;
   await chooseFont(context.page,panel,2);const withSettings=await readTypography(context.page,context.getSessionId());await context.capture('大字号设置实际效果');await releaseSettingsPanel(context.page,resources);await context.checkpointResources();const after=await readTypography(context.page,context.getSessionId());after.items.settings=withSettings.items.settings;
   await save(context,'四区域字号与布局实际采样',{before,after});await context.capture('大字号任务空间与本Session正文');context.assert('字号滑块实际设置大18且全局根字号变化',Math.abs(after.root-18)<.2&&after.root>before.root);
   const missing=Object.keys(after.items).filter(key=>!before.items[key]||!after.items[key]);if(missing.length)throw review('缺少实际字体观察区域：'+missing.join('、')+'；保留采样，不将全局字号配置当全部区域生效');
   for(const [name,item] of Object.entries(after.items)){context.assert('区域正文随字号比例变化：'+name,Math.abs(item.size/before.items[name].size-after.root/before.root)<.03,{before:before.items[name].size,after:item.size});context.assert('区域正文可见且无纵向文字溢出：'+name,item.visible&&!item.textExceedsHeight);}
   finish('真实滑块大18及任务空间对话设置四区域效果');panel=await openSettings(context,'system');await chooseFont(context.page,panel,1);await context.capture('恢复默认14档位');await releaseSettingsPanel(context.page,resources);await context.checkpointResources();finish('恢复默认14并按原基线收尾');await releaseSystemSettings(context.page,resources,{checkpoint:context.checkpointResources});await context.checkpointResources();
  });
 }
 if(number===179)return control.withUI(context.page,'VERIFYING',async()=>{
  const identity=await readAccountSession(context.page);await prepareSystemSettings(context,'theme');const panel=await openSettings(context,'system');await chooseTheme(context.page,panel,'dark');const before=await readTheme(context.page);await context.capture('真实深色设置与主界面');await releaseSettingsPanel(context.page,resources);await context.checkpointResources();context.assert('深色外观与真实配置生效',before.actual==='dark'&&before.scheme==='dark');finish('真实深色主题配置及主界面外观');
  const proof=await restartOwnedClient(context),after=await readTheme(context.page),identityAfter=await readAccountSession(context.page);await save(context,'正常重启与主题持久化',{proof,before,after,sameAccount:identity.accountIdSha256===identityAfter.accountIdSha256});await context.capture('真实新进程启动后深色保持');context.assert('正常退出后新客户端进程保持深色与原账号',proof.newMainProcess&&after.actual==='dark'&&after.stored==='dark'&&identityAfter.validation==='valid'&&identity.accountIdSha256===identityAfter.accountIdSha256);finish('正常退出新进程启动及主题持久化');await releaseSystemSettings(context.page,resources,{checkpoint:context.checkpointResources});await context.checkpointResources();
 });
 if(number===180)return control.withUI(context.page,'VERIFYING',async()=>{
  await prepareSystemSettings(context,'system-theme');const panel=await openSettings(context,'system');await chooseTheme(context.page,panel,'system');const samples=[];
  for(const mode of ['dark','light']){
   const registry=await systemTheme('Set',mode==='light'?1:0);await context.page.waitForFunction(mode=>matchMedia('(prefers-color-scheme: dark)').matches===(mode==='dark')&&document.documentElement.dataset.theme===mode,mode,{timeout:20000});const actual=await readTheme(context.page);samples.push({mode,registry,actual});await save(context,'Windows真实主题联动',samples);await context.capture('Windows切换'+(mode==='dark'?'深色':'浅色')+'后自动跟随');context.assert('真实系统'+mode+'联动且跟随模式保留',actual.stored==='system'&&actual.actual===mode&&actual.scheme===mode&&registry.appsUseLightTheme===(mode==='light'?1:0));
  }
  finish('真实Windows明暗切换与客户端自动联动');await releaseSystemSettings(context.page,resources,{checkpoint:context.checkpointResources});await context.checkpointResources();finish('系统与客户端主题原值精确恢复');
 });
 if(number===181){
  const created=await control.withUI(context.page,'INTERACTING',async()=>{
   const owned=await prepareSystemStorage(context),panel=await openSettings(context,'system');resources.settingsPanel.relocationToken=randomUUID();await context.checkpointResources();
   await selectNativeFolder(context.page,{folder:owned.targetPath,dir:context.dir,control,log:context.log,open:()=>panel.getByRole('button',{name:'更新路径',exact:true}).click()});
   const dialog=context.page.getByRole('dialog',{name:'在新目录新建默认工作空间?',exact:true}).filter({visible:true});await dialog.waitFor();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-relocation',token),resources.settingsPanel.relocationToken);await context.capture('新目录默认空间真实二次确认');
   owned.stage='submitted';await context.checkpointResources();await dialog.getByRole('button',{name:'新建默认空间',exact:true}).click();const created=await settleSystemStorage(context.page,resources);await dialog.waitFor({state:'hidden'});delete resources.settingsPanel.relocationToken;await context.checkpointResources();
   const displayed=await panel.getByText(new RegExp(owned.targetPath.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).count();context.assert('设置展示本轮实际新存储路径',displayed===1);await context.capture('更新后的真实默认空间与路径');await releaseSettingsPanel(context.page,resources);await context.checkpointResources();await chooseWorkspace(context.page,created.name);await context.checkpointPage();finish('原生目录选择及新默认空间实际创建和展示');return created;
  });
  const name='默认空间产物核验.txt',marker='存储路径-'+randomUUID();await context.send('请在当前任务目录新建UTF-8文件“'+name+'”，内容为“'+marker+'”。只创建该文件，不改其他目录。完成后简要告知。');
  const body=await fs.readFile(path.join(control.directory,name),'utf8'),relative=path.relative(created.path,control.directory);await fs.writeFile(path.join(context.dir,name),body);context.outputs.push({name,path:name});await save(context,'默认空间真实任务归属',{workspaceId:created.id,workspacePath:created.path,sessionId:context.getSessionId(),directory:control.directory,relative});context.assert('本Session任务目录和实际文件属于新默认空间',relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&context.page.url().includes('/workspace/'+created.id+'/session/'+context.getSessionId())&&body.trim()===marker);finish('新默认空间真实Session与任务产物落盘');
  // Shared engine indexes/automation logs have no per-task storage contract in
  // this source case. Keep that unresolved expectation visible in the report.
  throw review('新默认空间及真实任务产物已验证；原表索引和自动化日志的具体存储对象及触发条件未定义，不能用任务文件冒充其路径验证');
 }
 throw Error('系统设置步骤只支持177～181');
}
