import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {readRunConfig,selectModel,handleConfiguredDialog} from './mobilework-run-policy.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';
import {testEnvironment} from '../local-console/environment.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';
const runConfig=readRunConfig();
if(runConfig?.provider?.url||runConfig?.provider?.model)throw Error('新模型配置尚未接入客户端；请先在客户端配置模型后从控制台读取选择，避免静默使用旧模型');

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('node scripts/run-client-case001.mjs [--check | --resume=ses_ID]：默认完整执行；--check只读预检；--resume仅续跑指定当前会话');process.exit(0);}
if(args.some(a=>a!=='--check'&&!/^--resume=ses_[A-Za-z0-9]+$/.test(a)))throw Error('未知参数');
const resumeId=args.find(a=>a.startsWith('--resume='))?.slice(9);
if(resumeId&&args.includes('--check'))throw Error('续跑与只读预检不能同时使用');
const checkOnly=args.includes('--check'), started=new Date();
const parts=d=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));
const prefix=d=>{const p=parts(d);return p.month+p.day+'-'+p.hour+p.minute;};
await fs.mkdir(path.join(root,'runs'),{recursive:true});
let dir;
for(let n=1;;n++){
 dir=path.join(root,'runs',prefix(started)+'-'+(checkOnly?'首条用例预检':'日程管理')+'-第'+String(n).padStart(2,'0')+'次');
 try{await fs.mkdir(dir);break;}catch(e){if(e.code!=='EEXIST')throw e;}
}
if(runConfig)await fs.writeFile(path.join(dir,'运行配置.json'),JSON.stringify(runConfig,null,2));
const checks=[],events=[],evidence=[];
let browser,page,sessionId,result='BLOCKED',errorText='',seq=0;
const log=(step,detail='')=>{events.push({time:new Date().toISOString(),step,detail});console.log('['+prefix(new Date())+'] '+step+' '+detail);};
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
async function allowedCommand(text){
 const skillDir=path.join(testEnvironment.skillsRoot,'workday-calendar','scripts');
 const expected='& "'+skillDir.replaceAll('/','\\')+'\\run_workday_calendar.ps1" export-rules-template '+parts(new Date()).year;
 const range=text.match(/范围\s*\n([\s\S]*?)\n详情/);
 if(text.includes('访问外部文件夹？')&&range?.[1].trim()===path.join(testEnvironment.clientHome,'skills','workday-calendar','references','*')&&text.includes('读取文件 cli.md'))return true;
 if(!range||range[1].trim()!==expected)return false;
 for(const [name,hash] of [['run_workday_calendar.ps1','0539c35e4757f2ea21525c54460551228a400eb78989fbeb59f9cef15ca2816e'],['workday_calendar.py','7aff0bc66625b2515384002f5d8092633e2502272ef356947e7dead4444a98b7']]){
  if(createHash('sha256').update(await fs.readFile(path.join(skillDir,name))).digest('hex')!==hash)return false;
 }return true;
}
try{
 /* 并行执行允许每个用例使用独立会话和独立证据目录。 */
 const port=Number(runConfig?.cdpPort||process.env.MW_CDP_PORT||9223),timeout=Number(process.env.MW_CASE_TIMEOUT_MS||600000);
 if(!Number.isInteger(port)||port<1||port>65535||!Number.isFinite(timeout)||timeout<1000)block('端口或超时参数无效');
 browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:15000});
 const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url().includes('MobileWork/resources/app-dist/index.html'));
 if(pages.length!==1)block('MobileWork主界面数量不是1');
 page=pages[0];page.setDefaultTimeout(15000);if(taskControl)await taskControl.begin(page,{openComposer:!resumeId&&!checkOnly});await capture('连接客户端');
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
  await button('新建任务').click();
  await button('日常办公').first().waitFor();await capture('新建任务');
  if(runConfig?.model){await selectModel(page,runConfig.model);log('模型已核对',runConfig.model);}
  await button('日常办公').first().click();await button('日程管理').first().click();
  const editor=page.locator('[contenteditable="true"]').filter({visible:true});
  await editor.locator('[data-skill-chip-label="true"]').waitFor();
  const text=await editor.innerText();
  assert('场景自动填充',text.includes('帮我规划本周的工作日程与优先级。')&&await editor.locator('[data-skill-remove="workday-calendar"]').count()===1,text);
  assert('发送按钮可用',await button('运行任务').isEnabled());
  await capture('日程管理自动填充');log('自动填充断言通过');
  await button('运行任务').click();
  await page.waitForURL(/\/session\/ses_[^/?#]+/,{timeout:30000});
  sessionId=page.url().match(/\/session\/(ses_[^/?#]+)/)?.[1];
  assert('新会话创建',Boolean(sessionId),sessionId);
  await capture('发送成功');log('任务已发送',sessionId);
  }
  const deadline=Date.now()+timeout;let done=false,approvals=0,answered=new Set(),lastLog=0,interactions=0;
  if(taskControl){await taskControl.submitted(page,sessionId);await taskControl.wait(page,runConfig,{timeoutMs:timeout,capture,log});done=true;}
  else{
  while(Date.now()<deadline){
   if(!page.url().endsWith('/session/'+sessionId))block('页面已离开本次会话，停止自动操作');
   const body=await page.locator('main').last().innerText();let handled=false;
   if(runConfig){
    try{handled=await handleConfiguredDialog(page,runConfig,capture,log);}catch(e){block(e.message);}
    if(handled){interactions++;await page.waitForTimeout(1500);continue;}
   }
   if(!runConfig){
   for(const choice of ['先给通用安排','先做通用模板','周五正常工作']){
    const option=page.getByRole('button',{name:new RegExp(choice)}).filter({visible:true});
    if(await option.count()){
     if(answered.has(choice))block('重复出现交互问题：'+choice);
     await capture('提问-'+choice);await option.click();await button('发送').click();
     answered.add(choice);log('回答提问',choice);handled=true;break;
    }
   }
   if(handled){await page.waitForTimeout(1500);continue;}
   if(await present('允许一次')){
    await capture('命令审批');
    if(approvals>=4||!await allowedCommand(body))block('出现未知命令或技能文件变化，保留审批现场');
    await button('允许一次').click();approvals++;log('允许一次',body.includes('访问外部文件夹？')?'本技能 references/cli.md 读取':'已核验的本年度日历规则读取');await page.waitForTimeout(1500);continue;
   }
   }
   if(/等待确认/.test(body)&&await present('发送'))block('出现未配置的人工交互问题，保留现场');
   if(await page.getByText('执行成功',{exact:true}).filter({visible:true}).count()&&!await present('停止')){done=true;break;}
   if(await page.getByText('执行失败',{exact:true}).filter({visible:true}).count())throw Error('客户端显示执行失败');
   if(Date.now()-lastLog>30000){log('等待任务完成');lastLog=Date.now();}
   await page.waitForTimeout(2000);
  }
  }
  if(!done)block('等待超时；保留运行中的任务，不自动中止');
  const final=await capture('执行完成');assert('任务完成',done);
  const hasSchedule=/(?:[01]?\d|2[0-3])[:：][0-5]\d\s*[—–~～-]\s*(?:[01]?\d|2[0-3])[:：][0-5]\d/.test(final.text);
  const hasPriority=/P[012]|高优先级|最高优先级|紧急.{0,5}重要/.test(final.text);
  assert('输出包含日程时间段及优先级',hasSchedule&&hasPriority,{hasSchedule,hasPriority});
  result=resumeId?'RESUMED':'PASS';log('场景功能检查完成',checks.length+'项断言；最终结论还需核验 Skill 调用');
 }
}catch(e){
 errorText=e.message;result=e.blocked||!sessionId&&checks.length===0?'BLOCKED':'FAIL';
 log(result,errorText);if(page)await capture('异常现场').catch(()=>{});
}finally{
 const trace=page&&sessionId?await saveRunTrace({page,sessionId,number:1,dir,checks,log,...(taskControl?.connection?{readLog:children=>taskControl.readLog(children)}:{})}):null;
 if(['PASS','RESUMED'].includes(result)&&checks.some(c=>!c.pass)){result='FAIL';errorText='Skill 实际调用或 Trace 证据断言失败，请查看 Trace 记录';log('用例失败',errorText);}
 else if(['PASS','RESUMED'].includes(result))log('用例通过',checks.length+'项断言，已包含 Skill 调用核验');
 const summary={result,caseId:'MW-CLIENT-001',sheet:'测试案例（客户端-多端兼容）',row:2,title:'日常办公01-日程管理自动填充内容，执行会话',startedAt:started.toISOString(),endedAt:new Date().toISOString(),sessionId,checks,events,evidence,trace,error:errorText,scope:'通用日程分支的功能及内容结构，不验证个人日程真实性或外部日历来源'};
 summary.runConfig=runConfig;
 if(runConfig)summary.scope='所选交互配置下的日程功能及内容结构，不验证个人日程真实性或外部日历来源；参数见运行配置.json';
 await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));
 const lines=['# 首条用例执行报告','','- 结论：'+result,'- 用例：'+summary.title,'- 会话：'+(sessionId||'未创建'),'- 时间：'+started.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）','- 控制：CDP + Playwright，配置见环境.json','- 范围：'+summary.scope,'- 错误或阻塞：'+(errorText||'无'),'','## 断言','',...checks.map(c=>'- '+(c.pass?'通过':'失败')+'：'+c.name),'','## 执行记录','',...events.map(e=>'- '+e.time+' '+e.step+' '+e.detail),'','## 截图证据','',...evidence.map(e=>'- ['+e.step+']('+e.screenshot+')')];
 if(trace)lines.push('','## Trace 记录','','- 调用证据：[trace.json](trace.json)','- 核验规则：'+trace.ruleVersion);
 await fs.writeFile(path.join(dir,'执行报告.md'),lines.join('\n')+'\n');
 await taskControl?.close(page).catch(e=>log('交还页面操作未完成',e.message));
 await browser?.close().catch(()=>{});
 console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=['PASS','CHECKED','RESUMED'].includes(result)?0:result==='BLOCKED'?2:1;
}
