import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

import openpyxl


ROOT = Path(__file__).resolve().parent.parent
CASE_DIR = ROOT / "测试用例与脚本"
WORKBOOK = CASE_DIR / "灵犀通用智能体· MobileWork Demo 功能点与测试案例-v1.8-1014.xlsx"
SHEET = "测试案例（客户端-多端兼容）"
DATA = CASE_DIR / "客户端多端兼容-覆盖清单.json"
REPORT = CASE_DIR / "客户端多端兼容-覆盖清单.md"


def cell_text(value):
    if value is None:
        return ""
    return str(value)


def build_manifest():
    digest = hashlib.sha256(WORKBOOK.read_bytes()).hexdigest()
    workbook = openpyxl.load_workbook(WORKBOOK, read_only=False, data_only=False)
    try:
        sheet = workbook[SHEET]
        headers = [cell_text(cell.value) for cell in sheet[1]]
        expected = ["标题*", "产品", "一级功能", "二级功能", "三级功能", "流程性", "类型", "描述", "前置条件", "执行步骤", "每步预期结果", "总体预期结果"]
        if headers != expected:
            raise ValueError(f"工作表列发生变化: {headers!r}")
        if sheet.merged_cells.ranges:
            raise ValueError("工作表存在合并单元格，需先核对其语义")

        cases = []
        for row in sheet.iter_rows(min_row=2):
            values = [cell_text(cell.value) for cell in row]
            if not any(values):
                continue
            if not values[0] or any(cell.data_type == "f" for cell in row):
                raise ValueError(f"第 {row[0].row} 行缺少标题或存在公式，需人工核对")
            number = row[0].row - 1
            entry = f"scripts/run-client-case{number:03d}.mjs" if 1 <= number <= 16 else ""
            if entry and not (ROOT / entry).is_file():
                raise FileNotFoundError(entry)
            cases.append({
                "row": row[0].row,
                "source": dict(zip(headers, values)),
                "script": entry,
                "coverage": "已接入，待审查" if entry else "待编写",
                "execution": "未执行",
                "evidence": [],
                "notes": "",
            })
        return {
            "schemaVersion": 1,
            "workbook": str(WORKBOOK.relative_to(ROOT)),
            "workbookSha256": digest,
            "sheet": SHEET,
            "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "cases": cases,
        }
    finally:
        workbook.close()


def report_text(manifest):
    cases = manifest["cases"]
    products = Counter(case["source"]["产品"] for case in cases)
    coverage = Counter(case["coverage"] for case in cases)
    execution = Counter(case["execution"] for case in cases)

    def counts(items):
        return "；".join(f"{key} {value}" for key, value in items.items())

    def field(value):
        return str(value).replace("|", "\\|").replace("\r", "").replace("\n", "<br>")

    lines = [
        "# 客户端多端兼容用例覆盖清单",
        "",
        f"来源：`{manifest['workbook']}`，工作表 `{manifest['sheet']}`。",
        f"来源 SHA-256：`{manifest['workbookSha256']}`。",
        "",
        f"有效用例：{len(cases)} 条。产品分布：{counts(products)}。",
        f"覆盖状态：{counts(coverage)}。本轮执行状态：{counts(execution)}。",
        "",
        "详细原始描述、前置条件、操作步骤和预期保存在同目录 JSON 的 `source` 字段中。",
        "JSON 是进度数据源；本表由 `scripts/build-workbook-coverage.py --render` 生成。",
        "历史结果与本轮结果分开记录；已接入不代表已覆盖或已通过。",
        "",
        "| 原表行 | 产品 | 一级功能 | 用例标题 | 覆盖状态 | 本轮结果 | 脚本 / 证据 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for case in cases:
        source = case["source"]
        refs = [case["script"], *case["evidence"]]
        lines.append("| " + " | ".join(field(item) for item in [
            case["row"], source["产品"], source["一级功能"], source["标题*"],
            case["coverage"], case["execution"], "<br>".join(x for x in refs if x) or "待补充",
        ]) + " |")
    return "\n".join(lines) + "\n"


def main():
    import sys

    if sys.argv[1:] == ["--init"]:
        if DATA.exists() or REPORT.exists():
            raise FileExistsError("覆盖清单已存在，拒绝覆盖；更新 JSON 后使用 --render")
        manifest = build_manifest()
        with DATA.open("x", encoding="utf-8", newline="\n") as file:
            json.dump(manifest, file, ensure_ascii=False, indent=2)
            file.write("\n")
        with REPORT.open("x", encoding="utf-8", newline="\n") as file:
            file.write(report_text(manifest))
        print(f"已创建 {len(manifest['cases'])} 条用例的覆盖清单")
    elif sys.argv[1:] == ["--render"]:
        manifest = json.loads(DATA.read_text(encoding="utf-8"))
        digest = hashlib.sha256(WORKBOOK.read_bytes()).hexdigest()
        if digest != manifest["workbookSha256"]:
            raise ValueError("来源工作簿已变化，请先核对差异，再更新覆盖清单")
        with REPORT.open("w", encoding="utf-8", newline="\n") as file:
            file.write(report_text(manifest))
        print(f"已刷新 {len(manifest['cases'])} 条用例的覆盖清单")
    else:
        raise SystemExit("用法: build-workbook-coverage.py --init | --render")


if __name__ == "__main__":
    main()
