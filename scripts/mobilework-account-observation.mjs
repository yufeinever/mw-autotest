import {randomUUID} from 'node:crypto';
export async function readAccountPrincipal(page){
 const value=await page.evaluate(async()=>{
  const data=await window.__MOBILEWORK__.invoke('auth:current');
  return {signedIn:!!data.account?.id,role:data.account?.role||null,validation:data.oidcValidation||null};
 });
 if(!value.signedIn||!value.role||value.validation!=='valid')throw Object.assign(Error('当前登录身份或在线校验尚未确认，未切换账号'),{blocked:true});return value;
}
export function requireAccountRole(principal,role){
 const actual=principal.role==='admin'?'admin':'user';if(actual!==role)throw Object.assign(Error('本条需要'+(role==='admin'?'管理员':'普通用户')+'真实登录账号，当前前置不符；未改写账号或菜单'),{blocked:true});
}
export async function startAccountObservation(context){
 const owner=randomUUID();context.resources.accountObservation=owner;await context.checkpointResources();
 await context.page.evaluate(({owner,menuToken})=>{
  if(window.__MW_ACCOUNT_OBSERVATION__)throw Error('页面已有未结束的账户观察');
  const toastSelector='[data-sonner-toast],[role="alert"]';
  const initialToasts=new Map([...document.querySelectorAll(toastSelector)].map(element=>[element,element.textContent]));
  const state={owner,samples:[]};
  const sample=()=>{
   const menu=document.querySelector('[data-mw-account-menu="'+menuToken+'"]'),row=[...(menu?.querySelectorAll('[role="menuitem"]')||[])].find(element=>element.textContent.includes('用量余额'));
   const amount=[...(row?.querySelectorAll('span')||[])].find(element=>!element.querySelector('span')&&/^-?[\d,.]+万Token$/.test(element.textContent.trim()));
   const toasts=[...document.querySelectorAll(toastSelector)].filter(element=>element.getBoundingClientRect().height>0&&initialToasts.get(element)!==element.textContent).map(element=>element.textContent);
   const value={at:Date.now(),menuVisible:!!menu&&menu.getBoundingClientRect().height>0,loading:!!row&&!row.querySelector('button[aria-label]'),display:amount?.textContent.trim()||null,failed:toasts.some(text=>/用量|余额/.test(text)&&/失败|异常|网络|无法/.test(text))};
   const previous=state.samples.at(-1);if(!previous||['menuVisible','loading','display','failed'].some(key=>value[key]!==previous[key]))state.samples.push(value);
  };
  state.observer=new MutationObserver(sample);state.observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});state.sample=sample;window.__MW_ACCOUNT_OBSERVATION__=state;sample();
 },{owner,menuToken:context.resources.accountMenuToken});return owner;
}
export async function readAccountObservation(page,owner,{stop=false}={}){
 return page.evaluate(({owner,stop})=>{
  const state=window.__MW_ACCOUNT_OBSERVATION__;if(!state||state.owner!==owner)throw Error('账户观察归属不匹配');state.sample();const samples=state.samples;
  if(stop){state.observer.disconnect();delete window.__MW_ACCOUNT_OBSERVATION__;}return samples;
 },{owner,stop});
}
export async function releaseAccountObservation(page,resources){
 if(!resources.accountObservation)return;
 await page.evaluate(owner=>{const state=window.__MW_ACCOUNT_OBSERVATION__;if(!state)return;if(state.owner!==owner)throw Error('账户观察归属已变化，保留其他观察');state.observer.disconnect();delete window.__MW_ACCOUNT_OBSERVATION__;},resources.accountObservation);delete resources.accountObservation;
}
export function refreshObservationFacts(samples){
 const started=samples.findIndex(sample=>sample.loading),after=started<0?[]:samples.slice(started+1),last=samples.at(-1);
 return {started:started>=0,settled:after.length>0&&!last.loading&&last.menuVisible&&last.display!==null,failed:after.some(sample=>sample.failed),last};
}

export function manualRefreshChange(fact,{identity,before,after,observedAt,clickedAt}){
 const change=fact?.refresh;
 return Boolean(change&&fact.accountLabelSha256===identity&&fact.balance===after&&change.balanceBefore===before&&change.balanceAfter===after&&before!==after&&Date.parse(change.changedAt)>=observedAt&&Date.parse(change.changedAt)<=clickedAt);
}
