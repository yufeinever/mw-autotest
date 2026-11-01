import {connectClientMenu} from '../local-console/client-connection.mjs';

const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});

export function matchToolDetailText(tool,text){
 const normalized=value=>String(value).replace(/\s+/g,' ').trim();
 const output=typeof tool.state.output==='string'?tool.state.output:JSON.stringify(tool.state.output||'');
 const input=tool.state.input||{},expected=tool.tool==='write'?input.content:tool.tool==='bash'?input.command:tool.tool==='read'?(output.match(/<content>([\s\S]*?)<\/content>/)?.[1]||output):JSON.stringify(input);
 if(!expected||!normalized(text).includes(normalized(expected))||tool.tool!=='read'&&output&&!normalized(text).includes(normalized(output)))return null;
 return {missingInputFields:Object.entries(input).filter(([,value])=>typeof value==='string'&&!normalized(text).includes(normalized(value))).map(([key])=>key)};
}

// Callers assign a unique title tied to their owned Session or workspace. The same
// Session may appear in both Recent and its workspace; either row is valid.
export const taskRow=(page,title,scope=page)=>scope.locator('div.group\\/recent-task,[data-slot="sidebar-menu-sub-item"]').filter({visible:true}).filter({has:page.getByText(title,{exact:true})}).first();

export async function openTaskMenu(page,title,scope=page){
 const row=taskRow(page,title,scope);await row.waitFor();
 if(await row.count()!==1)throw Error('未唯一找到本轮任务行：'+title);
 await row.hover();await row.locator('button[data-slot="dropdown-menu-trigger"]').click();
 return row;
}

async function ensureWorkbenchVisible(page){
 const panel=page.getByTestId('session-workbench-panel');
 if(await panel.isVisible())return;
 const toggle=page.locator('main > header').getByRole('button',{name:/^(显示右边栏|关闭右边栏)$/}).filter({visible:true});
 await toggle.focus();
 // The browser tool may open the same rail while the model is running.
 // Re-read the current control before activating its native keyboard action.
 if(await toggle.getAttribute('aria-label')==='显示右边栏')await toggle.press('Enter');
 await panel.waitFor();
}

export async function selectWorkbench(page,config,mode,capture){
 await ensureWorkbenchVisible(page);
 const trigger=button(page,'切换面板功能'),url=page.url();let menuBrowser;
 await trigger.press('Enter');
 try{
  menuBrowser=await connectClientMenu('http://127.0.0.1:'+config.cdpPort,{timeout:10000});
  const expected=new URL('overlay.html',page.url());expected.hash='';expected.search='';
  const menus=menuBrowser.contexts().flatMap(context=>context.pages()).filter(item=>item.url()===expected.href);
  if(menus.length!==1)throw Error('菜单页面不唯一');
  const menu=menus[0];await menu.getByRole('menuitem',{name:mode,exact:true}).waitFor();
  await menu.getByRole('menuitem',{name:mode,exact:true}).click();
 }finally{
  if(menuBrowser)await menuBrowser.close();
  if(page.url()===url&&await trigger.getAttribute('aria-expanded')==='true')await trigger.press('Enter');
 }
 await capture('工作台-'+mode);
}

export async function openArtifactMenu(page){
 const trigger=page.getByTestId('session-workbench-panel').getByRole('button',{name:'产物',exact:true}).filter({visible:true});
 try{await trigger.waitFor({timeout:10000});}
 catch(error){
  if(error.name!=='TimeoutError')throw error;
  throw Object.assign(Error('当前Session的产物目录尚未提供真实入口；磁盘文件存在不能代替客户端产物登记',{cause:error}),{review:true});
 }
 await trigger.click();
 const menuId=await trigger.getAttribute('aria-controls');
 if(!menuId)throw Error('产物菜单触发器未提供aria-controls，无法确认菜单归属');
 const menu=page.getByRole('menu').and(page.locator('[id='+JSON.stringify(menuId)+']'));
 await menu.waitFor();return menu;
}

export async function closeArtifactMenu(page){
 const panel=page.getByTestId('session-workbench-panel'),trigger=panel.getByRole('button',{name:'产物',exact:true}).filter({visible:true});
 if(await trigger.count()&&await trigger.getAttribute('aria-expanded')==='true'){
  await page.keyboard.press('Escape');
  await panel.locator('button[aria-label="产物"][aria-expanded="true"]').waitFor({state:'hidden'});
 }
}

