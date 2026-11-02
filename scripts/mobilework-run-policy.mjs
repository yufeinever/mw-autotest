import {normalizeConfig,approvalLabels} from '../local-console/policy.mjs';
import {assertClientEdition,editionProfiles} from '../local-console/client-edition.mjs';

export async function waitStep(page,config={}){
 const seconds=normalizeConfig({stepInterval:config.stepInterval}).stepInterval;
 await page.waitForTimeout(Math.round(seconds*1000));
}

export function readRunConfig(){return process.env.MW_TEST_CONFIG_JSON?normalizeConfig(JSON.parse(process.env.MW_TEST_CONFIG_JSON)):null;}
export async function modelTrigger(page){
 const candidates=page.locator('button[aria-expanded][aria-label]').filter({visible:true});
 const excluded=new Set(['上传文件','模式','技能','专家','工具','知识库','权限','上下文用量']);
 const found=[];
 for(let i=0;i<await candidates.count();i++){
  const b=candidates.nth(i), label=await b.getAttribute('aria-label');
  if(!excluded.has(label)&&await b.locator('svg path[d^="M3.624"]').count())found.push(b);
 }
 // Current renderer uses the same cube icon for model options and the toolbar.
 if(found.length===1)return found[0];
 const run=page.getByRole('button',{name:'运行任务',exact:true}).filter({visible:true});
 if(await run.count()===1){
  let container=run;
  for(let i=0;i<5;i++){
   container=container.locator('..');
   const buttons=container.locator('button[aria-expanded][aria-label]').filter({visible:true});
   const valid=[];
   for(let j=0;j<await buttons.count();j++)if(!excluded.has(await buttons.nth(j).getAttribute('aria-label')))valid.push(buttons.nth(j));
   if(valid.length===1)return valid[0];
  }
 }
 throw Error('无法唯一定位模型选择器');
}
// Read one DOM version per sample. Holding the actual element (not nth(i))
// prevents async model refreshes from making one option look like two models.
async function modelSnapshot(page,name,timeoutMs){
 const menu=page.getByRole('listbox').filter({visible:true});
 return menu.evaluateHandle((root,name)=>{
  const inspectIdentity=element=>{
   const decode=value=>{
    if(typeof value!=='string')return null;
    const match=/^(\["(?:[^"\\]|\\.)*","(?:[^"\\]|\\.)*"\])(?:\s|$)/.exec(value);
    if(!match)return null;
    const identity=JSON.parse(match[1]);
    return identity.every(Boolean)?identity:null;
   };
   const attribute=decode(element.getAttribute('data-value')??element.getAttribute('value'));
   if(attribute)return {identity:attribute,status:'attribute'};
   // The packaged picker keeps its provider/model pair in the React option value.
   const key=Object.keys(element).find(item=>item.startsWith('__reactFiber$'));
   if(!key)return {identity:null,status:'fiber-missing'};
   const slot=element.getAttribute('data-slot');
   if(!slot)return {identity:null,status:'slot-missing'};
   let matchedSlot=false,foundValue=false;
   for(let fiber=element[key];fiber;fiber=fiber.return){
    if(fiber.tag===5&&fiber.stateNode!==element)break;
    if(fiber.memoizedProps?.['data-slot']!==slot)continue;
    matchedSlot=true;
    if(typeof fiber.memoizedProps.value==='string')foundValue=true;
    const identity=decode(fiber.memoizedProps.value);
    const alternate=fiber.alternate?.memoizedProps;
    if(identity&&alternate&&JSON.stringify(identity)!==JSON.stringify(decode(alternate.value)))return {identity:null,status:'fiber-changed'};
    if(identity)return {identity,status:'fiber'};
   }
   return {identity:null,status:foundValue?'value-unrecognized':matchedSlot?'value-missing':'slot-unmatched'};
  };
  const identityOf=element=>inspectIdentity(element).identity;
  const elements=[...root.querySelectorAll('[role="option"]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const models=elements.map(e=>{
   const {identity,status}=inspectIdentity(e);
   return {
    name:e.querySelector('span.truncate')?.textContent?.trim()||(e.innerText||'').trim().split('\n').filter(x=>x!=='--'&&x!=='默认')[0],
    selected:e.getAttribute('data-checked')==='true',
    disabled:e.hasAttribute('data-disabled')||e.getAttribute('aria-disabled')==='true',
    value:e.getAttribute('data-value')??e.getAttribute('value'),
    identity,identityStatus:status,slot:e.getAttribute('data-slot'),
   };
  });
  const matches=models.flatMap((m,i)=>m.name===name?[i]:[]);
  return {models,element:matches.length===1?elements[matches[0]]:null,identityOf};
 },name,{timeout:timeoutMs});
}
async function stableModelSnapshot(page,name,{timeoutMs=10000,stableMs=1000}={}){
 const deadline=Date.now()+timeoutMs;
 let signature='',since=Date.now(),last=[];
 while(Date.now()<deadline){
  const snapshot=await modelSnapshot(page,name,Math.max(1,deadline-Date.now()));
  let keep=false;
  try{
   last=await snapshot.evaluate(s=>s.models);
   const next=JSON.stringify(last);
   if(next!==signature){signature=next;since=Date.now();}
   const matches=last.filter(m=>m.name===name);
   // Missing/duplicate/disabled options may be transient while refreshing.
   if(last.length&&(!name||(matches.length===1&&!matches[0].disabled))&&Date.now()-since>=stableMs){keep=true;return snapshot;}
  }finally{if(!keep)await snapshot.dispose();}
  await page.waitForTimeout(100);
 }
 const matches=last.filter(m=>m.name===name);
 if(name&&Date.now()-since>=stableMs){
  if(matches.length>1)throw Error('模型重名：稳定后的同一列表存在多个同名选项，请先在客户端确认唯一模型');
  if(!matches.length)throw Error('等待模型列表加载后仍没有：'+name);
  if(matches[0].disabled)throw Error('目标模型不可用：'+name);
 }
 throw Error('模型列表在10秒内未稳定，保留现场，请稍后重试');
}
export async function readModelOptions(page,config={}){
 if(config.clientEdition)await assertClientEdition(page,config.clientEdition);
 const trigger=await modelTrigger(page);
 const current=(await trigger.innerText()).trim()||await trigger.getAttribute('aria-label');
 await waitStep(page,config);await trigger.click();
 try{
  await page.getByRole('listbox').filter({visible:true}).waitFor({timeout:5000});
  const snapshot=await stableModelSnapshot(page);
  try{return {current,models:await snapshot.evaluate(s=>s.models)};}finally{await snapshot.dispose();}
 }finally{await waitStep(page,config);await page.keyboard.press('Escape');}
}
export async function selectModel(page,name,{stepInterval=0.5,expectedIdentity,clientEdition}={}){
 if(!name)return null;
 if(clientEdition)await assertClientEdition(page,clientEdition);
 const trigger=await modelTrigger(page);await waitStep(page,{stepInterval});await trigger.click();
 await page.getByRole('listbox').filter({visible:true}).waitFor({timeout:5000});
 await waitStep(page,{stepInterval});
 const deadline=Date.now()+10000;
 let clicked=false,selectedValue=null,selectedIdentity=null;
 while(Date.now()<deadline&&!clicked){
  const snapshot=await stableModelSnapshot(page,name,{timeoutMs:deadline-Date.now()});
  const chosen=await snapshot.getProperty('element');
  try{
   // A detached row means React replaced the menu after the snapshot. Re-read
   // it; never retarget another option at the previous position.
   if(!await snapshot.evaluate((s,name)=>{
    const e=s.element,expected=s.models.find(m=>m.name===name);
    const label=row=>row.querySelector('span.truncate')?.textContent?.trim()||(row.innerText||'').trim().split('\n').filter(x=>x!=='--'&&x!=='默认')[0];
    if(!e?.isConnected||!expected||label(e)!==name||e.hasAttribute('data-disabled')||e.getAttribute('aria-disabled')==='true')return false;
    const root=e.closest('[role="listbox"]');if(!root)return false;
    const matches=[...root.querySelectorAll('[role="option"]')].filter(row=>row.getClientRects().length&&getComputedStyle(row).visibility!=='hidden'&&label(row)===name);
    return matches.length===1&&(e.getAttribute('data-value')??e.getAttribute('value'))===expected.value&&JSON.stringify(s.identityOf(e))===JSON.stringify(expected.identity);
   },name))continue;
   selectedValue=await snapshot.evaluate((s,name)=>s.models.find(m=>m.name===name)?.value,name);
   selectedIdentity=await snapshot.evaluate((s,name)=>s.models.find(m=>m.name===name)?.identity,name);
   if(expectedIdentity&&JSON.stringify(selectedIdentity)!==JSON.stringify(expectedIdentity))throw Error('目标模型身份已变化，未切换：'+name);
   const selected=await snapshot.evaluate((s,name)=>s.models.find(m=>m.name===name)?.selected,name);
   if(selected&&(selectedIdentity||selectedValue!==null)){
    await page.keyboard.press('Escape');
    return name;
   }
   try{await chosen.asElement().click({timeout:Math.max(1,deadline-Date.now())});clicked=true;}
   catch(error){
    if(!/Element is not attached|Element is not connected/i.test(error.message))throw error;
   }
  }finally{await chosen.dispose();await snapshot.dispose();}
 }
 if(!clicked)throw Error('模型选项持续刷新，未能安全选择：'+name);
 await page.getByRole('listbox').filter({visible:true}).waitFor({state:'hidden',timeout:5000});
 const verify=await readModelOptions(page,{stepInterval,clientEdition});
 const matches=verify.models.filter(m=>m.name===name);
 const sameValue=selectedValue===null||matches[0]?.value===selectedValue;
 const sameIdentity=!selectedIdentity||JSON.stringify(matches[0]?.identity)===JSON.stringify(selectedIdentity);
 if(matches.length!==1||!matches[0].selected||!sameValue||!sameIdentity)throw Error('模型切换未生效或目标已变化：'+name+'；候选数='+matches.length+'，已选中='+Boolean(matches[0]?.selected)+'，值一致='+sameValue+'，身份一致='+sameIdentity);
 return name;
}

