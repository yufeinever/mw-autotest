import {waitStep} from './mobilework-run-policy.mjs';
// Append through the browser's real text input path. Enter is a submit shortcut
// in MobileWork and must not be used to create a paragraph before insertion.
// Chromium may expose an empty contenteditable paragraph as extra newlines.
// Ignore only repeated blank lines; preserve every other character and its order.
export function containsComposerText(actual,expected){
 const normalize=s=>s.replace(/\r\n/g,'\n').replace(/\n{2,}/g,'\n').trim();
 return normalize(actual).includes(normalize(expected));
}
export const normalizeComposerText=s=>s.replace(/\r\n/g,'\n').replace(/\n{2,}/g,'\n').trim();
export async function readComposerState(editor){
 return editor.evaluate(element=>{
  // Read semantic editor content. Skill icons and remove buttons change on
  // hover; they are presentation, not prompt text or skill identity.
  const walk=node=>{
   if(node.nodeType===3)return node.textContent;
   if(node.nodeType!==1)return '';
   if(node.matches('[data-skill-chip-icon],button,svg,img'))return '';
   if(node.tagName==='BR')return '\n';
   const text=[...node.childNodes].map(walk).join('');
   return /^(P|DIV|LI)$/.test(node.tagName)?text+'\n':text;
  };
  return {text:[...element.childNodes].map(walk).join('').replace(/\r\n/g,'\n').replace(/\n{2,}/g,'\n').trim(),skills:[...element.querySelectorAll('[data-skill-remove]')].map(e=>e.getAttribute('data-skill-remove'))};
 });
}
export async function appendComposerText(editor,text,{onDraft=async()=>{},stepInterval=0.5}={}){
 if(typeof text!=='string'||!text.trim())throw Error('补充材料不能为空');
 await editor.waitFor({state:'visible',timeout:10000});
 if(await editor.count()!==1)throw Error('没有唯一的任务输入框');
 const page=editor.page(),url=page.url();
 const before=await readComposerState(editor);
 // Record the intended state BEFORE mutation, including when insertText or
 // validation throws. Never claim arbitrary observed text after an error.
 await onDraft({text:normalizeComposerText(before.text+'\n\n'+text),skills:before.skills});
 await editor.evaluate(element=>{
  element.focus();
  const range=document.createRange();range.selectNodeContents(element);range.collapse(false);
  const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
 });
 await waitStep(page,{stepInterval});
 await page.keyboard.insertText('\n\n'+text);
 if(page.url()!==url)throw Error('补充材料期间页面发生切换，未点击发送');
 const after=await readComposerState(editor);
 if(!containsComposerText(after.text,text))throw Error('输入框没有保留完整补充材料，未点击发送');
 if(!containsComposerText(after.text,before.text)||JSON.stringify(after.skills)!==JSON.stringify(before.skills))throw Error('补充材料改变了自动填充的提示词或技能，未点击发送');
 if(normalizeComposerText(after.text)!==normalizeComposerText(before.text+'\n\n'+text))throw Error('追加期间出现非本次预期的文字变化，保留现场，未点击发送');
 return after;
}
export async function clearComposerText(editor,{stepInterval=0.5}={}){
 await editor.waitFor({state:'visible',timeout:10000});
 if(await editor.count()!==1)throw Error('没有唯一的任务输入框，未清理草稿');
 const pause=()=>waitStep(editor.page(),{stepInterval});
 await pause();await editor.click();
 if(!await editor.evaluate(element=>document.activeElement===element))throw Error('输入框未获得焦点，未清理草稿');
 await pause();await editor.page().keyboard.press('ControlOrMeta+A');
 await pause();await editor.page().keyboard.press('Backspace');
 await pause();
 if((await editor.innerText()).trim()||await editor.locator('[data-skill-remove]').count())throw Error('客户端尚未清空本次草稿，保留现场');
}
