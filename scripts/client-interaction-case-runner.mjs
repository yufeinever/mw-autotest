import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectClient} from '../local-console/client-connection.mjs';
import {uniqueClientPage} from '../local-console/client-page.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';
import {getClientCase,caseSheet,caseWorkbook} from './client-case-catalog.mjs';
import {createRunDirectory,createEvidenceRecorder,beijingLogTime} from './mobilework-evidence.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';
import {RootSessionGroup} from './mobilework-root-session-group.mjs';
import {archiveRootEvidence} from './client-case-multi-root-steps.mjs';
import {appendComposerText,readComposerState,normalizeComposerText} from './mobilework-composer.mjs';
import {snapshotDraft,clearOwnedDraft,editorOf,resetComposerPermission,readComposerPermission} from './mobilework-isolation.mjs';
import {selectSlashSkill} from './mobilework-skill-resources.mjs';
import {waitCreatedSession,finalAssistantText} from './client-case-runner.mjs';
import {handleConfiguredDialog,waitStep} from './mobilework-run-policy.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';
import {attachmentRow,releaseComposerResources} from './mobilework-composer-resources.mjs';
import {runTaskLifecycleSteps} from './client-task-lifecycle-steps.mjs';
import {runMessageDisplaySteps} from './client-message-display-steps.mjs';
import {runLoadingUsageSteps} from './client-loading-usage-steps.mjs';
import {runMessageActionsSteps} from './client-message-actions-steps.mjs';
import {runQueueWorkbenchSteps} from './client-queue-workbench-steps.mjs';
import {runFilePreviewSteps} from './client-file-preview-steps.mjs';
import {runOfficeFileSteps} from './client-office-file-steps.mjs';
import {runMindmapTodoSteps} from './client-mindmap-todo-steps.mjs';
import {runBrowserWorkspaceSteps} from './client-browser-workspace-steps.mjs';
import {runWorkspaceManagementSteps} from './client-workspace-management-steps.mjs';
import {runRpaPreconditions} from './client-rpa-preconditions.mjs';
import {runStaffMarketSteps} from './client-staff-market-steps.mjs';
import {runGuiRecordingSteps} from './client-gui-recording-steps.mjs';
import {runRecordingWorkflowSteps} from './client-recording-workflow-steps.mjs';
import {runSkillManagementSteps} from './client-skill-management-steps.mjs';
import {runExpertModuleSteps} from './client-expert-module-steps.mjs';
import {runAutomationSteps} from './client-automation-steps.mjs';
import {runCaseLibrarySteps} from './client-case-library-steps.mjs';
import {runKnowledgeManagementSteps} from './client-knowledge-management-steps.mjs';
import {runKanbanSteps} from './client-kanban-steps.mjs';
import {runKanbanTaskSteps} from './client-kanban-task-steps.mjs';
import {runKanbanOperationsSteps} from './client-kanban-operations-steps.mjs';
import {runEfficiencySteps} from './client-efficiency-steps.mjs';
import {runAccountUsageSteps} from './client-account-usage-steps.mjs';
import {runAccountNavigationSteps} from './client-account-navigation-steps.mjs';
import {runAccountProfileSteps} from './client-account-profile-steps.mjs';
import {runSystemSettingsSteps} from './client-system-settings-steps.mjs';
import {runSystemMemorySteps} from './client-system-memory-steps.mjs';
import {runConversationSettingsSteps} from './client-conversation-settings-steps.mjs';
import {runSecuritySettingsSteps} from './client-security-settings-steps.mjs';
import {runHelpFeedbackSteps} from './client-help-feedback-steps.mjs';
import {runFeedbackSteps} from './client-feedback-steps.mjs';
import {runUpdateSteps} from './client-update-steps.mjs';
import {runHomeWorkspaceSteps} from './client-home-workspace-steps.mjs';
import {runHomeModelSteps} from './client-home-model-steps.mjs';
import {resumeClientRestart} from './mobilework-client-restart.mjs';
import {releaseSettingsPanel} from './mobilework-account-settings.mjs';
import {releaseAccountLogout} from './mobilework-account-logout.mjs';
import {identifyKanbanTask} from './mobilework-kanban.mjs';
import {findAutomationSession,settleOwnedAutomation} from './mobilework-automation-resources.mjs';
import {adoptCaseTaskDraft} from './mobilework-case-library.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';
import {queueMessage,interveneQueued} from './mobilework-message-queue.mjs';
import {initializeTestPage} from './mobilework-initialize.mjs';
import {adoptWorkspacePage} from './mobilework-workspaces.mjs';
import {canAdvanceRecordingSession,settleRecordingResources} from './mobilework-recording-workflow.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const blocked=message=>Object.assign(Error(message),{blocked:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const messageText=m=>(m.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
const review=message=>Object.assign(Error(message),{review:true});
const fileSize=bytes=>{const units=['B','KB','MB','GB'],index=Math.min(3,Math.floor(Math.log(bytes)/Math.log(1024)));return (index?Math.round(bytes/1024**index*10)/10:bytes)+' '+units[index];};

