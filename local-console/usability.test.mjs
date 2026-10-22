import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createConsole} from './server.mjs';
import {normalizeConfig} from './policy.mjs';
import {TaskScheduler} from './task-scheduler.mjs';
import {renderReport} from './report.mjs';
import {findScriptCase} from './detail-preview.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';

test('用例描述按完整路径映射，覆盖独立入口001/002并排除同名自定义脚本',()=>{
 const root='D:\\workspace\\Mobilework-test';
 for(const n of [1,2,16])assert.equal(findScriptCase({path:root+'/scripts/run-client-case'+String(n).padStart(3,'0')+'.mjs'},root)?.number,n);
 assert.equal(findScriptCase({path:'D:/other/run-client-case001.mjs',name:'日程管理'},root),null);
 assert.equal(findScriptCase({path:root+'/scripts/run-client-case001.mjs'},undefined),null);
});

test('旧并行参数归一为串行，等待模型与未完成交接均不能放行下条',()=>{
 assert.equal(normalizeConfig({executionStrategy:'parallel',maxParallel:16}).executionStrategy,'serial');
 assert.equal(normalizeConfig({executionStrategy:'parallel',maxParallel:16}).maxParallel,1);
 const scheduler=new TaskScheduler(),a={id:'a',status:'QUEUED',config:{executionStrategy:'parallel',maxParallel:16,cdpPort:9223}},b={...a,id:'b'};
 scheduler.enqueue(a,{cooperative:true,start:()=>{}});scheduler.enqueue(b,{cooperative:true,start:()=>{}});
 scheduler.acquire('a','PREPARING');scheduler.release('a',{url:'file:///MobileWork/resources/app-dist/index.html#/session/ses_a',sessionId:'ses_a'});
 assert.equal(b.status,'QUEUED');assert.equal(scheduler.nextStatus('a').ready,false);assert.throws(()=>scheduler.advance('a','b'),/取消并行/);
 a.status='BLOCKED';scheduler.finish('a',{unresolved:true});assert.equal(b.status,'QUEUED');
 scheduler.finish('a');assert.equal(b.status,'RUNNING');
});

test('源码接口只读已登记脚本且要求凭证，勾选批次按序号记录并禁用旧并行入口',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-source-ui-')),script=path.join(dir,'fixture.mjs');
 await fs.writeFile(script,'// MW_TEST_CONFIG_JSON\nconst text = "<script>test</script>";');
 const {server,url}=await createConsole({port:0,dataDir:dir});
 try{
  const state=await (await fetch(url+'/api/state')).json(),headers={'content-type':'application/json','x-console-token':state.token};
  const created=await (await fetch(url+'/api/scripts',{method:'POST',headers,body:JSON.stringify({name:'源码测试',path:script})})).json();
  const next=await (await fetch(url+'/api/state')).json(),registered=next.scripts.find(s=>s.path===script);assert.ok(registered,JSON.stringify(created));
  assert.equal((await fetch(url+'/api/scripts/'+registered.id+'/source')).status,403);
  const source=await (await fetch(url+'/api/scripts/'+registered.id+'/source',{headers})).json();assert.match(source.content,/<script>test/);
  assert.equal((await fetch(url+'/api/scripts/not-registered/source',{headers})).status,404);
  const ids=[next.scripts[2].id,next.scripts[0].id];
  const batch=await (await fetch(url+'/api/batches',{method:'POST',headers,body:JSON.stringify({mode:'selected',scriptIds:ids,config:{executionStrategy:'parallel',maxParallel:3}})})).json();
  const detail=await (await fetch(url+'/api/batches/'+batch.id)).json();
  assert.deepEqual(detail.entries.map(e=>e.number),[1,3]);assert.equal(detail.config.executionStrategy,'serial');
  assert.equal((await fetch(url+'/api/jobs/old/next',{method:'POST',headers,body:'{}'})).status,409);
 }finally{await new Promise(r=>server.close(r));}
});

