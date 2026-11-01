// Read only CDP Network events. Request bodies stay in process memory; only
// this run's expected setting matches are retained, never headers or full system.
export function promptSettingFact(event,{tone,instruction}){
 const match=new URL(event.request.url).pathname.match(/\/session\/(ses_[A-Za-z0-9]+)\/prompt_async$/);if(event.request.method!=='POST'||!match||!event.request.postData)return null;
 const body=JSON.parse(event.request.postData),system=typeof body.system==='string'?body.system:'';
 return {sessionId:match[1],at:Date.now(),toneMatched:tone?system.includes(tone):null,instructionMatched:instruction?system.includes('用户长期偏好：\n'+instruction):null};
}
export async function observePromptSettings(page,expected){
 const session=await page.context().newCDPSession(page),facts=[];let error;
 const listener=event=>{try{const fact=promptSettingFact(event,expected);if(fact)facts.push(fact);}catch(e){error=e;}};
 session.on('Network.requestWillBeSent',listener);
 try{await session.send('Network.enable',{maxPostDataSize:1048576});}catch(error){await session.detach();throw error;}
 return {read:sessionId=>{if(error)throw error;return facts.filter(f=>f.sessionId===sessionId);},close:async()=>{session.off('Network.requestWillBeSent',listener);await session.detach();}};
}
