import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import {normalizeConfig} from './policy.mjs';
import {recordingDefaults} from './recording-config.mjs';
import {PageRecorder,recordingFile,encoderArgs} from './recording.mjs';
import {createConsole,projectRoot} from './server.mjs';
import {recordingMarks,recordingTime} from './recording-timeline.mjs';
const exec=promisify(execFile);
test('截图时间以录像实际开始计算，保持小数精度，范围和缺失时间不能伪造定位',()=>{
 const recording={startedAt:'2026-10-22T06:04:52.520Z',durationSeconds:10};
 const evidence=[{step:'第一张',time:'2026-10-22T06:04:55.939Z',screenshot:'a.png'},{step:'早于开始',time:'2026-10-22T06:04:51Z',screenshot:'b.png'},{step:'超时',time:'2026-10-22T06:05:03Z',screenshot:'c.png'},{step:'无时间',screenshot:'d.png'},{step:'非法时间',time:'invalid',screenshot:'e.png'},{step:'不是截图',time:'2026-10-22T06:04:56Z'}];
 const marks=recordingMarks(recording,evidence);assert.equal(marks.length,5);
 assert.equal(marks[0].offsetSeconds,3.419);assert.equal(marks[0].clock,'14:04:55');assert.equal(marks[0].label,'00:03');assert.equal(marks[0].reason,'');
 assert.match(marks[1].reason,/早于/);assert.match(marks[2].reason,/超出/);assert.match(marks[3].reason,/有效时间/);assert.match(marks[4].reason,/有效时间/);
 assert.match(recordingMarks({},evidence)[0].reason,/缺少录像开始/);
 assert.match(recordingMarks({startedAt:recording.startedAt},evidence)[0].reason,/尚未取得/);
 assert.match(recordingMarks(recording,evidence,2)[0].reason,/超出/,'浏览器实际时长优先');
 assert.equal(recordingTime(3661.9),'01:01:01');
});
async function until(fn){for(let n=0;n<150;n++){const result=await fn();if(result)return result;await delay(100);}throw Error('等待定向验证超时');}
async function fixture(){
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1000,height:650}});
 await page.setContent('<h1>隔离录像验证，无产品任务</h1><div style="font-size:50px" id="counter"></div><script>setInterval(()=>counter.textContent=Date.now(),100)</script>');
 const connect=async()=>({contexts:()=>[{pages:()=>[{url:()=> 'mobilework-shell://app/index.html',context:()=>({newCDPSession:()=>page.context().newCDPSession(page)})}]}],close:async()=>{}});
 return {browser,connect};
}

test('录像默认值、参数边界及编码选项',()=>{
 assert.deepEqual(normalizeConfig().recording,recordingDefaults);
 const changed=normalizeConfig({recording:{resolution:'1280x720',fps:15,bitrateKbps:800,maxSeconds:60}}).recording;
 assert.equal(changed.fps,15);assert.equal(changed.enabled,true);
 for(const seconds of [10,180,181,1800])assert.equal(normalizeConfig({recording:{maxSeconds:seconds}}).recording.maxSeconds,seconds);
 for(const bad of [{fps:31},{bitrateKbps:0},{maxSeconds:1801},{maxSeconds:9},{maxSeconds:10.5},{maxSeconds:0},{resolution:'999999x999999'},{enabled:'false'}])assert.throws(()=>normalizeConfig({recording:bad}));
 const longArgs=encoderArgs(normalizeConfig({recording:{maxSeconds:1800}}).recording,'long.mp4');assert.equal(longArgs[longArgs.indexOf('-t')+1],'1800');
 const args=encoderArgs(recordingDefaults,'file.mp4');assert.ok(args.includes('libx264'));assert.ok(args.includes('600k'));assert.ok(args.includes('30'));assert.ok(args.includes('600'));assert.ok(args.includes('-an'));
});

test('真实隔离页面录制达到上限自动保存，输出分辨率帧率和时长可读，失败独立留证',async()=>{
 const {browser,connect}=await fixture(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'mw-video-limit-'));
 const config={...recordingDefaults,resolution:'640x360',fps:15,bitrateKbps:400,maxSeconds:1};
 let recorder;
 try{
  recorder=new PageRecorder({config,directory,connect});await recorder.start();
  await until(()=>['COMPLETED','ERROR'].includes(recorder.state.status));assert.equal(recorder.state.status,'COMPLETED',recorder.state.error);
  assert.equal(recorder.state.stopReason,'limit');assert.ok(recorder.state.bytes>0);
  assert.equal(recorder.state.encodedFrames,15);assert.equal(recorder.state.durationSeconds,1);
  const {stderr}=await exec(ffmpeg,['-hide_banner','-i',path.join(directory,recordingFile),'-f','null','-'],{windowsHide:true});
  assert.match(stderr,/640x360/);assert.match(stderr,/15 fps/);assert.match(stderr,/Duration: 00:00:01/);
  await recorder.stop('stopped');assert.equal(recorder.state.stopReason,'limit','停止幂等且保留首次原因');
  const failed=new PageRecorder({config,directory,executable:path.join(directory,'missing.exe'),connect});await failed.start();
  assert.equal(failed.state.status,'ERROR');assert.equal(failed.state.available,undefined);assert.match(failed.state.error,/编码器/);
 }finally{await recorder?.stop();await browser.close();}
});

