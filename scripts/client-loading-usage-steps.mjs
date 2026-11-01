import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersonalization,setPersonalization,openPersonalization,closePersonalization} from './mobilework-personalization.mjs';
import {startMessageObservation,readMessageObservation} from './mobilework-message-observer.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const messages=page=>page.locator('[data-session-messages="true"]:not([aria-hidden="true"])');
const tools=data=>data.messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool'));
const longTask='请为虚构星桥设备交接制定80项不同的验收清单，每项包含检查动作与预期结果，分成8组，每组10项。逐项编号1至80，不省略。先认真分析覆盖范围，再直接输出完整清单，不调用外部网络，不修改用户文件。';
export const totalTokens=data=>data.messages.reduce((sum,message)=>{
 const t=message.info?.tokens;
 return sum+(t?t.input+t.output+t.reasoning+(t.cache?.read||0)+(t.cache?.write||0):0);
},0);

export function generationFacts(data){
 const completed=data.messages.filter(message=>message.info?.role==='assistant'&&message.info.time?.completed);
 const generation=completed.filter(message=>message.info.tokens).map(message=>{
  const parts=message.parts.filter(part=>part.type==='reasoning'||part.type==='text'&&!part.synthetic&&!part.ignored||part.type==='tool');
  const starts=parts.filter(part=>part.type!=='tool').map(part=>part.time?.start).filter(value=>value>0);
  const ends=parts.map(part=>part.type==='tool'?part.state.time?.start:part.time?.end).filter(value=>value>0);
  return {output:message.info.tokens.output,ms:(ends.length?Math.max(...ends):message.info.time.completed)-(starts.length?Math.min(...starts):message.info.time.created)};
 }).filter(item=>item.ms>0);
 const elapsed=Math.floor((Math.max(...completed.map(message=>message.info.time.completed))-Math.min(...completed.map(message=>message.info.time.created)))/1000);
 return {generation,elapsed,ms:generation.reduce((sum,item)=>sum+item.ms,0),output:generation.reduce((sum,item)=>sum+item.output,0)};
}

export async function usageSnapshot(page){
 const group=messages(page).locator('.group\\/message-group').last();
 await group.hover();
 return group.evaluate(element=>{
  const spans=[...element.querySelectorAll('span')].filter(span=>!span.querySelector('span'));
  const token=spans.find(span=>/^\d+\.\d{2}万token$/.test(span.textContent));
  const rate=spans.find(span=>/^\d+\.\d{2}t\/s$/.test(span.textContent));
  const row=token?.parentElement.parentElement;
  const duration=spans.find(span=>/^(?:\d+d )?(?:\d+h )?(?:\d+m )?\d+s$/.test(span.textContent));
  return {tokens:token?.textContent||'',rate:rate?.textContent||'',duration:duration?.textContent||'',text:row?.innerText||'',success:!!row?.textContent.includes('执行成功'),separators:row?[...row.children].filter(child=>child.getAttribute('aria-hidden')==='true').length:0};
 });
}

function loadingEpisodes(observation){
 const episodes=new Map();
 for(const sample of observation.samples){
  for(const row of sample.rows){
   if(!episodes.has(row.id))episodes.set(row.id,{start:sample.at,end:sample.at,rows:[]});
   const episode=episodes.get(row.id);episode.end=sample.at;episode.rows.push({at:sample.at,...row});
  }
  for(const [id,episode] of episodes)if(!episode.closed&&!sample.rows.some(row=>row.id===id)){episode.end=sample.at;episode.closed=true;}
 }
 for(const episode of episodes.values())if(!episode.closed)episode.end=observation.endedAt;
 return [...episodes.values()];
}

