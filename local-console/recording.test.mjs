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
const exec=promisify(execFile);
async function until(fn){for(let n=0;n<150;n++){const result=await fn();if(result)return result;await delay(100);}throw Error('等待定向验证超时');}
async function fixture(){
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1000,height:650}});
 await page.setContent('<h1>隔离录像验证，无产品任务</h1><div style="font-size:50px" id="counter"></div><script>setInterval(()=>counter.textContent=Date.now(),100)</script>');
 const connect=async()=>({contexts:()=>[{pages:()=>[{url:()=>'/MobileWork/resources/app-dist/index.html',context:()=>({newCDPSession:()=>page.context().newCDPSession(page)})}]}],close:async()=>{}});
 return {browser,connect};
}

test('录像默认值、参数边界及编码选项',()=>{
 assert.deepEqual(normalizeConfig().recording,recordingDefaults);
 const changed=normalizeConfig({recording:{resolution:'1280x720',fps:15,bitrateKbps:800,maxSeconds:60}}).recording;
 assert.equal(changed.fps,15);assert.equal(changed.enabled,true);
 for(const bad of [{fps:31},{bitrateKbps:0},{maxSeconds:181},{maxSeconds:0},{resolution:'999999x999999'},{enabled:'false'}])assert.throws(()=>normalizeConfig({recording:bad}));
 const args=encoderArgs(recordingDefaults,'file.mp4');assert.ok(args.includes('libx264'));assert.ok(args.includes('600k'));assert.ok(args.includes('30'));assert.ok(args.includes('180'));assert.ok(args.includes('-an'));
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
 const {server,url}=await createConsole({port:0,dataDir,recorderFactory:async options=>{starts++;const recorder=new PageRecorder({...options,connect});await recorder.start();return recorder;}});
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