async function withUI(run,prepare=()=>{}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-usability-')),{server,url}=await createConsole({port:0,dataDir:dir});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],errors=[];
  const projectRoot='D:/workspace/Mobilework-test';
  const scripts=Array.from({length:8},(_,i)=>({id:'s'+(i+1),name:'用例 '+(i+1),path:i===6?'D:/custom/run-client-case007.mjs':projectRoot+'/scripts/run-client-case'+String(i+1).padStart(3,'0')+'.mjs',exists:true,integrated:true}));
  const jobs=scripts.map((s,i)=>({id:'j'+(i+1),scriptId:s.id,name:s.name,status:'PASS',sessionId:'ses_test',startedAt:'2026-10-22T01:00:00Z'}));
  const state={projectRoot,token:'test',config:normalizeConfig(),capabilities:{taskIsolation:2,taskScheduling:1,serialOnly:1,scriptSource:1,detailPreview:1},scripts,jobs,batches:[],active:0};
  prepare(state);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const req=route.request(),pathname=new URL(req.url()).pathname;
   if(pathname==='/api/state')return route.fulfill({json:state});
   if(pathname==='/api/cdp-config')return route.fulfill({json:{allowed:true,connected:true}});
   if(pathname.endsWith('/source'))return route.fulfill({json:{name:'源码',path:'fixture.mjs',content:'// <script>unsafe()</script>\nconsole.log("只读");'}});
   if(req.method()==='POST')requests.push({path:pathname,body:req.postDataJSON()});
   if(pathname==='/api/config')return route.fulfill({json:req.postDataJSON()});
   if(pathname==='/api/batches')return route.fulfill({status:201,json:{id:'batch'}});
   if(pathname==='/api/batches/batch/complete')return route.fulfill({json:{id:'batch'}});
   if(pathname==='/api/run')return route.fulfill({status:202,json:{id:'new-'+requests.length}});
   return route.fulfill({status:404,json:{error:'isolated'}});
  });
  await page.route('**/reports/*',route=>route.fulfill({contentType:'text/html',body:renderReport({...jobs[5],result:{checks:[],evidence:[]}})}));
  await page.goto(url);await page.locator('#scripts tr').last().waitFor();
  await run({page,requests,url});assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}

test('跨页勾选、全选反选与范围互斥，部分用例按原顺序串行提交',async()=>withUI(async({page,requests})=>{
 assert.equal(await page.locator('[name=executionStrategy],#maxParallel,.execute-next').count(),0);
 await page.locator('#scripts .script-choice').nth(1).check();await page.locator('#scriptNextPage').click();await page.locator('#scripts .script-choice').nth(1).check();
 assert.match(await page.locator('#selectionCount').innerText(),/已选 2 条/);
 await page.locator('#runSelected').click();await page.getByText(/执行勾选：已加入队列 2 条/).first().waitFor();
 assert.deepEqual(requests.filter(r=>r.path==='/api/run').map(r=>r.body.scriptId),['s2','s7']);
 assert.ok(requests.filter(r=>r.path==='/api/run').every(r=>r.body.config.executionStrategy==='serial'&&r.body.config.maxParallel===1));
 await page.locator('#selectAllScripts').click();assert.match(await page.locator('#selectionCount').innerText(),/已选 8 条/);
 await page.locator('#invertScripts').click();assert.match(await page.locator('#selectionCount').innerText(),/已选 0 条/);
 await page.locator('#scripts .script-choice').first().check();await page.locator('[name=selectionMode][value=range]').check();
 assert.equal(await page.locator('#scripts .script-choice').first().isDisabled(),true);assert.equal(await page.locator('#selectionControls').isVisible(),false);
 await page.locator('#scriptRange').fill('3-4');await page.locator('#runRange').click();await page.getByText(/执行序号 3-4：已加入队列 2 条/).first().waitFor();
 assert.deepEqual(requests.filter(r=>r.path==='/api/run').slice(-2).map(r=>r.body.scriptId),['s3','s4']);
 await page.locator('[name=selectionMode][value=selected]').check();assert.equal(await page.locator('#scriptRange').inputValue(),'');
 assert.match(await page.locator('#selectionCount').innerText(),/已选 0 条/);
}));

