import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const execFile=promisify(execFileCallback);
const blocked=message=>Object.assign(Error(message),{blocked:true});

async function invokePicker(pid,args){
 let result;
 try{result=await execFile(process.env.MW_PYTHON||'python',[path.join(root,'scripts/mobilework-folder-picker.py'),'--pid',String(pid),...args],{cwd:root,windowsHide:true,encoding:'utf8'});}
 catch(error){if(!error.stdout)throw error;result=error;}
 return JSON.parse(String(result.stdout).trim().split(/\r?\n/).at(-1));
}

export async function inspectClientNativeFolders(page){
 const cdp=await page.context().browser().newBrowserCDPSession();let pid;
 try{pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id;}
 finally{await cdp.detach();}
 if(!Number.isInteger(pid))throw blocked('无法确认当前MobileWork进程，未核对原生窗口');
 const result=await invokePicker(pid,['--inspect']);
 if(!result.ok)throw blocked('原生窗口交接检查失败：'+result.error);
 return {pid,dialogs:result.dialogs};
}

export async function closeOwnedNativeFolder(owned){
 const result=await invokePicker(owned.pid,['--cancel',String(owned.hwnd),'--path',owned.path]);
 if(!result.ok||!result.dialogClosed||result.alreadyClosed)throw blocked('本轮原生文件夹窗口取消未确认：'+(result.error||'窗口已消失或仍可见'));
 return result;
}
export async function ownedNativeFolderExists(owned){
 const result=await invokePicker(owned.pid,['--window-state',String(owned.hwnd)]);
 if(!result.ok)throw blocked('原生窗口状态检查失败：'+result.error);
 return result.exists;
}

async function beginNativeFolder(control,pid,folder){
 const opening={pid,path:folder,phase:'opening'};
 const state=await control.call('checkpoint',{nativeFolder:opening});
 if(state.stopRequested){
  await control.call('checkpoint',{nativeFolder:null});
  throw blocked('任务已停止，未打开原生文件夹窗口');
 }
 return opening;
}
async function registerNativeFolder(control,opening,found){
 const owned={...opening,hwnd:found.dialog.hwnd,phase:'opened'};
 const state=await control.call('checkpoint',{nativeFolder:owned});
 if(state.stopRequested){
  await closeOwnedNativeFolder(owned);
  await control.call('checkpoint',{nativeFolder:null});
  throw blocked('任务已停止，本轮原生文件夹窗口已取消');
 }
 return owned;
}
async function authorizeNativeConfirmation(control,owned){
 const state=await control.call('checkpoint',{nativeFolder:{...owned,phase:'confirming'}});
 if(state.stopRequested){
  await closeOwnedNativeFolder(owned);
  await control.call('checkpoint',{nativeFolder:{...owned,phase:'cancelled'}});
  throw blocked('任务已停止，本轮原生文件夹窗口已取消');
 }
}
async function finishNativeFolder(control,owned,deferCompletion){
 const state=await control.call('checkpoint',{nativeFolder:deferCompletion?{...owned,phase:'confirmed'}:null});
 if(state.stopRequested)throw blocked('任务已停止，原生选择提交后的产品状态待确认');
}
export async function completeNativeFolder(control,owned){
 const state=await control.call('checkpoint',{nativeFolder:{...owned,phase:'settled'}});
 if(state.stopRequested)throw blocked('任务已停止，本轮目录操作已完成，等待统一收尾');
}