export async function readTaskPreviewText(panel,name){
 if(/\.csv$/i.test(name)){
  const cells=panel.locator('table td input');await cells.first().waitFor();
  return (await cells.evaluateAll(elements=>elements.map(element=>element.value))).join('\n');
 }
 if(/\.docx$/i.test(name)){
  // The loading label disappears before the lazy docx renderer mounts its
  // document. Wait for that real document, rather than reading the file header.
  await panel.locator('.mw-docx-host section.docx').or(panel.locator('iframe').filter({visible:true})).first().waitFor({timeout:45000});
 }
 let text=await panel.innerText();
 const frame=panel.locator('iframe').filter({visible:true});
 if(await frame.count()===1)text+='\n'+await frame.contentFrame().locator('body').innerText();
 return text;
}

export const taskPreviewTitle=(panel,name)=>panel.locator('span.min-w-0.flex-1.truncate').and(panel.getByText(name,{exact:true}));

export async function openTaskFilePreview(page,name){
 const panel=page.getByTestId('session-workbench-panel');
 // Open tabs retain intermediate files even when the final delivery menu
 // contains only the latest artifact. Both are real product entry points.
 const tab=panel.getByRole('button',{name,exact:true});
 if(await tab.count())await tab.click();
 else{
  const menu=await openArtifactMenu(page);
  try{
   const item=menu.getByRole('menuitem',{name,exact:true});
   if(!await item.count())throw Object.assign(Error('当前Session的已开标签及产物菜单均无此文件入口：'+name),{review:true});
   await item.click();
  }finally{await closeArtifactMenu(page);}
 }
 return panel;
}

export async function previewTaskFile(page,config,name,capture,facts=[]){
 await selectWorkbench(page,config,'产物',capture);
 const panel=await openTaskFilePreview(page,name);
 await taskPreviewTitle(panel,name).waitFor();
 await waitTaskPreviewReady(panel,name);
 const text=await readTaskPreviewText(panel,name);
 await capture('文件预览-'+name);
 if(facts.some(fact=>!text.includes(fact)))throw Object.assign(Error('文件入口已打开，但尚未在预览内容中核对关键事实：'+name),{review:true});
 return panel;
}

export async function waitTaskPreviewReady(panel,name){
 await panel.getByText(/正在加载|加载中|正在转换(?:幻灯片|文档)|正在准备预览/).filter({visible:true}).first().waitFor({state:'hidden',timeout:45000});
 const error=panel.getByText(/预览失败|无法预览|加载失败|无法加载.*预览|无法渲染(?:文档|幻灯片)/);
 if(await error.count())throw Error('客户端文件预览失败：'+name+'；'+await error.first().innerText());
}

export async function restoreWorkbenchLayout(page,layout,config){
 await ensureWorkbenchVisible(page);
 let toggle=button(page,'放大 / 还原侧栏');
 if(!await toggle.count())await previewTaskFile(page,config,layout.file,async()=>{});
 if((await toggle.getAttribute('aria-pressed')==='true')!==layout.expanded)await toggle.click();
 await page.waitForFunction(expanded=>document.querySelector('button[aria-label="放大 / 还原侧栏"]')?.getAttribute('aria-pressed')===String(expanded),layout.expanded);
}

export async function readPreviewZoom(scope){
 const values=await scope.locator('input,span').filter({visible:true}).evaluateAll(elements=>elements.map(e=>e.value||e.textContent).filter(value=>/^\s*\d+%\s*$/.test(value)));
 const unique=[...new Set(values.map(value=>parseInt(value,10)))];
 if(unique.length!==1)throw Object.assign(Error('未唯一识别预览的实际缩放百分比'),{review:true});
 return unique[0];
}

export async function restorePreviewZoom(page,owned,config){
 await previewTaskFile(page,config,owned.file,async()=>{});
 const panel=page.getByTestId('session-workbench-panel'),iframe=panel.locator('iframe').filter({visible:true});
 const scope=owned.iframe?await (await iframe.elementHandle()).contentFrame():panel;
 let value=await readPreviewZoom(scope);
 if(Math.abs(value-owned.value)>10||(value-owned.value)%5)throw Error('预览缩放与本轮操作范围不符，保留原值');
 const count=Math.abs(value-owned.value)/5,direction=value>owned.value?-5:5;
 for(let i=0;i<count;i++){
  await scope.getByRole('button',{name:direction<0?/^(缩小|Zoom out)$/i:/^(放大|Zoom in)$/i}).filter({visible:true}).click();
  const next=await readPreviewZoom(scope);
  if(next!==value+direction)throw Error('本轮缩放恢复未按5个百分点生效，保留现场');
  value=next;
 }
}
