// 编号按第二张工作表中的用例顺序；保留原表标题和行号。
export const caseWorkbook='灵犀通用智能体· MobileWork Demo 功能点与测试案例-v1.8-1014.xlsx';
export const caseSheet='测试案例（客户端-多端兼容）';
const definitions=[
 ['日常办公01-日程管理自动填充内容，执行会话','日常办公','日程管理','帮我规划本周的工作日程与优先级。','workday-calendar'],
 ['日程办公02-会议纪要自动填充内容，执行会话','日常办公','会议纪要','把这段会议记录整理成结构化纪要与待办清单。','meeting-and-brief'],
 ['日程办公04-邮件处理自动填充内容，执行会话','日常办公','邮件处理','帮我起草一封专业的工作邮件。','email-official'],
 ['日程办公05-公文写作自动填充内容，执行会话','日常办公','文稿写作','帮我起草一份公文（请说明文种与主要内容）。','chinese-official-writing'],
 ['代码开发01-代码工作流','代码开发','代码工作流','帮我实现这个需求：先规划、再实现，然后验证与测试。','sdd'],
 ['代码开发02-CI/CD流水线','代码开发','CI/CD 流水线','帮我用 GitHub Actions 搭建并调试 CI/CD 流水线（测试、构建、部署、发布）。','github'],
 ['代码开发03-架构图绘制','代码开发','架构图绘制','帮我绘制这个系统的架构图 / 流程图。',null],
 ['代码开发04-技能管理','代码开发','技能管理','帮我创建一个新的技能（Skill），并打包成可上传的归档。','mobilework-skill-creator'],
 ['代码开发05-AI Coding','代码开发','AI Coding','帮我编写高质量的代码实现，包含完整的逻辑、错误处理和注释。','dev-expert'],
 ['设计创意01-AI PPT','设计创意','AI PPT','请把我提供的资料制作成一套 PPT 演示文稿。','ai-ppt-generation'],
 ['设计创意02-网站开发','设计创意','网站开发','帮我设计并开发一个响应式网站，包含页面布局、导航结构、内容模块和交互效果，输出完整的设计方案和HTML/CSS/JS实现代码。','web-design-layout'],
 ['设计创意03-海报设计','设计创意','海报设计','帮我设计一张活动宣传海报，包含主视觉构图、配色方案、排版布局和文案创意，输出设计规范和HTML预览。','poster-skill'],
 ['设计创意04-创意构思','设计创意','创意构思','帮我就给定的主题进行创意发散，输出多个不同角度的产品概念方案，包含用户场景、核心功能和差异化亮点。','brainstorm-with-file'],
 ['设计创意05-图标设计','设计创意','图标设计','帮我设计一套移动端 App 的图标系统，包含导航、操作和状态图标，输出 SVG 代码和视觉规范。','mobile-icon-system-design'],
 ['深度洞察01-深度研究','深度洞察','深度研究','AI Agent产品对比研究：对Codex、Claude Code与WorkBuddy进行清晰对比，从核心功能、易用性、定价、实际案例和优劣势入手，以故事线形式呈现选型逻辑，形成2026年AI Agent实用决策报告，结构清晰、洞察明确',null],
 ['深度洞察02-商品推荐','深度洞察','商品推荐','给自己买商务差旅轻薄本，推荐一些产品',null]
];
const notes={
 1:'原表步骤“日常管理”按标题和当前客户端“日程管理”定位。',
 4:'原表“公文写作”在当前客户端显示为“文稿写作”；技能和自动填充提示词一致。',
 6:'当前按钮为“CI/CD 流水线”，与原表相差一个空格。只验证本地流水线定义，不推送或部署。',
 7:'当前入口还会选择 mermaid-diagram-expert 专家，原表未要求该附加配置。',
 10:'当前客户端额外自动选择 ai-ppt-generation 技能。',
 14:'原表三级功能误写为深度洞察；步骤和当前入口均为设计创意。',
 15:'原表步骤分类误写为设计创意，当前入口在深度洞察。报告检查结构与来源，不以自动断言代替逐项事实审查。',
 16:'原表步骤分类和预期按钮存在笔误；当前为深度洞察→商品推荐。使用明确标注的虚构商品快照验证筛选逻辑。'
};
export const clientCases=definitions.map(([title,category,button,prompt,skill],i)=>Object.freeze({
 number:i+1,id:'MW-CLIENT-'+String(i+1).padStart(3,'0'),row:i+2,title,category,button,prompt,skills:skill?[skill]:[],
 label:button.replaceAll('/',''),note:notes[i+1]||'',timeoutMs:i+1===15?1200000:600000,
 entry:'scripts/run-client-case'+String(i+1).padStart(3,'0')+'.mjs'
}));
export function getClientCase(number){
 const found=clientCases.find(c=>c.number===Number(number));
 if(!found)throw Error('用例编号必须为1～16');return found;
}
