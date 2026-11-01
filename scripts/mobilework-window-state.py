"""Read or reveal an explicitly owned MobileWork window, without desktop input."""
import argparse
import json
import sys
import win32con
import win32gui
import win32process

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--pid', required=True, type=int)
parser.add_argument('--hwnd', type=int)
parser.add_argument('--show', action='store_true')
args = parser.parse_args()
windows = []

def visit(hwnd, _):
    if win32process.GetWindowThreadProcessId(hwnd)[1] != args.pid:
        return
    if not win32gui.GetClassName(hwnd).startswith('Chrome_WidgetWin_'):
        return
    if win32gui.GetWindow(hwnd, win32con.GW_OWNER) or win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE) & win32con.WS_EX_TOOLWINDOW:
        return
    if args.hwnd and hwnd != args.hwnd:
        return
    if not args.hwnd and (not win32gui.IsWindowVisible(hwnd) or 'mobilework' not in win32gui.GetWindowText(hwnd).lower()):
        return
    if args.show:
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
    windows.append({'hwnd': hwnd, 'pid': args.pid, 'visible': bool(win32gui.IsWindowVisible(hwnd)),
                    'minimized': bool(win32gui.IsIconic(hwnd)), 'title': win32gui.GetWindowText(hwnd)})

win32gui.EnumWindows(visit, None)
print(json.dumps({'windows': windows}, ensure_ascii=False))
