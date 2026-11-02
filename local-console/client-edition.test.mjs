import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole,projectRoot} from './server.mjs';
import {assertClientEdition,editionProfiles} from './client-edition.mjs';
import {resolveEnvironment} from './environment.mjs';
import {handleConfiguredDialog,readModelOptions} from '../scripts/mobilework-run-policy.mjs';

test('客户端版别切换、配置隔离与匹配交互的完整流程',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-edition-'));
 const originalEnvironment=process.env.MW_TEST_ENV_FILE,configFile=path.join(dir,'environment.json'),editions={};
 for(const edition of ['enterprise','public']){const install=path.join(dir,edition);await fs.mkdir(path.join(install,'resources'),{recursive:true});await fs.writeFile(path.join(install,'resources','build-info.json'),JSON.stringify({version:edition+'-fixture',packagedCdpAllowed:false}));editions[edition]={clientExecutable:path.join(install,'MobileWork.exe')};}
 await fs.writeFile(configFile,JSON.stringify({editions}));process.env.MW_TEST_ENV_FILE=configFile;
 const app=await createConsole({port:0,dataDir:dir,discoverPort:async()=>null,clientProbe:async(_port,{clientEdition})=>({connected:clientEdition==='public',actualEdition:'public'}),modelReader:async c=>({current:c.model,models:[{name:'自动',selected:true}]})});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await page.getByText('本机服务已连接',{exact:true}).waitFor();
  assert.equal(await page.getByRole('radio',{name:'政企版',exact:true}).isChecked(),true);
  assert.equal(await page.locator('#clientEdition').evaluate(e=>Boolean(e.compareDocumentPosition(document.querySelector('#cdpState'))&Node.DOCUMENT_POSITION_FOLLOWING)),true,'全局胶囊位于 CDP 配置上方');
  await page.locator('#cdpState').getByText(/enterprise-fixture/).waitFor();
  await page.locator('#enableCdp').click();
  await page.locator('#cdpState').getByText(/packagedCdpAllowed=true/).waitFor();
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'public/resources/build-info.json'),'utf8')).packagedCdpAllowed,false,'修改政企版 CDP 不写入公众版');
  await page.locator('#cdpPort').fill('9555');
  await page.getByRole('radio',{name:'拒绝',exact:true}).check();
  await page.getByRole('radio',{name:'公众版',exact:true}).check();
  await page.getByText('已切换到公众版，执行前将核对实际连接。',{exact:true}).waitFor();
  await page.locator('#cdpState').getByText(/public-fixture.*packagedCdpAllowed=false/).waitFor();
  assert.equal(await page.locator('#cdpPort').inputValue(),'9223');
  await page.locator('#enableCdp').click();
  await page.locator('#cdpState').getByText(/public-fixture.*packagedCdpAllowed=true/).waitFor();
  assert.equal(await page.locator('#model').inputValue(),'自动');
  await page.getByRole('radio',{name:'在会话期间允许',exact:true}).check();
  await page.getByRole('radio',{name:'政企版',exact:true}).check();
  await page.getByText('已切换到政企版，执行前将核对实际连接。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('radio',{name:'拒绝',exact:true}).isChecked(),true);
  assert.equal(await page.locator('#cdpPort').inputValue(),'9555');
  await page.getByRole('radio',{name:'公众版',exact:true}).check();
  await page.getByText('已切换到公众版，执行前将核对实际连接。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('radio',{name:'在会话期间允许',exact:true}).isChecked(),true);
  await page.getByRole('button',{name:'从客户端读取模型'}).click();
  await page.waitForFunction(()=>document.querySelector('#models').disabled===false);
  const evidence=path.join(projectRoot,'runs','edition-adapter-regression');await fs.mkdir(evidence,{recursive:true});
  await page.screenshot({path:path.join(evidence,'console.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'console-mobile.png'),fullPage:true});
  assert.equal(await page.locator('.edition-global').evaluate(e=>e.getBoundingClientRect().right<=innerWidth),true);
  assert.deepEqual(errors,[]);
  const saved=JSON.parse(await fs.readFile(path.join(dir,'settings.json'),'utf8'));
  assert.equal(saved.editionConfigs.enterprise.approval,'reject');assert.equal(saved.editionConfigs.public.approval,'session');
  const config={clientExecutable:'C:/legacy/MobileWork.exe',clientHome:'C:/legacy-home'};
  const publicEnv=resolveEnvironment({edition:'public',homeDir:'C:/test-user',env:{},config,exists:()=>false});
  assert.match(publicEnv.clientExecutable,/MobileWork-toC/);assert.match(publicEnv.clientHome,/\.mobilework_public$/);
  const fixture=await browser.newPage();
  for(const edition of ['enterprise','public']){
   await fixture.setContent('<button aria-label="模型" aria-expanded="false"><svg><path d="M3.624"/></svg>自动</button><div id="menu"></div>');
   await fixture.evaluate(bridge=>{
    delete window.__OPENWORK_ELECTRON__;delete window.__MOBILEWORK_ELECTRON__;window[bridge]={invokeDesktop(){}};
    document.querySelector('button').onclick=()=>{document.querySelector('#menu').innerHTML='<div role="listbox"><div role="option" data-value="[&quot;auto&quot;,&quot;auto&quot;]" data-checked="true"><span class="truncate">自动</span></div></div>';};
    document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('#menu').replaceChildren();});
   },editionProfiles[edition].bridge);
   assert.equal(await assertClientEdition(fixture,edition),edition);
   await assert.rejects(()=>assertClientEdition(fixture,edition==='public'?'enterprise':'public'),/实际连接的是/);
   assert.equal((await readModelOptions(fixture,{clientEdition:edition,stepInterval:0.1})).models[0].selected,true);
   await fixture.locator('body').evaluate(body=>{const panel=document.createElement('section');panel.innerHTML='<button>拒绝</button><button>允许一次</button><button>在会话期间允许</button><button>开启完全访问权限</button>';panel.onclick=e=>{window.approved=e.target.textContent;panel.remove();};body.append(panel);});
   assert.equal(await handleConfiguredDialog(fixture,{clientEdition:edition,approval:'session',stepInterval:0.1},async()=>{},()=>{},{kind:'permission'}),true);
   assert.equal(await fixture.evaluate(()=>window.approved),'在会话期间允许');
   await fixture.locator('body').evaluate(body=>{const panel=document.createElement('section');panel.innerHTML='<h2>选择方式</h2><button><span>1</span><span>第一项</span></button><button><span>2</span><span>第二项</span></button><button disabled>发送</button>';panel.onclick=e=>{if(e.target.closest('button')?.textContent.startsWith('2')){window.choice=2;panel.remove();}};body.append(panel);});
   assert.equal(await handleConfiguredDialog(fixture,{clientEdition:edition,question:'second',stepInterval:0.1},async()=>{},()=>{},{kind:'question'}),true);
   assert.equal(await fixture.evaluate(()=>window.choice),2);
  }
 }finally{await browser.close();await new Promise(resolve=>app.server.close(resolve));if(originalEnvironment===undefined)delete process.env.MW_TEST_ENV_FILE;else process.env.MW_TEST_ENV_FILE=originalEnvironment;await fs.rm(dir,{recursive:true,force:true});}
});
