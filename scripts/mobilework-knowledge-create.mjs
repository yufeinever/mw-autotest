import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {knowledgeClient} from './mobilework-knowledge-api.mjs';
import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {ownedKnowledgeCandidate,sameKnowledgePath} from './mobilework-knowledge-resources.mjs';
import {reloadOwnedModule} from './mobilework-module-navigation.mjs';
import {finishKnowledgeGuide} from './mobilework-knowledge-guide.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const fingerprint=bytes=>createHash('sha256').update(bytes).digest('hex');
async function prepareSources(dir){
 const source=path.join(dir,'本轮知识源'),names=['会议纪要.docx','任务台账.xlsx','项目简报.pptx','项目进度.pdf'];
 await fs.mkdir(source,{recursive:true});
 for(const name of names)await fs.copyFile(path.resolve('scripts/fixtures/client-upload-files',name),path.join(source,name));
 await fs.writeFile(path.join(source,'海棠项目报告.md'),'# 海棠知识库验收报告\n\n合成项目：海棠115。负责人林澈，预算48000元。\n\n登录、搜索、导出已验收，权限待复核。请保留该风险，不将部分通过说成全部通过。\n');
 return {source,hashes:Object.fromEntries(await Promise.all((await fs.readdir(source)).map(async name=>[name,fingerprint(await fs.readFile(path.join(source,name)))])))};
}


export async function createManagedKnowledge(context,{resourceKey='knowledgeCreation'}={}){
 const {number,page,resources,dir,remaining,assert,capture,checkpointResources,control,log}=context;
 await fs.mkdir(dir,{recursive:true});
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)),done=step=>remaining.delete(step);
 const call=await knowledgeClient(page),before=await call('/knowledge/list'),defaultRoot=(await call('/knowledge/default_storage_root')).default_storage_root;
 const name='MW-Autotest-KB-'+number+'-'+randomUUID().slice(0,8),outer=number===115;
 const fixture=outer?await prepareSources(dir):null,storageDir=outer?path.join(dir,'本轮Wiki存储'):path.join(defaultRoot,name);
 resources.moduleNavigation??={originUrl:page.url(),targetHash:'#/knowledge'};
 resources[resourceKey]={name,beforeIds:before.map(item=>item.id),storageDir,sourceDir:fixture?.source||null,submitted:false,...(number>=117?{renamedName:name+'-改名',id:null,removing:false}:{})};
 await checkpointResources();
 if(new URL(page.url()).hash==='#/knowledge')await reloadOwnedModule(page,resources);
 else{await button(page,'知识库').click();await button(page,'管理知识库').click();await page.waitForURL(url=>url.hash==='#/knowledge');}
 const entry=page.locator('[data-knowledge-guide="entry"]');await entry.waitFor();
 const entryButtons=entry.getByRole('button');
 if(await entryButtons.count()!==2)throw blocked('知识中心创建/本地关联入口已变化，未猜测点击');
 await entryButtons.nth(outer?1:0).click();
 const nameInput=page.getByRole('textbox',{name:'知识库名称',exact:true});
 await finishKnowledgeGuide(page,nameInput,{capture,log});
 await nameInput.fill(name);
 if(outer){
  for(const [field,folder] of [['source',fixture.source],['wiki',storageDir]]){
   const row=page.locator('[data-knowledge-guide="'+field+'"]');
   await selectNativeFolder(page,{folder,dir,control,log,open:()=>row.getByRole('button').click()});
   await page.waitForFunction(({field,folder})=>[...document.querySelectorAll('[data-knowledge-guide="'+field+'"] [title]')].some(node=>node.title.replaceAll('\\','/').toLowerCase()===folder),{field,folder:folder.replaceAll('\\','/').toLowerCase()});
  }
 }else{
  const shown=page.locator('[data-knowledge-guide="storage"] p[title]');await shown.waitFor();
  assert('系统默认位置与实际默认根目录及本轮名称一致',sameKnowledgePath(await shown.getAttribute('title'),storageDir));
 }
 await capture(outer?'源目录和Wiki原生选择已回显':'系统默认知识库存储位置');done('真实创建表单与本轮路径');
 resources[resourceKey].submitted=true;await checkpointResources();
 const [response]=await Promise.all([page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/knowledge/create'&&value.request().postDataJSON().name===name),page.locator('button[data-knowledge-guide="create"]').click()]);
 const payload=response.request().postDataJSON(),body=await response.json();
 await save('知识库真实创建请求结果.json',{request:payload,response:body});
 if(!response.ok()||body.success!=='true'){
  resources[resourceKey].submitted=false;await checkpointResources();
  throw Error('知识库创建服务拒绝本轮请求：HTTP '+response.status());
 }
 const created=ownedKnowledgeCandidate(await call('/knowledge/list'),resources[resourceKey]);
 assert('真实UI创建唯一新库且模式与实际路径一致',!!created&&payload.create_mode===(outer?'outer':'inner')&&(outer?sameKnowledgePath(payload.source_dir,fixture.source)&&sameKnowledgePath(payload.wiki_dir,storageDir):!payload.storage_dir));
 await save('本轮知识库实际记录.json',created);
 if(number>=117){resources[resourceKey].id=created.id;await checkpointResources();}
 const expected=['knowledge/raw','knowledge/memory','knowledge/wiki','knowledge/wiki/concepts','knowledge/wiki/entities','knowledge/wiki/sources',...(outer?[]:['information','resource'])],directoryChecks=[];
 for(const relative of expected)directoryChecks.push({relative,isDirectory:(await fs.stat(path.join(storageDir,relative))).isDirectory()});
 await save('系统实际初始化目录.json',directoryChecks);
 assert('系统真实生成当前版本知识目录结构',directoryChecks.every(item=>item.isDirectory));
 assert('系统源目录和Wiki关联正确',sameKnowledgePath(created.wiki_dir,path.join(storageDir,'knowledge'))&&(outer?created.source_dir.length===1&&sameKnowledgePath(created.source_dir[0],fixture.source):JSON.stringify(created.source_dir.map(p=>path.basename(p)).sort())===JSON.stringify(['information','resource'])));
 assert('新库默认未开启定时解析',created.open_update===false);done('创建请求持久化与初始化目录');
 return {call,created,name,fixture,storageDir,outer,entry};
}