export async function runInteractionCase(number){
 const definition=getClientCase(number),args=process.argv.slice(2);
 if(!definition.kind.startsWith('interaction-'))throw Error('入口仅支持任务交互用例');
 if(args.some(arg=>arg!=='--check'))throw Error('只支持完整执行或--check');
 const checkOnly=args.includes('--check'),config=normalizeConfig(JSON.parse(process.env.MW_TEST_CONFIG_JSON||'{}'));
 const started=new Date(),dir=await createRunDirectory(path.join(root,'runs'),definition.label,started);
 const checks=[],events=[],outputs=[],sessions=[],remaining=new Set(definition.steps),recorder=createEvidenceRecorder(dir);
 const log=(step,detail='')=>{events.push({time:new Date().toISOString(),step,detail});console.log('['+beijingLogTime()+'] '+step+' '+detail);};
 const control=createTaskControl({log});let browser,page,owned,resources,sessionId,data,trace,rootGroup,recordingResources=null,expertResources=null,submissionPending=false,result='BLOCKED',errorText='';
 const assert=(name,pass,actual)=>{checks.push({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});if(!pass)throw Error('断言失败：'+name);};
 const capture=(step,key)=>{
  key??=rootGroup?.activeControl?.rootKey||rootGroup?.pending?.key||rootGroup?.currentRootKey;
  const record=()=>recorder.capture(page,key&&!step.startsWith('任务'+key)?'任务'+key+'-'+step:step);
  if(rootGroup?.activeControl)return rootGroup.activeControl.withUI(page,'EVIDENCE',record);
  if(rootGroup?.pending)return rootGroup.withPendingUI('EVIDENCE',record);
  if(rootGroup?.tasks.length)return rootGroup.withRootUI(rootGroup.tasks.some(task=>task.key===key)?key:rootGroup.tasks[0].key,'EVIDENCE',record);
  return control.withUI(page,'EVIDENCE',record);
 };
 const createRootGroup=()=>{if(rootGroup)throw Error('本用例已建立根任务组');rootGroup=new RootSessionGroup({control,page,config,dir,capture,log});return rootGroup;};
 const checkpointResources=()=>control.call('checkpoint',{composerResources:resources});
 const checkpointExpertResources=async next=>{
  if(next)expertResources=next;
  await control.call('checkpoint',{expertResources:next});
  if(next===null)expertResources=null;
 };
 const checkpointRecordingResources=async next=>{recordingResources=next;await control.call('checkpoint',{recordingResources:next});};
 const settleOwnedRecording=async()=>{
  if(!recordingResources)return;
  await control.acquire(page,'EVIDENCE');
  await settleRecordingResources(page,recordingResources,{allowAbort:false,checkpoint:()=>checkpointRecordingResources(recordingResources),submissionPending,submittedSession:sessionId?{id:sessionId,url:control.sessionUrl}:null});
  await checkpointRecordingResources(null);
 };
 const replaceClient=async next=>{const previous=browser;browser=next.browser;page=next.page;page.setDefaultTimeout(10000);await previous.close();};
 const checkpointPage=async(draft,extra={})=>{
  owned=draft||await snapshotDraft(page);resources.url=owned.url;
  const {editor,...saved}=owned;
  await control.call('checkpoint',{draft:saved,composerResources:resources,...extra});
 };
 const recordPreparedSession=async session=>{
  const archive='准备会话-'+String(sessions.length+1).padStart(2,'0'),target=path.join(dir,archive);await fs.mkdir(target);
  const snapshot=await saveRunTrace({page,sessionId:session.id,number,dir:target,checks,log});
  if(snapshot.error)throw blocked('准备会话日志或Trace未保存：'+snapshot.error);
  sessions.push({id:session.id,directory:session.directory,evidence:archive,origin:'product-local-api',modelRequested:false,trace:{...snapshot,path:archive+'/trace.json'}});
  outputs.push({name:archive+'日志',path:archive+'/'+session.id+'-session-log.json'},{name:archive+'Trace',path:archive+'/trace.json'});
 };
 const markDraftSent=async()=>{owned=null;await control.call('checkpoint',{draft:null});};
 async function fill(text){
  const editor=editorOf(page);owned=await snapshotDraft(page,editor);
  const filled=await appendComposerText(editor,text,{...config,onDraft:async draft=>{owned={...owned,...draft};await control.checkpointDraft(owned);}});
  owned={...owned,...filled};await control.checkpointDraft(owned);
 }
 async function send(text,{continuing=false,wait=true,waitOptions={},prefilled=false,submit=()=>button(page,'运行任务').click()}={}){
  await control.acquire(page,'PREPARING');
  if(continuing)await control.call('checkpoint',{continuing:true});
  const previous=continuing?(await control.readLog()).messages.at(-1)?.info?.id:undefined;
  if(prefilled){
   const draft=await snapshotDraft(page);
   if(!owned||draft.url!==owned.url||normalizeComposerText(draft.text)!==normalizeComposerText(text)||normalizeComposerText(owned.text)!==normalizeComposerText(text))throw blocked('实际预填与本轮已登记的完整提示词不一致，未发送');
   await checkpointPage(draft);
  }else await fill(text);
  await capture(continuing?'续轮发送前':'发送前');
  const originalUrl=page.url();data=null;trace=null;submissionPending=true;
  if(recordingResources&&!recordingResources.sourceSession&&!recordingResources.submissionAttempted){
   recordingResources.submissionAttempted=true;
   await control.call('checkpoint',{submitting:true,recordingResources});
  }else await control.markSubmitting();
  await submit();owned=null;
  if(!continuing)sessionId=await waitCreatedSession(page,originalUrl,{timeoutMs:90000,log});
  await control.registerSession(page,sessionId);
  submissionPending=false;
  if(resources.moduleNavigation?.originUrl===originalUrl)delete resources.moduleNavigation;
  resources.url=page.url();await checkpointResources();
  await control.submitted(page,sessionId);
  if(control.held)await control.release(page);
  if(wait){data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log,afterMessageId:previous,...waitOptions});await capture('本轮执行完成');}
  return previous;
 }
 async function adoptExternalSession({sessionId:externalId,workspaceId,expectedPrompt,workspacePath}){
  const automation=resources.automation,link=automation&&await findAutomationSession(page,automation);
  if(!automation?.runPending||link?.sessionId!==externalId||link.workspaceId!==workspaceId)throw blocked('外部Session未与本轮自动化计划唯一关联');
  await control.acquire(page,'PREPARING');
  const url=new URL(automation.originUrl);url.hash='/workspace/'+workspaceId+'/session/'+externalId;
  // Keep the renderer alive: the product's automation runner awaits its model
  // and records the run in this same document. A full navigation would kill it.
  await page.evaluate(hash=>{location.hash=hash;},url.hash);await page.waitForURL(url.href);
  await page.waitForFunction(expected=>(document.querySelector('main:last-of-type')||document.body).innerText.replace(/\s+/g,' ').includes(expected.replace(/\s+/g,' ')),expectedPrompt,{timeout:30000});
  await control.registerSession(page,externalId);sessionId=externalId;
  delete resources.moduleNavigation;resources.url=page.url();await checkpointResources();await markDraftSent();
  await control.submitted(page,sessionId);
  const relative=path.relative(workspacePath,control.directory);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw blocked('自动化任务目录不属于产品关联的本轮空间');
  const deadline=Date.now()+30000;let user;
  while(Date.now()<deadline){
   user=(await control.readLog()).messages.find(m=>m.info?.role==='user');
   if(user)break;await page.waitForTimeout(200);
  }
  if(!user||!messageText(user).includes(expectedPrompt))throw blocked('自动化Session未包含本轮真实任务指令，未继续处理交互');
  log('接管产品自动化Session',sessionId+'；未通过普通对话重复发送');
  data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log});await capture('自动化模型执行完成');
 }
 async function sendKanbanTask(){
  const task=resources.kanban.task;if(!task||task.submitted)throw blocked('看板任务未登记或已发送，不重复提交');
  await control.acquire(page,'PREPARING');await capture('看板任务发送前');
  task.submitted=true;await checkpointResources();await control.markSubmitting();
  await button(page,'发送').click();
  // The product navigates through /session and submits the board task itself.
  const deadline=Date.now()+90000;
  while(!/\/session\/ses_[A-Za-z0-9]+$/.test(page.url())&&Date.now()<deadline){
   const current=new URL(page.url()),origin=new URL(task.originUrl);
   if(current.origin!==origin.origin||current.pathname!==origin.pathname||!['#/session',origin.hash,'#/kanban/'+resources.kanban.id].includes(current.hash))throw blocked('看板任务交接离开本轮入口，未重复发送');
   if((await page.locator('body').innerText()).includes('工作区准备失败'))throw blocked('看板自动任务工作区准备失败；保留待交接归属');
   await page.waitForTimeout(200);
  }
  const link=await identifyKanbanTask(page,resources);sessionId=link.sessionId;task.sessionId=sessionId;
  await control.registerSession(page,sessionId);owned=null;delete resources.moduleNavigation;resources.url=page.url();await checkpointResources();
  await control.submitted(page,sessionId);data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log});await capture('看板模型任务完成');
 }
 async function waitBusy(){
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){const states=await control.get('/session/status');if(states[sessionId]?.type==='busy')return;await page.waitForTimeout(200);}
  throw review('首轮未观察到实际busy状态，未验证人工介入，不把直接完成当介入成功');
 }
 async function newSession(){
  if(recordingResources&&!canAdvanceRecordingSession(recordingResources))throw blocked('本轮录制、生成或续轮尚未完成，不能切换回放会话');
  await control.acquire(page,'PREPARING');
  if((await control.get('/session/status'))[sessionId]?.type==='busy')throw blocked('本阶段仍在运行，不能新建下一阶段会话');
  const archive='会话-'+String(sessions.length+1).padStart(2,'0'),target=path.join(dir,archive);
  await fs.mkdir(target);
  const snapshot=await saveRunTrace({page,sessionId,number,dir:target,checks,log,readLog:children=>control.readLog(children)});
  if(snapshot.error)throw blocked('本阶段会话日志或Trace未保存，不能切换阶段会话：'+snapshot.error);
  sessions.push({id:sessionId,directory:control.directory,evidence:archive,trace:{...snapshot,path:archive+'/trace.json'}});
  outputs.push({name:archive+'会话日志',path:archive+'/'+sessionId+'-session-log.json'},{name:archive+'Trace',path:archive+'/trace.json'});
  await control.call('checkpoint',{nextSession:true});
  control.permissionEvents?.stop();control.permissionEvents=null;control.connection=null;control.directory=null;control.sessionId=null;control.sessionUrl=null;
  sessionId=null;data=null;trace=null;
  await initializeTestPage(page,{stepInterval:config.stepInterval,model:config.model||'自动',managedSession:true,log});
  owned=await snapshotDraft(page);await control.checkpointDraft(owned);resources.url=page.url();await checkpointResources();
 }
 async function permissionMode(full){
  await button(page,'权限').click();
  await button(page,full?'完全访问权限':'默认权限').click();
  if(full){const consent=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'确认开启完全访问权限',exact:true})});await consent.waitFor();await capture('完全访问二次确认');await page.waitForTimeout(1000);await consent.getByRole('button',{name:'同意并开启',exact:true}).click();await consent.waitFor({state:'hidden'});}
  assert('权限菜单选中状态已生效',await readComposerPermission(page)===(full?'full':'default'));
 }
 try{
  if(!control)throw blocked('请通过18888控制台统一调度');
  browser=await connectClient('http://127.0.0.1:'+config.cdpPort,{timeout:15000});page=uniqueClientPage(browser);page.setDefaultTimeout(10000);
  await control.begin(page,{openComposer:!checkOnly,stepInterval:config.stepInterval,model:config.model||'自动'});await capture('连接客户端');
  if(checkOnly){assert('客户端输入区可读取',await editorOf(page).count()===1);result='CHECKED';}
  else{
   owned=await snapshotDraft(page);await control.checkpointDraft(owned);
   resources={url:page.url(),attachments:[],queueTexts:[],restorePermission:false};await checkpointResources();
   if(number>=17&&number<=21){
    await (number===21?runHomeModelSteps:runHomeWorkspaceSteps)({number,definition,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,checkpointResources,checkpointPage,getData:()=>data,getSessionId:()=>sessionId});
   }else if(number===27){
    const fixtureDir=path.join(root,'scripts','fixtures','client-upload-files'),files=(await fs.readdir(fixtureDir)).filter(name=>!name.endsWith('.md'));
    const expected=['.txt','.docx','.pptx','.xlsx','.pdf','.js','.png'];
    assert('测试材料覆盖原表七类真实格式',expected.every(ext=>files.some(name=>path.extname(name)===ext)),files);
    const upload=button(page,'上传文件');await upload.hover();
    const tip=page.locator('[data-slot="tooltip-content"][data-open]:not([data-closed])').filter({visible:true,hasText:"上传"});await tip.waitFor();assert('上传入口悬停有上传提示',(await tip.innerText()).includes('上传'));await capture('上传文件悬停提示');
    remaining.delete('上传入口与选择器');
    for(const name of files){
     const file=path.join(fixtureDir,name),target=path.join(dir,'输入材料',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(file,target);
     const {size}=await fs.stat(target);resources.attachments.push(name);await checkpointResources();
     await upload.click();
     const choicePromise=page.waitForEvent('filechooser');await button(page,'上传文件').last().click();const chooser=await choicePromise;
     assert('产品触发真实文件选择请求：'+name,chooser.isMultiple());await chooser.setFiles(target);
     const row=attachmentRow(page,name);await row.waitFor();
     assert('附件展示真实名称和大小：'+name,(await row.innerText()).includes(fileSize(size)),{name,size});
     assert('附件提供移除控件：'+name,await row.locator('button[title]').count()===1);await capture('附件展示-'+name);
     await row.locator('button[title]').click();await row.waitFor({state:'hidden'});
     assert('附件可移除且保留空白输入：'+name,(await readComposerState(editorOf(page))).text==='');
     resources.attachments=[];await checkpointResources();
    }
    remaining.delete('七类文件展示及移除');
   }else if(number===28){
    await resetComposerPermission(page,config);resources.restorePermission=true;await checkpointResources();
    const outputs=path.join(dir,'权限输出');await fs.mkdir(outputs);let approvals=0;
    const permissionHandler=async({kind,targets,canAct})=>{
     if(kind!=='permission')return undefined;
     const handled=await handleConfiguredDialog(page,{...config,approval:'once'},capture,log,{kind,canAct,expectedPermission:{id:targets[0].id,sessionID:sessionId}});
     if(handled)approvals++;return handled;
    };
    const first=path.join(outputs,'允许一次.txt'),second=path.join(outputs,'完全访问.txt');
    await send('这是隔离测试。请在 '+first+' 新建UTF-8文件，内容为“青禾项目预算为7300元”。只操作这个路径，不写其他目录。完成后简要说明。',{waitOptions:{interactionHandler:permissionHandler}});
    assert('默认权限阶段真实文件已创建',(await fs.readFile(first,'utf8')).includes('7300'));
    if(approvals){assert('允许一次由本Session真实审批卡确认',true,approvals);remaining.delete('默认权限允许一次');}
    else log('允许一次分支待复核','默认权限阶段未触发审批，文件已创建，不把未询问判为允许一次通过');
    await control.acquire(page,'INTERACTING');await permissionMode(true);await capture('完全访问已选中');
    let unexpectedApprovals=0;
    await send('继续隔离测试。请在 '+second+' 新建UTF-8文件，内容为“青禾项目责任人为林悦”。只操作这个路径。',{continuing:true,waitOptions:{interactionHandler:async({kind})=>{if(kind==='permission'){unexpectedApprovals++;throw Error('完全访问仍出现本轮文件操作审批');}return undefined;}}});
    assert('完全访问真实操作成功且未出现审批',!unexpectedApprovals&&(await fs.readFile(second,'utf8')).includes('林悦'));
    remaining.delete('完全访问二次确认及真实操作');
   }else if(number===29){
    // Product now queues first; its per-item “人工介入” is the direct-send path.
    const initial='请连续调用工具，分三次读取当前任务目录的一级文件列表，每次单独调用，不修改文件。最后汇总看到的文件类型。';
    await send(initial,{wait:false});await waitBusy();
    const queued='排队校验：请计算127加286，并说明运算结果。';
    const queueContext={page,control,resources,fill,markDraftSent,checkpointResources,getSessionId:()=>sessionId};
    const {before}=await queueMessage(queueContext,queued);owned=null;await capture('首轮执行中消息进入队列');
    const current=await control.readLog();assert('排队时本轮消息尚未发送给引擎',!current.messages.some(m=>m.info?.role==='user'&&messageText(m).includes(queued)));
    await control.release(page);data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log,afterMessageId:before.messages.at(-1).info.id});
    const queuedIndex=data.messages.findIndex(m=>m.info?.role==='user'&&messageText(m).includes(queued));
    const prior=data.messages.slice(0,queuedIndex).filter(m=>m.info?.role==='assistant');
    assert('排队消息在首轮助手完成后发送',queuedIndex>0&&prior.at(-1)?.info?.time?.completed<=data.messages[queuedIndex].info.time.created);
    assert('排队轮最终回复包含正确结果',finalAssistantText(data).includes('413'));remaining.delete('排队等待上一轮完成');
    await send(initial,{continuing:true,wait:false});await waitBusy();
    const interrupt='介入校验：停止上一轮目录分析，现在只计算215加308。';
    await queueMessage(queueContext,interrupt);owned=null;
    const boundary=await interveneQueued(queueContext,interrupt);await capture('人工介入当前任务');
    await control.release(page);data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log,afterMessageId:boundary});
    const index=data.messages.findIndex(m=>m.info?.role==='user'&&messageText(m).includes(interrupt));
    assert('人工介入后的新指令完成',index>0&&finalAssistantText(data).includes('523'));
    const aborted=data.messages.slice(0,index).some(m=>m.info?.error&&/abort|cancel|interrupt/i.test(JSON.stringify(m.info.error)));
    if(!aborted)throw review('介入新指令已完成，但未取得上一轮中止证据；不能仅凭最终答案判定直接介入成功');
    remaining.delete('人工介入中止当前轮');
   }else if(number===30){
    const name='青禾项目材料-'+path.basename(dir)+'.txt';
    await send('请在当前任务目录新建文件“'+name+'”，内容为“引用材料准备完成”。只创建这个文本文件，不修改其他文件。');
    const actual=path.join(control.directory,name),body=await fs.readFile(actual,'utf8');
    assert('本Session真实生成本轮引用文件',body.includes('引用材料准备完成'),actual);
    // This is input preparation for @, not a claimed model output. Keeping the
    // facts out of the first prompt prevents a memory-only summary from passing.
    const material='合成引用材料：青禾项目预算7300元，责任人林悦，验收日期2026年11月6日。';
    await fs.writeFile(actual,material,'utf8');await fs.writeFile(path.join(dir,'预存引用材料.txt'),material,'utf8');
    log('本轮引用输入材料已准备','产品生成本轮文件后，仅替换此文件的合成输入内容；事实未写入此前提示词');
    remaining.delete('本轮历史会话及真实文件准备');
    await control.acquire(page,'INTERACTING');await control.call('checkpoint',{continuing:true});
    const boundary=data.messages.at(-1).info.id;await fill('@');await page.keyboard.insertText(name);
    owned=await snapshotDraft(page);await control.checkpointDraft(owned);
    const option=page.locator('button[title]').filter({visible:true}).filter({hasText:name});
    const empty=page.getByText('未找到匹配的文件',{exact:true}).filter({visible:true});
    try{await option.or(empty).first().waitFor({timeout:45000});}
    catch(error){if(error.name!=='TimeoutError')throw error;throw blocked('@文件候选45秒仍未返回，停止本条并保留加载现场；未把加载中判断为文件不存在');}
    await capture('引用文件候选列表');assert('候选加载后找到本轮引用文件',await option.count()===1);
    const mentionMenu=page.getByRole('presentation').filter({has:option});
    const candidates=await mentionMenu.locator('button[title]').evaluateAll(nodes=>nodes.map(node=>({title:node.title,text:node.innerText})));
    await fs.writeFile(path.join(dir,'引用文件候选.json'),JSON.stringify({query:name,candidates},null,2));
    if(candidates.length!==1)throw blocked('@列表存在多个候选，未用键盘确认不明确的文件');
    // The product's composer handles Tab through the same onInsertMention path
    // as its candidate button, without the conversation scroll overlay.
    await editorOf(page).press('Tab');
    const chip=editorOf(page).locator('[data-mention-chip]');await chip.waitFor();
    assert('通过真实@列表生成文件引用标签',(await chip.innerText()).includes(name));
    owned=await snapshotDraft(page);await control.checkpointDraft(owned);remaining.delete('@引用候选与标签');
    await fill('请读取刚引用的文件，提取项目预算、责任人和验收日期，简要总结。');
    await control.markSubmitting();await button(page,'运行任务').click();owned=null;await control.registerSession(page,sessionId);await control.release(page);
    data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log,afterMessageId:boundary});
    const output=finalAssistantText(data);assert('引用文件内容被正确读取和总结',['7300','林悦'].every(word=>output.includes(word))&&/11.{0,3}6|2026-11-06|2026年11月6/.test(output));
    const newMessages=data.messages.slice(data.messages.findIndex(m=>m.info?.id===boundary)+1);
    assert('引用后有实际文件内容或已完成读取工具证据',newMessages.some(m=>(m.parts||[]).some(p=>p.type==='tool'&&p.state?.status==='completed'&&JSON.stringify(p.state.input||{}).includes(name)&&['7300','林悦'].every(word=>JSON.stringify(p.state.output||'').includes(word))))||newMessages.some(m=>m.info?.role==='user'&&(m.parts||[]).some(p=>p.type==='file'&&[name,encodeURIComponent(name)].some(value=>String(p.filename||p.url||'').includes(value)))));
    remaining.delete('引用后真实读取与总结');
   }else if(number===31){
    const skill='chinese-official-writing',displayName='文稿写作',editor=editorOf(page);await fill('/');
    const search=page.locator('input[placeholder="输入名称搜索..."]').filter({visible:true});await search.waitFor();await search.fill(skill);
    const menu=search.locator('xpath=../../..').getByRole('presentation'),element=await menu.elementHandle();let ready=false;
    try{
     await page.waitForFunction(node=>{
      if(!node.isConnected||node.textContent.includes('正在加载命令与技能…'))return false;
      return node.querySelectorAll('button').length>0||node.textContent.trim()==='未找到命令或技能。';
     },element,{timeout:45000});ready=true;
    }catch(error){if(error.name!=='TimeoutError')throw error;}
    finally{
     await element.dispose();
     const candidates=await menu.getByRole('button').evaluateAll(nodes=>nodes.map(node=>({text:node.innerText,disabled:node.getAttribute('aria-disabled')==='true'})));
     await fs.writeFile(path.join(dir,'斜线技能候选.json'),JSON.stringify({expectedSkill:skill,expectedDisplayName:displayName,query:await search.inputValue(),ready,loading:await menu.getByText('正在加载命令与技能…',{exact:true}).isVisible(),empty:await menu.getByText('未找到命令或技能。',{exact:true}).isVisible(),candidates},null,2));
     await capture('斜线技能候选');
    }
    if(!ready)throw blocked('当前/菜单45秒仍未完成候选加载，未把加载中判断为技能不存在');
    // The product searches machine IDs, but renders the preset displayName.
    // Identity is confirmed by the actual chip after choosing the real entry.
    const target=menu.getByRole('button').filter({has:page.getByText(displayName,{exact:true})}).filter({visible:true});
    if(await target.count()!==1)throw blocked('当前/菜单未唯一找到原表公文写作技能：'+displayName+'（'+skill+'），未替换为其他技能');
    owned=await selectSlashSkill({page,checkpointPage,getOwnedDraft:()=>owned},target,skill);
    assert('斜线选择真实生成公文写作技能标签',owned.skills.includes(skill));remaining.delete('斜线菜单与技能标签');
    await send('请直接完成以下虚构任务：起草星桥科技综合管理部关于办公设备盘点的通知，范围为电脑、显示器、打印机。各部门在2026年11月6日17时前向赵宁提交资产编号、使用人和设备状态。只输出通知，不发出、不改文件。');
    const output=finalAssistantText(data);assert('公文正文符合素材及通知用途',['通知','电脑','显示器','打印机','赵宁'].every(word=>output.includes(word))&&/11.{0,3}6/.test(output));remaining.delete('公文任务与实际Skill调用');
   }else if(number>=32){
    await (number>=202?runUpdateSteps:number>=200?runFeedbackSteps:number>=199?runHelpFeedbackSteps:number>=192?runSecuritySettingsSteps:number>=187?runConversationSettingsSteps:number>=182?runSystemMemorySteps:number>=177?runSystemSettingsSteps:number>=172?runAccountProfileSteps:number>=167?runAccountNavigationSteps:number>=165?runAccountUsageSteps:number>=162?runEfficiencySteps:number>=152?runKanbanOperationsSteps:number>=147?runKanbanTaskSteps:number>=145?runKanbanSteps:number>=114?runKnowledgeManagementSteps:number>=104?runCaseLibrarySteps:number>=97?runAutomationSteps:number>=92?runExpertModuleSteps:number===91?runSkillManagementSteps:number>=87?runRecordingWorkflowSteps:number>=85?runGuiRecordingSteps:number>=82?runStaffMarketSteps:number>=80?runRpaPreconditions:number>=77?runWorkspaceManagementSteps:number>=72?runBrowserWorkspaceSteps:number>=67?runMindmapTodoSteps:number>=62?runOfficeFileSteps:number>=57?runFilePreviewSteps:number>=52?runQueueWorkbenchSteps:number>=47?runMessageActionsSteps:number>=42?runLoadingUsageSteps:number>=37?runMessageDisplaySteps:runTaskLifecycleSteps)({number,definition,page,config,control,dir,resources,remaining,outputs,checks,assert,capture,jobId:process.env.MW_CONSOLE_JOB_ID,getRecordingResources:()=>recordingResources,checkpointRecordingResources,checkpointExpertResources,settleOwnedRecording,createRootGroup,captureElement:(element,step)=>control.withUI(page,'EVIDENCE',()=>recorder.captureElement(element,step)),replaceClient,captureBrowser:(target,step)=>control.withUI(page,'EVIDENCE',()=>recorder.capture(target,step)),log,send,sendKanbanTask,adoptExternalSession,fill,markDraftSent,waitBusy,newSession,recordPreparedSession,checkpointResources,checkpointPage,getData:()=>data,getSessionId:()=>sessionId,getOwnedDraft:()=>owned,saveTrace:async()=>{
     trace=await saveRunTrace({page,sessionId,number,dir,checks,log,readLog:children=>control.readLog(children)});return trace;
    }});
   }
   await capture('用例操作完成');result=remaining.size?'REVIEW':'PASS';
  }
 }catch(error){errorText=error.message;result=error.review?'REVIEW':error.blocked?'BLOCKED':'FAIL';log(result,errorText);if(page)await capture('异常现场').catch(e=>log('异常截图失败',e.message));}
 finally{
  if(rootGroup){
   for(const task of rootGroup.tasks){
    try{await archiveRootEvidence(task,{page,number,dir,checks,log,outputs});}
    catch(error){log('根任务证据保存失败',task.key+'：'+error.message);errorText+=(errorText?'；':'')+error.message;result='BLOCKED';}
    sessions.push({key:task.key,id:task.id,directory:task.directory,evidence:task.evidence,source:task.source,result:task.result,error:task.error,completed:task.completed,trace:task.trace?{...task.trace,path:task.evidence+'/trace.json'}:null});
   }
   if(number===112&&rootGroup.tasks.length===2&&rootGroup.tasks.every(task=>task.evidenceStored))remaining.delete('各根日志Trace归档');
   const first=rootGroup.tasks[0];sessionId=first?.id;data=first?.data;trace=first?.trace?{...first.trace,path:first.evidence+'/trace.json'}:null;
   try{await rootGroup.close();}
   catch(error){log('根任务组交接未完成',error.message);errorText+=(errorText?'；':'')+error.message;result='BLOCKED';}
   // Shared resources and all active roots remain registered. Only the server's
   // group barrier may settle them and hand the client to the next case.
  }else if(expertResources){
   const reason='专家安装、召唤或历史收尾尚未确认，保留模块与空间交控制台恢复';
   log('专家资源交接未完成',reason);errorText+=(errorText?'；':'')+reason;result='BLOCKED';
  }else if(page&&resources){try{
   await settleOwnedRecording();
   if(resources.clientRestart){const next=await resumeClientRestart(resources,config,{checkpoint:checkpointResources});await replaceClient(next);}
   await control.acquire(page,'EVIDENCE');
   await releaseSettingsPanel(page,resources);await checkpointResources();
   await releaseAccountLogout(page,resources,{checkpoint:checkpointResources});
   if(resources.automation)await settleOwnedAutomation(page,resources.automation);
   const caseDraft=await adoptCaseTaskDraft(page,resources);if(caseDraft)await checkpointPage(caseDraft);
   if(resources.knowledgeSelection&&sessionId&&(await control.get('/session/status'))[sessionId]?.type==='busy')throw blocked('本轮知识库引用Session仍在执行，保留知识库与选择，待统一停止收尾');
   if(resources.kanban?.task?.submitted&&!resources.kanban.task.sessionId){
    const link=await identifyKanbanTask(page,resources);sessionId=link.sessionId;resources.kanban.task.sessionId=sessionId;await control.registerSession(page,sessionId);owned=null;delete resources.moduleNavigation;resources.url=page.url();await checkpointResources();await control.submitted(page,sessionId);await control.acquire(page,'EVIDENCE');
   }
   await restoreModuleNavigation(page,resources,{modelSettled:Boolean(data),cdpPort:config.cdpPort});
   const adopted=await adoptWorkspacePage(page,resources);if(adopted)await checkpointPage(adopted);
   if(owned){if(!await clearOwnedDraft(page,owned,config))throw blocked('本轮草稿清理归属未确认');owned=null;}
   // Active sessions are finalized by the existing scheduler before recovery.
   if(!sessionId||(await control.get('/session/status'))[sessionId]?.type!=='busy'){
    const changedWorkspace=Boolean(resources.workspaceResources);
    if(changedWorkspace&&sessionId){trace=await saveRunTrace({page,sessionId,number,dir,checks,log,readLog:children=>control.readLog(children)});if(trace.error)throw blocked('空间收尾前日志/Trace未保存：'+trace.error);}
    await releaseComposerResources(page,resources,{...config,checkpoint:checkpointResources,checkpointPage,modelSettled:Boolean(data)});await control.call('checkpoint',{composerResources:null});resources=null;
    if(changedWorkspace){await control.call('checkpoint',{draft:null});control.sessionId=null;}
    assert('本轮附件、队列与权限设置收尾完成',true);
   }
  }catch(error){log('输入区收尾未完成',error.message);errorText+=(errorText?'；':'')+error.message;result='BLOCKED';}}
  if(!rootGroup&&page&&sessionId){if(!trace)trace=await saveRunTrace({page,sessionId,number,dir,checks,log,readLog:children=>control.readLog(children)});if(result==='PASS'&&checks.some(check=>!check.pass))result='FAIL';}
  if(rootGroup&&result==='PASS'&&checks.some(check=>!check.pass))result='FAIL';
  const summary={result,caseId:definition.id,sheet:caseSheet,workbook:caseWorkbook,row:definition.row,title:definition.title,startedAt:started.toISOString(),endedAt:new Date().toISOString(),sessionId,sessions:[...sessions,...(!rootGroup&&sessionId?[{id:sessionId,directory:control.directory,evidence:'.'}]:[])],checks,events,outputs,evidence:recorder.evidence,trace,error:errorText,remainingSteps:[...remaining],scope:definition.note,...(rootGroup?{rootSessionVersion:1,rootPending:rootGroup.pending?{key:rootGroup.pending.key,state:rootGroup.pending.state,source:rootGroup.pending.source,submittedAt:rootGroup.pending.submittedAt}:null}:{} )};
  await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));await fs.writeFile(path.join(dir,'执行日志.txt'),events.map(e=>e.time+' '+e.step+' '+e.detail).join('\n')+'\n');
  await fs.writeFile(path.join(dir,'执行报告.md'),['# '+definition.id+' 执行报告','','- 用例：'+definition.title,'- 原表：'+caseSheet+'，第'+definition.row+'行','- 结果：'+result,'- Session：'+(sessionId||(sessions.length?'已准备'+sessions.length+'条真实任务，未发起模型对话':'未创建')),'- 原因：'+(errorText||'无'),'','## 阶段会话证据','',...summary.sessions.map((item,index)=>'- 阶段'+(index+1)+'：'+item.id+'；[日志]('+item.evidence+'/'+item.id+'-session-log.json)；[Trace]('+item.evidence+'/trace.json)'),'','## 未完成步骤','',...[...remaining].map(s=>'- '+s),'','## 断言','',...checks.map(c=>'- '+(c.pass?'通过':'**失败**')+'：'+c.name),'','## 执行过程','',...events.map(e=>'- '+e.time+' '+e.step+' '+e.detail),'','## 过程截图','',...recorder.evidence.flatMap(e=>['### '+e.step,'','!['+e.step+']('+e.screenshot+')',''])].join('\n')+'\n');
  if(!rootGroup)await control?.close(page).catch(e=>log('交接未完成',e.message));await browser?.close().catch(e=>log('断开连接失败',e.message));console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=['PASS','CHECKED','REVIEW'].includes(result)?0:result==='BLOCKED'?2:1;
 }
}
