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

const knowledgeSourceTypeIconSignatures={
 "md": {
  "viewBox": "0 0 16 16",
  "primaryFill": "var(--mw-file-markdown)",
  "pathData": [
   "M2.5 1h7.6L13.5 4.5V15h-11Z",
   "M10.1 1v3.5h3.4Z",
   "M5.5 12V7l2.5 3L10.5 7v5"
  ]
 },
 "docx": {
  "viewBox": "0 0 18 18",
  "primaryFill": "#4A8DFF",
  "pathData": [
   "M3.14648437,1.125L11.38183595,1.125L15.30175825,5.0888672L15.30175825,16.435547C15.30175825,16.678249,15.10500725,16.875,14.86230425,16.875L3.14648437,16.875C2.90378332,16.875,2.70703125,16.678249,2.70703125,16.435547L2.70703125,1.56445312C2.70703125,1.32175192,2.90378332,1.125,3.14648437,1.125Z",
   "M11.3818359375,1.125L11.3818359375,4.6494140999999996C11.3818359375,4.8921151,11.5785873575,5.0888672,11.8212890575,5.0888672L15.3017578375,5.0888672L11.3818359375,1.125Z",
   "M12.184329,13.791797125C12.5630503,14.206570625000001,13.2539063,13.938626325000001,13.2539063,13.376953125L13.2539063,6.837890625L12.0234375,6.837890625L12.0234375,11.790667525L9.577388299999999,9.111620925C9.333421699999999,8.844415625,8.9126716,8.844415625,8.668705,9.111620925L6.2226563,11.790667525L6.2226563,6.837890625L4.9921875,6.837890625L4.9921875,13.376953125C4.9921875,13.938644425,5.68304282,14.206588225,6.0617635,13.791797125L9.1230469,10.438892125L12.184329,13.791797125Z"
  ]
 },
 "bin": {
  "viewBox": "0 0 18 18",
  "primaryFill": "#CCCCCC",
  "pathData": [
   "M3.14648437,1.125L11.38183595,1.125L15.30175825,5.0888672L15.30175825,16.435547C15.30175825,16.678249,15.10500725,16.875,14.86230425,16.875L3.14648437,16.875C2.90378332,16.875,2.70703125,16.678249,2.70703125,16.435547L2.70703125,1.56445312C2.70703125,1.32175192,2.90378332,1.125,3.14648437,1.125Z",
   "M11.3818359375,1.125L11.3818359375,4.6494140999999996C11.3818359375,4.8921151,11.5785873575,5.0888672,11.8212890575,5.0888672L15.3017578375,5.0888672L11.3818359375,1.125Z",
   "M9.0000000125,6.4072265625C9.6000996125,6.4072265625,10.2041018125,6.6039608125,10.6658969125,6.9642773825C11.195648712499999,7.3775919725,11.5048828125,7.9757226625,11.5048828125,8.6748046625C11.5048828125,9.5840332625,10.8797350125,10.4154434625,9.700277612499999,11.2058791625L9.6943362125,11.2098340625L9.6943362125,12.234374962499999C9.6943362125,12.546738662500001,9.4436540125,12.8005490625,9.1324863125,12.8055944625L9.1230469125,12.805664562499999C8.8075197125,12.805664562499999,8.5517578125,12.5499024625,8.5517578125,12.234374962499999L8.5517578125,10.898437462499999C8.551757112499999,10.7009315625,8.6537721125,10.5174345625,8.8215291125,10.4131936625C9.878080412500001,9.7567033625,10.3623049125,9.1619825625,10.3623049125,8.6748046625C10.3623049125,8.3378671625,10.2225587125,8.0675684625,9.9630356125,7.8650863625C9.7074847125,7.6656974625,9.3516855125,7.5498046625,9.0000000125,7.5498046625C8.6498439125,7.5498046625,8.2994060125,7.6647657625,8.0483732125,7.8630291625C7.7931567125,8.0645623625,7.6552734125,8.3353533625,7.6552734125,8.6748046625C7.6552734125,8.9903321625,7.3995117525000005,9.2460937625,7.0839843725,9.2460937625C6.7684570525,9.2460937625,6.5126953125,8.9903321625,6.5126953125,8.6748046625C6.5126953125,7.9770760625,6.8169198025,7.3795955825,7.3402735025,6.9663167025C7.7986581125,6.6043473925,8.3994084125,6.4072265625,9.0000000125,6.4072265625ZM9.1494141125,14.8007812625C9.5134570125,14.8007812625,9.8085940125,14.5056447625,9.8085940125,14.141602062499999C9.8085940125,13.7775587625,9.5134570125,13.4824223625,9.1494141125,13.4824223625C8.7853711125,13.4824223625,8.4902345125,13.7775587625,8.4902345125,14.141602062499999C8.4902345125,14.5056447625,8.7853711125,14.8007812625,9.1494141125,14.8007812625Z"
  ]
 }
};

// Installed v2026.02.01 file glyphs; compare visible geometry, not total SVG count.
export async function readKnowledgeSourceTypeIcons(page,expectedNodes){
 const signatures=knowledgeSourceTypeIconSignatures;
 return page.locator('[data-knowledge-source-node][role="button"]').filter({visible:true}).evaluateAll((rows,{expectedNodes,signatures})=>{
  const results=[];
  for(const expected of expectedNodes){
   const matching=rows.filter(row=>{
    const label=row.querySelector('span[title]');if(label?.title!==expected.name)return false;
    let owner=row[Object.keys(row).find(key=>key.startsWith('__reactFiber$'))];
    while(owner){
     const node=owner.memoizedProps?.node;
     if(node)return node.id===expected.path&&node.name===expected.name&&node.type===expected.type;
     owner=owner.return;
    }
    return false;
   });
   if(matching.length!==1)throw Error('源行完整路径未唯一匹配：'+expected.path);
   const row=matching[0],label=row.querySelector('span[title]'),svg=label.previousElementSibling;
   if(svg?.tagName.toLowerCase()!=='svg'||!svg.getClientRects().length)throw Error('文件名相邻类型SVG未显示：'+expected.path);
   const actual={viewBox:svg.getAttribute('viewBox'),pathData:[...svg.querySelectorAll('path')].map(p=>p.getAttribute('d')),primaryFill:svg.querySelector('path')?.getAttribute('fill')};
   const kind=expected.name.split('.').at(-1).toLowerCase(),signature=signatures[kind];
   const pass=Boolean(signature)&&actual.viewBox===signature.viewBox&&JSON.stringify(actual.pathData)===JSON.stringify(signature.pathData)&&actual.primaryFill===signature.primaryFill;
   results.push({path:expected.path,name:expected.name,type:expected.type,expectedKind:kind,pass,actual});
  }
  return results;
 },{expectedNodes,signatures});
}
