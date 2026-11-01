// Clipboard payloads stay in renderer memory, never in checkpoints or reports.
export async function beginMessageClipboard(page,owner){
 return page.evaluate(async owner=>{
  const items=await navigator.clipboard.read();
  if(items.some(item=>item.types.some(type=>!ClipboardItem.supports(type))))return {supported:false};
  const original=[];
  for(const item of items){const data={};for(const type of item.types)data[type]=await item.getType(type);original.push(data);}
  window.__mwMessageClipboard??=new Map();
  window.__mwMessageClipboard.set(owner,{original,expected:null});
  return {supported:true};
 },owner);
}

export async function expectMessageClipboard(page,owner,text){
 await page.evaluate(({owner,text})=>{window.__mwMessageClipboard.get(owner).expected=text;},{owner,text});
}

export async function restoreMessageClipboard(page,owner){
 return page.evaluate(async owner=>{
  const saved=window.__mwMessageClipboard?.get(owner);
  if(!saved)throw Error('本轮剪贴板恢复快照不存在，不能覆盖当前剪贴板');
  if(saved.expected!==null&&(await navigator.clipboard.readText())!==saved.expected){
   // A later user copy takes precedence over this test's original clipboard.
   window.__mwMessageClipboard.delete(owner);return {restored:false,reason:'剪贴板已有其他内容，保留当前内容'};
  }
  if(saved.expected!==null){
   if(saved.original.length)await navigator.clipboard.write(saved.original.map(data=>new ClipboardItem(data)));
   else await navigator.clipboard.writeText('');
  }
  window.__mwMessageClipboard.delete(owner);return {restored:true};
 },owner);
}
