import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {parseDocument} from 'yaml';
import {unzipSync,strFromU8} from 'fflate';

const check=(name,pass,actual)=>({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});
const compact=s=>s.normalize('NFKC').replace(/[\s*`_]/g,'');
const date=(s,y,m,d)=>new RegExp(y+'(?:年|[-/.])0?'+m+'(?:月|[-/.])0?'+d+'(?:日|\\b)').test(compact(s));
const chineseNumber=n=>n<10?'零一二三四五六七八九'[n]:(n<20?'十':'二十')+(n%10?'零一二三四五六七八九'[n%10]:'');
const time=(s,h,m)=>{
 const words=hour=>'(?:'+hour+'|'+chineseNumber(hour)+(hour===2?'|两':'')+')(?:时|点)'+(m===0?'(?:整)?':m===30?'(?:半|30分?|三十分?)':'(?:'+m+'|'+chineseNumber(m)+')分?');
 return new RegExp('(?<!\\d)(?:'+h+'[:：]'+String(m).padStart(2,'0')+'|'+words(h)+(h>12?'|(?:下午|午后)(?:'+(h-12)+'[:：]'+String(m).padStart(2,'0')+'|'+words(h-12)+')':'')+')').test(compact(s));
};
const evidence=(text,patterns)=>patterns.map(p=>text.split('\n').find(line=>p.test(line))?.trim()).filter(Boolean);
// Compare concepts and supplied facts, not headings, word counts or JSON syntax.
function conceptsCheck(name,text,patterns){const actual=evidence(text,patterns);return check(name,patterns.every(p=>p.test(text)),{evidence:actual});}
function sections(text,groups,{labelColumns=false}={}){
 const sourceLines=text.split('\n'),cells=l=>l.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
 const rows=sourceLines.filter(l=>/^\s*\|.*\|\s*$/.test(l)&&! /^[\s|:-]+$/.test(l)).map(cells);
 // A pipe in a heading (including NFKC-normalized “｜”) is not a table.
 // Recognize Markdown tables by their separator, then gather their rows.
 for(let i=1;i<sourceLines.length;i++)if(/^\s*\|?[\s:|-]+\|?[\s]*$/.test(sourceLines[i])&&sourceLines[i].includes('|')&&sourceLines[i].includes('---')&&sourceLines[i-1].includes('|')&&!/^\s*\|/.test(sourceLines[i-1])){
  rows.push(cells(sourceLines[i-1]));while(i+1<sourceLines.length&&sourceLines[i+1].includes('|')&&!/^\s*#/.test(sourceLines[i+1]))rows.push(cells(sourceLines[++i]));
 }
 const header=rows.findIndex(row=>groups.every(g=>row.some(c=>g.test(c))));
 if(header>=0)return groups.map(g=>{const col=rows[header].findIndex(c=>g.test(c));return rows.slice(header+1).filter(row=>row[col]).map(row=>row[0]+': '+row[col]).join('\n');});
 const groupRows=groups.map(g=>rows.filter(row=>row.some(c=>g.test(c))));
 if(groupRows.every(r=>r.length))return groupRows.map(r=>r.map(c=>labelColumns?c.map((value,i)=>value?(rows[0]?.[i]||'')+': '+value:'').join(' | '):c.join(' | ')).join('\n'));
 // A concluding recommendation mentioning every audience/product is not
 // an individual section heading. Fall back to each first concrete mention.
 const lines=text.split('\n'),starts=groups.map(g=>{const heading=lines.findIndex(l=>/^\s*(?:#{1,6}\s|\*\*|(?:\d+|[一二三四五])\s*[.、)）])/.test(l)&&g.test(l)&&groups.filter(other=>other.test(l)).length===1);return heading>=0?heading:lines.findIndex(l=>g.test(l));});
 const summaries=lines.flatMap((l,i)=>/^\s*(?:#{1,6}\s|\*\*)/.test(l)&&groups.filter(g=>g.test(l)).length>1?[i]:[]);
 return starts.map((start,i)=>start<0?'':lines.slice(start,Math.min(...starts.filter((n,j)=>j!==i&&n>start),...summaries.filter(n=>n>start),lines.length)).join('\n'));
}
export function reportJson(text,key){
 for(const match of [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].reverse()){
  try{const value=JSON.parse(match[1]);if(value&&Object.hasOwn(value,key))return value;}catch{}
 }
 return null;
}
function conceptSections(text,groups){
 const lines=text.split('\n'),heads=lines.flatMap((line,index)=>{const m=line.match(/^\s*(#{1,6})\s+(?:方案|概念)\s*[一二三四五六七八九十\d]+/);return m?[{index,level:m[1].length}]:[];});
 if(heads.length<3)return sections(text,groups);
 const blocks=heads.map(({index,level})=>{let end=index+1;while(end<lines.length){const h=lines[end].match(/^\s*(#{1,6})\s/);if(h&&h[1].length<=level)break;end++;}return lines.slice(index,end).join('\n');});
 // Named concepts can introduce the audience in their positioning paragraph.
 // Use the first audience mentioned inside each concept, never the preamble
 // or a comparison table that happens to repeat all audiences.
 return groups.map((g,i)=>blocks.find(block=>{const positions=groups.map(x=>block.search(x));const first=Math.min(...positions.filter(n=>n>=0));return positions[i]>=0&&positions[i]===first;})||'');
}
export function textChecks(number,text,{scheduleFixture=false}={}){
 text=text.normalize('NFKC');
 if(number===1){
  const content=text.split(/\n|[。！？]/).filter(s=>!/(?:请|需要|还需).{0,16}(?:提供|补充|发给|告诉)|(?:我会|我将|收到.{0,12}后).{0,40}(?:安排|排序|规划)/.test(s)).join('\n');
  return [
   conceptsCheck('回复提供实际日程安排（索要材料不算完成）',content,[/周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|每天|每日/,/安排|计划|日程|排期/,/完成|处理|推进|交付|整理|提交/]),
   conceptsCheck('回复说明任务优先顺序或取舍依据',content,[/优先|先.{0,12}再|P[0-3]|紧急|重要性/,/截止|交付|重要|紧急|核心|依赖|优先级|P[0-3]/]),
   ...(scheduleFixture?[conceptsCheck('安排涵盖提供的三项任务',content,[/项目方案/,/客户反馈/,/周报/])]:[])
  ];
 }
 if(number===3)return [
  conceptsCheck('邮件回应改期主题并保留收件人与署名',text,[/星桥项目/,/项目组/,/许晴/,/调整|改期|变更|更改|改为/]),
  check('保留材料中原会议及调整后的时间',time(text,14,0)&&time(text,15,30)&&date(text,2026,11,3)),
  check('保留会议地点及反馈截止时间',/(?:三|3)楼\s*A\s*会议室|A\s*会议室.{0,8}(?:三|3)楼/.test(text)&&date(text,2026,11,2)&&time(text,18,0)&&/反馈|回复|确认/.test(text))
 ];
 if(number===4)return [
  conceptsCheck('通知回应设备盘点且保留受文对象和发文单位',text,[/办公设备.*盘点|盘点.*办公设备/,/通知/,/各部门/,/星桥科技\s*综合管理部/]),
  conceptsCheck('盘点范围和登记信息完整',text,[/电脑|计算机/,/显示器/,/打印机/,/资产编号|资产编码/,/使用人|使用者/,/设备状态|使用状态|设备状况/]),
  check('保留发文日期、提交期限、联系人和异常说明',date(text,2026,11,2)&&date(text,2026,11,6)&&time(text,17,0)&&/赵宁/.test(text)&&/803/.test(text)&&/丢失|遗失/.test(text)&&/损坏|损毁/.test(text))
 ];
 if(number===13){
  const data=reportJson(text,'concepts'),items=Array.isArray(data?.concepts)?data.concepts:[];
  const groups=[/上班族|职场|通勤/,/儿童|亲子|家庭/,/老年|长者|银发/];
  const parts=items.length?groups.map(g=>JSON.stringify(items.find(x=>g.test(x.userGroup))||'')):conceptSections(text,groups);
  const substantive=parts.map(p=>compact(p.split('\n').filter(l=>!/^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(l)&&!/^\s*(?:[-+]\s*)?(?:目标人群|适用人群|用户群体|人群|受众)\s*[:：]/.test(l.replace(/[*`]/g,''))).join('\n')));
  return [
   check('针对三类人群分别形成方案（接受正文、表格或JSON）',parts.every(p=>p&&p!=='""')&&new Set(parts).size===3),
   check('方案包含使用场景与可执行功能',items.length?items.every(x=>x.scene?.trim()&&Array.isArray(x.coreFeatures)&&x.coreFeatures.length>=2&&x.coreFeatures.every(f=>f.trim())&&x.differentiation?.trim()):parts.every(p=>/借|换|互助|共享/.test(p)&&/预约|匹配|登记|发布|归还|提醒|代取|上门|邻里|功能/.test(p))),
   check('方案场景与功能具有区别',items.length?['scene','differentiation'].every(k=>new Set(items.map(x=>x[k])).size===items.length)&&new Set(items.map(x=>JSON.stringify(x.coreFeatures))).size===items.length:substantive.every(Boolean)&&new Set(substantive).size===3)
  ];
 }
 if(number===15){
  const data=reportJson(text,'products'),items=Array.isArray(data?.products)?data.products:[];
  const primary=(name,value)=>{try{const u=new URL(value),h=u.hostname.toLowerCase();if(u.protocol!=='https:')return false;
   const hosts=/codex/i.test(name)?['openai.com']: /claude/i.test(name)?['anthropic.com','claude.com','claude.ai']:['workbuddy.cn','tencent.com','tencent.cn','tencentcloud.com'];
   return hosts.some(d=>h===d||h.endsWith('.'+d))||(/codex/i.test(name)&&h==='github.com'&&u.pathname.startsWith('/openai/'));
  }catch{return false;}};
  const names=['Codex','Claude Code','WorkBuddy'],urls=[...text.matchAll(/https:\/\/[^\s<>"\])]+/g)].map(m=>m[0]);
  const productParts=sections(text,names.map(n=>new RegExp(n.replace(' ','\\s*'),'i')),{labelColumns:true});
  const dimensions=[/功能|能力/,/易用|门槛|上手|安装|使用体验/,/定价|价格|费用|成本|未核实/,/案例|场景|实践/,/优势|优点|擅长/,/局限|不足|缺点|限制|风险/];
  return [
   check('研究比较三种指定产品',names.every(n=>new RegExp(n.replace(' ','\\s*'),'i').test(text))),
   check('每种产品覆盖功能、使用门槛、成本、场景与优劣势',items.length?names.every(n=>items.some(x=>new RegExp(n.replace(' ','\\s*'),'i').test(x.name||'')&&['features','usability','pricing','useCase','pros','cons'].every(k=>typeof x[k]==='string'&&x[k].trim()))):productParts.every(p=>dimensions.every(d=>d.test(p)))),
   check('提供对应产品的官方来源依据',names.every(n=>urls.some(u=>primary(n,u)))),
   conceptsCheck('结论回应团队选型需求',data?.recommendation||text,[/建议|推荐|选择|选型/,/Windows|权限|审查|成本|预算|团队/])
  ];
 }
 if(number===16){
  const data=reportJson(text,'recommended'),good=data?.recommended||[],bad=data?.excluded||[];
  const lines=text.split('\n'),aliases={A:/云杉\s*Air|(?:候选|产品)?\bA\b/i,B:/远行\s*Pro|(?:候选|产品)?\bB\b/i,C:/旗舰\s*Max|(?:候选|产品)?\bC\b/i,D:/力量\s*Book|(?:候选|产品)?\bD\b/i,E:/轻享\s*Go|(?:候选|产品)?\bE\b/i};
  const exclusion=/不推荐|不满足|不符合|不达标|未达|不足|超出|超标|超限|剔除|排除|淘汰|超预算|超重/;
  // Candidate headings can be followed by reasons on later lines. Keep those
  // reasons attached to their candidate instead of demanding one table row.
  const parts=sections(text,Object.values(aliases));
  const mention=id=>{
   // A response may put recommended products in a table and exclusions in
   // a list. Match the product-name cell, not comparisons in another row.
   const rows=lines.filter(l=>/^\s*\|.*\|\s*$/.test(l)).map(l=>l.trim().replace(/^\||\|$/g,'').split('|'));
   const row=rows.find(r=>aliases[id].test(r[0]));if(row)return row.join(' | ');
   const body=parts[Object.keys(aliases).indexOf(id)]||lines.filter(l=>aliases[id].test(l)).join('\n');
   const start=lines.findIndex(l=>l===body.split('\n')[0]);
   const heading=start>=0?lines.slice(0,start).findLast(l=>/^\s*#{1,6}\s/.test(l)||/^\s*\*\*[^*]+\*\*\s*$/.test(l)):'';
   return (heading&&!Object.values(aliases).some(a=>a.test(heading))?heading+'\n':'')+body;
  };
  return [
   check('推荐符合条件的A、B两款并说明理由',data?Array.isArray(good)&&good.length===2&&good.map(x=>x.id).sort().join(',')==='A,B'&&good.every(x=>x.reason?.trim()):['A','B'].every(id=>/推荐|满足|符合|达标|合格|首选|备选/.test(mention(id))&&!exclusion.test(mention(id)))),
   check('不推荐超预算、超重或容量不足的候选',data?Array.isArray(bad)&&['C','D','E'].every(id=>bad.some(x=>x.id===id&&x.reason?.trim())):['C','D','E'].every(id=>exclusion.test(mention(id))&&!/(?<!不)推荐|首选|备选|符合条件/.test(mention(id))),{excluded:data?bad:['C','D','E'].map(id=>({id,evidence:mention(id)}))}),
   check('剔除原因对应候选的真实短板',[[/预算|价格|8000|8999/,'C'],[/重量|1[.．]65|1[.．]4|超重/,'D'],[/内存|SSD|存储|容量|8GB|256GB/i,'E']].every(([pattern,id])=>pattern.test(data?bad.find(x=>x.id===id)?.reason||'':mention(id)))),
   check('明确测试快照性质且未生成购买链接',/虚构|模拟|测试商品|测试快照/.test(data?.note||text)&&!/https?:\/\//i.test(text))
  ];
 }
 // File scenarios are judged by their actual deliverables below; response
 // length is not evidence of either success or failure.
 return [];
}

export async function readArtifact(root,name,{binary=false,maxBytes=4000000}={}){
 const full=path.resolve(root,name),actual=await fs.realpath(full),base=await fs.realpath(root),relative=path.relative(base,actual);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('产物实际路径越出本次输出目录：'+name);
 const stat=await fs.stat(actual);if(!stat.isFile()||stat.size===0||stat.size>maxBytes)throw Error('产物为空、非文件或超过大小限制：'+name);
 return fs.readFile(actual,binary?undefined:'utf8');
}
export function zipTextFiles(bytes){
 let total=0;
 return unzipSync(bytes,{filter(file){
  const name=file.name.replaceAll('\\','/');
  if(name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))throw Error('归档包含越界路径');
  total+=file.originalSize;
  if(file.originalSize>20000000||total>80000000)throw Error('归档展开大小超过验证限制');
  return /\.(xml|rels|md)$/i.test(name);
 }});
}
export function algorithmChecks(number,source){
 const fn=number===5?'normalizePriority':'clamp';
 if(!new RegExp('\\bexport\\s+(?:(?:async\\s+)?(?:function|const|let)\\s+'+fn+'\\b|\\{[^}]*\\b'+fn+'\\b)').test(source))return [check('代码具名导出 '+fn,false)];
 if(/\bimport\s*(?:\(|[{*'"A-Za-z])|\brequire\s*\(/.test(source))return [check('纯函数不导入外部模块',false)];
 const calls=number===5?[
  [['P0'],'P0'],[[' p1 '],'P1'],[['p2'],'P2'],[['P3'],null,'RangeError'],[[''],null,'RangeError'],[[null],null,'TypeError'],[[1],null,'TypeError']
 ]:[
  [[5,0,10],5],[[-3,0,10],0],[[20,0,10],10],[[0,0,0],0],[[10,0,10],10],[[-7,-10,-2],-7],[[3,5,1],null,'RangeError'],[['1',0,5],null,'TypeError'],[[null,0,5],null,'TypeError'],[[1,'0',5],null,'TypeError'],[[1,0,'5'],null,'TypeError']
 ];
 const executable=source.replace(/\bexport\s*\{[^}]*\};?/g,'').replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g,'');
 const script=executable+`\nJSON.stringify(__calls.map(args=>{try{return {value:${fn}(...args)}}catch(e){return {error:e.name}}}))`;
 let values;
 try{values=JSON.parse(vm.runInNewContext(script,{__calls:calls.map(c=>c[0])},{timeout:1000}));}
 catch(error){return [check('代码可执行且在时限内返回',false,error.message)];}
 const results=calls.map((c,i)=>check('独立行为断言 '+fn+'('+JSON.stringify(c[0]).slice(1,-1)+')',c[2]?values[i]?.error===c[2]:values[i]?.value===c[1],values[i]));
 if(number===9){
  const nonfinite=executable+'\nJSON.stringify([NaN,Infinity,-Infinity].flatMap(x=>[[x,0,1],[0,x,1],[0,0,x]]).map(args=>{try{clamp(...args);return false}catch(e){return e.name==="TypeError"}}))';
  try{results.push(check('NaN与正负Infinity均拒绝',JSON.parse(vm.runInNewContext(nonfinite,{}, {timeout:1000})).every(Boolean)));}catch(e){results.push(check('NaN与正负Infinity均拒绝',false,e.message));}
 }
 return results;
}
export function workflowChecks(source){
 const doc=parseDocument(source);if(doc.errors.length)return [check('流水线YAML语法正确',false,doc.errors.map(e=>e.message).join('; '))];
 const w=doc.toJS(),jobs=w?.jobs||{},triggers=w?.on||{},needs=(j,n)=>[jobs[j]?.needs].flat().includes(n);
 const steps=j=>jobs[j]?.steps||[];
 const run=(j,re)=>steps(j).some(s=>re.test(s.run||''));
 const node22=j=>steps(j).some(s=>String(s.uses||'').startsWith('actions/setup-node@')&&/^22(?:\.|$)/.test(String(s.with?.['node-version'])));
 const checkout=j=>steps(j).some(s=>String(s.uses||'').startsWith('actions/checkout@'));
 const guarded=j=>{
  const expression=String(jobs[j]?.if||'').replace(/^\s*\$\{\{|\}\}\s*$/g,'');
  if(!expression)return false;
  try{return ['push','pull_request','workflow_dispatch'].every(event=>[false,true].every(confirm=>{
   const answer=vm.runInNewContext(expression,{github:{event_name:event,event:{inputs:{confirm:String(confirm)}}},inputs:{confirm}},{timeout:1000});
   return Boolean(answer)===(event==='workflow_dispatch'&&confirm);
  }));}catch{return false;}
 };
 return [
  check('流水线具备push、PR、手动触发和默认只读权限',['push','pull_request','workflow_dispatch'].every(k=>Object.hasOwn(triggers,k))&&w.permissions?.contents==='read'),
  check('手动确认输入为布尔且默认关闭',triggers.workflow_dispatch?.inputs?.confirm?.type==='boolean'&&triggers.workflow_dispatch.inputs.confirm.default===false),
  check('四个任务均声明运行环境',['test','build','deploy','release'].every(j=>typeof jobs[j]?.['runs-on']==='string'&&jobs[j]['runs-on'].trim().length>0)),
  check('测试与构建使用Node22并按依赖执行',['test','build'].every(j=>checkout(j)&&node22(j))&&run('test',/npm ci/)&&run('test',/npm test/)&&needs('build','test')&&run('build',/npm ci/)&&run('build',/npm run build/)),
  check('构建上传dist真实产物',steps('build').some(s=>String(s.uses||'').startsWith('actions/upload-artifact@')&&/dist/.test(s.with?.path||''))),
  check('部署和发布仅在手动确认后触发',needs('deploy','build')&&needs('release','build')&&guarded('deploy')&&guarded('release')),
  check('部署发布仅echo模拟且无密钥引用',['deploy','release'].every(j=>steps(j).length>0&&steps(j).every(s=>!s.uses&&typeof s.run==='string'&&s.run.split('\n').filter(l=>l.trim()).every(l=>/^\s*echo(?:\s|$)/.test(l)&&!/[`$;&|<>]/.test(l))))&&!/secrets\./i.test(source))
 ];
}
export function diagramChecks(source){
 const labels=new Map(),roles={browser:/浏览器|browser/i,gateway:/API\s*网关|API\s*gateway/i,orders:/订单服务|order\s*service/i,db:/PostgreSQL/i,cache:/Redis/i,queue:/消息队列|message\s*queue/i,notify:/通知服务|notification\s*service/i};
 // Remove label syntax after mapping semantic roles, then parse chains. Node
 // IDs, rounded/database shapes, edge labels and LR/TD layouts are equivalent.
 let graph=source.replace(/\b([A-Za-z_]\w*)\s*(\[\([^\n]*?\)\]|\[\[[^\n]*?\]\]|\["[^"\n]*"\]|\[[^\]\n]*\]|\(\([^\n]*?\)\)|\([^\)\n]*\)|\{[^}\n]*\})/g,(_,id,label)=>{for(const [role,re] of Object.entries(roles))if(re.test(label))labels.set(id,role);return id;});
 graph=graph.replace(/\|[^|\n]*\|/g,'').replace(/--\s+[^\n>]+?\s+-->/g,'-->');
 const edges=[];
 for(const match of graph.matchAll(/\b([A-Za-z_]\w*)\s*(?:-->|==>|-\.->)\s*(?=([A-Za-z_]\w*))/g))edges.push((labels.get(match[1])||match[1])+'>'+(labels.get(match[2])||match[2]));
 return [
  check('Mermaid表达材料中的七个组件',/^\s*(?:flowchart|graph)\s+(?:LR|RL|TD|TB|BT)\b/m.test(source)&&Object.keys(roles).every(r=>[...labels.values()].includes(r))),
  check('请求链路和异步通知链路方向正确',['browser>gateway','gateway>orders','orders>db','orders>cache','orders>queue','queue>notify'].every(e=>edges.includes(e)),edges),
  check('浏览器不直接访问数据库',!edges.includes('browser>db'))
 ];
}
const decodeXml=s=>s.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi,(_,hex,dec,n)=>hex?String.fromCodePoint(parseInt(hex,16)):dec?String.fromCodePoint(Number(dec)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[n]));
export function pptChecks(bytes){
 const files=zipTextFiles(bytes),names=Object.keys(files),slides=names.filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b)=>parseInt(a.match(/slide(\d+)/)[1])-parseInt(b.match(/slide(\d+)/)[1]));
 const slideText=slides.map(n=>[...strFromU8(files[n]).matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(m=>decodeXml(m[1])).join(' '));
 const s=slideText.join('\n'),presentation=strFromU8(files['ppt/presentation.xml']||new Uint8Array());
 const size=presentation.match(/<p:sldSz\b([^>]*)/),cx=Number(size?.[1].match(/\bcx=["'](\d+)/)?.[1]),cy=Number(size?.[1].match(/\bcy=["'](\d+)/)?.[1]);
 return [
  check('真实PPTX包含材料要求的四页且每页有可编辑文字',names.includes('[Content_Types].xml')&&names.includes('ppt/presentation.xml')&&slides.length===4&&slideText.every(t=>t.trim())),
  check('PPT保留试点人数与正确满意率',/青禾/.test(s)&&/120/.test(s)&&/96/.test(s)&&/84/.test(s)&&/87[.．]5\s*%/.test(s)),
  check('PPT包含问题改进及负责人截止时间',/排队/.test(s)&&/预约分流/.test(s)&&/林溪/.test(s)&&/周言/.test(s)&&date(s,2026,11,6)&&date(s,2026,11,10)),
  check('演示文稿声明四个页面引用',(presentation.match(/<p:sldId\s/g)||[]).length===4),
  check('PPT采用16比9页面尺寸',cx>0&&cy>0&&Math.abs(cx/cy-16/9)<0.01)
 ];
}
export function skillArchiveChecks(bytes){
 const files=zipTextFiles(bytes),md=files['text-brief/SKILL.md']?strFromU8(files['text-brief/SKILL.md']):'',example=files['text-brief/references/example.md']?strFromU8(files['text-brief/references/example.md']):'';
 const front=md.match(/^---\s*\n([\s\S]*?)\n---/);let meta;try{meta=front?parseDocument(front[1]).toJS():null;}catch{}
 return [
  check('真实归档包含SKILL.md及示例',Boolean(md&&example)),
  check('技能元数据名称和描述有效',meta?.name==='text-brief'&&typeof meta.description==='string'&&Boolean(meta.description.trim())),
  check('技能说明文字输入、摘要输出与事实边界',/输入|提供.{0,8}(?:文字|文本)/.test(md)&&/摘要|总结/.test(md)&&/待确认|未知|缺失|未明确/.test(md)&&/不.{0,6}(?:补造|编造|虚构)|禁止.{0,6}(?:补造|编造|虚构)|仅.{0,10}(?:原文|材料)|忠于.{0,6}(?:原文|事实)/.test(md)),
  check('示例保留金星计划延期和日期未定',/金星计划/.test(example)&&/延期|推迟/.test(example)&&/日期.{0,8}(?:待定|待确认|未确定|未明确)|尚未确定.{0,8}(?:日期|时间)/.test(example))
 ];
}

export const expectedArtifacts={5:['priority.mjs','priority.test.mjs'],6:['.github/workflows/ci.yml','README.md'],7:['architecture.mmd'],8:['text-brief.zip'],9:['clamp.mjs','clamp.test.mjs'],10:['试点复盘.pptx'],11:['index.html'],12:['poster.html'],14:['home.svg','add.svg','success.svg','视觉规范.md']};
export async function fileChecks(number,root){
 const names=expectedArtifacts[number]||[],checks=[];
 for(const name of names){try{await readArtifact(root,name,{binary:true,maxBytes:80000000});checks.push(check('真实产物存在：'+name,true));}catch(e){checks.push(check('真实产物存在：'+name,false,e.message));}}
 if(checks.some(c=>!c.pass))return checks;
 if(number===5||number===9)checks.push(...algorithmChecks(number,await readArtifact(root,names[0])));
 if(number===6)checks.push(...workflowChecks(await readArtifact(root,names[0])));
 if(number===7)checks.push(...diagramChecks(await readArtifact(root,names[0])));
 if(number===8)checks.push(...skillArchiveChecks(await readArtifact(root,names[0],{binary:true,maxBytes:80000000})));
 if(number===10)checks.push(...pptChecks(await readArtifact(root,names[0],{binary:true,maxBytes:80000000})));
 return checks;
}
