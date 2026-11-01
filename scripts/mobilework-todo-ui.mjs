const panelOf=page=>page.getByTestId('session-workbench-panel');

// Read the product's cards and badges, never a model's prose describing them.
export async function readTodoPanel(page){
 return panelOf(page).evaluate(panel=>({
  filter:panel.querySelector('button[aria-label="筛选待办"]')?.textContent.trim(),
  counts:[...panel.querySelectorAll('div.flex.flex-wrap.gap-3 > span')].map(element=>element.textContent.trim()),
  cards:[...panel.querySelectorAll('div.overflow-y-auto.overscroll-y-contain > div')].map(card=>({content:card.querySelector('div.break-words')?.textContent.trim(),status:card.querySelector('span.mt-2')?.textContent.trim()})).filter(card=>card.content),
  text:panel.innerText
 }));
}

export async function selectTodoFilter(page,label){
 const trigger=panelOf(page).getByRole('button',{name:'筛选待办',exact:true});
 if((await trigger.innerText()).trim()===label)return;
 const url=page.url();
 await trigger.click();
 try{await page.getByRole('menuitem',{name:label,exact:true}).filter({visible:true}).click();}
 finally{if(page.url()===url&&await trigger.getAttribute('aria-expanded')==='true')await page.keyboard.press('Escape');}
 await page.waitForFunction(label=>document.querySelector('[data-testid="session-workbench-panel"] button[aria-label="筛选待办"]')?.textContent.trim()===label,label);
 await page.waitForFunction(()=>document.querySelector('[data-testid="session-workbench-panel"] button[aria-label="筛选待办"]')?.getAttribute('aria-expanded')!=='true');
}

export async function startTodoObservation(page,owner){
 await page.evaluate(owner=>{
  if(window.__MW_TODO_OBSERVATION__)throw Error('当前页面已有未收尾的待办观察');
  const state={owner,url:location.href,samples:[]};
  const sample=()=>{
   const panel=document.querySelector('[data-testid="session-workbench-panel"]'),filter=panel?.querySelector('button[aria-label="筛选待办"]');
   if(!filter||!panel.getBoundingClientRect().height)return;
   const value={at:Date.now(),url:location.href,filter:filter.textContent.trim(),counts:[...panel.querySelectorAll('div.flex.flex-wrap.gap-3 > span')].map(element=>element.textContent.trim()),cards:[...panel.querySelectorAll('div.overflow-y-auto.overscroll-y-contain > div')].map(card=>({content:card.querySelector('div.break-words')?.textContent.trim(),status:card.querySelector('span.mt-2')?.textContent.trim()})).filter(card=>card.content)};
   const previous=state.samples.at(-1);
   if(!previous||JSON.stringify([previous.url,previous.filter,previous.counts,previous.cards])!==JSON.stringify([value.url,value.filter,value.counts,value.cards]))state.samples.push(value);
  };
  state.timer=setInterval(sample,100);state.sample=sample;window.__MW_TODO_OBSERVATION__=state;sample();
 },owner);
}

export async function stopTodoObservation(page,owner){
 return page.evaluate(owner=>{
  const state=window.__MW_TODO_OBSERVATION__;
  if(!state)return null;
  if(state.owner!==owner)throw Error('待办观察归属不一致，未停止其他观察');
  state.sample();clearInterval(state.timer);delete window.__MW_TODO_OBSERVATION__;
  return {samples:state.samples};
 },owner);
}
