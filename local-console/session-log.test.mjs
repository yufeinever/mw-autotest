import test from 'node:test';
import assert from 'node:assert/strict';
import {readSessionLog} from './session-log.mjs';
test('导出保留工具详情并隐藏凭证，读取失败不生成空日志',async()=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;
 const routes=[];
 globalThis.window={__OPENWORK_ELECTRON__:{invokeDesktop:async()=>({baseUrl:'http://127.0.0.1:1234',opencodeUsername:'test',opencodePassword:'engine-secret'})},__MOBILEWORK__:{invoke:async()=>({models:[{apiKey:'custom-secret-value'}]})}};
 globalThis.fetch=async url=>{routes.push(url);return {ok:true,json:async()=>url.includes('/message')?[{info:{sessionID:'ses_test',role:'assistant',time:{created:1}},parts:[{type:'tool',tool:'shell',state:{status:'error',input:{command:'echo test',apiKey:'custom-secret-value'},error:'password=hidden-value',output:'custom-secret-value'}}]}]:{id:'ses_test',directory:'D:/工作空间'}};};
 try{const data=await readSessionLog('ses_test');assert.equal(data.messageCount,1);assert.equal(data.messages[0].parts[0].state.status,'error');assert.equal(data.messages[0].parts[0].state.input.command,'echo test');assert.ok(!JSON.stringify(data).includes('custom-secret-value'));assert.ok(!JSON.stringify(data).includes('hidden-value'));assert.match(routes[1],/directory=/);
 globalThis.fetch=async()=>({ok:false,status:404});await assert.rejects(()=>readSessionLog('ses_test'),/404/);await assert.rejects(()=>readSessionLog('../bad'),/ID/);
 }finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});
test('采集子会话核对 parentID；不读取任意历史会话',async()=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window,routes=[];
 globalThis.window={__OPENWORK_ELECTRON__:{invokeDesktop:async()=>({baseUrl:'http://127.0.0.1:1234',opencodeUsername:'test',opencodePassword:'secret'})},__MOBILEWORK__:{invoke:async()=>({models:[]})}};
 globalThis.fetch=async url=>{routes.push(url);const route=new URL(url).pathname;let data;
  if(route.endsWith('/children'))data=route.includes('ses_root')?[{id:'ses_child',parentID:'ses_root'},{id:'ses_foreign',parentID:'ses_other'}]:[];
  else if(route.endsWith('/message'))data=[{info:{sessionID:route.includes('ses_root')?'ses_root':'ses_child',role:'assistant'},parts:[]}];
  else data={id:route.split('/').at(-1),parentID:route.includes('ses_child')?'ses_root':undefined};
  return {ok:true,json:async()=>data};
 };
 try{const data=await readSessionLog({sessionId:'ses_root',includeChildren:true});assert.equal(data.children[0].sessionId,'ses_child');assert.equal(data.childrenCollected,true);assert.match(data.traceErrors.join(),/归属/);assert.ok(!routes.some(url=>url.includes('/ses_foreign')));}
 finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});

test('后台等待读取Session也隐藏客户端自定义密钥，不依赖当前渲染页面',async()=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;delete globalThis.window;
 globalThis.fetch=async url=>({ok:true,json:async()=>url.includes('/message')?[{info:{sessionID:'ses_background',role:'assistant'},parts:[{type:'text',text:'工具输出 custom-background-secret-value'}]}]:{id:'ses_background',directory:'D:/isolated'}});
 try{
  const data=await readSessionLog({sessionId:'ses_background',connection:{baseUrl:'http://127.0.0.1:1234',opencodeUsername:'test',opencodePassword:'engine-secret',redactionSecrets:['custom-background-secret-value']}});
  assert.ok(!JSON.stringify(data).includes('custom-background-secret-value'));assert.match(data.messages[0].parts[0].text,/REDACTED/);
 }finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});
