import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {parseDocument} from 'yaml';
import {unzipSync,strFromU8} from 'fflate';

const item=(name,pass,actual)=>({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});
const compact=text=>String(text).normalize('NFKC').replace(/[\s*_`]/g,'');
const all=(text,patterns)=>patterns.every(p=>p.test(text));
const clock=(h,m)=>new RegExp(`${h}[:：]${String(m).padStart(2,'0')}|${h}(?:时|点)${m===0?'(?:整)?':m+'分?'}|${h>12?'下午'+(h-12)+(m===30?'点半|下午'+(h-12)+':30':'点'):'(?!)'}`);
export function publicTextChecks(number,text){
 const s=compact(text),checks=[item('本Session有非空最终助手正文',Boolean(s))];
 if(number===1){
  checks.push(item('三项任务及原始工时保留',all(s,[/蓝桥方案/,/访谈/,/周报/,/3(?:小时|h)/i,/2(?:小时|h)/i,/1(?:小时|h)/i])),item('提供工作日安排及优先顺序理由',all(s,[/周一|星期一|11月9|11[-/.]0?9/,/周五|星期五|11月13|11[-/.]13/,/优先|紧急|截止|先.{0,30}后/])),item('保留会议避让与每天两小时约束',all(s,[/周二|星期二|11月10|11[-/.]10/,/会议/,/2小时|两小时|2h|2小时\/天/i])));
 }else if(number===2){
  checks.push(item('决定为预约分流原型且本周不上线',all(s,[/预约分流/,/原型/,/本周.{0,10}(?:不|暂不)|不.{0,8}(?:本周|上线)|暂不.{0,5}上线/])),item('两项已确定行动含负责人和期限',all(s,[/林遥/,/顾行/,/11(?:月|[-/.])11|11日/,/11(?:月|[-/.])13|13日/,/测试/])),item('短信成本明确待确认而非编造',all(s,[/短信/,/待定|待确认|未确定|未明确|尚未/])&&!/预算(?:为|是|金额[:：]?)[¥￥]?\d+(?:元|万元)/.test(s)));
 }else if(number===3){
  checks.push(item('邮件对象、主题与署名保留',all(s,[/蓝桥/,/评审/,/沈然/])),item('原新时间、地点与反馈期限保留',all(s,[clock(14,0),clock(15,30),/二楼B|2楼B|B会议室/,/11(?:月|[-/.])9|9日/,clock(18,0)])),item('包含确认出席及冲突反馈要求',all(s,[/回复|反馈|确认/,/参加|出席/,/冲突|不便|不能|无法/,/可选|其他|备选|替代|方便|合适/])));
 }else if(number===4){
  checks.push(item('通知对象、核查内容及单位完整',all(s,[/各部门/,/电脑/,/显示器/,/打印机/,/资产编号/,/使用人/,/设备状态|状态/,/蓝桥科技综合管理部/])),item('提交期限联系人与异常说明完整',all(s,[/11(?:月|[-/.])13|13日/,clock(17,0),/周宁/,/806/,/丢失|遗失/,/损坏/,/单独|另行|注明|说明/])));
 }
 return checks;
}
export const publicArtifacts={5:['priority.mjs','priority.test.mjs'],6:['.github/workflows/ci.yml','README.md'],7:['architecture.mmd'],8:['text-brief.zip'],9:['clamp.mjs','clamp.test.mjs'],10:['试点复盘.pptx']};
async function ownedFile(root,name){
 const actualRoot=await fs.realpath(root),file=await fs.realpath(path.join(root,name)),relative=path.relative(actualRoot,file);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('产物指向本轮输出目录之外：'+name);
 const stat=await fs.stat(file);if(!stat.isFile()||stat.size===0||stat.size>40*1024*1024)throw Error('产物为空、非文件或超出40MB检查预算：'+name);
 return fs.readFile(file);
}
function functionChecks(number,source,testSource){
 const fn=number===5?'normalizePriority':'clamp';
 const checks=[item('实现具名导出且测试文件包含真实断言',new RegExp('export[\\s\\S]*\\b'+fn+'\\b').test(source)&&/assert|expect|throw/.test(testSource))];
 if(/\bimport\s|\brequire\s*\(|\bprocess\s*\.|\bfetch\s*\(/.test(source)){checks.push(item('纯函数实现无文件网络进程依赖',false));return checks;}
 const executable=source.replace(/export\s*\{[^}]*\}\s*;?/g,'').replace(/\bexport\s+(?=(?:async\s+)?function|const|let|var|class)/g,'');
 const calls=number===5?[[['P0'],'P0'],[[' p1 '],'P1'],[['p2'],'P2'],[['P3'],null,'RangeError'],[[''],null,'RangeError'],[[1],null,'TypeError'],[[null],null,'TypeError'],[[{}],null,'TypeError']]:[[[5,0,10],5],[[12,0,10],10],[[ -2,0,10],0],[[2,2,2],2],[[ -5,-10,-1],-5],[[1,2,0],null,'RangeError'],[['5',0,10],null,'TypeError'],[[null,0,10],null,'TypeError']];
 try{
  const values=JSON.parse(vm.runInNewContext(executable+'\nJSON.stringify('+JSON.stringify(calls.map(c=>c[0]))+'.map(args=>{try{return {value:'+fn+'(...args)}}catch(e){return {error:e.name}}}))',{}, {timeout:1000,contextCodeGeneration:{strings:false,wasm:false}}));
  for(let i=0;i<calls.length;i++)checks.push(item('独立行为 '+fn+'('+JSON.stringify(calls[i][0]).slice(1,-1)+')',calls[i][2]?values[i].error===calls[i][2]:values[i].value===calls[i][1],values[i]));
  if(number===9){const nonfinite=JSON.parse(vm.runInNewContext(executable+'\nJSON.stringify([NaN,Infinity,-Infinity].flatMap(v=>[[v,0,1],[0,v,1],[0,0,v]]).map(args=>{try{clamp(...args);return false}catch(e){return e.name==="TypeError"}}))',{}, {timeout:1000}));checks.push(item('三个参数均拒绝NaN与正负Infinity',nonfinite.length===9&&nonfinite.every(Boolean)));}
 }catch(error){checks.push(item('真实模块可独立验证',false,error.message));}
 return checks;
}
function workflowChecks(source){
 const doc=parseDocument(source);if(doc.errors.length)return [item('YAML语法正确',false,doc.errors.map(e=>e.message))];
 const w=doc.toJS(),jobs=w?.jobs||{},entries=Object.entries(jobs),steps=j=>j?.steps||[],runs=(j,re)=>steps(j).some(s=>re.test(s.run||''));
 const test=entries.find(([,j])=>runs(j,/npm test/)),build=entries.find(([,j])=>runs(j,/npm run build/));
 const depends=(j,id)=>[j?.needs].flat().includes(id),setup=j=>steps(j).some(s=>String(s.uses).startsWith('actions/checkout@'))&&steps(j).some(s=>String(s.uses).startsWith('actions/setup-node@')&&/^22(?:\.|$)/.test(String(s.with?.['node-version'])));
 const guarded=j=>{const expression=String(j.if||'').replace(/^\s*\$\{\{|\}\}\s*$/g,'');try{return ['push','pull_request','workflow_dispatch'].every(event=>[false,true].every(confirm=>Boolean(vm.runInNewContext(expression,{github:{event_name:event,event:{inputs:{confirm:String(confirm)}}},inputs:{confirm}},{timeout:100}))===(event==='workflow_dispatch'&&confirm)));}catch{return false;}};
 const delivery=entries.filter(([id,j])=>/deploy|release|部署|发布/i.test(id+' '+(j.name||'')));
 return [item('三种触发与默认只读权限',all(JSON.stringify(w.on||{}),[/push/,/pull_request/,/workflow_dispatch/])&&w.permissions?.contents==='read'),item('手动确认布尔输入默认关闭',w.on?.workflow_dispatch?.inputs?.confirm?.type==='boolean'&&w.on.workflow_dispatch.inputs.confirm.default===false),item('测试构建真实依赖及Node22环境',test&&build&&depends(build[1],test[0])&&[test[1],build[1]].every(j=>setup(j)&&runs(j,/npm ci/)&&j['runs-on'])),item('上传dist构建产物',steps(build?.[1]).some(s=>String(s.uses).startsWith('actions/upload-artifact@')&&/dist/.test(s.with?.path||''))),item('部署发布均依赖构建且仅手动确认后模拟',delivery.length===2&&delivery.every(([,j])=>depends(j,build?.[0])&&guarded(j)&&j['runs-on']&&steps(j).length&&steps(j).every(s=>!s.uses&&typeof s.run==='string'&&s.run.trim().split('\n').every(line=>/^\s*echo(?:\s|$)/.test(line)&&!/[`$;&|<>]/.test(line))))&&!/secrets\./i.test(source))];
}
function diagramChecks(source){
 const labels=new Map(),roles={browser:/浏览器|browser/i,gateway:/API\s*网关|API\s*gateway/i,orders:/订单服务|order\s*service/i,db:/PostgreSQL/i,cache:/Redis/i,queue:/消息队列|message\s*queue/i,notify:/通知服务|notification\s*service/i};
 let graph=source.replace(/\b([A-Za-z_]\w*)\s*(\[\([^\n]*?\)\]|\[\[[^\n]*?\]\]|\["[^"\n]*"\]|\[[^\]\n]*\]|\(\([^\n]*?\)\)|\([^\)\n]*\)|\{[^}\n]*\})/g,(_,id,label)=>{for(const [role,re] of Object.entries(roles))if(re.test(label))labels.set(id,role);return id;});
 graph=graph.replace(/\|[^|\n]*\|/g,'').replace(/--\s+[^\n>]+?\s+-->/g,'-->');
 const edges=[...graph.matchAll(/\b([A-Za-z_]\w*)\s*(?:-->|==>|-\.->)\s*(?=([A-Za-z_]\w*))/g)].map(m=>(labels.get(m[1])||m[1])+'>'+(labels.get(m[2])||m[2]));
 return [item('Mermaid真实包含七类业务节点',/^\s*(?:flowchart|graph)\s+(?:LR|RL|TD|TB|BT)\b/m.test(source)&&Object.keys(roles).every(r=>[...labels.values()].includes(r))),item('请求及异步链路方向正确',['browser>gateway','gateway>orders','orders>db','orders>cache','orders>queue','queue>notify'].every(e=>edges.includes(e)),edges),item('浏览器无直连数据库边',!edges.includes('browser>db'))];
}
function zipContents(bytes){
 let total=0;return unzipSync(bytes,{filter:entry=>{total+=entry.originalSize;if(total>80*1024*1024)throw Error('ZIP解压超出80MB检查预算');if(/(^[\\/]|^[A-Za-z]:|(?:^|[\\/])\.\.(?:[\\/]|$))/.test(entry.name))throw Error('ZIP含越界路径');return true;}});
}
function skillChecks(bytes){
 const zip=zipContents(bytes),source=zip['text-brief/SKILL.md']?strFromU8(zip['text-brief/SKILL.md']):'',example=zip['text-brief/references/example.md']?strFromU8(zip['text-brief/references/example.md']):'';
 const front=source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/),doc=front?parseDocument(front[1]):null,meta=doc&&!doc.errors.length?doc.toJS():{};
 return [item('归档包含正确技能路径与YAML元数据',meta?.name==='text-brief'&&typeof meta.description==='string'&&all(meta.description,[/摘要/,/不.*编造|不得.*编造|不.*虚构/])),item('技能正文包含触发输入输出及不补造约束',all(source,[/触发|何时|使用/,/输入/,/摘要/,/待确认|待定/,/日期/,/人物/,/来源/])),item('真实示例保留计划延期及日期待定',all(example,[/蓝桥/,/延期/,/日期待定|日期.*待确认|日期.*未定/]))];
}
const xmlText=s=>[...s.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m=>m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))).join('');
function pptChecks(bytes){
 const zip=zipContents(bytes),slides=Object.keys(zip).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1])),text=slides.map(n=>compact(xmlText(strFromU8(zip[n]))));
 const presentation=zip['ppt/presentation.xml']?strFromU8(zip['ppt/presentation.xml']):'',size=presentation.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
 return [item('真实PPTX为四页且每页有可编辑文本',slides.length===4&&text.every(Boolean)),item('16比9画幅',size&&Math.abs(Number(size[1])/Number(size[2])-16/9)<0.01),item('封面保留蓝桥试点主题',/蓝桥.*试点.*复盘/.test(text[0]||'')),item('问卷人数及满意率分母正确',all(text[1]||'',[/90/,/72/,/54/,/75%|75％/])&&!/60%/.test(text[1]||'')),item('问题与改进措施清楚',all(text[2]||'',[/排队/,/预约分流/])),item('两项行动负责人及期限保留',all(text[3]||'',[/林遥/,/顾行/,/11(?:月|[-/.])11|11日/,/11(?:月|[-/.])13|13日/,/原型/,/测试/]))];
}
export async function publicFileChecks(number,root){
 const checks=[],outputs=[],files={};
 for(const name of publicArtifacts[number]||[]){try{files[name]=await ownedFile(root,name);checks.push(item('本轮真实产物可读：'+name,true));outputs.push({name,source:path.join(root,name)});}catch(error){checks.push(item('本轮真实产物可读：'+name,false,error.message));}}
 if(checks.every(c=>c.pass)){
  if([5,9].includes(number)){const [source,tests]=publicArtifacts[number];checks.push(...functionChecks(number,strFromU8(files[source]),strFromU8(files[tests])));}
  if(number===6)checks.push(...workflowChecks(strFromU8(files['.github/workflows/ci.yml'])));
  if(number===7)checks.push(...diagramChecks(strFromU8(files['architecture.mmd'])));
  if(number===8)checks.push(...skillChecks(files['text-brief.zip']));
  if(number===10)checks.push(...pptChecks(files['试点复盘.pptx']));
 }
 return {checks,outputs};
}
