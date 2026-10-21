import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTrace} from './trace.mjs';
import {toObservatory} from './observatory-data.mjs';
import {observatoryDocument} from './observatory-view.mjs';
const source={sessionId:'ses_root',session:{id:'ses_root',title:'测试',time:{created:1000,updated:3000}},messages:[{info:{id:'m1',sessionID:'ses_root',role:'assistant',finish:'stop',time:{created:1000,completed:3000},tokens:{input:10,output:20}},parts:[{id:'p1',type:'tool',tool:'skill',state:{status:'completed',input:{name:'other',apiKey:'private'},output:'</script><img src=x>',time:{start:1100,end:1200}}}]}]};
test('观察台按原会话映射步骤、Token及失败断言，不伪造耗时或混入外部会话',()=>{
 const trace=buildTrace(source,{expectedSkills:['required']}),view=toObservatory(trace,source);
 assert.equal(trace.checks[0].pass,false);assert.equal(view.timeline[0].finish,'stop');assert.equal(view.timeline[0].tokens.output,20);assert.equal(view.timeline[0].tools[0].time.end,1200);assert.equal(view.timeline[0].waitTiming,null);assert.equal(view.timeline[0].tools[0].input.apiKey,'[REDACTED]');assert.equal(view.childTraces.length,0);
 const child={...source,sessionId:'ses_child',session:{id:'ses_child',parentID:'ses_root'},messages:[]};const alien={...child,sessionId:'ses_alien',session:{id:'ses_alien',parentID:'ses_unknown'}};
 const tree=buildTrace({...source,children:[child,alien]});assert.deepEqual(toObservatory(tree).childTraces.map(c=>c.session.id),['ses_child']);
});
test('观察台嵌入数据转义与脱敏，使用本次快照而非8770的全部会话',()=>{
 const html=observatoryDocument(toObservatory(buildTrace(source),source));assert.ok(!html.includes('private'));assert.ok(!html.includes('</script><img src=x>'));assert.ok(html.includes('\\u003c/script>'));assert.ok(html.includes("window.fetch=async"));assert.ok(!html.includes('http://127.0.0.1:8770'));assert.ok(html.includes("loadTrace(snapshot.session.id)"));
});
