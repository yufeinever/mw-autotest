import fs from 'node:fs/promises';
import path from 'node:path';
import {openCanvas} from './client-kanban-steps.mjs';
import {readMailBaseline,disposablePendingMail,priorityForFacts} from './mobilework-mail-baseline.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const blocked=message=>Object.assign(Error(message),{blocked:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
const ids=items=>items.map(item=>item.id).sort();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const labels={high:'高优先级',medium:'中优先级',low:'低优先级'};

export async function openMailbox(context,{call,before}){
 const matches=before.filter(item=>item.builtin&&item.title==='邮箱工作台');
 if(matches.length!==1)throw blocked('当前账号未唯一提供内置邮箱工作台');
 const detail=await call('/canvases/'+matches[0].canvasId),widgets=[];
 for(const placement of detail.placements){const source=await call('/widgets/'+placement.widgetId+'/page');if(source.html.includes('/aggregate/mail/dashboard'))widgets.push(placement.widgetId);}
 if(widgets.length!==1)throw blocked('未找到唯一真实邮箱聚合组件，不创建伪邮箱');
 const owned=context.resources.kanban;owned.mail={widgetId:widgets[0],modals:[]};await context.checkpointResources();
 const [response]=await Promise.all([context.page.waitForResponse(r=>URL.canParse(r.url())&&new URL(r.url()).pathname==='/aggregate/mail/dashboard'&&r.request().method()==='GET'),openCanvas(context,{...matches[0],placements:detail.placements})]);
 if(!response.ok())throw blocked('真实邮箱组件数据加载失败：HTTP '+response.status());
 const data=await response.json(),frame=context.page.locator('iframe[data-widget-id="'+widgets[0]+'"]').contentFrame();await frame.locator('#briefing').waitFor();
 // Wait for the actual response to render; the iframe shell precedes its data.
 await frame.locator('#briefing').filter({hasText:data.summary.text}).waitFor();
 const baseline=await readMailBaseline(),issues=[];if(!baseline)issues.push('缺少独立邮箱真实基线，界面与聚合接口一致不能证明邮箱统计准确');
 await save(context,'邮箱数据观察范围',{fetchedAt:data.fetchedAt,counts:{summary:data.summary,priority:data.priority,priorityStats:data.priorityStats,todos:data.todos.length,allMail:data.allMail.length},baseline:baseline?{source:baseline.source,observedAt:baseline.observedAt,testMailIds:baseline.messages.map(item=>item.id)}:null});
 context.remaining.delete('真实内置邮箱组件及本轮数据快照');return {call,data,frame,baseline,issues};
}

export async function modal(context,frame,key,action){
 const owned=context.resources.kanban.mail;if(!owned.modals.includes(key))owned.modals.push(key);await context.checkpointResources();await action();await frame.locator('#'+key+'-modal').waitFor({state:'visible'});
}
export async function closeModal(context,frame,key){
 await frame.locator('#'+(key==='compose'?'c-cancel':key+'-close')).click();await frame.locator('#'+key+'-modal').waitFor({state:'hidden'});context.resources.kanban.mail.modals=context.resources.kanban.mail.modals.filter(item=>item!==key);await context.checkpointResources();
}
export async function list(context,mail){await modal(context,mail.frame,'list',()=>mail.frame.locator('#open-list').click());await mail.frame.locator('[data-tab="todo"]').click();await mail.frame.locator('[data-filter="all"]').click();}
async function listIds(frame){return frame.locator('#full-list .todo[data-open]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-open')).sort());}

export async function openMailDetail(context,mail,id,action){
 const {page}=context,{frame}=mail;
 context.resources.kanban.mail.summaryPending=true;await context.checkpointResources();
 const [response,bodyResponse]=await Promise.all([page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname==='/aggregate/mail/'+encodeURIComponent(id)),page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname==='/aggregate/mail/'+encodeURIComponent(id)+'/body'),modal(context,frame,'detail',action)]);
 context.assert('真实详情读取成功',response.ok());const actual=await response.json();await frame.locator('#d-body').waitFor({state:'visible'});
 context.assert('详情来自本次选中邮件',actual.id===id);
 return {actual,bodyResponse};
}

