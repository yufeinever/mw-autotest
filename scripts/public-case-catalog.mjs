// 公众版独立定义。入口、材料和判定单独维护；声明已接入不代表已实测通过。
const scenes=[
 ['日常办公','日程管理','帮我整理日程并排定优先级。可以直接上传日程表、会议通知等文件（Excel/Word/文本均可），将根据文件内容生成对应日程。','workday-calendar'],
 ['日常办公','会议纪要','把这段会议记录整理成结构化纪要与待办清单。','meeting-and-brief'],
 ['日常办公','邮件处理','帮我起草一封专业的工作邮件。','email-official'],
 ['日常办公','文稿写作','帮我起草一份公文（请说明文种与主要内容）。','chinese-official-writing'],
 ['代码开发','代码工作流','帮我实现这个需求：先规划、再实现，然后验证与测试。','sdd'],
 ['代码开发','CI/CD 流水线','帮我用 GitHub Actions 搭建并调试 CI/CD 流水线（测试、构建、部署、发布）。','github'],
 ['代码开发','架构图绘制','帮我绘制这个系统的架构图 / 流程图。',null],
 ['代码开发','技能管理','帮我创建一个新的技能（Skill），并打包成可上传的归档。','mobilework-skill-creator'],
 ['代码开发','AI Coding','帮我编写高质量的代码实现，包含完整的逻辑、错误处理和注释。','dev-expert'],
 ['设计创意','AI PPT','请把我提供的资料制作成一套 PPT 演示文稿。','ai-ppt-generation']
];
const goals=[
 '按虚构事项和期限给出可执行日程与优先顺序，不写外部日历。',
 '从完整合成会议原文提取决定、负责人、截止日期和待确认项，不补造信息。',
 '起草含原/新时间、地点、回复期限及署名的邮件，不真实发送。',
 '输出面向各部门的设备盘点通知，保留对象、截止、联系人和异常说明。',
 '规划并实现优先级规范化模块；以独立输入核对真实代码及错误分支。',
 '生成本地GitHub Actions YAML及说明，核对依赖、只读权限与发布保护，不远程执行。',
 '从业务描述生成真实Mermaid文件，核对节点语义、方向及禁止的直接访问关系。',
 '生成可解析的Skill ZIP，检查元数据、正文和示例，不安装技能。',
 '实现范围裁剪纯函数，独立验证正常值、类型、非有限值及反向区间。',
 '制作四页16:9可编辑PPTX，检查原始材料、计算分母及行动项。'
];
export const publicCases=scenes.map(([category,button,prompt,skill],index)=>Object.freeze({
 number:index+1,id:'MW-PUBLIC-'+String(index+1).padStart(3,'0'),clientEdition:'public',suite:'functional',
 title:'公众版 · '+button+'：'+goals[index],category,button,prompt,skills:skill?[skill]:[],
 expert:index===6?'mermaid-diagram-expert':null,expertLabel:index===6?'图表设计与渲染专家':null,kind:'public-scene',label:'公众版-'+button.replaceAll('/',''),
 sourceCaseId:'MW-CLIENT-'+String(index+1).padStart(3,'0'),
 requirement:'公众版MW-V1.0.1实际首页场景与自动填充；仅沿用政企版同序号的业务目标，独立材料与判定。',
 requirementLink:'测试用例与脚本/公众版01-10用例说明.md',
 preconditions:'已登录公众版，CDP可用，主窗口展开，自动模型可用；对应预置技能/专家就绪。无需真实邮箱、日历或GitHub写权限。',
 steps:['统一初始化新任务并核对公众版与自动模型','点击当前公众版分类和场景，核对预填与实际选择','追加本轮合成材料；仅发送一次，登记真实Session与任务目录','按本Session实际审批/选项推进并等待终态','核对正文或真实产物，归档Trace/截图/录像，统一收尾'],
 expected:goals[index],note:'独立公众版用例；不绑定政企版任务根目录，不要求固定模型措辞或唯一工具路径。实测状态以执行批次/报告为准。',
 timeoutMs:index===9?1200000:600000,entry:'scripts/run-public-case'+String(index+1).padStart(3,'0')+'.mjs'
}));
export function getPublicCase(number){const item=publicCases.find(c=>c.number===Number(number));if(!item)throw Error('公众版编号必须为1～10');return item;}
