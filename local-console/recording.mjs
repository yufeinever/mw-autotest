import {isClientPageUrl} from './client-page.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright-core';
import ffmpegPath from 'ffmpeg-static';

export const recordingFile='执行录像.mp4';
const timeout=(promise,ms,message)=>{
 let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
};
export function encoderArgs(config,file){
 const [width,height]=config.resolution.split('x');
 return ['-hide_banner','-loglevel','error','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(config.fps),'-i','pipe:0','-an',
  '-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
  '-c:v','libx264','-preset','veryfast','-threads','2','-b:v',config.bitrateKbps+'k','-maxrate',config.bitrateKbps+'k','-bufsize',config.bitrateKbps*2+'k',
  '-r',String(config.fps),'-t',String(config.maxSeconds),'-movflags','+faststart',file];
}

// The controller owns the encoder, independently of the script process. A
// forced script stop can therefore still flush and finalize its own video.
export class PageRecorder {
 constructor({config,directory,cdpPort,onChange=async()=>{},connect=()=>chromium.connectOverCDP('http://127.0.0.1:'+cdpPort,{timeout:4000}),executable=ffmpegPath}){
  Object.assign(this,{config,directory,onChange,connect,executable});
  this.state={status:'STARTING',config:{...config},source:'MobileWork 页面',capturedFrames:0,encodedFrames:0};
  this.file=path.join(directory,recordingFile);this.partial=path.join(directory,'执行录像.partial.mp4');
 }
 async publish(){await this.onChange({...this.state}).catch(()=>{});}
 async start(){
  this.startPromise=this.open().catch(async error=>{this.state.error=error.message;await this.stop('error');});
  await this.startPromise;return this;
 }
 async open(){
  if(!this.executable)throw Error('当前平台没有录像编码器');
  await fs.access(this.executable).catch(()=>{throw Error('缺少录像编码器，请运行 npm run recording:setup');});
  this.browser=await this.connect();
  if(this.stopping)return;
  const pages=this.browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
  if(pages.length!==1)throw Error('录像未找到唯一 MobileWork 主页面');
  this.session=await timeout(pages[0].context().newCDPSession(pages[0]),2000,'建立页面录像连接超时');
  const [maxWidth,maxHeight]=this.config.resolution.split('x').map(Number);
  const first=await timeout(this.session.send('Page.captureScreenshot',{format:'jpeg',quality:75,captureBeyondViewport:false}),3000,'录像首帧超时');
  if(this.stopping)return;
  this.latest=Buffer.from(first.data,'base64');this.state.capturedFrames=1;
  this.session.on('Page.screencastFrame',event=>{
   this.session.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
   if(!this.stopping){this.latest=Buffer.from(event.data,'base64');this.state.capturedFrames++;}
  });
  this.session.on('Page.screencastVisibilityChanged',event=>{
   if(!event.visible)this.state.visibilityWarning='录制期间页面曾不可见，部分画面可能未更新';
  });
  await timeout(this.session.send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth,maxHeight,everyNthFrame:1}),2500,'页面录制启动超时');
  if(this.stopping)return;
  await fs.mkdir(this.directory,{recursive:true});
  this.encoder=spawn(this.executable,encoderArgs(this.config,this.partial),{windowsHide:true,stdio:['pipe','ignore','pipe']});
  let encoderError='';this.encoder.stderr.on('data',chunk=>{encoderError=(encoderError+chunk).slice(-2000);});
  this.exit=new Promise(resolve=>{
   this.encoder.once('error',error=>{this.state.error='录像编码器启动失败：'+error.message;resolve(-1);});
   this.encoder.once('close',code=>{if(code!==0)this.state.error||='录像编码失败：'+(encoderError||'退出码 '+code);resolve(code);});
  });
  this.encoder.stdin.on('error',error=>{if(!this.stopping){this.state.error='录像写入失败：'+error.message;void this.stop('error');}});
  this.epoch=performance.now();this.state.startedAt=new Date().toISOString();this.state.status='RECORDING';
  this.timer=setInterval(()=>{void this.flush().catch(error=>{this.state.error=error.message;void this.stop('error');});},Math.max(5,Math.floor(1000/this.config.fps)));
  this.limit=setTimeout(()=>{void this.stop('limit');},this.config.maxSeconds*1000);
  void this.exit.then(()=>{if(!this.stopping)void this.stop('error');});
  await this.flush();await this.publish();
 }
 async flush(){
  if(this.writing)return this.writing;
  this.writing=(async()=>{
   const target=Math.min(Math.max(1,Math.ceil((performance.now()-this.epoch)/1000*this.config.fps)),this.config.maxSeconds*this.config.fps);
   while(this.state.encodedFrames<target){
    if(!this.encoder?.stdin.writable||this.encoder.stdin.destroyed)throw Error('录像编码管道已关闭');
    const ready=this.encoder.stdin.write(this.latest);this.state.encodedFrames++;
    if(!ready)await timeout(new Promise((resolve,reject)=>{
     const stream=this.encoder.stdin;
     const clear=()=>{stream.off('drain',drain);stream.off('error',error);stream.off('close',closed);};
     const drain=()=>{clear();resolve();},error=e=>{clear();reject(e);},closed=()=>error(Error('录像编码管道意外关闭'));
     stream.once('drain',drain);stream.once('error',error);stream.once('close',closed);
    }),2500,'录像写入超时');
   }
  })().finally(()=>{this.writing=null;});
  return this.writing;
 }
 stop(reason='completed'){
  if(this.stopPromise)return this.stopPromise;
  this.stopping=true;clearInterval(this.timer);clearTimeout(this.limit);
  this.stopPromise=this.finish(reason);return this.stopPromise;
 }
 async finish(reason){
  this.state.status='FINALIZING';await this.publish();
  try{
   if(this.encoder){
    if(this.writing)await this.writing;
    if(!this.state.error)await this.flush();
    this.encoder.stdin.end();
    const code=await timeout(this.exit,10000,'录像保存超时');
    if(code!==0||this.state.error)throw Error(this.state.error||'录像未正常保存');
    await fs.rename(this.partial,this.file);const stat=await fs.stat(this.file);
    if(!stat.size)throw Error('录像文件为空');
    this.state.bytes=stat.size;this.state.status='COMPLETED';this.state.available=true;
   }else this.state.status='ERROR';
  }catch(error){this.state.status='ERROR';this.state.error=error.message;if(this.encoder?.exitCode===null)this.encoder.kill();}
  finally{
   if(this.session){await timeout(this.session.send('Page.stopScreencast'),2000,'结束页面采集超时').catch(()=>{});await timeout(this.session.detach(),2000,'释放页面录像连接超时').catch(()=>{});}
   if(this.browser)await timeout(this.browser.close(),2000,'断开录像连接超时').catch(()=>{});
   this.state.endedAt=new Date().toISOString();this.state.stopReason=reason;
   this.state.durationSeconds=Number((this.state.encodedFrames/this.config.fps).toFixed(2));
   await this.publish();
  }
  return this.state;
 }
}
export async function startRecording(options){const recorder=new PageRecorder(options);await recorder.start();return recorder;}
