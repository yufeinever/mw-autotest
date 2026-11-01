import fs from 'node:fs/promises';
import path from 'node:path';
import {readAccountSnapshot,accountUsageFacts,billingDelta} from './mobilework-account-menu.mjs';
import {totalTokens} from './client-loading-usage-steps.mjs';

const save=(c,name,value)=>fs.writeFile(path.join(c.dir,name+'.json'),JSON.stringify(value,null,2));
const review=message=>Object.assign(Error(message),{review:true});
export async function runAccountUsageSteps(context){
 const before=await readAccountSnapshot(context,'执行前');await save(context,'本轮账户余额基线',before);
 if(context.number===165){const fact=await accountUsageFacts(before.identity);if(!fact)throw review('菜单与正常本地余额查询一致，但缺独立云端账户余额观测');context.assert('当前用量与独立云端余额一致',fact.balance===before.balance);await save(context,'独立云端余额对照',{before,fact:{source:fact.source,observedAt:fact.observedAt,balance:fact.balance,accountLabelSha256:fact.accountLabelSha256}});context.remaining.delete('真实账户菜单余额及独立云端对照');return;}
 context.remaining.delete('真实账户菜单余额及独立云端对照');
 if(before.balance<=0)throw Object.assign(Error('前置账号没有可用Token余额，未消耗或修改账户'),{blocked:true});
 await context.send('这是本轮独立用量核对，请直接计算137加286，给出结果及一行计算过程。不调用工具，不访问网络或修改文件。');const sessionId=context.getSessionId(),data=context.getData(),tokens=totalTokens(data);context.assert('本轮独立Session确实完成并有实际Token记录',!!sessionId&&tokens>0&&data.messages.some(m=>m.info?.role==='assistant'&&m.info.time?.completed));context.remaining.delete('独立自动模型任务及真实Token消耗');
 const after=await readAccountSnapshot(context,'任务完成后');context.assert('重新打开菜单仍为同一账户',after.identity===before.identity);const fact=await accountUsageFacts(after.identity),entry=fact?.sessions?.find(item=>item.sessionId===sessionId);await save(context,'余额自动同步与独立计费观察',{sessionId,before,after,engineTokens:tokens,billingEntry:entry?{sessionId:entry.sessionId,settledAt:entry.settledAt,balanceBefore:entry.balanceBefore,balanceAfter:entry.balanceAfter,chargedTokens:entry.chargedTokens,requestIds:entry.requestIds}:null,changed:before.balance!==after.balance});
 if(!entry)throw review('已核对任务完成及重新开菜单的真实余额，缺本Session独立云端结算明细，不能以引擎Token桶冒充扣费量');
 context.assert('独立云端明细属于当前已结算任务',Date.parse(entry.settledAt)>=data.messages.filter(m=>m.info?.role==='assistant').at(-1).info.time.completed&&fact.balance===after.balance);context.assert('实际余额减少量与本Session云端计费一致',billingDelta(before.balance,after.balance,entry));
 if(before.display===after.display)throw review('原始余额与独立账单扣量一致，但万Token显示精度未呈现本轮变化；不追加任务制造变化');
 context.remaining.delete('无手工刷新自动同步及独立账单扣量');
}
