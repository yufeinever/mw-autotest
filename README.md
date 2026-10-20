# mw-autotest

MobileWork 客户端自动化测试平台，包含本地控制台、前16条客户端用例及一键执行脚本，使用 CDP + Playwright 或客户端本地接口。

## 启动

使用 Windows 和 Node.js 22，在项目目录运行 `npm ci`，然后双击 `启动测试平台.cmd` 或执行 `npm start`。默认地址为 http://127.0.0.1:18888 ，端口冲突时明确报错，不自动换端口。

MobileWork 客户端、模型与 Skills 需要另行配置。配置说明见 [打包与迁移说明](打包与迁移说明.md) 和 [控制台说明](local-console/README.md)。

## 内容

- `local-console/`：参数配置、串行/任务并行调度、批次、报告、Session 日志、Trace 与停止操作。
- `scripts/`：前16条用例入口、共享交互控件、内容及产物断言、构建与打包脚本。
- `测试用例与脚本/`：原用例表、执行说明及中文一键入口。
- `AGENTS.md`：项目约定；开发后验证最多5个用例，默认不运行全量回归。

运行记录保存在本地 `runs/` 和 `runtime-config/`，不提交到仓库。模型 Key 和客户端账号资料不属于仓库内容。

修改前端源码后运行 `npm run build:console`；打包使用 `npm run package:windows`。历史实机通过记录只代表报告中列明的用例，不能推断全部用例已通过。
