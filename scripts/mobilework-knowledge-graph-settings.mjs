import fs from 'node:fs/promises';
import path from 'node:path';
import {knowledgeFingerprint,knowledgeMultiset} from './mobilework-knowledge-reading.mjs';

const review=message=>Object.assign(Error(message),{review:true});
export const graphNodeSize=degree=>degree>50?48:degree>=26?36:degree>=11?26:degree>=4?18:12;
export function assessKnowledgeGraph(graph,observed){
 const degrees=new Map(graph.nodes.map(node=>[node.id,0]));
 for(const edge of graph.edges)for(const id of [edge.source,edge.target])degrees.set(id,(degrees.get(id)||0)+1);
 const nodes=graph.nodes.map(node=>{
  const actual=observed.nodes.find(item=>item.id===node.id),missing=!node.has_source||!node.has_content;
  const color=observed.palette[(missing?'missing':'')+(missing?(node.kind==='entity'?'Entity':'Concept'):node.kind)];
  return {id:node.id,degree:degrees.get(node.id),size:actual?.size===graphNodeSize(degrees.get(node.id)),color:!!color&&actual?.fill===color,label:observed.zoom>=.6?actual?.labelText===node.label:!actual?.labelText};
 });
 const edges=graph.edges.map(edge=>{const actual=observed.edges.find(item=>item.id===edge.id);return {id:edge.id,style:!!actual&&(edge.strength==='weak'?JSON.stringify(actual.lineDash)==='[5,5]':!actual.lineDash||actual.lineDash.length===0)};});
 return {sameIds:knowledgeMultiset(graph.nodes.map(n=>n.id))===knowledgeMultiset(observed.nodes.map(n=>n.id))&&knowledgeMultiset(graph.edges.map(e=>e.id))===knowledgeMultiset(observed.edges.map(e=>e.id)),nodes,edges,
  missingBranches:['entity','concept'].flatMap(kind=>[false,true].filter(missing=>!graph.nodes.some(node=>node.kind===kind&&(!node.has_source||!node.has_content)===missing)).map(missing=>kind+(missing?'无来源或空内容':'有来源及内容'))).concat(['strong','weak'].filter(strength=>!graph.edges.some(edge=>edge.strength===strength)),new Set([...degrees.values()].map(graphNodeSize)).size<2?['不同尺寸档位']:[])};
}