test('控制台强制停止保存真实隔离录像，排队不录，配置快照和播放下载范围正确',async()=>{
 const {browser,connect}=await fixture(),dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-video-http-'));
 let starts=0;
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir,recorderFactory:async options=>{starts++;const recorder=new PageRecorder({...options,connect});await recorder.start();return recorder;}});
 let s=await fetch(url+'/api/state').then(r=>r.json());
 const post=(route,body)=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:JSON.stringify(body)});
 try{
  const script=await post('/api/scripts',{name:'隔离录制夹具',path:path.join(projectRoot,'local-console/fixtures/long-running.mjs')}).then(r=>r.json());
  const config={recording:{fps:24,bitrateKbps:800,maxSeconds:10}};
  const a=await post('/api/run',{scriptId:script.id,config}).then(r=>r.json());
  const b=await post('/api/run',{scriptId:script.id,config}).then(r=>r.json());
  await until(async()=>{const j=await fetch(url+'/api/jobs/'+a.id).then(r=>r.json());if(j.recording?.status==='ERROR')throw Error(j.recording.error);return j.pid&&j.recording?.status==='RECORDING';});
  assert.equal(starts,1);
  assert.equal((await post('/api/jobs/'+b.id+'/stop',{})).status,200);
  assert.equal((await post('/api/jobs/'+a.id+'/stop',{})).status,200);
  const job=await until(async()=>{const j=await fetch(url+'/api/jobs/'+a.id).then(r=>r.json());return j.recording?.status==='COMPLETED'?j:null;});
  assert.equal(job.status,'STOPPED');assert.equal(job.recording.stopReason,'stopped');assert.equal(job.config.recording.fps,24);assert.equal(starts,1);
  const report=await fetch(url+'/reports/'+a.id).then(r=>r.text());assert.match(report,/<video/);assert.match(report,/下载执行录像/);
  const part=await fetch(url+'/recordings/'+a.id,{headers:{range:'bytes=0-99'}});assert.equal(part.status,206);assert.equal((await part.arrayBuffer()).byteLength,100);
  assert.equal((await fetch(url+'/recordings/'+a.id,{headers:{range:'bytes=99999999999-'}})).status,416);
  const download=await fetch(url+'/recordings/'+a.id+'/download');assert.match(download.headers.get('content-disposition'),/attachment/);await download.arrayBuffer();
  assert.equal((await fetch(url+'/recordings/'+b.id)).status,404);
  const current=await fetch(url+'/api/state').then(r=>r.json());assert.equal(current.active,0);
 }finally{
  s=await fetch(url+'/api/state').then(r=>r.json());
  for(const job of s.jobs.filter(j=>['QUEUED','RUNNING'].includes(j.status)))await post('/api/jobs/'+job.id+'/stop',{});
  await new Promise(r=>server.close(r));await browser.close();
 }
});