export async function runLoadingUsageSteps(context){
 const {number,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,newSession,checkpointResources,getData,getSessionId}=context;
 const finish=step=>remaining.delete(step),ui=action=>control.withUI(page,'INTERACTING',action);
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
 async function observedSend(text,{label,waitOptions={},...options}){
  const owner=randomUUID();
  await ui(async()=>{resources.messageObservation=owner;await checkpointResources();await startMessageObservation(page,owner);});
  try{return await send(text,{...options,waitOptions});}
  finally{await ui(async()=>{const observation=await readMessageObservation(page,{stop:true,owner});await save(label+'.json',observation);delete resources.messageObservation;await checkpointResources();});}
 }
 async function preferences(target){
  await ui(async()=>{
   if(!resources.personalization){resources.personalization=await readPersonalization(page);await checkpointResources();await save('个性化恢复基线.json',resources.personalization);}
   const actual=await setPersonalization(page,target);
   assert('个性化两项设置通过真实控件生效',actual.showLoadingTips===target.showLoadingTips&&actual.agentTone===target.agentTone,actual);
   await capture('个性化-'+({concise:'简洁高效',rigorous:'严谨详尽',friendly:'亲和友好'}[target.agentTone])+'-'+(target.showLoadingTips?'开启':'关闭'));
  });
 }
 async function validateWelcome(file,tone,{rotation=false}={}){
  const observation=JSON.parse(await fs.readFile(path.join(dir,file+'.json'),'utf8'));
  const episodes=loadingEpisodes(observation),episode=episodes.find(item=>item.rows.some(row=>row.welcome&&row.opacity>=0.9));
  if(!episode)throw review('没有捕获持续到欢迎语显示的真实Loading，保留时间线，不伪造等待时长');
  const first=episode.rows.find(row=>row.welcome&&row.opacity>=0.9),elapsed=first.at-episode.start;
  const corpus=JSON.parse(await fs.readFile(new URL('fixtures/loading-greetings.json',import.meta.url),'utf8'));
  assert('欢迎语文案属于当前设置语调',corpus.tones[tone].includes(first.welcome),{tone,text:first.welcome,source:corpus.source});
  assert('欢迎语以竖线与Loading分隔',first.separator,first);
  if(!rotation)return;
  if(episode.rows[0].welcome)throw review('首次捕获Loading时已显示欢迎语，未取得起点，不判断四秒延迟');
  const premature=episode.rows.filter(row=>row.at-episode.start<3850&&row.opacity>0.05&&row.welcome);
  assert('欢迎语没有在四秒前提前显示',!premature.length,{elapsed,premature});
  assert('四秒后首次显示欢迎语',elapsed>=3850&&elapsed<=4900,{elapsedMs:elapsed});
  finish('前四秒隐藏及首次欢迎语');
  const changes=[];
  for(const row of episode.rows.filter(row=>row.welcome&&row.opacity>=0.9))if(changes.at(-1)?.welcome!==row.welcome)changes.push(row);
  if(changes.length<2)throw review('真实Loading没有持续到第二条欢迎语，十秒轮换尚未覆盖');
  for(let index=1;index<changes.length;index++){
   const interval=changes[index].at-changes[index-1].at;
   assert('欢迎语约十秒轮换且不连续重复',interval>=9500&&interval<=11500&&changes[index].welcome!==changes[index-1].welcome,{intervalMs:interval,previous:changes[index-1].welcome,current:changes[index].welcome});
  }
  assert('欢迎语轮换捕获真实淡入淡出',episode.rows.some(row=>row.opacity>0&&row.opacity<0.9&&parseFloat(row.transition)>0));
  finish('十秒轮换与淡入淡出');
 }
 async function checkUsage(label,data){
  const actual=await ui(()=>usageSnapshot(page)),total=totalTokens(data);
  await save(label+'数值核对.json',{sessionId:getSessionId(),actual,engineTokens:total});
  assert(label+'客户端总Token格式保留两位小数',/^\d+\.\d{2}万token$/.test(actual.tokens),actual);
  assert(label+'客户端总Token与本Session引擎各桶一致',Number.parseFloat(actual.tokens)===(total/10000).toFixed(2)*1,{actual:actual.tokens,engine:total});
  await capture(label+'统计');return actual;
 }

 if(number===42){
  await send('这是本轮隔离测试。请在当前任务目录创建“折叠样例.txt”，内容包含“星桥折叠验收”和80条设备检查项，再实际读取文件，核对首尾内容。完成后在最终回复完整列出这80条检查项，每条写出检查动作和预期结果，首行标注“清单开始”，末行标注“清单结束”。');
  const data=getData(),completed=tools(data).filter(tool=>tool.state?.status==='completed');
  const reply=data.messages.filter(message=>message.info?.role==='assistant').at(-1)?.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n')||'';
  assert('本Session确有完成的文件工具调用',completed.length>0,completed.map(tool=>tool.tool));
  const material=await fs.readFile(path.join(control.directory,'折叠样例.txt'),'utf8');
  assert('本Session真实文件与长回复完整',material.includes('星桥折叠验收')&&reply.includes('清单开始')&&reply.includes('清单结束')&&reply.length>=1500,{length:reply.length});
  assert('真实工具返回本轮文件内容',completed.some(tool=>JSON.stringify(tool.state.output).includes('星桥折叠验收')));
  await fs.writeFile(path.join(dir,'折叠样例.txt'),material);outputs.push({name:'折叠样例',path:'折叠样例.txt'});finish('真实工具及超长回复');
  await ui(async()=>{
   const expand=messages(page).getByRole('button',{name:'展开执行过程',exact:true});
   if(!await expand.count())throw review('本轮没有触发执行过程收纳，工具默认折叠分支待复核');
   assert('工具执行过程默认折叠',await expand.first().getAttribute('aria-expanded')==='false');
   await capture('工具过程默认折叠');await expand.first().click();
   const collapse=messages(page).getByRole('button',{name:'收起执行过程',exact:true}).first();await collapse.waitFor();
   assert('展开执行过程后展示本轮文件工具',(await messages(page).innerText()).includes('折叠样例.txt'));await capture('工具过程展开');
   await collapse.click();finish('工具调用默认折叠与完整展开');
   // Final text is inspected outside the process block. Its disclosure must
   // belong to the final text, never the already-tested process control.
   const last=messages(page).locator('[data-message-role="assistant"]').filter({hasText:'清单结束'}).last();await last.waitFor();
   const size=await last.evaluate(element=>({height:element.scrollHeight,viewport:element.closest('[data-session-messages]').clientHeight,text:element.textContent.length}));
   await save('最终长消息边界.json',size);
   if(size.height<=size.viewport)throw review('最终回复没有超过真实消息视口，超长消息阈值分支待验证');
   const toggle=last.getByRole('button',{name:/^(展开|展开全部|查看全部|查看更多)$/}).filter({visible:true});
   assert('超长最终回复提供独立展开入口',await toggle.count()===1,size);
   const before=await last.innerText();await toggle.click();
   assert('展开最终回复后首尾内容完整',(await last.innerText()).includes('清单开始')&&(await last.innerText()).includes('清单结束')&&(await last.innerText()).length>=before.length);
   const collapseMessage=last.getByRole('button',{name:/^(收起|收起全部)$/}).filter({visible:true});await collapseMessage.click();await capture('最终消息收起');finish('超长消息独立折叠与完整展开');
  });
 }else if(number===43){
  await preferences({showLoadingTips:true,agentTone:'concise'});finish('开启及基础语调设置');
  await observedSend(longTask,{label:'基础语调欢迎语时间线'});
  // Do not skip the second tone when the first task completed too quickly.
  let missing;
  try{await validateWelcome('基础语调欢迎语时间线','concise',{rotation:true});}catch(error){if(!error.review)throw error;missing=error.message;log('基础语调覆盖缺口',missing);}
  await newSession();await preferences({showLoadingTips:true,agentTone:'friendly'});
  await observedSend(longTask,{label:'友好语调新Session时间线'});await validateWelcome('友好语调新Session时间线','friendly');finish('新Session友好语调跟随');
  if(missing)throw review(missing);
 }else if(number===44){
  await preferences({showLoadingTips:true,agentTone:'friendly'});
  let dismissed=false;
  await observedSend(longTask,{label:'悬停关闭欢迎语时间线',waitOptions:{observe:async({pending})=>{
   if(pending.length||dismissed)return;
   const welcome=messages(page).locator('span.group').filter({has:page.getByRole('button',{name:'不再显示',exact:true,includeHidden:true})});
   if(!await welcome.count())return;
   await ui(async()=>{
    await welcome.hover();const dismiss=welcome.getByRole('button',{name:'不再显示',exact:true});await dismiss.waitFor();await capture('欢迎语悬停关闭入口');
    await dismiss.click();await welcome.waitFor({state:'hidden'});
    assert('不再显示立即关闭且持久化开关为关闭',(await readPersonalization(page)).showLoadingTips===false);dismissed=true;finish('悬停与即时关闭');await capture('欢迎语立即消失');
   });
  }}});
  if(!dismissed)throw review('本轮Loading未显示欢迎语，未操作关闭入口');
  await newSession();await observedSend(longTask,{label:'关闭后新Session时间线'});
  const closed=JSON.parse(await fs.readFile(path.join(dir,'关闭后新Session时间线.json'),'utf8'));
  if(!loadingEpisodes(closed).some(episode=>episode.end-episode.start>=5000))throw review('关闭后新Session未捕获持续至少五秒的Loading，保留时间线，不判不再显示通过');
  assert('关闭后新Session所有真实Loading均无欢迎语',closed.samples.every(sample=>sample.rows.every(row=>!row.welcome)));finish('关闭后新Session不再展示');
  await ui(async()=>{const dialog=await openPersonalization(page);assert('设置页面欢迎语开关同步为关闭',await dialog.getByRole('switch',{name:'加载欢迎语',exact:true}).getAttribute('aria-checked')==='false');await capture('设置同步关闭');await closePersonalization(page);});
  await preferences({showLoadingTips:true,agentTone:'friendly'});await newSession();
  await observedSend(longTask,{label:'重新开启新Session时间线'});await validateWelcome('重新开启新Session时间线','friendly');finish('设置关闭回读与重新开启恢复');
 }else if(number===45){
  const engineSamples=[];let liveCaptured=false;
  await observedSend(longTask,{label:'实时Token展示时间线',waitOptions:{observe:async({states,pending})=>{
   if(pending.length||states[getSessionId()]?.type!=='busy')return;
   const data=await control.readLog(),tokens=totalTokens(data),observation=await readMessageObservation(page,{owner:resources.messageObservation}),sample=observation.samples.at(-1);
   engineSamples.push({at:Date.now(),tokens,live:sample?.live||[],metrics:sample?.metrics||[]});
   if(tokens===0&&sample?.rows.length){assert('实际零Token阶段统计组件隐藏',sample.live.length===0&&sample.metrics.length===0,sample);finish('无Token时隐藏');}
   if(sample?.live.some(text=>text.endsWith('万token'))&&!liveCaptured){await capture('执行中Token统计');liveCaptured=true;}
  }}});
  await save('引擎Token过程采样.json',engineSamples);
  const observation=JSON.parse(await fs.readFile(path.join(dir,'实时Token展示时间线.json'),'utf8'));
  const live=observation.samples.filter(sample=>sample.rows.length&&sample.live.length);
  if(live.some(sample=>sample.live.some(text=>/^\d+\.\d{2}t\/s$/.test(text)))&&new Set(live.map(sample=>sample.live.join('|'))).size>=2){assert('执行中统计有真实更新且速度格式正确',true);finish('执行中Token与速度更新');}
  const actual=await checkUsage('完成后',getData());
  const {generation,elapsed,ms,output}=generationFacts(getData());
  assert('最终统计展示成功状态、总耗时及分隔线',actual.success&&!!actual.duration&&actual.separators>=3,actual);
  const displayed=actual.duration.match(/(?:(\d+)h )?(?:(\d+)m )?(\d+)s$/);
  assert('最终总耗时与本Session助手起止时间一致',!!displayed&&Number(displayed[1]||0)*3600+Number(displayed[2]||0)*60+Number(displayed[3])===elapsed,{actual:actual.duration,elapsedSeconds:elapsed});
  if(ms>0&&output>0){assert('最终速度与真实输出Token及生成时段一致',actual.rate===(output/(ms/1000)).toFixed(2)+'t/s',{actual:actual.rate,output,generationMs:ms});finish('最终消耗速度耗时状态');}
  await ui(async()=>{
   const group=messages(page).locator('.group\\/message-group').last();
   for(const [value,tip] of [[actual.tokens,'总计消耗token'],[actual.rate,'每秒生成 Token 数']]){
    if(!value)throw review('当前任务没有可悬停的统计值，提示分支待验证');
    await group.getByText(value,{exact:true}).last().hover();
    const tooltip=page.getByRole('tooltip').filter({visible:true});await tooltip.waitFor();
    assert('统计悬停提示：'+tip,(await tooltip.innerText()).replace(/\s+/g,'')===tip.replace(/\s+/g,''));await capture('统计提示-'+tip);
   }
  });finish('Token与速度提示');
 }else if(number===46){
  await send('这是隔离统计测试。请只计算127加286，简短说明结果。');await checkUsage('短任务',getData());finish('短任务客户端记录');
  await newSession();await send(longTask);await checkUsage('长任务',getData());finish('长任务客户端记录');
  const prerequisite={gateway:'未提供可按本轮Session或请求ID查询的独立模型网关接口及授权；本地引擎数据只用于客户端一致性核对，不能替代网关',statistics:''};
  await ui(async()=>{
   await page.locator('[data-testid="sidebar-account-footer"] button[data-sidebar="menu-button"][aria-haspopup="menu"]').click();
   const menu=page.getByRole('menu').filter({visible:true});await menu.waitFor();
   const entries=await menu.getByRole('menuitem').allTextContents();await save('当前资源统计入口检查.json',{entries});await capture('账户菜单实际统计入口');
   prerequisite.statistics=entries.some(text=>text.includes('资源统计'))?'发现资源统计入口，日月切换尚需核对当前版本界面':'当前账户菜单没有原表资源统计入口；余额和上下文用量不能替代日月Token统计';
   await page.keyboard.press('Escape');
  });
  await save('网关及统计前置缺口.json',prerequisite);throw review(prerequisite.gateway+'；'+prerequisite.statistics);
 }
}
