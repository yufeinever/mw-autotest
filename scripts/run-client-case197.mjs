import {dispatchStandalone} from './mobilework-standalone.mjs';
import {readRunConfig} from './mobilework-run-policy.mjs';
if(await dispatchStandalone({number:197,args:process.argv.slice(2),config:readRunConfig()}))process.exit();
throw Error('跨Windows重启的续跑与原开关恢复尚未接入，暂不可执行。');
