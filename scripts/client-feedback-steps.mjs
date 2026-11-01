import fs from 'node:fs/promises';
import path from 'node:path';
import {isAccountExternalUrl} from '../local-console/client-connection.mjs';
import {openSettings,releaseSettingsPanel} from './mobilework-account-settings.mjs';
import {releaseAccountExternal} from './mobilework-account-external.mjs';
import {prepareFeedbackExternal,connectFeedbackExternal} from './mobilework-feedback-external.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const safeError=error=>String(error.message||error.name||'未知错误').split(/\r?\n/)[0]
 .replace(/(?:https?|wss?):\/\/\S+/gi,'[地址已隐藏]')
 .replace(/\?\S+/g,'[查询参数已隐藏]')
 .replace(/\b(?:token|ticket|access_token|refresh_token|id_token|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'[凭证已隐藏]');

async function prepareFields(frame){
 const title=frame.locator('#title'),product=frame.locator('#relateproduct'),category=frame.locator('.onea.oneacheck');
 await title.fill('自动化测试草稿：反馈内容校验');
 if(!await product.inputValue()||await category.count()!==1)throw blocked('反馈表单的关联产品或建议类别尚未就绪');
 const province=frame.locator('#province');
 if(await frame.locator('#provincetr').isVisible()&&!await province.inputValue()){
  const choice=await frame.locator('#provinceTrigger').evaluate(()=>window.gdadd?.provinceTree?.flatMap(item=>(item.child||[]).map(child=>({parent:item.title,child:child.title}))).find(item=>item.parent&&item.child));
  if(!choice)throw blocked('反馈来源没有可选的真实数据');
  await frame.locator('#provinceTrigger').click();
  await frame.locator('.casc-search-input').fill(choice.child);
  const option=frame.locator('.casc-result-item').filter({hasText:choice.parent}).filter({hasText:choice.child}).filter({visible:true});
  if(await option.count()!==1)throw blocked('反馈来源候选不能唯一确认');
  await option.click();
  if(!await province.inputValue())throw blocked('反馈来源选择后未回填');
 }
 const extra=frame.locator('#provinceextra');
 if(await frame.locator('#extradiv').isVisible()&&!await extra.inputValue()){
  await frame.locator('#extradiv .select2-selection').click();
  const options=frame.locator('.select2-results__option:not([aria-disabled="true"])').filter({visible:true}).filter({hasNotText:/请选择/});
  if(!await options.count())throw blocked('反馈来源拓展没有可选的真实数据');
  await options.first().click();
  if(!await extra.inputValue())throw blocked('反馈来源拓展选择后未回填');
 }
 return {
  product:await product.locator('option:checked').innerText(),
  category:(await category.innerText()).trim(),
  source:await frame.locator('#provincetr').isVisible()?(await frame.locator('#provinceTrigger .casc-text').innerText()).trim():null,
  sourceExtra:await frame.locator('#extradiv').isVisible()?await extra.locator('option:checked').innerText():null
 };
}

async function checkContent(context,page,frame){
 for(const item of page.frames())if(await item.evaluate(()=>Boolean(navigator.serviceWorker?.controller)))throw blocked('反馈页面由Service Worker控制，无法确认提交拦截');
 let submissions=0;
 const guard=route=>{
  const request=route.request(),pathname=new URL(request.url()).pathname;
  if(!['GET','HEAD','OPTIONS'].includes(request.method())||['/upe_web/finedo/upe/api/transition','/cmit/order/add'].includes(pathname)){submissions++;return route.abort();}
  return route.continue();
 };
 await page.route('**/*',guard);
 try{
  const editor=frame.locator('#content .ql-editor'),hint=frame.locator('#span2'),submit=frame.locator('input[type="button"][value="提交"]');
  if(await hint.count()!==1||await submit.count()!==1)throw blocked('反馈正文校验控件无法唯一识别');
  await editor.fill('');await submit.click();
  if(!await hint.isVisible()&&await frame.locator('#span1:visible,#span3:visible,#span4:visible,#provincetip:visible,#provinceextratip:visible').count())throw blocked('反馈正文前仍有未满足的必填条件');
  context.assert('空反馈显示正文必填提示',await hint.isVisible()&&/内容/.test(await hint.innerText())&&/输入|填写|必填|为空/.test(await hint.innerText()));
  context.assert('空反馈未发起工单创建请求',submissions===0);
  await context.captureElement(frame.locator('.new-pj-textabc'),'空反馈正文校验');
  context.remaining.delete('空反馈内容真实拦截与提示');
  const text='测'.repeat(1001);await editor.fill(text);
  const actual=await editor.innerText();
  if(!actual||!/^测+$/.test(actual.trim()))throw blocked('超长反馈输入未能回读');
  if(actual.trim().length<=1000){
   context.assert('超长反馈被输入控件限制',actual.trim().length<text.length);
  }else{
   await submit.click();
   context.assert('超长反馈显示长度提示',await hint.isVisible()&&/超过|长度|字数|1000/.test(await hint.innerText()));
  }
  context.assert('超长反馈未发起工单创建请求',submissions===0);
  await context.captureElement(frame.locator('.new-pj-textabc'),'超长反馈正文校验');
  context.remaining.delete('超长反馈内容真实限制或拦截');
 }finally{await page.unroute('**/*',guard);}
}

export async function runFeedbackSteps(context){
 if(![200,201].includes(context.number))throw Error('反馈步骤只支持200和201');
 return context.control.withUI(context.page,'VERIFYING',async()=>{
  const owned=await prepareFeedbackExternal(context),panel=await openSettings(context,'help');
  const item=panel.getByText('意见反馈',{exact:true}).locator('xpath=../..');
  if(await item.count()!==1||await item.getByRole('button',{name:'提交',exact:true}).count()!==1)throw blocked('意见反馈入口无法唯一定位');
  await context.captureElement(item,'意见反馈入口');
  owned.submitted=true;await context.checkpointResources();
  await item.getByRole('button',{name:'提交',exact:true}).click();
  const {browser,page}=await connectFeedbackExternal(context);
  try{
   await page.locator('#gdadditem').click();
   const frame=page.frameLocator('#iframeid');
   await frame.locator('#title').waitFor();
   const frameMatches=await frame.locator('#title').evaluate((element,origin)=>location.origin===origin&&location.pathname==='/pjcustomer/pjcust/order/gdadd.html',owned.origin);
   if(!frameMatches||!isAccountExternalUrl(page.url(),owned))throw blocked('反馈表单地址与本轮页面归属不一致');
   context.assert('本轮反馈页面实际打开表单',await frame.locator('#content .ql-editor').count()===1);
   context.remaining.delete('真实反馈入口与表单');
   const fields=await prepareFields(frame);
   await fs.writeFile(path.join(context.dir,'反馈表单选择.json'),JSON.stringify(fields,null,2));
   if(context.number===200){
    const draft='这是自动化测试草稿，用于确认意见反馈表单；不会提交工单。';
    await frame.locator('#content .ql-editor').fill(draft);
    context.assert('合成反馈草稿及必填项实际回读',Boolean(fields.product&&fields.category)&&await frame.locator('#title').inputValue()==='自动化测试草稿：反馈内容校验'&&(await frame.locator('#content .ql-editor').innerText()).trim()===draft);
    await context.captureElement(frame.locator('.new-pj-textabc'),'合成反馈草稿');
    context.remaining.delete('有效反馈草稿及必填校验');
    throw blocked('已准备合成草稿；真实提交将创建外部工单，尚未获得提交授权');
   }
   await checkContent(context,page,frame);
  }catch(error){
   if(error.blocked||error.review||error.message.startsWith('断言失败：'))throw error;
   throw Error('反馈表单执行失败：'+safeError(error));
  }finally{await browser.close();}
  await releaseAccountExternal(context.resources);await releaseSettingsPanel(context.page,context.resources);await context.checkpointResources();
 });
}
