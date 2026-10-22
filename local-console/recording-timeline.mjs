const timestamp=value=>typeof value==='string'&&value?Date.parse(value):NaN;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const clock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function recordingTime(seconds){
 const value=Math.max(0,Math.floor(seconds)),h=Math.floor(value/3600),m=Math.floor(value/60)%60,s=value%60;
 return (h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
export function recordingMarks(recording,evidence,mediaDuration){
 const start=timestamp(recording?.startedAt),duration=positive(mediaDuration)?mediaDuration:positive(recording?.durationSeconds)?recording.durationSeconds:null;
 return (Array.isArray(evidence)?evidence:[]).filter(item=>typeof item?.screenshot==='string'&&item.screenshot).map((item,index)=>{
  const at=timestamp(item.time),offset=(at-start)/1000;
  const reason=!Number.isFinite(at)?'截图未记录有效时间':!Number.isFinite(start)?'缺少录像开始时间':duration===null?'尚未取得录像时长':offset<0?'早于录像开始':offset>duration?'超出录像范围':'';
  return {step:item.step||'截图 '+(index+1),screenshot:item.screenshot,time:item.time,clock:Number.isFinite(at)?clock.format(at):'时间未记录',offsetSeconds:Number.isFinite(offset)?offset:null,label:Number.isFinite(offset)&&offset>=0?recordingTime(offset):'—',reason};
 });
}
export function renderRecordingTimeline(container,{video,jobId,recording,evidence}){
 container.className='recording-timeline';
 const heading=document.createElement('h3');heading.textContent='关键截图定位';
 const hint=document.createElement('p');hint.className='hint';hint.textContent='点击时间跳转并暂停，方便对照截图。按截图记录时间定位，采集可能存在少量延迟。';
 const list=document.createElement('ol'),message=document.createElement('p');message.className='hint';message.setAttribute('role','status');
 container.replaceChildren(heading,hint,list,message);
 let entries=[];
 function highlight(){
  let active=-1;
  for(let i=0;i<entries.length;i++)if(!entries[i].button.disabled&&entries[i].mark.offsetSeconds<=video.currentTime+0.001&&(active<0||entries[i].mark.offsetSeconds>=entries[active].mark.offsetSeconds))active=i;
  entries.forEach((entry,i)=>entry.button.setAttribute('aria-pressed',String(i===active)));
 }
 function render(){
  entries=[];list.replaceChildren();
  const marks=recordingMarks(recording,evidence,video.duration);
  if(!marks.length){message.textContent='本次运行尚无关键截图记录。';return;}
  message.textContent='共 '+marks.length+' 张关键截图 · 截图时间为北京时间';
  for(const mark of marks){
   const row=document.createElement('li'),button=document.createElement('button'),position=document.createElement('span'),step=document.createElement('span'),at=document.createElement('small'),image=document.createElement('a');
   button.className='recording-marker';button.type='button';position.className='marker-position';position.textContent=mark.label;step.className='marker-step';step.textContent=mark.step;
   const loaded=video.readyState>=1&&positive(video.duration);
   at.textContent=mark.clock+(mark.reason?' · '+mark.reason:'');button.append(position,step,at);button.disabled=!!mark.reason||!!video.error||!loaded;
   button.title=mark.reason||(video.error?'录像无法播放':!loaded?'正在加载录像':'跳转到 '+mark.offsetSeconds.toFixed(3)+' 秒并暂停');button.setAttribute('aria-label',(mark.reason?'无法定位：':'跳到录像 '+mark.label+'：')+mark.step);button.setAttribute('aria-pressed','false');
   button.onclick=()=>{
    try{video.pause();video.currentTime=Math.min(mark.offsetSeconds,Math.max(0,video.duration-0.001));highlight();message.textContent='已定位 '+mark.label+' · '+mark.step+'（已暂停）';video.scrollIntoView({block:'nearest',behavior:'smooth'});}
    catch{message.textContent='定位失败，请确认录像已加载且文件未被删除。';}
   };
   image.textContent='查看截图';image.href='/artifacts/'+encodeURIComponent(jobId)+'/'+encodeURIComponent(mark.screenshot);image.target='_blank';image.rel='noopener';image.setAttribute('aria-label','查看截图：'+mark.step);
   row.append(button,image);list.append(row);entries.push({mark,button});
  }
  highlight();
 }
 video.addEventListener('loadedmetadata',render);video.addEventListener('durationchange',render);video.addEventListener('timeupdate',highlight);video.addEventListener('seeked',highlight);video.addEventListener('error',render);
 render();
}
