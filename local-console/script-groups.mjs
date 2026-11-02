import {normalizeEdition,editionLabels} from './client-edition.mjs';
export const scriptSuite=script=>script?.suite==='permission'?'permission':'functional';
export const scriptEdition=script=>normalizeEdition(script?.clientEdition??'enterprise');
export const suiteLabels={functional:'功能用例',permission:'权限管控'};
export const scriptsInSuite=(scripts,suite,edition)=>scripts.filter(s=>scriptSuite(s)===suite&&(edition===undefined||scriptEdition(s)===normalizeEdition(edition)));
export function assertScriptEdition(script,edition){
 const actual=scriptEdition(script),expected=normalizeEdition(edition);
 if(actual!==expected)throw Error(`${script.name}属于${editionLabels[actual]}，不能在${editionLabels[expected]}执行`);
}
