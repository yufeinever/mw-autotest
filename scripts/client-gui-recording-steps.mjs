import fs from 'node:fs/promises';
import path from 'node:path';
import {readInstalledSkills,selectSlashSkill} from './mobilework-skill-resources.mjs';
import {withRecordingExpert} from './mobilework-recording-expert.mjs';
import {workspaces} from './mobilework-workspaces.mjs';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {connectClientBrowser} from '../local-console/client-connection.mjs';
import {selectWorkbench} from './mobilework-task-ui.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function runGuiRecordingSteps(context){
 const {number,page,config,control,dir,remaining,assert,capture,captureBrowser,fill,send,getSessionId,saveTrace}=context;
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
 if(number===86){
  return withRecordingExpert(context,async({catalog,installedByRun})=>{
   const target=catalog.filter(e=>e.name==='流程录制专家');
   await save('录制回放前置条件.json',{expertPresent:target.length===1,installedByRun,candidates:target.map(({id,name,kind})=>({id,name,kind})),missing:['专用IHR测试环境及可丢弃请假单的明确提交授权','运行时合成测试账号配置','录制面板、生成Skill目录和本轮回放归属接入'],implemented:'真实市场安装/召唤及归属收尾；原表录制至回放完整业务仍待实现'});
   remaining.delete('真实流程录制专家前置');
   throw blocked('已召唤流程录制专家，但专用测试环境、提交授权及录制/回放资源归属尚未接入；未启动录制或向真实人事系统提交请假');
  });
 }
 const workspaceId=page.url().match(/\/workspace\/([^/]+)/)[1],workspace=(await workspaces(page)).items.find(w=>w.id===workspaceId);
 const skills=await readInstalledSkills(page,workspace.path),target='lx-flow-search';
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now()+7*86400000);
 await save('车票查询前置条件.json',{workspaceId,skill:target,installed:skills.includes(target),date,from:'深圳',to:'上海',model:config.model||'自动',scope:'只查询，不登录、不下单、不购票；原固定日期已过期，改为查询时北京时间七天后'});
 if(!skills.includes(target))throw blocked('原表要求lx-flow-search，当前空间尚未安装该技能；不替换为普通搜索对话');
 await fill('/');
 const search=page.locator('input[placeholder="输入名称搜索..."]').filter({visible:true});await search.waitFor();await search.fill(target);
 const choice=page.getByRole('presentation').getByRole('button').filter({visible:true});
 const empty=page.getByText('未找到命令或技能。',{exact:true}).filter({visible:true});
 await choice.first().or(empty).waitFor();
 if(await empty.isVisible())throw blocked('安装目录包含lx-flow-search，但本空间斜线菜单搜索明确无结果；需核对技能启用及菜单加载状态，未创建会话');
 if(await choice.count()!==1)throw blocked('斜线技能搜索存在多个候选，无法唯一确认lx-flow-search，保留现场');
 await selectSlashSkill(context,choice,target);
 assert('真实选择原表GUI查询技能',(await snapshotDraft(page)).skills.includes(target));remaining.delete('原表技能真实选择');await capture('查询技能已选中');
 await send('请使用已选lx-flow-search技能及MobileWork内置浏览器，在中国铁路12306官方车票查询页面完成单程查询：出发地深圳，到达地上海，出发日期'+date+'。实际选择城市候选和日期并点击查询，等结果加载。只查询，不登录、不下单、不购票；不使用搜索摘要代替。若验证码、网络或视觉模型能力导致无法完成，请如实说明。最后保留真实查询结果页供核对。');
 await control.acquire(page,'EVIDENCE');await selectWorkbench(page,config,'浏览器',capture);
 let hostBrowser;
 try{
  hostBrowser=await connectClientBrowser('http://127.0.0.1:'+config.cdpPort,{browserViewId:getSessionId(),timeout:15000});
  const host=hostBrowser.contexts().flatMap(c=>c.pages())[0],view=host.locator('webview').filter({visible:true});await view.waitFor();
  const actual=await view.evaluate(async el=>({url:el.getURL(),loading:el.isLoading(),...await el.executeJavaScript(`(()=>({title:document.title,from:document.querySelector('#fromStationText')?.value,to:document.querySelector('#toStationText')?.value,date:document.querySelector('#train_date')?.value,rows:[...document.querySelectorAll('#queryLeftTable tr[id^="ticket_"]')].map(e=>e.innerText),body:document.body.innerText}))()`)}));
  await save('12306实际查询结果.json',actual);await captureBrowser(host,'12306实际查询页面');
  const url=new URL(actual.url);
  assert('实际内嵌页面位于12306官方查询域',url.hostname==='kyfw.12306.cn'&&url.pathname.includes('/leftTicket/'));
  assert('实际查询出发到达日期正确',actual.from==='深圳'&&actual.to==='上海'&&actual.date===date&&!actual.loading,{from:actual.from,to:actual.to,date:actual.date});remaining.delete('官方页面真实单程参数');
  if(/验证码|验证失败|网络异常|查询超时/.test(actual.body)&&!actual.rows.length)throw blocked('官方查询受验证码或网络阻碍，已保留实际页面；不以模型回复判成功');
  assert('结果页面有实际车次或明确无符合车次结论',actual.rows.length>0||/没有符合条件的车次|没有查询到.*车次|暂无.*车次/.test(actual.body));remaining.delete('真实车次查询结果');
 }finally{if(hostBrowser)await hostBrowser.close();}
 const trace=await saveTrace();
 assert('查询Skill有本Session真实调用证据',!trace.error&&trace.summary.total>0&&trace.summary.passed===trace.summary.total,trace.summary);remaining.delete('GUI技能真实调用');
}