// Read the actual G6 instance held by this canvas's React ancestors. Never
// call graph setters, emit events or fabricate nodes to satisfy an assertion.
const knowledgeGraphCanvas=async page=>{
 const canvas=page.locator('aside.mw-knowledge-workspace canvas').filter({visible:true});
 if(await canvas.count()!==1)throw review('当前图谱画布未唯一识别，未猜测图谱实例');
 return canvas;
};
const readKnowledgeGraphInPage=(node,{expected,hoverId})=>{
  const ids=values=>JSON.stringify(values.map(value=>value.id).sort());let instance;
  for(let element=node;element&&!instance;element=element.parentElement){
   const key=Object.keys(element).find(key=>key.startsWith('__reactFiber$'));
   for(let fiber=key&&element[key];fiber&&!instance;fiber=fiber.return){
    for(let hook=fiber.memoizedState;hook&&typeof hook==='object';hook=hook.next){
     const value=hook.memoizedState?.current;
     if(!value||value.destroyed||typeof value.getNodeData!=='function'||typeof value.getElementRenderStyle!=='function'||typeof value.getCanvas!=='function')continue;
     const container=value.getCanvas().getContainer();
     if(container instanceof HTMLElement&&container.contains(node)&&ids(value.getNodeData())===ids(expected.nodes)&&ids(value.getEdgeData())===ids(expected.edges)){instance=value;break;}
    }
   }
  }
  if(!instance)return {supported:false};
  if(hoverId!==undefined){
   const owner=()=>{
    let element=node;while(element&&!Object.keys(element).some(key=>key.startsWith('__reactFiber$')))element=element.parentElement;
    const host=element?.[Object.keys(element).find(key=>key.startsWith('__reactFiber$'))],pending=[host,host?.alternate].filter(Boolean).map(fiber=>[fiber]),seen=new Set();
    while(pending.length){
     const chain=pending.shift(),fiber=chain.at(-1);if(seen.has(fiber))continue;seen.add(fiber);
     if(fiber.tag===3){if(fiber.stateNode.current===fiber)return chain.find(item=>item.type?.name==='fYr');continue;}
     for(const parent of [fiber.return,fiber.return?.alternate]){
      if(!parent)continue;let child=parent.child;while(child&&child!==fiber)child=child.sibling;
      if(child===fiber)pending.push([...chain,parent]);
     }
    }
   };
   const owned=()=>{const fiber=owner();for(let hook=fiber?.memoizedState;hook;hook=hook.next)if(hook.memoizedState?.current===instance)return fiber;};
   if(!owned()||typeof instance.on!=='function'||typeof instance.off!=='function')return {supported:false};
   const state={supported:true,complete:false,hoverId:null,dragId:null,draws:0,error:null};
   const drawn=()=>{
    const fiber=owned();if(!fiber){state.error='悬停绘制后本轮图谱组件归属不再匹配';return;}
    state.draws++;state.hoverId=fiber.memoizedState.memoizedState;state.dragId=fiber.memoizedState.next.memoizedState;
    if(state.hoverId===hoverId&&state.dragId===null)state.complete=true;
   };
   instance.on('afterdraw',drawn);state.dispose=()=>instance.off('afterdraw',drawn);return state;
  }

  const normalize=color=>{if(typeof color!=='string'||!color.trim()||!CSS.supports('color',color))return null;const context=document.createElement('canvas').getContext('2d');context.fillStyle=color;return context.fillStyle;};
  const css=getComputedStyle(document.documentElement),palette={};
  for(const [name,token] of Object.entries({entity:'--mw-knowledge-graph-entity',concept:'--mw-knowledge-graph-concept',missingEntity:'--mw-knowledge-graph-missing-entity',missingConcept:'--mw-knowledge-graph-missing-concept',dragRelatedEntity:'--mw-gray-4',edge:'--mw-gray-5'}))palette[name]=normalize(css.getPropertyValue(token).trim());
  const host=instance.getCanvas().getContainer(),rect=host.getBoundingClientRect();
  const nodes=expected.nodes.map(item=>{
   const style=instance.getElementRenderStyle(item.id),position=instance.getElementPosition(item.id),client=instance.getClientByCanvas(position);
   return {id:item.id,position,client,size:Array.isArray(style.size)?style.size[0]:style.size,fill:normalize(style.fill),labelText:style.labelText||'',opacity:style.opacity??1};
  });
  return {supported:true,zoom:instance.getZoom(),palette,nodes,edges:expected.edges.map(item=>{const s=instance.getElementRenderStyle(item.id);return {id:item.id,lineDash:s.lineDash,opacity:s.opacity??1,lineWidth:s.lineWidth,stroke:normalize(s.stroke)};}),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},ready:!!host.closest('.opacity-100')};
};
export async function observeKnowledgeGraph(page,graph){
 const canvas=await knowledgeGraphCanvas(page),observed=await canvas.evaluate(readKnowledgeGraphInPage,{expected:graph});
 if(!observed.supported)throw review('当前真实G6实例不提供已核实的只读观察接口，未用模型自述或模拟画布代替');
 return observed;
}

// Register before the real pointer move. Read committed hover/drag state only
// after this graph actually emits afterdraw; opacity remains a business assertion.
export async function observeKnowledgeGraphHover(page,graph,id,action){
 const canvas=await knowledgeGraphCanvas(page),observer=await canvas.evaluateHandle(readKnowledgeGraphInPage,{expected:graph,hoverId:id});let registered=false,completed;
 try{
  if(!await observer.evaluate(value=>value.supported))throw review('本轮图谱未对应已核实的悬停组件及绘制观察接口');
  registered=true;await action();completed=await page.waitForFunction(value=>value.complete||value.error,observer,{timeout:15000});
  const readiness=await observer.evaluate(({complete,hoverId,dragId,draws,error})=>({complete,hoverId,dragId,draws,error}));
  if(readiness.error)throw review(readiness.error);
  return {...await observeKnowledgeGraph(page,graph),hoverReadiness:readiness};
 }finally{
  try{if(registered)await observer.evaluate(value=>value.dispose());}finally{if(completed)await completed.dispose();await observer.dispose();}
 }
}

