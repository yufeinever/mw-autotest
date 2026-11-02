// Shared by the console, runners and reports. Historical configs are enterprise.
export const editionLabels={enterprise:'政企版',public:'公众版'};
export function normalizeEdition(value='enterprise'){
 if(!Object.hasOwn(editionLabels,value))throw Error('客户端版本必须选择政企版或公众版');
 return value;
}
export const editionProfiles={
 enterprise:{label:'政企版',bridge:'__OPENWORK_ELECTRON__',directory:'MobileWork',home:'.mobilework',sessionActions:['在会话期间允许','在会话期间运行']},
 public:{label:'公众版',bridge:'__MOBILEWORK_ELECTRON__',directory:'MobileWork-toC',home:'.mobilework_public',sessionActions:['在会话期间允许']},
};
export async function inspectClientEdition(page){
 const available=await page.evaluate(()=>({
  enterprise:typeof window.__OPENWORK_ELECTRON__?.invokeDesktop==='function',
  public:typeof window.__MOBILEWORK_ELECTRON__?.invokeDesktop==='function',
 }));
 const matches=Object.keys(editionLabels).filter(key=>available[key]);
 if(matches.length!==1)throw Error(matches.length?'客户端版本接口不唯一，未操作客户端':'客户端桌面接口尚未就绪或版本不受支持');
 return matches[0];
}
export async function assertClientEdition(page,expected){
 const actual=await inspectClientEdition(page);
 if(expected!==undefined&&actual!==normalizeEdition(expected))throw Error(`选择的是${editionLabels[expected]}，实际连接的是${editionLabels[actual]}；请切换版本或连接对应客户端`);
 return actual;
}
