import {chromium} from 'playwright-core';
import {readArtifact} from './client-case-checks.mjs';
import {previewBrowserOptions} from '../local-console/environment.mjs';

export async function previewChecks(number,root,recordPreview){
 if(![11,12,14].includes(number))return [];
 const checks=[],check=(name,pass,actual)=>checks.push({name,pass:Boolean(pass),...(actual?{actual}:{})});
 const browser=await chromium.launch(previewBrowserOptions());
 try{
  const context=await browser.newContext({viewport:{width:1200,height:900}}),external=[],errors=[];
  await context.route('**/*',route=>{external.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
  if(number===14){
   const svgs=[],geometries=[];
   for(const name of ['home.svg','add.svg','success.svg']){
    const source=await readArtifact(root,name);
    const active=/<(?:script|foreignObject|image)\b|\bon\w+\s*=|\b(?:href|xlink:href)\s*=\s*["'](?!#)|url\s*\(/i.test(source);
    check(name+'仅包含独立矢量内容',!active);
    if(active)continue;
    const parsed=await page.evaluate(source=>{
     const xml=new DOMParser().parseFromString(source,'image/svg+xml'),svg=xml.documentElement;
     const shapes=[...svg.querySelectorAll('path,line,polyline,polygon,circle,rect,ellipse')];
     const attrs=['d','points','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','width','height','transform'];
     return {valid:!xml.querySelector('parsererror')&&svg.localName==='svg'&&svg.namespaceURI==='http://www.w3.org/2000/svg',viewBox:svg.getAttribute('viewBox'),geometry:shapes.length,signature:JSON.stringify(shapes.map(e=>[e.localName,...attrs.map(a=>e.getAttribute(a)?.replace(/\s+/g,' ').trim()||'')]))};
    },source);
    check(name+'可解析且采用24px网格',parsed.valid&&parsed.viewBox?.trim().replace(/\s+/g,' ')==='0 0 24 24'&&parsed.geometry>0,parsed);
    check(name+'使用统一颜色与线宽',/currentColor/.test(source)&&/(?:stroke-width\s*=\s*["']2["']|stroke-width\s*:\s*2(?:px)?\b)/.test(source));
    svgs.push(source);geometries.push(parsed.signature);
   }
   check('三类图标的几何内容互不相同',svgs.length===3&&new Set(geometries).size===3);
   const spec=await readArtifact(root,'视觉规范.md');check('规范涵盖导航、操作、状态与样式',['导航','操作','状态','尺寸','线宽','颜色'].every(w=>spec.includes(w)));
   if(checks.every(c=>c.pass)){
    await page.setContent('<html><body style="display:flex;gap:50px;padding:50px;color:#163849">'+svgs.map(s=>'<div style="width:150px;height:150px">'+s+'</div>').join('')+'</body></html>');
    await recordPreview(page,'图标真实产物预览');
   }
  }else{
   const source=await readArtifact(root,number===11?'index.html':'poster.html');
   await page.setContent(source,{waitUntil:'domcontentloaded'});
   if(number===11){
    const nav=await page.getByRole('navigation').allTextContents();
    check('网站包含书房名称与导航模块',await page.getByText('青禾共享书房',{exact:true}).count()>0&&['首页','活动','联系'].every(w=>nav.some(t=>t.includes(w))));
    const search=page.getByRole('searchbox',{name:'搜索书籍',exact:true}),category=page.getByRole('combobox',{name:'分类',exact:true}),cards=page.locator('[data-book]').filter({visible:true});
    check('默认显示三本书',await cards.count()===3);
    await category.selectOption({label:'技术'});check('选择技术后只显示两本技术书',await cards.count()===2&&!(await cards.allTextContents()).some(t=>t.includes('城市散步')));
    await search.fill('Python');check('搜索与分类组合只留下Python入门',await cards.count()===1&&(await cards.innerText()).includes('Python入门'));
    await search.fill('');await category.selectOption({label:'全部'});check('清空筛选后恢复全部三本',await cards.count()===3);
   }else{
    const text=await page.locator('body').innerText();
    check('海报包含完整活动信息',['周末读书交换会','青禾书房一楼','免费','一本可交换的书'].every(w=>text.includes(w))&&/2026/.test(text)&&/11(?:月|[-/.])0?7/.test(text)&&/14[:：]00|14时|14点/.test(text));
    const heading=page.getByRole('heading',{name:'周末读书交换会',exact:true});
    check('海报有可见的主标题及字号层级',await heading.count()===1&&await heading.isVisible()&&await heading.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=24));
    check('海报未嵌入脚本或交互事件',!/<script\b|\bon\w+\s*=/i.test(source));
   }
   await page.setViewportSize({width:375,height:900});
   check('375px视口无横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   check('离线页面无外部依赖和脚本错误',external.length===0&&errors.length===0,{external,errors});
   await recordPreview(page,number===11?'网站真实产物预览':'海报真实产物预览');
  }
 }catch(error){check('真实产物渲染及交互验证',false,error.message);}
 finally{await browser.close();}
 return checks;
}
