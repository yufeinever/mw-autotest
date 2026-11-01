import {dispatchStandalone} from './mobilework-standalone.mjs';
import {readRunConfig} from './mobilework-run-policy.mjs';
import {runInteractionCase} from './client-interaction-case-runner.mjs';
if(await dispatchStandalone({number:90,args:process.argv.slice(2),config:readRunConfig()}))process.exit();
await runInteractionCase(90);
