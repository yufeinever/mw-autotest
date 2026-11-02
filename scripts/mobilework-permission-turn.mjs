export class PermissionTurn {
 constructor(timeoutMs){
  this.timeoutMs=timeoutMs;
  this.active=null;
  this.unassignedSince=null;
  this.previousKeys=new Set();
 }

 confirmedClick(key,now=Date.now()){
  if(this.active?.key===key)this.active.since=now;
 }

 update(permissions,identity,now=Date.now()){
  const keys=new Set(permissions.map(item=>item.key));
  const resolved=[...this.previousKeys].some(key=>!keys.has(key));
  this.previousKeys=keys;
  if(this.active&&!keys.has(this.active.key)){
   this.active=null;
   this.unassignedSince=keys.size?now:null;
  }
  if(this.active){
   if(now-this.active.since>=this.timeoutMs)return {blocked:this.active.key,reason:'active-timeout'};
   const selected=permissions.find(item=>item.key===this.active.key);
   return {selected:identity?.id===selected.id&&identity?.sessionID===selected.sessionID?selected:null};
  }
  if(!permissions.length){this.unassignedSince=null;return {selected:null};}
  const matches=identity?permissions.filter(item=>item.id===identity.id&&item.sessionID===identity.sessionID):[];
  if(matches.length===1){
   this.active={key:matches[0].key,since:now};
   this.unassignedSince=null;
   return {selected:matches[0]};
  }
  if(this.unassignedSince===null||resolved)this.unassignedSince=now;
  if(now-this.unassignedSince>=this.timeoutMs)return {blocked:null,reason:'unidentified-timeout'};
  return {selected:null};
 }
}
