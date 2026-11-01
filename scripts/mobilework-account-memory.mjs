import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openSettings,releaseSettingsPanel} from './mobilework-account-settings.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true}),review=message=>Object.assign(Error(message),{review:true});
export const memoryPath='memory/conversation-memory',memoryEnabledPath='memory/generation-enabled';
export const memoryHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function readMemory(page){
 return page.evaluate(async()=>{
  const bridge=window.__MOBILEWORK__,auth=await bridge.invoke('auth:current');if(!auth.account?.id||auth.oidcValidation!=='valid')throw Error('未确认当前记忆账号在线有效身份');const accountId=auth.account.id;
  const accountIdSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(accountId))))).map(v=>v.toString(16).padStart(2,'0')).join('');
  const read=async path=>(await bridge.invoke('store:read',{accountId,path,fallback:null,strict:true})).value;
  const enabled=await read('memory/generation-enabled'),doc=await read('memory/conversation-memory');
  return {accountIdSha256,rawEnabled:enabled,rawDoc:doc,enabled:enabled??true,doc:doc??{content:'',updatedAt:null},ephemeralIds:JSON.parse(localStorage.getItem('memory/ephemeral-session-ids')||'[]')};
 });
}
export function validateAccountMemory(value,previous){
 if(!/^[a-f0-9-]{36}$/.test(value.owner)||!/^[a-f0-9]{64}$/.test(value.accountIdSha256)||value.originalEnabled!==null&&typeof value.originalEnabled!=='boolean'||value.originalDoc!==null&&(typeof value.originalDoc.content!=='string'||!Number.isFinite(value.originalDoc.updatedAt)&&value.originalDoc.updatedAt!==null)||!Array.isArray(value.sourceSessions)||value.sourceSessions.some(id=>!/^ses_[A-Za-z0-9]+$/.test(id))||Object.keys(value).some(key=>!['owner','accountIdSha256','originalEnabled','originalDoc','sourceSessions'].includes(key)))throw Error('记忆用例恢复基线无效');
 if(value.originalDoc?.content&&!value.originalDoc.content.startsWith('MW-AUTOTEST-MEMORY'))throw Error('仅允许空记忆或明确标记的合成记忆基线');
 if(previous&&(['owner','accountIdSha256','originalEnabled'].some(k=>previous[k]!==value[k])||JSON.stringify(previous.originalDoc)!==JSON.stringify(value.originalDoc)||previous.sourceSessions.some((id,i)=>value.sourceSessions[i]!==id)))throw Error('不能替换本轮记忆恢复基线或来源会话');
}
export async function prepareAccountMemory(context){
 const file=process.env.MW_TEST_MEMORY_ACCOUNT_FILE;if(!file||!path.isAbsolute(file))throw blocked('记忆修改需MW_TEST_MEMORY_ACCOUNT_FILE专用账号显式授权；未改用户记忆');
 const facts=JSON.parse(await fs.readFile(file,'utf8')),current=await readMemory(context.page);
 if(facts.source!=='dedicated-memory-account'||facts.allowMemoryMutation!==true||facts.accountIdSha256!==current.accountIdSha256)throw blocked('未确认专用记忆账号及修改授权');
 if(current.ephemeralIds.length)throw blocked('已有未完成记忆整理，未接管');
 const states=await engineRequest(await readEngineConnection(context.page),'/session/status');if(Object.values(states).some(item=>item.type!=='idle'))throw blocked('存在其他进行中任务，未修改共享账号记忆');
 const owned={owner:randomUUID(),accountIdSha256:current.accountIdSha256,originalEnabled:current.rawEnabled,originalDoc:current.rawDoc,sourceSessions:[]};validateAccountMemory(owned);context.resources.accountMemory=owned;await context.checkpointResources();return owned;
}
export async function chooseMemoryEnabled(page,panel,enabled){
 const toggle=panel.getByRole('switch',{name:'自动生成记忆',exact:true});if((await toggle.getAttribute('aria-checked')==='true')!==enabled)await toggle.click();
 await page.waitForFunction(async enabled=>{const bridge=window.__MOBILEWORK__,auth=await bridge.invoke('auth:current');return (await bridge.invoke('store:read',{accountId:auth.account.id,path:'memory/generation-enabled',fallback:true,strict:true})).value===enabled;},enabled);
}
export async function registerMemorySource(context){return context.control.withUI(context.page,'VERIFYING',async()=>{const id=context.getSessionId(),owned=context.resources.accountMemory;if(!owned.sourceSessions.includes(id)){owned.sourceSessions.push(id);await context.checkpointResources();}});}
export async function observeAutoMemory(context,{before,marker,enabled,timeout=330000,quietMs=20000,read=()=>readMemory(context.page),readSession=()=>context.control.get('/session/'+context.getSessionId()),pause=ms=>context.page.waitForTimeout(ms),now=()=>Date.now(),onSample=async()=>{}}={}){
 const started=now(),samples=[],expectedUser=context.getData().messages.filter(message=>message.info?.role==='user').at(-1).info.id;
 while(now()-started<=timeout){
  const state=await read(),source=await readSession();if(state.accountIdSha256!==context.resources.accountMemory.accountIdSha256)throw blocked('记忆观察期间账号变化，未读取其他账号材料');
  const checkpoint=source.metadata?.['mobilework.memory.lastSummarizedMessageId']??null;
  samples.push({elapsedMs:now()-started,enabled:state.enabled,documentSha256:memoryHash(state.rawDoc),updatedAt:state.doc.updatedAt,activeGenerators:state.ephemeralIds.length,sourceCheckpoint:checkpoint,markerFound:state.doc.content.includes(marker)});
  await onSample(samples);
  if(state.enabled!==enabled)throw blocked('记忆开关在执行期间被其他操作改变');
  if(enabled&&checkpoint===expectedUser&&!state.ephemeralIds.length){if(!state.doc.content.includes(marker)||state.doc.updatedAt===before.doc.updatedAt)throw Error('自动整理已记录本轮用户消息，但长期事实未写入实际记忆');return {state,samples,sourceCheckpoint:checkpoint};}
  if(!enabled){if(memoryHash(state.rawDoc)!==memoryHash(before.rawDoc)||checkpoint)throw Error('关闭自动生成后本轮新对话仍修改了记忆或整理断点');if(now()-started>=quietMs&&!state.ephemeralIds.length)return {state,samples,sourceCheckpoint:checkpoint};}
  await pause(500);
 }
 throw review('未取得本轮自动记忆整理终态及源消息断点；不以普通对话回复或手工更新冒充自动生成');
}
export async function releaseAccountMemory(page,resources,{checkpoint=async()=>{},timeout=330000}={}){
 const owned=resources.accountMemory;if(!owned)return;validateAccountMemory(owned);let current=await readMemory(page);if(current.accountIdSha256!==owned.accountIdSha256)throw blocked('记忆恢复账号已变化，保留原基线');
 const states=await engineRequest(await readEngineConnection(page),'/session/status');if(Object.entries(states).some(([id,item])=>item.type!=='idle'&&!owned.sourceSessions.includes(id)&&!current.ephemeralIds.includes(id)))throw blocked('有其他任务正在使用共享账号，暂不恢复记忆');
 await releaseSettingsPanel(page,resources);await checkpoint();const panel=await openSettings({page,resources,checkpointResources:checkpoint},'memory');await chooseMemoryEnabled(page,panel,false);await releaseSettingsPanel(page,resources);await checkpoint();
 // The product debounces automatic generation by 10 seconds. Disable it and
 // let any already-started writer finish before restoring the original data.
 const started=Date.now();do{current=await readMemory(page);if(current.accountIdSha256!==owned.accountIdSha256)throw blocked('等待记忆收尾期间账号变化');if(Date.now()-started>=12000&&!current.ephemeralIds.length)break;if(Date.now()-started>=timeout)throw blocked('本轮自动记忆写入仍未结束，原基线暂未覆盖');await page.waitForTimeout(500);}while(true);
 await page.evaluate(async owned=>{const bridge=window.__MOBILEWORK__,auth=await bridge.invoke('auth:current'),accountId=auth.account?.id,fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(accountId))))).map(v=>v.toString(16).padStart(2,'0')).join('');if(auth.oidcValidation!=='valid'||fingerprint!==owned.accountIdSha256)throw Error('写回前账号身份变化，未覆盖');for(const [path,value]of [['memory/conversation-memory',owned.originalDoc],['memory/generation-enabled',owned.originalEnabled]]){const result=await bridge.invoke('store:write',{accountId,path,value});if(!result.ok)throw Error('记忆原值恢复写入失败');}},owned);
 const restored=await readMemory(page);if(memoryHash(restored.rawDoc)!==memoryHash(owned.originalDoc)||restored.rawEnabled!==owned.originalEnabled)throw blocked('原记忆及开关恢复未确认');delete resources.accountMemory;
}
