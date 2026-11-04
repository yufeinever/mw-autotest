import {readRunConfig} from './mobilework-run-policy.mjs';
import {runPublicCase} from './public-case-runner.mjs';
await runPublicCase(2,readRunConfig());
