// 保留原虚构材料及其断言，供历史回归使用；第二条用例默认使用公开会议材料。
export const meetingText=`以下是自动化测试专用的虚构会议记录，不涉及真实业务。请直接依据记录整理，不补造信息、不发送消息、不调用外部服务。将纪要和待办清单直接输出在最终回复中。
会议主题：星桥项目上线评审
会议时间：2026年10月16日 10:00—10:30
参会人：林青、周宁、陈禾。
讨论：监控告警接入仍未完成，当前版本不得上线。
决议：推迟上线，待监控接入和回归测试均通过后，再安排上线评审，不设定新的上线日期。
待办一：林青负责完成监控告警接入，截止2026年10月19日18:00。
待办二：周宁负责完成回归测试，截止2026年10月20日17:00。
待办三：陈禾负责更新发布检查清单，截止2026年10月20日12:00。
待确认：新的上线日期尚未确定。`;
export function meetingAssertions(text){
 const compact=text.replace(/[\s*`_]/g,'');
 const task=(person,work,date,hour)=>{
  // Require each task, owner and deadline in the same row or small paragraph.
  const blocks=text.split(/\n\s*\n/).flatMap(p=>p.includes('|')?p.split('\n'):[p]);
  return blocks.some(b=>b.includes(person)&&work.test(b)&&date.test(b)&&hour.test(b));
 };
 return [
  {name:'纪要包含主题与参会人',pass:compact.includes('星桥项目')&&['林青','周宁','陈禾'].every(x=>compact.includes(x))},
  {name:'保留推迟上线的决议和未定日期',pass:/推迟|延期|暂缓|暂不|不得上线/.test(text)&&/未定|未确定|待定|待确认|尚未确定/.test(text)},
  {name:'林青：监控告警接入及10月19日18时截止',pass:task('林青',/监控|告警/,/10[-/.月]19/,/18[:：]00|18时|18点/)},
  {name:'周宁：回归测试及10月20日17时截止',pass:task('周宁',/回归测试/,/10[-/.月]20/,/17[:：]00|17时|17点/)},
  {name:'陈禾：发布检查清单及10月20日12时截止',pass:task('陈禾',/发布检查清单/,/10[-/.月]20/,/12[:：]00|12时|12点/)}
 ];
}
