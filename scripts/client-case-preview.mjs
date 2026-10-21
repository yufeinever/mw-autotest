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
   const svgs=[],geometries=[],grids=[],styles=[];
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
    const grid=parsed.viewBox?.trim().split(/[\s,]+/).map(Number)||[];
    check(name+'可解析且包含有效坐标网格和几何',parsed.valid&&grid.length===4&&grid.every(Number.isFinite)&&grid[2]>0&&grid[3]>0&&parsed.geometry>0,parsed);
    grids.push(JSON.stringify(grid));
    await page.setContent(source);
    styles.push(await page.locator('svg').evaluate(svg=>[...svg.querySelectorAll('path,line,polyline,polygon,circle,rect,ellipse')].map(e=>{const s=getComputedStyle(e);return [s.fill,s.stroke,s.strokeWidth].join('|');}).sort().filter((x,i,a)=>a.indexOf(x)===i).join(';')));
    svgs.push(source);geometries.push(parsed.signature);
   }
   check('三类图标的几何内容互不相同',svgs.length===3&&new Set(geometries).size===3);
   check('图标使用一致网格与颜色描边风格',grids.length===3&&new Set(grids).size===1&&new Set(styles).size===1,{grids,styles});
   const spec=await readArtifact(root,'视觉规范.md');check('规范说明三类语义与视觉样式',[/导航|首页/,/操作|添加|新增/,/状态|成功|完成/,/尺寸|大小|网格|viewBox/,/线宽|描边|stroke/,/颜色|配色|currentColor/].every(p=>p.test(spec)));
   if(checks.every(c=>c.pass)){
    await page.setContent('<html><body style="display:flex;gap:50px;padding:50px;color:#163849">'+svgs.map(s=>'<div style="width:150px;height:150px">'+s+'</div>').join('')+'</body></html>');
    await recordPreview(page,'图标真实产物预览');
   }
  }else{
   const source=await readArtifact(root,number===11?'index.html':'poster.html');
   await page.setContent(source,{waitUntil:'domcontentloaded'});
   if(number===11){
    const nav=await page.locator('nav,[role="navigation"],header').allTextContents();
    check('网站包含书房名称与导航模块',(await page.locator('body').innerText()).includes('青禾共享书房')&&['首页','活动','联系'].every(w=>nav.some(t=>t.includes(w))));
    const search=page.locator('input[type="search"],input[aria-label*="搜索"],input[placeholder*="搜索"]').filter({visible:true}),category=page.getByRole('combobox').filter({has:page.locator('option').filter({hasText:'技术'})});
    const visibleBooks=async()=>{const found=[];for(const name of ['JavaScript基础','城市散步','Python入门'])if(await page.getByText(name,{exact:true}).filter({visible:true}).count())found.push(name);return found;};
    check('搜索和分类控件可操作',await search.count()===1&&await category.count()===1);
    check('默认显示材料中的三本书',(await visibleBooks()).length===3);
    await category.selectOption({label:'技术'});check('选择技术后仅显示技术书',JSON.stringify(await visibleBooks())===JSON.stringify(['JavaScript基础','Python入门']));
    await search.fill('Python');check('搜索与分类组合只留下Python入门',JSON.stringify(await visibleBooks())===JSON.stringify(['Python入门']));
    await search.fill('');await category.selectOption({label:'全部'});check('清空筛选后恢复全部三本',(await visibleBooks()).length===3);
   }else{
    const text=await page.locator('body').innerText();
    check('海报保留活动、时间地点、费用和参与方式',[/周末读书交换会/,/青禾书房.{0,3}(?:一楼|1楼|1F)/,/免费|无需费用|不收.{0,3}费/,/携带|带上|自带/,/书/,/2026/,/11(?:月|[-/.])0?7/,/14[:：]00|14时|14点|下午\s*(?:2|两|二)(?:点|时)/].every(p=>p.test(text)));
    const heading=page.getByText('周末读书交换会',{exact:false}).filter({visible:true});
    check('海报有可见的活动主标题',await heading.count()>0);
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
