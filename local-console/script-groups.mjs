export const scriptSuite=script=>script?.suite==='permission'?'permission':'functional';
export const suiteLabels={functional:'功能用例',permission:'权限管控'};
export const scriptsInSuite=(scripts,suite)=>scripts.filter(s=>scriptSuite(s)===suite);
