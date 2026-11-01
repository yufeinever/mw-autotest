import fs from 'node:fs/promises';
import path from 'node:path';
import {modelTrigger,readModelOptions,restoreHomeModel,selectModel,waitStep} from './mobilework-run-policy.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function runHomeModelSteps(context){
 const {page,config,resources,remaining,control}=context;
 return control.withUI(page,'VERIFYING',async()=>{
  const gaps=[];
  const before=await readModelOptions(page,config),selected=before.models.filter(model=>model.selected);
  if(selected.length!==1||!selected[0].name||typeof selected[0].value!=='string'||!selected[0].value)throw blocked('当前模型的唯一选中项或身份不可读取，未切换模型');
  const owned={restore:selected[0].name,value:selected[0].value};
  resources.homeModel=owned;
  let operationError,restoreError;
  try{
   await context.checkpointResources();
   const descriptions=await page.evaluate(async()=>{
    const result=await window.__MOBILEWORK__.invoke('models:list');
    return (result.models||[]).filter(item=>item.officialRemote&&item.featureDesc?.trim()).map(item=>({id:item.id,modelId:item.modelId,description:item.featureDesc.trim()}));
   });
   const matchDescription=model=>descriptions.find(item=>model.value?.toLowerCase().includes(JSON.stringify([item.id,item.modelId]).toLowerCase()));
   const candidates=before.models.filter(model=>!model.disabled&&before.models.filter(item=>item.name===model.name).length===1);
   const described=candidates.find(model=>model.name!=='自动'&&matchDescription(model));
   const target=candidates.find(model=>model.name!=='自动'&&model.value!==owned.value)||candidates.find(model=>model.value!==owned.value);
   const trigger=await modelTrigger(page);
   await waitStep(page,config);await trigger.click();
   const menu=page.getByRole('listbox').filter({visible:true});
   let menuError;
   try{
    await menu.waitFor({timeout:5000});
    const groups=await menu.locator('[data-slot="command-group"]').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>({
     label:node.querySelector('[data-slot="command-group-label"]')?.textContent?.trim()||'',
     options:[...node.querySelectorAll('[role="option"] span.truncate')].map(item=>item.textContent.trim())
    })));
    await fs.writeFile(path.join(context.dir,'模型面板实际观察.json'),JSON.stringify({current:before.current,models:before.models.map(({name,selected,disabled})=>({name,selected,disabled})),groups},null,2));
    await context.capture('模型面板及分组');
    context.assert('模型列表展示自动项',before.models.some(model=>model.name==='自动'));
    context.assert('模型列表只有一个选中项',selected.length===1,selected.map(item=>item.name));
    if(selected[0].name!==before.current)gaps.push('工具栏与选中项名称不同，模型显示别名对应关系未确认');
    const series=groups.some(group=>/(?:系列|Series)$/i.test(group.label)&&group.options.length);
    const custom=groups.some(group=>/^(?:自定义模型|Custom Models)$/i.test(group.label)&&group.options.length);
    if(series&&custom&&selected.length===1)remaining.delete('模型面板、自动项与分类');
    else gaps.push('当前未同时观察到含模型的系列与自定义分组');
    if(described){
     const row=menu.getByRole('option').filter({has:page.getByText(described.name,{exact:true})}).filter({visible:true});
     if(await row.count()!==1)gaps.push('含简介模型的实际选项未唯一识别');
     else{
      await row.hover();
      const tip=page.locator('[data-slot="tooltip-content"]').filter({visible:true}).filter({hasText:matchDescription(described).description});
      try{
       await tip.waitFor({timeout:3000});
       const itemBox=await row.boundingBox(),tipBox=await tip.boundingBox();
       await context.capture('模型悬停简介');
       context.assert('悬停展示对应模型真实简介',(await tip.innerText()).includes(matchDescription(described).description));
       if(itemBox&&tipBox&&tipBox.x>=itemBox.x+itemBox.width-2)remaining.delete('模型悬停简介');
       else gaps.push('模型简介已展示，右侧位置未确认');
      }catch(error){
       if(error.name!=='TimeoutError')throw error;
       gaps.push('含简介模型悬停后未能识别对应提示');
      }
     }
    }else gaps.push('当前没有可匹配的官方模型简介，悬停分支未验证');
   }catch(error){menuError=error;}
   try{if(await menu.isVisible())await page.keyboard.press('Escape');}
   catch(error){
    if(menuError)throw blocked(menuError.message+'；关闭模型面板失败：'+error.message);
    throw error;
   }
   if(menuError)throw menuError;
   if(target){
    await selectModel(page,target.name,config);
    const switched=await readModelOptions(page,config);
    context.assert('切换后目标模型真实选中',switched.models.some(model=>model.name===target.name&&model.selected));
    await context.capture('目标模型切换完成');
    remaining.delete('切换选中与面板自动关闭');
   }else gaps.push('当前没有可唯一切换的其他模型');
  }catch(error){operationError=error;}
  try{
   const menu=page.getByRole('listbox').filter({visible:true});
   if(await menu.count()===1)await page.keyboard.press('Escape');
   await restoreHomeModel(page,owned,config);
   delete resources.homeModel;await context.checkpointResources();
   remaining.delete('恢复原模型');
  }catch(error){restoreError=error;}
  if(restoreError){
   const detail=(operationError?operationError.message+'；':'')+'恢复原模型失败：'+restoreError.message;
   throw Object.assign(blocked(detail),{cause:operationError||restoreError});
  }
  if(operationError)throw operationError;
  gaps.push('原表仅在描述中提及名称限制和自定义模型跳转，未定义操作及预期');
  if(gaps.length)throw review(gaps.join('；'));
 });
}
