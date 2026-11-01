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

export async function selectWorkbench(page,config,mode,capture){
 const show=button(page,'显示右边栏');
 if(await show.count())await show.click();
 const trigger=button(page,'切换面板功能'),url=page.url();let menuBrowser;
 await trigger.click();
 try{
  menuBrowser=await connectClientMenu('http://127.0.0.1:'+config.cdpPort,{timeout:10000});
  const expected=new URL('overlay.html',page.url());expected.hash='';expected.search='';
  const menus=menuBrowser.contexts().flatMap(context=>context.pages()).filter(item=>item.url()===expected.href);
  if(menus.length!==1)throw Error('菜单页面不唯一');
  const menu=menus[0];await menu.getByRole('menuitem',{name:mode,exact:true}).waitFor();
  await menu.getByRole('menuitem',{name:mode,exact:true}).click();
 }finally{
  if(menuBrowser)await menuBrowser.close();
  if(page.url()===url&&await trigger.getAttribute('aria-expanded')==='true')await trigger.click();
 }
 await capture('工作台-'+mode);
}

export async function closeArtifactMenu(page){
 const trigger=button(page,'产物');
 if(await trigger.getAttribute('aria-expanded')==='true'){
  await page.keyboard.press('Escape');
  await page.getByRole('menu').filter({visible:true}).waitFor({state:'hidden'});
 }
}

export async function previewTaskFile(page,config,name,capture,facts=[]){
 await selectWorkbench(page,config,'产物',capture);
 await button(page,'产物').click();
 try{await page.getByRole('menuitem',{name,exact:true}).click();}
 finally{await closeArtifactMenu(page);}
 const panel=page.locator('[data-slot="resizable-panel"]').filter({visible:true}).last();
 await panel.getByText(name,{exact:false}).first().waitFor();
 await waitTaskPreviewReady(panel,name);
 await capture('文件预览-'+name);
 let text=await panel.innerText();
 const frame=panel.locator('iframe').filter({visible:true});
 if(await frame.count()===1)text+='\n'+await frame.contentFrame().locator('body').innerText();
 if(facts.some(fact=>!text.includes(fact)))throw Object.assign(Error('文件入口已打开，但尚未在预览内容中核对关键事实：'+name),{review:true});
 return panel;
}

export async function waitTaskPreviewReady(panel,name){
 await panel.getByText(/正在加载|加载中|正在转换(?:幻灯片|文档)|正在准备预览/).filter({visible:true}).first().waitFor({state:'hidden',timeout:45000});
 const error=panel.getByText(/预览失败|无法预览|加载失败|无法加载.*预览|无法渲染(?:文档|幻灯片)/);
 if(await error.count())throw Error('客户端文件预览失败：'+name+'；'+await error.first().innerText());
}

export async function restoreWorkbenchLayout(page,layout,config){
 const show=button(page,'显示右边栏');
 if(await show.count())await show.click();
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
