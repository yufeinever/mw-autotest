// Keep the list DOM alive: returning never reloads configuration or CDP status.
import {clientCases,caseWorkbook,caseSheet} from '../scripts/client-case-catalog.mjs';
import {renderRecordingTimeline} from './recording-timeline.mjs';

const normalizedPath=value=>{
 const parts=[];
 for(const part of String(value||'').replaceAll('\\','/').split('/')){
  if(!part||part==='.')continue;
  if(part==='..')parts.pop();else parts.push(part.toLowerCase());
 }
 return parts.join('/');
};
export function findScriptCase(script,projectRoot){
 if(!projectRoot||!script?.path)return null;
 return clientCases.find(item=>normalizedPath(projectRoot+'/'+item.entry)===normalizedPath(script.path))||null;
}
export function installDetailPreview(readCase,canPreview=()=>true,recordingActions={}){
 if(window.top!==window)return {openScript:()=>{},openRecording:()=>{}};
 const dialog=document.createElement('dialog');dialog.className='detail-preview';
 dialog.setAttribute('aria-label','详情预览');
 const bar=document.createElement('div');bar.className='detail-preview-bar';
 const back=document.createElement('button'),title=document.createElement('strong'),close=document.createElement('button');
 back.textContent='← 返回';close.textContent='关闭 · 返回列表';bar.append(back,title,close);
 const body=document.createElement('div');body.className='detail-preview-body';dialog.append(bar,body);document.body.append(dialog);
 let current=null,generation=0,anchor=null,scrollY=0;
 const previewUrl=href=>{
  const u=new URL(href,location.href);
  return u.origin===location.origin&&(/^\/reports\/[\w-]+$/.test(u.pathname)||/^\/traces\/[\w-]+$/.test(u.pathname)||(u.pathname==='/'&&(u.searchParams.has('trace')||u.searchParams.has('batch'))))?u.pathname+u.search:null;
 };
 function closeToList(){const depth=history.state?.mwPreview?.depth;if(depth)history.go(-depth);else hide();}
 function clearBody(){for(const nested of body.querySelectorAll('dialog[open]'))nested.close();for(const video of body.querySelectorAll('video')){video.pause();video.removeAttribute('src');video.load();}body.replaceChildren();}
 function hide(){generation++;current=null;clearBody();if(dialog.open)dialog.close();window.scrollTo(0,scrollY);if(anchor?.isConnected)anchor.focus({preventScroll:true});}
 function intercept(event){
  if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  const a=event.target.closest('a[href]');if(!a||a.hasAttribute('download')||a.target==='_blank')return;
  const href=new URL(a.href,location.href),target=previewUrl(href.href);
  if(target&&canPreview()){event.preventDefault();open({kind:'page',url:target,title:a.textContent.trim()||'详情'});}
  else if(current&&href.origin===location.origin&&href.pathname==='/'&&!href.search){event.preventDefault();closeToList();}
 }
 async function show(entry){
  const request=++generation;current=entry;title.textContent=entry.title;
  clearBody();if(!dialog.open){anchor=document.activeElement;scrollY=window.scrollY;dialog.showModal();}
  if(entry.kind==='recording'){
   const content=document.createElement('article');content.className='recording-preview';
   const heading=document.createElement('h2');heading.textContent=entry.title;
   const meta=document.createElement('p'),recording=entry.recording||{},config=recording.config||{};
   meta.textContent=[config.resolution?.replace('x',' × '),config.fps?config.fps+' 帧/秒':null,config.bitrateKbps?config.bitrateKbps+' kbps':null,Number.isFinite(recording.durationSeconds)?recording.durationSeconds.toFixed(2)+' 秒':null,Number.isFinite(recording.bytes)?(recording.bytes/1e6).toFixed(2)+' MB':null].filter(Boolean).join(' · ');
   const video=document.createElement('video');video.controls=true;video.preload='metadata';video.setAttribute('aria-label','执行录像');video.src='/recordings/'+encodeURIComponent(entry.id);
   const download=document.createElement('a');download.textContent='下载录像（MP4）';download.href=video.src+'/download';download.setAttribute('download','');
   const error=document.createElement('p');error.className='error';error.hidden=true;
   video.addEventListener('error',()=>{error.hidden=false;error.textContent='录像加载失败，请尝试下载或在截图报告中核对录像状态。';});
   const actions=document.createElement('div');actions.className='recording-actions';
   const openFolder=document.createElement('button');openFolder.textContent='打开所在文件夹';openFolder.disabled=true;actions.append(download,openFolder);
   const paths=document.createElement('div');paths.className='recording-locations';
   const folderMessage=document.createElement('p');folderMessage.className='hint';folderMessage.textContent='正在读取本地保存位置…';folderMessage.setAttribute('role','status');
   const timeline=document.createElement('div');
   content.append(heading,meta,video,error,timeline,actions,paths,folderMessage);body.append(content);
   const loadTimeline=async()=>{
    try{
     const data=Array.isArray(entry.evidence)?{recording:entry.recording,evidence:entry.evidence}:await recordingActions.readEvidence(entry.id);
     if(request===generation)renderRecordingTimeline(timeline,{video,jobId:entry.id,recording:data.recording,evidence:data.evidence});
    }catch(e){if(request===generation){timeline.className='recording-timeline';timeline.textContent='关键截图读取失败：'+e.message;}}
   };
   void loadTimeline();
   const openLocation=async(button,key)=>{
    button.disabled=true;folderMessage.textContent='正在打开文件夹…';
    try{const result=await recordingActions.openFolder(entry.id,key);if(request===generation)folderMessage.textContent=result.message;}
    catch(e){if(request===generation)folderMessage.textContent='打开失败：'+e.message;}
    finally{if(request===generation)button.disabled=false;}
   };
   try{
    const info=await recordingActions.readLocations(entry.id);if(request!==generation)return;
    const primary=info.locations.find(item=>item.key==='primary');
    openFolder.disabled=!primary?.directoryExists;openFolder.onclick=()=>openLocation(openFolder,'primary');
    for(const item of info.locations){
     const row=document.createElement('div'),label=document.createElement('strong'),text=document.createElement('code');
     label.textContent=item.label+(item.exists?'':'（录像已删除或未保存）');text.textContent=item.file;row.append(label,text);
     if(item.key!=='primary'){const link=document.createElement('button');link.textContent='打开历史副本文件夹';link.onclick=()=>openLocation(link,item.key);row.append(link);}
     paths.append(row);
    }
    folderMessage.textContent=info.locations.length>1?'这条历史录像还有报告副本，释放全部空间需分别清理两处MP4；请保留报告和日志文件。':info.legacy?'此旧版目录含运行资料，请只删除MP4，保留报告和日志文件。':'本次录像只保存一份，报告和播放器共用此文件。可手动删除MP4，报告和日志保留。';
    if(primary&&!primary.exists){video.hidden=true;video.removeAttribute('src');video.load();download.hidden=true;error.hidden=false;error.textContent='录像文件已被移动或删除，报告和日志仍保留。';}
   }catch(e){if(request===generation)folderMessage.textContent='保存位置读取失败：'+e.message;}
   return;
  }
  if(entry.kind==='case'||entry.kind==='source'){
   const description=document.createElement('article');description.className='case-description';body.append(description);
   try{
    const data=await readCase(entry.id);if(request!==generation)return;
    if(!data){description.textContent='此脚本尚未关联用例描述。当前支持项目内置的前16条用例。';return;}
    const heading=document.createElement('h2');heading.textContent=data.title;description.append(heading);
    const fields=[['用例编号',data.id],['场景入口',data.category+' → '+data.button],['验证目的','验证场景入口自动填充提示词和预期技能，并完成独立会话，检查本会话回复、产物及实际 Skill 调用。'],['操作步骤','1. 新建独立会话，进入上述场景。\n2. 检查自动填充的提示词及技能选择。\n3. 发送脚本内置测试素材，按执行参数处理选项与审批弹框。\n4. 等待任务结束，检查业务结果并保存截图、日志、Trace和报告。'],['入口自动填充提示词',data.prompt],['预期 Skill',data.skills.length?data.skills.join('、'):'本用例未指定固定 Skill'],['用例来源',caseWorkbook+'\n第二张工作表：'+caseSheet+' · 第 '+data.row+' 行'],['脚本入口',data.entry]];
    if(data.note)fields.push(['差异说明',data.note]);
    const note=document.createElement('p');note.className='hint';note.textContent='根据当前脚本用例定义展示；入口提示词不含执行时追加的测试素材，不代表原表全文或某次执行结果。';description.append(note);
    const list=document.createElement('dl');
    for(const [label,value] of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;list.append(dt,dd);}
    description.append(list);
   }catch(e){if(request===generation)description.textContent='读取失败：'+e.message;}
   return;
  }
  const frame=document.createElement('iframe');frame.title=entry.title;body.append(frame);
  // Replace iframe history; only the outer preview owns navigation entries.
  frame.addEventListener('load',()=>{
   if(request!==generation)return;
   try{frame.contentDocument.addEventListener('click',intercept);}catch{}
  });
  frame.contentWindow.location.replace(entry.url);
 }
 function open(entry){
  const depth=(history.state?.mwPreview?.depth||0)+1;
  history.pushState({...history.state,mwPreview:{...entry,depth}},'',location.href);
  show({...entry,depth});
 }
 back.onclick=()=>history.back();close.onclick=closeToList;
 dialog.addEventListener('cancel',event=>{event.preventDefault();closeToList();});
 window.addEventListener('popstate',()=>{const entry=history.state?.mwPreview;if(entry)show(entry);else hide();});
 document.addEventListener('click',intercept);
 if(history.state?.mwPreview)show(history.state.mwPreview);
 return {openScript(script){open({kind:'case',id:script.id,title:script.name+' · 用例描述'});},openRecording(job){if(job.recording?.available)open({kind:'recording',id:job.id,title:job.name+' · 执行录像',recording:job.recording,evidence:job.result?.evidence||[]});}};
}
