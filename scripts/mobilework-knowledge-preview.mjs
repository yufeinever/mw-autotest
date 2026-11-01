const blocked=message=>Object.assign(Error(message),{blocked:true});

// Current app-DqjcqLuT.js: sos.knowledgeBase.id -> a6r -> l6r.panel.
// Portal dialogs retain this React ancestry. Read committed props only;
// the sole mutation is the same test-only DOM ownership tag used elsewhere.
function inspectPreview({knowledgeId,wikiId,token,tag=false,waitFor=null}){
 const shown=node=>node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
 const committedPath=node=>{
  const host=node[Object.keys(node).find(key=>key.startsWith('__reactFiber$'))],pending=[host,host?.alternate].filter(Boolean).map(fiber=>[fiber]),seen=new Set();
  while(pending.length){
   const chain=pending.shift(),fiber=chain.at(-1);if(seen.has(fiber))continue;seen.add(fiber);
   if(fiber.tag===3){if(fiber.stateNode.current===fiber)return chain;continue;}
   for(const parent of [fiber.return,fiber.return?.alternate]){
    if(!parent)continue;let child=parent.child;while(child&&child!==fiber)child=child.sibling;
    if(child===fiber)pending.push([...chain,parent]);
   }
  }
  return null;
 };
 if(location.hash.split('?')[0]!=='#/knowledge')return {error:'Wiki预览收尾已离开本轮知识模块，保留现场'};
 const owners=new Set([...document.querySelectorAll('.mw-knowledge-workspace')].filter(shown).map(node=>committedPath(node)?.find(fiber=>fiber.type?.name==='sos')).filter(Boolean));
 if(owners.size!==1)return {error:'无法唯一确认当前知识库组件，保留Wiki预览归属'};
 const owner=[...owners][0],actualId=owner.memoizedProps.knowledgeBase?.id;
 if(actualId!==knowledgeId)return {error:'当前知识库ID与本轮不符，未关闭其他知识库窗口'};
 const panels=[],pending=[owner];
 while(pending.length){
  const fiber=pending.pop();if(fiber.type?.name==='l6r')panels.push(fiber);
  for(let child=fiber.child;child;child=child.sibling)pending.push(child);
 }
 if(panels.length!==1)return {error:'无法唯一确认本轮知识卡片预览组件，保留现场'};
 const panelFiber=panels[0],panel=panelFiber.memoizedProps.panel;
 if(panel.previewWikiId!==null&&panel.previewWikiId!==wikiId)return {error:'当前预览Wiki ID与本轮不符，未关闭未知Wiki'};
 const dialogs=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(shown),matches=[];
 for(const dialog of dialogs){
  const chain=committedPath(dialog);
  if(chain?.find(fiber=>fiber.type?.name==='l6r')!==panelFiber||chain?.find(fiber=>fiber.type?.name==='sos')!==owner)return {error:'存在非本轮Wiki预览弹框，保留现场'};
  const existing=dialog.getAttribute('data-mw-knowledge-preview-owner');
  if(existing&&existing!==token)return {error:'Wiki预览DOM已有其他归属，未覆盖'};
  matches.push(dialog);
 }
 if(matches.length>1)return {error:'Wiki预览弹框不唯一，保留现场'};
 let status=panel.previewWikiId===null?(matches.length?'closing':'closed'):(matches.length?'open':'opening');
 if(status==='open'){
  if(panel.wikiPreview&&panel.wikiPreview.id!==wikiId)return {error:'已加载Wiki正文ID与本轮预览不符，保留现场'};
  if(tag)matches[0].setAttribute('data-mw-knowledge-preview-owner',token);
 }
 const value={knowledgeId:actualId,previewWikiId:panel.previewWikiId,status,loading:panel.wikiPreviewLoading,error:panel.wikiPreviewError??null,loadedWikiId:panel.wikiPreview?.id??null};
 if(waitFor&&status!==waitFor)return false;
 return value;
}

export async function observeOwnedKnowledgePreview(page,owned,{waitFor=null,tag=false}={}){
 const input={knowledgeId:owned.id,wikiId:owned.previewWikiId,token:owned.previewToken,waitFor,tag};
 let state;
 if(waitFor){const handle=await page.waitForFunction(inspectPreview,input,{timeout:15000});try{state=await handle.jsonValue();}finally{await handle.dispose();}}
 else state=await page.evaluate(inspectPreview,input);
 if(state.error&&state.status===undefined)throw blocked(state.error);
 return state;
}

export async function dismissOwnedKnowledgePreview(page,owned){
 if(!owned.previewWikiId&&!owned.previewToken)return;
 if(!owned.id||!owned.previewWikiId||!owned.previewToken)throw blocked('Wiki预览缺少本轮库ID/Wiki ID/token，未使用标题接管');
 let state=await observeOwnedKnowledgePreview(page,owned,{tag:true});
 if(state.status==='opening')state=await observeOwnedKnowledgePreview(page,owned,{waitFor:'open',tag:true});
 if(state.status==='open'){
  // Recheck the committed library/Wiki identity immediately before Escape;
  // retained DOM tags alone do not authorize closing a reused dialog.
  await observeOwnedKnowledgePreview(page,owned,{waitFor:'open',tag:true});
  const dialog=page.locator('[data-mw-knowledge-preview-owner="'+owned.previewToken+'"]');
  await dialog.press('Escape');
 }
 if(state.status!=='closed')await observeOwnedKnowledgePreview(page,owned,{waitFor:'closed'});
 await page.locator('[data-mw-knowledge-preview-owner="'+owned.previewToken+'"]').evaluateAll(nodes=>nodes.forEach(node=>node.removeAttribute('data-mw-knowledge-preview-owner')));
 delete owned.previewWikiId;delete owned.previewToken;delete owned.previewTitle;
}
