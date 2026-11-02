// Input rows are consecutive actual renderer samples for one loading element.
export function inspectWelcomeRotation(rows){
 const events=[];
 let previous=null,active=null,faded=false,maxGap=0,missingFade=false;
 for(const row of rows){
  if(previous)maxGap=Math.max(maxGap,row.at-previous.at);
  if(active&&row.opacity<=0.1)faded=true;
  if(row.welcome&&row.opacity>=0.9){
   if(!active||faded||row.welcome!==active.text){
    if(active&&!faded)missingFade=true;
    const event={text:row.welcome,earliest:previous?.at??null,latest:row.at,fadeObserved:Boolean(active&&faded)};
    events.push(event);active=event;faded=false;
   }
  }
  previous=row;
 }
 const intervals=events.slice(1).map((event,index)=>{
  const prior=events[index];
  return {
   previous:prior.text,current:event.text,fadeObserved:event.fadeObserved,
   minMs:event.earliest===null?null:event.earliest-prior.latest,
   maxMs:prior.earliest===null?null:event.latest-prior.earliest
  };
 });
 return {events,intervals,maxGap,missingFade};
}
