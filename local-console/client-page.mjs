// Match only the application document, never a URL embedded in another page.
export function isClientPageUrl(value){
 if(typeof value!=='string')return false;
 try{
  const url=new URL(value);
  if(url.protocol==='mobilework-shell:')return url.hostname==='app'&&!url.port&&!url.username&&!url.password&&url.pathname==='/index.html';
  return url.protocol==='file:'&&url.hostname===''&&/\/MobileWork\/resources\/app-dist\/index\.html$/i.test(decodeURIComponent(url.pathname));
 }catch{return false;}
}
export function uniqueClientPage(browser){
 const pages=browser.contexts().flatMap(context=>context.pages()).filter(page=>isClientPageUrl(page.url()));
 if(pages.length!==1)throw Error('未找到唯一的 MobileWork 主界面（发现 '+pages.length+' 个）');
 return pages[0];
}