test('录像本地位置按运行ID限定，兼容历史副本及手动删除，打开文件夹要求凭证',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-video-folder-'));
 const reportDir=await fs.mkdtemp(path.join(projectRoot,'runs','录像目录回归-')),opened=[];
 const oldDir=path.join(dataDir,'jobs','legacy'),singleDir=path.join(dataDir,'recordings','single');
 for(const dir of [oldDir,singleDir,path.join(dataDir,'jobs','single')])await fs.mkdir(dir,{recursive:true});
 const old={id:'legacy',name:'历史录像',status:'PASS',startedAt:'2026-10-22T01:00:00Z',reportPath:path.join(reportDir,'执行报告.md'),recording:{available:true,status:'COMPLETED'}};
 const single={...old,id:'single',reportPath:path.join(dataDir,'outside','执行报告.md'),recording:{...old.recording,storage:'recordings'}};
 for(const job of [old,single])await fs.writeFile(path.join(dataDir,'jobs',job.id,'job.json'),JSON.stringify(job));
 for(const dir of [oldDir,singleDir,reportDir])await fs.writeFile(path.join(dir,recordingFile),'fixture-mp4');
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir,folderOpener:async directory=>{opened.push(directory);}});
 try{
  const state=await fetch(url+'/api/state').then(r=>r.json()),headers={'x-console-token':state.token,'content-type':'application/json'};
  const read=id=>fetch(url+'/api/jobs/'+id+'/recording-locations',{headers});
  const open=(id,body,auth=headers)=>fetch(url+'/api/jobs/'+id+'/recording-folder',{method:'POST',headers:auth,body:JSON.stringify(body)});
  assert.equal((await fetch(url+'/api/jobs/legacy/recording-locations')).status,403);
  assert.equal((await open('legacy',{location:'primary'},{})).status,403);
  assert.equal((await read('unknown')).status,404);
  const info=await read('legacy').then(r=>r.json());assert.equal(info.legacy,true);assert.deepEqual(info.locations.map(l=>l.key),['primary','report']);
  assert.equal(info.locations[0].file,path.join(oldDir,recordingFile));assert.ok(info.locations.every(l=>l.exists));
  assert.equal((await open('legacy',{location:'C:/Windows'})).status,400);
  assert.equal((await open('legacy',{location:'primary',path:'C:/Windows'})).status,200);
  assert.equal((await open('legacy',{location:'report'})).status,200);assert.deepEqual(opened,[oldDir,reportDir]);
  const next=await read('single').then(r=>r.json());assert.equal(next.legacy,false);assert.equal(next.locations.length,1);assert.equal(next.locations[0].directory,singleDir);
  assert.equal((await open('single',{location:'report'})).status,404);
  assert.equal(await fetch(url+'/recordings/single').then(r=>r.text()),'fixture-mp4');
  await fs.unlink(path.join(oldDir,recordingFile));
  assert.equal((await fetch(url+'/recordings/legacy')).status,404);
  const removed=await read('legacy').then(r=>r.json());assert.equal(removed.locations[0].exists,false);assert.equal(removed.locations[1].exists,true);
  assert.equal((await fetch(url+'/api/jobs/legacy').then(r=>r.json())).status,'PASS');
  assert.equal(await fs.readFile(path.join(reportDir,recordingFile),'utf8'),'fixture-mp4');
 }finally{await new Promise(r=>server.close(r));await fs.rm(reportDir,{recursive:true,force:true});await fs.rm(dataDir,{recursive:true,force:true});}
});

test('新执行录像仅存独立录像目录，报告和播放器共用，不复制到运行或报告目录',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-single-video-'));
 const reportDir=await fs.mkdtemp(path.join(projectRoot,'runs','单份录像回归-')),scriptPath=path.join(dataDir,'fixture.mjs');
 await fs.writeFile(path.join(reportDir,'执行报告.md'),'# 隔离测试');await fs.writeFile(path.join(reportDir,'执行结果.json'),JSON.stringify({result:'PASS'}));
 await fs.writeFile(scriptPath,'// MW_TEST_CONFIG_JSON\nconsole.log("报告："+'+JSON.stringify(path.join(reportDir,'执行报告.md'))+');');
 let outputDirectory;
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir,recorderFactory:async options=>{
  outputDirectory=options.directory;await fs.mkdir(outputDirectory,{recursive:true});
  await options.onChange({status:'RECORDING',available:false,config:options.config});
  return {stop:async()=>{await fs.writeFile(path.join(outputDirectory,recordingFile),'one-video');await options.onChange({status:'COMPLETED',available:true,config:options.config,bytes:9});}};
 }});
 try{
  const state=await fetch(url+'/api/state').then(r=>r.json()),headers={'x-console-token':state.token,'content-type':'application/json'};
  const post=(route,body)=>fetch(url+route,{method:'POST',headers,body:JSON.stringify(body)}).then(r=>r.json());
  const script=await post('/api/scripts',{name:'单份录像夹具',path:scriptPath}),created=await post('/api/run',{scriptId:script.id,config:{}});
  const job=await until(async()=>{const current=await fetch(url+'/api/jobs/'+created.id).then(r=>r.json());return current.phase==='FINISHED'?current:null;});
  assert.equal(job.status,'PASS');assert.equal(job.recording.storage,'recordings');assert.equal(job.recording.available,true);
  assert.equal(outputDirectory,path.join(dataDir,'recordings',job.id));assert.equal(await fs.readFile(path.join(outputDirectory,recordingFile),'utf8'),'one-video');
  for(const dir of [reportDir,path.join(dataDir,'jobs',job.id)])await assert.rejects(fs.access(path.join(dir,recordingFile)),{code:'ENOENT'});
  assert.equal(await fetch(url+'/recordings/'+job.id).then(r=>r.text()),'one-video');
  assert.match(await fetch(url+'/reports/'+job.id).then(r=>r.text()),new RegExp('/recordings/'+job.id));
 }finally{await new Promise(r=>server.close(r));await fs.rm(reportDir,{recursive:true,force:true});await fs.rm(dataDir,{recursive:true,force:true});}
});
