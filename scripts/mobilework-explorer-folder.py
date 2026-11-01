"""Read Explorer's actual folder locations, restricted to the supplied task directory."""
import argparse
import json
import os
import sys
import win32com.client

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--path', required=True)
parser.add_argument('--close', type=int)
parser.add_argument('--reveal', action='store_true')
args = parser.parse_args()
target = os.path.normcase(os.path.abspath(args.path))
matches = []
for window in win32com.client.Dispatch('Shell.Application').Windows():
    if os.path.basename(window.FullName).lower() != 'explorer.exe':
        continue
    actual = window.Document.Folder.Self.Path
    actual_key = os.path.normcase(os.path.abspath(actual))
    if actual_key == target or args.reveal and actual_key == os.path.dirname(target):
        selected = [item.Path for item in window.Document.SelectedItems()]
        revealed = any(os.path.normcase(os.path.abspath(item)) == target for item in selected)
        entry = {'hwnd': int(window.HWND), 'path': actual, 'selected': selected, 'targetVisible': actual_key == target or revealed}
        if args.close == entry['hwnd']:
            if not entry['targetVisible']:
                raise RuntimeError('本轮目录已不在Explorer中打开或选中，未关闭窗口')
            window.Quit()
            entry['closed'] = True
        matches.append(entry)
if args.close and not any(item['hwnd'] == args.close for item in matches):
    raise RuntimeError('登记的Explorer窗口不存在或已离开本轮目录，未关闭其他窗口')
print(json.dumps({'windows': matches}, ensure_ascii=False))
