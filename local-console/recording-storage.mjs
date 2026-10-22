import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {recordingFile} from './recording.mjs';

const inside=(root,target)=>{const relative=path.relative(root,target);return !!relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
async function location(root,directory,key,label){
 const result={key,label,directory:path.resolve(directory),file:path.join(path.resolve(directory),recordingFile),directoryExists:false,exists:false};
 if(!inside(path.resolve(root),result.directory))throw Error('录像位置超出允许目录');
 try{
  const realRoot=await fs.realpath(root),realDirectory=await fs.realpath(result.directory);
  if(!inside(realRoot,realDirectory))throw Error('录像文件夹超出允许目录');
  result.directory=realDirectory;result.file=path.join(realDirectory,recordingFile);result.directoryExists=true;
  const realFile=await fs.realpath(result.file);
  if(!inside(realDirectory,realFile))throw Error('录像文件超出允许目录');
  const stat=await fs.stat(realFile);result.exists=stat.isFile();result.bytes=result.exists?stat.size:0;
 }catch(error){if(error.code!=='ENOENT')throw error;}
 return result;
}
export async function recordingLocation(job,dataDir){
 if(!/^[\w-]+$/.test(job.id))throw Error('运行ID无效');
 const root=path.join(dataDir,job.recording?.storage==='recordings'?'recordings':'jobs');
 return location(root,path.join(root,job.id),'primary','录像文件夹');
}
export async function recordingLocations(job,{dataDir,runsDir}){
 const primary=await recordingLocation(job,dataDir),locations=[primary];
 if(job.reportPath&&inside(path.resolve(runsDir),path.dirname(path.resolve(job.reportPath)))){
  const copy=await location(runsDir,path.dirname(job.reportPath),'report','历史报告副本文件夹');
  if(copy.exists)locations.push(copy);
 }
 return {locations,legacy:job.recording?.storage!=='recordings'};
}
export async function openWindowsFolder(directory){
 if(process.platform!=='win32')throw Error('自动打开文件夹仅支持Windows，请复制页面中的本地路径');
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe'),[directory],{windowsHide:false,detached:true,stdio:'ignore'});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
 });
}
