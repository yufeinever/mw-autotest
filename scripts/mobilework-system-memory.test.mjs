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
import {runSystemMemorySteps} from './client-system-memory-steps.mjs';
import {openSettings,releaseSettingsPanel,validateSettingsPanel} from './mobilework-account-settings.mjs';
import {chooseClosePreference,readClosePreference,releaseWindowClose} from './mobilework-window-close.mjs';
import {readMemory,prepareAccountMemory,chooseMemoryEnabled,releaseAccountMemory,validateAccountMemory,observeAutoMemory} from './mobilework-account-memory.mjs';
import {prepareInvalidDirectory,releaseInvalidDirectory,validateInvalidDirectory} from './mobilework-storage-probe.mjs';
import {validateSystemStorage,releaseSystemStorage} from './mobilework-default-storage.mjs';

// Independent DOM fixture and local HTTP engine: these are framework checks,
// never evidence that MobileWork's business behavior has passed.
const runtime=`
window.accountId='synthetic-memory-account';window.values={};window.writes=[];window.closePref='quit';window.engineBase='';window.serverBase='';
window.__MOBILEWORK__={invoke:async(action,payload)=>{if(action==='auth:current')return {account:{id:accountId},oidcValidation:'valid'};if(action==='models:list')return {models:[]};if(action==='store:read')return {value:Object.hasOwn(values,payload.path)?values[payload.path]:payload.fallback};if(action==='store:write'){writes.push(payload.path);values[payload.path]=payload.value;return {ok:true};}throw Error('unexpected bridge action '+action);}};
window.__OPENWORK_ELECTRON__={invokeDesktop:async(action,value)=>{if(action==='getWindowClosePref')return {closeBehavior:closePref};if(action==='setWindowClosePref'){closePref=value;return {ok:true};}if(action==='engineInfo')return {baseUrl:engineBase,opencodeUsername:'synthetic',opencodePassword:'synthetic'};if(action==='openworkServerInfo')return {baseUrl:serverBase,ownerToken:'synthetic'};throw Error('unexpected desktop action '+action);}};
function element(tag,text,attrs={}){const node=document.createElement(tag);node.textContent=text;for(const[k,v]of Object.entries(attrs))node.setAttribute(k,v);return node;}
window.showSettings=()=>{const panel=element('div','',{role:'dialog','aria-label':'设置'}),close=element('button','关闭设置'),main=element('main');close.onclick=()=>panel.remove();panel.append(close);for(const name of ['账户管理','系统设置','记忆']){const button=element('button',name);button.onclick=()=>render(main,name);panel.append(button);}panel.append(main);document.body.append(panel);render(main,'账户管理');};
function render(main,section){main.replaceChildren();if(section==='账户管理'){main.append(element('button','退出登录'));return;}if(section==='记忆'){const toggle=element('button','',{role:'switch','aria-label':'自动生成记忆','aria-checked':String(values['memory/generation-enabled']??true)});toggle.onclick=async()=>{const next=toggle.getAttribute('aria-checked')!=='true';await __MOBILEWORK__.invoke('store:write',{path:'memory/generation-enabled',value:next});toggle.setAttribute('aria-checked',String(next));};main.append(toggle,element('p','在 MobileWork 对话会话缓存相关上下文信息，保障多轮对话连贯性。'));return;}const slider=element('input','',{type:'range','aria-label':'字体大小'}),combo=element('button','关闭偏好',{role:'combobox','aria-label':'窗口关闭行为偏好设置'});combo.onclick=()=>{const list=element('div','',{role:'listbox'});for(const[label,value]of [['最小化到系统托盘','minimize'],['直接退出应用','quit']]){const option=element('div',label,{role:'option'});option.onclick=()=>{closePref=value;list.remove();};list.append(option);}document.body.append(list);};main.append(slider,combo);}
const footer=element('div','',{'data-testid':'sidebar-account-footer'}),trigger=element('button','账户',{'data-sidebar':'menu-button','aria-haspopup':'menu'});trigger.onclick=()=>{const menu=element('div','',{role:'menu'}),settings=element('div','设置',{role:'menuitem'});settings.onclick=()=>{menu.remove();showSettings();};menu.append(settings);document.body.append(menu);};footer.append(trigger);document.body.append(footer);
localStorage.setItem('openwork.preferences',JSON.stringify({unrelated:'keep'}));
`;
new Function(runtime);
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-system-memory-')),entry=path.join(dir,'MobileWork/resources/app-dist/index.html');await fs.mkdir(path.dirname(entry),{recursive:true});await fs.writeFile(entry,'<!doctype html><meta charset="utf-8"><body><script src="runtime.js"></script></body>');await fs.writeFile(path.join(path.dirname(entry),'runtime.js'),runtime);
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch(previewBrowserOptions());t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 const page=await browser.newPage();page.setDefaultTimeout(4000);await page.goto(pathToFileURL(entry).href+'#/workspace/ws_fixture/session');await page.waitForFunction(()=>typeof showSettings==='function');await page.evaluate(base=>window.engineBase=base,'http://127.0.0.1:'+server.address().port);
 const resources={url:page.url(),attachments:[],queueTexts:[],restorePermission:false},snapshots=[];const c={page,resources,dir,remaining:new Set(),config:{},control:{withUI:async(page,phase,action)=>action()},capture:async()=>{},assert:(name,pass)=>assert.ok(pass,name),checkpointResources:async()=>{if(resources.settingsPanel)validateSettingsPanel(resources.settingsPanel,snapshots.at(-1)?.settingsPanel);if(resources.accountMemory)validateAccountMemory(resources.accountMemory,snapshots.at(-1)?.accountMemory);snapshots.push(structuredClone(resources));}};return {...c,snapshots};
}

