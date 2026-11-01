# Office与多格式预览合成材料

供063～066使用，全部为虚构数据，不含用户资料或运行时凭据。每条脚本将原文件复制到本轮输入材料目录，再通过产品真实上传入口选择；预存材料不算本轮模型产物。manifest.json记录实际SHA256、大小与可独立核对的源事实。

- 中文DOCX含两页、段落、表格、图片与末段；XLSX为双Sheet、两行不同商品明细；PPTX为三页固定顺序且含图片；PDF含可提取中文字层与真实书签。
- CSV、Markdown、HTML和PNG覆盖其他预览类型，HTML不联网、不执行脚本。
- 大材料是1500行×16列的双Sheet、60页PDF与5120×2880图像，验证原表加载与交互目的。
- legacy下doc/xls/ppt由真实LibreOffice转换器生成，文件头为OLE Compound File，不是更改现代格式扩展名。仅用于产品旧格式原生解析，不把测试平台转换材料冒充MobileWork解析成功。

材料生成器：scripts/fixtures/prepare-office-preview.py，使用Python的python-docx/openpyxl/python-pptx/reportlab/Pillow；显式传入--soffice路径。输出文件已随项目保存，正常运行用例不依赖这些生成库或本机LibreOffice生成步骤。生成时使用独立临时用户配置，不接管客户端组件进程。
