// Keep the list DOM alive: returning never reloads configuration or CDP status.
import {clientCases,caseWorkbook,caseSheet} from '../scripts/client-case-catalog.mjs';
import {permissionCases} from '../scripts/permission-case-catalog.mjs';
import {publicCases} from '../scripts/public-case-catalog.mjs';
import {scriptEdition} from './script-groups.mjs';
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
 const cases=scriptEdition(script)==='public'?publicCases:[...clientCases,...permissionCases];
 return cases.find(item=>normalizedPath(projectRoot+'/'+item.entry)===normalizedPath(script.path))||null;
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
  const recording=href.origin===location.origin&&href.pathname.match(/^\/recordings\/([\w-]+)$/);
  if(recording&&canPreview()){event.preventDefault();open({kind:'recording',id:recording[1],title:'执行录像'});}
  else if(target&&canPreview()){event.preventDefault();open({kind:'page',url:target,title:a.textContent.trim()||'详情'});}
  else if(current&&href.origin===location.origin&&href.pathname==='/'&&!href.search){event.preventDefault();closeToList();}
 }
 async function show(entry){
  const request=++generation;current=entry;title.textContent=entry.title;
  clearBody();if(!dialog.open){anchor=document.activeElement;scrollY=window.scrollY;dialog.showModal();}
  if(entry.kind==='recording'){
   if(!entry.recording){
    const loading=document.createElement('p');loading.textContent='正在读取录像…';body.append(loading);
    try{
     const data=await recordingActions.readEvidence(entry.id);if(request!==generation)return;
     if(!data.recording?.available)throw Error('本次尚无已保存录像，请返回批次查看录像状态。');
     entry={...entry,...data,title:(data.name||'本次执行')+' · 执行录像'};title.textContent=entry.title;body.replaceChildren();
    }catch(e){if(request===generation){loading.textContent='读取录像失败：'+e.message;loading.className='error';}return;}
   }
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
    if(!data){description.textContent='此脚本尚未关联用例描述。';return;}
    if(data.suite==='permission'){
     const heading=document.createElement('h2');heading.textContent=data.id+' · '+data.title;description.append(heading);
     for(const [label,text]of [['准备',data.unavailable||'通过产品注册表及输入区核对所选空间；由客户端正常创建任务，在首次模型请求发出前按真实Session目录准备本场景材料并保存哈希。仅替换本次请求文本的材料路径，不改权限、模型或工具配置；不强制切换空间，不发送准备闲聊。'],['执行',data.task||'尚不具备自动触发条件，不提交执行。'],['观察与判断','一次提交操作任务，分别记录目标触发、权限问询或拦截、实际操作效果、决策后的会话进展。权限卡固定拒绝；没触发或证据不足待复核。免问询场景真实出现对应确认记过度拦截；不匹配固定模型措辞、Skill或工具路线。'],['期望',data.expectation==='continue'?'实际执行并完成，观察窗口无权限确认':data.expectation==='gate'?'目标请求触发后问询，拒绝后未产生受保护效果；后续执行单独记录':'行为观察；需求口径或材料来源存在差异，记录后复核'],['用例来源',data.source],['脚本',data.entry]]){const h=document.createElement('h3'),p=document.createElement('p');h.textContent=label;p.textContent=text;description.append(h,p);}return;
    }
    const heading=document.createElement('h2');heading.textContent=data.title;description.append(heading);
    if(data.kind==='public-scene'){
     const fields=[['用例编号 / 版别',data.id+' / 公众版'],['需求与版本依据',data.requirement],['设计文档',data.requirementLink],['业务目标参考',data.sourceCaseId+'，仅沿用目标；执行入口、材料及判断独立维护'],['前置条件',data.preconditions],['操作步骤',data.steps.map((step,index)=>(index+1)+'. '+step).join('\n')],['预期行为与判断',data.expected],['预期技能 / 专家',data.skills.length?data.skills.join('、'):data.expert||'不限定'],['验证边界',data.note],['脚本入口',data.entry]];
     const list=document.createElement('dl');for(const [label,value] of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;list.append(dt,dd);}description.append(list);return;
    }
    if(data.kind?.startsWith('interaction-')){
     const fields=[['用例编号',data.id],['功能模块',data.category],['验证目的与边界',data.note],['操作步骤',data.steps.map((step,index)=>(index+1)+'. '+step).join('\n')],['操作与断言依据',data.operations||data.note],['验证状态','执行结果以本次报告及覆盖清单为准，脚本说明不代表已经通过。'],['预期 Skill',data.skills.length?data.skills.join('、'):'不限定固定 Skill 或工具路线'],['用例来源',caseWorkbook+'\n第二张工作表：'+caseSheet+' · 第 '+data.row+' 行'],['脚本入口',data.entry]];
     const list=document.createElement('dl');
     for(const [label,value]of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;list.append(dt,dd);}
     description.append(list);return;
    }
    if(data.kind?.startsWith('config-')){
     const details={
      'config-mode':{
       purpose:'验证首页会话模式的展示、悬停说明、切换和恢复。',
       steps:'1. 展开模式面板。\n2. 悬停执行模式与计划模式，读取行为说明。\n3. 切换另一模式，核对面板关闭和重新打开后的选中状态。\n4. 恢复原模式。',
       assertions:'两个选项及行为说明；目标模式高亮；原模式恢复。',
       scope:'不发送模型请求；切换恢复4项已通过，新增悬停断言待实测。'
      },
      'config-skill':{
       purpose:'按原表验证搜索、悬停、滚动、市场安装及技能chip选择删除。',
       steps:'已编写：记录加载技能名称，验证知识库关键词命中或空结果；检查悬停与滚动；选择技能回读checkbox与chip；点击空白关闭并删除chip。进入市场查找office办公助手，仅安装和卸载本轮新增目标，保留已有安装。',
       assertions:'真实搜索结果、tooltip、末项可见、checkbox与chip状态、草稿清理；安装需独立证据。',
       scope:'部分覆盖；搜索分支已修，市场安装已接入后台归属及统一强停恢复，尚待实测。目标在已加载候选中未找到时明确列缺口。'
      },
      'config-expert':{
       purpose:'按原表验证专家搜索、最近三位、安装召唤、chip删除和空白关闭。',
       steps:'1. 对照真实最近召唤历史核对顺序；搜索AI命中已安装AIPPT专家，检查悬停说明。\n2. 召唤并悬停删除专家chip，清理自动填充内容；点击空白关闭面板。\n3. 进入市场搜索文档生成专家，仅安装本轮新增目标，再次召唤并删除chip。\n4. 恢复召唤历史并仅卸载本轮新增包；未确认安装结束时保留归属、暂停交接。',
       assertions:'真实历史排序、AI搜索、悬停说明、目录安装记录、输入区专家选择及删除、历史和新增资源收尾。',
       scope:'00:53真实执行PASS（17/17）；新增安装、召唤返回、chip删除、仅卸载本轮新增包及历史恢复通过。原有安装保留；强停恢复尚未专项验收。'
      },
      'config-tool':{
       purpose:'按原表验证工具列表、密钥保存、真实连接状态及错误密钥失败恢复。',
       steps:'1. 展示实际工具列表和更多工具。\n2. 仅对未配置的百度地图及TradingAgents投研填写合成无效密钥并保存。\n3. 观察黄色连接中状态及真实MCP终态，最长按产品三分钟等待；失败应恢复连接入口。\n4. 已连接时切换并恢复本任务选择开关；该开关不代表断开MCP。\n5. 恢复本轮配置及原元数据，点击空白关闭。后台连接未终结时保留归属。',
       assertions:'密钥保存回读仅返回布尔值；真实引擎状态与界面一致；任务选择及恢复；本轮资源清理和原元数据哈希。',
       scope:'MCP握手与业务鉴权分别判定；未提供有效业务密钥时正向业务鉴权分支待条件，合成无效密钥握手成功不等于业务授权通过。实际结果以本次报告为准。'
      },
      'config-knowledge':{
       purpose:'验证隔离知识库创建、报告解析、设置、引用开关和知识模块。',
       steps:'1. 创建唯一库，识别原生窗口并等待目录回显，核对请求及实际目录。\n2. 点击新库进入详情，加入合成报告并刷新。\n3. 先全量解析，核对本轮完成及真实Wiki关键事实。\n4. 设置更新时间，等待保存响应后回读并关闭本轮定时开关；检查五模块。\n5. 回首页检查任务引用switch，create状态不能当作可引用；再次进入管理。\n6. 移除本轮注册并保留材料；解析活跃或暂停时保留归属，暂停交接，结束后核对恢复。',
       assertions:'原生路径回读及关闭、页面目录回显、实际产品目录、更新设置、引用状态、本轮解析进度与真实Wiki产物。',
       scope:'00:55正式执行FAIL（10/11），原生目录链路通过；产品文档解析运行时退出0xc0000135，未生成Wiki。已补运行时明确诊断及终态与产物区分，尚未复测；解析成功、Wiki事实、任务引用和强停仍待验收。'
      }
     }[data.kind];
     const fields=[['用例编号',data.id],['场景入口',data.category+' → '+data.button],['验证目的',details.purpose],['操作步骤',details.steps],['断言依据',details.assertions],['范围',details.scope],['用例来源',caseWorkbook+'\n第二张工作表：'+caseSheet+' · 第 '+data.row+' 行'],['脚本入口',data.entry]];
     if(data.note)fields.push(['设计备注',data.note]);
     const list=document.createElement('dl');
     for(const [label,value]of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;list.append(dt,dd);}
     description.append(list);return;
    }
    const interfaceDetails={
     'workspace-default':['选择默认工作空间并验证新Session实际目录归属。','打开工作空间选择器，选择默认空间，检查输入区名称；发送短文本，核对本Session目录和最终回复。'],
     'workspace-create':['验证默认存储空间创建、选择和Session目录归属。','使用唯一名称创建空间并核对当前选择；发送短文本并检查Session目录；恢复原空间并仅删除本轮注册。'],
     'workspace-local':['验证原生本地目录选择、工作空间注册及Session归属。','通过产品入口打开Windows文件夹窗口，按客户端PID和控件选择隔离目录；回读路径和窗口关闭；核对产品注册并真实选择；创建Session检查目录；恢复原空间并移除本轮注册。原生环节已验证，完整业务及强停收尾待验证。'],
     'workspace-reference':['验证已有本机工作空间可发现、可引用和Session归属。','读取已有空间列表，选择非默认本机空间；检查输入区名称；发送短文本检查Session目录；不新增空间，结束后恢复原空间。'],
     'model-selection':['验证模型列表、候选切换、恢复自动及恢复后会话可用。','等待真实候选列表稳定，切换一个可用模型并核对选中状态；恢复自动后发送短文本，检查独立Session最终回复。']
    }[data.kind];
    const fields=[['用例编号',data.id],['场景入口',data.category+' → '+data.button],['验证目的',interfaceDetails?.[0]||'验证场景入口自动填充提示词和预期技能，并完成独立会话，检查本会话回复、产物及实际 Skill 调用。'],['操作步骤',interfaceDetails?.[1]||'1. 新建独立会话，进入上述场景。\n2. 检查自动填充的提示词及技能选择。\n3. 发送脚本内置测试素材，按执行参数处理选项与审批弹框。\n4. 等待任务结束，检查业务结果并保存截图、日志、Trace和报告。'],[interfaceDetails?'Session测试输入':'入口自动填充提示词',data.prompt],['预期 Skill',data.skills.length?data.skills.join('、'):'本用例未指定固定 Skill'],['用例来源',caseWorkbook+'\n第二张工作表：'+caseSheet+' · 第 '+data.row+' 行'],['脚本入口',data.entry]];
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
