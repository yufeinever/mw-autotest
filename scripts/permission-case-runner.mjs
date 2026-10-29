import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {getPermissionCase} from './permission-case-catalog.mjs';
import {preparePermissionFixtures,permissionPrompt} from './permission-fixtures.mjs';
import {createPermissionInteractionHandler,observePermissionResult,PermissionRunAudit} from './permission-observation.mjs';
import {readPermissionWorkspace,assertPermissionSessionDirectory,assertPermissionTaskDirectory} from './permission-workspace.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
import {createRunDirectory,createEvidenceRecorder,beijingLogTime} from './mobilework-evidence.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';
import {editorOf,snapshotDraft,clearOwnedDraft,resetComposerPermission} from './mobilework-isolation.mjs';
import {appendComposerText,readComposerState} from './mobilework-composer.mjs';
import {selectModel,waitStep} from './mobilework-run-policy.mjs';
import {waitCreatedSession,guardDialogs} from './client-case-runner.mjs';
import {testEnvironment} from '../local-console/environment.mjs';
import {uniqueClientPage} from '../local-console/client-page.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function runPermissionCase(number){
 const definition=getPermissionCase(number),args=process.argv.slice(2),config=normalizeConfig(JSON.parse(process.env.MW_TEST_CONFIG_JSON||'{}'));
 const startedAt=new Date().toISOString(),dir=await createRunDirectory(path.join(root,'runs'),'权限-'+definition.id+'-'+definition.title);
 const events=[],interactions=[],recorder=createEvidenceRecorder(dir),control=createTaskControl({log});
 let browser,page,sessionId,workspace,owned,fixtures,data,observation,audit,result='BLOCKED',error='',completed=false,phase='准备环境',promptRoute,preparedDirectory,dispatched=false,preparing=false,preparationTimer;
 const deadline=Date.parse(startedAt)+definition.timeoutMs;
 const remaining=()=>{const ms=deadline-Date.now();if(ms<=0)throw blocked('本条权限用例已达到180秒等待上限，交由调度器确认本会话收尾');return ms;};
 function log(step,detail=''){events.push({time:new Date().toISOString(),step,detail});console.log('['+beijingLogTime()+'] '+step+' '+detail);}
 const capture=async step=>{if(page)return control?.sessionId?control.withUI(page,'EVIDENCE',()=>recorder.capture(page,step)):recorder.capture(page,step);};
 try{
  if(args.some(a=>!['--check','--fill-check'].includes(a))||args.length>1)throw blocked('权限用例仅支持单个预检参数，不支持续跑');
  if(definition.unavailable)throw blocked(definition.unavailable);
  if(!control)throw blocked('请从控制台调度执行权限用例，不绕过统一调度');
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+config.cdpPort,{timeout:10000});page=uniqueClientPage(browser);page.setDefaultTimeout(8000);
  await control.begin(page,{openComposer:!args.includes('--check'),stepInterval:config.stepInterval,model:config.model});
  workspace=await readPermissionWorkspace(page,{allowedRoot:testEnvironment.taskRoot});
  log('工作空间已核对',workspace.name+'；'+workspace.directory+'；沿用输入区选择，不按名称强制切换');
  await capture('工作空间与准备状态');
  if(args.includes('--check')){result='CHECKED';log('只读预检完成','未写入材料或发送消息');return;}
  await resetComposerPermission(page,config);
  if(config.model)await selectModel(page,config.model,{stepInterval:config.stepInterval});
  const input=definition.task+'\n本次材料标识：'+definition.id+'-'+path.basename(dir)+'。';
  await fs.writeFile(path.join(dir,'任务输入模板.txt'),input);
  const editor=editorOf(page);owned=await snapshotDraft(page,editor);
  const filled=await appendComposerText(editor,input,{...config,onDraft:async patch=>{owned={...owned,...patch};await control.checkpointDraft({...owned,editor:undefined});}});owned={...owned,...filled};
  await capture('任务准备输入');
  if(args.includes('--fill-check')){
   if(!await clearOwnedDraft(page,owned,config))throw blocked('预检草稿已变化，保留未知内容');owned=null;result='CHECKED';log('输入模板检查完成','未创建Session或材料，未发送模型请求；实际材料只在产品准备好任务目录后生成');return;
  }
  // Keep the product's own task creation, Session permissions and model
  // preparation. Pause only OUR first prompt at the public HTTP boundary,
  // seed files in its actual directory, and substitute only our text part.
  let failedPreparation,prepared;const preparationFailure=new Promise(resolve=>{failedPreparation=resolve;});
  const preparationReady=new Promise(resolve=>{prepared=resolve;});
  promptRoute=/\/session\/ses_[A-Za-z0-9]+\/(?:prompt_async|message)(?:\?|$)/;
  await page.route(promptRoute,async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()!=='POST'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return route.continue();
   let body;try{body=request.postDataJSON();}catch{return route.continue();}
   const matched=(body?.parts||[]).filter(p=>p.type==='text'&&typeof p.text==='string'&&p.text.includes(input));
   if(matched.length!==1)return route.continue();
   try{
    if(preparing||dispatched)throw blocked('本次任务重复提交，未重复放行模型请求');preparing=true;
    phase='准备真实任务材料';
    const id=url.pathname.match(/\/session\/(ses_[A-Za-z0-9]+)\//)?.[1],connection=await readEngineConnection(page);
    const session=await engineRequest(connection,'/session/'+id);
    if(session.id!==id)throw blocked('首个任务请求的Session归属不一致');
    // This request contains our unique input and comes from the product's own
    // Session creation. Persist that ownership BEFORE fixture preparation so
    // even a preparation error can be stopped by the existing scheduler.
    const sessionUrl=new URL(page.url());
    if(sessionUrl.hash!=='#/workspace/'+workspace.id&&!sessionUrl.hash.startsWith('#/workspace/'+workspace.id+'/'))throw blocked('产品页面的工作空间路由与已选空间不一致');
    sessionUrl.hash='/workspace/'+workspace.id+'/session/'+id;
    sessionId=id;control.sessionId=id;control.sessionUrl=sessionUrl.href;
    await control.call('checkpoint',{sessionId:id,sessionUrl:sessionUrl.href});
    preparedDirectory=await assertPermissionTaskDirectory(workspace.directory,session.directory);
    fixtures=await preparePermissionFixtures({directory:preparedDirectory,allowedRoot:testEnvironment.taskRoot,runDir:dir,kind:definition.fixture});
    const effective=permissionPrompt(definition,fixtures);
    matched[0].text=matched[0].text.replace(input,effective);
    await fs.writeFile(path.join(dir,'测试输入.txt'),effective);
    await fs.writeFile(path.join(dir,'夹具清单.json'),JSON.stringify({workspace,sessionId:id,directory:preparedDirectory,inside:fixtures.inside,outside:fixtures.outside,files:fixtures.files,before:fixtures.before,source:'产品创建真实任务目录后、首个模型请求发送前准备的隔离副本；仅替换本次文本中的材料路径，不改权限、模型或工具配置'},null,2));
    log('真实任务材料已准备',preparedDirectory+'；'+definition.fixture+'；仅本场景材料，初始哈希已保存');
    audit=new PermissionRunAudit({connection,directory:preparedDirectory});audit.bind(id);
    log('模型请求前权限观察',await audit.start()?'已订阅':'暂不可用，无问询结论将保留待复核');
    const since=audit.checkpoint();try{audit.seed(await engineRequest(connection,'/permission?directory='+encodeURIComponent(preparedDirectory)),since);}catch{}
    await route.continue({postData:JSON.stringify(body)});dispatched=true;prepared();phase='创建会话';
   }catch(e){await route.abort('failed').catch(()=>{});failedPreparation(e);}
  });
  const current=await readPermissionWorkspace(page,{allowedRoot:testEnvironment.taskRoot});
  if(current.id!==workspace.id||current.directory!==workspace.directory)throw blocked('准备期间工作空间发生变化，未发送任务');
  if((await readComposerState(editor)).text!==owned.text)throw blocked('发送前输入发生变化，未发送任务');
  phase='创建会话';await guardDialogs(page);await control.markSubmitting();await waitStep(page,config);
  const sourceUrl=page.url();await page.getByRole('button',{name:'运行任务',exact:true}).filter({visible:true}).click();owned=null;
  const createdId=await Promise.race([waitCreatedSession(page,sourceUrl,{timeoutMs:remaining(),log}),preparationFailure.then(e=>{throw e;})]);
  if(sessionId&&sessionId!==createdId)throw blocked('页面会话与实际首个模型请求不一致');
  sessionId=createdId;await control.registerSession(page,sessionId);
  await Promise.race([preparationReady,preparationFailure.then(e=>{throw e;}),new Promise((_,reject)=>{preparationTimer=setTimeout(()=>reject(blocked('未捕获本次首个模型请求，无法核验材料准备；已保留Session由调度器收尾')),Math.min(15000,remaining()));})]);clearTimeout(preparationTimer);
  await control.submitted(page,sessionId);
  if(!fixtures||!dispatched)throw blocked('未观察到支持的本次首个模型请求，不能证明材料在执行前准备就绪');
  await assertPermissionSessionDirectory(preparedDirectory,control.directory);
  log('正式任务已发送',sessionId+'；一次消息，无初始化闲聊轮次');phase='观察执行';
  data=await control.wait(page,{...config,approval:'reject'},{timeoutMs:remaining(),capture,log,
   interactionHandler:createPermissionInteractionHandler({capture:step=>recorder.capture(page,step),log,fixtures,interactions}),
   onQuestion:targets=>{for(const target of targets)interactions.push({time:new Date().toISOString(),kind:'question',requestId:target.id});}
  });completed=true;data=await control.readLog(true);phase='判断结果';
  const auditEvents=audit?.records()||[],unanswered=auditEvents.filter(e=>e.type==='permission.asked'&&!interactions.some(i=>i.requestId===e.requestId));
  observation=observePermissionResult({definition,fixtures,after:await fixtures.snapshot(),log:data,interactions,completed,transportComplete:Boolean(audit?.healthy&&audit.baselined&&!unanswered.length)});
  result=observation.result;log('四项行为记录',[observation.trigger,observation.permission,observation.execution,observation.sessionProgress].join('；'));log('行为观察完成',observation.behavior+'；'+observation.reason);await capture('实际行为与会话结果');
 }catch(e){error=phase+'：'+e.message;result=e.blocked||phase!=='判断结果'?'BLOCKED':'REVIEW';log(result,error);if(page)await capture('本次中断现场').catch(()=>{});}
 finally{
  clearTimeout(preparationTimer);const auditEvents=audit?.records()||[];audit?.stop();if(page&&promptRoute)await page.unroute(promptRoute).catch(()=>{});
  if(!data&&control?.connection&&sessionId)try{data=await control.readLog(true);}catch{}
  if(fixtures&&!observation)try{observation=observePermissionResult({definition,fixtures,after:await fixtures.snapshot(),log:data,interactions,transportComplete:false,completed});if(observation.result==='FAIL')result='FAIL';}catch{}
  if(owned&&page)await clearOwnedDraft(page,owned,config).catch(()=>{});
  await fixtures?.close().catch(()=>{});
  if(data)await fs.writeFile(path.join(dir,'会话日志.json'),JSON.stringify(data,null,2));
  const summary={result,suite:'permission',designVersion:'0.0.2',actualApproval:'reject',caseId:definition.id,title:definition.title,startedAt,endedAt:new Date().toISOString(),sessionId,checks:[],events,evidence:recorder.evidence,outputs:[{name:'观察数据',path:'权限观察.json'},...(fixtures?[{name:'准备材料清单',path:'夹具清单.json'},{name:'实际测试输入',path:'测试输入.txt'}]:[])],observation,interactions,error,phase,scope:'一次自然操作请求，分别观察目标触发、权限处置、操作效果及后续执行；不要求固定回复、Skill或工具路线。仅覆盖本次分支，不代替完整规范验收。',mode:args[0]||'权限行为观察',preparation:fixtures?{workspace,inside:fixtures.inside,outside:fixtures.outside,actualSessionDirectory:data?.session?.directory}:null};
  await fs.writeFile(path.join(dir,'权限观察.json'),JSON.stringify({observation,interactions,auditEvents},null,2));
  await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(dir,'执行报告.md'),['# '+definition.id+' '+definition.title,'','- 结果：'+result,'- 行为：'+(observation?.behavior||'未进入正式观察'),'- 说明：'+(error||observation?.reason||'预检'),'','## 执行记录','',...events.map(e=>'- '+e.time+' '+e.step+' '+e.detail),'','## 证据','',...recorder.evidence.map(e=>'!['+e.step+']('+e.screenshot+')')].join('\n'));
  await control?.close(page).catch(()=>{});await browser?.close().catch(()=>{});
  console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=['PASS','REVIEW','CHECKED'].includes(result)?0:result==='BLOCKED'?2:1;
 }
}
