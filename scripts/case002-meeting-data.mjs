// 固定在脚本中的文字材料：运行时不读附件、不下载网页、不依赖外部文件。
export const meetingSource=Object.freeze({
 title:'济宁市统计局2025年第2次局长办公会会议纪要',
 publisher:'济宁市统计局（济宁市人民政府网站）',
 url:'https://www.jining.gov.cn/art/2025/2/7/art_36041_2901232.html?xxgkhide=1',
 meetingDate:'2025-02-06',publishedAt:'2025-02-07',verifiedAt:'2026-10-18',
 adaptation:'依据公开纪要整理的摘要，非逐字转载；保留会议日期、人员、决议及分工。原文未注明具体截止日期。'
});

export const meetingText=`请把以下会议文字材料整理成结构化会议纪要和待办清单，直接在最终回复中展示。材料已完整提供，请直接整理，无需索要原始记录、读取文件或访问来源链接；不要发送消息或执行现实业务。区分已明确的分工和待确认信息，未提供的具体负责人或截止时间标注“未明确”，不要自行补造。

材料来源：${meetingSource.title}；发布机构：济宁市统计局；发布日期：2025年2月7日。
来源链接：${meetingSource.url}
以下是依据公开纪要整理的摘要，非逐字转载：
会议时间：2025年2月6日上午。主持人：市统计局局长李长华。
出席：李长华、魏中齐、刘振、梁立、张乃智、徐晶、郑瑜。列席：孔伟、张朋。
会议议题：部署“大调研、大服务”活动。
会议决议：原则同意徐晶汇报的活动方案。
工作要求：组建四个工作组，由市局领导班子成员担任组长、各专业骨干担任成员，定向包保县市区；结合各专业关注事项设计调查问卷；将线上调查、实地走访与企业座谈相结合，并分专业编写调研报告。
明确分工：综合科牵头，负责统筹调度、方案制定和材料收集。
待确认信息：公开纪要没有逐项指定个人负责人，也未明确各项工作的具体截止日期，整理时应保留这一信息缺口。`;

export function meetingAssertions(text){
 text=text.normalize('NFKC');
 const compact=text.replace(/[\s*`_]/g,'');
 const blocks=text.split(/\n\s*\n/).flatMap(p=>p.includes('|')?p.split('\n'):[p]);
 const responsibility=text.match(/综合科[^\n]*(?:\n(?!\s*#{1,6}\s)[^\n]*){0,5}/g)||[];
 const ledByGeneralOffice=[...blocks,...responsibility].some(b=>/综合科/.test(b)&&/统筹|调度|协调/.test(b)&&/方案/.test(b)&&/材料|资料/.test(b)&&/收集|汇总|搜集/.test(b));
 const deadlineLabel=/截止|时限|期限|完成时间|完成日期|时间要求/;
 const deadlineBlocks=[];let deadlineColumn=-1;
 for(const line of text.split('\n')){
  if(line.includes('|')){
   const cells=line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
   const header=cells.findIndex(c=>deadlineLabel.test(c));
   if(header>=0)deadlineColumn=header;
   else if(deadlineColumn>=0&&!cells.every(c=>/^:?-+:?$/.test(c)))deadlineBlocks.push(cells[deadlineColumn]||'');
  }else{
   deadlineColumn=-1;
   if(deadlineLabel.test(line))deadlineBlocks.push(line);
  }
 }
 const unspecified=/(?:未(?:明确|说明|提供|给出|注明|确定|提及|载明|规定)|待确认|待明确|待补充|待定|无明确|无具体)/;
 // 只检查期限相关段落或表格行，避免把真实会议日期误认成截止日期。
 const inventedDeadline=/(?:\d{4}\s*[-/.年]\s*\d{1,2}|\d{1,2}\s*(?:[-/.]\s*\d{1,2}|月\s*\d{1,2})|[〇零一二三四五六七八九十两]+月[〇零一二三四五六七八九十两]+日|\d{1,2}\s*[:：]\s*\d{2}|(?:本|下|这)(?:周|星期|月)|[\d一二三四五六七八九十两]+\s*(?:个)?(?:工作日|天|日|周)(?:内|前)|明天|后天|今日|今天|当天|月底|月末)/;
 return [
  {name:'保留会议议题、实际会议日期与主持人',pass:/大调研/.test(text)&&/大服务/.test(text)&&/2025(?:年|[-/.])0?2(?:月|[-/.])0?6/.test(compact)&&/李长华/.test(text)},
  {name:'保留出席及列席人员',pass:['李长华','魏中齐','刘振','梁立','张乃智','徐晶','郑瑜','孔伟','张朋'].every(n=>compact.includes(n))},
  {name:'保留原则通过活动方案的决议',pass:/原则(?:上)?(?:同意|通过|认可)/.test(text)&&/徐晶/.test(text)&&/(?:活动|调研|服务)方案/.test(compact)},
  {name:'四个工作组及人员构成、包保范围完整',pass:/(?:四|4)(?:个|支)?(?:工作|调研)组/.test(compact)&&/领导班子|局领导/.test(compact)&&/组长|带队/.test(text)&&/专业骨干/.test(text)&&/县[、,，（(]?市[、,，）)]?区/.test(compact)},
  {name:'待办包含问卷、线上线下调研及报告',pass:/问卷/.test(text)&&/线上|在线|网络调查/.test(text)&&/实地|走访/.test(text)&&/企业座谈|企业.{0,6}座谈/.test(text)&&/调研报告|调查报告/.test(text)},
  {name:'综合科承担统筹调度、方案制定和材料收集',pass:ledByGeneralOffice},
  {name:'明确截止时间未提供且未补造期限',pass:deadlineBlocks.some(b=>unspecified.test(b))&&!deadlineBlocks.some(b=>inventedDeadline.test(b))}
 ];
}