export async function restoreHomeModel(page,owned,config={}){
 const menu=page.getByRole('listbox').filter({visible:true});
 if(await menu.count()===1)await page.keyboard.press('Escape');
 const before=await readModelOptions(page,config);
 const matches=before.models.filter(model=>model.name===owned.restore);
 const sameIdentity=model=>Array.isArray(owned.value)?JSON.stringify(model.identity)===JSON.stringify(owned.value):typeof owned.value==='string'&&Boolean(owned.value)&&model.value===owned.value;
 if(matches.length!==1||!sameIdentity(matches[0]))throw Error('原模型身份不可核对或已变化，未选择其他模型');
 if(!matches[0].selected)await selectModel(page,owned.restore,Array.isArray(owned.value)?{...config,expectedIdentity:owned.value}:config);
 const after=await readModelOptions(page,config);
 if(!after.models.some(model=>model.name===owned.restore&&sameIdentity(model)&&model.selected))throw Error('原模型恢复未确认');
}
// The current renderer concatenates the numbered badge and label in textContent
// ("1下周…"), while older builds put whitespace/newlines between them. Match
// the leading number and keep the locator scoped to the question panel.
export function questionOptions(panel){
 // The question overlay can be visually present while its ARIA subtree is
 // hidden. Native button locators still find its real, clickable controls.
 return panel.locator('button').filter({hasText:/^\s*\d+/}).filter({visible:true});
}
function sendButton(panel){
 // Discover the real control even before selection enables it.
 return panel.locator('button').filter({hasText:/^\s*发送\s*$/}).filter({visible:true});
}
const questionSignature=element=>String(element.textContent??'').replace(/\s+/g,' ').trim();

