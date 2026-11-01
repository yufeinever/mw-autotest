import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {openAccountMenu,closeAccountMenu} from './mobilework-account-menu.mjs';
import {openAccountSettings,releaseSettingsPanel,readAccountProfileMatch,readAccountSession,validateSettingsPanel} from './mobilework-account-settings.mjs';
import {releaseAccountLogout,validateAccountLogout,validateReloginMaterial} from './mobilework-account-logout.mjs';
import {runAccountProfileSteps} from './client-account-profile-steps.mjs';
import {clientCases,getClientCase} from './client-case-catalog.mjs';
import {withClientCases} from '../local-console/case-registry.mjs';

async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-account-profile-')),file=path.join(dir,'MobileWork/resources/app-dist/index.html');await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,`<body><script>
 window.testAccount={id:'synthetic-account',displayName:'林悦',username:'synthetic-user'};window.signedIn=true;window.calls=[];window.engineBase='';
 window.avatar=()=>{const value=JSON.parse(localStorage.getItem('mobilework.account.avatar.'+testAccount.id)||'null');return value?'<img src="'+value+'">':'林';};
 window.render=()=>{document.querySelectorAll('[data-testid],#run,#login,[role=menu],[role=dialog]').forEach(element=>element.remove());if(!signedIn){document.body.insertAdjacentHTML('beforeend','<div id="login"><button>验证码登录</button><input placeholder="请输入手机号"><button>登录</button></div>');return;}
 document.body.insertAdjacentHTML('beforeend','<div data-testid="sidebar-account-footer"><button data-sidebar="menu-button" aria-haspopup="menu" onclick="showMenu()"><span style="width:32px;height:32px">'+avatar()+'</span><span class="truncate">'+testAccount.displayName+'</span></button></div><button id="run">运行任务</button>');};
 window.showMenu=()=>{document.body.insertAdjacentHTML('beforeend','<div role="menu"><div class="relative z-20"><span style="width:32px;height:32px">'+avatar()+'</span><div><span class="truncate">'+testAccount.displayName+'</span></div></div><div role="menuitem" onclick="showSettings();this.parentElement.remove()">设置</div><div role="menuitem" class="text-[var(--mw-error)]" style="color:red" onclick="window.signedIn=false;render()">登出</div></div>');document.querySelector('[role=menu]').addEventListener('keydown',event=>{if(event.key==='Escape')event.currentTarget.remove()});};
 window.showSettings=()=>{document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-label="设置"><button onclick="this.parentElement.remove()">关闭设置</button><nav><button class="bg-[var(--mw-settings-nav-active)]">账户管理</button></nav><main><div><button aria-label="修改头像"><span style="width:50px;height:50px">'+avatar()+'</span></button><span class="truncate">'+testAccount.displayName+'</span><button onclick="showConfirm()">退出登录</button><button>我的用量</button></div></main></div>');};
 window.showConfirm=()=>document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-label="确认登出"><div aria-busy="false"><button onclick="this.parentElement.parentElement.remove()">取消</button><button>确认登出</button></div></div>');
 window.__MOBILEWORK__={invoke:async(action,payload)=>{calls.push(action);if(action==='auth:current')return {account:signedIn?testAccount:null,oidcValidation:signedIn?'valid':null};if(action==='auth:sms:login'){signedIn=true;render();return {ok:true};}if(action==='models:list')return {models:[]};throw Error('unexpected action');}};
 window.__OPENWORK_ELECTRON__={invokeDesktop:async action=>{if(action==='engineInfo')return {baseUrl:engineBase,opencodeUsername:'fixture',opencodePassword:'synthetic'};throw Error('unexpected desktop action');}};render();
 </script></body>`);
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage();await page.goto(pathToFileURL(file).href+'#/session');
 const resources={url:page.url(),attachments:[],queueTexts:[],restorePermission:false},checkpoints=[],context={page,resources,dir,remaining:new Set(),control:{withUI:async(page,phase,action)=>action()},checkpointResources:async()=>checkpoints.push(structuredClone(resources)),capture:async()=>{},assert:(name,pass)=>assert.ok(pass,name)};
 t.after(async()=>{await browser.close();await fs.rm(dir,{recursive:true,force:true});});return {...context,checkpoints};
}
async function reloginFile(context){const session=await readAccountSession(context.page),value={source:'dedicated-mobilework-sms-account',allowLogout:true,accountIdSha256:session.accountIdSha256,phoneNumber:'19900000000',captcha:'000000',state:'synthetic-once-state',attemptId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString()},file=path.join(context.dir,'runtime-login.json');await fs.writeFile(file,JSON.stringify(value));return {value,file};}

test('真实DOM账户资料比较当前身份和头像来源，识别错名/错图且不输出原始身份',async t=>{
 const c=await fixture(t);await openAccountMenu(c);let facts=await readAccountProfileMatch(c.page,{menuToken:c.resources.accountMenuToken});assert.ok(facts.signedIn&&facts.footerName&&facts.footerAvatar&&facts.menuName&&facts.menuAvatar);assert.equal(facts.avatarKind,'name-glyph');assert.equal(JSON.stringify(facts).includes('林悦'),false);
 await c.page.locator('[role=menu] span.truncate').evaluate(element=>element.textContent='另一个姓名');facts=await readAccountProfileMatch(c.page,{menuToken:c.resources.accountMenuToken});assert.equal(facts.menuName,false);await closeAccountMenu(c.page,c.resources);
 await c.page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);localStorage.setItem('mobilework.account.avatar.'+testAccount.id,JSON.stringify(canvas.toDataURL()));render();});
 await openAccountSettings(c);await c.page.waitForFunction(()=>[...document.querySelectorAll('img')].every(image=>image.complete&&image.naturalWidth>0));
 facts=await readAccountProfileMatch(c.page,{settingsToken:c.resources.settingsPanel.token});assert.ok(facts.settingsName&&facts.settingsAvatar&&facts.accountSelected);assert.equal(facts.avatarKind,'custom-image');
 await c.page.locator('main img').evaluate(image=>image.src='data:image/png;base64,broken');facts=await readAccountProfileMatch(c.page,{settingsToken:c.resources.settingsPanel.token});assert.equal(facts.settingsAvatar,false);await releaseSettingsPanel(c.page,c.resources);assert.equal(c.resources.settingsPanel,undefined);
});

test('真实设置登出确认取消后保留身份和原页，未知弹框不由共用收尾覆盖',async t=>{
 const c=await fixture(t);c.number=174;c.remaining=new Set(['真实设置登出确认取消且同账号保持登录']);const before=await readAccountSession(c.page);await runAccountProfileSteps(c);assert.equal(c.remaining.size,0);assert.deepEqual(await readAccountSession(c.page),before);assert.equal(await c.page.getByRole('dialog').count(),0);assert.equal((await c.page.evaluate(()=>calls)).includes('auth:sms:login'),false);
 await c.page.evaluate(()=>showSettings());await assert.rejects(openAccountSettings(c),/未归属弹框/);await assert.rejects(releaseSettingsPanel(c.page,{settingsPanel:{token:randomUUID(),originUrl:c.page.url(),section:'account'}}),/归属/);assert.equal(await c.page.getByRole('dialog',{name:'设置',exact:true}).count(),1);
});

test('登出恢复提前持久化一次性attempt，失败不重复提交，更新材料后恢复且不覆盖其他账号',async t=>{
 const c=await fixture(t),{value,file}=await reloginFile(c),base={owner:randomUUID(),accountIdSha256:value.accountIdSha256,loginFile:file,originUrl:c.page.url(),stage:'signed-out',lastAttemptId:null};validateAccountLogout(base);assert.throws(()=>validateAccountLogout({...base,accountIdSha256:'f'.repeat(64)},base),/替换/);assert.throws(()=>validateReloginMaterial({...value,allowLogout:false},value.accountIdSha256),/授权/);
 c.resources.accountLogout=structuredClone(base);await c.page.evaluate(()=>{signedIn=false;render();});let attempts=0;
 const checkpoint=async()=>{c.checkpoints.push(structuredClone(c.resources));};
 await assert.rejects(releaseAccountLogout(c.page,c.resources,{checkpoint,login:async()=>{attempts++;assert.equal(c.checkpoints.at(-1).accountLogout.lastAttemptId,value.attemptId);return false;}}),/未完成恢复/);
 await assert.rejects(releaseAccountLogout(c.page,c.resources,{checkpoint,login:async()=>{attempts++;return true;}}),/未重复提交/);assert.equal(attempts,1);assert.ok(c.resources.accountLogout);
 value.attemptId=randomUUID();await fs.writeFile(file,JSON.stringify(value));await releaseAccountLogout(c.page,c.resources,{checkpoint,login:async()=>{attempts++;await c.page.evaluate(()=>{signedIn=true;render();});return true;}});assert.equal(c.resources.accountLogout,undefined);assert.equal(attempts,2);
 c.resources.accountLogout=structuredClone(base);await c.page.evaluate(()=>{testAccount.id='other-account';render();});await assert.rejects(releaseAccountLogout(c.page,c.resources,{login:async()=>{throw Error('must not be called');}}),/其他账户/);assert.ok(c.resources.accountLogout);
 assert.equal(JSON.stringify(c.checkpoints).includes('000000'),false);assert.equal(JSON.stringify(c.checkpoints).includes('synthetic-once-state'),false);
});

test('173统一步骤经真实DOM菜单登出、空身份及登录入口，再经正常认证契约恢复；无材料不退出',async t=>{
 const c=await fixture(t),{file}=await reloginFile(c),prior=process.env.MW_TEST_ACCOUNT_RELOGIN_FILE;c.number=173;c.remaining=new Set(['专用账号真实菜单登出及登录态清除','通过正常短信登录恢复原账号并确认交接']);
 delete process.env.MW_TEST_ACCOUNT_RELOGIN_FILE;await assert.rejects(runAccountProfileSteps(c),/未退出当前账号/);assert.equal((await readAccountSession(c.page)).signedIn,true);
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{if(prior===undefined)delete process.env.MW_TEST_ACCOUNT_RELOGIN_FILE;else process.env.MW_TEST_ACCOUNT_RELOGIN_FILE=prior;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 process.env.MW_TEST_ACCOUNT_RELOGIN_FILE=file;await c.page.evaluate(base=>window.engineBase=base,'http://127.0.0.1:'+server.address().port);await runAccountProfileSteps(c);assert.equal(c.remaining.size,0);assert.equal(c.resources.accountLogout,undefined);assert.equal(c.resources.accountMenuToken,undefined);assert.equal((await readAccountSession(c.page)).signedIn,true);assert.equal((await c.page.evaluate(()=>calls)).filter(action=>action==='auth:sms:login').length,1);assert.ok(c.checkpoints.some(value=>value.accountLogout?.stage==='submitted'));assert.ok(c.checkpoints.some(value=>value.accountLogout?.stage==='relogin'));
});

test('001～176入口及219迁移映射，账户设置/登出资源接入同一runner与服务端收尾',async()=>{
 assert.ok(clientCases.length>=176);for(const item of clientCases){assert.equal(item.row,item.number+1);await fs.access(item.entry);}
 const root=path.resolve('.'),old=[{id:'old-2',name:'我的会议',path:path.resolve(getClientCase(2).entry)},{id:'custom',name:'其他',path:path.resolve('other.mjs')}],migrated=withClientCases(old,root);assert.equal(migrated.length,clientCases.length+43);assert.deepEqual(migrated.slice(0,2).map(({id,name,path})=>({id,name,path})),old);assert.deepEqual(withClientCases(migrated,root),migrated);
 for(let n=172;n<=176;n++){const text=await fs.readFile(getClientCase(n).entry,'utf8');assert.match(text,/dispatchStandalone/);assert.ok(text.includes('runInteractionCase('+n+')'));}
 const runner=await fs.readFile(new URL('client-interaction-case-runner.mjs',import.meta.url),'utf8'),stop=await fs.readFile(new URL('../local-console/stop-job.mjs',import.meta.url),'utf8'),server=await fs.readFile(new URL('../local-console/server.mjs',import.meta.url),'utf8');assert.match(runner,/number>=172\?runAccountProfileSteps:number>=167\?runAccountNavigationSteps/);assert.match(stop,/releaseAccountLogout\(page,job.composerResources,\{checkpoint\}\)/);assert.ok(server.includes('checkpoint:()=>writeJob(job)'));assert.ok(server.includes("'accountLogout','settingsPanel'"));
 validateSettingsPanel({token:randomUUID(),originUrl:'file:///MobileWork/resources/app-dist/index.html#/session',section:'account'});
});
