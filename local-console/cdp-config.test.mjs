import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole} from './server.mjs';
test('页面红色状态、按钮保存、备份与幂等（隔离安装配置）',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-cdp-')),file=path.join(dir,'build-info.json');
 const original='{"version":"test","packagedCdpAllowed":false,"disableDevTools":true,"other":42}';await fs.writeFile(file,original);
 const {server,url}=await createConsole({port:0,dataDir:path.join(dir,'state'),cdpConfigFile:file});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.goto(url);await page.locator('#cdpState.result-fail').waitFor();assert.match(await page.locator('#cdpState').innerText(),/false/);
  assert.equal(await page.locator('#enableCdp').innerText(),'修改 CDP 为 true');await page.locator('#enableCdp').click();await page.locator('#cdpState.result-pass').waitFor();assert.match(await page.locator('#cdpState').innerText(),/true/);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:'test',packagedCdpAllowed:true,disableDevTools:true,other:42});
  const backupDir=path.join(dir,'state','cdp-backups'),backups=await fs.readdir(backupDir);assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(backupDir,backups[0]),'utf8'),original);
  const s=await(await fetch(url+'/api/state')).json();const r=await fetch(url+'/api/cdp-config/enable',{method:'POST',headers:{'x-console-token':s.token}});assert.equal((await r.json()).changed,false);
  assert.equal((await fs.readdir(backupDir)).length,1);
  await fs.writeFile(file,'{}');await page.locator('#refreshCdp').click();await page.locator('#cdpState.result-fail').waitFor();assert.equal(await page.locator('#enableCdp').isDisabled(),true);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
