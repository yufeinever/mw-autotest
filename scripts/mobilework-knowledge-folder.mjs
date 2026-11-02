import {selectNativeFolder,completeNativeFolder} from './mobilework-native-folder.mjs';
import {sameKnowledgePath,sourceAdditionApplied} from './mobilework-knowledge-resources.mjs';

export async function addOwnedKnowledgeSource(context,call,created,folder,open){
 const {page,resources,control,dir,log}=context,owned=resources.knowledgeCreation;
 owned.sourceAdd={path:folder,before:[...created.source_dir],state:'picking'};
 await context.checkpointResources();
 const [responseResult,selectionResult]=await Promise.allSettled([
  page.waitForResponse(response=>{
   if(response.request().method()!=='POST'||new URL(response.url()).pathname!=='/knowledge/add_source')return false;
   const request=response.request().postDataJSON();
   return request.id===created.id&&typeof request.source_dir==='string'&&sameKnowledgePath(request.source_dir,folder);
  },{timeout:60000}),
  selectNativeFolder(page,{folder,dir,control,log,open,deferCompletion:true,beforeConfirm:async()=>{
   owned.sourceAdd.state='submitted';await context.checkpointResources();
  }})
 ]);
 if(selectionResult.status==='rejected')throw selectionResult.reason;
 if(responseResult.status==='rejected')throw responseResult.reason;
 const response=responseResult.value,body=await response.json();
 if(!response.ok()||body.success!=='true'){
  owned.sourceAdd.state='rejected';await context.checkpointResources();
  await completeNativeFolder(control,selectionResult.value.ownership);
  throw Error('知识库添加源目录失败：HTTP '+response.status());
 }
 const current=await call('/knowledge/'+created.id);
 if(current.id!==created.id||!sourceAdditionApplied(current,owned.sourceAdd))throw Error('源目录添加请求成功但持久状态尚未确认');
 owned.sourceAdd.state='completed';await context.checkpointResources();
 await completeNativeFolder(control,selectionResult.value.ownership);
 return {response,body,current};
}
