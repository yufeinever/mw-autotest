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
export function assessKnowledgeProgress(samples){
 const shown=samples.filter(item=>item.progress.isActive&&item.ui.visible),invalid=shown.filter(({ui})=>!Number.isFinite(ui.completed)||!Number.isFinite(ui.total)||ui.completed<0||ui.completed>ui.total||!Number.isFinite(ui.percent)||ui.percent<0||ui.percent>100);
 const matched=shown.filter(({progress:p,ui})=>ui.message===p.message&&ui.completed===p.completedCount&&ui.total===p.totalCount);
 const stages=[...new Set(matched.map(item=>item.progress.stage))],messages=[...new Set(matched.map(item=>item.ui.message))];
 let medium=false,long=false;
 for(const sample of matched){
  const first=matched.find(item=>item.progress.stage===sample.progress.stage&&item.progress.currentFile===sample.progress.currentFile);
  const elapsed=sample.at-first.at;
  if(sample.ui.message!==first.ui.message){if(elapsed>=5000)medium=true;if(elapsed>=30000)long=true;}
 }
 const missing=[];
 if(matched.length===0)missing.push('API与UI一致的实际执行进度');
 if(stages.length<2)missing.push('不同生成阶段的实际展示');
 if(messages.length<2)missing.push('实际阶段动作文案变化');
 if(!medium)missing.push('同阶段中等待文案变化');
 if(!long)missing.push('同阶段长等待文案变化');
 return {shown:shown.length,matched:matched.length,invalid,stages,messages,medium,long,animated:matched.some(item=>item.ui.animationName&&item.ui.animationName!=='none'),missing};
}
