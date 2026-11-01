import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {connectAccountExternal,connectClient,isAccountExternalUrl} from '../local-console/client-connection.mjs';
import {uniqueClientPage} from '../local-console/client-page.mjs';
import {accountBrowserTargets,ownedAccountTarget,validateAccountExternal,releaseAccountExternal,waitAccountExternalPage} from './mobilework-account-external.mjs';
import {validateAccountNetwork,releaseAccountNetwork} from './mobilework-account-network.mjs';
import {startAccountObservation,readAccountObservation,refreshObservationFacts,releaseAccountObservation,readAccountPrincipal,requireAccountRole,manualRefreshChange} from './mobilework-account-observation.mjs';
import {clientCases,getClientCase} from './client-case-catalog.mjs';
import {withClientCases} from '../local-console/case-registry.mjs';

test('系统浏览器定向外链等待真实业务加载，只关闭本轮页面并保留主页面及用户标签',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-account-external-'));
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end('<main aria-busy="true">加载中</main><script>setTimeout(()=>{document.querySelector("main").innerText="我的用量详情：本月Token消耗10000，剩余余额900000，显示当前周期实际账户的详细使用记录。";document.querySelector("main").removeAttribute("aria-busy")},650)</script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
 t.after(async()=>{await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 const [port]=String(await fs.readFile(path.join(dir,'profile/DevToolsActivePort'))).split('\n'),endpoint='http://127.0.0.1:'+port,origin='http://127.0.0.1:'+server.address().port;
 const mainFile=path.join(dir,'MobileWork/resources/app-dist/index.html');await fs.mkdir(path.dirname(mainFile),{recursive:true});await fs.writeFile(mainFile,'<h1>MobileWork主页面</h1>');
 const main=context.pages()[0];await main.goto(pathToFileURL(mainFile).href);const user=await context.newPage();await user.goto(origin+'/#/agentCenter/myUsage');
 const owned={endpoint,origin,route:'/agentCenter/myUsage',beforeIds:(await accountBrowserTargets(endpoint)).map(target=>target.id),submitted:false,targetId:null};validateAccountExternal(owned);
 assert.equal(ownedAccountTarget(await accountBrowserTargets(endpoint),owned),null);
 for(const suffix of ['?code=synthetic','#/agentCenter/myUsage?token=synthetic','#/agentCenter/myUsage?nonce=synthetic'])assert.equal(isAccountExternalUrl(origin+'/'+suffix,owned),false);
 assert.throws(()=>validateAccountExternal({...owned,endpoint:'http://example.invalid/'}),/无效/);assert.throws(()=>validateAccountExternal({...owned,beforeIds:[]},owned),/替换/);
 const own=await context.newPage();owned.submitted=true;await own.goto(origin+'/#/agentCenter/myUsage');const target=ownedAccountTarget(await accountBrowserTargets(endpoint),owned);assert.ok(target);owned.targetId=target.id;
 const browser=await connectAccountExternal(endpoint,{timeout:5000,external:owned});
 try{const pages=browser.contexts().flatMap(item=>item.pages());assert.equal(pages.length,1);const facts=await waitAccountExternalPage(pages[0],owned,{timeout:5000});assert.equal(facts.ready,true);assert.equal(await pages[0].locator('[aria-busy]').count(),0);}finally{await browser.close();}
 const mainConnection=await connectClient(endpoint,{timeout:5000});assert.equal(uniqueClientPage(mainConnection).url(),main.url());await mainConnection.close();
 const resources={accountExternal:owned};await releaseAccountExternal(resources);assert.equal(resources.accountExternal,undefined);assert.equal(own.isClosed(),true);assert.equal(user.isClosed(),false);assert.equal(main.isClosed(),false);
 const pending={accountExternal:{...owned,targetId:null,beforeIds:(await accountBrowserTargets(endpoint)).map(target=>target.id)}};await assert.rejects(releaseAccountExternal(pending),/未确认/);assert.ok(pending.accountExternal);assert.equal(user.isClosed(),false);
});

test('余额DOM观察识别真实loading和新失败，恢复阶段排除既有失败toast且释放归属',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 const token=randomUUID();await page.setContent('<div role="menu" data-mw-account-menu="'+token+'"><div role="menuitem">用量余额<span>100万Token</span><button aria-label="刷新用量余额">刷新</button></div></div><div data-sonner-toast>获取用量余额失败，请稍后重试。</div>');
 const resources={accountMenuToken:token},context={page,resources,checkpointResources:async()=>{}};
 let owner=await startAccountObservation(context);assert.equal(refreshObservationFacts(await readAccountObservation(page,owner)).started,false);
 await page.evaluate(()=>{document.querySelector('button').remove();document.querySelector('span').remove();});await page.waitForTimeout(20);
 await page.evaluate(()=>{document.querySelector('[role=menuitem]').insertAdjacentHTML('beforeend','<span>100万Token</span><button aria-label="刷新用量余额">刷新</button>');document.body.insertAdjacentHTML('beforeend','<div data-sonner-toast>获取用量余额失败，请稍后重试。</div>');});
 let facts=refreshObservationFacts(await readAccountObservation(page,owner));assert.ok(facts.started&&facts.settled&&facts.failed);assert.equal(facts.last.display,'100万Token');await releaseAccountObservation(page,resources);assert.equal(resources.accountObservation,undefined);
 owner=await startAccountObservation(context);await page.evaluate(()=>{document.querySelector('button').remove();document.querySelector('span').remove();});await page.waitForTimeout(20);
 await page.evaluate(()=>document.querySelector('[role=menuitem]').insertAdjacentHTML('beforeend','<span>99万Token</span><button aria-label="刷新用量余额">刷新</button>'));
 facts=refreshObservationFacts(await readAccountObservation(page,owner));assert.ok(facts.started&&facts.settled&&!facts.failed);assert.equal(facts.last.display,'99万Token');
 await assert.rejects(releaseAccountObservation(page,{accountObservation:randomUUID()}),/归属/);assert.ok(await page.evaluate(()=>!!window.__MW_ACCOUNT_OBSERVATION__));await releaseAccountObservation(page,resources);assert.equal(await page.evaluate(()=>window.__MW_ACCOUNT_OBSERVATION__),undefined);
});

test('临时网络规则只接受已登记精确客户端范围，恢复失败保留归属且不触碰用户规则',async()=>{
 const owned={name:'MW-Autotest-Network-169-'+randomUUID(),pid:123,program:'C:\\Program Files\\MobileWork\\MobileWork.exe',addresses:['192.0.2.10','2001:db8::1'],port:443};
 validateAccountNetwork(owned);assert.throws(()=>validateAccountNetwork({...owned,program:'MobileWork.exe'}),/无效/);assert.throws(()=>validateAccountNetwork({...owned,addresses:['Any']}),/无效/);assert.throws(()=>validateAccountNetwork({...owned,port:80},owned),/替换/);
 const resources={accountNetwork:structuredClone(owned)},commands=[];
 await assert.rejects(releaseAccountNetwork(resources,{command:async(mode,value)=>{commands.push([mode,value]);return {exists:true};}}),/仍存在/);assert.deepEqual(resources.accountNetwork,owned);
 await releaseAccountNetwork(resources,{command:async(mode,value)=>{commands.push([mode,value]);return {exists:false};}});assert.equal(resources.accountNetwork,undefined);assert.ok(commands.every(([mode,value])=>mode==='remove'&&value.name===owned.name));
 // Parse and inspect the actual helper without creating a rule on the user's network.
 const helper=await fs.readFile(new URL('mobilework-account-network.ps1',import.meta.url),'utf8');assert.match(helper,/-Program \$Program -Direction Outbound -Action Block/);assert.match(helper,/-RemoteAddress \$expected -RemotePort \$RemotePort/);assert.match(helper,/Rule no longer matches/);
});

test('真实账号前置不伪造角色，余额变化仅认可同账号及本轮窗口内独立云端事实',async()=>{
 const calls=[],page={evaluate:async()=>{calls.push('auth:current');return {signedIn:true,role:'admin',validation:'valid'};}};
 const principal=await readAccountPrincipal(page);requireAccountRole(principal,'admin');assert.throws(()=>requireAccountRole(principal,'user'),/前置不符/);assert.deepEqual(calls,['auth:current']);
 for(const validation of ['unknown','invalid',null])await assert.rejects(readAccountPrincipal({evaluate:async()=>({signedIn:true,role:'user',validation})}),/尚未确认/);
 requireAccountRole({signedIn:true,role:'user',validation:'valid'},'user');
 const baseline={identity:'a'.repeat(64),before:1000000,after:990000,observedAt:1000,clickedAt:3000},fact={accountLabelSha256:baseline.identity,balance:990000,refresh:{balanceBefore:1000000,balanceAfter:990000,changedAt:new Date(2000).toISOString()}};
 assert.equal(manualRefreshChange(fact,baseline),true);assert.equal(manualRefreshChange(null,baseline),false);assert.equal(manualRefreshChange({...fact,accountLabelSha256:'b'.repeat(64)},baseline),false);
 for(const changedAt of [500,4000])assert.equal(manualRefreshChange({...fact,refresh:{...fact.refresh,changedAt:new Date(changedAt).toISOString()}},baseline),false);
 assert.equal(manualRefreshChange({...fact,refresh:{...fact.refresh,balanceAfter:980000}},baseline),false);
});

test('001～171正式入口及214迁移映射保留旧ID和用户脚本，167～171使用统一串行框架',async()=>{
 assert.ok(clientCases.length>=171);
 for(const item of clientCases){assert.equal(item.row,item.number+1);await fs.access(item.entry);}
 const projectRoot=path.resolve('.'),old=[{id:'old-2',name:'我的会议',path:path.resolve(getClientCase(2).entry)},{id:'custom',name:'其他',path:path.resolve('other.mjs')}],migrated=withClientCases(old,projectRoot);
 assert.equal(migrated.length,clientCases.length+43);assert.deepEqual(migrated.slice(0,2).map(({id,name,path})=>({id,name,path})),old);assert.deepEqual(withClientCases(migrated,projectRoot),migrated);
 for(let number=167;number<=171;number++){const item=getClientCase(number),text=await fs.readFile(item.entry,'utf8');assert.match(item.kind,/^interaction-account-/);assert.match(text,/dispatchStandalone/);assert.ok(text.includes('runInteractionCase('+number+')'));}
 const runner=await fs.readFile(new URL('client-interaction-case-runner.mjs',import.meta.url),'utf8');assert.match(runner,/number>=167\?runAccountNavigationSteps:number>=165\?runAccountUsageSteps/);
 const server=await fs.readFile(new URL('../local-console/server.mjs',import.meta.url),'utf8');for(const name of ['accountNetwork','accountExternal','accountObservation'])assert.ok(server.includes(name));
});
