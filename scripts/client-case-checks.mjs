import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {parseDocument} from 'yaml';
import {unzipSync,strFromU8} from 'fflate';

const check=(name,pass,actual)=>({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});
const compact=s=>s.replace(/[\s*`_]/g,'');
const date=(s,y,m,d)=>new RegExp(y+'(?:年|[-/.])0?'+m+'(?:月|[-/.])0?'+d+'(?:日|\\b)').test(compact(s));
export function reportJson(text,key){
 for(const match of [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].reverse()){
  try{const value=JSON.parse(match[1]);if(value&&Object.hasOwn(value,key))return value;}catch{}
 }
 return null;
}
export function textChecks(number,text){
 const s=compact(text);
 if(number===3)return [
  check('邮件包含主题、收件人与署名',/主题/.test(text)&&/星桥项目/.test(text)&&/项目组/.test(text)&&/许晴/.test(text)),
  check('说明评审由14时调整到15时30分',/14[:：]00|14时|14点/.test(text)&&/15[:：]30|15时30|15点30/.test(text)&&/调整|改为|变更|更改/.test(text)&&date(text,2026,11,3)),
  check('保留会议地点及反馈截止时间',/三楼A会议室|3楼A会议室/.test(text)&&date(text,2026,11,2)&&/18[:：]00|18时|18点/.test(text)&&/反馈|回复/.test(text))
 ];
 if(number===4)return [
  check('公文包含通知标题、受文对象和落款',/关于开展办公设备盘点的通知/.test(text)&&/各部门/.test(text)&&/星桥科技综合管理部/.test(text)&&date(text,2026,11,2)),
  check('盘点范围和登记字段完整',['电脑','显示器','打印机','资产编号','使用人','设备状态'].every(w=>text.includes(w))),
  check('提交时间、联系人及异常说明完整',date(text,2026,11,6)&&/17[:：]00|17时|17点/.test(text)&&/赵宁/.test(text)&&/803/.test(text)&&/丢失/.test(text)&&/损坏/.test(text))
 ];
 if(number===13){
  const data=reportJson(text,'concepts'),items=data?.concepts||[];
  return [
   check('输出三个不同名称和人群的完整概念',Array.isArray(items)&&items.length===3&&new Set(items.map(x=>x.name)).size===3&&new Set(items.map(x=>x.userGroup)).size===3&&['上班族','儿童家庭','老年居民'].every(g=>items.some(x=>x.userGroup===g))),
   check('每个概念包含具体场景、功能和差异化',items.length===3&&items.every(x=>typeof x.scene==='string'&&x.scene.length>=10&&Array.isArray(x.coreFeatures)&&x.coreFeatures.length>=2&&x.coreFeatures.every(f=>typeof f==='string'&&f.length>=4)&&typeof x.differentiation==='string'&&x.differentiation.length>=10)),
   check('三个方案的场景、功能与亮点不重复',items.length===3&&['scene','differentiation'].every(k=>new Set(items.map(x=>x[k])).size===3)&&new Set(items.map(x=>JSON.stringify(x.coreFeatures))).size===3)
  ];
 }
 if(number===15){
  const data=reportJson(text,'products'),items=data?.products||[];
  const primary=(name,value)=>{try{const u=new URL(value),h=u.hostname.toLowerCase();if(u.protocol!=='https:')return false;
   const hosts=/codex/i.test(name)?['openai.com']: /claude/i.test(name)?['anthropic.com','claude.com','claude.ai']:['workbuddy.cn','tencent.com','tencent.cn','tencentcloud.com'];
   return hosts.some(d=>h===d||h.endsWith('.'+d))||(/codex/i.test(name)&&h==='github.com'&&u.pathname.startsWith('/openai/'));
  }catch{return false;}};
  return [
   check('研究比较三种指定产品',Array.isArray(items)&&items.length===3&&['Codex','Claude Code','WorkBuddy'].every(n=>items.some(x=>x.name?.toLowerCase()===n.toLowerCase()))),
   check('每种产品覆盖功能、易用性、价格、案例与优劣势',items.length===3&&items.every(x=>['features','usability','pricing','useCase','pros','cons'].every(k=>typeof x[k]==='string'&&x[k].trim().length>=4))),
   check('每种产品包含对应的官方HTTPS来源',items.length===3&&items.every(x=>Array.isArray(x.sources)&&x.sources.some(u=>primary(x.name,u)))),
   check('结论回应团队选型需求',typeof data?.recommendation==='string'&&data.recommendation.length>=30&&/Windows|权限|审查|成本|预算|团队/.test(data.recommendation))
  ];
 }
 if(number===16){
  const data=reportJson(text,'recommended'),good=data?.recommended||[],bad=data?.excluded||[];
  return [
   check('仅推荐满足硬条件的A、B两款',Array.isArray(good)&&good.length===2&&good.map(x=>x.id).sort().join(',')==='A,B'&&good.every(x=>typeof x.reason==='string'&&x.reason.length>=5)),
   check('剔除C的预算、D的重量、E的容量问题',Array.isArray(bad)&&bad.length===3&&bad.some(x=>x.id==='C'&&/预算|价格|8000|8999/.test(x.reason))&&bad.some(x=>x.id==='D'&&/重量|1[.．]65|1[.．]4|超重/.test(x.reason))&&bad.some(x=>x.id==='E'&&/内存|SSD|存储|容量|8GB|256GB/.test(x.reason))),
   check('明确虚构商品并未生成购买链接',/虚构/.test(data?.note||'')&&!/https?:\/\//i.test(text))
  ];
 }
 return [check('最终回复说明本场景交付结果',s.length>=30)];
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
 const edges=[...source.matchAll(/\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*-->\s*([A-Za-z_]\w*)/g)].map(m=>m[1]+'>'+m[2]);
 return [
  check('Mermaid包含七个规定节点及标签',/^\s*flowchart\s+LR\b/m.test(source)&&Object.entries({browser:'浏览器',gateway:'API网关',orders:'订单服务',db:'PostgreSQL',cache:'Redis',queue:'消息队列',notify:'通知服务'}).every(([n,label])=>new RegExp('\\b'+n+'\\s*\\[\\s*"?'+label+'"?\\s*\\]').test(source))),
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
  check('真实PPTX包含四页且每页有可编辑文字',names.includes('[Content_Types].xml')&&names.includes('ppt/presentation.xml')&&slides.length===4&&slideText.every(t=>t.trim().length>5)),
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
  check('技能元数据名称和描述有效',meta?.name==='text-brief'&&typeof meta.description==='string'&&meta.description.length>=8),
  check('技能说明输入输出与禁止补造信息',/输入/.test(md)&&/摘要/.test(md)&&/待确认/.test(md)&&/不(?:得|要)?(?:补造|编造)|禁止(?:补造|编造)/.test(md)),
  check('示例保留金星计划延期和日期待定',/金星计划/.test(example)&&/延期/.test(example)&&/日期待定|日期.*未确定/.test(example))
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
