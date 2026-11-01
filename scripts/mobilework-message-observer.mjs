// Observe the real renderer. No DOM, network response or product state is changed.
export async function startMessageObservation(page,owner){
 await page.evaluate(owner=>{
  if(window.__MW_MESSAGE_OBSERVER__)throw Error('本页面已有未结束的消息观察');
  const state={owner,startedAt:Date.now(),samples:[],elements:new WeakMap(),sequence:0};
  const sample=()=>{
   const root=document.querySelector('[data-session-messages="true"]:not([aria-hidden="true"])');
   if(!root)return;
   const loading=[...root.querySelectorAll('span')].filter(element=>/^(思考中|正在回复|等待确认|等待中|正在等待|正在生成工具参数)[….]*$/.test(element.textContent.trim())&&element.getBoundingClientRect().height>0);
   const rows=loading.map(element=>{
    if(!state.elements.has(element))state.elements.set(element,++state.sequence);
    const row=element.parentElement,dismiss=[...row.querySelectorAll('button')].find(button=>button.textContent==='不再显示');
    const welcome=dismiss?.parentElement.querySelector('span[aria-hidden="true"]'),text=welcome?.querySelector('span.truncate');
    const separator=welcome?.firstElementChild,rect=separator?.getBoundingClientRect();
    return {id:state.elements.get(element),label:element.textContent,welcome:text?.textContent||'',opacity:welcome?Number(getComputedStyle(welcome).opacity):0,transition:welcome?getComputedStyle(welcome).transitionDuration:'',separator:!!rect&&rect.height>=10&&rect.width<=2,text:row.innerText};
   });
   const groups=[...root.querySelectorAll('.group\\/message-group')];
   const group=groups.at(-1);
   const metrics=group?[...group.querySelectorAll('span')].filter(span=>!span.querySelector('span')&&/^\d+\.\d{2}(万token|t\/s)$/.test(span.textContent)).map(span=>span.textContent):[];
   const live=[...root.querySelectorAll('span')].filter(span=>!span.querySelector('span')&&/^\d+\.\d{2}(万token|t\/s)$/.test(span.textContent)&&!span.closest('.group\\/message-group')).map(span=>span.textContent);
   const value={at:Date.now(),rows,metrics,live};
   const previous=state.samples.at(-1);
   if(!previous||JSON.stringify([previous.rows,previous.metrics,previous.live])!==JSON.stringify([rows,metrics,live]))state.samples.push(value);
  };
  state.timer=setInterval(sample,50);state.sample=sample;window.__MW_MESSAGE_OBSERVER__=state;sample();
 },owner);
}

export async function readMessageObservation(page,{stop=false,owner}={}){
 return page.evaluate(({stop,owner})=>{
  const state=window.__MW_MESSAGE_OBSERVER__;
  if(!state)throw Error('本页面没有本轮消息观察');
  if(state.owner!==owner)throw Error('消息观察归属不一致，未操作其他观察');
  state.sample();
  const value={startedAt:state.startedAt,endedAt:Date.now(),samples:state.samples};
  if(stop){clearInterval(state.timer);delete window.__MW_MESSAGE_OBSERVER__;}
  return value;
 },{stop,owner});
}

export async function stopMessageObservation(page,owner){
 await page.evaluate(owner=>{
  const state=window.__MW_MESSAGE_OBSERVER__;
  if(!state)return;
  if(state.owner!==owner)throw Error('消息观察归属不一致，未停止其他观察');
  clearInterval(state.timer);delete window.__MW_MESSAGE_OBSERVER__;
 },owner);
}
