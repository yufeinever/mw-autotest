import {snapshotDraft,clearOwnedDraft} from './mobilework-isolation.mjs';
import {normalizeComposerText} from './mobilework-composer.mjs';

const createPrompt='请帮我创建一个可以实现「……」的 skill';
export function validateModuleHandoff(navigation,previous){
 const value=navigation.handoff;
 if(previous){
  const baseline=previous.handoff?.kind==='expert'&&!Object.hasOwn(previous.handoff,'expectedText')&&typeof value?.expectedText==='string'?{...previous,handoff:{...previous.handoff,expectedText:value.expectedText}}:previous;
  if(JSON.stringify(baseline)!==JSON.stringify(navigation))throw Error('不能替换本轮模块入口归属');
 }
 if(!value)return;
 if(!['skill-trial','skill-create','expert'].includes(value.kind)||typeof value.value!=='string'||!value.value||navigation.originUrl.split('/workspace/')[1]?.split('/')[0]!==value.workspaceId||Object.keys(value).some(k=>!['kind','value','workspaceId','expectedText'].includes(k))||Object.hasOwn(value,'expectedText')&&(value.kind!=='expert'||typeof value.expectedText!=='string'))throw Error('模块任务交接归属无效');
}

export async function inspectModuleHandoff(page,resources){
 const navigation=resources.moduleNavigation,value=navigation?.handoff;
 if(!value)return null;
 const current=new URL(page.url()),origin=new URL(navigation.originUrl);
 if(!['#/session','#/workspace/'+value.workspaceId+'/session'].includes(current.hash))return null;
 if(current.origin!==origin.origin||current.pathname!==origin.pathname)throw Error('模块交接离开本轮客户端');
 const workspace=await page.evaluate(()=>localStorage.getItem('openwork.react.newTaskDraftWorkspace'));
 if(workspace!==value.workspaceId)throw Error('模块交接实际工作空间与本轮不符');
 const draft=await snapshotDraft(page),text=normalizeComposerText(draft.text);
 const skills=value.kind==='expert'?[]:[value.value];
 if(value.kind==='expert'&&typeof value.expectedText!=='string')throw Error('专家召唤前尚未登记真实预填依据，保留草稿');
 const expected=normalizeComposerText(value.kind==='expert'?value.expectedText:value.kind==='skill-create'?createPrompt:'');
 const actual=text;
 const selected=value.kind==='expert'?draft.selection.length===1&&draft.selection[0].exit==='退出「'+value.value+'」':draft.selection.length===0;
 if(actual!==expected||JSON.stringify(draft.skills)!==JSON.stringify(skills)||!selected)throw Error('模块交接草稿与登记目标不符，保留未知输入或选择');
 return draft;
}

export async function clearModuleHandoff(page,resources){
 const draft=await inspectModuleHandoff(page,resources);
 if(!draft)return false;
 if(!await clearOwnedDraft(page,draft))throw Error('本轮模块交接草稿清理未确认');
 return true;
}
