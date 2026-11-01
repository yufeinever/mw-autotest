import fs from 'node:fs/promises';
import path from 'node:path';
import {openSettings,releaseSettingsPanel} from './mobilework-account-settings.mjs';
import {releaseAccountExternal} from './mobilework-account-external.mjs';
import {prepareHelpExternal,observeHelpExternal} from './mobilework-help-external.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});

export async function runHelpFeedbackSteps(context){
 if(context.number!==199)throw Error('帮助文档步骤只支持199');
 return context.control.withUI(context.page,'VERIFYING',async()=>{
  const owned=await prepareHelpExternal(context),panel=await openSettings(context,'help');
  const item=panel.getByText('帮助文档',{exact:true}).locator('xpath=../..');
  if(await item.count()!==1||await item.getByRole('button',{name:'打开',exact:true}).count()!==1)throw blocked('帮助文档入口无法唯一定位');
  await context.capture('帮助文档入口');
  owned.submitted=true;await context.checkpointResources();
  await item.getByRole('button',{name:'打开',exact:true}).click();
  const facts=await observeHelpExternal(context);
  await fs.writeFile(path.join(context.dir,'帮助文档页面观察.json'),JSON.stringify(facts,null,2));
  if(facts.authRequired)throw blocked('帮助文档页面要求登录，尚未验证文档内容');
  context.assert('帮助文档页面已打开且未显示错误',!facts.failed&&facts.bodyLength>=30);
  context.remaining.delete('帮助入口与真实页面');
  const missing=Object.entries(facts.categories).filter(([,found])=>!found).map(([name])=>name);
  if(missing.length||facts.contentLength<80)throw review('帮助页已打开，但文档正文或分类未完整识别：'+(missing.join('、')||'正文不足'));
  context.remaining.delete('帮助文档正文及四类目录');
  await releaseAccountExternal(context.resources);await releaseSettingsPanel(context.page,context.resources);await context.checkpointResources();
 });
}