test('182～184真实DOM默认记忆分支、已配置REVIEW及关闭偏好精确恢复',async t=>{
 const c=await fixture(t);c.number=184;c.remaining=new Set(getClientCase(184).steps);await runSystemMemorySteps(c);assert.equal(c.remaining.size,0);assert.equal(c.resources.settingsPanel,undefined);
 await c.page.evaluate(()=>values['memory/generation-enabled']=false);c.remaining=new Set(getClientCase(184).steps);await assert.rejects(runSystemMemorySteps(c),error=>error.review&&/已有显式/.test(error.message));assert.equal(c.resources.settingsPanel,undefined);
 const panel=await openSettings(c,'system');assert.deepEqual(await chooseClosePreference(c.page,panel,'minimize'),['最小化到系统托盘','直接退出应用']);assert.equal(await readClosePreference(c.page),'minimize');await releaseSettingsPanel(c.page,c.resources);await c.checkpointResources();
 const owned={owner:randomUUID(),pid:123,hwnd:456,original:'quit',originUrl:c.page.url()};c.resources.windowClose=owned;const calls=[];await releaseWindowClose(c.page,c.resources,{inspect:async(pid,options)=>{calls.push({pid,...options});return {windows:[{visible:!!options.show}]};}});assert.equal(c.resources.windowClose,undefined);assert.equal(await readClosePreference(c.page),'quit');assert.deepEqual(calls,[{pid:123,hwnd:456},{pid:123,hwnd:456,show:true}]);
 c.resources.windowClose=owned;await assert.rejects(releaseWindowClose(c.page,c.resources,{inspect:async()=>({windows:[]})}),/原MobileWork窗口/);assert.ok(c.resources.windowClose);
});

test('185/186专用账号授权与基线保护、写入终态后恢复原null默认语义',async t=>{
 const c=await fixture(t),previous=process.env.MW_TEST_MEMORY_ACCOUNT_FILE;t.after(()=>{if(previous===undefined)delete process.env.MW_TEST_MEMORY_ACCOUNT_FILE;else process.env.MW_TEST_MEMORY_ACCOUNT_FILE=previous;});delete process.env.MW_TEST_MEMORY_ACCOUNT_FILE;await assert.rejects(prepareAccountMemory(c),error=>error.blocked);assert.equal(c.resources.accountMemory,undefined);
 const file=path.join(c.dir,'authorization.json'),identity=await readMemory(c.page);process.env.MW_TEST_MEMORY_ACCOUNT_FILE=file;await fs.writeFile(file,JSON.stringify({source:'dedicated-memory-account',allowMemoryMutation:true,accountIdSha256:'wrong'}));await assert.rejects(prepareAccountMemory(c),/修改授权/);assert.equal(c.resources.accountMemory,undefined);
 await fs.writeFile(file,JSON.stringify({source:'dedicated-memory-account',allowMemoryMutation:true,accountIdSha256:identity.accountIdSha256}));const owned=await prepareAccountMemory(c);assert.throws(()=>validateAccountMemory({...owned,originalEnabled:true},owned),/替换/);assert.throws(()=>validateAccountMemory({...owned,originalDoc:{content:'real user data',updatedAt:1}}),/合成记忆/);
 let panel=await openSettings(c,'memory');await chooseMemoryEnabled(c.page,panel,true);await releaseSettingsPanel(c.page,c.resources);await c.checkpointResources();await c.page.evaluate(()=>values['memory/conversation-memory']={content:'MW-AUTOTEST-MEMORY new synthetic fact',updatedAt:2});
 await releaseAccountMemory(c.page,c.resources,{checkpoint:c.checkpointResources});const restored=await readMemory(c.page);assert.equal(restored.rawDoc,null);assert.equal(restored.rawEnabled,null);assert.equal(restored.enabled,true);assert.equal(c.resources.accountMemory,undefined);assert.equal(c.resources.settingsPanel,undefined);
 c.resources.accountMemory=owned;await c.page.evaluate(()=>accountId='other-account');const writes=await c.page.evaluate(()=>window.writes.length);await assert.rejects(releaseAccountMemory(c.page,c.resources),/账号已变化/);assert.equal(await c.page.evaluate(()=>window.writes.length),writes);assert.ok(c.resources.accountMemory);
});