export async function selectNativeFolder(page,{folder,open,dir,control,log=()=>{},beforeConfirm,deferCompletion=false,evidenceLabel=''}){
 const cdp=await page.context().browser().newBrowserCDPSession();
 let pid;
 try{pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id;}
 finally{await cdp.detach();}
 if(!Number.isInteger(pid))throw blocked('无法确认当前MobileWork进程，未操作原生窗口');
 const before=await invokePicker(pid,['--inspect']);
 if(!before.ok||before.dialogs.length)throw blocked('当前MobileWork已有文件夹选择器；保留未知原生窗口，请先处理后重试');
 log('原生选择器预检完成','客户端PID='+pid);
 await fs.mkdir(folder,{recursive:true});
 const opening=await beginNativeFolder(control,pid,folder);
 await open();
 const found=await invokePicker(pid,['--wait','--path',folder]);
 await fs.writeFile(path.join(dir,'原生文件夹控件识别'+evidenceLabel+'.json'),JSON.stringify(found,null,2));
 if(!found.ok||!found.dialogFound)throw blocked('未能识别原生文件夹选择器：'+found.error);
 const owned=await registerNativeFolder(control,opening,found);
 const prepared=await invokePicker(pid,['--prepare','--dialog',String(owned.hwnd),'--path',folder]);
 await fs.writeFile(path.join(dir,'原生文件夹准备'+evidenceLabel+'.json'),JSON.stringify(prepared,null,2));
 if(!prepared.ok||!prepared.dialogFound)throw blocked('未能准备原生文件夹选择器：'+prepared.error);
 await authorizeNativeConfirmation(control,owned);
 if(beforeConfirm)try{await beforeConfirm();}catch(error){
  await closeOwnedNativeFolder(owned);
  await control.call('checkpoint',{nativeFolder:{...owned,phase:'cancelled'}});
  throw error;
 }
 const picked=await invokePicker(pid,['--confirm',String(owned.hwnd),'--path',folder]);
 await fs.writeFile(path.join(dir,'原生文件夹选择器'+evidenceLabel+'.json'),JSON.stringify(picked,null,2));
 if(!picked.ok||!picked.dialogFound||!picked.dialogClosed)throw blocked('原生文件夹选择器未完成：'+(picked.error||'窗口尚未关闭'));
 if(path.resolve(picked.path).toLowerCase()!==path.resolve(folder).toLowerCase())throw blocked('原生选择器回读目录与本轮目录不一致');
 await finishNativeFolder(control,owned,deferCompletion);
 log('原生文件夹选择完成',picked.dialog.title+'；'+picked.path);
 return deferCompletion?{...picked,ownership:owned}:picked;
}

// Negative paths must reach the real chooser unchanged: do not mkdir them or
// use this probe for a successful existing-directory selection.
export async function probeInvalidNativeFolder(page,{folder,open,dir,control}){
 const cdp=await page.context().browser().newBrowserCDPSession();let pid;
 try{pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')?.id;}finally{await cdp.detach();}
 if(!Number.isInteger(pid))throw blocked('未确认当前客户端PID');
 const before=await invokePicker(pid,['--inspect']);if(!before.ok||before.dialogs.length)throw blocked('存在未知目录框，未覆盖');
 const opening=await beginNativeFolder(control,pid,folder);
 await open();const found=await invokePicker(pid,['--wait','--invalid','--path',folder]);if(!found.ok||!found.dialogFound)throw blocked('未识别本轮非法路径选择框');
 const owned=await registerNativeFolder(control,opening,found);
 await authorizeNativeConfirmation(control,owned);
 const actual=await invokePicker(pid,['--invalid','--dialog',String(owned.hwnd),'--path',folder,'--timeout','8']);
 await fs.writeFile(path.join(dir,'原生非法路径-'+path.basename(dir)+'.json'),JSON.stringify(actual,null,2));if(!actual.ok)throw blocked('非法路径原生控件操作未完成');
 if(!actual.dialogClosed){
  await closeOwnedNativeFolder(owned);
  const state=await control.call('checkpoint',{nativeFolder:{...owned,phase:'cancelled'}});
  if(state.stopRequested)throw blocked('任务已停止，本轮原生文件夹窗口已取消');
 }else await finishNativeFolder(control,owned,true);
 return actual.dialogClosed?{...actual,ownership:owned}:actual;
}
