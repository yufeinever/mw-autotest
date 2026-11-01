import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const fixtures=fileURLToPath(new URL('./fixtures/office-preview/',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const knowledgeFormatInputs=[
 ['legacy/中文项目说明.doc','doc'],['中文项目说明.docx','docx'],
 ['legacy/中文产品方案.ppt','ppt'],['中文产品方案.pptx','pptx'],
 ['legacy/中文销售明细.xls','xls'],['中文销售明细.xlsx','xlsx'],
 ['中文会议资料.pdf','pdf'],['中文说明.md','md']
];
export async function prepareKnowledgeFormats(target){
 const manifest=JSON.parse(await fs.readFile(path.join(fixtures,'manifest.json'),'utf8')),files=[];
 await fs.mkdir(target,{recursive:true});
 for(const [relative,format] of knowledgeFormatInputs){
  const data=await fs.readFile(path.join(fixtures,relative)),sourceHash=manifest.files.find(item=>item.name===relative).sha256;
  if(hash(data)!==sourceHash)throw Error('既有合成样本与材料清单不一致：'+relative);
  const name=format.toUpperCase()+'-'+path.basename(relative),file=path.join(target,name);
  await fs.writeFile(file,data);
  const key={doc:'docx',ppt:'pptx',xls:'xlsx'}[format]||format;
  files.push({format,name,path:file,sha256:sourceHash,facts:manifest.facts[key]||['星桥Markdown','7319','沈岚']});
 }
 return files;
}

export const rawKnowledgeName=file=>path.basename(file,path.extname(file))+'.md';
export const normalizedKnowledgeText=text=>text.replace(/[\s,，]/g,'');
// Current installed knowledge-parse-progress.js contract; recheck on client upgrades.
// Exact category membership proves the actual branch; arbitrary changed text does not.
const knowledgeStageCopy={
 read_source:{
  medium:['正在加载目标资料','正在拆解源文件结构','正在读取源文件内容'],
  long:['正在逐层解析源文件，确保内容不遗漏，请稍候','文档内容比较多，正在逐页梳理结构','文档内容体量较大，仍在读取资料，请稍候']
 },
 build_summary:{
  medium:['正在生成摘要数据结构','正在汇总核心信息','正在组织关键内容'],
  long:['文档要点较多，摘要仍在生成中，请耐心等待','正在压缩冗余信息，形成更清晰的摘要，请稍候','摘要构建还在进行，正在整理重点信息']
 },
 extract_entities:{
  medium:['正在识别关键实体','正在核对识别内容','正在梳理实体及其关联'],
  long:['文档实体数量较多，实体提取仍在进行，请稍候','正在逐项识别文档实体，处理时间较长，请耐心等待','实体信息量较大，抽取工作仍在进行，请稍候']
 },
 extract_concepts:{
  medium:['正在提炼文档业务概念','正在梳理文档知识概念','正在挖掘文档核心概念'],
  long:['正在深度挖掘文档知识概念，处理耗时较长，请耐心等待','正在逐一识别并归一化实体，请稍候','文档概念层次较多，概念构建仍在进行，请稍候','正在细致梳理文档知识脉络，所需时间较长，请耐心等待']
 },
 ingest:{
  medium:['正在同步知识库数据','持久化解析结果数据','正在写入内容'],
  long:['知识库写入数据量较大，仍在同步结果，请稍候','正在将解析结果写入知识库，耗时较长，请耐心等待','知识库数据同步中，写入工作量较大，请稍候']
 }
};
export function assessKnowledgeProgress(samples){
 const shown=samples.filter(item=>item.progress.isActive&&item.ui.visible),invalid=shown.filter(({ui})=>!Number.isFinite(ui.completed)||!Number.isFinite(ui.total)||ui.completed<0||ui.completed>ui.total||!Number.isFinite(ui.percent)||ui.percent<0||ui.percent>100);
 const matched=shown.filter(({progress:p,ui})=>ui.message===p.message&&ui.completed===p.completedCount&&ui.total===p.totalCount);
 const stages=[...new Set(matched.map(item=>item.progress.stage))],messages=[...new Set(matched.map(item=>item.ui.message))];
 let medium=false,long=false;const durationEvidence=[];
 for(const sample of matched){
  const first=matched.find(item=>item.progress.stage===sample.progress.stage&&item.progress.currentFile===sample.progress.currentFile);
  const elapsed=sample.at-first.at,copy=knowledgeStageCopy[sample.progress.stage];
  const category=copy?.medium.includes(sample.ui.message)?'medium':copy?.long.includes(sample.ui.message)?'long':null;
  durationEvidence.push({at:sample.at,stage:sample.progress.stage,currentFile:sample.progress.currentFile,observedElapsedMs:elapsed,category,message:sample.ui.message});
  if(category==='medium'&&elapsed>=5000)medium=true;
  if(category==='long'&&elapsed>=30000)long=true;
 }
 const missing=[];
 if(matched.length===0)missing.push('API与UI一致的实际执行进度');
 if(stages.length<2)missing.push('不同生成阶段的实际展示');
 if(messages.length<2)missing.push('实际阶段动作文案变化');
 if(!medium)missing.push('同阶段中等待文案变化');
 if(!long)missing.push('同阶段长等待文案变化');
 return {shown:shown.length,matched:matched.length,invalid,stages,messages,medium,long,durationEvidence,animated:matched.some(item=>item.ui.animationName&&item.ui.animationName!=='none'),missing};
}
