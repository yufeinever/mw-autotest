import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectClient} from '../local-console/client-connection.mjs';
import {uniqueClientPage} from '../local-console/client-page.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';
import {testEnvironment} from '../local-console/environment.mjs';
import {readSessionLogFromPage} from '../local-console/session-log.mjs';
import {getClientCase,caseSheet,caseWorkbook} from './client-case-catalog.mjs';
import {createRunDirectory,createEvidenceRecorder,beijingLogTime} from './mobilework-evidence.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';
import {appendComposerText} from './mobilework-composer.mjs';
import {selectModel,readModelOptions,waitStep} from './mobilework-run-policy.mjs';
import {initializeTestPage} from './mobilework-initialize.mjs';
import {finalAssistantText,waitCreatedSession,guardDialogs} from './client-case-runner.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';
import {workspaces,chooseWorkspace,createDefaultWorkspace,createLocalWorkspace,deleteWorkspace} from './mobilework-workspaces.mjs';
export {workspaces,chooseWorkspace} from './mobilework-workspaces.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const blocked=message=>Object.assign(Error(message),{blocked:true});
const visible=locator=>locator.filter({visible:true});
const button=(page,name)=>visible(page.getByRole('button',{name,exact:true}));

function inside(parent,child){
 const relative=path.relative(path.resolve(parent),path.resolve(child));
 return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));
}

