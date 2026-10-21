export const approvalLabels = {reject:'拒绝',once:'允许一次',session:'在会话期间允许',full:'开启完全访问权限'};
export function normalizeConfig(input={}) {
 const provider=input.provider||{};
 const rawStepInterval=input.stepInterval;
 const c={version:1,executionStrategy:input.executionStrategy??'serial',maxParallel:Number(input.maxParallel??3),question:input.question??'first',customText:input.customText??'',approval:input.approval??'once',model:input.model??'',cdpPort:Number(input.cdpPort??9223),stepInterval:rawStepInterval===undefined||rawStepInterval===null||rawStepInterval===''?0.5:Number(rawStepInterval),provider:{url:provider.url??'',key:provider.key??'',model:provider.model??'',multimodal:Boolean(provider.multimodal),inputTokens:Number(provider.inputTokens??262144),outputTokens:Number(provider.outputTokens??65536)}};
 if(!['serial','parallel'].includes(c.executionStrategy))throw Error('执行策略无效');
 if(!Number.isInteger(c.maxParallel)||c.maxParallel<1||c.maxParallel>16)throw Error('并行任务数必须为1～16');
 if(!['first','second','custom'].includes(c.question))throw Error('选项弹窗配置无效');
 if(typeof c.customText!=='string'||c.customText.length>4000)throw Error('自定义回答最多4000字');
 if(c.question==='custom'&&!c.customText.trim())throw Error('请填写自定义回答');
 if(!Object.hasOwn(approvalLabels,c.approval))throw Error('审批方式无效');
 if(typeof c.model!=='string'||c.model.length>150)throw Error('模型名称无效');
 if(typeof c.provider.url!=='string'||c.provider.url.length>1000)throw Error('模型URL无效');
 if(typeof c.provider.key!=='string'||c.provider.key.length>1000)throw Error('模型Key无效');
 if(typeof c.provider.model!=='string'||c.provider.model.length>150)throw Error('模型命中无效');
 if(!Number.isFinite(c.stepInterval)||c.stepInterval<0.1||c.stepInterval>60)throw Error('执行间隔必须为0.1～60秒');
 if(!Number.isInteger(c.provider.inputTokens)||c.provider.inputTokens<1||c.provider.inputTokens>10000000)throw Error('输入模型长度无效');
 if(!Number.isInteger(c.provider.outputTokens)||c.provider.outputTokens<1||c.provider.outputTokens>10000000)throw Error('输出模型长度无效');
 if(!Number.isInteger(c.cdpPort)||c.cdpPort<1||c.cdpPort>65535)throw Error('CDP端口无效');
 return c;
}
