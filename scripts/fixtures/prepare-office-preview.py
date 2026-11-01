"""Prepare synthetic inputs for cases 063-066; never run a product test."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from docx import Document
from docx.shared import Inches
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.util import Inches as PptInches
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parent / 'office-preview'
FONT = Path('C:/Windows/Fonts/msyh.ttc')
FACTS = {
    'docx': ['星桥文档核验', '预算7319元', '责任人沈岚', '终验窗口：十一月六日；请核实。'],
    'xlsx': ['销售甲', '销售乙', '星桥甲货', '星桥乙货', '340', '690'],
    'pptx': ['星桥方案首页', '方案中页：中文标点，清晰。', '方案末页：验收由陆川负责'],
    'pdf': ['星桥会议信息', '决议预算8427元', '行动负责人唐夏'],
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--soffice', required=True)
    args = parser.parse_args()
    ROOT.mkdir(exist_ok=True)
    image = Image.new('RGB', (1280, 720), '#f7fafc')
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(FONT), 48)
    draw.rectangle((80, 160, 400, 500), fill='#0052d9')
    draw.ellipse((700, 160, 1060, 520), fill='#0ea574')
    draw.text((80, 45), '星桥图片：蓝色方块与绿色圆形', font=font, fill='#111827')
    image.save(ROOT / '中文流程图.png')

    document = Document()
    document.add_heading(FACTS['docx'][0], 0)
    document.add_paragraph(FACTS['docx'][1])
    document.add_picture(str(ROOT / '中文流程图.png'), width=Inches(4))
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = '事项'
    table.rows[0].cells[1].text = '内容'
    for key, value in [('责任', FACTS['docx'][2]), ('验收', FACTS['docx'][3])]:
        cells = table.add_row().cells
        cells[0].text, cells[1].text = key, value
    document.add_page_break()
    document.add_heading('星桥文档第二页', 1)
    document.add_paragraph('独立段落：方案不含真实个人资料。')
    document.add_paragraph(FACTS['docx'][3])
    document.save(ROOT / '中文项目说明.docx')

    workbook = Workbook()
    for index, name in enumerate(FACTS['xlsx'][:2]):
        sheet = workbook.active if index == 0 else workbook.create_sheet()
        sheet.title = name
        for row in [['产品名称', '销量', '单价', '金额'], ['星桥甲货', 20, 17, 340], ['星桥乙货', 30, 23, 690]]:
            sheet.append(row)
        for col in 'ABCD':
            sheet.column_dimensions[col].width = 24
    workbook.save(ROOT / '中文销售明细.xlsx')

    presentation = Presentation()
    for title in FACTS['pptx']:
        slide = presentation.slides.add_slide(presentation.slide_layouts[1])
        slide.shapes.title.text = title
        slide.placeholders[1].text = '方案说明：准备、评审、验收。\n本页顺序与源文件保持一致。'
        slide.shapes.add_picture(str(ROOT / '中文流程图.png'), PptInches(6), PptInches(3), width=PptInches(3))
    presentation.save(ROOT / '中文产品方案.pptx')

    pdfmetrics.registerFont(TTFont('MWChinese', str(FONT)))
    pdf = canvas.Canvas(str(ROOT / '中文会议资料.pdf'))
    for index, text in enumerate(FACTS['pdf'], 1):
        pdf.setFont('MWChinese', 20)
        pdf.drawString(48, 760, text)
        pdf.drawString(48, 710, f'第{index}页：中文标点“正确”，不是扫描图片。')
        pdf.bookmarkPage(str(index))
        pdf.addOutlineEntry(text, str(index), 0)
        pdf.showPage()
    pdf.save()
    (ROOT / '中文清单.csv').write_text('产品,金额\n星桥甲,7319\n星桥乙,8427\n', encoding='utf-8-sig')
    (ROOT / '中文说明.md').write_text('# 星桥Markdown\n\n预算为7319元。\n\n|负责人|行动|\n|---|---|\n|沈岚|复核|\n', encoding='utf8')
    (ROOT / '中文页面.html').write_text('<!doctype html><html lang="zh"><meta charset="utf-8"><title>星桥HTML</title><h1>星桥HTML</h1><p>中文验收日期：十一月六日。</p><table><tr><th>负责人</th><td>唐夏</td></tr></table></html>', encoding='utf8')

    workbook = Workbook()
    for index, name in enumerate(['大表甲', '大表乙']):
        sheet = workbook.active if index == 0 else workbook.create_sheet()
        sheet.title = name
        sheet.append([f'列{n:02}' for n in range(1, 17)])
        for row in range(1, 1501):
            sheet.append([f'行{row:04}列{col:02}' for col in range(1, 17)])
        for column in 'ABCDEFGHIJKLMNOP':
            sheet.column_dimensions[column].width = 24
    workbook.save(ROOT / '大数据1500行.xlsx')
    pdf = canvas.Canvas(str(ROOT / '大文档60页.pdf'))
    for n in range(1, 61):
        pdf.setFont('MWChinese', 18)
        pdf.drawString(48, 760, f'星桥性能材料第{n:02}页，共60页')
        for line in range(25):
            pdf.drawString(48, 710 - line * 22, f'第{line+1:02}条记录：合成业务信息，保留中文。')
        pdf.showPage()
    pdf.save()
    image = Image.new('RGB', (5120, 2880), '#ffffff')
    draw = ImageDraw.Draw(image)
    for x in range(0, 5120, 80):
        draw.line((x, 0, x, 2880), fill='#9ca3af', width=2)
    for y in range(0, 2880, 80):
        draw.line((0, y, 5120, y), fill='#9ca3af', width=2)
    draw.rectangle((200, 400, 1800, 2400), fill='#0052d9')
    draw.ellipse((2800, 400, 4800, 2400), fill='#0ea574')
    draw.text((200, 100), '星桥高清图5120×2880', font=ImageFont.truetype(str(FONT), 110), fill='#111827')
    image.save(ROOT / '高清大图.png')

    # Use a separate profile and output directory; never attach to the client's
    # own LibreOffice process or replace user documents.
    legacy = ROOT / 'legacy'
    legacy.mkdir(exist_ok=True)
    profile = Path('tmp/office-fixture-profile').resolve().as_uri()
    for source, target, file_filter in [
        ('中文项目说明.docx', 'doc', 'MS Word 97'),
        ('中文销售明细.xlsx', 'xls', 'MS Excel 97'),
        ('中文产品方案.pptx', 'ppt', 'MS PowerPoint 97'),
    ]:
        result = subprocess.run([args.soffice, '-env:UserInstallation=' + profile, '--headless', '--convert-to', target + ':' + file_filter, '--outdir', str(legacy), str(ROOT / source)], capture_output=True)
        if result.returncode:
            raise RuntimeError('旧格式测试材料转换失败：' + source)
        file = legacy / (Path(source).stem + '.' + target)
        if not file.exists() or file.read_bytes()[:8] != bytes.fromhex('d0cf11e0a1b11ae1'):
            raise RuntimeError('旧格式材料不是实际Office二进制：' + str(file))
    files = sorted(file for file in ROOT.rglob('*') if file.is_file() and file.name != 'manifest.json')
    manifest = {'synthetic': True, 'facts': FACTS, 'files': [{'name': file.relative_to(ROOT).as_posix(), 'size': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()} for file in files]}
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'files': len(files), 'legacy': [file.name for file in legacy.iterdir()]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
