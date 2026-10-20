import {readRunConfig} from './mobilework-run-policy.mjs';
import {runScenarioCase} from './client-case-runner.mjs';

await runScenarioCase(10,readRunConfig());

