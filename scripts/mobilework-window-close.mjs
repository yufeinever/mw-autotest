import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {browserPid} from './mobilework-client-restart.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
const exec=promisify(execFile),helper=fileURLToPath(new URL('mobilework-window-state.py',import.meta.url)),blocked=message=>Object.assign(Error(message),{blocked:true});
export async function windowState(pid,{hwnd,show=false}={}){const {stdout}=await exec(process.env.MW_PYTHON||'python',[helper,'--pid',String(pid),...(hwnd?['--hwnd',String(hwnd)]:[]),...(show?['--show']:[])],{windowsHide:true,encoding:'utf8'});return JSON.parse(stdout);}
export const readClosePreference=page=>page.evaluate(async()=>{const value=await window.__OPENWORK_ELECTRON__.invokeDesktop('getWindowClosePref');return value.closeBehavior;});
export function validateWindowClose(value,previous){
 if(!/^[a-f0-9-]{36}$/.test(value.owner)||!Number.isInteger(value.pid)||value.pid<=0||!Number.isInteger(value.hwnd)||value.hwnd<=0||!['minimize','quit'].includes(value.original)||typeof value.originUrl!=='string'||Object.keys(value).some(key=>!['owner','pid','hwnd','original','originUrl'].includes(key)))throw Error('窗口关闭偏好归属无效');
 if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('不能替换本轮窗口关闭基线');
}
export async function prepareWindowClose(context){
 const states=await engineRequest(await readEngineConnection(context.page),'/session/status');if(Object.values(states).some(s=>s.type!=='idle'))throw blocked('存在其他进行中任务，未点击主窗口关闭');
 const pid=await browserPid(context.page),state=await windowState(pid);if(state.windows.length!==1)throw blocked('未识别唯一可见MobileWork主窗口，未猜测句柄');
 const owned={owner:randomUUID(),pid,hwnd:state.windows[0].hwnd,original:await readClosePreference(context.page),originUrl:context.page.url()};validateWindowClose(owned);context.resources.windowClose=owned;await context.checkpointResources();return owned;
}
export async function chooseClosePreference(page,panel,value){
 await panel.getByRole('combobox',{name:'窗口关闭行为偏好设置',exact:true}).click();
 const options=page.getByRole('option').filter({visible:true}),labels=await options.allTextContents();
 if(labels.length!==2||!['最小化到系统托盘','直接退出应用'].every(text=>labels.some(label=>label.trim()===text)))throw blocked('实际窗口关闭选项与当前约定不符，未按位置选择');
 await page.getByRole('option',{name:value==='minimize'?'最小化到系统托盘':'直接退出应用',exact:true}).click();await page.waitForFunction(async value=>(await window.__OPENWORK_ELECTRON__.invokeDesktop('getWindowClosePref')).closeBehavior===value,value);return labels;
}
export async function releaseWindowClose(page,resources,{inspect=windowState}={}){
 const owned=resources.windowClose;if(!owned)return;validateWindowClose(owned);
 const state=await inspect(owned.pid,{hwnd:owned.hwnd});if(state.windows.length!==1)throw blocked('原MobileWork窗口已不存在，未操作其他窗口');
 if(!state.windows[0].visible){const restored=await inspect(owned.pid,{hwnd:owned.hwnd,show:true});if(restored.windows.length!==1||!restored.windows[0].visible)throw blocked('本轮主窗口尚未恢复显示');}
 await page.evaluate(value=>window.__OPENWORK_ELECTRON__.invokeDesktop('setWindowClosePref',value),owned.original);if(await readClosePreference(page)!==owned.original)throw blocked('原窗口关闭偏好恢复未确认');delete resources.windowClose;
}
