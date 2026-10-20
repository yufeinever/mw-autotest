import {normalizeConfig,approvalLabels} from '../local-console/policy.mjs';

export function readRunConfig(){return process.env.MW_TEST_CONFIG_JSON?normalizeConfig(JSON.parse(process.env.MW_TEST_CONFIG_JSON)):null;}
export async function modelTrigger(page){
 const candidates=page.locator('button[aria-expanded][aria-label]').filter({visible:true});
 const excluded=new Set(['上传文件','模式','技能','专家','工具','知识库','权限']);
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
export async function readModelOptions(page){
 const trigger=await modelTrigger(page);
 const current=await trigger.innerText();
 await trigger.click();
 try{
  await page.getByRole('listbox').filter({visible:true}).waitFor({timeout:5000});
  return {current,models:await page.getByRole('option').filter({visible:true}).evaluateAll(es=>es.map(e=>({name:e.querySelector('span.truncate')?.textContent?.trim()||e.innerText.trim().split('\n').filter(x=>x!=='--'&&x!=='默认')[0],selected:e.getAttribute('data-checked')==='true',disabled:e.hasAttribute('data-disabled')})))};
 }finally{await page.keyboard.press('Escape');}
}
export async function selectModel(page,name){
 if(!name)return null;
 const trigger=await modelTrigger(page);await trigger.click();
 const options=page.getByRole('option').filter({visible:true});
 await options.first().waitFor({timeout:5000});
 let chosen;
 for(let i=0;i<await options.count();i++){
  const option=options.nth(i);
  if(await option.getByText(name,{exact:true}).count()){
   if(chosen)throw Error('模型重名，请先在客户端确认唯一模型');
   chosen=option;
  }
 }
 if(!chosen)throw Error('当前模型列表中没有：'+name);
 if(await chosen.getAttribute('data-disabled')!==null)throw Error('目标模型不可用：'+name);
 await chosen.click();
 await page.getByRole('listbox').filter({visible:true}).waitFor({state:'hidden',timeout:5000});
 const verify=await readModelOptions(page);
 if(!verify.models.some(m=>m.name===name&&m.selected))throw Error('模型切换未生效：'+name);
 return name;
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
const questionSignature=element=>element.textContent.replace(/\s+/g,' ').trim();
export async function questionPanel(page){
 // Current MobileWork single-choice cards omit the entire Send footer.
 // Identify the actual renderer's question shell, not arbitrary numbered
 // buttons in a transcript, sidebar, or generated answer.
 const cards=page.locator('div[class*="mw-question-panel-border"]').filter({visible:true});
 const candidates=[];
 for(let i=0;i<await cards.count();i++){
  const card=cards.nth(i);
  if(await card.locator('button[aria-label="关闭"]').count()===1&&
   (await questionOptions(card).count()||await card.locator('input[placeholder="请输入其他补充..."]').count()))candidates.push(card);
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
export async function handleConfiguredDialog(page,config,capture,log){
 const approve=page.getByRole('button',{name:'允许一次',exact:true}).filter({visible:true});
 if(await approve.count()){
  await page.waitForTimeout(1000);
  if(!await approve.count())return false;
  let panel=approve;
  for(let i=0;i<10;i++){panel=panel.locator('..');if(await panel.getByRole('button',{name:'拒绝',exact:true}).count()&&await panel.getByRole('button',{name:'开启完全访问权限',exact:true}).count())break;}
  await capture('审批前-'+approvalLabels[config.approval]);
  const aliases=config.approval==='session'?['在会话期间允许','在会话期间运行']:[approvalLabels[config.approval]];
  let target;
  for(const name of aliases){const b=panel.getByRole('button',{name,exact:true}).filter({visible:true});if(await b.count()===1){target=b;break;}}
  if(!target)throw Error('审批面板没有所选操作：'+approvalLabels[config.approval]);
  await target.click();log('按运行配置处理审批',approvalLabels[config.approval]);return true;
 }
 let panel=await questionPanel(page);
 if(!panel)return false;
 await page.waitForTimeout(1000);
 panel=await questionPanel(page);
 if(!panel)return false;
 await capture('选项弹窗');
 if(config.question==='custom'){
  let field=panel.locator('textarea,input[type="text"],input:not([type]),[contenteditable="true"]').filter({visible:true});
  if(!await field.count()){
   const custom=panel.getByRole('button',{name:/自定义|其他/}).filter({visible:true});
   if(await custom.count()===1)await custom.click();
   field=panel.locator('textarea,input[type="text"],input:not([type]),[contenteditable="true"]').filter({visible:true});
  }
  if(await field.count()!==1)throw Error('当前提问没有唯一的自定义回答输入框');
  await field.fill(config.customText);
  await sendButton(panel).click();
 }else{
  const options=questionOptions(panel);
  const index=config.question==='first'?0:1;
  if(await options.count()<=index)throw Error('当前问题没有'+(index+1)+'个选项（实际识别到'+await options.count()+'项）');
  // Keep handles to this question. A locator based on Send can resolve to the
  // next question after the renderer advances, and must never submit that one.
  const card=await panel.elementHandle();
  const sends=sendButton(panel),send=await sends.count()===1?await sends.elementHandle():null;
  try{
   const before=await card.evaluate(questionSignature);
   await options.nth(index).click();
   // New cards advance/submit immediately. Legacy cards keep the same question
   // and enable Send; only submit if these exact controls still belong to it.
   await page.waitForTimeout(200);
   const unchanged=await card.evaluate((element,signature)=>element.isConnected&&element.textContent.replace(/\s+/g,' ').trim()===signature,before);
   if(unchanged&&send&&await send.evaluate(element=>element.isConnected&&!element.disabled)&&await send.isVisible())await send.click({timeout:2000});
   if(unchanged&&!send)await page.waitForFunction(({element,signature})=>!element.isConnected||element.textContent.replace(/\s+/g,' ').trim()!==signature,{element:card,signature:before},{timeout:5000}).catch(()=>{throw Error('已点击所选编号，但提问卡片未推进或关闭，保留现场');});
  }finally{await card?.dispose();await send?.dispose();}
 }
 await capture('选项已填写');
 log('按运行配置回答',config.question==='custom'?config.customText:config.question==='first'?'第一项':'第二项');
 return true;
}