test('自动记忆观察只接受最近用户消息整理终态；关闭观察检测异步污染',async()=>{
 const id='ses_memorySource',accountIdSha256='a'.repeat(64),before={accountIdSha256,enabled:true,rawDoc:{content:'old',updatedAt:1},doc:{content:'old',updatedAt:1},ephemeralIds:[]},c={resources:{accountMemory:{accountIdSha256}},getSessionId:()=>id,getData:()=>({messages:[{info:{role:'user',id:'msg_latest'}}]})};let elapsed=0,reads=0;
 const updated={...before,rawDoc:{content:'synthetic-marker',updatedAt:2},doc:{content:'synthetic-marker',updatedAt:2}};
 const result=await observeAutoMemory(c,{before,marker:'synthetic-marker',enabled:true,now:()=>elapsed,pause:async ms=>elapsed+=ms,read:async()=>{reads++;return reads<3?{...updated,ephemeralIds:['ses_generator']}:updated;},readSession:async()=>({metadata:{'mobilework.memory.lastSummarizedMessageId':reads<2?'msg_older':'msg_latest'}})});assert.ok(result.samples.length===3);assert.equal(result.sourceCheckpoint,'msg_latest');
 elapsed=0;const disabled={...before,enabled:false};await assert.rejects(observeAutoMemory(c,{before:disabled,marker:'new',enabled:false,quietMs:1000,now:()=>elapsed,pause:async ms=>elapsed+=ms,read:async()=>elapsed<1000?disabled:{...updated,enabled:false},readSession:async()=>({})}),/关闭自动生成后/);
 elapsed=0;const quiet=await observeAutoMemory(c,{before:disabled,marker:'new',enabled:false,quietMs:20000,now:()=>elapsed,pause:async ms=>elapsed+=ms,read:async()=>disabled,readSession:async()=>({})});assert.ok(quiet.samples.at(-1).elapsedMs>=20000);
 elapsed=0;await assert.rejects(observeAutoMemory(c,{before,marker:'synthetic-marker',enabled:true,timeout:500,now:()=>elapsed,pause:async ms=>elapsed+=ms,read:async()=>updated,readSession:async()=>({metadata:{}})}),error=>error.review&&/未取得/.test(error.message));
});

