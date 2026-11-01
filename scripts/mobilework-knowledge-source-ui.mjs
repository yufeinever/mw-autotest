import {knowledgeClient} from './mobilework-knowledge-api.mjs';
export const knowledgeStatusLabels={unparsed:['未解析'],queued:['待解析'],success:['成功'],fail:['失败'],pending_update:['待更新'],updating:['解析中','待解析'],unable_parse:['无法解析']};
export const flattenKnowledgeFiles=nodes=>nodes.flatMap(node=>node.type==='file'?[{name:node.name,path:node.path,status:node.status}]:flattenKnowledgeFiles(node.children||[]));
export const matchingKnowledgeNames=(items,keyword)=>items.filter(item=>item.name.toLowerCase().includes(keyword.trim().toLowerCase())).map(item=>item.name).sort();
export const sourceToolbar=page=>page.locator('aside.mw-knowledge-workspace [role="tabpanel"]').filter({visible:true}).first().locator('div[tabindex="-1"]').first();

export async function sourceToolbarControls(page){
 const toolbar=sourceToolbar(page),buttons=toolbar.getByRole('button');
 const labels=await buttons.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')||node.textContent));
 if(labels.length!==7||await buttons.nth(2).getAttribute('data-knowledge-guide')!=='manage'||await buttons.nth(3).getAttribute('data-knowledge-guide')!=='files')throw Object.assign(Error('源文件工具栏结构与已识别安装版不一致，未按猜测顺序点击'),{blocked:true});
 return {toolbar,buttons,labels};
}

export async function observeKnowledgeSourceRows(page,files,{autoExpand=true}={}){
 const visible=await Promise.all(files.map(file=>page.locator('[data-knowledge-source-node] span[title='+JSON.stringify(file.name)+']').filter({visible:true}).isVisible()));
 if(autoExpand&&visible.some(value=>!value)){
  const {buttons,labels}=await sourceToolbarControls(page);
  if(labels[5].includes('收起'))await buttons.nth(5).click();
  await buttons.nth(5).click();
 }
 for(const file of files)await page.locator('[data-knowledge-source-node] span[title='+JSON.stringify(file.name)+']').filter({visible:true}).waitFor();
 return page.locator('[data-knowledge-source-node][role="button"]').filter({visible:true}).evaluateAll(nodes=>nodes.map(node=>({name:node.querySelector('span[title]')?.getAttribute('title'),text:node.textContent,icons:node.querySelectorAll('svg,img').length})).filter(item=>item.name));
}

export async function waitSourceFileSet(page,expected,universe){
 await page.waitForFunction(({expected,universe})=>{
  const shown=[...document.querySelectorAll('[data-knowledge-source-node] span[title]')].filter(node=>node.getBoundingClientRect().height&&universe.includes(node.title)).map(node=>node.title).sort();
  return JSON.stringify(shown)===JSON.stringify(expected);
 },{expected:[...expected].sort(),universe});
}

export const hasKnowledgeBudget=(text,value)=>[...text.replace(/[,，\s]/g,'').matchAll(/\d+(?:\.\d+)?(?:万)?/g)].some(([number])=>Math.abs(parseFloat(number)*(number.endsWith('万')?10000:1)-value)<0.001);

export async function openKnowledgeReference(page){
 const panel=page.getByRole('button',{name:'管理知识库',exact:true}).filter({visible:true});
 if(!await panel.count())await page.getByRole('button',{name:'知识库',exact:true}).filter({visible:true}).click();
 await panel.waitFor();
 return panel.locator('xpath=../..');
}
export const knowledgeReferenceRow=(panel,name)=>panel.getByText(name,{exact:true}).locator('xpath=..');

export async function releaseKnowledgeSelection(page,resources){
 const owned=resources.knowledgeSelection;if(!owned)return;
 if(page.url()!==resources.url)throw Error('知识库引用所在页面已变化，保留当前选择');
 const panel=await openKnowledgeReference(page);
 for(const item of owned.items){
  const row=knowledgeReferenceRow(panel,item.name);
  const count=await row.count();
  if(count===0&&!(await (await knowledgeClient(page))('/knowledge/list')).some(value=>value.id===item.id))continue;
  if(count!==1)throw Error('本轮知识库引用行未唯一识别，保留选择：'+item.name);
  const choice=row.getByRole('switch');
  await choice.waitFor();if(await choice.getAttribute('aria-checked')==='true')await choice.click();
  if(await choice.getAttribute('aria-checked')!=='false')throw Error('本轮知识库引用取消未确认');
 }
 await page.getByRole('button',{name:'知识库',exact:true}).filter({visible:true}).click();
 delete resources.knowledgeSelection;
}
