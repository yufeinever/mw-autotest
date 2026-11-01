import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {unzipSync} from 'fflate';
import {uploadTaskAttachment} from './mobilework-attachment-ui.mjs';
import {previewTaskFile,waitTaskPreviewReady} from './mobilework-task-ui.mjs';
import {xlsxRows} from './client-message-display-steps.mjs';

const fixtureRoot=fileURLToPath(new URL('./fixtures/office-preview/',import.meta.url));
const review=message=>Object.assign(Error(message),{review:true});
const normalize=value=>String(value).replace(/\s/g,'');
const panelOf=page=>page.getByTestId('session-workbench-panel');
const messageArea=page=>page.locator('[data-session-messages="true"]:not([aria-hidden="true"])');

// These are observations of the current preview, not a replacement renderer.
async function previewScope(panel){
 const iframe=panel.locator('iframe').filter({visible:true});
 if(!await iframe.count())return {scope:panel,kind:'page'};
 if(await iframe.count()!==1)throw review('当前文件有多个预览iframe，无法唯一核对正文');
 const scope=await (await iframe.elementHandle()).contentFrame();
 if(!scope)throw review('本轮预览iframe尚无可读取页面');
 await scope.locator('body').waitFor({state:'attached'});
 return {scope,kind:'iframe',src:await iframe.getAttribute('src')};
}