async function questionIdentity(card){
 return card.evaluate(element=>{
  for(let host=element;host;host=host.parentElement){
   const key=Object.keys(host).find(k=>k.startsWith('__reactFiber$'));
   let fiber=key&&host[key];if(!fiber)continue;
   let root=fiber;while(root.return)root=root.return;
   if(root.stateNode?.current!==root){fiber=fiber.alternate;if(!fiber)continue;}
   for(let depth=0;fiber&&depth<80;fiber=fiber.return,depth++){
    const props=fiber.memoizedProps;
    if(!Array.isArray(props?.questions)||typeof props.onReply!=='function')continue;
    for(let hook=fiber.memoizedState;hook;hook=hook.next){
     const index=hook.memoizedState?.currentIndex;
     if(!Number.isInteger(index)||!props.questions[index])continue;
     const question=props.questions[index];
     return {index,question:question.question,options:(question.options||[]).map(option=>option.label),multiple:question.multiple===true};
    }
   }
  }
  return null;
 });
}

// Click timeouts describe the CDP command, not whether Electron accepted it.
// A DOM replacement alone does not prove acceptance: require the original
// request to disappear, or the original full-access consent to become ready.
export async function clickApproval({page,button,canAct,checkReload,originUrl,log,timeoutMs,recoveryMs,consentReady}){
 try{await button.click({timeout:timeoutMs});return 'clicked';}
 catch(error){
  if(error?.name!=='TimeoutError')throw error;
 }
 log('审批点击超时，核对原请求结果','暂不判定失败、不重复点击');
 const deadline=Date.now()+recoveryMs;
 while(Date.now()<deadline){
  await checkReload();
  if(page.url()!==originUrl)throw Object.assign(Error('审批点击后页面已离开本任务会话，无法确认结果'),{blocked:true});
  try{
   if(!await canAct()){log('原审批请求已消失','点击超时未作为执行失败；继续等待模型');return 'resolved';}
   if(consentReady&&await consentReady()){log('完全访问二次确认已显示','首级点击超时，继续处理确认弹窗');return 'consent';}
  }catch(error){if(!error?.patchPermissionError)throw error;}
  await page.waitForTimeout(150);
 }
 throw Object.assign(Error('审批点击超时后仍无法确认原请求已受理；未重复点击，保留现场'),{blocked:true,approvalClickUncertain:true});
}
export async function questionPanel(page){
 // Current MobileWork single-choice cards omit the entire Send footer.
 // Identify the actual renderer's question shell, not arbitrary numbered
 // buttons in a transcript, sidebar, or generated answer.
 const cards=page.locator('div[class*="mw-question-panel-border"]').filter({visible:true});
 const candidates=[];
 for(let i=0;i<await cards.count();i++){
  const card=cards.nth(i);
  if(await card.locator('button[aria-label="关闭"]').count()!==1)continue;
  if(await questionOptions(card).count()||await card.locator('input[placeholder="请输入其他补充..."]').count()){candidates.push(card);continue;}
  const handle=await card.elementHandle();
  try{if((await questionIdentity(handle))?.multiple)candidates.push(card);}finally{await handle.dispose();}
 }
 if(candidates.length>1)throw Error('识别到多个提问面板，不能确定当前问题，保留现场');
 if(candidates.length===1)return candidates[0];
 // Older cards can still be found through their persistent Send control.
 const send=sendButton(page);
 if(await send.count()!==1)return null;
 let container=send;
 for(let i=0;i<10;i++){
  container=container.locator('..');
  if(await questionOptions(container).count() || await container.locator('textarea,input,[contenteditable="true"]').count())return container;
 }
 return null;
}
async function permissionPanel(page){
 const approve=page.getByRole('button',{name:'允许一次',exact:true}).filter({visible:true});
 if(await approve.count()!==1)return null;
 let panel=approve;
 for(let i=0;i<10;i++){
  panel=panel.locator('..');
  if(await panel.getByRole('button',{name:'拒绝',exact:true}).count()&&await panel.getByRole('button',{name:'开启完全访问权限',exact:true}).count())return panel;
 }
 return null;
}

