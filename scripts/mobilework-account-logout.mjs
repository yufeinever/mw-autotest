import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readAccountSession} from './mobilework-account-settings.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
import {isClientPageUrl} from '../local-console/client-page.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});
const stages=['prepared','submitted','signed-out','relogin'];
export function validateAccountLogout(owned,previous){
 if(!/^[a-f0-9-]{36}$/.test(owned.owner)||!/^[a-f0-9]{64}$/.test(owned.accountIdSha256)||!path.isAbsolute(owned.loginFile)||!isClientPageUrl(owned.originUrl)||!stages.includes(owned.stage)||owned.lastAttemptId!==null&&!/^[a-f0-9-]{36}$/.test(owned.lastAttemptId)||Object.keys(owned).some(key=>!['owner','accountIdSha256','loginFile','originUrl','stage','lastAttemptId'].includes(key)))throw Error('本轮登出恢复归属无效');
 if(previous&&(['owner','accountIdSha256','loginFile','originUrl'].some(key=>previous[key]!==owned[key])||stages.indexOf(owned.stage)<stages.indexOf(previous.stage)))throw Error('不能替换本轮登出恢复身份或回退状态');
}
export function validateReloginMaterial(value,identity,now=Date.now()){
 if(value.source!=='dedicated-mobilework-sms-account'||value.allowLogout!==true||value.accountIdSha256!==identity||!value.phoneNumber?.trim()||!value.captcha?.trim()||!value.state?.trim()||!/^[a-f0-9-]{36}$/.test(value.attemptId)||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now)throw blocked('缺当前专用测试账户有效的登出授权及一次性短信恢复材料，未输出凭据');
 return {phoneNumber:value.phoneNumber,captcha:value.captcha,state:value.state};
}
async function material(file,identity){
 // Credential parse/read errors must not include the file contents in reports.
 let value;try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw blocked('专用账户运行时恢复材料不可读取或格式无效，未输出内容');}
 validateReloginMaterial(value,identity);return value;
}
export async function prepareAccountLogout(context){
 const loginFile=process.env.MW_TEST_ACCOUNT_RELOGIN_FILE;if(!loginFile||!path.isAbsolute(loginFile))throw blocked('真实登出需MW_TEST_ACCOUNT_RELOGIN_FILE提供专用账号授权及短信恢复材料；未退出当前账号');
 const current=await readAccountSession(context.page);if(!current.signedIn||current.validation!=='valid')throw blocked('登出前未确认当前在线有效身份');await material(loginFile,current.accountIdSha256);
 const connection=await readEngineConnection(context.page),statuses=await engineRequest(connection,'/session/status');
 if(Object.values(statuses).some(value=>value.type==='busy'||value.type==='retry'))throw blocked('客户端仍有执行中的会话，未退出登录或停止其他任务');
 const owned={owner:randomUUID(),accountIdSha256:current.accountIdSha256,loginFile,originUrl:context.page.url(),stage:'prepared',lastAttemptId:null};validateAccountLogout(owned);context.resources.accountLogout=owned;await context.checkpointResources();return owned;
}
export async function waitAccountSignedOut(page,{timeout=30000,checkpoint=async()=>{}}={}){
 const end=Date.now()+timeout;
 do{const current=await readAccountSession(page);if(!current.signedIn){await page.locator('[data-testid="sidebar-account-footer"]').waitFor({state:'hidden'});await page.getByRole('button',{name:'验证码登录',exact:true}).filter({visible:true}).waitFor();return current;}await page.waitForTimeout(200);await checkpoint();}while(Date.now()<end);
 throw blocked('本轮登出尚未确认清除登录态，保留恢复归属');
}
export async function releaseAccountLogout(page,resources,{checkpoint=async()=>{},login=normalSmsLogin}={}){
 const owned=resources.accountLogout;if(!owned)return;validateAccountLogout(owned);
 if(owned.stage==='prepared'){delete resources.accountLogout;return;}
 let current=await readAccountSession(page);
 if(owned.stage==='submitted'){
  if(current.signedIn&&current.accountIdSha256!==owned.accountIdSha256)throw blocked('登出恢复时已登录其他账户，未覆盖');
  await waitAccountSignedOut(page,{checkpoint});owned.stage='signed-out';await checkpoint();current=await readAccountSession(page);
 }
 if(current.signedIn&&current.accountIdSha256!==owned.accountIdSha256)throw blocked('登出恢复时已登录其他账户，未覆盖');
 if(!current.signedIn){
  const value=await material(owned.loginFile,owned.accountIdSha256);
  if(owned.lastAttemptId===value.attemptId)throw blocked('本轮短信恢复已尝试，未重复提交同一一次性材料；需更新材料后恢复');
  owned.lastAttemptId=value.attemptId;owned.stage='relogin';await checkpoint();
  const result=await login(page,validateReloginMaterial(value,owned.accountIdSha256));
  if(!result)throw blocked('正常短信接口未完成恢复登录；保留本轮归属，未记录认证响应');
  current=await readAccountSession(page);
 }
 if(!current.signedIn||current.accountIdSha256!==owned.accountIdSha256||current.validation!=='valid')throw blocked('尚未恢复原专用账号在线身份，未放行下一条');
 await page.locator('[data-testid="sidebar-account-footer"]').waitFor({state:'visible',timeout:30000});
 if(page.url()!==owned.originUrl){
  const editors=await page.locator('[contenteditable="true"]').filter({visible:true}).allTextContents();if(editors.some(text=>text.trim()))throw blocked('登录后出现未知草稿，保留现场');
  await page.evaluate(url=>{location.hash=new URL(url).hash;},owned.originUrl);await page.waitForURL(owned.originUrl);
 }
 await page.getByRole('button',{name:'运行任务',exact:true}).filter({visible:true}).waitFor();delete resources.accountLogout;
}
async function normalSmsLogin(page,payload){
 // Discard the full authentication response inside the renderer. Only a
 // boolean may cross into task logs/reports, including on transport failure.
 try{return await page.evaluate(async payload=>Boolean((await window.__MOBILEWORK__.invoke('auth:sms:login',payload))?.ok),payload);}
 catch{throw blocked('恢复登录调用未确认，未输出凭据或认证响应');}
}
export async function readLoggedOutFiles(page){
 if((await readAccountSession(page)).signedIn)throw blocked('仍在登录状态，未读取原登录凭据文件');
 const roots=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('__pathRoots'));
 if(!path.isAbsolute(roots.dataRootDir))throw blocked('未确认当前客户端真实身份存储根目录');
 const result={};
 for(const name of ['session.json','current-account.json']){
  // Only test for the exact cleared object. Never parse, return or log secrets.
  result[name]=/^\s*\{\s*\}\s*$/.test(await fs.readFile(path.join(roots.dataRootDir,name),'utf8'));
 }
 for(const name of ['report-token.json','skill-userInfo.json']){
  try{await fs.stat(path.join(roots.dataRootDir,name));result[name]=false;}catch(error){if(error.code!=='ENOENT')throw error;result[name]=true;}
 }
 return result;
}
