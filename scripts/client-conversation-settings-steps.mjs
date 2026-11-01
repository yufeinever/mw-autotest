import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openSettings,releaseSettingsPanel,readAccountSession} from './mobilework-account-settings.mjs';
import {readMemory,prepareAccountMemory,chooseMemoryEnabled} from './mobilework-account-memory.mjs';
import {toneInstructions,toneLabels,readConversationPreferences,prepareConversationSettings,chooseTone,saveCustomInstruction,readOfficialMaf,readOfficialMafOrigin,chooseOfficialMaf,probeMaf} from './mobilework-conversation-settings.mjs';
import {observePromptSettings} from './mobilework-prompt-observation.mjs';
import {restartOwnedClient} from './mobilework-client-restart.mjs';
import {finalAssistantText} from './client-case-runner.mjs';
const review=message=>Object.assign(Error(message),{review:true}),blocked=message=>Object.assign(Error(message),{blocked:true});
export async function runConversationSettingsSteps(context){
 const {number,resources,control,remaining}=context,finish=step=>remaining.delete(step),save=(name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
 const ui=action=>control.withUI(context.page,'INTERACTING',action);
 async function settings(section,action){return ui(async()=>{const panel=await openSettings(context,section);try{return await action(panel);}finally{await releaseSettingsPanel(context.page,resources);await context.checkpointResources();}});}
 if(number===187){
  await ui(()=>prepareAccountMemory(context));await settings('memory',panel=>chooseMemoryEnabled(context.page,panel,false));
  const marker='MW-AUTOTEST-MEMORY '+randomUUID(),content=marker+'\n合成项目青禾；每周五检查预算7300元；所有资料仅供测试。',updatedAt=Date.now()-90000;
  for(const doc of [{content:'',updatedAt:null},{content,updatedAt}]){
   await ui(async()=>{
    const current=await readMemory(context.page);if(current.accountIdSha256!==resources.accountMemory.accountIdSha256||current.ephemeralIds.length)throw blocked('记忆账号或后台整理变化，未写展示材料');
    await context.page.evaluate(async doc=>{const bridge=window.__MOBILEWORK__,auth=await bridge.invoke('auth:current');const r=await bridge.invoke('store:write',{accountId:auth.account.id,path:'memory/conversation-memory',value:doc});if(!r.ok)throw Error('合成展示材料写入失败');},doc);
   });
   await settings('memory',async panel=>{
    if(!doc.content){context.assert('空记忆页展示真实空态',await panel.getByText('暂无对话记忆。',{exact:true}).isVisible());await context.capture('记忆展示合成空态');finish('空记忆真实展示');return;}
    const card=panel.getByRole('button').filter({has:context.page.getByText('来自对话的记忆',{exact:true})});context.assert('实际卡片摘要包含本轮合成记忆',await card.locator('p').innerText()===content);
    const time=card.locator('span').filter({hasText:/从对话中更新$/});context.assert('摘要更新时间按合成时间戳展示',/1 分钟前从对话中更新/.test(await time.innerText()));await context.capture('记忆摘要与更新时间');finish('合成记忆摘要及真实更新时间');
    resources.settingsPanel.memoryToken=randomUUID();await context.checkpointResources();await card.click();const dialog=context.page.getByRole('dialog',{name:'管理记忆',exact:true});await dialog.waitFor();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-memory',token),resources.settingsPanel.memoryToken);context.assert('管理详情保留完整合成记忆',await dialog.getByRole('textbox',{name:'记忆内容',exact:true}).inputValue()===content);await context.capture('管理记忆完整内容');finish('管理详情全文及本轮面板收尾');
   });
  }
  await save('展示输入来源',{source:'本轮正常store接口合成夹具，非自动整理结果',marker,updatedAt});
  throw review('当前产品将背景合并为对话记忆，没有原表独立工作背景区域；空态、摘要、时间和全文已分别验证，原区域保留差异');
 }
 if(number===188)return settings('models',async panel=>{
  const state=await readOfficialMaf(context.page),origin=await readOfficialMafOrigin(context.page),toggle=panel.getByRole('switch',{name:'MAF防火墙',exact:true});context.assert('官方MAF开关与真实保存状态一致',(await toggle.getAttribute('aria-checked')==='true')===state.enabled);
  context.assert('完整显示MAF作用时延及关闭风险说明',await panel.getByText('开启 MAF 将对 AI 流量做安全校验，轻微增加时延；关闭后失去 AI 安全防护能力',{exact:true}).isVisible());await save('官方MAF当前状态及默认来源',{...state,...origin});await context.capture('官方MAF默认来源与完整说明');finish('官方MAF开关真实状态及完整说明');
  if(origin.explicit)throw review('已有显式官方MAF配置，当前一致性不等于首次默认；未删除模型配置制造首次使用');context.assert('无显式配置的官方MAF默认开启',state.enabled);finish('无显式配置时默认开启');
 });
 if(number===189){
  if(context.config.model!=='自动')throw blocked('189仅针对官方自动模型总开关，不修改自定义模型各自防火墙');
  const baseline=await ui(()=>prepareConversationSettings(context,'maf')),identity=await readAccountSession(context.page),results=[];
  for(const enabled of [false,true]){
   await settings('models',panel=>chooseOfficialMaf(context,panel,enabled,{onConfirm:async dialog=>{context.assert('关闭前展示明确风险二次确认',(await dialog.innerText()).includes('跳过合规校验'));await context.capture('关闭MAF真实风险确认');}}));
   if(!enabled){const proof=await ui(()=>restartOwnedClient(context));await save('关闭MAF正常重启新进程',proof);context.assert('真实重启后同账号且关闭值保留',(await readAccountSession(context.page)).accountIdSha256===identity.accountIdSha256&&!(await readOfficialMaf(context.page)).enabled);finish('关闭确认与新进程持久化');}
   else await context.newSession();
   const marker='MAF合成探针'+randomUUID().slice(0,8);await context.send(marker+'：请计算217加36，简单说明计算结果。不要使用工具或创建文件。');context.assert((enabled?'开启':'关闭')+'时普通对话完成并计算正确',finalAssistantText(context.getData()).includes('253'));
   const assistant=context.getData().messages.filter(m=>m.info?.role==='assistant').at(-1),provider=assistant?.info?.providerID;if(!provider)throw review('真实会话未返回模型提供方，未猜测MAF探针目标');
   const fact=await ui(()=>probeMaf(context.page,{sessionId:context.getSessionId(),provider,content:marker+' 合成无害输入217加36'}));results.push({enabled,...fact,scope:'正常本地接口受控探针；不等同普通对话自动送检Trace'});await save('MAF实际校验接口与普通对话分支',results);
   if(!enabled){context.assert('关闭时真实主进程校验接口明确本地跳过',fact.accepted&&fact.bypassed&&!fact.degraded);finish('关闭后普通对话及真实主进程本地跳过');}
   else {
    if(!fact.configured||fact.mock||!fact.cloudEnabled||!fact.inputEnabled||fact.cloudDisabled)throw review('云端MAF或input分类未真实开启，已验证本地开关及对话，但不能宣称安全校验恢复');
    context.assert('开启后真实云端校验返回非降级判决',fact.accepted&&!fact.bypassed&&!fact.degraded&&fact.hasRequestId&&Number.isFinite(fact.decision));finish('重新开启后普通对话及真实云端校验');
   }
  }
  await save('MAF恢复基线摘要',{originalEnabled:baseline.enabled});throw review('受控主进程探针及普通对话已分别验证；当前接口没有普通对话自动送检的本Session审计证据，不将探针冒充自动流量Trace');
 }
 if(number===190||number===191){
  const baseline=await ui(()=>prepareConversationSettings(context,number===190?'tone':'instruction'));
  const tone=number===190?(baseline.agentTone==='rigorous'?'friendly':'rigorous'):baseline.agentTone;
  const marker='MW-AUTOTEST-'+randomUUID().slice(0,8),instruction=number===191?marker+'。默认使用中文，每次回答最后一行单独写：'+marker+'。':null;
  await settings('personalization',async panel=>{
   const select=panel.getByRole('combobox',{name:'基本风格和语调',exact:true});context.assert('当前风格与原配置一致',(await select.innerText()).includes(toneLabels[baseline.agentTone]));
   if(number===190){await select.click();const options=await context.page.getByRole('option').allTextContents();context.assert('三种真实风格候选完整',Object.values(toneLabels).every(label=>options.includes(label)));await context.page.getByRole('option',{name:toneLabels[tone],exact:true}).click();await chooseTone(context.page,panel,tone);}
   else {
    const input=panel.getByRole('textbox',{name:'自定义指令',exact:true});await input.fill(instruction);context.assert('指令最大150及实际字符计数',await input.getAttribute('maxlength')==='150'&&await panel.getByText(instruction.length+'/150',{exact:true}).isVisible());await saveCustomInstruction(context.page,panel,instruction);context.assert('确认后保存按钮已无未提交修改',!await panel.getByRole('button',{name:'确认',exact:true}).isEnabled());
   }
   await context.capture(number===190?'真实风格候选切换保存':'自定义指令计数及确认保存');
  });finish(number===190?'真实风格候选与切换保存':'自定义指令输入计数与真实确认保存');
  if(number===191){const proof=await ui(()=>restartOwnedClient(context));await save('自定义指令正常重启新进程',proof);const current=await readConversationPreferences(context.page);context.assert('真实客户端重启后原账号和新指令保持',(await readAccountSession(context.page)).accountIdSha256===baseline.accountIdSha256&&current.customInstruction===instruction);finish('新进程重启指令持久化');}
  const observer=await observePromptSettings(context.page,{tone:toneInstructions[tone],instruction});
  try{
   await context.send('合成项目青禾：预算7300元，已用2100元，周五评审。请用中文给出任务拆解、进展汇报、一个待确认问题及总结，计算剩余预算。不需要工具和文件。');
   const facts=observer.read(context.getSessionId());await save('本Session实际发送系统偏好匹配',facts);if(!facts.length)throw review('未捕获本Session真实发送的system字段，不能仅凭配置回读证明传入模型');context.assert('真实请求传入所选风格及本轮自定义指令',facts.every(f=>f.toneMatched&&(number===190||f.instructionMatched)));finish('本Session真实模型请求携带所选配置');
   const output=finalAssistantText(context.getData());context.assert('模型完成拆解汇报追问总结且剩余预算正确',/青禾/.test(output)&&/5[，,]?200/.test(output)&&/[?？]/.test(output));if(number===191)context.assert('真实回复遵循本轮指令的末行标记',output.trim().split('\n').at(-1).trim()===marker);await context.capture('偏好生效真实任务回复');finish('实际回复业务效果与指令遵循');
  }finally{await observer.close();}
  return;
 }
 throw Error('会话设置步骤只支持187～191');
}
