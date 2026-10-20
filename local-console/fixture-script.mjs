// Isolated test fixture: never connects to MobileWork.
import fs from 'node:fs/promises';
import path from 'node:path';
const config=JSON.parse(process.env.MW_TEST_CONFIG_JSON);
console.log('收到配置：'+JSON.stringify(config));
await new Promise(r=>setTimeout(r,800));
const base=process.env.MW_FIXTURE_DIR;
if(!base)throw Error('仅供自动测试使用，缺少隔离目录');
const dir=path.join(base,process.env.MW_CONSOLE_JOB_ID);
await fs.mkdir(path.join(dir,'产物'),{recursive:true});
await fs.writeFile(path.join(dir,'产物','preview.html'),'<script>throw Error("must be downloaded")</script>');
await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify({result:'PASS',checks:[{name:'参数传递',pass:true}],config,outputs:[{name:'preview.html',path:'产物/preview.html'}]}));
await fs.writeFile(path.join(dir,'执行报告.md'),'# 模拟脚本通过\n');
console.log('报告：'+path.join(dir,'执行报告.md'));
