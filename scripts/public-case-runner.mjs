import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectClient} from '../local-console/client-connection.mjs';
import {isClientPageUrl} from '../local-console/client-page.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';
import {readEnvironment} from '../local-console/environment.mjs';
import {readSessionLogFromPage} from '../local-console/session-log.mjs';
import {getPublicCase} from './public-case-catalog.mjs';
import {publicCaseInput} from './public-case-inputs.mjs';
import {publicArtifacts,publicTextChecks,publicFileChecks} from './public-case-checks.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';
import {dispatchStandalone} from './mobilework-standalone.mjs';
import {waitStep} from './mobilework-run-policy.mjs';
import {editorOf,selectionState,resetComposerPermission,clearOwnedDraft,snapshotDraft,modalDialogs} from './mobilework-isolation.mjs';
import {readComposerState,appendComposerText,containsComposerText} from './mobilework-composer.mjs';
import {createRunDirectory,createEvidenceRecorder,beijingLogTime} from './mobilework-evidence.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const blocked=message=>Object.assign(Error(message),{blocked:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
async function noUnknownDialog(page){
 if(await button(page,'立即终止并生效').count())throw blocked('公众版预置配置等待引擎生效；请确认当前任务已结束后处理客户端重载提示，本轮未强制终止');
 if(await modalDialogs(page).count())throw blocked('公众版出现未支持弹框，保留现场：'+(await modalDialogs(page).first().innerText()).slice(0,300));
}
async function fillPublicScene(page,definition,config,{assert,capture,control,log,rememberDraft}){
 await noUnknownDialog(page);await resetComposerPermission(page,config);
 // Public Base UI popovers finish their exit animation after Escape resolves.
 // Only wait for the permission menu opened by this check, never dismiss unknown dialogs.
 await page.waitForFunction(()=>{
  const trigger=document.querySelector('button[aria-label="权限"]');
  const menus=[...document.querySelectorAll('[role="dialog"]')].filter(menu=>menu.getBoundingClientRect().height>0&&[...menu.querySelectorAll('button')].some(button=>button.innerText.trim()==='完全访问权限'));
  return trigger?.getAttribute('aria-expanded')==='false'&&menus.length===0;
 },undefined,{timeout:5000});
 await noUnknownDialog(page);
 // Public renders both the welcome panel and an offscreen draft copy.
 // Resolve the actual hit-tested scene panel instead of arbitrary first()/last().
 const panels=page.locator('[data-home-guide="scenes"]');
 const candidates=await panels.evaluateAll((panels,label)=>panels.map((panel,index)=>{
  const matches=[...panel.querySelectorAll('button')].filter(button=>button.innerText.trim()===label);
  if(matches.length!==1)return null;const button=matches[0],r=button.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
  return r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&hit&&button.contains(hit)?index:null;
 }).filter(index=>index!==null),definition.category);
 if(candidates.length!==1)throw blocked('公众版未找到唯一可交互分类“'+definition.category+'”，请核对当前客户端功能版本');
 const panel=panels.nth(candidates[0]),category=panel.getByRole('button',{name:definition.category,exact:true});
 await waitStep(page,config);await category.click();
 const escaped=definition.button.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const scene=panel.getByRole('button',{name:new RegExp('^\\s*'+escaped+'(?:\\s*未生效)?\\s*$')}).filter({visible:true});
 if(await scene.count()!==1)throw blocked('公众版没有唯一场景“'+definition.button+'”，不使用政企版入口替代');
 if(!await scene.isEnabled())throw blocked('公众版场景尚未生效：'+definition.button);
 const previousSelection=await selectionState(page);await waitStep(page,config);await scene.click();
 const editor=editorOf(page);await editor.waitFor({timeout:10000});
 try{await page.waitForFunction(([element,prompt])=>element.innerText.includes(prompt),[await editor.elementHandle(),definition.prompt],{timeout:10000});}
 catch(error){await noUnknownDialog(page);throw blocked('场景预填与当前版本不一致或未完成，请检查“'+definition.button+'”预填内容；未发送任务');}
 const owned={...await snapshotDraft(page,editor),editor,previousSelection};await control.checkpointDraft(owned);rememberDraft(owned);
 await noUnknownDialog(page);assert('公众版场景真实自动填充',containsComposerText(owned.text,definition.prompt),{expected:definition.prompt,actual:owned.text});
 assert('公众版场景技能选择与实际预置一致',definition.skills.every(skill=>owned.skills.includes(skill)),{expected:definition.skills,actual:owned.skills});
 if(definition.expert)assert('架构图场景确实选择预期专家',owned.selection.some(selected=>selected.item==='expert'&&selected.exit==='退出「'+definition.expertLabel+'」'),{expected:definition.expertLabel,actual:owned.selection});
 assert('自动填充后可运行任务',await button(page,'运行任务').isEnabled());
 await capture('公众版场景自动填充');log('公众版场景已核对',definition.category+' → '+definition.button);return owned;
}
async function createdPublicSession(page,sourceUrl,log){
 const deadline=Date.now()+180000,workspace=sourceUrl.match(/\/workspace\/([^/]+)/)?.[1];let last=0;
 while(Date.now()<deadline){
  const url=page.url(),id=url.match(/\/session\/(ses_[A-Za-z0-9]+)(?:[/?#]|$)/)?.[1];if(id)return id;
  if(!isClientPageUrl(url)||workspace&&url.match(/\/workspace\/([^/]+)/)?.[1]!==workspace)throw blocked('准备期间已离开本轮公众版工作空间，不接管其他页面');
  const body=await page.locator('body').innerText();
  if(/工作区准备失败|消息未能发送|Workspace model runtime is unreachable/.test(body))throw blocked('公众版准备或发送失败；请查看客户端提示，未重复发送');
  await noUnknownDialog(page);
  if(Date.now()-last>20000){log('等待公众版创建Session',body.match(/第\s*\d+\s*步[^\n]*/)?.[0]||'等待实际Session，不重发');last=Date.now();}
  await page.waitForTimeout(400);
 }
 throw blocked('公众版创建Session超时，未重复发送；需核对客户端准备状态');
}
export async function runPublicCase(number,inputConfig){
 const definition=getPublicCase(number),args=process.argv.slice(2),checkOnly=args.includes('--check'),fillOnly=args.includes('--fill-check');
 if(args.includes('--help')){console.log(definition.id+'：默认完整执行；--check仅预检；--fill-check仅核对本版场景填充，未发送。暂不支持公众版续跑。');return;}
 if(args.some(a=>!['--check','--fill-check'].includes(a))||checkOnly&&fillOnly)throw Error('公众版参数无效，使用 --help 查看支持范围');
 if(await dispatchStandalone({number,entry:definition.entry,args,config:inputConfig}))return;
 const config=normalizeConfig(inputConfig),safeConfig=structuredClone(config);delete safeConfig.provider.key;
 const started=new Date(),dir=await createRunDirectory(path.join(root,'runs'),definition.label,started),recorder=createEvidenceRecorder(dir),checks=[],events=[],outputs=[],warnings=[];
 let browser,page,owned,sessionId,submitted=false,result='BLOCKED',error='',trace,environment={},actualOutput;
 const log=(step,detail='')=>{events.push({time:new Date().toISOString(),step,detail});console.log('['+beijingLogTime()+'] '+step+' '+detail);};
 const control=createTaskControl({log}),marker=definition.id+'-'+path.basename(dir),relativeOutput='mw-public-'+String(number).padStart(3,'0')+'-'+started.getTime();
 const input=publicCaseInput(number,{relativeOutput,marker});
 const assert=(name,pass,actual)=>{checks.push({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});if(!pass)throw Error('断言失败：'+name);};
 const capture=async step=>control.withUI(page,'EVIDENCE',async()=>{
  try{return await recorder.capture(page,step);}catch(e){if(!/screenshot|截图|captureScreenshot/i.test(e.message))throw e;warnings.push('截图未完成：'+step+'；'+e.message);log('证据采集异常',warnings.at(-1));return null;}
 });
 await fs.writeFile(path.join(dir,'运行配置.json'),JSON.stringify(safeConfig,null,2));
 await fs.writeFile(path.join(dir,'测试材料.txt'),input);
 try{
  if(!control)throw blocked('公众版业务执行必须接入18888统一调度，未绕过执行');
  if(config.clientEdition!=='public')throw blocked('此入口仅适用于公众版，请在顶部选择公众版');
  if(config.provider.url||config.provider.model)throw blocked('请先在客户端保存模型，再从控制台选择，不能使用未生效模型草稿');
  const build=JSON.parse(await fs.readFile(readEnvironment('public').buildInfoPath,'utf8'));
  environment={clientEdition:'public',version:build.version,productVersion:build.productVersion,cdpPort:config.cdpPort};
  if(build.packagedCdpAllowed!==true)throw blocked('公众版CDP配置未启用，请先启用并正常重启客户端');
  browser=await connectClient('http://127.0.0.1:'+config.cdpPort,{timeout:15000,clientEdition:'public'});
  const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));if(pages.length!==1)throw blocked('公众版主页面不唯一');
  page=pages[0];page.setDefaultTimeout(10000);
  await control.begin(page,{openComposer:!checkOnly,stepInterval:config.stepInterval,model:config.model});await capture('连接公众版');
  if(checkOnly){await noUnknownDialog(page);result='CHECKED';log('仅预检','未选择场景或发送业务');}
  else{
   owned=await fillPublicScene(page,definition,config,{assert,capture,control,log,rememberDraft:draft=>{owned=draft;}});
   const after=await appendComposerText(owned.editor,input,{stepInterval:config.stepInterval,onDraft:async value=>{owned={...owned,...value};await control.checkpointDraft(owned);}});owned={...owned,...after};
   assert('保留预填且追加完整本轮材料',containsComposerText(owned.text,definition.prompt)&&containsComposerText(owned.text,input)&&definition.skills.every(skill=>owned.skills.includes(skill)));
   await capture('公众版完整测试材料');
   if(fillOnly){if(!await clearOwnedDraft(page,owned,config))throw blocked('填充后草稿变化，未清理未知内容');owned=null;result='CHECKED';}
   else{
    await noUnknownDialog(page);const current=await readComposerState(owned.editor);
    if(page.url()!==owned.url||current.text!==owned.text)throw blocked('发送前页面或草稿变化，未发送');
    await control.markSubmitting();await waitStep(page,config);await button(page,'运行任务').click();submitted=true;
    sessionId=await createdPublicSession(page,owned.url,log);await control.registerSession(page,sessionId);
    // Session metadata precedes public workspace engine handoff. Confirm the
    // real user message through fresh engineInfo before freezing its runtime.
    let received;const receiptDeadline=Date.now()+120000;let receiptLogged=0;
    do{
     if(!page.url().endsWith('/session/'+sessionId))throw blocked('发送核对期间已离开本轮公众版Session，未重发');
     received=await readSessionLogFromPage(page,sessionId);
     if(received.messages.some(m=>m.info?.role==='user'&&containsComposerText((m.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join(''),input)))break;
     if(Date.now()-receiptLogged>15000){log('等待公众版发送落地','已创建Session，等待新工作区引擎的真实用户消息；不重复发送');receiptLogged=Date.now();}
     await page.waitForTimeout(500);
    }while(Date.now()<receiptDeadline);
    if(!received.messages.some(m=>m.info?.role==='user'&&containsComposerText((m.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join(''),input)))throw blocked('公众版Session已建立，但120秒内未核对到完整用户消息；不能判定业务失败，未重发');
    assert('本轮Session实际接收完整材料',true);await control.submitted(page,sessionId);
    const directory=received.session?.directory;
    assert('采用本Session真实目录且与引擎登记一致',typeof directory==='string'&&path.isAbsolute(directory)&&path.resolve(directory)===path.resolve(control.directory),{actual:directory,registered:control.directory});
    environment.sessionDirectory=directory;actualOutput=path.join(directory,relativeOutput);environment.outputDirectory=actualOutput;
    await fs.writeFile(path.join(dir,'环境.json'),JSON.stringify(environment,null,2));await capture('公众版发送成功');
    const data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log});
    const final=data.messages.filter(m=>m.info?.role==='assistant'&&m.info?.time?.completed).at(-1);
    const text=(final?.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
    await fs.writeFile(path.join(dir,'助手最终回复.txt'),text);checks.push(...publicTextChecks(number,text));
    if(publicArtifacts[number]){
     const artifacts=await publicFileChecks(number,actualOutput);checks.push(...artifacts.checks);
     for(const artifact of artifacts.outputs){const rel=path.join('产物',artifact.name);await fs.mkdir(path.dirname(path.join(dir,rel)),{recursive:true});await fs.copyFile(artifact.source,path.join(dir,rel));outputs.push({...artifact,path:rel});}
    }
    await capture('公众版执行完成');result='PASS';
   }
  }
 }catch(e){error=e.message;result=e.blocked||/MessageAbortedError/.test(error)?'BLOCKED':'FAIL';
  if(page&&/MessageAbortedError/.test(error)){
   const visible=await page.locator('body').innerText({timeout:3000}).catch(()=>'');
   if(visible.includes('MW103032001')&&visible.includes('请求模型服务 180 秒内未得到响应'))error='客户端提示请求模型服务180秒内未得到响应（MW103032001）；'+error;
  }
  log(result,error);if(page)await capture('公众版异常现场').catch(e=>log('异常现场未采集',e.message));if(!submitted&&owned&&page)await clearOwnedDraft(page,owned,config).catch(()=>false);}
 finally{
  if(page&&sessionId){trace=await saveRunTrace({page,sessionId,definition,dir,checks,log,...(control?.connection?{readLog:children=>control.readLog(children)}:{})});}
  if(result==='PASS'){
   const failed=checks.filter(c=>c.pass===false&&!c.review),pending=checks.filter(c=>c.review||c.pass==null);
   if(failed.length){result='FAIL';error=failed.map(c=>c.name).join('；');}
   else if(pending.length||warnings.length){result='REVIEW';error=[...pending.map(c=>c.name),...warnings].join('；');}
  }
  try{await control?.close(page);}catch(e){warnings.push('调度交接未完成：'+e.message);if(['PASS','REVIEW','CHECKED'].includes(result)){result='BLOCKED';error=warnings.at(-1);}}
  await browser?.close().catch(()=>{});
  const summary={result,caseId:definition.id,title:definition.title,sourceCaseId:definition.sourceCaseId,clientEdition:'public',requirement:definition.requirement,requirementLink:definition.requirementLink,startedAt:started.toISOString(),endedAt:new Date().toISOString(),sessionId,runConfig:safeConfig,environment,mode:checkOnly?'只读预检':fillOnly?'填充检查（未发送）':'完整执行',checks,events,evidence:recorder.evidence,outputs,trace,warnings,error,scope:definition.expected+' 公众版独立材料及判定；不代表完整产品需求验收，正文检查不强求固定措辞，产物检查以本轮真实文件为准。'};
  await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(dir,'执行日志.txt'),events.map(e=>'['+beijingLogTime(new Date(e.time))+'] '+e.step+' '+e.detail).join('\n')+'\n');
  const lines=['# '+definition.id+' 公众版执行报告','','- 用例：'+definition.title,'- 结果：'+result,'- 业务来源：'+definition.sourceCaseId+'（仅继承目标，非复用脚本）','- Session：'+(sessionId||'未创建'),'- 实际任务目录：'+(environment.sessionDirectory||'未取得'),'- 执行模式：'+summary.mode,'- 错误：'+(error||'无'),'- 范围：'+summary.scope,'','## 本轮检查','',...checks.map(c=>'- '+(c.review||c.pass==null?'**待复核**':c.pass?'通过':'**不符合**')+'：'+c.name+(c.actual===undefined?'':'；实际：'+JSON.stringify(c.actual))),'','## 证据缺口','',...warnings.map(w=>'- '+w),'','## 真实产物','',...outputs.map(o=>'- ['+o.name+']('+o.path.replaceAll('\\','/')+')'),'','## 执行过程','',...events.map(e=>'- ['+beijingLogTime(new Date(e.time))+'] '+e.step+' '+e.detail),'','## 关键截图','',...recorder.evidence.flatMap(e=>['### '+e.step,'','!['+e.step+']('+e.screenshot+')',''])];
  if(trace)lines.push('','## Trace','','[本Session调用证据](trace.json)');
  await fs.writeFile(path.join(dir,'执行报告.md'),lines.join('\n')+'\n');console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=['PASS','CHECKED'].includes(result)?0:result==='BLOCKED'?2:1;
 }
}