export async function runInterfaceCase(number){
 const definition=getClientCase(number),args=process.argv.slice(2);
 if(!definition.kind?.startsWith('workspace-')&&!['model-selection'].includes(definition.kind))throw Error('该入口只处理017～021界面用例');
 if(args.some(arg=>arg!=='--check'))throw Error('界面用例只支持 --check 或完整执行');
 const checkOnly=args.includes('--check'),config=normalizeConfig(JSON.parse(process.env.MW_TEST_CONFIG_JSON||'{}'));
 const started=new Date(),dir=await createRunDirectory(path.join(root,'runs'),definition.label+(checkOnly?'预检':''),started);
 const events=[],checks=[],recorder=createEvidenceRecorder(dir);
 let browser,page,sessionId,result='BLOCKED',errorText='',createdWorkspace,previousWorkspace,expectedDirectory,trace,data;
 const log=(step,detail='')=>{const event={time:new Date().toISOString(),step,detail};events.push(event);console.log('['+beijingLogTime()+'] '+step+' '+detail);};
 const control=createTaskControl({log});
 const assert=(name,pass,actual)=>{checks.push({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});if(!pass)throw Error('断言失败：'+name);};
 const capture=step=>control?.withUI(page,'EVIDENCE',()=>recorder.capture(page,step));
 try{
  if(!control)throw blocked('请从18888控制台调度界面用例');
  browser=await connectClient('http://127.0.0.1:'+config.cdpPort,{timeout:15000});
  page=uniqueClientPage(browser);
  page.setDefaultTimeout(10000);
  await control.begin(page,{openComposer:!checkOnly,stepInterval:config.stepInterval,model:config.model});
  await capture('连接客户端');
  const before=(await workspaces(page)).items;
  previousWorkspace=before.find(item=>page.url().includes('/workspace/'+item.id+'/'));
  const defaultSpace=before.find(item=>item.isDefault)||before.find(item=>item.name==='默认工作空间');
  if(checkOnly){
   assert('当前客户端主页面可读',await page.locator('main').last().isVisible());
   assert('产品工作空间列表可读取',Array.isArray(before)&&before.length>0);
  }else if(definition.kind==='workspace-default'){
   expectedDirectory=defaultSpace.path;await chooseWorkspace(page,defaultSpace.name);
   assert('默认工作空间在输入区被选中',await button(page.locator('main').last(),defaultSpace.name).count()===1,defaultSpace.name);
  }else if(definition.kind==='workspace-create'){
   const name='MW-Autotest-'+Date.now();createdWorkspace=await createDefaultWorkspace(page,name);expectedDirectory=createdWorkspace.path;
   assert('默认存储空间创建成功',createdWorkspace.name===name,createdWorkspace);log('本轮工作空间已创建',name);
  }else if(definition.kind==='workspace-local'){
   const name='MW-Autotest-Local-'+Date.now(),folder=path.join(testEnvironment.taskRoot,name);createdWorkspace=await createLocalWorkspace(page,folder,log,dir,control);expectedDirectory=createdWorkspace.path;
   assert('原生文件夹选择器已识别并关闭',createdWorkspace.nativePicker.dialogFound&&createdWorkspace.nativePicker.dialogClosed);
   // Creating a local workspace can return to the previous Session view.
   await initializeTestPage(page,{stepInterval:config.stepInterval,model:config.model,log});
   await chooseWorkspace(page,createdWorkspace.name);assert('本地工作空间已被选择',await button(page.locator('main').last(),createdWorkspace.name).count()===1,createdWorkspace.name);
  }else if(definition.kind==='workspace-reference'){
   const selected=before.find(item=>!item.isDefault&&item.workspaceType==='local');
   if(!selected)throw blocked('没有可供引用的已有本机工作空间');
   expectedDirectory=selected.path;await chooseWorkspace(page,selected.name);
   assert('已有工作空间可被发现并引用',await button(page.locator('main').last(),selected.name).count()===1,selected.name);
  }else{
   const beforeModels=await readModelOptions(page,config);
   assert('模型列表包含自动项',beforeModels.models.some(model=>model.name==='自动'),beforeModels.models);
   const target=beforeModels.models.find(model=>model.name!=='自动'&&!model.disabled);
   if(!target)throw blocked('模型列表没有可切换的候选模型');
   await selectModel(page,target.name,{stepInterval:config.stepInterval});
   const switched=await readModelOptions(page,config);assert('目标模型切换后被选中',switched.models.some(model=>model.name===target.name&&model.selected),target.name);
   await selectModel(page,'自动',{stepInterval:config.stepInterval});
   const restored=await readModelOptions(page,config);assert('模型切换后恢复自动',restored.models.some(model=>model.name==='自动'&&model.selected),restored.models);
   log('模型主流程完成',target.name+' → 自动');
  }
  await capture('配置完成');
  if(checkOnly){result='CHECKED';log('只读预检完成','未创建本次业务Session');}
  else{
   const editor=visible(page.locator('[contenteditable="true"]'));
   if(await editor.count()!==1)throw blocked('未找到唯一任务输入框');
   const filled=await appendComposerText(editor,definition.prompt,{stepInterval:config.stepInterval});
   assert('测试输入已写入当前会话',filled.text.includes(definition.prompt));
   await capture('发送前');await control.markSubmitting();await button(page,'运行任务').click();
   sessionId=await waitCreatedSession(page,page.url(),{timeoutMs:Math.min(definition.timeoutMs,180000),log});
   await control.registerSession(page,sessionId);await control.submitted(page,sessionId);
   data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log});
   const actualDirectory=data.session?.directory||'';
   if(expectedDirectory)assert('Session目录属于本次选定工作空间',inside(expectedDirectory,actualDirectory),{expected:expectedDirectory,actual:actualDirectory});
   assert('Session返回最终助手文本',Boolean(finalAssistantText(data).trim()));
   await fs.writeFile(path.join(dir,sessionId+'-session-log.json'),JSON.stringify(data,null,2));
   await capture('执行完成');result=checks.every(check=>check.pass)?'PASS':'FAIL';
  }
 }catch(error){errorText=error.message;result=error.blocked?'BLOCKED':sessionId?'FAIL':'BLOCKED';log(result,errorText);if(page)await capture('异常现场').catch(()=>{});}
 finally{
  if(createdWorkspace&&!checkOnly){try{
   if(previousWorkspace&&page.url().includes('/workspace/'+createdWorkspace.id+'/')){
    await initializeTestPage(page,{stepInterval:config.stepInterval,model:config.model,log});
    await chooseWorkspace(page,previousWorkspace.name);
   }
   await deleteWorkspace(page,createdWorkspace.id);log('已清理本轮工作空间',createdWorkspace.name);
  }catch(error){errorText=(errorText?errorText+'；':'')+error.message;result='BLOCKED';}}
  trace=page&&sessionId?await saveRunTrace({page,sessionId,number,dir,checks,log,...(control?.connection?{readLog:children=>control.readLog(children)}:{})}):null;
  const summary={result,caseId:definition.id,sheet:caseSheet,workbook:caseWorkbook,row:definition.row,title:definition.title,mode:checkOnly?'只读预检':'完整执行',startedAt:started.toISOString(),endedAt:new Date().toISOString(),sessionId,checks,events,evidence:recorder.evidence,trace,error:errorText,scope:'工作空间或模型配置真实界面操作；Session目录、最终回复和Trace证据'};
  await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(dir,'执行日志.txt'),events.map(event=>event.time+' '+event.step+' '+event.detail).join('\n')+'\n');
  const lines=['# '+definition.id+' 执行报告','','- 用例：'+definition.title,'- 原表：'+caseSheet+'，第'+definition.row+'行','- 结果：'+result,'- Session：'+(sessionId||'未创建'),'- 错误或阻塞：'+(errorText||'无'),'','## 断言','',...checks.map(check=>'- '+(check.pass?'通过':'**失败**')+'：'+check.name),'','## 执行过程','',...events.map(event=>'- '+event.time+' '+event.step+' '+event.detail),'','## 过程截图','',...recorder.evidence.flatMap(item=>['### '+item.step,'','!['+item.step+']('+item.screenshot+')',''])];
  if(trace)lines.push('','## Trace 记录','','- 调用证据：[trace.json](trace.json)');
  await fs.writeFile(path.join(dir,'执行报告.md'),lines.join('\n')+'\n');
  await control?.close(page).catch(error=>log('调度交接未完成',error.message));await browser?.close().catch(()=>{});
  console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=result==='PASS'||result==='CHECKED'?0:result==='BLOCKED'?2:1;
 }
}
