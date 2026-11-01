import fs from 'node:fs/promises';
import path from 'node:path';
import {randomInt,randomUUID,createHash} from 'node:crypto';
import {sameKnowledgePath} from './mobilework-knowledge-resources.mjs';

export const knowledgeText=value=>value.replace(/\r\n?/g,'\n').trim();
export const readableKnowledgeText=value=>value.replace(/!?\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[#*_`|>\s]/g,'');
export const knowledgeFingerprint=bytes=>createHash('sha256').update(bytes).digest('hex');
export const flattenWikiNodes=nodes=>nodes.flatMap(node=>[node,...(node.type==='directory'?flattenWikiNodes(node.children||[]):[])]);
export const knowledgeMultiset=values=>JSON.stringify([...values].sort());

export async function prepareKnowledgeReading(created,{single=false}={}){
 const code='晴川-'+randomUUID().slice(0,8),budget=randomInt(42000,58000),owner='林澈';
 const first={name:'晴川项目验收报告.md',content:'# 晴川项目验收报告\n\n本文件为合成测试材料。项目代号：'+code+'。负责人：'+owner+'。预算：'+budget+'元。\n\n## 预算审核\n\n预算审核由'+owner+'负责，执行双人复核，结论记录在晴川会议纪要。\n\n## 验收边界\n\n登录与搜索已经验收。权限功能待复核，正式上线尚未批准。\n'},
 second=single?{name:'隔离对照未解析.md',content:'# 隔离对照\n\n本文件属于另一个合成项目，代号：对照-'+randomUUID().slice(0,8)+'。不属于本次单文件解析目标。\n'}:{name:'晴川会议纪要.md',content:'# 晴川会议纪要\n\n项目代号：'+code+'。负责人'+owner+'主持本次预算审核，预算为'+budget+'元。\n\n## 同一项目的关联事实\n\n晴川项目验收报告记录登录和搜索验收完成，权限功能仍待复核；预算审核使用双人复核流程。本会议不批准正式上线。\n\n## 后续工作\n\n'+owner+'收集权限证据后再次评审，与项目验收报告共同作为决策依据。\n'};
 const inputs=[];
 for(const item of [first,second]){
  const file=path.join(created.source_dir[0],item.name);await fs.writeFile(file,item.content);
  inputs.push({...item,path:file,sha256:knowledgeFingerprint(await fs.readFile(file))});
 }
 return {code,budget,owner,inputs};
}

export function assessSingleKnowledge({target,control,files,requests,targetText,controlRawExists,facts}){
 const targetRow=files.find(file=>sameKnowledgePath(file.path,target.path)),controlRow=files.find(file=>sameKnowledgePath(file.path,control.path));
 return {
  targetedRequest:requests.length===1&&requests[0].route==='/knowledge/parse_source'&&requests[0].source_file===target.path,
  targetSuccess:targetRow?.status==='success',controlUnparsed:controlRow?.status==='unparsed',controlRawAbsent:!controlRawExists,
  missingFacts:facts.filter(fact=>!readableKnowledgeText(targetText).includes(readableKnowledgeText(String(fact))))
 };
}

export function assessWikiDocument({source,documentText,left,right}){
 return {complete:knowledgeText(source)===knowledgeText(documentText),sourceCharacters:source.length,documentCharacters:documentText.length,
  sideBySide:!!left&&!!right&&left.width>0&&right.width>0&&right.x>=left.x+left.width-2&&Math.min(left.y+left.height,right.y+right.height)>Math.max(left.y,right.y)};
}

export function assessKnowledgeCard(detail,observed){
 const body=readableKnowledgeText(observed.body),summary=readableKnowledgeText(detail.summary),content=readableKnowledgeText(detail.content),area=observed.contentArea;
 const clippedX=['hidden','clip'].includes(area.overflowX)&&area.scrollWidth>area.clientWidth+1;
 const clippedY=['hidden','clip'].includes(area.overflowY)&&area.scrollHeight>area.clientHeight+1;
 const contentReadable=area.width>0&&area.height>0&&!clippedX&&!clippedY;
 return {title:observed.title===detail.title,date:observed.body.includes(detail.updated_at),contentReadable,
  tags:detail.tags.every(tag=>observed.tags.includes(tag==='concept'?'概念':'实体')),
  summary:summary.length>0&&body.includes(summary),fullContent:content.length>0&&contentReadable&&readableKnowledgeText(area.text).includes(content),
  relatedCards:knowledgeMultiset(detail.related_cards.map(card=>card.title))===knowledgeMultiset(observed.relatedCards),
  relatedWikis:knowledgeMultiset(detail.related_wikis.map(wiki=>wiki.title))===knowledgeMultiset(observed.relatedWikis)};
}
