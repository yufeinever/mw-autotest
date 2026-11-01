import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {uploadTaskAttachment} from './mobilework-attachment-ui.mjs';
import {selectWorkbench,previewTaskFile,matchToolDetailText} from './mobilework-task-ui.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const messages=page=>page.locator('[data-session-messages="true"]:not([aria-hidden="true"])');
const tools=data=>data.messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool').map(part=>({...part,messageId:message.info.id})));
const normalize=text=>String(text).replace(/\s+/g,' ').trim();
export const xmlText=xml=>[...xml.matchAll(/<(?:w:t|a:t|t|v)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t|t|v)>/g)].map(match=>match[1].replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>entity[0]==='#'?String.fromCodePoint(entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1))):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()]))).join(' ');

export function xlsxRows(archive){
 const shared=archive['xl/sharedStrings.xml']?[...strFromU8(archive['xl/sharedStrings.xml']).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match=>xmlText(match[1])):[];
 return Object.entries(archive).filter(([name])=>/^xl\/worksheets\/sheet\d+\.xml$/.test(name)).flatMap(([,bytes])=>{
  const xml=strFromU8(bytes),cells=new Map([...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(match=>{
   const ref=match[1].match(/\br="([^"]+)"/)[1],value=/\bt="s"/.test(match[1])?shared[Number(match[2].match(/<v>(.*?)<\/v>/)?.[1])]:xmlText(match[2]);
   return [ref,{value,formula:match[2].match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1]}];
  }));
  const number=(ref,visiting=new Set())=>{
   const cell=cells.get(ref);
   if(!cell)throw review('Excel公式引用空单元格，尚未取得可核算结果：'+ref);
   if(!cell.formula)return Number(cell.value);
   if(visiting.has(ref))throw Error('Excel产物存在循环引用：'+ref);
   const next=new Set([...visiting,ref]);
   let expression=cell.formula.replace(/\$/g,'').replace(/SUM\(([A-Z]+)(\d+):\1(\d+)\)/gi,(_,column,first,last)=>'('+Array.from({length:Number(last)-Number(first)+1},(_,index)=>number(column+(Number(first)+index),next)).join('+')+')');
   expression=expression.replace(/\b[A-Z]+\d+\b/g,reference=>String(number(reference,next)));
   if(!/^[\d\s.+*/()\-]+$/.test(expression))throw review('真实Excel使用了当前核验器未支持的公式，保留文件待复核：'+cell.formula);
   // Only arithmetic tokens remain; workbook text is never executed as code.
   return Function('return ('+expression+')')();
  };
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row=>[...row[1].matchAll(/<c\b[^>]*\br="([^"]+)"[^>]*>[\s\S]*?<\/c>/g)].map(match=>{const cell=cells.get(match[1]);return cell.formula?String(number(match[1])):cell.value;}).join(' '));
 });
}

async function disclaimerSnapshot(page){
 return page.getByText('内容由AI生成，请核实重要信息',{exact:true}).evaluateAll(elements=>elements.map(element=>{
  const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
  const points=[0.05,0.5,0.95].map(ratio=>({x:rect.left+rect.width*ratio,y:rect.top+rect.height/2}));
  return {text:element.textContent,rect:rect.toJSON(),visible:rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth&&style.visibility==='visible'&&style.opacity!=='0',unobscured:points.every(point=>{const top=document.elementFromPoint(point.x,point.y);return top&&(top===element||element.contains(top));}),outsideMessages:!element.closest('[data-session-messages]')};
 }));
}

async function processSnapshot(page){
 return messages(page).evaluate(root=>({
  text:root.innerText,
  clientHeight:root.clientHeight,
  groups:[...root.querySelectorAll('.first-block-gap')].map(group=>{
   const toggle=[...group.children].find(child=>child.tagName==='BUTTON');
   return {label:toggle?.innerText||'',open:!!toggle?.nextElementSibling,body:toggle?.nextElementSibling?.innerText||'',height:group.getBoundingClientRect().height};
  }),
  disclosures:[...root.querySelectorAll('button[aria-expanded]')].map(button=>({label:button.getAttribute('aria-label'),expanded:button.getAttribute('aria-expanded')}))
 }));
}

