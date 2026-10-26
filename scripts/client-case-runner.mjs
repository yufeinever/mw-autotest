import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
import {isClientPageUrl} from '../local-console/client-page.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {normalizeConfig} from '../local-console/policy.mjs';
import {readSessionLogFromPage} from '../local-console/session-log.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';
import {testEnvironment} from '../local-console/environment.mjs';
import {selectModel,handleConfiguredDialog,waitStep} from './mobilework-run-policy.mjs';
import {appendComposerText,containsComposerText,readComposerState} from './mobilework-composer.mjs';
import {clearOwnedDraft,selectionState,resetComposerPermission} from './mobilework-isolation.mjs';
import {dispatchStandalone} from './mobilework-standalone.mjs';
import {getClientCase,caseSheet,caseWorkbook} from './client-case-catalog.mjs';
import {clientCaseInput} from './client-case-inputs.mjs';
import {textChecks,fileChecks,expectedArtifacts,readArtifact} from './client-case-checks.mjs';
import {previewChecks} from './client-case-preview.mjs';
import {createRunDirectory,createEvidenceRecorder,beijingLogTime} from './mobilework-evidence.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const scenarioButton=(page,name)=>page.getByRole('button',{name:new RegExp('^\\s*'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:\\s*未生效)?\\s*$')}).filter({visible:true});
const editorOf=page=>page.locator('[contenteditable="true"]').filter({visible:true});
export {clearOwnedDraft} from './mobilework-isolation.mjs';
export const blocked=message=>Object.assign(Error(message),{blocked:true});
export function finalAssistantText(sessionLog){
 const assistants=sessionLog.messages.filter(m=>m.info?.role==='assistant'&&!(m.parts||[]).some(p=>p.type==='tool'));
 return (assistants.at(-1)?.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
}
export async function waitSentInput(page,sessionId,input,{timeoutMs=10000}={}){
 const deadline=Date.now()+timeoutMs;let data;
 do{
  if(!page.url().endsWith('/session/'+sessionId))throw blocked('核对发送消息时页面已离开本次会话');
  data=await readSessionLogFromPage(page,sessionId);
  const text=data.messages.filter(m=>m.info?.role==='user').flatMap(m=>(m.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'')).join('\n');
  if(containsComposerText(text,input))return {data,complete:true};
  await page.waitForTimeout(300);
 }while(Date.now()<deadline);
 return {data,complete:false};
}
export async function waitCreatedSession(page,sourceUrl,{timeoutMs=180000,log=()=>{}}={}){
 const deadline=Date.now()+timeoutMs;let lastLog=0;
 while(Date.now()<deadline){
  const url=page.url(),id=url.match(/\/session\/(ses_[A-Za-z0-9]+)(?:[/?#]|$)/)?.[1];
  if(id)return id;
  if(url!==sourceUrl)throw blocked('任务准备期间页面切换，停止等待，未重发任务');
  const body=await page.locator('body').innerText();
  if(/工作区准备失败|Workspace model runtime is unreachable/.test(body)){
   const detail=body.match(/工作区准备失败\s*([\s\S]*?)(?:第\s*\d+\s*步|重试|返回编辑|$)/)?.[1]?.trim()||body.match(/Workspace model runtime[^\n]*/)?.[0]||'请查看客户端准备步骤';
   throw blocked('客户端工作区准备失败：'+detail.slice(0,700)+'；未创建Session');
  }
  if(body.includes('立即终止并生效'))throw blocked('任务准备触发引擎重载确认；未终止已有会话');
  if(Date.now()-lastLog>20000){log('等待客户端准备并创建会话',body.match(/第\s*\d+\s*步[^\n]*/)?.[0]||'未取得Session ID；不重复发送');lastLog=Date.now();}
  await page.waitForTimeout(500);
 }
 throw blocked('客户端准备任务超时，尚未取得Session ID；请核对客户端准备状态后重试，不自动重复发送');
}
export async function guardDialogs(page,{cancelReload=false,stepInterval=0.5}={}){
 const text=await page.locator('body').innerText();
 if(/配置已更新[，,]?需要重新加载引擎|配置已更新，需要重新加载引擎|立即终止并生效/.test(text)){
  if(cancelReload&&await button(page,'取消').count()===1){await waitStep(page,{stepInterval});await button(page,'取消').click();}
  throw blocked('场景配置要求重新加载引擎；未终止已有会话。请待客户端空闲并确认配置生效后重试');
 }
 const dialogs=page.getByRole('dialog').filter({visible:true});
 if(await dialogs.count())throw blocked('出现未支持的弹窗：'+(await dialogs.first().innerText()).slice(0,240));
}
export async function ensureIdleComposer(page){
 await guardDialogs(page);
 for(const name of ['停止','允许一次','跳过'])if(await button(page,name).count())throw blocked('当前页面已有运行任务或交互，保留现场');
 const editor=editorOf(page);
 if(await editor.count()>1)throw blocked('存在多个任务输入框，不能确认操作归属');
 if(await editor.count()&&((await editor.innerText()).trim()||await editor.locator('[data-skill-remove]').count()))throw blocked('当前有未发送草稿或技能，保留草稿');
 if((await selectionState(page)).length)throw blocked('当前输入区已有选中的专家或团队，保留用户选择');
}
export async function selectTestWorkspace(page,config={}){
 const main=page.locator('main').last(),selected=main.getByRole('button',{name:'默认工作空间',exact:true}).filter({visible:true});
 if(await selected.count()===1)return;
 const trigger=main.getByRole('button',{name:'Mobilework-test',exact:true}).filter({visible:true});
 if(await trigger.count()!==1)throw blocked('请在客户端选择默认工作空间；无法确认当前工作空间选择器');
 await waitStep(page,config);await trigger.click();
 // 弹出列表位于侧栏之后，排除侧栏自带的同名空间按钮。
 const options=button(page,'默认工作空间');
 if(await options.count()!==1){await waitStep(page,config);await page.keyboard.press('Escape');throw blocked('工作空间列表中没有唯一的默认工作空间入口');}
 await waitStep(page,config);await options.click();await selected.waitFor({timeout:5000});
}
// 返回的签名只用于清理本次生成、且从未被其他人改动的预览草稿。
export async function fillScenario(page,definition,config,{capture=async()=>{},log=()=>{},assert=()=>{},onDraft=()=>{}}={}){
 await ensureIdleComposer(page);
 const previousSelection=await selectionState(page);
 // TaskControl.begin has already initialized the fresh composer once.
 await button(page,definition.category).first().waitFor();
 await selectTestWorkspace(page,config);
 await resetComposerPermission(page,config);
 const url=page.url();
 if(config.model){await selectModel(page,config.model,{stepInterval:config.stepInterval});log('模型已回读核对',config.model);}
 await waitStep(page,config);await button(page,definition.category).first().click();
 await guardDialogs(page,{cancelReload:true,stepInterval:config.stepInterval});
 const scene=scenarioButton(page,definition.button).first();await scene.waitFor();
 if(!await scene.isEnabled())throw blocked('场景“'+definition.button+'”当前被客户端禁用（未生效），请先在客户端完成技能或配置生效');
 try{await waitStep(page,config);await scene.click();}catch(e){await guardDialogs(page,{cancelReload:true,stepInterval:config.stepInterval});throw e;}
 // 当前客户端的技能配置弹窗可在卡片点击后异步出现。
 await waitStep(page,config);
 const candidate=editorOf(page);
 if(await candidate.count()===1&&containsComposerText(await candidate.innerText(),definition.prompt))await onDraft({editor:candidate,url,...await readComposerState(candidate),previousSelection,selection:await selectionState(page)});
 await guardDialogs(page,{cancelReload:true,stepInterval:config.stepInterval});
 if(page.url()!==url)throw blocked('场景选择期间页面切换，停止自动操作');
 const editor=editorOf(page);
 if(await editor.count()!==1)throw blocked('未识别到唯一的任务输入框');
 await page.waitForFunction(expected=>[...document.querySelectorAll('[contenteditable="true"]')].some(e=>e.innerText.includes(expected)),definition.prompt,{timeout:10000});
 await guardDialogs(page,{cancelReload:true,stepInterval:config.stepInterval});
 const {text,skills}=await readComposerState(editor);
 assert('场景真实自动填充原提示词',containsComposerText(text,definition.prompt),text);
 if(definition.skills.length)assert('场景自动选择指定技能',definition.skills.every(s=>skills.includes(s)),{expected:definition.skills,actual:skills});
 else log('此用例未配置预期 Skill','保留实际专家或团队选择，不计为 Skill 调用通过');
 try{assert('自动填充后运行按钮可用',await button(page,'运行任务').isEnabled());}catch(e){await guardDialogs(page,{cancelReload:true,stepInterval:config.stepInterval});throw e;}
 await capture('场景自动填充');log('场景自动填充已核对',definition.category+' → '+definition.button);
 return {editor,url,text,skills,previousSelection,selection:await selectionState(page)};
}
async function sessionStatus(page,sessionId){
 const states=await engineRequest(await readEngineConnection(page),'/session/status');
 return states[sessionId]?.type||'idle';
}
export async function waitScenario(page,sessionId,config,{timeoutMs,capture,log}){
 const deadline=Date.now()+timeoutMs;let lastLog=0;
 while(Date.now()<deadline){
  if(!page.url().endsWith('/session/'+sessionId))throw blocked('页面已离开本次会话，停止自动操作；未给另一会话回答或审批');
  // 配置重载必须先识别；普通问题和审批交给既有处理器。
  const body=await page.locator('body').innerText();
  if(body.includes('立即终止并生效'))throw blocked('引擎等待重载；未终止运行中的会话');
  try{if(await handleConfiguredDialog(page,config,capture,log))continue;}catch(e){throw blocked(e.message);}
  await guardDialogs(page);
  if(/等待确认/.test(body)&&await button(page,'发送').count())throw blocked('出现未识别的待回答问题，保留现场');
  if(await page.getByText('执行失败',{exact:true}).filter({visible:true}).count())throw Error('客户端显示执行失败');
  if(!await button(page,'停止').count()){
   const status=await sessionStatus(page,sessionId);
   if(status==='idle'){
    const data=await readSessionLogFromPage(page,sessionId),last=data.messages.at(-1);
    if(last?.info?.error)throw Error('引擎会话错误：'+JSON.stringify(last.info.error));
    const complete=last?.info?.role==='assistant'&&last.info.time?.completed&&last.info.finish&&last.info.finish!=='tool-calls'&&!(last.parts||[]).some(p=>p.type==='tool');
    if(finalAssistantText(data).trim()&&(complete||await page.getByText('执行成功',{exact:true}).filter({visible:true}).count()))return data;
   }
  }
  if(Date.now()-lastLog>30000){log('等待本次会话完成',sessionId);lastLog=Date.now();}
  await page.waitForTimeout(1000);
 }
 throw blocked('等待会话超时；保留任务与证据，可在控制台强制停止本次会话');
}

export async function runScenarioCase(number,inputConfig){
 const definition=getClientCase(number),args=process.argv.slice(2);
 if(number<3)throw Error('第1、2条沿用原有独立脚本');
 if(args.includes('--help')){console.log(definition.id+'：默认完整执行；--check只读预检；--fill-check核对自动填充和材料后清理本次草稿，不发送；--resume=ses_ID只续跑指定当前会话');return;}
 const invalid=args.some(a=>!['--check','--fill-check'].includes(a)&&!/^--resume=ses_[A-Za-z0-9]+$/.test(a));
 const resumeId=args.find(a=>a.startsWith('--resume='))?.slice(9),checkOnly=args.includes('--check'),fillOnly=args.includes('--fill-check');
 if(invalid||[Boolean(resumeId),checkOnly,fillOnly].filter(Boolean).length>1)throw Error('参数无效或互斥，请使用 --help');
 const config=normalizeConfig(inputConfig||{cdpPort:process.env.MW_CDP_PORT||9223}),safeConfig=structuredClone(config);delete safeConfig.provider.key;
 if(await dispatchStandalone({number,args,config}))return;
 const started=new Date(),dir=await createRunDirectory(path.join(projectRoot,'runs'),definition.label+(checkOnly?'预检':fillOnly?'填充检查':''),started);
 const checks=[],events=[],outputs=[];let browser,page,sessionId=resumeId,result='BLOCKED',errorText='',owned,submitted=false,environment;
 const log=(step,detail='')=>{const now=new Date();events.push({time:now.toISOString(),step,detail});console.log('['+beijingLogTime(now)+'] '+step+' '+detail);};
 const taskControl=createTaskControl({log});
 const recorder=createEvidenceRecorder(dir,log),captureRaw=async step=>{
  if(sessionId&&page&&!page.url().endsWith('/session/'+sessionId))throw blocked('截图或弹窗操作前页面已离开本次会话');
  return recorder.capture(page,step);
 };
 const capture=step=>taskControl?taskControl.withUI(page,'EVIDENCE',()=>captureRaw(step)):captureRaw(step);
 const assert=(name,pass,actual)=>{checks.push({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});if(!pass)throw Error('断言失败：'+name);};
 const outputDir=path.join(dir,'产物');
 const scope='真实场景自动填充＋内嵌文字发送＋Session最终助手回复'+(expectedArtifacts[number]?'＋独立目录真实产物验证':'')+(number===6?'；未在远程运行CI、未部署或发布':number===15?'；自动检查报告结构与官方来源域名，价格及逐项事实仍需审查':'')+'；使用启用CDP的本地修改配置';
 await fs.writeFile(path.join(dir,'运行配置.json'),JSON.stringify(safeConfig,null,2));
 try{
  if(config.provider.url||config.provider.model)throw blocked('请先保存新模型到MobileWork，再读取选择；不能仅传模型草稿执行');
  const timeoutMs=Number(process.env.MW_CASE_TIMEOUT_MS||definition.timeoutMs);
  if(!Number.isFinite(timeoutMs)||timeoutMs<1000)throw blocked('超时参数无效');
  const build=JSON.parse(await fs.readFile(testEnvironment.buildInfoPath,'utf8'));
  environment={version:build.version,productVersion:build.productVersion,packagedCdpAllowed:build.packagedCdpAllowed,port:config.cdpPort,timezone:'Asia/Shanghai'};
  await fs.writeFile(path.join(dir,'环境.json'),JSON.stringify(environment,null,2));
  if(build.packagedCdpAllowed!==true)throw blocked('packagedCdpAllowed尚未启用，请在控制台启用并正常重启客户端');
  const endpoint='http://127.0.0.1:'+config.cdpPort;
  const list=await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw blocked('CDP列表不可读');return r.json();});
  if(list.filter(p=>p.type==='page'&&isClientPageUrl(p.url)).length!==1)throw blocked('CDP列表未发现唯一的MobileWork主界面');
  browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
  const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
  if(pages.length!==1)throw blocked('MobileWork主界面数量不是1');
  page=pages[0];page.setDefaultTimeout(10000);if(taskControl)await taskControl.begin(page,{openComposer:!resumeId&&!checkOnly,stepInterval:config.stepInterval});await capture('连接客户端');
  if(checkOnly){await ensureIdleComposer(page);result='CHECKED';log('只读预检通过','未点击场景，未发送会话');}
  else{
   if(resumeId){
    if(!page.url().endsWith('/session/'+resumeId))throw blocked('续跑ID与当前页面会话不一致');
    const prior=await readSessionLogFromPage(page,resumeId);
    const userText=prior.messages.filter(m=>m.info?.role==='user').flatMap(m=>(m.parts||[]).filter(p=>p.type==='text').map(p=>p.text)).join('\n');
    // 只允许续跑本脚本创建的会话，并复用它自己的原输出目录。
    const match=userText.match(/本次独立输出目录 (.+?) 中新增/);
    if(!containsComposerText(userText,definition.prompt)||!containsComposerText(userText,clientCaseInput(number,{outputDir:match?.[1]||outputDir,asOfDate:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(started)})))throw blocked('续跑会话缺少本用例完整测试材料；不能把其他会话当作本次执行');
    if(expectedArtifacts[number])throw blocked('文件产物用例请通过默认入口新建执行；续跑不能重用其他运行目录的产物');
    log('续跑既有会话',sessionId);
   }else{
    owned=await fillScenario(page,definition,config,{capture,log,assert,onDraft:async value=>{owned=value;await taskControl?.checkpointDraft(owned);}});
    await fs.mkdir(outputDir);
    const input=clientCaseInput(number,{outputDir,asOfDate:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(started)});
    await fs.writeFile(path.join(dir,'内嵌测试材料.txt'),input);
    const after=await appendComposerText(owned.editor,input,{stepInterval:config.stepInterval,onDraft:async value=>{owned={...owned,...value};await taskControl?.checkpointDraft(owned);}});owned={...owned,...after};
    assert('完整材料追加且保留原提示词和技能',containsComposerText(after.text,input)&&containsComposerText(after.text,definition.prompt)&&definition.skills.every(s=>after.skills.includes(s)));
    await capture('完整测试材料');
    if(fillOnly){
     if(!await clearOwnedDraft(page,owned,{stepInterval:config.stepInterval}))throw blocked('填充检查结束时草稿已变化，保留现场');
     owned=null;result='CHECKED';log('自动填充与材料检查通过','已清理本次草稿；没有发送任务');
    }else{
     await waitStep(page,config);await guardDialogs(page);
     if(page.url()!==owned.url||(await readComposerState(owned.editor)).text!==owned.text)throw blocked('发送前页面或草稿已变化，停止发送');
     await taskControl?.markSubmitting();
     await button(page,'运行任务').click();submitted=true;
     sessionId=await waitCreatedSession(page,owned.url,{timeoutMs:Math.min(timeoutMs,180000),log});
     await taskControl?.registerSession(page,sessionId);
     assert('创建本次独立会话',Boolean(sessionId),sessionId);log('任务已发送',sessionId);await capture('发送成功');
     const receipt=await waitSentInput(page,sessionId,input),sent=receipt.data;
     await fs.writeFile(path.join(dir,'发送核对-session-log.json'),JSON.stringify(sent,null,2));
     environment.sessionDirectory=sent.session.directory;
     await fs.writeFile(path.join(dir,'环境.json'),JSON.stringify(environment,null,2));
     assert('Session返回本次默认任务空间的实际目录',path.isAbsolute(sent.session.directory||'')&&path.resolve(sent.session.directory).toLowerCase().startsWith(path.resolve(testEnvironment.taskRoot).toLowerCase()+path.sep),sent.session.directory);
     const users=sent.messages.filter(m=>m.info?.role==='user');
     assert('Session实际用户消息包含完整材料',receipt.complete);
     assert('Session未使用输入附件',!users.some(m=>(m.parts||[]).some(p=>p.type==='file')));
     log('完整发送已核对','agent='+String(users[0]?.info?.agent||'未返回'));
    }
   }
   if(!fillOnly){
    if(taskControl)await taskControl.submitted(page,sessionId);
    const data=taskControl?await taskControl.wait(page,config,{timeoutMs,capture,log}):await waitScenario(page,sessionId,config,{timeoutMs,capture,log});
    assert('本次会话完成且返回最终助手文本',Boolean(finalAssistantText(data).trim()));
    await fs.writeFile(path.join(dir,sessionId+'-session-log.json'),JSON.stringify(data,null,2));
    const output=finalAssistantText(data);await fs.writeFile(path.join(dir,'助手最终回复.txt'),output);
    checks.push(...textChecks(number,output));
    if(number===12)checks.push({name:'回复说明海报视觉设计',pass:/构图|主视觉|布局|视觉/.test(output)&&/配色|色彩|颜色|色调|#[0-9a-f]{3,8}/i.test(output)&&/排版|字号|字体|层级|标题/.test(output)});
    try{checks.push(...await fileChecks(number,outputDir));}catch(e){checks.push({name:'真实产物内容可解析',pass:false,actual:e.message});}
    for(const name of expectedArtifacts[number]||[]){try{await readArtifact(outputDir,name,{binary:true,maxBytes:80000000});outputs.push({name,path:'产物/'+name});}catch{}}
    if([11,12,14].includes(number)&&outputs.length===(expectedArtifacts[number]||[]).length)checks.push(...await previewChecks(number,outputDir,(preview,step)=>recorder.capture(preview,step)));
    await capture('执行完成');
    result=checks.every(c=>c.pass)?(resumeId?'RESUMED':'PASS'):'FAIL';
    if(result==='FAIL')errorText='内容或真实产物断言失败，请查看逐项结果';
    log(result==='FAIL'?'内容或产物检查失败':'内容与产物检查完成',checks.filter(c=>c.pass).length+'/'+checks.length+'项断言；最终结论还需核验 Skill 调用');
   }
  }
 }catch(e){
  errorText=e.message;result=e.blocked||(!sessionId&&!checks.some(c=>!c.pass))?'BLOCKED':'FAIL';log(result,errorText);
  if(page)await capture('异常现场').catch(e=>log('异常截图未完成',e.message));
  if(!submitted&&owned&&await clearOwnedDraft(page,owned,{stepInterval:config.stepInterval}).catch(()=>false))log('已清理本次未发送草稿','原有用户草稿不会进入本步骤');
 }finally{
  const trace=page&&sessionId?await saveRunTrace({page,sessionId,number,dir,checks,log,...(taskControl?.connection?{readLog:children=>taskControl.readLog(children)}:{})}):null;
  if(['PASS','RESUMED'].includes(result)&&checks.some(c=>!c.pass)){result='FAIL';errorText='Skill 实际调用或 Trace 证据断言失败，请查看 Trace 记录';log('用例失败',errorText);}
  else if(['PASS','RESUMED'].includes(result))log('用例通过',checks.filter(c=>c.pass).length+'/'+checks.length+'项断言，已包含 Skill 调用核验');
  const summary={result,caseId:definition.id,sheet:caseSheet,workbook:caseWorkbook,row:definition.row,title:definition.title,note:definition.note,mode:checkOnly?'只读预检':fillOnly?'填充检查（未发送）':resumeId?'续跑':'完整执行',startedAt:started.toISOString(),endedAt:new Date().toISOString(),sessionId,environment,runConfig:safeConfig,checks,events,evidence:recorder.evidence,outputs,trace,error:errorText,scope};
  await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(dir,'执行日志.txt'),events.map(e=>e.time+' '+e.step+' '+e.detail).join('\n')+'\n');
  const lines=['# '+definition.id+' 执行报告','','- 用例：'+definition.title,'- 原表：'+caseSheet+'，第'+definition.row+'行','- 执行模式：'+summary.mode,'- 结果：'+result,'- 开始：'+summary.startedAt,'- 结束：'+summary.endedAt,'- Session：'+(sessionId||'未创建'),'- 范围：'+scope,'- 原表差异：'+(definition.note||'无'),'- 错误或阻塞：'+(errorText||'无'),'','## 断言','',...checks.map(c=>'- '+(c.pass?'通过':'**失败**')+'：'+c.name),'','## 真实产物','',...outputs.map(o=>'- ['+o.name+']('+o.path+')'),'','## 执行过程','',...events.map(e=>'- '+e.time+' '+e.step+' '+e.detail),'','## 过程截图','',...recorder.evidence.flatMap(e=>['### '+e.step,'','!['+e.step+']('+e.screenshot+')',''])];
  if(trace)lines.push('','## Trace 记录','','- 调用证据：[trace.json](trace.json)','- 核验规则：'+trace.ruleVersion);
  await fs.writeFile(path.join(dir,'执行报告.md'),lines.join('\n')+'\n');
  await taskControl?.close(page).catch(e=>log('交还页面操作未完成',e.message));
  await browser?.close().catch(()=>{});
  console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=['PASS','RESUMED','CHECKED'].includes(result)?0:result==='BLOCKED'?2:1;
 }
}
