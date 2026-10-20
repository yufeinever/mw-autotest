import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole,projectRoot} from './server.mjs';
import {normalizeConfig,approvalLabels} from './policy.mjs';
import {handleConfiguredDialog,selectModel} from '../scripts/mobilework-run-policy.mjs';
import {renderReport} from './report.mjs';

test('参数校验',()=>{assert.equal(normalizeConfig().approval,'once');assert.throws(()=>normalizeConfig({question:'custom'}));assert.throws(()=>normalizeConfig({approval:'bad'}));assert.throws(()=>normalizeConfig({cdpPort:0}));});

test('紧凑脚本表分页、跨页范围和全部执行、固定参数及部分提交失败',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-script-pagination-'));
 const {server,url}=await createConsole({port:0,dataDir:dir});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const scripts=Array.from({length:18},(_,i)=>({id:'script-'+(i+1),name:'分页脚本'+(i+1),path:'D:/测试脚本/case'+(i+1)+'.mjs',exists:true,integrated:true}));
  const mock={token:'isolated-token',capabilities:{taskScheduling:1},config:normalizeConfig(),scripts,jobs:[{id:'job-16',scriptId:'script-16',status:'RUNNING',pid:123}],active:1,readingModels:false};
  const requests=[],stops=[];let failAt=0,holdNext=false,release,held;
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  // All client, configuration and run traffic is intercepted: no MobileWork tasks.
  await page.route('**/api/**',async route=>{
   const request=route.request(),pathname=new URL(request.url()).pathname;
   if(pathname==='/api/state')return route.fulfill({json:mock});
   if(pathname==='/api/cdp-config')return route.fulfill({json:{allowed:true,connected:true,version:'mock',port:9223}});
   if(pathname==='/api/config')return route.fulfill({json:request.postDataJSON()});
   if(pathname==='/api/batches')return route.fulfill({status:201,json:{id:'mock-batch'}});
   if(pathname==='/api/batches/mock-batch/complete')return route.fulfill({json:{id:'mock-batch'}});
   if(pathname==='/api/run'){
    const body=request.postDataJSON();requests.push(body);
    if(holdNext){holdNext=false;await new Promise(resolve=>{release=resolve;held();});}
    if(failAt===requests.length)return route.fulfill({status:400,json:{error:'模拟提交失败'}});
    return route.fulfill({status:202,json:{id:'new-job-'+requests.length}});
   }
   if(pathname.endsWith('/stop')){stops.push(pathname);return route.fulfill({json:{message:'模拟停止成功'}});}
   throw Error('不应访问实际接口：'+pathname);
  });
  await page.goto(url);await page.getByText('脚本执行中',{exact:true}).waitFor();
  const serial=page.locator('#scriptSection').getByRole('radio',{name:'串行',exact:true});
  const parallel=page.locator('#scriptSection').getByRole('radio',{name:'并行（不用等模型）',exact:true});
  assert.equal(await serial.isChecked(),true,'默认勾选串行，策略位于脚本列表');assert.equal(await parallel.isChecked(),false);
  await parallel.check();assert.equal(await serial.isChecked(),false);assert.equal(await page.locator('#maxParallel').isEnabled(),true);
  await serial.check();assert.equal(await parallel.isChecked(),false);assert.equal(await page.locator('#maxParallel').isDisabled(),true);
  const rows=page.locator('#scripts tr');assert.equal(await rows.count(),5);
  assert.match(await page.locator('#scriptPageInfo').innerText(),/共 18 条.*第 1 \/ 4 页/);
  assert.equal(await page.locator('#scripts .script-title').first().getAttribute('title'),scripts[0].path);
  assert.ok((await rows.first().boundingBox()).height<55,'紧凑行高小于55px');
  await page.locator('#scriptNextPage').click();assert.equal(await rows.first().getAttribute('data-script-number'),'6');
  await page.waitForResponse(r=>r.url()===url+'/api/state');assert.equal(await rows.first().getAttribute('data-script-number'),'6','自动刷新保留页码');
  await page.locator('#scriptNextPage').click();await page.locator('#scriptNextPage').click();
  assert.equal(await rows.count(),3);assert.equal(await rows.first().getAttribute('data-script-number'),'16');
  assert.equal(await page.locator('#scriptNextPage').isDisabled(),true);
  await rows.first().getByRole('button',{name:'强制停止',exact:true}).click();assert.deepEqual(stops,['/api/jobs/job-16/stop']);
  for(const value of ['','0-2','7-3','1-19','1.5-4','2']){
   await page.locator('#scriptRange').fill(value);await page.locator('#runRange').click();await page.locator('#batchMessage.error').waitFor();
  }
  assert.equal(requests.length,0,'无效范围不会启动脚本');
  await page.getByRole('radio',{name:'第二项',exact:true}).check();await page.getByRole('radio',{name:'在会话期间允许',exact:true}).check();
  await page.locator('#scriptRange').fill('4-7');holdNext=true;const waiting=new Promise(resolve=>held=resolve);
  await page.locator('#runRange').click();await waiting;
  assert.equal(await page.locator('#runAll').isDisabled(),true);
  await page.getByRole('radio',{name:'第一项',exact:true}).check();release();
  await page.locator('#batchMessage').getByText(/已加入队列 4 条/).waitFor();
  assert.deepEqual(requests.map(r=>r.scriptId),['script-4','script-5','script-6','script-7']);
  assert.ok(requests.every(r=>r.config.question==='second'&&r.config.approval==='session'),'所有跨页任务固定使用点击时的参数');
  assert.equal(await rows.first().getAttribute('data-script-number'),'16','范围执行不改变当前页码');
  assert.ok(requests.every(r=>r.config.executionStrategy==='serial'));assert.equal(await page.locator('#maxParallel').isDisabled(),true);
  await parallel.check();await page.locator('#maxParallel').fill('2');
  requests.length=0;await page.locator('#runAll').click();await page.locator('#batchMessage').getByText(/已加入队列 18 条/).waitFor();
  assert.ok(requests.every(r=>r.config.executionStrategy==='parallel'&&r.config.maxParallel===2));
  assert.deepEqual(requests.map(r=>r.scriptId),scripts.map(s=>s.id),'全部执行覆盖所有分页');
  assert.ok(requests.every(r=>r.config.question==='first'));
  requests.length=0;failAt=3;await page.locator('#scriptRange').fill('2-6');await page.locator('#runRange').click();
  await page.locator('#batchMessage.error').getByText(/已加入队列 2 \/ 5 条.*模拟提交失败/).waitFor();
  assert.deepEqual(requests.map(r=>r.scriptId),['script-2','script-3','script-4'],'部分提交失败停止后续且不重试');
  assert.equal(await page.locator('#runAll').isEnabled(),true);
  await page.locator('#scriptPageSize').selectOption('10');assert.equal(await rows.count(),10);assert.equal(await rows.first().getAttribute('data-script-number'),'1');
  await page.locator('#scriptNextPage').click();assert.equal(await rows.count(),8);await page.locator('#scriptPrevPage').click();assert.equal(await rows.first().getAttribute('data-script-number'),'1');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('页面、接口、脚本执行和报告',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-console-test-'));process.env.MW_FIXTURE_DIR=dir;
 const {server,url}=await createConsole({port:0,dataDir:dir,modelReader:async()=>({models:[{name:'mock-model',selected:true,disabled:false}]})});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const state=await(await fetch(url+'/api/state')).json();
  const post=(route,body,extra={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','x-console-token':state.token,...extra},body:JSON.stringify(body)});
  assert.equal((await post('/api/config',{}, {origin:'http://evil.example'})).status,403);
  assert.equal((await post('/api/config',{question:'custom'})).status,400);
  const page=await browser.newPage({viewport:{width:1400,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.getByText('本机服务已连接',{exact:true}).waitFor();
  await page.getByRole('radio',{name:'自定义',exact:true}).check();await page.locator('#customText').fill('模拟自定义内容');await page.getByRole('radio',{name:'在会话期间允许',exact:true}).check();
  await page.getByRole('button',{name:'从客户端读取模型'}).click();await page.waitForFunction(()=>document.querySelector('#model').options.length===2);await page.locator('#model').selectOption('mock-model');
  await page.getByRole('button',{name:'＋ 添加脚本'}).click();await page.locator('#scriptName').fill('隔离验证脚本');await page.getByRole('button',{name:'浏览本机文件'}).click();await page.locator('#files button').first().waitFor();
  await page.locator('#scriptPath').fill(path.join(projectRoot,'local-console','fixture-script.mjs'));await page.getByRole('button',{name:'添加',exact:true}).click();
  const row=page.getByRole('row').filter({hasText:'隔离验证脚本'});await row.getByRole('button',{name:'执行',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#connection').textContent==='脚本执行中');
  const live=await(await fetch(url+'/api/state')).json();assert.ok(live.active);
  assert.ok(live.scripts.length>=16);
  await page.waitForFunction(()=>document.querySelector('#historyRows .result-pass')?.textContent==='通过',null,{timeout:15000});
  assert.equal(await page.locator('#historyRows').getByRole('link',{name:'查看批次',exact:true}).count(),1);
  assert.equal(await page.locator('#historyRows').getByRole('link',{name:'查看报告',exact:true}).count(),0);
  let doneJob;for(let i=0;i<30;i++){const s=await(await fetch(url+'/api/state')).json();doneJob=s.jobs.at(-1);if(doneJob.status==='PASS')break;await new Promise(r=>setTimeout(r,300));}assert.equal(doneJob.status,'PASS');
  const detail=await browser.newPage();await detail.goto(url+'/?batch='+doneJob.batchId);await detail.getByRole('heading',{name:'执行批次详情',exact:true}).waitFor();
  await detail.locator('#batchCaseRows').getByRole('link',{name:'查看报告',exact:true}).waitFor();assert.match(await detail.locator('body').innerText(),/隔离验证脚本/);await detail.close();
  const reportPage=await browser.newPage();const reportUrl=url+'/reports/'+doneJob.id;await reportPage.goto(reportUrl);
  await reportPage.getByRole('heading',{name:'测试用例执行报告',exact:true}).waitFor();assert.match(await reportPage.locator('body').innerText(),/参数传递/);
  const after=await(await fetch(url+'/api/state')).json();const job=after.jobs.at(-1);assert.equal(job.status,'PASS');assert.equal(job.config.question,'custom');assert.equal(job.config.customText,'模拟自定义内容');assert.equal(job.config.approval,'session');assert.equal(job.config.model,'mock-model');
  assert.match(await(await fetch(url+'/artifacts/'+job.id+'/'+encodeURIComponent('执行报告.md'))).text(),/模拟脚本通过/);
  const download=await fetch(url+'/artifacts/'+job.id+'/'+encodeURIComponent('产物/preview.html'));
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(download.headers.get('content-type'),'application/octet-stream');
  assert.match(await reportPage.locator('body').innerText(),/真实产物/);
  const tracePage=await browser.newPage();await tracePage.goto(url+'/traces/'+job.id);
  await tracePage.getByRole('heading',{name:'Trace 记录',exact:true}).waitFor();assert.match(await tracePage.locator('body').innerText(),/没有取得会话 ID/);
  assert.notEqual((await fetch(url+'/artifacts/'+job.id+'/%2e%2e%5csettings.json')).status,200);
  assert.equal((await post('/api/scripts',{path:path.join(projectRoot,'local-console','fixture-script.mjs')})).status,400);
  await page.screenshot({path:path.join(projectRoot,'local-console','preview.png'),fullPage:true});assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));delete process.env.MW_FIXTURE_DIR;}
});

test('弹窗策略和模型切换模拟验证',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();const capture=async()=>{},log=()=>{};
  for(const question of ['first','second','custom']){
   // Match the real renderer: adjacent spans with no whitespace in textContent.
   await page.setContent(`<main><section><button aria-label="上一题" disabled>←</button><button onclick="window.choice=1;document.querySelector('#send').disabled=false"><span>1</span><span>第一选项</span></button><button onclick="window.choice=2;document.querySelector('#send').disabled=false"><span>2</span><span>第二选项</span></button><input type="text" placeholder="其他补充..." oninput="document.querySelector('#send').disabled=false"><footer><button>跳过</button><button id="send" disabled onclick="window.sent=true">发送</button></footer></section></main>`);
   await page.evaluate(()=>{window.choice=null;window.sent=false;});
   const began=Date.now();
   assert.equal(await handleConfiguredDialog(page,normalizeConfig({question,customText:'我的回答'}),capture,log),true);
   assert.ok(Date.now()-began>=1000);
   assert.equal(await page.evaluate(()=>window.sent),true);
   if(question==='custom')assert.equal(await page.locator('input').inputValue(),'我的回答');else assert.equal(await page.evaluate(()=>window.choice),question==='first'?1:2);
  }
  for(const [approval,label] of Object.entries(approvalLabels)){
   await page.setContent('<section>'+Object.values(approvalLabels).map(x=>`<button onclick="window.approved=this.textContent">${x}</button>`).join('')+'</section>');
   for(let repeat=0;repeat<2;repeat++){
    await page.evaluate(()=>{window.approved=null;});const began=Date.now();
    await handleConfiguredDialog(page,normalizeConfig({approval}),capture,log);assert.equal(await page.evaluate(()=>window.approved),label);assert.ok(Date.now()-began>=1000);
   }
  }
  await page.setContent('<section><button><span>1</span><span>唯一选项</span></button><footer><button>跳过</button><button>发送</button></footer></section>');
  await assert.rejects(()=>handleConfiguredDialog(page,normalizeConfig({question:'second'}),capture,log),/没有2个选项/);
  await page.setContent(`<div><button aria-expanded="false" aria-label="模型" onclick="document.querySelector('[role=listbox]').hidden=false">模型</button><button>运行任务</button><div role="listbox" hidden><div role="option" data-checked="false" onclick="this.setAttribute('data-checked','true');this.parentNode.hidden=true"><span class="truncate">mock-model</span></div></div></div><script>document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('[role=listbox]').hidden=true})</script>`);
  assert.equal(await selectModel(page,'mock-model'),'mock-model');
 }finally{await browser.close();}
});

test('重复出现的问题每次选择第一项，报告按时间展示并转义内容',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();
  await page.setContent(`<section><button onclick="window.choice=1"><span>1</span><span>第一项</span></button><button onclick="window.choice=2"><span>2</span><span>第二项</span></button><footer><button>跳过</button><button onclick="window.answers.push(window.choice);window.choice=null">发送</button></footer></section><script>window.answers=[]</script>`);
  for(let i=0;i<3;i++)await handleConfiguredDialog(page,normalizeConfig(),async()=>{},()=>{});
  assert.deepEqual(await page.evaluate(()=>window.answers),[1,1,1]);
 }finally{await browser.close();}
 const html=renderReport({id:'test',name:'<script>alert(1)</script>',status:'PASS',config:{},result:{events:[{time:'2026-10-15T01:00:01Z',step:'中间事件'}],evidence:[{time:'2026-10-15T01:00:00Z',step:'第一张',screenshot:'第一张.png'},{time:'2026-10-15T01:00:02Z',step:'第二张',screenshot:'第二张.png'}]}});
 assert.ok(html.indexOf('第一张')<html.indexOf('中间事件'));assert.ok(html.indexOf('中间事件')<html.indexOf('第二张'));assert.match(html,/<img /);assert.ok(!html.includes('<script>'));
});
