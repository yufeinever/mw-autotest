import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const diskScanCode=fs.readFileSync(new URL('fixtures/efficiency/disk-scan-reference.py',import.meta.url),'utf8');
export function timerSeconds(value){
 const match=value.match(/^(\d{2}):(\d{2})$/);if(!match||Number(match[2])>59)throw Error('实际番茄钟时间格式无效');return Number(match[1])*60+Number(match[2]);
}
export function timerProgress(before,after,elapsedMs){return before>=after&&Math.abs((before-after)*1000-elapsedMs)<=1500;}
export function diskFormat(bytes){return bytes>=1024**4?(bytes/1024**4).toFixed(1)+' TB':(bytes/1024**3).toFixed(1)+' GB';}
export function diskChecks(data,before,after,{toleranceBytes=64*1024**2}={}){
 const expected=before.map(d=>d.drive).sort(),actual=data.drives.map(d=>d.drive).sort();
 return {allDrives:JSON.stringify(actual)===JSON.stringify(expected),drives:data.drives.map(d=>{
  const a=before.find(x=>x.drive===d.drive),b=after.find(x=>x.drive===d.drive);
  return {drive:d.drive,capacity:!!a&&!!b&&d.total===a.total&&d.total===b.total,arithmetic:d.free+d.used===d.total&&Math.abs(d.used_pct-d.used/d.total*100)<=0.051,free:!!a&&!!b&&d.free>=Math.min(a.free,b.free)-toleranceBytes&&d.free<=Math.max(a.free,b.free)+toleranceBytes};
 }),toleranceBytes};
}
export async function systemDisks(){
 const run=promisify(execFile),{stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-File',fs.realpathSync(new URL('mobilework-disk-observation.ps1',import.meta.url))],{windowsHide:true,encoding:'utf8'});return JSON.parse(stdout.replace(/^\uFEFF/,''));
}
export function naturalWeek(now=new Date()){
 const monday=new Date(now.getFullYear(),now.getMonth(),now.getDate());monday.setDate(monday.getDate()-(monday.getDay()+6)%7);
 const key=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'),dates=Array.from({length:7},(_,i)=>key(new Date(monday.getFullYear(),monday.getMonth(),monday.getDate()+i)));
 const thursday=new Date(monday);thursday.setDate(thursday.getDate()+3);const year=thursday.getFullYear(),first=new Date(year,0,4);first.setDate(first.getDate()-(first.getDay()+6)%7);
 return {dates,todayIndex:(now.getDay()+6)%7,week:year+'-W'+String(Math.round((monday-first)/(7*86400000))+1).padStart(2,'0')};
}
