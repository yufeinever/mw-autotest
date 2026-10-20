import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingAssertions,meetingText} from './case002-meeting-data.mjs';
import {meetingAssertions as syntheticAssertions} from './fixtures/case002-synthetic-meeting.mjs';
import {chromium} from 'playwright-core';
import {appendComposerText,containsComposerText} from './mobilework-composer.mjs';
const good=`# 星桥项目上线评审纪要
参会人：林青、周宁、陈禾
决议：推迟上线，新的上线日期待定。
|负责人|待办|截止时间|
|林青|监控告警接入|2026-10-19 18:00|
|周宁|回归测试|2026-10-20 17:00|
|陈禾|更新发布检查清单|2026-10-20 12:00|`;
test('会议内容断言区分有效纪要、错误负责人日期与索要材料',()=>{
 assert.ok(syntheticAssertions(good).every(c=>c.pass));
 assert.ok(syntheticAssertions('请提供会议原始记录，我可以整理会议纪要和待办清单。').every(c=>!c.pass));
 assert.equal(syntheticAssertions(good.replace('2026-10-19 18:00','2026-10-21 18:00'))[2].pass,false);
 assert.equal(syntheticAssertions(good.replace('|周宁|回归测试','|陈禾|回归测试'))[3].pass,false);
});
const publicGood=`# 大调研、大服务会议纪要
会议日期：2025-02-06上午，主持人李长华。

出席：李长华、魏中齐、刘振、梁立、张乃智、徐晶、郑瑜；列席：孔伟、张朋。

决议：原则同意徐晶汇报的活动方案。

|待办|负责人|截止时间|
|组建四个工作组，市局领导班子成员任组长，各专业骨干任成员，定向包保县市区|具体个人未明确|未明确|
|制定调查问卷，结合线上调查、实地走访、企业座谈，分专业撰写调研报告|具体个人未明确|未明确|
|统筹调度、方案制定、材料收集|综合科|未明确|`;
test('公开会议断言检查真实分工，拒绝缺项、索要材料和补造截止时间',()=>{
 assert.ok(meetingAssertions(publicGood).every(c=>c.pass));
 assert.ok(meetingAssertions('请提供会议原始记录，我可以整理会议纪要和待办清单。').every(c=>!c.pass));
 assert.equal(meetingAssertions(publicGood.replace('2025-02-06','2025-02-07'))[0].pass,false,'发布日期不是会议日期');
 assert.equal(meetingAssertions(publicGood.replace('|综合科|','|徐晶|'))[5].pass,false,'汇报人不能冒充明确牵头单位');
 assert.equal(meetingAssertions(publicGood.replace('企业座谈','内部讨论'))[4].pass,false);
 for(const deadline of ['2025-02-10','2月10日','二月十日','下周五','3个工作日内','一周内']){
  assert.equal(meetingAssertions(publicGood.replace('|综合科|未明确|','|综合科|'+deadline+'|'))[6].pass,false,deadline);
 }
});
test('补充材料不覆盖自动填充技能和提示词',async()=>{
 const b=await chromium.launch({channel:'chrome',headless:true});try{
  const p=await b.newPage();await p.setContent('<div contenteditable="true"><span contenteditable="false" data-skill-remove="meeting-and-brief">会议纪要</span>把这段会议记录整理成结构化纪要与待办清单。</div><script>window.submitted=false;document.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();window.submitted=true;document.querySelector("[contenteditable]").innerHTML="";}});</script>');
  const editor=p.locator('[contenteditable="true"]');await appendComposerText(editor,meetingText);
  assert.equal(await p.evaluate(()=>window.submitted),false,'追加材料不能触发 Enter 发送');
  assert.equal(await editor.locator('[data-skill-remove="meeting-and-brief"]').count(),1);assert.ok(containsComposerText(await editor.innerText(),meetingText));assert.ok((await editor.innerText()).includes('把这段会议记录整理成结构化纪要与待办清单。'));
 }finally{await b.close();}
});
test('全文核对仅容忍空行转换，文字丢失或日期更改不能通过',()=>{
 assert.equal(containsComposerText(meetingText.replace(/\n\n/g,'\n\n\n'),meetingText),true);
 assert.equal(containsComposerText(meetingText.replace('材料收集',''),meetingText),false);
 assert.equal(containsComposerText(meetingText.replace('2月6日','2月7日'),meetingText),false);
});
