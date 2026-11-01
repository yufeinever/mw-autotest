import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {selectWorkbench,previewTaskFile,closeArtifactMenu,restoreWorkbenchLayout,readPreviewZoom} from './mobilework-task-ui.mjs';
import {xmlText} from './client-message-display-steps.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const panelOf=page=>page.getByTestId('session-workbench-panel');

async function pdfFacts(file){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const loading=getDocument({data:new Uint8Array(await fs.readFile(file)),useSystemFonts:true});
 try{
  const document=await loading.promise,pages=[];
  for(let n=1;n<=document.numPages;n++)pages.push((await (await document.getPage(n)).getTextContent()).items.map(item=>item.str).join(' '));
  const bookmarks=[];
  async function collect(items){
   for(const item of items||[]){
    const destination=typeof item.dest==='string'?await document.getDestination(item.dest):item.dest;
    const reference=destination?.[0];
    const page=reference===undefined?null:typeof reference==='number'?reference+1:await document.getPageIndex(reference)+1;
    bookmarks.push({title:item.title,page});await collect(item.items);
   }
  }
  await collect(await document.getOutline());
  return {pages,bookmarks};
 }finally{await loading.destroy();}
}

// Inspect only the iframe belonging to this task's current preview. PDF plugin
// internals may be unavailable to the renderer; that is an observation gap.
async function previewSurface(panel){
 const iframe=panel.locator('iframe').filter({visible:true});
 if(!await iframe.count())return {scope:panel,kind:'page'};
 if(await iframe.count()!==1)throw review('本轮预览出现多个iframe，无法唯一确定文档视图');
 const frame=await iframe.elementHandle().then(handle=>handle.contentFrame());
 if(!frame)throw review('当前预览iframe尚无可读取的文档页面');
 await frame.locator('body').waitFor({state:'attached'});
 return {scope:frame,kind:'iframe',src:await iframe.getAttribute('src')};
}

