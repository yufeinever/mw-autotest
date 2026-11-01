import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {connectClientBrowser} from '../local-console/client-connection.mjs';
import {selectWorkbench} from './mobilework-task-ui.mjs';
import {workspaces,workspaceSessions,createDefaultWorkspace,createLocalWorkspace,workspaceRow,workspaceExpand,readWorkspaceSidebar,prepareWorkspaceResources} from './mobilework-workspaces.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const safeSpace=({id,name,path,isDefault})=>({id,name,path,isDefault:Boolean(isDefault)});
const inside=(parent,child)=>{const rel=path.relative(parent,child);return !rel.startsWith('..')&&!path.isAbsolute(rel);};

export async function runBrowserWorkspaceSteps(context){
 const {number,page,config,control,dir,resources,remaining,outputs,assert,capture,captureBrowser,log,send,checkpointResources,checkpointPage,getData,getSessionId}=context;
 const finish=name=>remaining.delete(name),save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
 const ui=action=>control.withUI(page,'INTERACTING',action);
 async function updatePageOwnership(){
  await checkpointPage();
 }
 async function beginSpaces(target=null){resources.workspaceResources=await prepareWorkspaceResources(page,{target});await checkpointResources();}
 async function ensureRows(){
  const toggle=page.getByTestId('workspace-section-header').locator('button[aria-expanded]:not([aria-haspopup])');
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 }
 async function createSpace(local=false){
  const name='MW-CASE'+number+'-'+Date.now(),folder=path.join(dir,name);
  await beginSpaces({name,...(local?{path:folder}:{})});
  const created=local?await createLocalWorkspace(page,folder,log,dir,control):await createDefaultWorkspace(page,name);
  await updatePageOwnership();await ensureRows();const row=workspaceRow(page,created.id);await row.waitFor();
  await save('本轮工作空间.json',safeSpace(created));
  assert('产品实际注册本轮独立工作空间',created.name===name&&(local?path.resolve(created.path)===path.resolve(folder):inside((await workspaces(page)).items.find(item=>item.isDefault).path,created.path)),safeSpace(created));
  assert('新增工作空间默认展开',await workspaceExpand(row).getAttribute('aria-expanded')==='true');
  await capture('新空间默认展开');return created;
 }
 if(number===72){
  const marker='青禾浏览器-'+path.basename(dir),name='内嵌浏览器验证.html';
  await send('请通过MobileWork内置浏览器真实打开 https://www.baidu.com/ ，在页面搜索框输入“天气”并点击百度一下，等待结果并读取网页标题。然后在本任务目录生成“'+name+'”，这是UTF-8独立HTML，正文含标题“'+marker+'”及表格：项目青禾、预算7300元、负责人林悦。最后给出本地HTML文件入口。不要用网络搜索摘要替代浏览器操作，不修改其他目录。');
  const html=await fs.readFile(path.join(control.directory,name),'utf8');await fs.writeFile(path.join(dir,name),html);outputs.push({name,path:name});
  assert('本Session实际生成带中文事实的HTML',[marker,'7300','林悦'].every(text=>html.includes(text)));finish('本Session浏览器与HTML准备');
  await ui(async()=>{
   await selectWorkbench(page,config,'浏览器',capture);
   let hostBrowser;
   try{
    hostBrowser=await connectClientBrowser('http://127.0.0.1:'+config.cdpPort,{browserViewId:getSessionId(),timeout:15000});
    const host=hostBrowser.contexts().flatMap(c=>c.pages())[0];host.setDefaultTimeout(15000);
    const view=host.locator('webview').filter({visible:true});await view.waitFor();
    const read=()=>view.evaluate(async e=>({url:e.getURL(),title:e.getTitle(),loading:e.isLoading(),body:await e.executeJavaScript('document.body.innerText')}));
    const search=await read();await save('百度搜索实际页面.json',search);
    assert('内嵌浏览器实际展示天气搜索结果',/baidu\.com/.test(search.url)&&(/(?:wd|word)=/.test(search.url)||/天气/.test(search.title))&&search.body.includes('天气')&&!/安全验证|网络不给力|无法访问此网站/.test(search.title));
    await captureBrowser(host,'百度天气实际搜索');finish('百度实际访问与天气搜索');
    const address=host.locator('input.url-input');
    async function navigate(url){await address.fill(url);await address.press('Enter');await host.waitForFunction(expected=>{const e=[...document.querySelectorAll('webview')].find(e=>e.getBoundingClientRect().width>0);return e&&!e.isLoading()&&e.getURL()===expected;},url,{timeout:45000});return read();}
    const local=pathToFileURL(path.join(control.directory,name)).href,localRead=await navigate(local);
    await save('本地HTML实际页面.json',localRead);assert('内嵌浏览器实际读取本地HTML正文',[marker,'7300','林悦'].every(text=>localRead.body.includes(text)));
    // Installed browser exposes three buttons in order: back, forward, reload.
    const actualButtons=await host.locator('.nav-btn').evaluateAll(items=>items.map(e=>({html:e.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g,'<svg/>')})));await save('浏览器导航实际控件.json',actualButtons);
    const toolbar=host.locator('.nav-btn').filter({visible:true});
    await toolbar.nth(0).click();await host.waitForFunction(()=>{const e=[...document.querySelectorAll('webview')].find(e=>e.getBoundingClientRect().width>0);return e&&!e.isLoading()&&e.getURL().includes('baidu.com');},undefined,{timeout:45000});
    const back=await read();assert('后退返回刚才天气搜索页',back.body.includes('天气')&&back.url===search.url);
    await toolbar.nth(1).click();await host.waitForFunction(url=>{const e=[...document.querySelectorAll('webview')].find(e=>e.getBoundingClientRect().width>0);return e&&!e.isLoading()&&e.getURL()===url;},local,{timeout:45000});
    assert('前进回到本轮本地HTML',(await read()).body.includes(marker));finish('内嵌前进后退');
    const prior=await view.evaluate(e=>e.executeJavaScript('performance.timeOrigin'));
    await toolbar.nth(2).click();await host.waitForFunction(async prior=>{const e=[...document.querySelectorAll('webview')].find(e=>e.getBoundingClientRect().width>0);return e&&!e.isLoading()&&(await e.executeJavaScript('performance.timeOrigin'))!==prior;},prior,{timeout:45000});
    const refreshed=await read();assert('刷新真实重载且正文正确',refreshed.url===local&&refreshed.body.includes(marker));await save('浏览器导航完成.json',{back,refreshed});finish('刷新与本地HTML预览');
    await captureBrowser(host,'本地HTML浏览器预览');
   }finally{if(hostBrowser)await hostBrowser.close();}
  });
 }else if(number===73){
  await beginSpaces();await ensureRows();
  const {items}=await workspaces(page),expected=items.filter(item=>!item.isDefault);
  let sidebar=await readWorkspaceSidebar(page);await save('空间列表基线.json',{items:items.map(safeSpace),sidebar});
  assert('侧栏空间数量与产品非默认空间集合一致',Number(sidebar.heading.match(/\d+/)?.[0])===expected.length&&sidebar.rows.length===expected.length);
  assert('用户自建空间名称及编号无遗漏重复',new Set(sidebar.rows.map(row=>row.id)).size===expected.length&&expected.every(item=>sidebar.rows.some(row=>row.id===item.id&&row.name===item.name)));finish('真实空间集合与动态数量');
  const header=page.getByTestId('workspace-section-header');await header.hover();assert('新建空间入口可用',await button(header,'添加工作空间').isEnabled());
  await button(header,'排序').click();
  const sorted=expected.slice().sort((a,b)=>a.name.localeCompare(b.name,'zh-Hans-CN')).map(item=>item.id);
  await page.waitForFunction(ids=>JSON.stringify([...document.querySelectorAll('[data-testid="workspace-section"] [id^="ws_"]')].map(e=>e.id))===JSON.stringify(ids),sorted);
  sidebar=await readWorkspaceSidebar(page);await save('空间名称排序.json',sidebar);assert('排序入口按真实中文名称顺序排列',JSON.stringify(sidebar.rows.map(row=>row.id))===JSON.stringify(sorted));finish('新建入口与中文名称排序');
  const taskEvidence=[];
  for(const space of expected){
   const row=workspaceRow(page,space.id);if(await workspaceExpand(row).getAttribute('aria-expanded')!=='true')await workspaceExpand(row).click();
   await row.locator('[data-slot="collapsible-content"]').waitFor();
   const tasks=await workspaceSessions(page,space.id),roots=tasks.filter(task=>!task.parentID&&!task.time?.archived);
   const more=row.getByRole('button').filter({hasText:/^显示更多(?:\d+个)?$/});
   while(await more.count()===1){const before=await row.innerText();await more.click();await page.waitForFunction(({id,before})=>document.getElementById(id)?.innerText!==before,{id:space.id,before});}
   const text=await row.innerText();taskEvidence.push({workspaceId:space.id,tasks:roots.map(({id,title})=>({id,title})),text});await save('各空间任务事实.json',taskEvidence);
   assert('空间任务展示与实际根任务对应：'+space.name,roots.every(task=>text.includes(task.title)),{expected:roots.map(task=>task.title),actual:text});
   if(!roots.length)assert('无任务空间有可见空提示：'+space.name,/暂无|没有|新建|创建|工作任务/.test(text),text);
   await capture('空间展开-'+space.name);
  }
  const expanded=await readWorkspaceSidebar(page);await save('空间展开及任务行.json',expanded);
  assert('各自建空间均可实际展开并展示任务或空提示',expanded.rows.every(row=>row.expanded));
  finish('各空间任务展开与空状态');
 }else if(number===74||number===75){
  await createSpace(number===75);finish('真实新增空间及注册');finish('新增空间默认展开');
  if(number===75){const picker=JSON.parse(await fs.readFile(path.join(dir,'原生文件夹选择器.json'),'utf8'));assert('原生目录窗口识别回读及关闭完成',picker.dialogFound&&picker.dialogClosed&&picker.path===resources.workspaceResources.target.path);finish('原生窗口目录选择及产品接收');}
 }else if(number===76){
  const created=await createSpace();finish('独立测试空间前置');
  const row=workspaceRow(page,created.id);await row.locator('[data-workspace-row-header]').hover();
  const create=row.locator('[data-workspace-actions] > button:not([aria-haspopup])');await create.hover();
  const tip=page.locator('[data-slot="tooltip-content"]').filter({visible:true});await tip.waitFor();assert('空间行新建入口提示为新建任务',(await tip.innerText()).includes('新建任务'));
  await create.click();await page.waitForURL(url=>!url.toString().includes('/session/'));await updatePageOwnership();
  await button(page.locator('main').last(),created.name).waitFor();assert('空间行入口新任务默认选择本空间',await button(page.locator('main').last(),created.name).count()===1);finish('空间行入口创建任务');
  const marker='空间归属-'+path.basename(dir),file='空间任务核验.txt';
  await send('请在当前任务目录新建“'+file+'”，UTF-8内容为“'+marker+'；项目青禾，预算7300元，负责人林悦”。只创建这个文件，完成后简要告知。');
  const directory=control.directory;
  const body=await fs.readFile(path.join(directory,file),'utf8');await fs.writeFile(path.join(dir,file),body);outputs.push({name:file,path:file});
  assert('新Session及实际任务目录归属目标空间',page.url().includes('/workspace/'+created.id+'/session/'+getSessionId())&&inside(created.path,directory),{workspace:safeSpace(created),directory,sessionId:getSessionId()});
  assert('本Session实际完成独立任务产物',body.includes(marker)&&body.includes('7300')&&body.includes('林悦'));finish('Session目录及真实产物归属');
  await ui(async()=>{
   const title='MW076-'+getSessionId(),response=await fetch(control.connection.baseUrl.replace(/\/$/,'')+'/session/'+getSessionId()+'?directory='+encodeURIComponent(directory),{method:'PATCH',headers:{Authorization:'Basic '+btoa(control.connection.opencodeUsername+':'+control.connection.opencodePassword),'content-type':'application/json'},body:JSON.stringify({title})});
   if(!response.ok)throw Error('本轮Session标题设置失败HTTP '+response.status);
   if(await workspaceExpand(row).getAttribute('aria-expanded')!=='true')await workspaceExpand(row).click();
   await row.getByText(title,{exact:true}).waitFor({timeout:15000});assert('新任务实际显示在本工作空间下',await row.getByText(title,{exact:true}).count()===1);await capture('空间下真实新任务');finish('侧栏任务实际归属');
  });
 }
}
