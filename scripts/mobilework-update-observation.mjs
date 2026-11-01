// Keep updater events for one run without recording package paths or URLs.
export async function startUpdateObservation(page, owner) {
 await page.evaluate(async owner => {
  if (window.__MW_UPDATE_OBSERVER__) throw Error('已有未结束的更新观察');
  const updater=window.__OPENWORK_ELECTRON__?.autoUpdate;
  if (!updater?.getState||!updater?.onState) throw Error('客户端未提供更新状态订阅');
  const project=(value,kind)=>({
   kind,at:Date.now(),state:value?.state??null,checkSource:value?.checkSource??null,
   currentVersionCode:value?.currentVersionCode??null,currentProductVersion:value?.currentProductVersion??null,
   targetVersionCode:value?.targetVersionCode??null,targetProductVersion:value?.targetProductVersion??null,
   force:value?.force===true,packageSize:value?.packageSize??null,packageMd5:value?.packageMd5??null,
   progress:value?.progress?{received:value.progress.received,total:value.progress.total}:null,
  });
  const observation={owner,samples:[],unsubscribe:null};
  observation.unsubscribe=updater.onState(value=>observation.samples.push(project(value,'event')));
  window.__MW_UPDATE_OBSERVER__=observation;
  try {observation.samples.push(project(await updater.getState(),'baseline'));}
  catch (error) {observation.unsubscribe();delete window.__MW_UPDATE_OBSERVER__;throw error;}
 },owner);
}

export async function readUpdateObservation(page, owner) {
 return page.evaluate(owner=>{
  const observation=window.__MW_UPDATE_OBSERVER__;
  if (!observation||observation.owner!==owner) throw Error('更新观察归属不一致');
  return observation.samples;
 },owner);
}

export async function stopUpdateObservation(page, owner) {
 return page.evaluate(owner=>{
  const observation=window.__MW_UPDATE_OBSERVER__;
  if (!observation) return null;
  if (observation.owner!==owner) throw Error('更新观察归属不一致，未停止其他观察');
  observation.unsubscribe();delete window.__MW_UPDATE_OBSERVER__;return observation.samples;
 },owner);
}
