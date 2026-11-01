import fs from 'node:fs/promises';
import path from 'node:path';
import {withRecordingExpert} from './mobilework-recording-expert.mjs';
import {readInstalledSkills} from './mobilework-skill-resources.mjs';
import {workspaces} from './mobilework-workspaces.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function runRecordingWorkflowSteps(context){
 const {number,page,dir,remaining,assert,capture}=context;
 const save=(name,data)=>fs.writeFile(path.join(dir,name),JSON.stringify(data,null,2));
 if(number===89||number===90){
  const workspaceId=page.url().match(/\/workspace\/([^/]+)/)[1],workspace=(await workspaces(page)).items.find(w=>w.id===workspaceId);
  const expectedSkill=number===89?'ihr-leave-application':'win-calculator-subtract-one',installed=await readInstalledSkills(page,workspace.path);
  await save('真实录制复用前置.json',{workspaceId,expectedSkill,installed:installed.includes(expectedSkill),required:['来自真实录制的独立可复用材料及来源Session/产物证据','新Session实际技能选择与回放','回放的真实应用效果及本轮清理归属'],scope:number===89?'专用IHR环境及合成账号/测试提交授权；不依赖086残留':'原表浏览器前置为笔误，保留桌面计算器录制来源；不依赖087残留',implemented:'仅已安装目录前置观察；来源核验和真实回放业务尚未接入'});
  await capture('录制技能复用前置');remaining.delete('真实已安装技能前置');
  if(!installed.includes(expectedSkill))throw blocked('本空间无原表录制技能'+expectedSkill+'；尚未提供来自真实录制的独立材料，不生成预制技能冒充录制产物');
  throw blocked('目标技能存在，但真实录制来源及回放归属尚未接入，不能以目录存在宣称本条复用完成');
 }
 await withRecordingExpert(context,async({catalog,installedByRun})=>{
  assert('通过真实专家市场安装或复用并召唤流程录制专家',catalog.filter(e=>e.name==='流程录制专家').length===1,{installedByRun});remaining.delete('真实录制专家安装及召唤');
  await save('录制业务接入缺口.json',{scenario:number===87?'Windows计算器123456789减1，录制后生成Skill并完整路径回放':'已登录移动会议的可丢弃会议预约，真实录制后生成Skill并回放',expectedResult:number===87?'123456788':'专用账号会议列表中可归属的新增测试预约',implemented:'真实市场安装/召唤及统一专家归属收尾',missing:['录制器实际开始/结束控件与运行状态接入','真实桌面操作事件及录制来源证明','生成Skill目录与回放的实际应用效果核对',...(number===88?['专用移动会议账号、无真实参会者的测试预约及清理归属']:[])]});
  throw blocked('已召唤流程录制专家；实际录制器控件、桌面录制及回放效果尚未接入，未发送开始录制指令，避免留下无法收尾的后台录制；本条保留部分实现');
 });
}