export async function expandProcess(page){
 const expand=messages(page).getByRole('button',{name:'展开执行过程',exact:true});
 const count=await expand.count();for(let index=0;index<count;index++)await expand.first().click();
 const groups=messages(page).locator('.first-block-gap > button.group');
 for(let index=0;index<await groups.count();index++){
  if(await groups.nth(index).evaluate(element=>!element.nextElementSibling))await groups.nth(index).click();
 }
}

export async function runMessageDisplaySteps(context){
 const {number,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,checkpointResources,getData,getSessionId}=context;
 const finish=step=>remaining.delete(step);
 const ui=action=>control.withUI(page,'INTERACTING',action);
 const saveFile=async name=>{await fs.copyFile(path.join(control.directory,name),path.join(dir,name));outputs.push({name,path:name});};
 const observations=[];

 if(number===37){
  const checkFooter=async stage=>{
   const entries=await disclaimerSnapshot(page);observations.push({stage,entries});
   await fs.writeFile(path.join(dir,'固定提示位置核对.json'),JSON.stringify(observations,null,2));
   assert(stage+'固定提示完整可见且无遮挡',entries.length===1&&entries[0].visible&&entries[0].unobscured&&entries[0].outsideMessages,entries);
   await capture(stage+'固定提示');
  };
  let during=false;
  await send('请为虚构星桥设备台账列出60条不同的验收检查点，每条独立一行，包含操作与预期，不合并条目，只输出文字。',{waitOptions:{observe:async({states,pending})=>{
   if(!during&&!pending.length&&states[getSessionId()]?.type==='busy'){
    await ui(()=>checkFooter('新建会话执行中'));finish('新建提示可见');during=true;
   }
  }}});
  if(during)finish('执行中提示可见');
  await ui(async()=>{
   await checkFooter('执行完成');finish('完成提示可见');
   const container=messages(page),size=await container.evaluate(element=>({height:element.clientHeight,scroll:element.scrollHeight}));
   if(size.scroll<=size.height)throw review('本轮消息不足以实际滚动，未把设置scrollTop当作滚动验证');
   for(const [label,ratio] of [['顶部',0],['中部',0.5],['底部',1]]){
    const position=await container.evaluate((element,ratio)=>{element.scrollTop=(element.scrollHeight-element.clientHeight)*ratio;return {actual:element.scrollTop,maximum:element.scrollHeight-element.clientHeight};},ratio);
    assert('消息区真实滚动到'+label,Math.abs(position.actual-position.maximum*ratio)<=2,position);
    await checkFooter('消息'+label);
   }
   finish('消息顶部中部底部固定提示');
  });
  await send('继续同一任务，只用一句话说明为什么设备台账需要核实重要信息。',{continuing:true});
  await ui(async()=>{await page.reload();await messages(page).waitFor();await checkFooter('历史会话重新加载');});finish('历史与多轮提示可见');
  await fs.writeFile(path.join(dir,'固定提示位置核对.json'),JSON.stringify(observations,null,2));
 }else if(number===38){
  let thinking=false,autoTransition=false,lastGroups=[];
  const observe=async({states,pending})=>{
   if(pending.length||states[getSessionId()]?.type!=='busy')return;
   await ui(async()=>{
    const snapshot=await processSnapshot(page),data=await control.readLog();
    const active=tools(data).filter(tool=>['running','pending'].includes(tool.state?.status)).map(tool=>({id:tool.callID,tool:tool.tool}));
    const reasoning=data.messages.some(message=>(message.parts||[]).some(part=>part.type==='reasoning'&&part.text?.trim()));
    const waiting=/思考中|深度思考中|正在生成工具参数/.test(snapshot.text);
    if((waiting||reasoning)&&!thinking){thinking=true;await capture('执行中思考与等待');}
    // Compare actual disclosures across samples; completed logs alone cannot prove automatic folding.
    if(active.length&&lastGroups.some(previous=>previous.open&&snapshot.groups.some(current=>current.label===previous.label&&!current.open))&&snapshot.groups.some(group=>group.open))autoTransition=true;
    const current={time:new Date().toISOString(),active,reasoning,waiting,...snapshot};
    const previous=observations.at(-1);
    if(!previous||JSON.stringify([previous.active,previous.groups,previous.waiting])!==JSON.stringify([current.active,current.groups,current.waiting])){
     observations.push(current);await fs.writeFile(path.join(dir,'执行展示过程观察.json'),JSON.stringify({thinking,autoTransition,samples:observations},null,2));
    }
    lastGroups=snapshot.groups;
   });
  };
  await send('请为虚构星桥设备台账项目制作约500字的项目周报Word文档，保存为项目周报.docx。事实：本周计划40项，完成32项，剩余8项；阻碍为接口联调延期，负责人许棠，下周优先处理异常数据。请分阶段创建待办、保存素材.md、编写周报正文.md、生成Word、读取核验Word文本，再完成待办。每个阶段分别更新真实任务状态，保留中间文件，最终回复附交付文件入口。',{waitOptions:{observe}});
  await fs.writeFile(path.join(dir,'执行展示过程观察.json'),JSON.stringify({thinking,autoTransition,samples:observations},null,2));
  const complete=tools(getData()).filter(tool=>tool.state?.status==='completed');
  assert('本任务有至少三个真实完成的工具步骤',complete.length>=3,complete.map(tool=>tool.tool));finish('多步骤真实执行');
  if(thinking)finish('思考及等待状态观察');if(autoTransition)finish('完成步骤自动收起与下一步打开');
  await ui(async()=>{
   const expand=messages(page).getByRole('button',{name:'展开执行过程',exact:true});
   if(!await expand.count()){log('过程收纳待复核','本次未出现半屏收纳入口，未以最终完成替代阈值分支');return;}
   const toggle=expand.first(),before=await toggle.evaluate(element=>({expanded:element.getAttribute('aria-expanded'),text:element.parentElement.innerText,height:element.parentElement.getBoundingClientRect().height}));
   assert('收纳块初始为收起状态',before.expanded==='false',before);await capture('执行过程自动收纳');
   await toggle.click();const collapse=messages(page).getByRole('button',{name:'收起执行过程',exact:true}).first();await collapse.waitFor();
   const expanded=await collapse.evaluate(element=>({expanded:element.getAttribute('aria-expanded'),text:element.parentElement.innerText,height:element.parentElement.getBoundingClientRect().height}));
   assert('展开后展示更多真实历史步骤',expanded.expanded==='true'&&expanded.text.length>before.text.length,{before,expanded});await capture('展开执行过程');
   await collapse.click();await messages(page).getByRole('button',{name:'展开执行过程',exact:true}).first().waitFor();await capture('收起执行过程');finish('半屏收纳及展开收起');
  });
  const file='项目周报.docx',archive=unzipSync(await fs.readFile(path.join(control.directory,file))),text=xmlText(strFromU8(archive['word/document.xml']));
  assert('真实Word包含本轮周报事实',['40','32','8','许棠','联调'].every(fact=>text.includes(fact)),text);await saveFile(file);
  await ui(()=>previewTaskFile(page,config,file,capture,['许棠','32']));finish('最终Word内容及预览');
 }else if(number===39){
  const token=randomUUID(),requests=[],route='/markdown-link/'+token;
  const server=http.createServer((request,response)=>{if(request.url===route){requests.push({at:new Date().toISOString(),method:request.method});response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('<!doctype html><title>Markdown链接验收</title><p>星桥链接跳转成功</p>');}else{response.writeHead(404);response.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();
  try{
   const url='http://127.0.0.1:'+server.address().port+route,name='标准Markdown-'+token+'.md',file=path.join(dir,name),output='Markdown渲染验收.md';
   const body=['# 星桥排版验收','','## 本轮检查','','正文说明与**重要信息**，包含行内代码 `sampleValue`。','','- 设备新增','- 设备查询','','> 本内容为合成测试材料。','','```javascript','globalThis.MW_MARKDOWN_EXECUTED = "'+token+'";','```','','| 项目 | 数量 |','| --- | --- |','| 电脑 | 12 |','| 显示器 | 8 |','','[打开验收页面]('+url+')',''].join('\n');
   await fs.writeFile(file,body,'utf8');
   await uploadTaskAttachment(page,{file,name,resources,checkpointResources,capture});finish('真实上传标准Markdown');
   await send('请读取刚上传的Markdown文件，将全部内容原样复制为当前任务目录的“'+output+'”，不要修改Markdown语法或链接，不执行代码块。最终提供这个文件的预览入口。');
   assert('任务产物与上传Markdown内容一致',(await fs.readFile(path.join(control.directory,output),'utf8')).replace(/\r\n/g,'\n').trimEnd()===body.trimEnd());await saveFile(output);resources.attachments=[];await checkpointResources();
   await ui(async()=>{
    const panel=await previewTaskFile(page,config,output,capture,['星桥排版验收']);
    // The renderer can live directly in the panel or inside its documented preview frame.
    const frame=panel.locator('iframe').filter({visible:true}),root=await frame.count()===1?frame.contentFrame().locator('body'):panel;
    for(const [label,selector,fact] of [['H1','h1','星桥排版验收'],['H2','h2','本轮检查'],['列表','li','设备新增'],['加粗','strong','重要信息'],['行内代码','code','sampleValue'],['代码块','pre code',token],['引用','blockquote','合成测试材料'],['表格','table','电脑']]){
     const element=root.locator(selector).filter({hasText:fact});assert('Markdown真实渲染'+label,await element.count()>0);assert(label+'在预览中可见',await element.first().isVisible());
    }
    const metrics=await root.locator('h1,h2,p,strong,pre,table').evaluateAll(elements=>elements.map(element=>({tag:element.tagName,text:element.textContent.slice(0,100),fontSize:getComputedStyle(element).fontSize,fontWeight:getComputedStyle(element).fontWeight,rect:element.getBoundingClientRect().toJSON()})));
    await fs.writeFile(path.join(dir,'Markdown渲染语义及样式.json'),JSON.stringify(metrics,null,2));
    assert('标题层级字号可区分',parseFloat(metrics.find(item=>item.tag==='H1').fontSize)>parseFloat(metrics.find(item=>item.tag==='H2').fontSize));
    assert('代码块未在预览页面执行',await root.evaluate((element,token)=>element.ownerDocument.defaultView.MW_MARKDOWN_EXECUTED!==token,token));finish('Markdown语义及代码不执行');
    const link=root.getByRole('link',{name:'打开验收页面',exact:true});assert('链接保留真实目标地址',await link.getAttribute('href')===url);await link.hover();
    assert('链接可识别并显示手型',await link.evaluate(element=>getComputedStyle(element).cursor)==='pointer');
    const baseline=requests.length;await link.click();
    const deadline=Date.now()+15000;while(requests.length===baseline&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    await fs.writeFile(path.join(dir,'Markdown实际链接请求.json'),JSON.stringify({url,baseline,requests},null,2));
    assert('点击链接产生新的真实本机GET请求',requests.slice(baseline).some(request=>request.method==='GET'));finish('超链接真实跳转');await capture('Markdown链接点击后');
   });
  }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 }else if(number===40){
  const file='工具详情样例.txt',marker='星桥工具详情-'+randomUUID();
  await send('请在当前任务目录新建“'+file+'”，UTF-8正文为“'+marker+'”，然后读取文件确认内容。最终给出该文件的入口。不修改其他文件。');
  assert('本Session工具实际生成目标文件',(await fs.readFile(path.join(control.directory,file),'utf8')).trim()===marker);await saveFile(file);
  const complete=tools(getData()).filter(tool=>tool.state?.status==='completed'&&JSON.stringify(tool.state.input).includes(file));
  assert('有对应本轮文件的完成工具调用',complete.length>0);finish('真实成功工具与文件');
  await ui(async()=>{
   await expandProcess(page);await capture('本Session工具卡片展开');
   // The client can merge several engine messages into one displayed reply.
   // Match details against this Session's actual unique input/output, rather
   // than assuming its rendered message ID equals every engine message ID.
   const details=messages(page).locator('button[aria-label="在工作台查看工具调用详情"],button.group.cursor-pointer.text-start');
   let matched;
   for(const tool of complete){
    for(let index=0;index<await details.count();index++){
     const card=details.nth(index),label=await card.innerText();await card.click();
     const panel=page.locator('[data-slot="resizable-panel"]').filter({visible:true}).last();
     await panel.waitFor();const text=await panel.innerText();
     const detail=matchToolDetailText(tool,text);
     if(detail){
      const {missingInputFields}=detail;
      matched={tool:tool.tool,callID:tool.callID,messageId:tool.messageId,renderedMessageId:await card.evaluate(element=>element.closest('[data-message-id]')?.getAttribute('data-message-id')),label,missingInputFields,panel};break;
     }
    }
    if(matched)break;
   }
   if(!matched)throw review('文件与完成工具已核对，但未在本Session卡片详情中匹配完整实际入参及出参，保留界面证据');
   const {panel,...identity}=matched;await fs.writeFile(path.join(dir,'工具详情对应关系.json'),JSON.stringify(identity,null,2));
   assert('卡片详情主体对应本次真实完成工具',true,identity);await capture('工具真实入参出参');
   if(!matched.missingInputFields.length)finish('工具卡片与详情参数');
   else log('详情入参覆盖缺口','当前详情未完整展示字段：'+matched.missingInputFields.join('、'));
   const related=panel.locator('[title="在工作台预览"],a,button,div.cursor-pointer').filter({hasText:file}).filter({visible:true});
   if(!await related.count())throw review('当前工具详情展示实际输入输出，但没有关联文件入口；没有改从产物菜单打开冒充详情关联');
   await related.first().click();const preview=page.locator('[data-slot="resizable-panel"]').filter({visible:true}).last();
   await preview.getByText(marker,{exact:false}).waitFor();assert('详情关联文件预览对应本轮内容',(await preview.innerText()).includes(marker));await capture('工具详情关联文件预览');finish('详情关联交付物预览');
  });
 }else if(number===41){
  const excel='星桥销量报表.xlsx',word='星桥销量说明.docx';
  await send('在当前任务目录同时生成两个文件：“'+excel+'”与“'+word+'”。这是虚构测试数据：甲产品销量10、单价20元，乙产品销量5、单价30元。Excel应有列产品、销量、单价、金额，包含两行商品和总金额；Word应有明细表及总金额说明。两份文件金额都应能核对。最终提供两个文件入口，不生成其他替代格式。');
  const generated=await fs.readdir(control.directory);
  assert('本任务实际生成两种Office文件',[excel,word].every(name=>generated.includes(name)),{files:generated,missing:[excel,word].filter(name=>!generated.includes(name))});
  const xlsx=unzipSync(await fs.readFile(path.join(control.directory,excel))),docx=unzipSync(await fs.readFile(path.join(control.directory,word)));
  const rows=xlsxRows(xlsx);
  const text=xmlText(strFromU8(docx['word/document.xml']));
  assert('Excel真实数据行及金额可核算',rows.some(row=>/甲/.test(row)&&/\b10\b/.test(row)&&/\b20\b/.test(row)&&/\b200\b/.test(row))&&rows.some(row=>/乙/.test(row)&&/\b150\b/.test(row))&&rows.some(row=>/\b350\b/.test(row)),rows);
  assert('Word真实说明与Excel事实一致',['甲','乙','200','150','350'].every(fact=>text.includes(fact)),text);await saveFile(excel);await saveFile(word);finish('Excel与Word真实产物内容');
  await ui(async()=>{
   await selectWorkbench(page,config,'产物',capture);await page.getByRole('button',{name:'产物',exact:true}).filter({visible:true}).click();
   const icons=[];
   for(const [name,typeClass] of [[excel,'text-green-9'],[word,'text-blue-9']]){
    const item=page.getByRole('menuitem',{name,exact:true});await item.waitFor();
    assert('产物列表名称完整显示：'+name,(await item.innerText()).includes(name));
    const svg=item.locator('svg');assert('产物有文件类型图标：'+name,await svg.count()>0);
    assert('文件图标匹配当前客户端类型映射：'+name,(await svg.first().getAttribute('class')).split(/\s+/).includes(typeClass));
    icons.push(await svg.first().evaluate(element=>element.innerHTML));
   }
   assert('两种文件类型使用可区分图标',icons[0]!==icons[1]);await capture('两类交付物名称与图标');await page.keyboard.press('Escape');finish('两类产物名称与类型图标');
   await previewTaskFile(page,config,excel,capture,['甲','乙']);await previewTaskFile(page,config,word,capture,['350']);finish('两类文件各自实际预览');
  });
 }
 if(remaining.size)throw review('已完成范围及证据已保存，以下分支尚未取得充分证据：'+[...remaining].join('、'));
}
