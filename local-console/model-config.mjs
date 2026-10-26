import {isClientPageUrl} from './client-page.mjs';
import {chromium} from 'playwright-core';
import {normalizeConfig} from './policy.mjs';
export async function saveClientModel(input){
 const c=normalizeConfig(input),p=c.provider;
 if(!p.url.trim()||!p.model.trim()||!p.key.trim())throw Error('请填写 URL、Key 和模型名称');
 const url=new URL(p.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('请输入有效的 HTTP/HTTPS URL');
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${c.cdpPort}`,{timeout:8000});
 try{
  const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>isClientPageUrl(p.url()));
  if(pages.length!==1)throw Error('没有唯一的 MobileWork 主界面');
  const page=pages[0];if(await page.getByRole('button',{name:'停止',exact:true}).filter({visible:true}).count())throw Error('客户端正在执行任务，请结束后保存模型');
  return await page.evaluate(async p=>{
   const api=window.__MOBILEWORK__;const before=await api.invoke('models:list');
   if(!Array.isArray(before.models))throw Error('客户端模型列表不可读取');
   const matches=before.models.filter(m=>!m.builtin&&m.modelId===p.model.trim()&&m.baseUrl.replace(/\/$/,'')===p.url.trim().replace(/\/$/,''));
   if(matches.length>1)throw Error('存在多个相同模型，请先在客户端整理');
   const model={...(matches[0]||{}),id:matches[0]?.id||'console-'+crypto.randomUUID(),name:matches[0]?.name||'自定义 · '+p.model.trim(),baseUrl:p.url.trim(),apiKey:p.key,modelId:p.model.trim(),enabled:true,auth:{type:'bearer'},mafEnabled:false,limit:{input:p.inputTokens,output:p.outputTokens},inputModality:p.multimodal?'image':'text'};
   const models=matches.length?before.models.map(m=>m.id===model.id?model:m):[...before.models,model];
   const saved=await api.invoke('models:save',{models,expectedRevision:before.revision});
   if(!saved.ok||saved.projection?.ok===false)throw Error('客户端保存或模型同步失败，请在模型设置中核查');
   const after=await api.invoke('models:list'),actual=after.models.find(m=>m.id===model.id);
   if(!actual||actual.modelId!==model.modelId||actual.baseUrl!==model.baseUrl||actual.limit?.input!==p.inputTokens||actual.limit?.output!==p.outputTokens||actual.inputModality!==model.inputModality)throw Error('保存后的模型参数核对失败');
   window.dispatchEvent(new CustomEvent('openwork-workspace-models-invalidated',{detail:{reason:'model-config'}}));
   return {ok:true,model:actual.modelId,id:actual.id};
  },p);
 }finally{await browser.close();}
}
