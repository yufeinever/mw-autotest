import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openSettings,releaseSettingsPanel} from './mobilework-account-settings.mjs';
import {prepareWindowClose,chooseClosePreference,windowState,releaseWindowClose} from './mobilework-window-close.mjs';
import {prepareInvalidDirectory,prepareStorageProbe,releaseInvalidDirectory} from './mobilework-storage-probe.mjs';
import {probeInvalidNativeFolder,completeNativeFolder} from './mobilework-native-folder.mjs';
import {restoreSystemStorageMetadata,releaseSystemStorage} from './mobilework-default-storage.mjs';
import {workspaces,releaseWorkspaceResources} from './mobilework-workspaces.mjs';
import {readMemory,memoryHash,prepareAccountMemory,chooseMemoryEnabled,registerMemorySource,observeAutoMemory} from './mobilework-account-memory.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
const review=message=>Object.assign(Error(message),{review:true}),blocked=message=>Object.assign(Error(message),{blocked:true});
export async function runSystemMemorySteps(context){
 const {number,resources,control,remaining}=context,finish=step=>remaining.delete(step),save=(name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
 async function settings(section,action){return control.withUI(context.page,'INTERACTING',async()=>{const panel=await openSettings(context,section);try{return await action(panel);}finally{await releaseSettingsPanel(context.page,resources);await context.checkpointResources();}});}
 if(number===182)return control.withUI(context.page,'VERIFYING',async()=>{
  const states=await engineRequest(await readEngineConnection(context.page),'/session/status');if(Object.values(states).some(item=>item.type!=='idle'))throw blocked('其他会话正在执行，未试验默认路径');
  let absentDrive;for(const letter of 'ZYXWVUTSRQP'){try{await fs.stat(letter+':\\');}catch(error){if(error.code!=='ENOENT')throw error;absentDrive=letter;break;}}if(!absentDrive)throw blocked('未找到真实不存在的盘符，未用其他路径冒充');
  const denied=await prepareInvalidDirectory(context),trials=[{name:'不存在盘符',folder:absentDrive+':\\MW-AUTOTEST-'+randomUUID()},{name:'不可写隔离目录',folder:denied.path},{name:'Windows非法字符',folder:path.join(context.dir,'MW-AUTOTEST-非法<路径>')}],outcomes=[],unconfirmed=[];
  for(const trial of trials){
   const owned=await prepareStorageProbe(context,trial.folder),panel=await openSettings(context,'system'),token=randomUUID(),evidenceDir=path.join(context.dir,trial.name);await fs.mkdir(evidenceDir);
   await context.page.locator('[data-sonner-toast]').evaluateAll((nodes,token)=>nodes.forEach(node=>node.setAttribute('data-mw-before-probe',token)),token);
   resources.settingsPanel.relocationToken=randomUUID();await context.checkpointResources();
   const native=await probeInvalidNativeFolder(context.page,{folder:trial.folder,dir:evidenceDir,control,open:()=>panel.getByRole('button',{name:'更新路径',exact:true}).click()});let rejected=native.rejected===true,layer=rejected?'Windows原生选择器':'未决',errors=native.errors?.map(item=>item.text)||[];
   if(native.dialogClosed){
    const dialog=context.page.getByRole('dialog',{name:'在新目录新建默认工作空间?',exact:true});await dialog.waitFor();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-relocation',token),resources.settingsPanel.relocationToken);await completeNativeFolder(control,native.ownership);owned.stage='submitted';await context.checkpointResources();
    const [response]=await Promise.all([context.page.waitForResponse(response=>{const request=response.request();if(request.method()!=='POST'||new URL(response.url()).pathname!=='/workspaces/local')return false;try{return JSON.parse(request.postData()).folderPath===trial.folder;}catch{return false;}},{timeout:20000}),dialog.getByRole('button',{name:'新建默认空间',exact:true}).click()]);
    await save(trial.name+'空间创建响应',{status:response.status()});
    if(!response.ok()){owned.stage='rejected';await context.checkpointResources();}
    const failure=context.page.locator('[data-sonner-toast][data-type="error"]:not([data-mw-before-probe="'+token+'"])');
    try{await failure.first().waitFor({timeout:5000});}catch(error){if(error.name!=='TimeoutError')throw error;}
    errors=await failure.allTextContents();rejected=!response.ok()&&errors.some(text=>/失败|拒绝|权限|无效|failed|denied|invalid/i.test(text));layer='MobileWork空间创建';
    if(response.ok())throw review('目录创建接口已成功，须确认默认空间切换及恢复');
   }
   const current=await workspaces(context.page),scratch=await context.page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).scratchFolderPath??null),unchanged=JSON.stringify(current.items.map(item=>item.id).sort())===JSON.stringify([...resources.workspaceResources.beforeIds].sort())&&current.items.filter(item=>item.isDefault).length===1&&current.items.some(item=>item.id===owned.originalDefault.id&&item.isDefault&&item.path===owned.originalDefault.path&&item.name===owned.originalDefault.name)&&scratch===owned.oldScratch;
   outcomes.push({trial:trial.name,path:trial.folder,rejected,layer,errors,unchanged});await save('非法路径三分支实测',outcomes);await context.capture(trial.name+(rejected?'明确拒绝':'拒绝提示未确认')+'及原设置');
   if(rejected)context.assert(trial.name+'明确拒绝且默认空间/偏好未保存无效值',unchanged);else unconfirmed.push(trial.name);
   await releaseSettingsPanel(context.page,resources);await context.checkpointResources();await restoreSystemStorageMetadata(context.page,resources,{checkpoint:context.checkpointResources});await releaseWorkspaceResources(context.page,resources.workspaceResources,{...context.config,checkpointPage:context.checkpointPage});await releaseSystemStorage(context.page,resources,{checkpointPage:context.checkpointPage});delete resources.workspaceResources;await context.checkpointPage();if(rejected)finish(trial.name+'拒绝及无效值未保存');
  }
  await releaseInvalidDirectory(resources);await context.checkpointResources();finish('隔离目录ACL及默认空间原状态恢复');
  if(unconfirmed.length)throw review(unconfirmed.join('、')+'未取得明确错误提示，选择框停留不等于已验证拒绝');
 });
 if(number===183)return control.withUI(context.page,'VERIFYING',async()=>{
  const owned=await prepareWindowClose(context),options=await settings('system',panel=>chooseClosePreference(context.page,panel,'minimize'));await save('关闭偏好实际候选',{options});finish('真实关闭偏好全部选项及保存');
  const close=context.page.getByRole('button',{name:'关闭',exact:true}).filter({visible:true});if(await close.count()!==1)throw blocked('未找到唯一主窗口关闭按钮，未猜测点击');await context.capture('主窗口关闭前托盘偏好');await close.click();
  const end=Date.now()+10000;let actual;do{actual=await windowState(owned.pid,{hwnd:owned.hwnd});if(actual.windows.length===1&&!actual.windows[0].visible)break;await context.page.waitForTimeout(200);}while(Date.now()<end);
  await save('主窗口关闭后的真实Win32状态',actual);context.assert('关闭后原进程同一主窗口隐藏而未销毁',actual.windows.length===1&&!actual.windows[0].visible);finish('关闭按钮隐藏窗口且原进程后台驻留');await releaseWindowClose(context.page,resources);await context.checkpointResources();await context.capture('原主窗口显示与关闭偏好恢复');finish('恢复本轮窗口与原关闭偏好');
 });
 if(number===184)return settings('memory',async panel=>{
  const actual=await readMemory(context.page),toggle=panel.getByRole('switch',{name:'自动生成记忆',exact:true}),visibleEnabled=await toggle.getAttribute('aria-checked')==='true';context.assert('记忆开关显示与当前账号实际配置一致',visibleEnabled===actual.enabled);context.assert('展示自动记忆的用途说明',await panel.getByText('在 MobileWork 对话会话缓存相关上下文信息，保障多轮对话连贯性。',{exact:true}).isVisible());await save('记忆默认状态只读观察',{accountIdSha256:actual.accountIdSha256,rawEnabled:actual.rawEnabled,effectiveEnabled:actual.enabled,documentSha256:memoryHash(actual.rawDoc)});await context.capture('记忆当前状态与默认说明');finish('真实记忆入口开关及用途说明');if(actual.rawEnabled!==null)throw review('该账号已有显式记忆配置，只验证当前状态；不能将已有开启值冒充首次默认开启');context.assert('未配置账号的自动记忆默认开启',visibleEnabled);finish('无显式配置账号首次默认开启');
 });
 if(number===185||number===186){
  await control.withUI(context.page,'PREPARING',()=>prepareAccountMemory(context));
  const seed='青禾长期档案-'+randomUUID().slice(0,8),next='星桥长期档案-'+randomUUID().slice(0,8);
  const set=enabled=>settings('memory',panel=>chooseMemoryEnabled(context.page,panel,enabled));
  const observe=async(label,before,marker,enabled)=>observeAutoMemory(context,{before,marker,enabled,onSample:samples=>save(label,samples)});
  if(number===185){
   await set(true);const before=await readMemory(context.page);await context.send('这是我长期负责的项目，代号为“'+seed+'”。请记住此项目背景，后续所有汇报均使用中文。只简短确认，不使用工具或写文件。');await registerMemorySource(context);await context.send('补充长期偏好：该项目的进展汇报固定先列结论，再列行动项。请简短确认。',{continuing:true});const baseline=await observe('开启时实际自动记忆基线',before,seed,true);finish('本轮真实自动生成既有合成记忆');
   await set(false);await context.newSession();await context.send('这是另一项长期项目，代号为“'+next+'”。后续汇报需增加预算列。请简短确认，不调用工具、不生成文件。');await registerMemorySource(context);await context.send('补充长期背景：这项工作每周五审阅，负责人为合成测试员林澄。请简短确认。',{continuing:true});const observed=await observe('关闭后多轮对话与记忆不变',baseline.state,next,false);context.assert('关闭后既有记忆及时间戳完全保留且本轮长期事实未新增',memoryHash(observed.state.rawDoc)===memoryHash(baseline.state.rawDoc)&&!observed.state.doc.content.includes(next));finish('关闭后新Session多轮及既有记忆保留');
  }else{
   await set(false);const before=await readMemory(context.page);await context.send('我的长期测试项目代号为“'+seed+'”，请简短确认。不用工具、不写文件。');await registerMemorySource(context);await context.send('该项目固定每周一整理进展。请简短确认。',{continuing:true});await observe('重新开启前关闭分支观察',before,seed,false);finish('真实关闭状态及本轮多轮对话观察');
   await set(true);await context.newSession();const enabledBefore=await readMemory(context.page);await context.send('我的长期项目代号为“'+next+'”。请记住，今后关于本项目的汇报都用中文并带行动项。仅简短确认，不用工具、不写文件。');await registerMemorySource(context);await context.send('补充长期背景：本项目负责人是合成测试员林澄，固定每周四评审。请简短确认。',{continuing:true});const observed=await observe('重新开启后真实自动整理',enabledBefore,next,true);context.assert('重新开启后本轮实际长期事实进入记忆且源消息已整理',observed.state.doc.content.includes(next)&&Boolean(observed.sourceCheckpoint));finish('重新开启后新Session自动记忆及真实源消息断点');
  }
  await settings('memory',async()=>context.capture('本轮记忆开关与实际自动结果'));finish('记忆页面结果与完整观察证据');return;
 }
 throw Error('系统负向及记忆步骤只支持182～186');
}
