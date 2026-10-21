import fs from 'node:fs/promises';
import {beijingLogTime} from './mobilework-evidence.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {readRunConfig,selectModel,waitStep} from './mobilework-run-policy.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';
import {finalAssistantText,waitScenario,waitSentInput,waitCreatedSession} from './client-case-runner.mjs';
import {appendComposerText,containsComposerText} from './mobilework-composer.mjs';
import {snapshotDraft,clearOwnedDraft,resetComposerPermission} from './mobilework-isolation.mjs';
import {dispatchStandalone} from './mobilework-standalone.mjs';
import {scheduleText} from './client-case-inputs.mjs';
import {textChecks} from './client-case-checks.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';
import {testEnvironment} from '../local-console/environment.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';
const runConfig=readRunConfig()||normalizeConfig();
const safeConfig=structuredClone(runConfig);delete safeConfig.provider.key;
if(runConfig?.provider?.url||runConfig?.provider?.model)throw Error('新模型配置尚未接入客户端；请先在客户端配置模型后从控制台读取选择，避免静默使用旧模型');

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('node scripts/run-client-case001.mjs [--check | --resume=ses_ID]：默认完整执行；--check只读预检；--resume仅续跑指定当前会话');process.exit(0);}
if(args.some(a=>a!=='--check'&&!/^--resume=ses_[A-Za-z0-9]+$/.test(a)))throw Error('未知参数');
const resumeId=args.find(a=>a.startsWith('--resume='))?.slice(9);
if(resumeId&&args.includes('--check'))throw Error('续跑与只读预检不能同时使用');
const checkOnly=args.includes('--check'), started=new Date();
if(await dispatchStandalone({number:1,args,config:runConfig}))process.exit(process.exitCode||0);
const parts=d=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));
const prefix=d=>{const p=parts(d);return p.month+p.day+'-'+p.hour+p.minute;};
await fs.mkdir(path.join(root,'runs'),{recursive:true});
let dir;
for(let n=1;;n++){
 dir=path.join(root,'runs',prefix(started)+'-'+(checkOnly?'首条用例预检':'日程管理')+'-第'+String(n).padStart(2,'0')+'次');
 try{await fs.mkdir(dir);break;}catch(e){if(e.code!=='EEXIST')throw e;}
}
await fs.writeFile(path.join(dir,'运行配置.json'),JSON.stringify(safeConfig,null,2));
const checks=[],events=[],evidence=[];
let browser,page,sessionId,result='BLOCKED',errorText='',seq=0,owned,submitted=false;
const log=(step,detail='')=>{const now=new Date();events.push({time:now.toISOString(),step,detail});console.log('['+beijingLogTime(now)+'] '+step+' '+detail);};
const taskControl=createTaskControl({log});
const block=message=>{const e=Error(message);e.blocked=true;throw e;};
const assert=(name,pass,actual)=>{checks.push({name,pass:Boolean(pass),actual});if(!pass)throw Error('断言失败：'+name);};
const button=name=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const present=async name=>(await button(name).count())>0;
const capture=name=>taskControl?taskControl.withUI(page,'EVIDENCE',()=>captureRaw(name)):captureRaw(name);
async function captureRaw(name){
 const stem=prefix(new Date())+'-'+String(++seq).padStart(2,'0')+'-'+name;
 const state=await page.evaluate(()=>({url:location.href,text:(document.querySelector('main')||document.body).innerText,editors:[...document.querySelectorAll('[contenteditable="true"]')].map(e=>e.innerText)}));
 await fs.writeFile(path.join(dir,stem+'.json'),JSON.stringify({time:new Date().toISOString(),...state},null,2));
 await page.screenshot({path:path.join(dir,stem+'.png')});
 evidence.push({time:new Date().toISOString(),step:name,screenshot:stem+'.png',state:stem+'.json'});return state;
}
try{
 /* 并行执行允许每个用例使用独立会话和独立证据目录。 */
 const port=Number(runConfig?.cdpPort||process.env.MW_CDP_PORT||9223),timeout=Number(process.env.MW_CASE_TIMEOUT_MS||600000);
 if(!Number.isInteger(port)||port<1||port>65535||!Number.isFinite(timeout)||timeout<1000)block('端口或超时参数无效');
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:15000});
 const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url().includes('MobileWork/resources/app-dist/index.html'));
 if(pages.length!==1)block('MobileWork主界面数量不是1');
 page=pages[0];page.setDefaultTimeout(15000);if(taskControl)await taskControl.begin(page,{openComposer:!resumeId&&!checkOnly,stepInterval:runConfig.stepInterval});await capture('连接客户端');
 const build=JSON.parse(await fs.readFile(testEnvironment.buildInfoPath,'utf8'));
 await fs.writeFile(path.join(dir,'环境.json'),JSON.stringify({version:build.version,productVersion:build.productVersion,packagedCdpAllowed:build.packagedCdpAllowed,port,timezone:'Asia/Shanghai'},null,2));
 if(resumeId&&!page.url().endsWith('/session/'+resumeId))block('续跑ID与当前会话不一致');
 if(!resumeId&&(await present('停止')||await present('允许一次')||await present('跳过')))block('当前存在执行任务或交互，不切换会话');
 const draft=page.locator('[contenteditable="true"]').filter({visible:true});
 if(await draft.count()&&(await draft.first().innerText()).trim())block('当前有未发送草稿，保留草稿并停止');
 if(checkOnly){result='CHECKED';log('只读预检通过');}
 else{
  if(resumeId){sessionId=resumeId;log('续跑既有会话',sessionId);}
  else{
  // 新建首页及输入清理由TaskControl.begin统一完成，避免再次恢复草稿。
  await button('日常办公').first().waitFor();await capture('新建任务');
  await resetComposerPermission(page,runConfig);
  if(runConfig?.model){await selectModel(page,runConfig.model,{stepInterval:runConfig.stepInterval});log('模型已核对',runConfig.model);}
  await waitStep(page,runConfig);await button('日常办公').first().click();await waitStep(page,runConfig);await button('日程管理').first().click();
  const editor=page.locator('[contenteditable="true"]').filter({visible:true});
  await editor.locator('[data-skill-chip-label="true"]').waitFor();
  owned=await snapshotDraft(page,editor);await taskControl?.checkpointDraft(owned);
  const text=await editor.innerText();
  assert('场景自动填充',text.includes('帮我规划本周的工作日程与优先级。')&&await editor.locator('[data-skill-remove="workday-calendar"]').count()===1,text);
  assert('发送按钮可用',await button('运行任务').isEnabled());
  await capture('日程管理自动填充');log('自动填充断言通过');
  await appendComposerText(editor,scheduleText,{stepInterval:runConfig.stepInterval,onDraft:async value=>{owned={...owned,...value};await taskControl?.checkpointDraft(owned);}});
  assert('补充完整日程素材且保留原提示词和技能',containsComposerText(await editor.innerText(),scheduleText)&&containsComposerText(await editor.innerText(),'帮我规划本周的工作日程与优先级。')&&await editor.locator('[data-skill-remove="workday-calendar"]').count()===1);
  await capture('完整日程材料');
  const sourceUrl=page.url();await taskControl?.markSubmitting();await waitStep(page,runConfig);await button('运行任务').click();submitted=true;
  sessionId=await waitCreatedSession(page,sourceUrl,{timeoutMs:Math.min(timeout,180000),log});
  await taskControl?.registerSession(page,sessionId);
  assert('新会话创建',Boolean(sessionId),sessionId);
  await capture('发送成功');log('任务已发送',sessionId);
  }
  const receipt=await waitSentInput(page,sessionId,scheduleText);
  assert('本会话实际收到完整日程素材',receipt.complete);
  if(taskControl)await taskControl.submitted(page,sessionId);
  const sessionLog=taskControl?await taskControl.wait(page,runConfig,{timeoutMs:timeout,capture,log}):await waitScenario(page,sessionId,runConfig,{timeoutMs:timeout,capture,log});
  const output=finalAssistantText(sessionLog);
  assert('任务完成且本会话返回最终助手回复',Boolean(output.trim()));
  await fs.writeFile(path.join(dir,sessionId+'-session-log.json'),JSON.stringify(sessionLog,null,2));
  await fs.writeFile(path.join(dir,'助手最终回复.txt'),output);
  await capture('执行完成');
  const contentChecks=textChecks(1,output,{scheduleFixture:true});checks.push(...contentChecks);
  if(contentChecks.some(c=>!c.pass))throw Error('最终回复未提供日程安排或优先顺序，请查看内容证据');
  result=resumeId?'RESUMED':'PASS';log('场景功能检查完成',checks.length+'项断言；最终结论还需核验 Skill 调用');
 }
}catch(e){
 errorText=e.message;result=e.blocked||!sessionId&&checks.length===0?'BLOCKED':'FAIL';
 log(result,errorText);if(page)await capture('异常现场').catch(()=>{});
  if(!submitted&&owned&&await clearOwnedDraft(page,owned,runConfig).catch(()=>false))log('已清理本次未发送草稿');
}finally{
 const trace=page&&sessionId?await saveRunTrace({page,sessionId,number:1,dir,checks,log,...(taskControl?.connection?{readLog:children=>taskControl.readLog(children)}:{})}):null;
 if(['PASS','RESUMED'].includes(result)&&checks.some(c=>!c.pass)){result='FAIL';errorText='Skill 实际调用或 Trace 证据断言失败，请查看 Trace 记录';log('用例失败',errorText);}
 else if(['PASS','RESUMED'].includes(result))log('用例通过',checks.length+'项断言，已包含 Skill 调用核验');
 const summary={result,caseId:'MW-CLIENT-001',sheet:'测试案例（客户端-多端兼容）',row:2,title:'日常办公01-日程管理自动填充内容，执行会话',startedAt:started.toISOString(),endedAt:new Date().toISOString(),sessionId,checks,events,evidence,trace,error:errorText,scope:'通用日程分支的功能及内容结构，不验证个人日程真实性或外部日历来源'};
 summary.runConfig=safeConfig;
 if(runConfig)summary.scope='所选交互配置下的日程功能及内容结构，不验证个人日程真实性或外部日历来源；参数见运行配置.json';
 await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));
 const lines=['# 首条用例执行报告','','- 结论：'+result,'- 用例：'+summary.title,'- 会话：'+(sessionId||'未创建'),'- 时间：'+started.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）','- 控制：CDP + Playwright，配置见环境.json','- 范围：'+summary.scope,'- 错误或阻塞：'+(errorText||'无'),'','## 断言','',...checks.map(c=>'- '+(c.pass?'通过':'失败')+'：'+c.name),'','## 执行记录','',...events.map(e=>'- '+e.time+' '+e.step+' '+e.detail),'','## 截图证据','',...evidence.map(e=>'- ['+e.step+']('+e.screenshot+')')];
 if(trace)lines.push('','## Trace 记录','','- 调用证据：[trace.json](trace.json)','- 核验规则：'+trace.ruleVersion);
 await fs.writeFile(path.join(dir,'执行报告.md'),lines.join('\n')+'\n');
 await taskControl?.close(page).catch(e=>log('交还页面操作未完成',e.message));
 await browser?.close().catch(()=>{});
 console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=['PASS','CHECKED','RESUMED'].includes(result)?0:result==='BLOCKED'?2:1;
}
