import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {previewBrowserOptions} from '../local-console/environment.mjs';
import {createConsole,projectRoot} from '../local-console/server.mjs';
import {clientCases,getClientCase} from './client-case-catalog.mjs';
import {withClientCases} from '../local-console/case-registry.mjs';
import {runConversationSettingsSteps} from './client-conversation-settings-steps.mjs';
import {openSettings,releaseSettingsPanel,validateSettingsPanel} from './mobilework-account-settings.mjs';
import {readMemory} from './mobilework-account-memory.mjs';
import {prepareConversationSettings,readConversationPreferences,chooseTone,saveCustomInstruction,chooseOfficialMaf,readOfficialMaf,probeMaf,releaseConversationSettings,validateConversationSettings,toneInstructions} from './mobilework-conversation-settings.mjs';
import {observePromptSettings,promptSettingFact} from './mobilework-prompt-observation.mjs';

// Independent fixture; these five development checks do not execute MobileWork
// or establish product acceptance. Keep the source UTF-8 and compile runtime.
const runtime=String.raw`
window.accountId='synthetic-settings-account';window.values={};window.engineBase='';window.configRoot='';window.maf=true;
localStorage.setItem('openwork.preferences',JSON.stringify({agentTone:'concise',customInstruction:'',showLoadingTips:false,unrelated:'keep'}));
window.__MOBILEWORK__={invoke:async(action,payload)=>{
 if(action==='auth:current')return {account:{id:accountId},oidcValidation:'valid'};
 if(action==='models:list')return {models:[],officialMaf:maf};
 if(action==='store:read')return {value:Object.hasOwn(values,payload.path)?values[payload.path]:payload.fallback};
 if(action==='store:write'){values[payload.path]=payload.value;return {ok:true};}
 if(action==='maf:config')return {enabled:true,mock:false,configured:true,facets:{input:true}};
 if(action==='maf:moderate')return {ResponseMetadata:{RequestId:maf?'synthetic-cloud-request':'maf-local-disabled'},Result:{Decision:{DecisionType:1}}};
 throw Error('unexpected bridge action '+action);
}};
window.__OPENWORK_ELECTRON__={invokeDesktop:async(action)=>{if(action==='engineInfo')return {baseUrl:engineBase,opencodeUsername:'synthetic',opencodePassword:'synthetic'};if(action==='__pathRoots')return {dataRootDir:configRoot};throw Error('unexpected desktop action '+action);}};
function el(tag,text='',attrs={}){const n=document.createElement(tag);n.textContent=text;for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
function preference(key,value){const prefs=JSON.parse(localStorage.getItem('openwork.preferences'));prefs[key]=value;localStorage.setItem('openwork.preferences',JSON.stringify(prefs));}
window.showSettings=()=>{
 const panel=el('div','',{role:'dialog','aria-label':'设置'}),main=el('main'),close=el('button','关闭设置');close.onclick=()=>panel.remove();panel.append(close);
 for(const name of ['账户管理','系统设置','记忆','模型','个性化']){const b=el('button',name);b.onclick=()=>render(main,name);panel.append(b);}panel.append(main);document.body.append(panel);render(main,'账户管理');
};
function render(main,section){
 main.replaceChildren();if(section==='账户管理'){main.append(el('button','退出登录'));return;}
 if(section==='模型'){
  const toggle=el('button','',{role:'switch','aria-label':'MAF防火墙','aria-checked':String(maf)});toggle.onclick=()=>{
   if(!maf){maf=true;toggle.setAttribute('aria-checked','true');return;}
   const d=el('div','所有智能体输入输出将跳过合规校验',{role:'dialog','aria-label':'你确定关闭MAF防火墙吗？'}),cancel=el('button','取消'),yes=el('button','确认');cancel.onclick=()=>d.remove();yes.onclick=()=>{maf=false;toggle.setAttribute('aria-checked','false');d.remove();};d.append(cancel,yes);document.body.append(d);
  };main.append(toggle,el('p','开启 MAF 将对 AI 流量做安全校验，轻微增加时延；关闭后失去 AI 安全防护能力'));return;
 }
 if(section==='记忆'){
  const toggle=el('button','',{role:'switch','aria-label':'自动生成记忆','aria-checked':String(values['memory/generation-enabled']??true)});toggle.onclick=()=>{const enabled=!(values['memory/generation-enabled']??true);values['memory/generation-enabled']=enabled;toggle.setAttribute('aria-checked',String(enabled));};main.append(toggle);
  const doc=values['memory/conversation-memory'];if(!doc?.content){main.append(el('p','暂无对话记忆。'));return;}
  const card=el('button');card.append(el('span','来自对话的记忆'),el('p',doc.content),el('span','1 分钟前从对话中更新'));card.onclick=()=>{const d=el('div','',{role:'dialog','aria-label':'管理记忆'}),input=el('textarea','',{'aria-label':'记忆内容'}),close=el('button','关闭');input.value=doc.content;close.onclick=()=>d.remove();d.append(input,close);document.body.append(d);};main.append(card);return;
 }
 if(section==='个性化'){
  const prefs=JSON.parse(localStorage.getItem('openwork.preferences')),labels={concise:'简洁高效',rigorous:'严谨详尽',friendly:'亲和友好'},select=el('button',labels[prefs.agentTone],{role:'combobox','aria-label':'基本风格和语调'});
  select.onclick=()=>{const list=el('div','',{role:'listbox'});for(const[value,label]of Object.entries(labels)){const o=el('button',label,{role:'option'});o.onclick=()=>{preference('agentTone',value);select.textContent=label;list.remove();};list.append(o);}main.append(list);};
  const input=el('textarea','',{'aria-label':'自定义指令',maxlength:'150'}),counter=el('span',prefs.customInstruction.length+'/150'),confirm=el('button','确认');input.value=prefs.customInstruction;confirm.disabled=true;input.oninput=()=>{counter.textContent=input.value.length+'/150';confirm.disabled=input.value===JSON.parse(localStorage.getItem('openwork.preferences')).customInstruction;};confirm.onclick=()=>{preference('customInstruction',input.value);confirm.disabled=true;};main.append(select,input,counter,confirm);return;
 }
}
`;
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-conversation-settings-')),browser=await chromium.launch(previewBrowserOptions());t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});const page=await browser.newPage();
 const server=http.createServer((req,res)=>{res.setHeader('content-type',req.url==='/fixture'?'text/html;charset=utf-8':'application/json');res.end(req.url==='/fixture'?'<meta charset="utf-8"><div data-testid="sidebar-account-footer"><button data-sidebar="menu-button" aria-haspopup="menu">测试账户</button></div>':'{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 await page.goto('http://127.0.0.1:'+server.address().port+'/fixture');await page.addScriptTag({content:runtime});
 await page.evaluate(({engineBase,configRoot})=>{window.engineBase=engineBase;window.configRoot=configRoot;document.querySelector('[data-testid="sidebar-account-footer"] button').onclick=()=>{const menu=el('div','',{role:'menu'}),item=el('button','设置',{role:'menuitem'});item.onclick=()=>{menu.remove();showSettings();};menu.append(item);document.body.append(menu);};},{engineBase:'http://127.0.0.1:'+server.address().port,configRoot:dir});
 const c={page,dir,resources:{url:page.url(),attachments:[],queueTexts:[],restorePermission:false},remaining:new Set(),checkpointResources:async()=>{},capture:async()=>{},assert:(name,value)=>assert.ok(value,name),control:{withUI:async(p,phase,action)=>action()}};return c;
}

test('187合成空态摘要全文和独立背景差异；嵌套面板归属及只关本轮窗口',async t=>{
 const c=await fixture(t),file=path.join(c.dir,'authorization.json'),previous=process.env.MW_TEST_MEMORY_ACCOUNT_FILE;t.after(()=>{if(previous===undefined)delete process.env.MW_TEST_MEMORY_ACCOUNT_FILE;else process.env.MW_TEST_MEMORY_ACCOUNT_FILE=previous;});
 await fs.writeFile(file,JSON.stringify({source:'dedicated-memory-account',allowMemoryMutation:true,accountIdSha256:(await readMemory(c.page)).accountIdSha256}));process.env.MW_TEST_MEMORY_ACCOUNT_FILE=file;c.number=187;c.remaining=new Set(getClientCase(187).steps);
 await assert.rejects(runConversationSettingsSteps(c),error=>error.review&&/独立工作背景/.test(error.message));assert.deepEqual([...c.remaining],['原表独立工作背景区域差异复核']);assert.equal(c.resources.settingsPanel,undefined);assert.ok(c.resources.accountMemory);assert.equal(await c.page.getByRole('dialog').count(),0);
 const panel=await openSettings(c,'models');c.resources.settingsPanel.mafToken=randomUUID();await panel.getByRole('switch',{name:'MAF防火墙'}).click();await assert.rejects(releaseSettingsPanel(c.page,c.resources),/尚未归属/);assert.ok(c.resources.settingsPanel);
 await c.page.getByRole('dialog',{name:'你确定关闭MAF防火墙吗？'}).evaluate((node,token)=>node.setAttribute('data-mw-settings-maf',token),c.resources.settingsPanel.mafToken);await releaseSettingsPanel(c.page,c.resources);assert.equal((await readOfficialMaf(c.page)).enabled,true);
 assert.throws(()=>validateSettingsPanel({token:randomUUID(),originUrl:c.page.url(),section:'models',mafToken:'unknown'}),/无效/);
});

test('188默认与已有值区分，189真实确认逻辑和原官方开关恢复不重存模型',async t=>{
 const c=await fixture(t);c.number=188;c.remaining=new Set(getClientCase(188).steps);await runConversationSettingsSteps(c);assert.equal(c.remaining.size,0);
 await fs.writeFile(path.join(c.dir,'models.json'),JSON.stringify({officialMaf:true,models:[{apiKey:'synthetic-secret-not-returned'}]}));c.remaining=new Set(getClientCase(188).steps);await assert.rejects(runConversationSettingsSteps(c),error=>error.review);const evidence=await fs.readFile(path.join(c.dir,'官方MAF当前状态及默认来源.json'),'utf8');assert.ok(!evidence.includes('synthetic-secret'));
 const owned=await prepareConversationSettings(c,'maf');let confirms=0;const panel=await openSettings(c,'models');await chooseOfficialMaf(c,panel,false,{onConfirm:async()=>confirms++});assert.equal(confirms,1);assert.equal((await readOfficialMaf(c.page)).enabled,false);await releaseSettingsPanel(c.page,c.resources);
 const off=await probeMaf(c.page,{sessionId:'ses_fixture',provider:'official-fixture',content:'harmless synthetic'});assert.ok(off.bypassed&&off.accepted);await releaseConversationSettings(c.page,c.resources);assert.equal((await readOfficialMaf(c.page)).enabled,true);assert.equal(c.resources.conversationSettings,undefined);
 assert.throws(()=>validateConversationSettings({...owned,enabled:false},owned),/不能替换/);c.resources.conversationSettings=owned;await c.page.evaluate(()=>accountId='another');await assert.rejects(releaseConversationSettings(c.page,c.resources),/账号已变化/);assert.ok(c.resources.conversationSettings);
});

test('190/191真实个性化控件保存及同Session请求观察，仅保留匹配事实',async t=>{
 const c=await fixture(t),baseline=await prepareConversationSettings(c,'instruction'),panel=await openSettings(c,'personalization');await chooseTone(c.page,panel,'rigorous');await saveCustomInstruction(c.page,panel,'MW-AUTOTEST-使用中文');await releaseSettingsPanel(c.page,c.resources);
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.setHeader('access-control-allow-origin','*');res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});const base='http://127.0.0.1:'+server.address().port;
 const observer=await observePromptSettings(c.page,{tone:toneInstructions.rigorous,instruction:'MW-AUTOTEST-使用中文'});try{
  for(const session of ['ses_target','ses_other'])await c.page.evaluate(async({url,system})=>{await fetch(url,{method:'POST',body:JSON.stringify({system})});},{url:base+'/session/'+session+'/prompt_async',system:toneInstructions.rigorous+'\n用户长期偏好：\nMW-AUTOTEST-使用中文\nsynthetic-hidden-secret'});
  const facts=observer.read('ses_target');assert.equal(facts.length,1);assert.ok(facts[0].toneMatched&&facts[0].instructionMatched);assert.ok(!JSON.stringify(facts).includes('hidden-secret'));assert.equal(observer.read('ses_missing').length,0);
 }finally{await observer.close();}
 await releaseConversationSettings(c.page,c.resources);assert.deepEqual(await readConversationPreferences(c.page),{agentTone:baseline.agentTone,customInstruction:baseline.customInstruction});assert.equal(await c.page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).unrelated),'keep');
 await c.page.evaluate(()=>preference('customInstruction','用户原始私人指令'));await assert.rejects(prepareConversationSettings(c,'instruction'),error=>error.blocked);assert.equal(c.resources.conversationSettings,undefined);
});

