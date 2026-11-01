import path from 'node:path';
import fs from 'node:fs/promises';
import {settleSkillReload} from './mobilework-skill-resources.mjs';

export async function knowledgeClient(page){
 const info=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo'));
 const url=new URL(info.baseUrl);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('知识库服务地址不是本机地址');
 const base=info.baseUrl.replace(/\/$/,''),headers={Authorization:'Bearer '+(info.ownerToken||info.clientToken),'content-type':'application/json'};
 return async(route,body)=>{
  const response=await fetch(base+route,{headers,signal:AbortSignal.timeout(15000),...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  const data=await response.json();
  if(!response.ok||data.success!=='true')throw Error('知识库接口失败 '+route+'：HTTP '+response.status);
  return data.data;
 };
}

export async function removeOwnedKnowledge(call,owned){
 const current=(await call('/knowledge/list')).find(item=>item.id===owned.id);
 if(!current)return;
 if(current.name!==owned.name||path.resolve(current.storage_dir).toLowerCase()!==path.resolve(owned.storageDir).toLowerCase())throw Error('本轮知识库归属不匹配，未移除注册');
 const progress=await call('/knowledge/'+owned.id+'/progress');
 if(progress.isActive||progress.pause)throw Object.assign(Error('本轮知识库仍在解析或暂停，保留注册和材料，待解析结束后恢复收尾'),{blocked:true});
 // The parser creates a runtime .env under its wiki folder. It can contain
 // model credentials and must not remain inside served test evidence.
 const wiki=path.resolve(current.wiki_dir),relative=path.relative(path.resolve(owned.storageDir),wiki);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('本轮Wiki目录不在隔离材料内，未清理运行时配置');
 await fs.rm(path.join(wiki,'wiki','.env'),{force:true});
 await call('/knowledge/remove',{id:owned.id,sync_delete_data:'0'});
 if((await call('/knowledge/list')).some(item=>item.id===owned.id))throw Error('本轮知识库注册移除未确认');
}

export async function knowledgeParserDiagnostic(wikiDir){
 const logs=path.join(wikiDir,'logs');
 let files;
 try{files=await fs.readdir(logs);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 for(const name of files.filter(name=>name.endsWith('.log'))){
  const text=await fs.readFile(path.join(logs,name),'utf8');
  if(text.includes('document_parser_runtime_unavailable'))return {code:'document_parser_runtime_unavailable',exitCodeHex:text.includes('0xc0000135')?'0xc0000135':null};
 }
 return null;
}

export async function openKnowledgeSettings(page,{capture=async()=>{},log=()=>{}}={}){
 const settings=page.getByRole('dialog',{name:'设置',exact:true}).filter({visible:true});
 const entry=page.getByRole('button',{name:'设置',exact:true}).filter({visible:true});
 const reload=page.getByRole('dialog').filter({visible:true}).filter({hasText:'配置已更新，需要重新加载引擎'});
 const wait=reload.getByRole('button',{name:'等待会话结束后生效',exact:true});
 while(!await settings.isVisible()){
  await entry.or(wait).first().waitFor();
  if(await reload.isVisible()){
   await capture('知识库设置入口延迟引擎确认');
   log('知识库设置入口处理引擎确认','等待会话结束后生效');
  }
  // Resolve the actionable control again at click time: the reload modal may
  // arrive after the board entry was ready and hide its accessibility role.
  await entry.or(wait).first().click();
  await settings.or(entry).or(wait).first().waitFor();
 }
 await settings.getByRole('switch',{name:'引用',exact:true}).waitFor();
 return settings;
}

export async function closeKnowledgeSettings(page,owned){
 await settleSkillReload(page);
 const dialog=page.getByRole('dialog',{name:'设置',exact:true}).filter({visible:true});
 if(await dialog.count()===1&&(await dialog.innerText()).includes(owned.storageDir)){
  await dialog.press('Escape');await dialog.waitFor({state:'hidden'});
 }
 if(await page.getByRole('dialog').filter({visible:true}).count())throw Error('仍有未确认归属的弹窗，保留现场');
}
