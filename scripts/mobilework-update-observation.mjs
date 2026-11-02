// Keep updater events for one run without recording package paths or URLs.
export async function startUpdateObservation(page, owner, {snapshotOnly=false}={}) {
 return page.evaluate(async ({owner,snapshotOnly}) => {
  if (window.__MW_UPDATE_OBSERVER__) throw Error('已有未结束的更新观察');
  const updater=(window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__)?.autoUpdate;
  if (!updater?.getState||!updater?.onState) throw Error('客户端未提供更新状态订阅');
  const project=(value,kind)=>({
   kind,at:Date.now(),state:value?.state??null,checkSource:value?.checkSource??null,
   currentVersionCode:value?.currentVersionCode??null,currentProductVersion:value?.currentProductVersion??null,
   targetVersionCode:value?.targetVersionCode??null,targetProductVersion:value?.targetProductVersion??null,
   force:value?.force===true,forceSource:value?.forceSource??null,
   packageSize:value?.packageSize??null,packageMd5:value?.packageMd5??null,
   progress:value?.progress?{received:value.progress.received,total:value.progress.total}:null,
   error:value?.error?.failReason&&/^[a-z0-9-]+$/.test(value.error.failReason)?{failReason:value.error.failReason}:null,
  });
  const observation={owner,samples:[],unsubscribe:null};
  observation.unsubscribe=updater.onState(value=>observation.samples.push(project(value,'event')));
  window.__MW_UPDATE_OBSERVER__=observation;
  let ready=false;
  try {
   observation.samples.push(project(await updater.getState(),'baseline'));
   ready=true;
   return snapshotOnly?observation.samples:null;
  } finally {
   if(snapshotOnly||!ready){observation.unsubscribe();delete window.__MW_UPDATE_OBSERVER__;}
  }
 },{owner,snapshotOnly});
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