async function permissionIdentity(card){
 return card.evaluate(element=>{
  for(let host=element;host;host=host.parentElement){
   const key=Object.keys(host).find(k=>k.startsWith('__reactFiber$'));
   let fiber=key&&host[key];if(!fiber)continue;
   let root=fiber;while(root.return)root=root.return;
   if(root.stateNode?.current!==root){fiber=fiber.alternate;if(!fiber)continue;}
   for(let depth=0;fiber&&depth<80;fiber=fiber.return,depth++){
    const props=fiber.memoizedProps,p=props?.permission;
    if(p&&typeof props.respondPermission==='function')return {id:p.id,sessionID:p.sessionID};
   }
  }
  return null;
 });
}

export async function visiblePermissionIdentity(page){
 const panel=await permissionPanel(page);if(!panel)return null;
 const card=await panel.elementHandle();if(!card)return null;
 try{return await permissionIdentity(card);}finally{await card.dispose();}
}
export async function hasPermissionIdentity(page,expected){
 const buttons=page.locator('button').filter({hasText:/^\s*允许一次\s*$/});let matches=0;
 for(let i=0;i<await buttons.count();i++){
  const button=await buttons.nth(i).elementHandle();
  try{const actual=await permissionIdentity(button);if(actual?.id===expected.id&&actual.sessionID===expected.sessionId)matches++;}
  finally{await button?.dispose();}
 }
 return matches===1;
}
export async function handleConfiguredDialog(page,config,capture,log,{kind,expectedQuestions=[],expectedPermission,canAct=async()=>true,consentCheckpoint,clickTimeoutMs=2000,clickRecoveryMs=5000}={}){
 if(config.clientEdition)await assertClientEdition(page,config.clientEdition);
 const originUrl=page.url();
 const fail=message=>{throw Object.assign(Error(message),{blocked:true});};
 const checkReload=async()=>{
  const modal=page.getByRole('dialog').filter({visible:true}).filter({hasText:'配置已更新，需要重新加载引擎'});
  if(await modal.count())throw Object.assign(Error('客户端配置要求重新加载引擎，审批被弹窗遮挡；未点击立即终止并生效，保留现场'),{blocked:true});
 };
 await checkReload();
 const approvalPanel=kind==='question'?null:await permissionPanel(page);
 if(kind!=='question'&&await page.getByRole('button',{name:'允许一次',exact:true}).filter({visible:true}).count()>1)throw Error('存在多个审批面板，不能确定本次审批');
 if(approvalPanel){
  const panel=approvalPanel;
  const profile=editionProfiles[config.clientEdition||'enterprise'];
  const aliases=config.approval==='session'?profile.sessionActions:[approvalLabels[config.approval]];
  let target;
  for(const name of aliases){const b=panel.getByRole('button',{name,exact:true}).filter({visible:true});if(await b.count()===1){target=b;break;}}
  if(!target)throw Error('审批面板没有所选操作：'+approvalLabels[config.approval]);
  // Bind the original DOM controls before the delay/capture. A locator could
  // otherwise resolve to a replacement permission and approve the wrong one.
  const card=await panel.elementHandle(),button=await target.elementHandle();
  try{
   const signature=await card.evaluate(questionSignature);
   // Fallback events must match the permission actually rendered by React.
   // Read props only: no calling private handlers, mutating state, or guessing
   // an ID from text. Unknown renderer versions remain blocked.
   const matchesPermission=async()=>{
    const expected=typeof expectedPermission==='function'?expectedPermission():expectedPermission;
    if(!expected)return true;
    const actual=await permissionIdentity(card);
    return actual?.id===expected.id&&actual.sessionID===expected.sessionID;
   };
   const unchanged=async()=>await card.evaluate((e,s)=>e.isConnected&&String(e.textContent??'').replace(/\s+/g,' ').trim()===s,signature)&&await button.isVisible()&&await matchesPermission();
   await waitStep(page,config);
   if(!await canAct()||!await unchanged())return false;
   await capture('审批前-'+approvalLabels[config.approval]);
   if(!await canAct()||!await unchanged())return false;
   if(config.approval==='full'&&await page.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true}).count())fail('开启完全访问前存在其他弹窗，不能确认归属，保留现场');
   const consent=page.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true})
    .filter({has:page.getByRole('heading',{name:'确认开启完全访问权限',exact:true})});
   if(config.approval==='full'&&consentCheckpoint){
    const state=await consentCheckpoint('prepared');
    if(state.stopRequested){await consentCheckpoint('closed');fail('任务已停止，未打开完全访问确认');}
    if(!await canAct()||!await unchanged()){await consentCheckpoint('closed');return false;}
    if((await consentCheckpoint('opening')).stopRequested){await consentCheckpoint('closed');fail('任务已停止，未打开完全访问确认');}
   }
   const clickResult=await clickApproval({page,button,canAct,checkReload,originUrl,log,timeoutMs:clickTimeoutMs,recoveryMs:clickRecoveryMs,
    consentReady:config.approval==='full'?async()=>await consent.count()===1:undefined});
   if(config.approval==='full'){
    if(clickResult==='resolved'){
     if(await consent.count())fail('原审批已消失但完全访问确认仍显示，保留现场');
     if(consentCheckpoint)await consentCheckpoint('closed');
     return false;
    }
    // This click only opens consent in MobileWork; the permission request is
    // not answered until the second button is pressed. Keep the UI lease and
    // original request throughout both steps, including delayed rendering.
    try{await consent.waitFor({state:'visible',timeout:5000});}
    catch{
     await checkReload();
     if(page.url()===originUrl&&!await canAct()&&!await consent.count()){if(consentCheckpoint)await consentCheckpoint('closed');return false;}
     fail('开启完全访问后二次确认未唯一显示，未将审批标记为已处理，保留现场');
    }
    const confirm=consent.getByRole('button',{name:'同意并开启',exact:true});
    if(await confirm.count()!==1||await consent.getByRole('button',{name:'取消',exact:true}).count()!==1)fail('完全访问二次确认控件不完整，保留现场');
    const modal=await consent.elementHandle(),ok=await confirm.elementHandle();
    try{
     const signature=await modal.evaluate(questionSignature);
     const verify=async()=>{
      await checkReload();
      if(page.url()!==originUrl||!await canAct())fail('完全访问二次确认所属会话或审批请求已变化，未确认，保留现场');
      if(!await matchesPermission())fail('完全访问确认与实时审批请求ID不匹配，保留现场');
      if(!await modal.evaluate((e,s)=>e.isConnected&&String(e.textContent??'').replace(/\s+/g,' ').trim()===s,signature)||!await ok.isVisible()||!await ok.isEnabled())fail('完全访问二次确认已变化，未点击替换后的弹窗，保留现场');
     };
     await waitStep(page,config);
     await verify();
     await capture('完全访问权限-二次确认前');
     await verify();
     if(consentCheckpoint&&(await consentCheckpoint('confirming')).stopRequested){
      await consent.getByRole('button',{name:'取消',exact:true}).click();
      await modal.waitForElementState('hidden',{timeout:5000});
      await consentCheckpoint('closed');
      fail('任务已停止，本轮完全访问确认已取消');
     }
     await clickApproval({page,button:ok,canAct,checkReload,originUrl,log,timeoutMs:clickTimeoutMs,recoveryMs:clickRecoveryMs});
     try{await ok.waitForElementState('hidden',{timeout:5000});}
     catch{fail('已点击同意并开启，但二次确认未关闭，保留现场');}
     await checkReload();
     if(page.url()!==originUrl)fail('完全访问确认后页面已离开本任务会话，保留现场');
     if(consentCheckpoint)await consentCheckpoint('closed');
     await capture('完全访问权限-二次确认后');
     log('完全访问权限二次确认完成','已点击同意并开启；继续等待本会话引擎确认');
    }finally{await modal?.dispose();await ok?.dispose();}
   }
   log('按运行配置处理审批',approvalLabels[config.approval]);return true;
  }finally{await card?.dispose();await button?.dispose();}
 }
 if(kind==='permission')return false;
 const panel=await questionPanel(page);
 if(!panel)return false;
 const card=await panel.elementHandle();
 const before=await card.evaluate(questionSignature);
 const identity=await questionIdentity(card);
 const stableText=await card.evaluate(element=>{
  const copy=element.cloneNode(true);copy.querySelectorAll('button,input,textarea,[contenteditable="true"]').forEach(node=>node.remove());
  return String(copy.textContent??'').replace(/\s+/g,' ').trim();
 });
 const valid=async(target,signature)=>{
  if(page.url()!==originUrl||!await canAct())return false;
  const actual=await card.evaluate((element,{signature,questions,stableText})=>{
   const text=String(element.textContent??'').replace(/\s+/g,' ').trim();
   const copy=element.cloneNode(true);copy.querySelectorAll('button,input,textarea,[contenteditable="true"]').forEach(node=>node.remove());
   return element.isConnected&&(!signature||text===signature)&&String(copy.textContent??'').replace(/\s+/g,' ').trim()===stableText&&(!questions.length||questions.some(q=>text.includes(q.replace(/\s+/g,' ').trim())));
  },{signature,questions:expectedQuestions,stableText});
  if(!actual)return false;
  if(identity&&JSON.stringify(await questionIdentity(card))!==JSON.stringify(identity))return false;
  return !target||await target.evaluate((element,parent)=>element.isConnected&&parent.contains(element),card);
 };
 try{
  await waitStep(page,config);
  if(!await valid(null,before))return false;
  await capture('选项弹窗');
  if(!await valid(null,before))return false;
  if(config.question==='custom'){
   let field=panel.locator('textarea,input[type="text"],input:not([type]),[contenteditable="true"]').filter({visible:true});
   if(!await field.count()){
    const custom=panel.getByRole('button',{name:/自定义|其他/}).filter({visible:true});
    if(await custom.count()===1){
     const button=await custom.elementHandle();
     try{await waitStep(page,config);if(!await valid(button,before))return false;await button.click();}
     finally{await button.dispose();}
    }
    if(!await valid())return false;
    field=panel.locator('textarea,input[type="text"],input:not([type]),[contenteditable="true"]').filter({visible:true});
   }
   if(await field.count()!==1)throw Error('当前提问没有唯一的自定义回答输入框');
   const input=await field.elementHandle();
   try{await waitStep(page,config);if(!await valid(input))return false;await input.fill(config.customText);}
   finally{await input.dispose();}
   await waitStep(page,config);
   if(!await valid())return false;
   const sends=sendButton(panel);
   if(await sends.count()!==1)throw Error('当前提问没有唯一的发送按钮');
   const send=await sends.elementHandle();
   try{if(!await valid(send))return false;await send.click();}finally{await send.dispose();}
  }else{
   const index=config.question==='first'?0:1;
   const label=identity?.multiple?identity.options[index]:null;
   const options=identity?.multiple?panel.locator('button').filter({visible:true}).filter({hasText:new RegExp('^\\s*'+String(label??'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*$')}):questionOptions(panel);
   if(identity?.multiple&&(!label||await options.count()!==1))throw Error('当前多选问题没有唯一的第'+(index+1)+'个选项');
   if(!identity?.multiple&&await options.count()<=index)throw Error('当前问题没有'+(index+1)+'个选项（实际识别到'+await options.count()+'项）');
   const option=await options.nth(identity?.multiple?0:index).elementHandle();
   const sends=sendButton(panel),send=await sends.count()===1?await sends.elementHandle():null;
   try{
    await waitStep(page,config);
    if(!await valid(option,before))return false;
    await option.click();
    await waitStep(page,config);
    if(identity?.multiple){
     if(!await valid())return false;
     const buttons=sendButton(panel);
     if(await buttons.count()!==1)throw Error('当前多选问题没有唯一的发送按钮');
     const submit=await buttons.elementHandle();
     try{if(!await valid(submit))return false;await submit.click({timeout:2000});}finally{await submit.dispose();}
    }else{
    const unchanged=await valid(null,before);
    if(unchanged&&send&&await valid(send,before)&&await send.evaluate(element=>!element.disabled)&&await send.isVisible())await send.click({timeout:2000});
    if(unchanged&&!send)await page.waitForFunction(({element,signature})=>!element.isConnected||String(element.textContent??'').replace(/\s+/g,' ').trim()!==signature,{element:card,signature:before},{timeout:5000}).catch(()=>{throw Error('已点击所选编号，但提问卡片未推进或关闭，保留现场');});
    }
   }finally{await option.dispose();await send?.dispose();}
  }
 }finally{await card.dispose();}
 await capture('选项已填写');
 log('按运行配置回答',config.question==='custom'?config.customText:config.question==='first'?'第一项':'第二项');
 return true;
}