export async function awaitMailAnalysis(context,mail){
 const end=Date.now()+60000;let analysis;
 do{analysis=(await mail.frame.locator('#d-summary').innerText()).trim();if(!analysis.includes('生成中'))break;await context.page.waitForTimeout(250);}while(Date.now()<end);
 if(analysis.includes('生成中'))throw blocked('本轮邮件AI分析仍在执行，尚未确认终态');
 delete context.resources.kanban.mail.summaryPending;await context.checkpointResources();return analysis;
}

async function summary(context,mail){
 const {data,frame,baseline,issues}=mail,chips=await frame.locator('#chips').innerText(),brief=await frame.locator('#briefing').innerText();
 context.assert('摘要真实正文与本轮响应一致且非单邮件详情',brief.trim()===data.summary.text.trim()&&!!brief.trim()&&!await frame.locator('#detail-modal').isVisible());
 context.assert('今日新收和本周已处理数真实展示',chips.includes(data.summary.receivedToday+' 封今日新收')&&chips.includes(data.summary.handledThisWeek+' 封本周已处理'));
 await list(context,mail);context.assert('待处理计数对应完整待办集合',data.summary.pending===data.todos.length&&same(await listIds(frame),ids(data.todos)));
 const stats=await frame.locator('#stats .stat').allTextContents();context.assert('待处理数量在完整列表统计区展示',stats.some(text=>text.includes('待处理')&&text.trim().startsWith(String(data.summary.pending))));await closeModal(context,frame,'list');
 if(baseline)for(const key of ['receivedToday','pending','handledThisWeek'])context.assert('与独立邮箱基线核对：'+key,data.summary[key]===baseline.summary[key]);
 if(baseline?.summaryFacts?.length)for(const fact of baseline.summaryFacts)context.assert('每日自然语言重要事实',brief.includes(fact));else issues.push('缺独立概览重要事实，计数一致不足以证明重要内容准确');
 if(!/\d|待|邮件|处理/.test(brief))issues.push('摘要自然语言重要内容未取得有效观察');
 await context.capture('每日概览与真实计数');context.remaining.delete('每日摘要计数正文及独立邮箱对照');
}

async function priority(context,mail){
 const {data,frame,baseline,issues}=mail,observations=[];
 for(const band of ['high','medium','low']){
  const row=frame.locator('#legend [data-band="'+band+'"]'),count=data.priorityStats[band].total;
  context.assert('环图图例与真实统计：'+band,(await row.innerText()).includes(labels[band])&&(await row.locator('.n').innerText()).startsWith(String(count)));
  if(count===0){issues.push('缺少'+labels[band]+'实际样本，圆环点击分支未覆盖');continue;}
  // Clicking the SVG circle center can land in its hole. Use the real segment's
  // title via the legend's equivalent real click target, recording both paths.
  const segment=frame.locator('#donut .donut-seg[data-band="'+band+'"]');context.assert('非零分区实际SVG存在：'+band,await segment.count()===1);await segment.scrollIntoViewIfNeeded();
  const point=await segment.evaluate(node=>{const len=node.getTotalLength(),fraction=Number(node.getAttribute('stroke-dasharray').split(' ')[0])/100,offset=Number(node.getAttribute('stroke-dashoffset'))/100;const p=node.getPointAtLength(((fraction/2-offset)%1+1)%1*len),matrix=node.getScreenCTM();return {x:p.x*matrix.a+p.y*matrix.c+matrix.e,y:p.x*matrix.b+p.y*matrix.d+matrix.f};});
  const iframe=context.page.locator('iframe[data-widget-id="'+context.resources.kanban.mail.widgetId+'"]'),box=await iframe.boundingBox();
  await modal(context,frame,'list',()=>context.page.mouse.click(box.x+point.x,box.y+point.y));
  const actual=await listIds(frame),expected=ids(data.allMail.filter(item=>item.priority===band));context.assert('点击真实圆环进入对应档全部列表：'+band,same(actual,expected)&&await frame.locator('[data-tab="all"].active').count()===1);
  observations.push({band,actual,expected,renderedTotal:count,pendingCount:data.priority[band]});await context.capture('优先级-'+band+'对应列表');await closeModal(context,frame,'list');
 }
 if(baseline){
  for(const item of baseline.messages){const actual=data.allMail.find(mail=>mail.id===item.id);context.assert('独立邮件分类事实：'+item.id,!!actual&&actual.priority===item.priority&&item.priority===priorityForFacts(item,baseline.observedAt));}
 }
 issues.push('原表按待办分布，当前圆环及点击采用近7天全部邮件；两种口径不能视为相同');await save(context,'优先级真实分区及口径差异',observations);context.remaining.delete('三优先级环图点击分类及原口径差异');
}