export function relatedKnowledgeNodes(graph,id){
 const related=new Set([id]);for(const edge of graph.edges)if(edge.source===id||edge.target===id){related.add(edge.source);related.add(edge.target);}return related;
}
export function assessGraphHighlight(graph,observed,id,mode='hover'){
 const related=relatedKnowledgeNodes(graph,id),other=observed.nodes.filter(node=>!related.has(node.id));
 if(mode==='drag'){
  const baseColor=node=>observed.palette[(!node.has_source||!node.has_content)?(node.kind==='entity'?'missingEntity':'missingConcept'):node.kind];
  const expectedColor=node=>node.id===id?baseColor(node):related.has(node.id)?(node.kind==='concept'?baseColor(node):!node.has_source||!node.has_content?observed.palette.missingEntity:observed.palette.dragRelatedEntity):observed.palette.missingEntity;
  const matching=node=>{const actual=observed.nodes.find(item=>item.id===node.id),color=expectedColor(node);return !!color&&actual?.fill===color&&actual?.opacity===1;};
  const neighbours=observed.nodes.filter(node=>node.id!==id&&related.has(node.id));
  return {related:graph.nodes.filter(node=>related.has(node.id)).every(matching),
   other:other.length>0&&other.every(node=>matching(graph.nodes.find(item=>item.id===node.id))),
   distinguishable:other.length>0&&neighbours.some(node=>node.fill!==observed.palette.missingEntity),
   edges:graph.edges.every(edge=>{const actual=observed.edges.find(item=>item.id===edge.id),incident=edge.source===id||edge.target===id,color=observed.palette[incident?'concept':'edge'];return !!color&&actual?.stroke===color&&(incident?actual?.opacity===1:actual?.opacity<1);})};
 }
 return {related:observed.nodes.filter(node=>related.has(node.id)).every(node=>node.opacity===1),other:other.length>0&&other.every(node=>node.opacity<1),edges:observed.edges.every(edge=>{const source=graph.edges.find(item=>item.id===edge.id);return (source.source===id||source.target===id)?edge.opacity===1:edge.opacity<1;})};
}
export function blankGraphPoint(observed){
 const {rect,nodes}=observed;
 for(let y=rect.y+40;y<rect.y+rect.height-170;y+=35)for(let x=rect.x+40;x<rect.x+rect.width-100;x+=35){
  if(nodes.every(node=>Math.hypot(x-node.client[0],y-node.client[1])>Math.max(30,node.size/2+18)))return {x,y};
 }
 throw review('图谱当前没有可识别的安全空白位置，未把节点拖动冒充画布拖动');
}
export function nextKnowledgeSchedule(now=new Date()){
 const at=new Date(now);at.setSeconds(0,0);at.setMinutes(at.getMinutes()+2);
 return {time:String(at.getHours()).padStart(2,'0')+':'+String(at.getMinutes()).padStart(2,'0'),at:at.toISOString()};
}
export async function knowledgeDirectoryManifest(root){
 const result=[];
 async function visit(relative){
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
   const file=path.join(relative,entry.name);if(entry.isSymbolicLink())throw review('本轮迁移材料出现链接，不能验证为独立副本');
   if(entry.isDirectory()){result.push({path:file,type:'directory'});await visit(file);}
   else result.push({path:file,type:'file',sha256:knowledgeFingerprint(await fs.readFile(path.join(root,file)))});
  }
 }
 await visit('');return result.sort((a,b)=>a.path.localeCompare(b.path));
}
export function relocatedKnowledgePath(value,from,to){
 const relative=path.relative(from,value);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)?path.join(to,relative):value;
}
