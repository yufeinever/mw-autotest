import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openSettings,releaseSettingsPanel} from './mobilework-account-settings.mjs';
const exec=promisify(execFile),themeFile=fileURLToPath(new URL('mobilework-system-theme.ps1',import.meta.url));
const blocked=message=>Object.assign(Error(message),{blocked:true});
export const fontKey='openwork.desktop-font-zoom.v1',themeKey='openwork.react.settings.theme-mode';
export async function systemTheme(action='Read',value){
 const args=['-NoProfile','-NonInteractive','-File',themeFile,'-Action',action];
 if(action!=='Read')args.push(...(value===null?['-Absent']:['-Value',String(value)]));
 const {stdout}=await exec('powershell.exe',args,{windowsHide:true});return JSON.parse(stdout.trim());
}
export function validateSystemSettings(value,previous){
 if(!/^[a-f0-9-]{36}$/.test(value.owner)||!['font','theme','system-theme'].includes(value.kind)||typeof value.originUrl!=='string'||Object.keys(value).some(key=>!['owner','kind','originUrl','fontStored','fontStyle','themeStored','nativeZoom','osTheme'].includes(key))||value.fontStored!==null&&!Number.isFinite(Number(value.fontStored))||typeof value.fontStyle!=='string'||value.themeStored!==null&&!['system','light','dark'].includes(value.themeStored)||!Number.isFinite(value.nativeZoom)||value.osTheme!==undefined&&value.osTheme!==null&&![0,1].includes(value.osTheme))throw Error('系统设置恢复基线无效');
 if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('不能替换本轮系统设置恢复基线');
}
export async function prepareSystemSettings(context,kind){
 const baseline=await context.page.evaluate(({fontKey,themeKey})=>({fontStored:localStorage.getItem(fontKey),fontStyle:document.documentElement.style.getPropertyValue('--openwork-font-size'),themeStored:localStorage.getItem(themeKey),nativeZoom:window.__OPENWORK_ZOOM_FACTOR__||1}),{fontKey,themeKey});
 const owned={owner:randomUUID(),kind,originUrl:context.page.url(),...baseline};
 if(kind==='system-theme'){
  if(process.env.MW_TEST_ALLOW_SYSTEM_THEME!=='1')throw blocked('180需MW_TEST_ALLOW_SYSTEM_THEME=1授权临时切换Windows应用明暗模式；未修改系统');
  owned.osTheme=(await systemTheme()).appsUseLightTheme;
 }
 validateSystemSettings(owned);context.resources.systemSettings=owned;await context.checkpointResources();return owned;
}
export async function chooseTheme(page,panel,value){
 await panel.getByRole('button',{name:{light:'浅色',dark:'深色',system:'跟随系统'}[value],exact:true}).click();
 await page.waitForFunction(value=>localStorage.getItem('openwork.react.settings.theme-mode')===value&&document.documentElement.dataset.theme===(value==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):value),value);
}
export async function chooseFont(page,panel,index){
 const slider=panel.getByRole('slider',{name:'字体大小',exact:true});await slider.focus();await slider.press('Home');for(let i=0;i<index;i++)await slider.press('ArrowRight');
 await page.waitForFunction(expected=>localStorage.getItem('openwork.desktop-font-zoom.v1')===String(expected),[.75,.875,1.125][index]);
}
export async function readTheme(page){
 return page.evaluate(()=>({stored:localStorage.getItem('openwork.react.settings.theme-mode'),actual:document.documentElement.dataset.theme,systemDark:matchMedia('(prefers-color-scheme: dark)').matches,scheme:getComputedStyle(document.documentElement).colorScheme,background:getComputedStyle(document.body).backgroundColor}));
}
export async function releaseSystemSettings(page,resources,{checkpoint=async()=>{},setSystemTheme=systemTheme}={}){
 const owned=resources.systemSettings;if(!owned)return;validateSystemSettings(owned);
 await releaseSettingsPanel(page,resources);
 await checkpoint();
 if(owned.kind==='system-theme'){
  await setSystemTheme('Restore',owned.osTheme);
  if((await setSystemTheme()).appsUseLightTheme!==owned.osTheme)throw blocked('Windows应用明暗基线尚未恢复');
 }
 if(page.url()!==owned.originUrl)throw blocked('系统设置恢复页面归属变化，保留原值');
 const context={page,resources,checkpointResources:checkpoint},panel=await openSettings(context,'system');
 if(owned.kind==='font'){
  const numeric=owned.fontStored===null?owned.nativeZoom:Number(owned.fontStored),sizes=[.75,.875,1.125];let nearest=0;for(let i=1;i<3;i++)if(Math.abs(sizes[i]-numeric)<Math.abs(sizes[nearest]-numeric))nearest=i;
  await chooseFont(page,panel,nearest);
  // Restore the exact original preference and style, including an absent key.
  // This is cleanup only; business assertions read the product's UI changes.
  await page.evaluate(({owned,fontKey})=>{if(owned.fontStored===null)localStorage.removeItem(fontKey);else localStorage.setItem(fontKey,owned.fontStored);if(owned.fontStyle)document.documentElement.style.setProperty('--openwork-font-size',owned.fontStyle);else document.documentElement.style.removeProperty('--openwork-font-size');},{owned,fontKey});
 }else{
  await chooseTheme(page,panel,owned.themeStored||'system');
  if(owned.themeStored===null)await page.evaluate(key=>localStorage.removeItem(key),themeKey);
 }
 await releaseSettingsPanel(page,resources);delete resources.systemSettings;
}
export async function readTypography(page,sessionId){
 return page.evaluate(sessionId=>{
  const regions={tasks:document.querySelector('[data-testid="recent-tasks-scroll"] button[data-slot="context-menu-trigger"] span'),workspaces:document.querySelector('[data-testid="workspace-section-header"]'),conversation:document.querySelector('[data-session-messages="true"] p'),settings:document.querySelector('[role="dialog"][aria-label="设置"] main input[aria-label="字体大小"]')?.parentElement.querySelector('div.flex.flex-col > span:nth-child(2)')};
  const root=parseFloat(getComputedStyle(document.documentElement).fontSize),items={};
  for(const [name,element] of Object.entries(regions)){
   if(!element){items[name]=null;continue;}const rect=element.getBoundingClientRect(),style=getComputedStyle(element),range=document.createRange();range.selectNodeContents(element);const textBounds=range.getBoundingClientRect();
   items[name]={size:parseFloat(style.fontSize),visible:rect.width>0&&rect.height>0,clipped:style.overflow!=='visible'&&element.scrollWidth>element.clientWidth+1,textExceedsHeight:textBounds.height>rect.height+1};
  }
  return {sessionId,root,stored:localStorage.getItem('openwork.desktop-font-zoom.v1'),items};
 },sessionId);
}