async function todos(context,mail){
 const {data,frame,baseline,issues}=mail,visible=await frame.locator('#todos .todo[data-open]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-open')));
 context.assert('面板只展示实际待办前3条',same(visible,data.todos.slice(0,3).map(item=>item.id)));await list(context,mail);context.assert('查看全部待办完整集合',same(await listIds(frame),ids(data.todos)));
 for(const todo of data.todos){const row=frame.locator('#full-list .todo[data-open]').filter({has:frame.locator('[data-id="'+todo.id+'"]')}),text=await row.innerText();context.assert('待办实际标题发件时间截止字段：'+todo.id,text.includes(todo.title)&&text.includes(todo.sender)&&text.includes(todo.receivedAt)&&text.includes(todo.deadlineAt|| (todo.asap?'尽快':'无截止时间')));}
 if(data.todos.length===0)issues.push('无待处理邮件，字段和状态操作缺实际样本');
 issues.push('当前待办卡片展示主题、标签、发件人、时间和时限，无基于正文的AI摘要和独立处理状态字段；保留原表字段目标待确认');
 await context.capture('完整邮箱待办字段');await closeModal(context,frame,'list');context.remaining.delete('待办字段全量弹框及关闭恢复');
 const target=disposablePendingMail(baseline,data.todos);if(!target){issues.push('无明确可丢弃且仍在待办的测试邮件，未操作用户真实邮件');return;}
 await list(context,mail);const row=frame.locator('#full-list .todo[data-open="'+target.id+'"]');context.assert('标记前真实目标标题与独立基线一致',(await row.innerText()).includes(target.title));
 const [response,nextResponse]=await Promise.all([context.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/aggregate/mail/'+encodeURIComponent(target.id)+'/handled'),context.page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname==='/aggregate/mail/dashboard'),row.locator('.done').click()]);
 context.assert('标记完成真实请求成功',response.ok());const next=await nextResponse.json();await row.waitFor({state:'hidden'});
 context.assert('标记完成后同ID已处理且待办移除',!next.todos.some(item=>item.id===target.id)&&next.allMail.some(item=>item.id===target.id&&item.status==='handled'));
 context.assert('标记后计数与真实集合一致',next.summary.pending===next.todos.length&&next.priorityStats[target.priority].handled>=data.priorityStats[target.priority].handled+1);
 await save(context,'可丢弃邮件标记真实结果',{id:target.id,before:{pending:data.summary.pending,priorityStats:data.priorityStats},after:{pending:next.summary.pending,priorityStats:next.priorityStats},irreversible:'专用测试邮件标记完成，无逆向接口，不伪造恢复'});await context.capture('本轮测试邮件标记后结果');await closeModal(context,frame,'list');context.remaining.delete('可丢弃邮件标记完成及统计同步');
}

async function detail(context,mail){
 const {frame,data,baseline,issues}=mail;await list(context,mail);
 const target=baseline?.messages.find(item=>data.todos.some(todo=>todo.id===item.id))||data.todos[0];if(!target)throw review('无待办邮件，未伪造详情数据');
 const listElement=frame.locator('#full-list');await frame.locator('[data-filter="'+target.priority+'"]').click();
 const row=frame.locator('#full-list .todo[data-open="'+target.id+'"]');await row.scrollIntoViewIfNeeded();const view=await listElement.evaluate(node=>({scrollTop:node.scrollTop,tab:document.querySelector('#list-tabs .active').getAttribute('data-tab'),filter:document.querySelector('#filters .active')?.getAttribute('data-filter')}));
 const {actual,bodyResponse}=await openMailDetail(context,mail,target.id,()=>row.locator('.todo-title').click());
 context.assert('同邮件ID标题发件人与截止实际展示',actual.id===target.id&&await frame.locator('#d-title').innerText()===actual.title&&await frame.locator('#d-name').innerText()===actual.senderName&&await frame.locator('#d-email').innerText()===(actual.senderEmail||'')&&await frame.locator('#d-deadline').innerText()===(actual.deadlineAt||'无截止时间'));
 const expectedTime=actual.timeMs?await frame.locator('#d-time').evaluate((_,ms)=>{const date=new Date(ms),pad=v=>String(v).padStart(2,'0');return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+' '+pad(date.getHours())+':'+pad(date.getMinutes());},actual.timeMs):actual.receivedAt;
 const stateLabels={pending:'待处理',overdue:'已超时',read:'已读',handled:'已处理',ignored:'已忽略'};
 context.assert('时间和状态字段与实际邮件一致',await frame.locator('#d-time').innerText()===expectedTime&&await frame.locator('#d-status').innerText()===(stateLabels[actual.status]||actual.status));
 for(const id of ['d-reply','d-ignore','d-done'])context.assert('详情操作按钮：'+id,await frame.locator('#'+id).isVisible());
 // Read-only detail may launch the product's own asynchronous AI summary.
 // Poll its real DOM result; never author a summary on behalf of the product.
 const analysis=await awaitMailAnalysis(context,mail);
 if(/生成中|暂不可用|无总结内容/.test(analysis))issues.push('邮件AI分析未得到有效终态：'+analysis);
 context.assert('AI分析不展示紧急度分值',!/紧急度.{0,8}(分值|得分|\d+)/.test(analysis));
 const expected=baseline?.messages.find(item=>item.id===target.id);
 if(expected){
  for(const key of ['title','senderName','senderEmail','deadlineAt','status'])if(expected[key]!==undefined)context.assert('独立邮箱详情对照：'+key,actual[key]===expected[key]);
  if(!bodyResponse.ok()||await frame.locator('#d-content-hint').isVisible())issues.push('真实正文未取到，仅显示摘要，不能作为正文通过');
  else if(expected.bodyFacts?.length)for(const fact of expected.bodyFacts)context.assert('真实正文核心事实', (await frame.locator('#d-content').innerText()).includes(fact));
  else issues.push('独立邮箱基线缺正文事实，正文准确性未验');
  if(expected.aiFacts?.length)for(const fact of expected.aiFacts)context.assert('AI分析核心事实',analysis.includes(fact));else issues.push('缺独立AI分析事实约束');
 }else issues.push('详情仅核对真实接口回显，缺独立邮件正文/时间/状态事实');
 await context.capture('真实邮件详情与分析');await closeModal(context,frame,'detail');
 const after=await listElement.evaluate(node=>({scrollTop:node.scrollTop,tab:document.querySelector('#list-tabs .active').getAttribute('data-tab'),filter:document.querySelector('#filters .active')?.getAttribute('data-filter')}));context.assert('关闭详情保持原Tab筛选与滚动',view.tab===after.tab&&view.filter===after.filter&&Math.abs(view.scrollTop-after.scrollTop)<=1);await save(context,'详情关闭视图保持',{id:target.id,view,after,bodyFallback:await frame.locator('#d-content-hint').isVisible(),analysisAvailable:!/生成中|暂不可用|无总结内容/.test(analysis)});await closeModal(context,frame,'list');context.remaining.delete('邮件真实详情字段分析操作及返回状态');
}

export async function runMailDashboardSteps(context,prepared){
 const mail=await openMailbox(context,prepared);
 if(context.number===153)await summary(context,mail);
 else if(context.number===154)await priority(context,mail);
 else if(context.number===155)await todos(context,mail);
 else await detail(context,mail);
 await save(context,'邮箱待复核项',{issues:mail.issues});if(mail.issues.length)throw review(mail.issues.join('；'));
}