async function excelView(panel){
 const table=panel.locator('table.mw-preview-table');await table.waitFor();
 return table.locator('xpath=..');
}
const scrollFacts=scroll=>scroll.evaluate(element=>({top:element.scrollTop,left:element.scrollLeft,width:element.clientWidth,height:element.clientHeight,totalWidth:element.scrollWidth,totalHeight:element.scrollHeight}));
async function selectExcelSheet(panel,name){
 const tab=panel.getByRole('button',{name,exact:true});await tab.click();
 await tab.and(panel.locator('button.bg-white')).waitFor();
}
async function scrollTo(scroll,top,left){
 await scroll.evaluate(async(element,{top,left})=>{element.scrollTo({top,left,behavior:'instant'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);},{top,left});
}

export async function runOfficeFileSteps(context){
 const {number,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,checkpointResources,getData}=context;
 const finish=name=>remaining.delete(name),ui=action=>control.withUI(page,'INTERACTING',action);
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
 const fixtureManifest=JSON.parse(await fs.readFile(path.join(fixtureRoot,'manifest.json'),'utf8'));
 async function upload(names){
  for(const name of names){
   const meta=fixtureManifest.files.find(file=>file.name===name),source=path.join(fixtureRoot,name),buffer=await fs.readFile(source);
   assert('预存合成材料哈希一致-'+name,createHash('sha256').update(buffer).digest('hex')===meta.sha256);
   const target=path.join(dir,'输入材料',path.basename(name));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,buffer);
   outputs.push({name:'输入材料-'+path.basename(name),path:'输入材料/'+path.basename(name)});
   await ui(()=>uploadTaskAttachment(page,{file:target,name:path.basename(name),resources,checkpointResources,capture}));
  }
 }
 async function openUploaded(name){
  const start=performance.now();
  await messageArea(page).getByText(name,{exact:true}).filter({visible:true}).last().click();
  const panel=panelOf(page);await panel.getByRole('button',{name:'关闭 '+name,exact:true}).waitFor();
  await waitTaskPreviewReady(panel,name);
  return {panel,start};
 }
 async function checkExcel(panel,sheetNames,{large=false}={}){
  const records=[];
  for(const name of sheetNames){
   await selectExcelSheet(panel,name);
   const scroll=await excelView(panel),before=await scrollFacts(scroll),seen=new Map();
   assert('真实表格双向超出首屏-'+name,before.totalHeight>before.height&&before.totalWidth>before.width,before);
   const positions=large?[0,Math.round((before.totalHeight-before.height)/2),before.totalHeight]:Array.from({length:Math.ceil(before.totalHeight/Math.max(1,before.height*0.75))+1},(_,i)=>i*before.height*0.75);
   for(const top of positions){
    await scrollTo(scroll,top,before.totalWidth);
    const rows=await scroll.locator('tbody tr[data-index]').evaluateAll(elements=>elements.map(row=>({index:Number(row.dataset.index),cells:[...row.querySelectorAll('td')].map(cell=>cell.innerText)})));
    for(const row of rows)seen.set(row.index,row.cells);
   }
   const lastCell=scroll.locator('tr[data-index="'+(large?1500:80)+'"] td').last();
   await lastCell.scrollIntoViewIfNeeded();
   const end=await scrollFacts(scroll),edge=await lastCell.evaluate(element=>{
    const viewport=element.closest('.mw-preview-scroll').getBoundingClientRect(),cell=element.getBoundingClientRect();
    return {cell:cell.toJSON(),viewport:viewport.toJSON(),visible:cell.top>=viewport.top&&cell.bottom<=viewport.bottom+1&&cell.left>=viewport.left&&cell.right<=viewport.right+1};
   });
   await save('Excel逐行观察-'+name+'.json',{before,end,edge,rows:[...seen].sort((a,b)=>a[0]-b[0]).map(([index,cells])=>({index,cells}))});
   assert('实际横纵滚动到末端-'+name,end.top>0&&end.left>0&&edge.visible,{end,edge});
   if(large){
    assert('大表首中尾与末列真实数据-'+name,[0,750,1500].every(index=>seen.has(index)&&seen.get(index).length===16&&seen.get(index).every((value,column)=>value===(index===0?'列'+String(column+1).padStart(2,'0'):'行'+String(index).padStart(4,'0')+'列'+String(column+1).padStart(2,'0')))),[...seen.entries()].filter(([index])=>[0,750,1500].includes(index)));
   }else{
    assert('完整80行销售数据及原10行样本-'+name,seen.size===81&&[...seen].every(([index,cells])=>normalize(cells.join(' '))===normalize(index===0?'产品名称 销量 单价 金额':'星桥产品'+String(index).padStart(3,'0')+' '+index+' 17 '+index*17)),{observedRows:seen.size});
   }
   await capture('Excel末端-'+name);await scrollTo(scroll,0,0);
   const reset=await scrollFacts(scroll);assert('返回表格开头-'+name,reset.top===0&&reset.left===0,reset);
   records.push({name,before,end,observedRows:seen.size});
  }
  await save('Excel实际滚动与Sheet.json',records);
 }
 async function checkImage(panel,name,width,height){
  const image=panel.locator('img').filter({visible:true});await image.waitFor();
  await image.evaluate(element=>element.decode());
  const data=await image.evaluate(element=>{const box=element.getBoundingClientRect();return {complete:element.complete,naturalWidth:element.naturalWidth,naturalHeight:element.naturalHeight,width:box.width,height:box.height};});
  assert('图片完整解码且等比例-'+name,data.complete&&data.naturalWidth===width&&data.naturalHeight===height&&data.width>0&&data.height>0&&Math.abs(data.width/data.height-width/height)<0.01,data);
  await save(name+'-图片几何.json',data);await capture('图片实际预览-'+name);
 }
 async function checkReadable(panel,name,expected){
  const surface=await previewScope(panel),text=surface.kind==='iframe'?await surface.scope.locator('body').innerText():await panel.innerText();
  if(surface.kind==='iframe'&&!text.trim()){
   await save(name+'-插件观察.json',{kind:surface.kind,src:surface.src,bodyTextLength:text.length});
   log('预览正文待复核',name+'；插件未暴露正文、翻页与实际页内容，文件存在不代表该项通过');await capture('插件观察缺口-'+name);return false;
  }
  for(const fact of expected)await surface.scope.getByText(fact,{exact:false}).first().waitFor();
  const actual=surface.kind==='iframe'?await surface.scope.locator('body').innerText():await panel.innerText();
  assert('预览正文关键事实无乱码-'+name,expected.every(fact=>normalize(actual).includes(normalize(fact))));
  if(name.endsWith('.docx')){
   const last=surface.scope.getByText(expected.at(-1),{exact:false}).last();await last.scrollIntoViewIfNeeded();
   const position=await last.evaluate(element=>{const scroll=element.closest('.mw-preview-scroll'),a=element.getBoundingClientRect(),b=scroll.getBoundingClientRect();return {top:scroll.scrollTop,target:a.toJSON(),viewport:b.toJSON()};});
   assert('Word滚动可见末页内容',position.top>0&&position.target.top>=position.viewport.top&&position.target.bottom<=position.viewport.bottom,position);
  }
  if(name.endsWith('.pptx')){
   // DOM text alone cannot prove the active slide or page transition.
   log('PPT逐页待复核','已核对可读取正文，仍需取得逐页入口及当前页内容的对应证据');return false;
  }
  await capture('完整正文预览-'+name);return true;
 }
 function nativeAudit(names){
  const data=getData(),tools=data.messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool'));
  const custom=tools.filter(part=>{
   const input=part.state?.input||{},command=input.command||'',file=input.filePath||input.path||'';
   const processor=/\b(?:python(?:3(?:\.\d+)?)?|py(?:\.exe)?|node|powershell|pwsh)\b/i.test(command)&&/\.py\b|\.ps1\b|python|py -|openpyxl|pptx|docx|pdfplumber|pypdf|\.doc\b|\.xls\b|\.ppt\b/i.test(command);
   return processor||/\.(?:py|ps1|js)$/i.test(file)&&/openpyxl|pptx|docx|pdfplumber|pypdf|libreoffice|soffice/i.test(input.content||'');
  });
  const observed=data.messages.flatMap(message=>(message.parts||[]).filter(part=>message.info.role==='user'&&['text','file'].includes(part.type)||part.type==='tool'&&part.state?.status==='completed').map(part=>JSON.stringify(part)));
  const materialFacts={doc:['7319','沈岚'],xls:['星桥甲货','星桥乙货','340','690'],ppt:['星桥方案首页','方案中页','陆川'],pdf:['8427','唐夏']};
  return {custom:custom.map(part=>({tool:part.tool,input:part.state?.input})),sourceEvidence:names.map(name=>{
   const type=path.extname(name).slice(1).replace(/x$/,''),facts=materialFacts[type];
   return {name,observed:observed.some(text=>text.includes(name)||text.includes(encodeURIComponent(name))),contentObserved:facts.every(fact=>observed.some(text=>text.includes(fact)))};
  })};
 }

 if(number===62){
  const name='双Sheet滚动核验.xlsx';
  await send('请在本任务目录生成真实Excel“'+name+'”。两个Sheet分别叫销售甲、销售乙，内容完全相同。列名：产品名称、销量、单价、金额。共80行明细，第i行产品名为星桥产品加三位编号（001至080），销量为i，单价17，金额=i*17（可用公式）。原10行销售样本为前10行，补充70行用于滚动。四列各宽度至少30。不要合并单元格，最后提供入口。');
  const file=path.join(control.directory,name),buffer=await fs.readFile(file),rows=xlsxRows(unzipSync(buffer));await fs.writeFile(path.join(dir,name),buffer);outputs.push({name,path:name});
  assert('真实双Sheet各80行且两表相同',rows.length===162&&rows.slice(0,81).every((row,index)=>row===rows[index+81]));finish('真实双Sheet及滚动材料');
  await ui(async()=>{const panel=await previewTaskFile(page,config,name,capture);await checkExcel(panel,['销售甲','销售乙']);});
  finish('两个Sheet真实内容一致');finish('横纵滚动及首尾数据');
 }else if(number===63){
  const names=['中文销售明细.xlsx','中文项目说明.docx','中文产品方案.pptx','中文清单.csv','中文说明.md','中文页面.html','中文流程图.png','中文会议资料.pdf'];
  await upload(names);finish('八种真实材料上传');
  await send('这是独立文件预览测试，随附八份合成材料。请仅回复“材料已接收”，不创建、修改或转换文件。');
  for(const name of names)await ui(async()=>{
   const {panel}=await openUploaded(name);let covered=false;
   if(name.endsWith('.xlsx')){
    for(const sheet of ['销售甲','销售乙']){await selectExcelSheet(panel,sheet);const table=panel.locator('table.mw-preview-table');await table.getByText('星桥乙货',{exact:true}).waitFor();const text=await table.innerText();assert('上传Excel实际Sheet及明细-'+sheet,['星桥甲货','星桥乙货','340','690'].every(fact=>text.includes(fact)));}covered=true;
   }else if(name.endsWith('.png')){await checkImage(panel,name,1280,720);covered=true;}
   else if(name.endsWith('.csv')){
    const cells=panel.locator('table td input');
    await panel.locator('table td input[value="星桥甲"]').waitFor();
    const values=await cells.evaluateAll(elements=>elements.map(element=>element.value));
    await save('CSV实际单元格.json',values);
    assert('CSV实际单元格内容无乱码',JSON.stringify(values)===JSON.stringify(['产品','金额','星桥甲','7319','星桥乙','8427']),values);covered=true;
    await capture('CSV实际单元格预览');
   }else{
    const expected=name.endsWith('.docx')?['星桥文档核验','预算7319元','责任人沈岚','终验窗口：十一月六日；请核实。']:name.endsWith('.pptx')?fixtureManifest.facts.pptx:name.endsWith('.pdf')?fixtureManifest.facts.pdf:name.endsWith('.csv')?['星桥甲','7319','星桥乙','8427']:name.endsWith('.md')?['星桥Markdown','7319','沈岚']:['星桥HTML','十一月六日','唐夏'];
    covered=await checkReadable(panel,name,expected);
   }
   if(covered)finish('实际预览-'+name);
  });
 }else if(number===64){
  const names=['大数据1500行.xlsx','大文档60页.pdf','高清大图.png'];await upload(names);finish('三种大文件真实上传');
  await send('这是大文件预览测试。请仅回复“预览材料已接收”，不处理或转换文件，不编写脚本。');
  await ui(async()=>{
   const {panel,start}=await openUploaded(names[0]);await panel.locator('table.mw-preview-table').waitFor();await panel.getByText('行0001列01',{exact:true}).waitFor();const elapsed=performance.now()-start;
   await save('大Excel首次可用耗时.json',{milliseconds:elapsed,limit:10000,boundary:'点击本Session附件到真实表格及首行可见；含页面渲染，不含上传及模型等待'});
   assert('大Excel10秒内实际可用',elapsed<=10000,{milliseconds:elapsed});finish('大Excel真实加载计时');await checkExcel(panel,['大表甲','大表乙'],{large:true});finish('大Excel滚动及双Sheet');
   const pdf=await openUploaded(names[1]);if(await checkReadable(pdf.panel,names[1],['星桥性能材料第01页','星桥性能材料第60页']))finish('大PDF正文滚动与末页');
   const image=await openUploaded(names[2]);await checkImage(image.panel,names[2],5120,2880);finish('高清图解码及比例');
  });
 }else if(number===65||number===66){
  const legacy=number===66,names=legacy?['legacy/中文项目说明.doc','legacy/中文销售明细.xls','legacy/中文产品方案.ppt']:['中文项目说明.docx','中文销售明细.xlsx','中文产品方案.pptx','中文会议资料.pdf'];
  await upload(names);finish('中文真实Office材料上传');
  await send(legacy?'请用MobileWork内置文件读取能力，分别解析随附真实旧格式doc/xls/ppt，转为三个UTF-8 Markdown文件：旧Word解析.md、旧Excel解析.md、旧PPT解析.md。完整保留原文段落、表格数据和PPT页面顺序。不要编写或执行自定义Python/JS/PowerShell转换脚本。原材料含图片时保留说明，不凭空补内容。最后提供三个文件入口。':'请用MobileWork内置文件读取能力读取随附四份中文命名docx/xlsx/pptx和有文字层PDF，总结每份的全部核心事实、负责人、数值和时间。用表格列出Excel的产品、销量、单价、金额，保留行列对应关系，按PPT原页顺序列出三个标题；包含文档末段和PDF每页事实。不要编写或执行自定义Python/JS/PowerShell解析脚本。不得改写或覆盖源文件。');
  const markdownNames=['旧Word解析.md','旧Excel解析.md','旧PPT解析.md'],markdown=[];
  if(legacy)for(const name of markdownNames){
   const text=await fs.readFile(path.join(control.directory,name),'utf8');markdown.push(text);
   await fs.writeFile(path.join(dir,name),text);outputs.push({name,path:name});
  }
  const audit=nativeAudit(names.map(name=>path.basename(name)));await save('原生解析与自定义脚本审计.json',audit);
  assert('各源文件及实际内容进入本Session读取上下文',audit.sourceEvidence.every(item=>item.observed&&item.contentObserved),audit.sourceEvidence);finish('各格式实际读取证据');
  assert('本轮未生成或执行自定义解析脚本',audit.custom.length===0,audit.custom);finish('原生解析无自定义脚本');
  if(legacy){
   for(const [index,name] of markdownNames.entries()){
    const text=markdown[index],facts=fixtureManifest.facts[['docx','xlsx','pptx'][index]];
    assert('旧格式转Markdown保留真实事实-'+name,facts.every(value=>normalize(text).includes(normalize(value))),{length:text.length});
    assert('旧格式产出Markdown结构-'+name,index===1?/\|.+\|/.test(text):/^#{1,6}\s|^[-*]\s/m.test(text));
    if(index===2)assert('旧PPT页序保留',facts.every((value,i)=>i===0||text.indexOf(value)>text.indexOf(facts[i-1])));
   }
   finish('三份真实Markdown及内容结构');
  }else{
   const assistants=getData().messages.filter(message=>message.info.role==='assistant'&&!(message.parts||[]).some(part=>part.type==='tool')),text=(assistants.at(-1)?.parts||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
   const facts=['7319','沈岚','十一月六日','星桥甲货','星桥乙货','340','690','8427','唐夏','陆川'];
   assert('中文段落表格末段及各页事实正确',facts.every(value=>normalize(text).includes(normalize(value))),{missing:facts.filter(value=>!normalize(text).includes(normalize(value)))});
   assert('Excel产品与销量单价金额对应正确',[['星桥甲货',20,17,340],['星桥乙货',30,23,690]].every(([product,...values])=>text.split('\n').some(line=>line.includes(product)&&values.every(value=>new RegExp('\\b'+value+'\\b').test(line)))));
   const slides=['星桥方案首页','方案中页','方案末页'];assert('新版PPT按实际页面顺序提取',slides.every((value,i)=>text.includes(value)&&(i===0||text.indexOf(value)>text.indexOf(slides[i-1]))));finish('中文内容与表格事实');finish('PPT页面顺序与PDF事实');
  }
 }
 if(remaining.size)throw review('本轮已完成的检查及证据已保存，以下项目仍缺实际观察：'+[...remaining].join('、'));
}
