import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {testEnvironment,previewBrowserOptions} from '../local-console/environment.mjs';
import {openAccountSettings,openAccountLogoutConfirmation,openSettings,releaseSettingsPanel,validateSettingsPanel} from './mobilework-account-settings.mjs';
import {waitAccountSignedOut,readLoggedOutFiles} from './mobilework-account-logout.mjs';
import {prepareSystemSettings,chooseFont,chooseTheme,readTheme,releaseSystemSettings,validateSystemSettings} from './mobilework-system-settings.mjs';
import {resumeClientRestart,validateClientRestart} from './mobilework-client-restart.mjs';
import {releaseSystemStorage,validateSystemStorage} from './mobilework-default-storage.mjs';
import {clientCases,getClientCase} from './client-case-catalog.mjs';
import {withClientCases} from '../local-console/case-registry.mjs';

const runtime=`
window.signedIn=true;window.rootPath='';window.serverBase='';
window.__MOBILEWORK__={invoke:async action=>{if(action==='auth:current')return {account:signedIn?{id:'synthetic-system-test'}:null,oidcValidation:signedIn?'valid':null};if(action==='auth:logout'){await testClearIdentity();signedIn=false;document.body.replaceChildren();const login=document.createElement('button');login.textContent='验证码登录';document.body.append(login);return {ok:true};}throw Error('unexpected action');}};
window.__OPENWORK_ELECTRON__={invokeDesktop:async action=>{if(action==='__pathRoots')return {dataRootDir:rootPath};if(action==='openworkServerInfo')return {baseUrl:serverBase,ownerToken:'synthetic-fixture'};throw Error('unexpected desktop action');}};
function element(tag,text,attributes={}){const e=document.createElement(tag);if(text)e.textContent=text;for(const[k,v]of Object.entries(attributes))e.setAttribute(k,v);return e;}
window.showMenu=()=>{const menu=element('div','',{role:'menu'}),item=element('div','设置',{role:'menuitem'});item.onclick=()=>{menu.style.pointerEvents='none';showSettings(menu);};menu.onkeydown=event=>{if(event.key==='Escape'){document.querySelector('[role="dialog"][aria-label="设置"]')?.remove();menu.remove();}};menu.append(item);document.body.append(menu);};
window.showSettings=menu=>{const panel=element('div','',{role:'dialog','aria-label':'设置'}),close=element('button','关闭设置');close.onclick=()=>{panel.remove();menu.remove();};const nav=element('nav'),main=element('main');for(const name of ['账户管理','系统设置']){const button=element('button',name);button.onclick=()=>renderSection(main,name);nav.append(button);}panel.append(close,nav,main);document.body.append(panel);renderSection(main,'账户管理');};
function renderSection(main,name){main.replaceChildren();if(name==='账户管理'){const logout=element('button','退出登录');logout.onclick=showConfirm;main.append(logout);return;}const slider=element('input','',{'aria-label':'字体大小',type:'range',min:0,max:2,step:1});slider.value=[.75,.875,1.125].indexOf(Number(localStorage.getItem('openwork.desktop-font-zoom.v1')||.875));slider.oninput=()=>{const value=[.75,.875,1.125][slider.valueAsNumber];localStorage.setItem('openwork.desktop-font-zoom.v1',String(value));document.documentElement.style.setProperty('--openwork-font-size',16*value+'px');};main.append(slider);for(const [label,value]of [['浅色','light'],['深色','dark'],['跟随系统','system']]){const b=element('button',label);b.onclick=()=>{localStorage.setItem('openwork.react.settings.theme-mode',value);const actual=value==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):value;document.documentElement.dataset.theme=actual;document.documentElement.style.colorScheme=actual;};main.append(b);}}
window.showConfirm=()=>{const dialog=element('div','',{role:'dialog','aria-label':'确认登出'}),cancel=element('button','取消'),ok=element('button','确认登出');cancel.onclick=()=>dialog.remove();ok.onclick=()=>__MOBILEWORK__.invoke('auth:logout');dialog.append(cancel,ok);document.body.append(dialog);};
const footer=element('div','',{'data-testid':'sidebar-account-footer'}),menu=element('button','账户',{'data-sidebar':'menu-button','aria-haspopup':'menu'});menu.onclick=showMenu;footer.append(menu);document.body.append(footer,element('button','运行任务'));
localStorage.setItem('openwork.preferences',JSON.stringify({scratchFolderPath:null,unrelated:'keep'}));
`;
new Function(runtime);
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-system-settings-')),entry=path.join(dir,'MobileWork/resources/app-dist/index.html');await fs.mkdir(path.dirname(entry),{recursive:true});await fs.writeFile(entry,'<!doctype html><meta charset="utf-8"><style>:root{font-size:var(--openwork-font-size,14px)}</style><body><script src="fixture-runtime.js"></script></body>');await fs.writeFile(path.join(path.dirname(entry),'fixture-runtime.js'),runtime);
 const browser=await chromium.launch(previewBrowserOptions()),page=await browser.newPage();await page.exposeFunction('testClearIdentity',async()=>{for(const name of ['session.json','current-account.json'])await fs.writeFile(path.join(dir,name),'{}');for(const name of ['report-token.json','skill-userInfo.json'])await fs.rm(path.join(dir,name),{force:true});});await page.goto(pathToFileURL(entry).href+'#/session');await page.waitForFunction(()=>typeof window.__MOBILEWORK__?.invoke==='function');await page.evaluate(value=>window.rootPath=value,dir);
 const resources={url:page.url(),attachments:[],queueTexts:[],restorePermission:false},checkpoints=[],context={page,resources,dir,checkpointResources:async()=>{if(resources.settingsPanel)validateSettingsPanel(resources.settingsPanel,checkpoints.at(-1)?.settingsPanel);checkpoints.push(structuredClone(resources));}};
 t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});return {...context,browser,checkpoints};
}

