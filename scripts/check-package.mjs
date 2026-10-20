import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createConsole,projectRoot} from '../local-console/server.mjs';
import {testEnvironment,previewBrowserOptions} from '../local-console/environment.mjs';
import {clientCases,caseWorkbook} from './client-case-catalog.mjs';
import {readCdpConfig} from '../local-console/cdp-config.mjs';
import {probeCdp} from '../local-console/cdp-restart.mjs';

// Isolated fixture execution validates the harness, never a MobileWork product case.
export async function selfTestPackage(){
 assert.ok(Number(process.versions.node.split('.')[0])>=22,'需要 Node.js 22 或更新版本');
 assert.equal(clientCases.length,16);
 for(const item of clientCases)await fs.access(path.join(projectRoot,item.entry));
 await fs.access(path.join(projectRoot,'测试用例与脚本',caseWorkbook));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'MobileWork-包自检-'));
 const previous=process.env.MW_FIXTURE_DIR;process.env.MW_FIXTURE_DIR=dir;
 let app,browser;
 try{
  app=await createConsole({port:0,dataDir:path.join(dir,'console')});
  const state=await(await fetch(app.url+'/api/state')).json();
  assert.equal(state.projectRoot,projectRoot);assert.equal(state.scripts.length,16);
  assert.ok(state.scripts.every(s=>s.exists&&s.integrated));assert.equal(state.jobs.length,0);
  browser=await chromium.launch(previewBrowserOptions());
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  // Avoid connecting to the actual client during package self-test.
  await page.route('**/api/cdp-config',r=>r.fulfill({json:{allowed:null,connected:false,port:9223,error:'隔离自检未检查客户端'}}));
  await page.goto(app.url);await page.getByText('本机服务已连接',{exact:true}).waitFor();
  const post=async(route,body)=>{const r=await fetch(app.url+route,{method:'POST',headers:{'Content-Type':'application/json','x-console-token':state.token},body:JSON.stringify(body)});assert.ok(r.ok,'接口 '+route+' HTTP '+r.status);return r.json();};
  const fixture=await post('/api/scripts',{name:'包自检（模拟）',path:path.join(projectRoot,'local-console','fixture-script.mjs')});
  await post('/api/run',{scriptId:fixture.id,config:state.config});
  let job;
  for(let i=0;i<80;i++){
   const current=await(await fetch(app.url+'/api/state')).json();job=current.jobs.at(-1);
   if(job&&!['RUNNING','QUEUED'].includes(job.status))break;
   await new Promise(r=>setTimeout(r,150));
  }
  assert.equal(job?.status,'PASS','隔离脚本运行应通过');
  await page.goto(app.url+'/reports/'+job.id);await page.getByRole('heading',{name:'测试用例执行报告',exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/参数传递/);
  const download=await fetch(app.url+'/artifacts/'+job.id+'/'+encodeURIComponent('产物/preview.html'));
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/);
  await page.goto(app.url+'/?trace='+job.id);await page.getByRole('heading',{name:'Trace 记录',exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/没有取得会话 ID/);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(dir,'自检Trace.png'),fullPage:true});
  return {checks:['Node运行时','16条入口及参数协议','用例工作簿','隔离配置与脚本执行','内置浏览器真实渲染','报告与产物下载','Trace页面'],evidenceDirectory:dir};
 }finally{
  if(browser)await browser.close();if(app)await new Promise(r=>app.server.close(r));
  if(previous===undefined)delete process.env.MW_FIXTURE_DIR;else process.env.MW_FIXTURE_DIR=previous;
 }
}

export async function runPackageCheck({selfTest=process.argv.includes('--self-test')}={}){
 try{
  const result=await selfTestPackage();console.log('包自检完成：'+result.checks.join('、'));console.log('自检证据：'+result.evidenceDirectory);
  if(selfTest){console.log('CHECKED：仅验证测试平台，不代表16条产品用例通过。');return 0;}
  const blocked=[];
  try{await fs.access(testEnvironment.clientExecutable);}catch{blocked.push('未发现 MobileWork，请安装客户端或配置 config/environment.json');}
  const build=await readCdpConfig();console.log('客户端版本：'+build.version+'；packagedCdpAllowed='+build.allowed);
  if(build.allowed!==true)blocked.push(build.error||'需要在页面启用 CDP 并正常重启客户端');
  const cdp=await probeCdp(Number(process.env.MW_CDP_PORT||9223));if(!cdp.connected)blocked.push('未连接到 CDP '+cdp.port+' 的 MobileWork 主界面');
  const missing=[];for(const name of new Set(clientCases.flatMap(c=>c.skills)))try{await fs.access(path.join(testEnvironment.skillsRoot,name,'SKILL.md'));}catch{missing.push(name);}
  if(missing.length)blocked.push('目标客户端缺少预期 Skills：'+missing.join('、'));
  if(blocked.length){for(const message of blocked)console.log('BLOCKED：'+message);return 2;}
  console.log('CHECKED：环境可用；模型、具体任务状态和功能结果由用例执行时继续核对。');return 0;
 }catch(e){console.error('包检查失败：'+e.message);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.slice(2).some(a=>a!=='--self-test')){console.error('参数仅支持 --self-test');process.exitCode=1;}
 else process.exitCode=await runPackageCheck();
}
