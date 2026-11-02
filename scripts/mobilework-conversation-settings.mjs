import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openSettings,releaseSettingsPanel,readAccountSession} from './mobilework-account-settings.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});
export const toneLabels={concise:'简洁高效',rigorous:'严谨详尽',friendly:'亲和友好'};
export const toneInstructions={concise:'表达风格：简洁高效，先给结论，再补充必要依据，避免冗长铺垫。',rigorous:'表达风格：严谨详尽，说明推理步骤与依据，适合技术与合规类任务。',friendly:'表达风格：亲和友好，语气自然，兼顾专业性与可读性。'};
export async function readConversationPreferences(page){return page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('openwork.preferences'));return {agentTone:p.agentTone,customInstruction:p.customInstruction??''};});}
export async function readSendMessageShortcut(page){return page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')||'{}').sendMessageShortcut??'enter');}
export async function readOfficialMaf(page){return page.evaluate(async()=>{const data=await window.__MOBILEWORK__.invoke('models:list');if(data.ok===false)throw Error('读取模型配置失败');return {enabled:data.officialMaf!==false};});}
export async function readOfficialMafOrigin(page){
 const roots=await page.evaluate(()=>(window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__).invokeDesktop('__pathRoots'));if(!path.isAbsolute(roots.dataRootDir))throw blocked('未确认模型配置真实根目录');
 let raw;try{raw=JSON.parse(await fs.readFile(path.join(roots.dataRootDir,'models.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return {explicit:false};}
 return {explicit:!Array.isArray(raw)&&Object.hasOwn(raw,'officialMaf'),...(typeof raw.officialMaf==='boolean'?{storedEnabled:raw.officialMaf}:{})};
}
export function validateConversationSettings(value,previous){
 if(!/^[a-f0-9-]{36}$/.test(value.owner)||!/^[a-f0-9]{64}$/.test(value.accountIdSha256)||!['maf','tone','instruction','shortcut'].includes(value.kind)||Object.keys(value).some(key=>!['owner','kind','accountIdSha256','enabled','agentTone','customInstruction','sendMessageShortcut'].includes(key)))throw Error('会话设置恢复基线无效');
 if(value.kind==='maf'?typeof value.enabled!=='boolean':value.kind==='shortcut'?!['enter','mod-enter'].includes(value.sendMessageShortcut):!Object.hasOwn(toneLabels,value.agentTone))throw Error('会话设置原值无效');
 if(value.kind==='instruction'&&(typeof value.customInstruction!=='string'||value.customInstruction.length>150||value.customInstruction&&!value.customInstruction.startsWith('MW-AUTOTEST-')))throw Error('自定义指令只允许空或明确合成原值');
 if(previous&&JSON.stringify(value)!==JSON.stringify(previous))throw Error('不能替换会话设置原基线');
}
export async function prepareConversationSettings(context,kind){
 const identity=await readAccountSession(context.page);if(!identity.signedIn||identity.validation!=='valid')throw blocked('未确认当前设置账号有效');
 const states=await engineRequest(await readEngineConnection(context.page),'/session/status');if(Object.values(states).some(item=>item.type!=='idle'))throw blocked('其他会话正在使用共享设置，未修改');
 const current=kind==='maf'?await readOfficialMaf(context.page):kind==='shortcut'?{sendMessageShortcut:await readSendMessageShortcut(context.page)}:await readConversationPreferences(context.page);
 if(kind==='instruction'&&current.customInstruction&&!current.customInstruction.startsWith('MW-AUTOTEST-'))throw blocked('已有用户自定义指令，未覆盖；请在空或合成配置的测试账号执行指令用例');
 const owned={owner:randomUUID(),kind,accountIdSha256:identity.accountIdSha256,...(['maf','shortcut'].includes(kind)?current:{agentTone:current.agentTone,...(kind==='instruction'?{customInstruction:current.customInstruction}:{})})};
 validateConversationSettings(owned);context.resources.conversationSettings=owned;await context.checkpointResources();return owned;
}
export async function chooseTone(page,panel,tone){
 const select=panel.getByRole('combobox',{name:'基本风格和语调',exact:true});
 if(!(await select.innerText()).includes(toneLabels[tone])){await select.click();await page.getByRole('option',{name:toneLabels[tone],exact:true}).click();}
 await page.waitForFunction(tone=>JSON.parse(localStorage.getItem('openwork.preferences')).agentTone===tone,tone);
}
export async function saveCustomInstruction(page,panel,text){
 const input=panel.getByRole('textbox',{name:'自定义指令',exact:true});await input.fill(text);
 if((await readConversationPreferences(page)).customInstruction!==text)await panel.getByRole('button',{name:'确认',exact:true}).click();
 await page.waitForFunction(text=>JSON.parse(localStorage.getItem('openwork.preferences')).customInstruction===text,text);
}
export async function chooseSendMessageShortcut(context,panel,shortcut,{onOpen=async()=>{}}={}){
 const owned=context.resources.settingsPanel;owned.shortcutToken=randomUUID();await context.checkpointResources();
 const row=panel.getByText('快捷键',{exact:true}).locator('xpath=../..');
 await row.getByRole('button',{name:'编辑',exact:true}).click();
 const dialog=context.page.getByRole('dialog',{name:'快捷键设置',exact:true}).filter({visible:true});await dialog.waitFor();
 await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-shortcut',token),owned.shortcutToken);
 await onOpen(dialog);await dialog.getByRole('button',{name:shortcut==='enter'?'Enter':'Ctrl+Enter',exact:true}).click();
 await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await context.page.waitForFunction(value=>JSON.parse(localStorage.getItem('openwork.preferences')).sendMessageShortcut===value,shortcut);
 delete owned.shortcutToken;await context.checkpointResources();
}
export async function chooseOfficialMaf(context,panel,enabled,{onConfirm=async()=>{}}={}){
 const toggle=panel.getByRole('switch',{name:'MAF防火墙',exact:true});if((await toggle.getAttribute('aria-checked')==='true')===enabled)return;
 if(!enabled){context.resources.settingsPanel.mafToken=randomUUID();await context.checkpointResources();}
 await toggle.click();
 if(!enabled){
  const dialog=context.page.getByRole('dialog',{name:'你确定关闭MAF防火墙吗？',exact:true}).filter({visible:true});await dialog.waitFor();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-maf',token),context.resources.settingsPanel.mafToken);
  await onConfirm(dialog);await dialog.getByRole('button',{name:'确认',exact:true}).click();await dialog.waitFor({state:'hidden'});
 }
 await context.page.waitForFunction(async enabled=>(await window.__MOBILEWORK__.invoke('models:list')).officialMaf===enabled,enabled);
}
export async function releaseConversationSettings(page,resources,{checkpoint=async()=>{}}={}){
 const owned=resources.conversationSettings;if(!owned)return;validateConversationSettings(owned);
 const identity=await readAccountSession(page);if(identity.accountIdSha256!==owned.accountIdSha256||identity.validation!=='valid')throw blocked('设置恢复账号已变化，保留原基线');
 await releaseSettingsPanel(page,resources);await checkpoint();
 const context={page,resources,checkpointResources:checkpoint},panel=await openSettings(context,owned.kind==='maf'?'models':owned.kind==='shortcut'?'software':'personalization');
 if(owned.kind==='maf')await chooseOfficialMaf(context,panel,owned.enabled);
 else if(owned.kind==='shortcut')await chooseSendMessageShortcut(context,panel,owned.sendMessageShortcut);
 else {await chooseTone(page,panel,owned.agentTone);if(owned.kind==='instruction')await saveCustomInstruction(page,panel,owned.customInstruction);}
 await releaseSettingsPanel(page,resources);delete resources.conversationSettings;
}
// Controlled real host request, separate from the product's automatic dialogue
// screening. It does not rewrite or intercept normal dialogue traffic.
export async function probeMaf(page,{sessionId,provider,content}){return page.evaluate(async({sessionId,provider,content})=>{
 const bridge=window.__MOBILEWORK__,config=await bridge.invoke('maf:config');
 const request={MsgID:crypto.randomUUID(),Message:{Role:'user',Content:content,ContentType:1},UseStream:0,Extensions:{session_id:sessionId}};
 const r=await bridge.invoke('maf:moderate',{request,facet:'input',provider}),requestId=r.ResponseMetadata?.RequestId;
 return {sessionId,provider,configured:config.configured===true,mock:config.mock===true,cloudEnabled:config.enabled===true,inputEnabled:config.facets?.input===true,bypassed:requestId==='maf-local-disabled',cloudDisabled:requestId==='maf-disabled',accepted:r.ok!==false&&!r.ResponseMetadata?.Error?.Code,decision:r.Result?.Decision?.DecisionType??null,degraded:r.Result?.Degraded===true,hasRequestId:typeof requestId==='string'&&requestId.length>0};
 },{sessionId,provider,content});}
