import {sameKnowledgePath} from './mobilework-knowledge-resources.mjs';

export const sameSourceDirectories=(actual,expected)=>actual.length===expected.length&&expected.every(value=>actual.filter(item=>sameKnowledgePath(item,value)).length===1);

// Read one version of the real menu, including its React identity. Names alone
// are not unique; no handler or React state is invoked or changed here.
export async function readParseModelMenu(menu){
 return menu.evaluateHandle(root=>{
  const marker=[...root.querySelectorAll('div')].find(node=>node.textContent==='自定义模型'&&node.children.length===0);
  const elements=[...root.querySelectorAll('button')].filter(node=>node.querySelector('span.truncate')&&node.getClientRects().length);
  const models=elements.map(node=>{
   const fiber=node[Object.keys(node).find(key=>key.startsWith('__reactFiber$'))];
   const key=fiber?.key;
   let parts=null;
   if(key?.startsWith('['))parts=JSON.parse(key);
   return {id:Array.isArray(parts)&&parts.length===2?parts.join('/'):null,title:node.querySelector('span.truncate').textContent.trim(),custom:!!marker&&!!(marker.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)};
  });
  return {models,elements};
 });
}

export async function stableParseModelMenu(page,menu){
 const deadline=Date.now()+10000;let signature='',since=Date.now();
 while(Date.now()<deadline){
  const sample=await readParseModelMenu(menu);let keep=false;
  try{
   const models=await sample.evaluate(value=>value.models),next=JSON.stringify(models);
   if(signature!==next){signature=next;since=Date.now();}
   if(models.length&&Date.now()-since>=1000){
    if(models.some(model=>!model.id)||new Set(models.map(model=>model.id)).size!==models.length)throw Object.assign(Error('解析模型菜单未暴露唯一身份，未按名称或位置猜测'),{review:true});
    keep=true;return sample;
   }
  }finally{if(!keep)await sample.dispose();}
  await page.waitForTimeout(100);
 }
 throw Object.assign(Error('解析模型列表在观察期限内未稳定加载，未按旧位置选择'),{review:true});
}