test('182真实Windows拒写目录及ACL恢复，失败归属保留和存储拒绝终态恢复',async t=>{
 const c=await fixture(t);try{const owned=await prepareInvalidDirectory(c);validateInvalidDirectory(owned);await assert.rejects(fs.writeFile(path.join(owned.path,'probe.txt'),'synthetic'));assert.throws(()=>validateInvalidDirectory({...owned,path:path.join(c.dir,'用户目录')}),/归属无效/);await assert.rejects(releaseInvalidDirectory(c.resources,{operate:async()=>{throw Error('restore rejected');}}),/restore rejected/);assert.ok(c.resources.invalidDirectory);await releaseInvalidDirectory(c.resources);assert.equal(c.resources.invalidDirectory,undefined);await fs.writeFile(path.join(owned.path,'保留.txt'),'retained');assert.equal(await fs.readFile(path.join(owned.path,'保留.txt'),'utf8'),'retained');}finally{await releaseInvalidDirectory(c.resources);}
 const oldPath=path.join(c.dir,'原默认'),base={owner:randomUUID(),originUrl:c.page.url(),originalDefault:{id:'ws_old',name:'原默认',path:oldPath},targetPath:path.join(c.dir,'无效目标'),oldScratch:null,stage:'prepared'};validateSystemStorage({...base,stage:'submitted'},base);validateSystemStorage({...base,stage:'rejected'},{...base,stage:'submitted'});assert.throws(()=>validateSystemStorage({...base,stage:'settled'},{...base,stage:'rejected'}),/终态/);
 const items=[{...base.originalDefault,isDefault:true}],server=http.createServer((req,res)=>{assert.equal(req.method,'GET');res.setHeader('content-type','application/json');res.end(JSON.stringify({items}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});await c.page.evaluate(base=>serverBase=base,'http://127.0.0.1:'+server.address().port);c.resources.systemStorage={...base,stage:'rejected'};c.resources.workspaceResources={beforeIds:['ws_old']};await releaseSystemStorage(c.page,c.resources);assert.equal(c.resources.systemStorage,undefined);assert.deepEqual(await c.page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences'))),{unrelated:'keep'});
});

test('186/229正式注册与隔离真实控制台HTTP：记忆基线跨阶段、替换拒绝及正常交接',async t=>{
 assert.ok(clientCases.length>=186);assert.equal(withClientCases([{id:'custom',name:'自定义',path:path.resolve('custom.mjs')}],projectRoot).length,clientCases.length+43);
 for(let n=182;n<=186;n++){const d=getClientCase(n),source=await fs.readFile(d.entry,'utf8');assert.equal(d.row,n+1);assert.ok(source.includes('dispatchStandalone'));assert.ok(source.includes('runInteractionCase('+n+')'));}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-memory-stage-')),worker=path.join(dir,'worker.mjs'),controlURL=pathToFileURL(path.join(projectRoot,'scripts/mobilework-task-control.mjs')).href,base=pathToFileURL(path.join(dir,'MobileWork/resources/app-dist/index.html')).href+'#/workspace/ws_fixture/session/';
 await fs.writeFile(worker,`// MW_TEST_CONFIG_JSON: isolated memory stage fixture, no client access.
import {createTaskControl} from ${JSON.stringify(controlURL)};
const control=createTaskControl();let current='ses_memoryStageA';const page={url:()=>${JSON.stringify(base)}+current};await control.begin(page,{openComposer:false});await control.registerSession(page,current);
const memory={owner:${JSON.stringify(randomUUID())},accountIdSha256:'a'.repeat(64),originalEnabled:null,originalDoc:null,sourceSessions:[current]};const resources={url:page.url(),attachments:[],queueTexts:[],restorePermission:false,accountMemory:memory};await control.call('checkpoint',{composerResources:resources});await control.call('completed');await control.call('checkpoint',{nextSession:true});
current='ses_memoryStageB';await control.registerSession(page,current);resources.url=page.url();memory.sourceSessions.push(current);await control.call('checkpoint',{composerResources:resources});let rejected=false;try{await control.call('checkpoint',{composerResources:{...resources,accountMemory:{...memory,originalEnabled:true}}});}catch(error){rejected=error.message.includes('不能替换');}if(!rejected)throw Error('baseline substitution accepted');
await control.call('checkpoint',{composerResources:null});await control.call('completed');await control.release(page,'VERIFYING');console.log('MEMORY_STAGE_OK');
`);
 const app=await createConsole({port:0,dataDir:path.join(dir,'console'),clientProbe:async()=>({connected:true}),cooperativeDetector:p=>p===worker,recovery:async()=>({ready:true,reason:'isolated stage handoff'}),recorderFactory:async()=>({metadata:{state:'disabled'},stop:async()=>({state:'disabled'})})});
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});const state=async()=>await(await fetch(app.url+'/api/state')).json(),token=(await state()).token;const post=async(route,body)=>{const response=await fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};
 const script=await post('/api/scripts',{name:'记忆隔离阶段开发验证',path:worker}),run=await post('/api/run',{scriptId:script.id,config:{executionStrategy:'serial'}});let job;const deadline=Date.now()+20000;do{job=(await state()).jobs.find(job=>job.id===run.id);if(!['RUNNING','QUEUED'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
 const log=await fs.readFile(path.join(dir,'console/jobs',run.id,'执行日志.txt'),'utf8');await fs.writeFile(path.join(projectRoot,'tmp/system-memory-182-186-http-validation.json'),JSON.stringify({job,log},null,2));assert.equal(job.status,'EXITED',log);assert.match(log,/MEMORY_STAGE_OK/);assert.equal(job.completedSessions.length,1);assert.equal(job.completedSessions[0].id,'ses_memoryStageA');assert.equal(job.sessionId,'ses_memoryStageB');assert.equal(job.composerResources,undefined);assert.equal((await state()).active,0);
});