export async function runFilePreviewSteps(context){
 const {number,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,checkpointResources,getData,getSessionId}=context;
 const finish=step=>remaining.delete(step),save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
 const ui=action=>control.withUI(page,'INTERACTING',action),marker='星桥预览-'+randomUUID();
 async function archive(name){const file=path.join(control.directory,name);await fs.copyFile(file,path.join(dir,name));outputs.push({name,path:name});return file;}
 async function ownLayout(file){resources.workbenchLayout={file,expanded:await button(page,'放大 / 还原侧栏').getAttribute('aria-pressed')==='true'};await checkpointResources();}
 async function restoreLayout(){await restoreWorkbenchLayout(page,resources.workbenchLayout,config);delete resources.workbenchLayout;await checkpointResources();}
 async function previewInventory(name){
  const panel=panelOf(page),surface=await previewSurface(panel);
  const controls=await surface.scope.locator('button,[role="treeitem"],input').evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().height).map(e=>({tag:e.tagName,role:e.getAttribute('role'),label:e.getAttribute('aria-label'),title:e.title,text:e.textContent,value:e.value})));
  await save(name,{kind:surface.kind,src:surface.src,controls});return surface;
 }
 if(number===57){
  const name='面板状态核验.txt';
  await send('请在当前任务目录生成“'+name+'”，内容为“'+marker+'”。建立真实待办并完成它，再通过浏览器实际打开https://example.com/读取标题，最后提供本轮文件入口。只操作本任务目录，不下载其他资料。');
  assert('本轮文件真实生成',(await fs.readFile(await archive(name),'utf8')).trim()===marker);
  const todos=await control.get('/session/'+getSessionId()+'/todo');
  assert('本轮存在真实待办',todos.length>0,todos);
  const browserUsed=getData().messages.flatMap(m=>m.parts).some(p=>p.type==='tool'&&p.state.status==='completed'&&/browser/i.test(p.tool)&&JSON.stringify(p.state).includes('example.com'));
  if(!browserUsed)throw review('模型未实际访问浏览器，三模式状态验证缺少前置条件');
  finish('本轮产物待办浏览器准备');
  await ui(async()=>{
   await previewTaskFile(page,config,name,capture,[marker]);await ownLayout(name);
   const observations=[];
   for(let cycle=0;cycle<2;cycle++)for(const mode of ['产物','浏览器','待办']){
    if(mode==='产物')await previewTaskFile(page,config,name,capture,[marker]);else await selectWorkbench(page,config,mode,capture);
    const panel=panelOf(page),before=await panel.boundingBox(),hide=button(page,'关闭右边栏');
    await hide.hover();const tooltip=page.locator('[data-slot="tooltip-content"]').filter({visible:true});await tooltip.waitFor();
    assert('收起提示可见-'+cycle+'-'+mode,(await tooltip.innerText()).includes('关闭右边栏'));
    const position=await hide.boundingBox();await hide.click();await button(page,'显示右边栏').waitFor();
    assert('右栏真实关闭-'+cycle+'-'+mode,!await panel.isVisible());await capture(mode+'右栏收起-'+cycle);
    await button(page,'显示右边栏').click();await hide.waitFor();
    const after=await panel.boundingBox(),text=await panel.innerText();
    const correct=mode==='产物'?text.includes(marker):mode==='待办'?todos.every(todo=>text.includes(todo.content)):(await panel.getByRole('textbox').evaluateAll(elements=>elements.map(e=>e.value))).some(value=>value.includes('example.com'));
    assert('重新显示后模式内容及宽度保持-'+cycle+'-'+mode,correct&&Math.abs(before.width-after.width)<3,{before,after});
    observations.push({cycle,mode,before,after,closePosition:position});
   }
   await save('工作台状态保持.json',observations);finish('三模式两轮收起展开与状态保持');finish('收起入口位置和悬停提示');
   assert('三模式收起控件相对右上角位置一致',observations.every(view=>Math.abs(view.closePosition.x+view.closePosition.width-view.before.x-view.before.width-(observations[0].closePosition.x+observations[0].closePosition.width-observations[0].before.x-observations[0].before.width))<3&&Math.abs(view.closePosition.y-view.before.y-(observations[0].closePosition.y-observations[0].before.y))<3),observations);
   await previewTaskFile(page,config,name,capture,[marker]);
   const initial=await panelOf(page).boundingBox(),toggle=button(page,'放大 / 还原侧栏'),expanded=await toggle.getAttribute('aria-pressed')==='true';
   await toggle.click();await page.waitForFunction(value=>document.querySelector('button[aria-label="放大 / 还原侧栏"]')?.getAttribute('aria-pressed')!==String(value),expanded);
   const changed=await panelOf(page).boundingBox();assert('放大还原有真实宽度变化',expanded?changed.width<initial.width:changed.width>initial.width,{initial,changed});await capture('侧栏宽度切换');
   await restoreLayout();finish('侧栏放大还原及恢复');
  });
 }else if(number===58){
  const files=[['目录核验.txt',marker+'，预算7300元。'],['目录核验.md','# '+marker+'\n\n责任人林悦。'],['目录核验.csv','项目,金额\n星桥,7300']];
  await send('请在本任务目录生成三个真实UTF-8文件，名称和内容如下：'+JSON.stringify(files)+'。只生成这些合成文件，最终分别提供文件入口。');
  for(const [name,text] of files)assert('真实多格式产物内容-'+name,(await fs.readFile(await archive(name),'utf8')).replace(/\r\n/g,'\n').trim()===text.trim());finish('本轮三类真实产物');
  await ui(async()=>{
   await selectWorkbench(page,config,'产物',capture);await button(page,'产物').click();
   const candidates=await page.getByRole('menuitem').filter({visible:true}).allTextContents();await save('产物目录候选.json',candidates);
   assert('产物目录汇聚本轮全部文件',files.every(([name])=>candidates.some(text=>text.trim()===name)),candidates);await capture('多格式产物目录');
   try{await page.getByRole('menuitem',{name:files[0][0],exact:true}).click();}
   finally{await closeArtifactMenu(page);}finish('产物目录真实汇聚');
   for(const [name,text] of files){
    await previewTaskFile(page,config,name,capture);const panel=panelOf(page);
    const fact=name.endsWith('.csv')?'7300':marker;assert('点击后正文属于当前文件-'+name,(await panel.innerText()).includes(fact));
   }
   const panel=panelOf(page);assert('三个文件标签同时存在',await panel.getByRole('button',{name:/^关闭 目录核验\./}).count()===3);finish('逐项点击新开多标签预览');
   for(const [name] of [...files].reverse()){
    await panel.getByRole('button',{name,exact:true}).click();
    assert('已有标签切换正文-'+name,(await panel.innerText()).includes(name.endsWith('.csv')?'7300':marker));await capture('切换已有标签-'+name);
   }
   finish('多标签往返内容正确');
   // The current client exposes an artifact menu. A menu is not evidence of
   // the original requirement for a workspace-wide hierarchical file tree.
   const tree=page.getByRole('tree').filter({visible:true});
   if(await tree.count()===1){
    const items=tree.getByRole('treeitem');
    for(const [name] of files){const item=items.filter({hasText:name});assert('文件树包含本轮文件-'+name,await item.count()===1);await item.click();assert('从文件树点击打开本轮标签-'+name,await panel.getByRole('button',{name:'关闭 '+name,exact:true}).count()===1);}
    await capture('工作空间文件树');
    // A task's three files do not prove coverage of all workspace files.
    log('全域覆盖待复核','本轮文件树节点及点击已检查；未建立工作空间全域文件基线，不能据此宣称全域汇聚通过');
   }else log('原表全域文件树待复核','已验证当前产物目录及多标签；未取得工作空间全域层级文件树证据');
  });
 }else if(number===59){
  const name='星桥项目周报.docx',headings=['一、本周进展','二、风险跟踪','三、下周计划'];
  await send('请在当前任务目录生成约500个中文字的“'+name+'”Word周报，使用真实Word标题样式：文档标题“星桥项目周报”，三个一级标题为'+headings.join('、')+'，每节有二级标题。合成事实：预算7300元、责任人林悦、上线日期2026年11月6日。文末标记“'+marker+'”。只写此文件，不联网，最后提供文件入口。');
  const archiveData=unzipSync(await fs.readFile(await archive(name))),xml=strFromU8(archiveData['word/document.xml']),text=xmlText(xml);
  assert('真实Word包含周报事实与足量正文',['7300','林悦',marker,...headings].every(value=>text.includes(value))&&text.replace(/\s/g,'').length>=400,{textLength:text.length});
  const styles=strFromU8(archiveData['word/styles.xml']),levels=new Map();
  for(const match of styles.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)){
   const id=match[1].match(/w:styleId="([^"]+)"/)?.[1],body=match[2];
   const outline=body.match(/<w:outlineLvl\b[^>]*w:val="([01])"/)?.[1];
   const name=body.match(/<w:name\b[^>]*w:val="([^"]+)"/)?.[1]||'';
   const namedLevel=name.match(/^(?:heading|标题)\s*([12])$/i)?.[1];
   if(id&&(outline!==undefined||namedLevel))levels.set(id,outline===undefined?Number(namedLevel):Number(outline)+1);
  }
  const usedLevels=[...xml.matchAll(/<w:pStyle\b[^>]*w:val="([^"]+)"/g)].map(match=>levels.get(match[1]));
  assert('真实Word包含标题层级',usedLevels.includes(1)&&usedLevels.includes(2),{usedLevels});finish('真实周报及标题层级');
  await ui(async()=>{
   await previewTaskFile(page,config,name,capture);const host=panelOf(page).locator('.mw-docx-host');await host.getByText(marker,{exact:false}).waitFor();
   const visibleText=await host.innerText();assert('Word预览显示真实业务正文',['7300','林悦',marker,...headings].every(value=>visibleText.includes(value)),visibleText);finish('Word实际正文预览');await ownLayout(name);
   const layouts=[];
   for(let i=0;i<2;i++){
    layouts.push(await host.evaluate(element=>{const scroll=element.closest('.mw-preview-scroll'),a=element.getBoundingClientRect(),b=scroll.getBoundingClientRect();return {host:a.toJSON(),container:b.toJSON(),clientWidth:scroll.clientWidth,centerOffset:Math.abs((a.left+a.right)/2-(b.left+scroll.clientLeft+scroll.clientWidth/2))};}));
    await capture('Word布局-'+i);await button(page,'放大 / 还原侧栏').click();
   }
   await save('Word限宽居中.json',layouts);assert('Word两种宽度均限宽居中',layouts.every(view=>view.host.width<=816.5&&view.host.width<=view.clientWidth&&view.centerOffset<=3),layouts);finish('两种宽度限宽居中');await restoreLayout();
   const nav=panelOf(page).getByRole('navigation',{name:/大纲|outline/i});
   await save('Word大纲控件.json',{navigationCount:await nav.count(),headings:await host.locator('h1,h2,[class*="heading"]').allTextContents()});
   assert('带真实标题的Word提供大纲导航',await nav.count()===1);
   for(const heading of headings){await nav.getByText(heading,{exact:true}).click();const target=host.getByText(heading,{exact:true});assert('大纲点击定位-'+heading,await target.evaluate(element=>{const a=element.getBoundingClientRect(),b=element.closest('.mw-preview-scroll').getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;}));await capture('Word大纲-'+heading);}
   finish('Word大纲逐项导航');
  });
 }else if(number===60||number===61){
  const pdf=number===60,name=pdf?'星桥会议纪要模板.pdf':'星桥产品介绍.pptx';
  await send(pdf?'请在本任务目录生成真实三页PDF“'+name+'”，内容是中文会议纪要通用模板。每页各有一个真实PDF书签：Meeting Info、Decisions、Action Items，分别定位第1、2、3页。各页正文也分别包含以上英文标题及中文模板字段。最后一页加入“'+marker+'”。请嵌入可显示中文的字体，不将图片或HTML改扩展名充当PDF，最终提供入口。':'请在本任务目录生成真实5页PowerPoint“'+name+'”，介绍虚构的星桥产品，五页依次标题为Overview、Features、Workflow、Benefits、Next Steps。每页包含中文说明、文字和几何图形；第一页含“'+marker+'”。不要生成图片或PDF冒充PPTX，最后提供文件入口。');
  const file=await archive(name);let facts;
  if(pdf){facts=await pdfFacts(file);await save('PDF原始内容与书签.json',facts);assert('真实PDF三页且正文可提取',facts.pages.length===3&&['Meeting Info','Decisions','Action Items'].every((title,i)=>facts.pages[i].includes(title))&&facts.pages[2].replace(/\s/g,'').includes(marker));assert('PDF真实书签分别定位对应页',['Meeting Info','Decisions','Action Items'].every((title,i)=>facts.bookmarks.some(item=>item.title===title&&item.page===i+1)),facts.bookmarks);}
  else{const zip=unzipSync(await fs.readFile(file)),slides=Object.keys(zip).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>Number(a.match(/(\d+)\.xml$/)[1])-Number(b.match(/(\d+)\.xml$/)[1]));facts={slides:slides.map(name=>({name,text:xmlText(strFromU8(zip[name]))}))};await save('PPTX真实页面.json',facts);assert('真实PPTX恰好五页且标题正确',slides.length===5&&['Overview','Features','Workflow','Benefits','Next Steps'].every((title,i)=>facts.slides[i].text.includes(title)));}
  finish(pdf?'真实PDF模板与书签':'真实五页PPTX');
  await ui(async()=>{
   await previewTaskFile(page,config,name,capture);const panel=panelOf(page),surface=await previewInventory(pdf?'PDF预览控件.json':'PPT预览控件.json');
   if(pdf){
    const nav=surface.scope.getByRole('navigation',{name:/大纲|书签|outline|bookmark/i});
    if(!await nav.count()&&surface.kind==='iframe')throw review('PDF文件及书签已核对，但内嵌PDF插件未暴露可读取大纲；已保存现场，不能只凭iframe存在判定预览及导航通过');
    assert('PDF预览存在大纲导航',await nav.count()===1);
    for(const title of ['Meeting Info','Decisions','Action Items']){await nav.getByText(title,{exact:true}).click();await capture('PDF书签-'+title);assert('PDF书签切换对应正文-'+title,await surface.scope.getByText(title,{exact:true}).filter({visible:true}).count()>0);}
    finish('PDF大纲逐项定位');
    await ownLayout(name);const layouts=[];
    for(let i=0;i<2;i++){
     const canvases=surface.scope.locator('canvas').filter({visible:true});
     if(!await canvases.count())throw review('PDF大纲可操作，但未暴露可读取的实际页面几何，保留正文布局缺口');
     const canvas=canvases.last();
     layouts.push(await canvas.evaluate(element=>{let parent=element.parentElement;while(parent&&getComputedStyle(parent).overflowY!=='auto'&&getComputedStyle(parent).overflowY!=='scroll')parent=parent.parentElement;const container=parent||element.parentElement,a=element.getBoundingClientRect(),b=container.getBoundingClientRect();return {page:a.toJSON(),container:b.toJSON(),clientWidth:container.clientWidth,offset:Math.abs((a.left+a.right)/2-(b.left+container.clientLeft+container.clientWidth/2))};}));
     await capture('PDF布局-'+i);await button(page,'放大 / 还原侧栏').click();
    }
    await save('PDF限宽居中.json',layouts);assert('PDF两种宽度页面居中且不超出容器',layouts.every(view=>view.page.width>0&&view.page.width<=view.clientWidth+1&&view.offset<4)&&layouts.some(view=>view.page.width<view.clientWidth-10),layouts);finish('PDF两种宽度限宽居中');await restoreLayout();
   }else{
    const zoomIn=surface.scope.getByRole('button',{name:/^(放大|Zoom in)$/i}).filter({visible:true}),zoomOut=surface.scope.getByRole('button',{name:/^(缩小|Zoom out)$/i}).filter({visible:true});
    if(!await zoomIn.count()&&surface.kind==='iframe')throw review('PPTX五页原文件已核对，当前转换后的内嵌PDF隐藏工具栏；未取得PPT缩放入口和实际页内容，不能将转换窗口当PPT缩放通过');
    assert('PPT预览有可操作的放大缩小入口',await zoomIn.count()===1&&await zoomOut.count()===1);
    const percentages=[await readPreviewZoom(surface.scope)];
    resources.previewZoom={file:name,value:percentages[0],iframe:surface.kind==='iframe'};await checkpointResources();
    const geometry=()=>surface.scope.locator('canvas,svg,img').filter({visible:true}).evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height};}).filter(r=>r.width>=120&&r.height>=80).sort((a,b)=>b.width*b.height-a.width*a.height)[0]||null);
    const geometries=[await geometry()];
    for(const [index,action] of [zoomIn,zoomIn,zoomOut,zoomOut].entries()){
     await action.click();percentages.push(await readPreviewZoom(surface.scope));
     geometries.push(await geometry());
     await capture('PPT缩放-'+(index+1));
    }
    await save('PPT缩放百分比.json',percentages);assert('四次缩放每次5个百分点且回到原值',percentages.slice(1).every((value,i)=>value-percentages[i]===(i<2?5:-5)));finish('缩放四次每次五个百分点');
    await save('PPT缩放图形几何.json',geometries);
    if(geometries.some(item=>!item))throw review('已取得缩放数值，未取得实际页面大图形几何；工具栏图标不能证明版式比例');
    const baseline=geometries[0];
    assert('实际页面随缩放等比例变化',geometries.every((item,i)=>Math.abs(item.width/baseline.width-percentages[i]/percentages[0])<0.03&&Math.abs(item.height/baseline.height-percentages[i]/percentages[0])<0.03),{percentages,geometries});
    delete resources.previewZoom;await checkpointResources();
    for(const [index,title] of ['Overview','Features','Workflow','Benefits','Next Steps'].entries()){
     const target=surface.scope.getByRole('button',{name:new RegExp('^(?:第\\s*'+(index+1)+'\\s*页|(?:Slide|Page)\\s*'+(index+1)+')$','i')}).filter({visible:true});
     if(await target.count()!==1)throw review('未唯一识别PPT第'+(index+1)+'页切换入口，保留页间版式缺口');
     await target.click();assert('PPT切换显示当前页真实标题-'+(index+1),await surface.scope.getByText(title,{exact:false}).filter({visible:true}).count()>0);
     assert('PPT当前页具有可见页面图形-'+(index+1),!!await geometry());await capture('PPT第'+(index+1)+'页');
    }
    finish('PPT五页切换及版式');
   }
  });
 }
}