test('报告和Trace加载中可立即返回，保留页码勾选滚动；脚本名展示用例描述',async()=>withUI(async({page,url,requests})=>{
 await page.locator('#scriptNextPage').click();await page.locator('#scripts .script-choice').first().check();await page.locator('#stepInterval').fill('1.7');
 await page.locator('#scripts tr').first().scrollIntoViewIfNeeded();
 const position=await page.evaluate(()=>{window.retainedList=true;return scrollY;});
 await page.locator('#scripts tr').first().getByRole('link',{name:'截图报告'}).click();
 await page.frameLocator('.detail-preview iframe').getByRole('heading',{name:'测试用例执行报告'}).waitFor();
 await page.frameLocator('.detail-preview iframe').getByRole('link',{name:'返回脚本列表'}).click();
 await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 assert.equal(await page.evaluate(()=>window.retainedList),true);assert.equal(await page.locator('#stepInterval').inputValue(),'1.7');
 assert.equal(await page.locator('#scripts tr').first().getAttribute('data-script-number'),'6');assert.equal(await page.locator('#scripts .script-choice').first().isChecked(),true);
 assert.ok(Math.abs(await page.evaluate(()=>scrollY)-position)<5);
 await page.locator('#scripts .script-title').first().click();await page.locator('.case-description').getByRole('heading',{name:'代码开发02-CI/CD流水线'}).waitFor();
 assert.match(await page.locator('.case-description').innerText(),/MW-CLIENT-006/);
 assert.equal(await page.locator('.case-description dd').filter({hasText:/^github$/}).count(),1);
 assert.equal(await page.locator('.detail-preview-body script').count(),0);
 await page.goBack();await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 await page.locator('#scripts .script-title').nth(1).click();await page.getByText('此脚本尚未关联用例描述。当前支持项目内置的前16条用例。').waitFor();
 await page.goBack();await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 assert.deepEqual(requests,[]);
 let release;await page.route(url+'/?trace=*',async route=>{await new Promise(r=>release=r);await route.abort().catch(()=>{});});
 await page.locator('#scripts tr').first().getByRole('link',{name:'Trace 记录'}).click();
 await page.waitForFunction(()=>document.querySelector('.detail-preview').open);
 await page.getByRole('button',{name:'关闭 · 返回列表',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);release?.();
 assert.equal(await page.evaluate(()=>window.retainedList),true);
}));

test('录像紧跟截图报告且绑定最新运行，缺失禁用、失败可退出并保留列表状态',async()=>withUI(async({page,url,requests})=>{
 const row=page.locator('#scripts tr').first();
 assert.deepEqual(await row.locator('.script-evidence > *').allTextContents(),['截图报告','录像','执行日志','Trace 记录']);
 assert.equal(await row.getByRole('button',{name:'录像',exact:true}).isEnabled(),true);
 const missing=page.locator('#scripts tr').nth(1).getByRole('button',{name:'录像',exact:true});
 assert.equal(await missing.isDisabled(),true);assert.match(await missing.getAttribute('title'),/没有已保存/);
 assert.match(await page.locator('#scripts tr').nth(2).getByRole('button',{name:'录像',exact:true}).getAttribute('title'),/录制中/);
 assert.match(await page.locator('#scripts tr').nth(3).getByRole('button',{name:'录像',exact:true}).getAttribute('title'),/录像失败/);
 await page.locator('#scripts .script-choice').first().check();await page.locator('#stepInterval').fill('1.9');
 await page.route('**/recordings/j1-new',route=>route.fulfill({status:404,body:'missing fixture'}));
 await page.locator('#scripts tr').first().getByRole('button',{name:'录像',exact:true}).click();
 await page.getByRole('heading',{name:'用例 1 · 执行录像',exact:true}).waitFor();
 assert.equal(await page.locator('.recording-preview video').getAttribute('src'),'/recordings/j1-new');
 assert.equal(await page.getByRole('link',{name:'下载录像（MP4）'}).getAttribute('href'),url+'/recordings/j1-new/download');
 assert.match(await page.locator('.recording-preview').innerText(),/49.97 秒 · 1.52 MB/);
 await page.getByText('录像加载失败，请尝试下载或在截图报告中核对录像状态。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭 · 返回列表',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 assert.equal(await page.locator('video').count(),0);assert.equal(await page.locator('#scripts .script-choice').first().isChecked(),true);
 assert.equal(await page.locator('#stepInterval').inputValue(),'1.9');assert.deepEqual(requests,[]);
 await page.locator('#scripts tr').first().getByRole('button',{name:'录像',exact:true}).click();
 await page.getByRole('heading',{name:'用例 1 · 执行录像',exact:true}).waitFor();await page.goBack();
 await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);assert.equal(await page.locator('video').count(),0);
},state=>{
 const recording={available:true,status:'COMPLETED',durationSeconds:49.97,bytes:1517103,config:{resolution:'960x540',fps:30,bitrateKbps:400}};
 state.jobs[0].recording=recording;state.jobs[1].recording=recording;
 state.jobs[2].recording={available:false,status:'RECORDING'};state.jobs[3].recording={available:false,status:'ERROR',error:'编码失败'};
 state.jobs.push({...state.jobs[0],id:'j1-new'}, {...state.jobs[1],id:'j2-new',recording:undefined});
}));

test('录像页面显示本地文件夹及历史副本，点击按本次运行打开且手动删除提示明确',async()=>withUI(async({page,requests})=>{
 let deleted=false;const opened=[];
 await page.route('**/api/jobs/j1/recording-locations',route=>route.fulfill({json:{legacy:true,locations:[
  {key:'primary',label:'录像文件夹',directory:'C:/fixture/jobs/j1',file:'C:/fixture/jobs/j1/执行录像.mp4',exists:!deleted,directoryExists:true},
  {key:'report',label:'历史报告副本文件夹',directory:'C:/fixture/runs/case',file:'C:/fixture/runs/case/执行录像.mp4',exists:true,directoryExists:true}
 ]}}));
 await page.route('**/api/jobs/j1/recording-folder',route=>{opened.push({body:route.request().postDataJSON(),token:route.request().headers()['x-console-token']});return route.fulfill({json:{message:'已请求打开文件夹'}});});
 await page.route('**/recordings/j1',route=>route.fulfill({status:404,body:'isolated'}));
 await page.locator('#scripts tr').first().getByRole('button',{name:'录像',exact:true}).click();
 await page.getByText('这条历史录像还有报告副本，释放全部空间需分别清理两处MP4；请保留报告和日志文件。',{exact:true}).waitFor();
 assert.match(await page.locator('.recording-locations').innerText(),/C:\/fixture\/jobs\/j1\/执行录像.mp4/);
 await page.getByRole('button',{name:'打开所在文件夹',exact:true}).click();await page.getByText('已请求打开文件夹',{exact:true}).waitFor();
 await page.getByRole('button',{name:'打开历史副本文件夹',exact:true}).click();await page.getByText('已请求打开文件夹',{exact:true}).waitFor();
 assert.deepEqual(opened,[{body:{location:'primary'},token:'test'},{body:{location:'report'},token:'test'}]);
 await page.getByRole('button',{name:'关闭 · 返回列表',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.detail-preview').open);
 deleted=true;await page.locator('#scripts tr').first().getByRole('button',{name:'录像',exact:true}).click();
 await page.getByText('录像文件已被移动或删除，报告和日志仍保留。',{exact:true}).waitFor();
 assert.equal(await page.locator('.recording-preview video').isVisible(),false);assert.equal(await page.getByRole('link',{name:'下载录像（MP4）'}).count(),0);
 assert.deepEqual(requests,[]);
},state=>{state.capabilities.recordingFolders=1;state.jobs[0].recording={available:true,status:'COMPLETED'};}));

test('关键截图时间可定位并暂停真实视频，只读本次证据且旧历史预览刷新可恢复',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-video-markers-')),file=path.join(dir,'clip.mp4');
 try{
  await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-t','3','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',file],{windowsHide:true});
  const clip=await fs.readFile(file),recording={available:true,status:'COMPLETED',startedAt:'2026-10-22T06:00:00.000Z',durationSeconds:3,config:{fps:30}};
  const evidence=[{step:'连接客户端',time:'2026-10-22T06:00:00.500Z',screenshot:'连接.png'},{step:'发送成功',time:'2026-10-22T06:00:02.125Z',screenshot:'发送.png'},{step:'录制结束后',time:'2026-10-22T06:00:05Z',screenshot:'超时.png'},{step:'未记录时间',screenshot:'无时间.png'}];
  await withUI(async({page,url,requests})=>{
   await page.route('**/recordings/j1-new',route=>{
    const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/),start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),clip.length-1):clip.length-1;
    return route.fulfill({status:range?206:200,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${clip.length}`}:{})},body:clip.subarray(start,end+1)});
   });
   await page.route('**/api/jobs/j1-new/recording-locations',route=>route.fulfill({json:{legacy:false,locations:[{key:'primary',label:'录像文件夹',file:'C:/fixture/clip.mp4',directoryExists:true,exists:true}]}}));
   await page.route('**/api/jobs/j1-new',route=>route.fulfill({json:{recording,result:{evidence}}}));
   await page.locator('#scripts tr').first().getByRole('button',{name:'录像',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
   const target=page.getByRole('button',{name:'跳到录像 00:02：发送成功',exact:true});
   await target.waitFor();await page.locator('video').evaluate(v=>v.play());
   await target.click();await page.waitForFunction(()=>!document.querySelector('video').seeking);
   const actual=await page.locator('video').evaluate(v=>({time:v.currentTime,paused:v.paused,duration:v.duration,seekable:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)]),error:v.error?.message}));
   assert.ok(Math.abs(actual.time-2.125)<0.05,JSON.stringify(actual));assert.equal(actual.paused,true);assert.equal(await target.getAttribute('aria-pressed'),'true');
   assert.equal(await page.getByRole('button',{name:'无法定位：录制结束后',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'无法定位：未记录时间',exact:true}).isDisabled(),true);
   assert.equal(await page.getByRole('link',{name:'查看截图：发送成功',exact:true}).getAttribute('href'),'/artifacts/j1-new/'+encodeURIComponent('发送.png'));
   assert.equal(await page.getByText('旧运行截图',{exact:true}).count(),0);
   // An old browser history entry may predate screenshot markers.
   await page.evaluate(()=>{const state=structuredClone(history.state);delete state.mwPreview.evidence;history.replaceState(state,'',location.href);});
   await page.reload();await page.getByRole('button',{name:'跳到录像 00:02：发送成功',exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);await page.getByRole('button',{name:'跳到录像 00:02：发送成功',exact:true}).click();
   await page.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-2.125)<0.05);
   assert.deepEqual(requests,[]);assert.equal(await page.url(),url+'/');
  },state=>{
   state.capabilities.recordingFolders=1;state.jobs[0].recording=recording;state.jobs[0].result={evidence:[{step:'旧运行截图',time:'2026-10-22T06:00:01Z',screenshot:'old.png'}]};
   state.jobs.push({...state.jobs[0],id:'j1-new',result:{evidence}});
  });
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