test('177真实DOM设置确认后核对已清空身份载体，只返回布尔且仍登录时不读原凭据',async t=>{
 const c=await fixture(t);for(const name of ['session.json','current-account.json','report-token.json','skill-userInfo.json'])await fs.writeFile(path.join(c.dir,name),'synthetic-not-cleared');await assert.rejects(readLoggedOutFiles(c.page),/仍在登录/);
 await openAccountSettings(c);const dialog=await openAccountLogoutConfirmation(c);await dialog.getByRole('button',{name:'确认登出',exact:true}).click();await waitAccountSignedOut(c.page);let facts=await readLoggedOutFiles(c.page);assert.ok(Object.values(facts).every(Boolean));assert.equal(JSON.stringify(facts).includes('synthetic-not-cleared'),false);
 await fs.writeFile(path.join(c.dir,'report-token.json'),'synthetic-residual');facts=await readLoggedOutFiles(c.page);assert.equal(facts['report-token.json'],false);await releaseSettingsPanel(c.page,c.resources);assert.equal(c.resources.settingsPanel,undefined);
});

test('178/179共用真实slider键盘与主题点击，精确恢复缺失键和原CSS，拒绝替换基线',async t=>{
 const c=await fixture(t);await c.page.evaluate(()=>document.documentElement.style.setProperty('--openwork-font-size','17.6px'));const baseline=await prepareSystemSettings(c,'font');validateSystemSettings(baseline);assert.throws(()=>validateSystemSettings({...baseline,fontStyle:'19px'},baseline),/替换/);let panel=await openSettings(c,'system');await chooseFont(c.page,panel,2);assert.equal(await panel.getByRole('slider',{name:'字体大小'}).inputValue(),'2');assert.equal(await c.page.evaluate(()=>getComputedStyle(document.documentElement).fontSize),'18px');await releaseSystemSettings(c.page,c.resources,{checkpoint:c.checkpointResources});assert.deepEqual(await c.page.evaluate(()=>({stored:localStorage.getItem('openwork.desktop-font-zoom.v1'),style:document.documentElement.style.getPropertyValue('--openwork-font-size')})),{stored:null,style:'17.6px'});
 await prepareSystemSettings(c,'theme');panel=await openSettings(c,'system');await chooseTheme(c.page,panel,'dark');assert.equal((await readTheme(c.page)).actual,'dark');await releaseSystemSettings(c.page,c.resources,{checkpoint:c.checkpointResources});assert.equal((await readTheme(c.page)).stored,null);assert.equal(c.resources.settingsPanel,undefined);
});

test('180强停恢复Windows应用明暗原值含缺失键，恢复失败保留归属且不覆盖其他设置',async t=>{
 const c=await fixture(t);const base={owner:randomUUID(),kind:'system-theme',originUrl:c.page.url(),fontStored:null,fontStyle:'',nativeZoom:1,themeStored:'light',osTheme:null};validateSystemSettings(base);c.resources.systemSettings=base;let actual=1;const calls=[];
 const native=async(action='Read',value)=>{calls.push({action,value});if(action==='Restore')actual=value;return {appsUseLightTheme:actual};};await releaseSystemSettings(c.page,c.resources,{checkpoint:c.checkpointResources,setSystemTheme:native});assert.equal(actual,null);assert.deepEqual(calls[0],{action:'Restore',value:null});assert.equal((await readTheme(c.page)).stored,'light');assert.equal(c.resources.systemSettings,undefined);
 c.resources.systemSettings=base;await assert.rejects(releaseSystemSettings(c.page,c.resources,{setSystemTheme:async()=>({appsUseLightTheme:1})}),/尚未恢复/);assert.equal(c.resources.systemSettings,base);assert.equal(await c.page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).unrelated),'keep');
});