test('190业务请求隔离与191拒绝缺少system或错误指令，不以保存代替生效',()=>{
 const event={request:{method:'POST',url:'http://127.0.0.1:123/session/ses_owned/prompt_async',postData:JSON.stringify({system:toneInstructions.friendly+'\n用户长期偏好：\nMW-AUTOTEST-末行'})}},expected={tone:toneInstructions.friendly,instruction:'MW-AUTOTEST-末行'};
 assert.deepEqual({...promptSettingFact(event,expected),at:0},{sessionId:'ses_owned',at:0,toneMatched:true,instructionMatched:true});const wrong=promptSettingFact({...event,request:{...event.request,postData:JSON.stringify({system:'unrelated'})}},expected);assert.equal(wrong.toneMatched,false);assert.equal(wrong.instructionMatched,false);assert.equal(promptSettingFact({...event,request:{...event.request,url:'http://127.0.0.1:123/other'}},expected),null);assert.equal(promptSettingFact({...event,request:{...event.request,postData:undefined}},expected),null);
});

test('会话设置正式入口和真实控制台HTTP资源持久化、跨阶段及非法重启拒绝',async t=>{
 assert.equal(withClientCases([{id:'custom',name:'保留',path:path.resolve('custom.mjs')}],projectRoot).length,clientCases.length+43);for(let n=187;n<=191;n++){const d=getClientCase(n);assert.equal(d.row,n+1);assert.match(await fs.readFile(d.entry,'utf8'),new RegExp('runInteractionCase\\('+n+'\\)'));}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-conversation-stage-')),worker=path.join(dir,'worker.mjs'),base=pathToFileURL(path.join(dir,'MobileWork/resources/app-dist/index.html')).href+'#/workspace/ws_fixture/session/',controlURL=pathToFileURL(path.join(projectRoot,'scripts/mobilework-task-control.mjs')).href;
 await fs.writeFile(worker,`// MW_TEST_CONFIG_JSON isolated stage fixture; no real client access.
import {createTaskControl} from ${JSON.stringify(controlURL)};
const control=createTaskControl();let current='ses_prefA';const page={url:()=>${JSON.stringify(base)}+current};await control.begin(page,{openComposer:false});await control.registerSession(page,current);
const settings={owner:${JSON.stringify(randomUUID())},kind:'maf',accountIdSha256:'a'.repeat(64),enabled:true},resources={url:page.url(),attachments:[],queueTexts:[],restorePermission:false,conversationSettings:settings};await control.call('checkpoint',{composerResources:resources});let rejected=false;
try{await control.call('checkpoint',{composerResources:{url:page.url(),attachments:[],queueTexts:[],restorePermission:false,clientRestart:{originUrl:page.url()}}});}catch(error){rejected=error.message.includes('重启缺');}if(!rejected)throw Error('unowned restart accepted');rejected=false;
try{await control.call('checkpoint',{composerResources:{...resources,conversationSettings:{...settings,enabled:false}}});}catch(error){rejected=error.message.includes('不能替换');}if(!rejected)throw Error('baseline substitution accepted');
await control.call('completed');await control.call('checkpoint',{nextSession:true});current='ses_prefB';await control.registerSession(page,current);resources.url=page.url();await control.call('checkpoint',{composerResources:resources});await control.call('checkpoint',{composerResources:null});await control.call('completed');await control.release(page,'VERIFYING');console.log('CONVERSATION_STAGE_OK');
`);
 const app=await createConsole({port:0,dataDir:path.join(dir,'console'),clientProbe:async()=>({connected:true}),cooperativeDetector:p=>p===worker,recovery:async()=>({ready:true,reason:'isolated handoff'}),recorderFactory:async()=>({metadata:{state:'disabled'},stop:async()=>({state:'disabled'})})});t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 const state=async()=>await(await fetch(app.url+'/api/state')).json(),token=(await state()).token,post=async(route,body)=>{const response=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};const script=await post('/api/scripts',{name:'会话设置阶段开发验证',path:worker}),run=await post('/api/run',{scriptId:script.id,config:{executionStrategy:'serial'}});
 let job;const deadline=Date.now()+20000;do{job=(await state()).jobs.find(item=>item.id===run.id);if(!['RUNNING','QUEUED'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
 const log=await fs.readFile(path.join(dir,'console/jobs',run.id,'执行日志.txt'),'utf8');await fs.writeFile(path.join(projectRoot,'tmp/conversation-settings-187-191-http-validation.json'),JSON.stringify({job,log},null,2));assert.equal(job.status,'EXITED',log);assert.match(log,/CONVERSATION_STAGE_OK/);assert.equal(job.completedSessions[0].id,'ses_prefA');assert.equal(job.sessionId,'ses_prefB');assert.equal(job.composerResources,undefined);assert.equal((await state()).active,0);
});
