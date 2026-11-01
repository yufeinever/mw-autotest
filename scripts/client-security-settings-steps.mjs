import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {errors} from 'playwright-core';
import {testEnvironment} from '../local-console/environment.mjs';
import {openSettings,releaseSettingsPanel} from './mobilework-account-settings.mjs';
import {prepareConversationSettings,readConversationPreferences,readSendMessageShortcut,chooseSendMessageShortcut,releaseConversationSettings} from './mobilework-conversation-settings.mjs';
import {beginMessageClipboard,expectMessageClipboard,restoreMessageClipboard} from './mobilework-message-clipboard.mjs';
import {snapshotDraft,clearOwnedDraft,editorOf} from './mobilework-isolation.mjs';
import {readComposerState} from './mobilework-composer.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));

async function auditRequest(page,route){
 const info=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo'));
 const url=new URL(info.baseUrl??info.connectUrl??info.lanUrl??info.mdnsUrl);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw Error('安全审计服务不是有效的本机地址');
 const base=url.href.replace(/\/$/,'');let token=info.ownerToken||info.clientToken;
 if(!token)throw Error('安全审计服务缺少访问令牌');
 if(info.ownerToken){
  const probe=await fetch(base+'/workspaces',{headers:{Authorization:'Bearer '+info.ownerToken,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});
  if([401,403].includes(probe.status)&&info.clientToken)token=info.clientToken;
 }
 const response=await fetch(base+'/venusguard/api/v1/host'+route,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
 if(response.status>=500)throw blocked('安全审计接口不可用：HTTP '+response.status);
 if(response.status===404)throw review('安全审计接口或本轮记录不存在：HTTP 404');
 if(!response.ok)throw Error('安全审计接口请求失败：HTTP '+response.status);
 let result;
 try{result=await response.json();}catch(error){if(error instanceof SyntaxError)throw Error('安全审计接口返回非 JSON 数据：HTTP '+response.status);throw error;}
 if(result.notice)throw blocked('安全审计未提供当前账户的数据：'+result.notice.message);
 if(result.ok!==true||!('data' in result))throw Error('安全审计接口请求失败：'+(result.error?.code||'响应数据无效'));
 return result.data;
}

async function openAudit(context,panel,kind){
 const owned=context.resources.settingsPanel;
 owned.auditKind=kind;owned.auditToken=randomUUID();await context.checkpointResources();
 const card=panel.getByText(kind,{exact:true}).locator('xpath=../..');
 await card.getByRole('button',{name:'查看明细',exact:true}).click();
 const dialog=context.page.getByRole('dialog',{name:kind,exact:true}).filter({visible:true});
 await dialog.waitFor();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-audit',token),owned.auditToken);
 await context.checkpointResources();return dialog;
}

async function showAllActions(context,dialog,endpoint){
 const response=context.page.waitForResponse(r=>{
  const url=new URL(r.url());return url.pathname.endsWith(endpoint)&&!url.searchParams.has('action');
 },{timeout:15000});
 await dialog.getByRole('combobox',{name:'处置结果',exact:true}).click();
 await context.page.getByRole('option',{name:'全部',exact:true}).click();await response;
}

async function waitAuditRow(row){
 try{await row.waitFor({state:'visible',timeout:15000});}
 catch(error){if(error instanceof errors.TimeoutError)throw review('本轮记录未在审计列表当前页出现，未将接口数据当作界面通过');throw error;}
}

async function openAuditDetail(context,row){
 const owned=context.resources.settingsPanel;owned.auditDetailToken=randomUUID();await context.checkpointResources();
 await row.click();
 const dialog=context.page.getByRole('dialog').filter({visible:true,has:context.page.getByText('记录原文',{exact:true})});
 await dialog.waitFor();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-settings-audit-detail',token),owned.auditDetailToken);
 await context.checkpointResources();return dialog;
}

function auditTime(iso){
 const d=new Date(iso),pad=n=>String(n).padStart(2,'0');
 return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function runSecuritySettingsSteps(context){
 const {number,page,resources,control,remaining}=context;
 const ui=action=>control.withUI(page,'INTERACTING',action);
 async function settings(section,action){return ui(async()=>{
  const panel=await openSettings(context,section);
  try{return await action(panel);}finally{await releaseSettingsPanel(page,resources);await context.checkpointResources();}
 });}

 if(number===192){
  await ui(()=>prepareConversationSettings(context,'instruction'));
  const prefix='MW-AUTOTEST-'+randomUUID().replaceAll('-','').slice(0,12)+'-',value=prefix+'测'.repeat(150-prefix.length);
  await settings('personalization',async panel=>{
   const input=panel.getByRole('textbox',{name:'自定义指令',exact:true});await input.fill(value);
   context.assert('输入150字符显示150/150',await input.inputValue()===value&&await panel.getByText('150/150',{exact:true}).isVisible());
   await input.press('End');await page.keyboard.type('XYZ');
   context.assert('继续真实输入时超出150的字符未进入输入框',await input.inputValue()===value);
   await panel.getByRole('button',{name:'确认',exact:true}).click();
   await page.waitForFunction(text=>JSON.parse(localStorage.getItem('openwork.preferences')).customInstruction===text,value);
   context.assert('确认后只保存150字符',(await readConversationPreferences(page)).customInstruction===value);
   await context.capture('指令150字符上限与确认');
  });
  remaining.delete('真实输入及超限限制');
  await settings('personalization',async panel=>context.assert('重新打开后保存值完整且无超限字符',await panel.getByRole('textbox',{name:'自定义指令',exact:true}).inputValue()===value));
  remaining.delete('确认保存及重新打开回读');return;
 }

 if(number===193){
  const guard=await auditRequest(page,'/guard');
  await settings('security',async panel=>{
   const toggle=panel.getByRole('switch',{name:'Guard安全拦截',exact:true});
   context.assert('Guard开关与安全插件当前状态一致',(await toggle.getAttribute('aria-checked')==='true')===guard.enabled);
   if(guard.lock?.locked)throw review('安全策略锁定了Guard说明，无法核对原表完整说明');
   context.assert('Guard安全拦截完整说明可见',await panel.getByText('开启 Guard 将对智能体交互过程中的会话、行为进行安全检测和拦截，保障智能体安全运行',{exact:true}).isVisible());
   await context.capture('Guard当前状态及完整说明');
  });
  await save(context,'Guard当前状态',{enabled:guard.enabled,enforcement:guard.enforcement,effectiveEnforcement:guard.effectiveEnforcement,locked:guard.lock?.locked});
  remaining.delete('Guard真实当前开关及说明');
  throw review('已核对当前Guard状态和说明；现有账号可能保存过设置，无法据此证明首次安装默认开启');
 }

 if(number===194||number===195){
  const guard=await auditRequest(page,'/guard');
  if(!guard.enabled||!guard.modules?.audit)throw blocked('当前Guard或审计模块未启用，未修改用户安全配置');
  const marker='MW-AUDIT-'+randomUUID().slice(0,8);
  if(number===194){
   const file=path.join(context.dir,marker+'.txt');await fs.writeFile(file,marker+' 青禾预算7300元，已用2100元，剩余5200元。\n');
   await context.send('请使用文件读取工具读取测试文件 '+file+'，核对其中的预算与剩余金额并简要回复。');
   const sessionId=context.getSessionId(),parts=context.getData().messages.flatMap(m=>m.parts||[]).filter(p=>p.type==='tool'&&p.state?.status==='completed'&&JSON.stringify(p.state?.input||{}).includes(marker));
   if(!parts.length)throw review('本轮模型未产生读取合成文件的真实工具调用，未将未触发当成审计通过');
   const events=await auditRequest(page,'/behaviors?kind=tool_call&limit=100&sessionId='+encodeURIComponent(sessionId));
   const part=parts.find(p=>events.some(e=>e.eventId===sessionId+'-'+p.callID&&e.tool===p.tool));
   if(!part)throw review('本轮实际工具调用尚未出现在安全行为审计中');
   const event=events.find(e=>e.eventId===sessionId+'-'+part.callID);
   context.assert('行为审计关联同一Session与真实工具调用',event.sessionId===sessionId&&event.tool===part.tool&&Math.abs(Date.parse(event.occurredAt)-part.state.time.start)<60000);
   await settings('security',async panel=>{
    const dialog=await openAudit(context,panel,'行为审计');await showAllActions(context,dialog,'/venusguard/api/v1/host/behaviors');
    const row=dialog.locator('tbody tr').filter({has:page.locator('td[title*="'+marker+'"]')});await waitAuditRow(row);
    context.assert('行为审计行展示本轮实际发生时间',(await row.innerText()).includes(auditTime(event.occurredAt)));
    await context.captureElement(row,'行为审计本轮工具记录');
    const detail=await openAuditDetail(context,row);await detail.locator('pre').waitFor();
    if(!(await detail.locator('pre').innerText()).includes(marker))throw review('本轮工具记录已打开，但详情未返回可核对的合成内容');
    await context.captureElement(detail,'行为审计本轮记录详情');
   });
   await save(context,'本轮行为审计关联',{sessionId,eventId:event.eventId,tool:event.tool,occurredAt:event.occurredAt,toolStartedAt:part.state.time.start});
   remaining.delete('真实工具调用及行为审计记录');remaining.delete('行为审计界面及详情');return;
  }

  const prompt=marker+'：请计算137加286，只需简要给出计算结果。';await context.send(prompt);
  const sessionId=context.getSessionId(),data=context.getData(),user=data.messages.find(m=>m.info?.role==='user'&&(m.parts||[]).some(p=>p.type==='text'&&p.text.includes(marker)));
  const sessions=await auditRequest(page,'/sessions?limit=100'),session=sessions.find(s=>s.sessionId===sessionId);
  if(!session||!user)throw review('未取得本轮真实会话对应的安全审计记录');
  const messages=await auditRequest(page,'/sessions/'+encodeURIComponent(sessionId)+'/messages?limit=100');
  const message=messages.find(m=>m.messageId===user.info.id&&m.content.includes(marker));
  if(!message)throw review('安全审计未找到本轮用户消息及唯一标记');
  context.assert('会话审计消息可追溯到本轮Session和时间',message.sessionId===sessionId&&Math.abs(Date.parse(message.createdAt)-user.info.time.created)<60000);
  await settings('security',async panel=>{
   const dialog=await openAudit(context,panel,'会话审计');
   await dialog.getByPlaceholder('按照任务名称搜索...').fill(session.title);
   const match=dialog.locator('aside button').filter({has:page.getByText(session.title,{exact:true})});await waitAuditRow(match);
   if(await match.count()!==1)throw review('审计列表中任务名称不唯一，未接管其他会话');
   await match.click();await showAllActions(context,dialog,'/venusguard/api/v1/host/sessions/'+encodeURIComponent(sessionId)+'/messages');
   const row=dialog.locator('tbody tr').filter({has:page.locator('td[title*="'+marker+'"]')});await waitAuditRow(row);
   context.assert('会话审计行展示本轮消息时间',(await row.innerText()).includes(auditTime(message.createdAt)));
   await context.captureElement(row,'会话审计本轮消息');
   const detail=await openAuditDetail(context,row);context.assert('会话审计详情展示本轮原始输入',(await detail.locator('pre').innerText()).includes(prompt));
   await context.captureElement(detail,'会话审计本轮消息详情');
  });
  await save(context,'本轮会话审计关联',{sessionId,messageId:message.messageId,createdAt:message.createdAt,userCreatedAt:user.info.time.created});
  remaining.delete('真实Session与安全审计消息关联');remaining.delete('会话审计界面及详情');return;
 }

 if(number===196){
  const build=JSON.parse(await fs.readFile(testEnvironment.buildInfoPath,'utf8')),version=build.productVersion;
  if(!version)throw review('安装包未提供产品版本，无法核对界面展示');
  let owner;
  await settings('software',async panel=>{
   await panel.getByText(version,{exact:true}).waitFor();
   const row=panel.getByText('客户端版本',{exact:true}).locator('xpath=..');
   context.assert('客户端版本与安装包产品版本一致',(await row.innerText()).includes(version));
   owner=randomUUID();const baseline=await beginMessageClipboard(page,owner);
   if(!baseline.supported)throw review('剪贴板含不可恢复格式，未覆盖原内容');
   resources.clipboardOwner=owner;await context.checkpointResources();
   await expectMessageClipboard(page,owner,'MobileWork '+version);
   await panel.getByRole('button',{name:'复制版本',exact:true}).click();
   await page.waitForFunction(value=>navigator.clipboard.readText().then(text=>text===value),'MobileWork '+version);
   await context.capture('软件配置版本与复制');
  });
  const text='MobileWork '+version,editor=editorOf(page),draft=await snapshotDraft(page);
  await context.checkpointPage({...draft,text});await editor.click();await page.keyboard.press('Control+v');
  context.assert('真实粘贴内容包含产品名及展示版本',(await readComposerState(editor)).text===text);await context.capture('版本复制后真实粘贴');
  const pasted=await snapshotDraft(page);await context.checkpointPage(pasted);
  if(!await clearOwnedDraft(page,pasted,context.config))throw blocked('版本粘贴草稿归属未确认');
  await context.checkpointPage();
  const restored=await restoreMessageClipboard(page,owner);delete resources.clipboardOwner;await context.checkpointResources();
  context.log('剪贴板收尾',restored.restored?'原内容已恢复':restored.reason);
  await save(context,'版本复制核对',{version,copied:text,clipboardRestored:restored.restored});
  remaining.delete('安装包与界面版本一致');remaining.delete('真实复制粘贴及剪贴板恢复');return;
 }
 if(number===198){
  const baseline=await ui(()=>prepareConversationSettings(context,'shortcut'));
  await settings('software',async panel=>{
   if(baseline.sendMessageShortcut!=='enter')await chooseSendMessageShortcut(context,panel,'enter');
   await chooseSendMessageShortcut(context,panel,'mod-enter',{onOpen:async dialog=>{
    context.assert('快捷键设置展示新建任务及发送消息',await dialog.getByText('新建任务',{exact:true}).isVisible()&&await dialog.getByText('发送消息',{exact:true}).isVisible());
    await context.capture('快捷键设置及发送选项');
   }});
   context.assert('保存后发送快捷键为Ctrl+Enter',await readSendMessageShortcut(page)==='mod-enter');
   await context.capture('快捷键保存后软件配置');
  });
  remaining.delete('快捷键列表与新组合保存');
  const prompt='MW-AUTOTEST-198-'+randomUUID().slice(0,8)+'：请计算17加25，只需简要回答，不调用工具。';
  let oldKeyKeptDraft=false;
  await context.send(prompt,{submit:async()=>{
   const origin=page.url(),editor=editorOf(page);await editor.click();await page.keyboard.press('Enter');
   await page.waitForTimeout(1000);
   oldKeyKeptDraft=page.url()===origin&&await editor.isVisible()&&await editor.isEditable()&&(await readComposerState(editor)).text.replaceAll('\n','')===prompt;
   await save(context,'快捷键实际触发',{old:'Enter',next:'Ctrl+Enter',oldKeyKeptDraft});
   if(oldKeyKeptDraft){await context.capture('旧快捷键未发送');await page.keyboard.press('Control+Enter');}
  }});
  context.assert('旧Enter未发送本轮草稿',oldKeyKeptDraft);
  context.assert('新Ctrl+Enter发送本轮Session消息',context.getData().messages.some(message=>message.info?.role==='user'&&(message.parts||[]).some(part=>part.type==='text'&&part.text.replaceAll('\n','').includes(prompt))));
  await context.capture('新快捷键发送本轮会话');remaining.delete('旧键不发送及新键真实发送');
  await ui(()=>releaseConversationSettings(page,resources,{checkpoint:context.checkpointResources}));await context.checkpointResources();
  context.assert('发送快捷键已恢复原值',await readSendMessageShortcut(page)===baseline.sendMessageShortcut);remaining.delete('原发送快捷键恢复');return;
 }
 throw Error('设置步骤只支持192～196及198');
}
