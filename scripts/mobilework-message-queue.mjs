import {queuedRow} from './mobilework-composer-resources.mjs';
const review=message=>Object.assign(Error(message),{review:true});
export const sessionMessageText=message=>(message.parts||[]).filter(part=>part.type==='text').map(part=>part.text||'').join('\n');

export async function queueMessage(context,text){
 const {page,control,resources,fill,markDraftSent,checkpointResources,getSessionId}=context;
 await control.acquire(page,'INTERACTING');
 if((await control.get('/session/status'))[getSessionId()]?.type!=='busy')throw review('前轮已完成，不能把新消息冒充执行中排队');
 await fill(text);resources.queueTexts.push(text);await checkpointResources();
 if((await control.get('/session/status'))[getSessionId()]?.type!=='busy')throw review('填写期间前轮已完成，未验证排队分支');
 const before=await control.readLog();
 await page.getByRole('button',{name:'发送并加入排队',exact:true}).click();
 await markDraftSent();
 const row=queuedRow(page,text);await row.waitFor();
 return {row,before};
}

export async function interveneQueued(context,text){
 const {page,control,getSessionId}=context;
 if((await control.get('/session/status'))[getSessionId()]?.type!=='busy')throw review('点击人工介入前原任务已结束，未取得中止分支');
 const boundary=(await control.readLog()).messages.at(-1).info.id;
 await queuedRow(page,text).getByRole('button',{name:'人工介入',exact:true}).click();
 return boundary;
}
