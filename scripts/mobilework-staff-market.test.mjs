import test from 'node:test';
import assert from 'node:assert/strict';
import {staffIdentity,sameStaffCards} from './mobilework-staff-market.mjs';

test('市场卡片核对保留同名不同员工的数量并拒绝漏项跨域及发布者串数据',()=>{
 const expected=[
  {id:1,agentName:'测试员工',orgName:'测试组织',createUserName:'测试发布者',businessTypeName:'办公'},
  {id:2,agentName:'测试员工',orgName:'测试组织',createUserName:'测试发布者',businessTypeName:'办公'},
  {id:3,agentName:'测试员工',orgName:'另一组织',createUserName:'另一发布者',businessTypeName:'财务'}
 ];
 const cards=expected.map(staffIdentity);
 assert.equal(sameStaffCards(cards.toReversed(),expected),true,'排序变化不改变集合');
 assert.equal(sameStaffCards(cards.slice(1),expected),false,'名称相同不允许漏掉一个实际员工');
 assert.equal(sameStaffCards([cards[0],cards[0],cards[0]],expected),false,'不能用重复卡片掩盖发布者及领域串数据');
 assert.equal(sameStaffCards(cards.map((c,i)=>i===2?{...c,domain:'办公'}:c),expected),false,'实际所属领域须对应');
});
