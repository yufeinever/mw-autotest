import {dispatchStandalone} from './mobilework-standalone.mjs';
import {readRunConfig} from './mobilework-run-policy.mjs';
import {runConfigCase} from './client-config-case-runner.mjs';
if(await dispatchStandalone({number:23,args:process.argv.slice(2),config:readRunConfig()}))process.exit();
await runConfigCase(23);