test('179重启提交阶段先持久化，新PID同程序才交接，launching未决不重复启动',async t=>{
 const c=await fixture(t),base={owner:randomUUID(),oldPid:101,executable:testEnvironment.clientExecutable,originUrl:c.page.url(),stage:'quitting'};validateClientRestart(base);assert.throws(()=>validateClientRestart({...base,oldPid:102},base),/替换/);c.resources.clientRestart=structuredClone(base);let starts=0;
 const options={checkpoint:c.checkpointResources,processInfo:async pid=>pid===101?null:{ExecutablePath:base.executable},start:async()=>{starts++;assert.equal(c.checkpoints.at(-1).clientRestart.stage,'launching');},probe:async()=>({connected:true}),connect:async()=>c.browser,pidOf:async()=>202};
 const result=await resumeClientRestart(c.resources,{cdpPort:19223},options);assert.equal(starts,1);assert.deepEqual(result.proof,{oldPid:101,newPid:202,normalQuit:true,newMainProcess:true});assert.equal(c.resources.clientRestart,undefined);
 c.resources.clientRestart={...base,stage:'launching'};await assert.rejects(resumeClientRestart(c.resources,{cdpPort:19223},{...options,probe:async()=>({connected:false}),timeout:0,wait:async()=>{}}),/未重复启动/);assert.equal(starts,1);assert.ok(c.resources.clientRestart);
});

test('181独立HTTP元数据恢复保留文件与无关偏好，第三方变更不覆盖；001～181/224统一入口',async t=>{
 const c=await fixture(t),oldPath=path.join(c.dir,'旧默认'),targetPath=path.join(c.dir,'本轮新默认');await fs.mkdir(oldPath);await fs.mkdir(targetPath);await fs.writeFile(path.join(targetPath,'保留.txt'),'retained');const items=[{id:'ws_old',path:oldPath,name:'旧默认(原默认)',isDefault:false},{id:'ws_new',path:targetPath,name:'默认工作空间',isDefault:true}],calls=[];
 const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end(JSON.stringify({items}));return;}let body='';for await(const chunk of req)body+=chunk;calls.push({url:req.url,body:body?JSON.parse(body):null});if(req.url.endsWith('/default'))for(const item of items)item.isDefault=item.id==='ws_old';if(req.url.endsWith('/display-name'))items[0].name=JSON.parse(body).displayName;res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});await c.page.evaluate(({base,targetPath})=>{serverBase=base;localStorage.setItem('openwork.preferences',JSON.stringify({scratchFolderPath:targetPath,unrelated:'keep'}));},{base:'http://127.0.0.1:'+server.address().port,targetPath});
 const owned={owner:randomUUID(),originUrl:c.page.url(),originalDefault:{id:'ws_old',name:'旧默认',path:oldPath},targetPath,oldScratch:null,stage:'settled'};validateSystemStorage(owned);c.resources.systemStorage=structuredClone(owned);c.resources.workspaceResources={beforeIds:['ws_old']};await releaseSystemStorage(c.page,c.resources);assert.equal(items[0].isDefault,true);assert.equal(items[0].name,'旧默认');assert.equal(calls[1].body.displayName,'旧默认');assert.deepEqual(await c.page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences'))),{unrelated:'keep'});assert.equal(await fs.readFile(path.join(targetPath,'保留.txt'),'utf8'),'retained');assert.equal(c.resources.systemStorage,undefined);
 items[0].name='用户刚改的名称';c.resources.systemStorage=structuredClone(owned);await assert.rejects(releaseSystemStorage(c.page,c.resources),/其他操作改变/);assert.equal(calls.length,2);assert.ok(c.resources.systemStorage);
 assert.ok(clientCases.length>=181);for(let n=177;n<=181;n++){const text=await fs.readFile(getClientCase(n).entry,'utf8');assert.match(text,/dispatchStandalone/);assert.ok(text.includes('runInteractionCase('+n+')'));}assert.equal(withClientCases([{id:'custom',name:'自定义',path:path.resolve('custom.mjs')}],path.resolve('.')).length,clientCases.length+43);
 const serverSource=await fs.readFile(new URL('../local-console/server.mjs',import.meta.url),'utf8'),runner=await fs.readFile(new URL('client-interaction-case-runner.mjs',import.meta.url),'utf8');for(const key of ['systemSettings','systemStorage','clientRestart'])assert.ok(serverSource.includes("'"+key+"'"));assert.ok(runner.includes('number>=177?runSystemSettingsSteps'));assert.ok(runner.includes('replaceClient,'));
});
