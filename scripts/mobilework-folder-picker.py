"""Operate only the Windows folder picker owned by the connected MobileWork process."""
import argparse
import ctypes
import json
import os
import sys
import time
import re
import subprocess
import win32con
import win32gui
import win32process

sys.stdout.reconfigure(encoding='utf-8')


def control_text(hwnd):
    length = win32gui.SendMessage(hwnd, win32con.WM_GETTEXTLENGTH, 0, 0)
    buffer = ctypes.create_unicode_buffer(length + 1)
    win32gui.SendMessage(hwnd, win32con.WM_GETTEXT, length + 1, ctypes.addressof(buffer))
    return buffer.value


def child_windows(parent):
    children = []
    win32gui.EnumChildWindows(parent, lambda hwnd, _: children.append(hwnd), None)
    return children


def folder_dialogs(process_id, include_hidden=False):
    result = []
    def visit(hwnd, _):
        if (not include_hidden and not win32gui.IsWindowVisible(hwnd)) or win32gui.GetClassName(hwnd) != '#32770':
            return
        if win32process.GetWindowThreadProcessId(hwnd)[1] != process_id:
            return
        title = win32gui.GetWindowText(hwnd).lower()
        if title == '指定wiki、知识卡片、知识记忆等存放位置' or any(hint in title for hint in ('选择', '文件夹', '工作区', 'select', 'folder', 'directory')):
            result.append(hwnd)
    win32gui.EnumWindows(visit, None)
    return result


def description(hwnd):
    return {
        'hwnd': hwnd,
        'pid': win32process.GetWindowThreadProcessId(hwnd)[1],
        'title': win32gui.GetWindowText(hwnd),
        'class': win32gui.GetClassName(hwnd),
        'controls': [{'id': win32gui.GetDlgCtrlID(child), 'class': win32gui.GetClassName(child),
                      'text': control_text(child) if win32gui.GetClassName(child) == 'Edit' else win32gui.GetWindowText(child)}
                     for child in child_windows(hwnd) if win32gui.IsWindowVisible(child)]
    }


def folder_controls(hwnd):
    children = child_windows(hwnd)
    labels = [child for child in children if win32gui.GetClassName(child) == 'Static'
              and any(word in win32gui.GetWindowText(child).lower() for word in ('文件夹', 'folder'))]
    for label in labels:
        parent = win32gui.GetParent(label)
        siblings = [child for child in children if win32gui.GetParent(child) == parent and win32gui.IsWindowVisible(child)]
        edits = [child for child in siblings if win32gui.GetClassName(child) == 'Edit']
        buttons = [child for child in siblings if win32gui.GetClassName(child) == 'Button'
                   and any(word in win32gui.GetWindowText(child).lower()
                           for word in ('选择文件夹', 'select folder', 'choose'))]
        if len(edits) == 1 and len(buttons) == 1:
            return edits[0], buttons[0]
    raise RuntimeError('已识别原生窗口，但无法唯一识别文件夹输入框及确认按钮；未发送键盘或坐标操作')


def owned_alerts(parent, process_id, read_text=False):
    result = []
    def visit(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd) or win32gui.GetClassName(hwnd) != '#32770' or hwnd == parent:
            return
        if win32process.GetWindowThreadProcessId(hwnd)[1] != process_id:
            return
        owner = win32gui.GetWindow(hwnd, win32con.GW_OWNER)
        while owner and owner != parent:
            owner = win32gui.GetWindow(owner, win32con.GW_OWNER)
        if owner != parent:
            return
        text = ' '.join(win32gui.GetWindowText(child) for child in child_windows(hwnd)
                        if win32gui.GetClassName(child) == 'Static')
        if read_text and not text.strip():
            script = ("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"
                      "Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;"
                      "$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]" + str(hwnd) + ");"
                      "$condition=[System.Windows.Automation.PropertyCondition]::new("
                      "[System.Windows.Automation.AutomationElement]::ControlTypeProperty,"
                      "[System.Windows.Automation.ControlType]::Text);"
                      "$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition) | "
                      "ForEach-Object { $_.Current.Name }")
            text = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                                  capture_output=True, text=True, encoding='utf-8', check=True).stdout.strip()
        buttons = [child for child in child_windows(hwnd)
                   if win32gui.IsWindowVisible(child) and win32gui.GetClassName(child) == 'Button']
        button = buttons[0] if len(buttons) == 1 and win32gui.GetWindowText(buttons[0]).lower() in ('确定', 'ok') else None
        result.append({'hwnd': hwnd, 'text': text, 'button': button})
    win32gui.EnumWindows(visit, None)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--path')
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--window-state', type=int)
    parser.add_argument('--wait', action='store_true')
    parser.add_argument('--dialog', type=int)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--confirm', type=int)
    parser.add_argument('--cancel', type=int)
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--invalid', action='store_true')
    args = parser.parse_args()
    if args.window_state:
        exists = bool(win32gui.IsWindow(args.window_state))
        if exists and (win32process.GetWindowThreadProcessId(args.window_state)[1] != args.pid
                       or win32gui.GetClassName(args.window_state) != '#32770'):
            raise RuntimeError('登记的文件夹窗口归属不匹配')
        print(json.dumps({'ok': True, 'exists': exists}, ensure_ascii=False))
        return 0
    if args.inspect:
        dialogs = []
        for hwnd in folder_dialogs(args.pid, include_hidden=True):
            alerts = owned_alerts(hwnd, args.pid)
            if win32gui.IsWindowVisible(hwnd) or alerts:
                dialog = description(hwnd)
                dialog['visible'] = bool(win32gui.IsWindowVisible(hwnd))
                dialog['alerts'] = alerts
                dialogs.append(dialog)
        print(json.dumps({'ok': True, 'dialogs': dialogs}, ensure_ascii=False))
        return 0
    if not args.path:
        parser.error('选择目录需要 --path')
    target = os.path.abspath(args.path)
    if not args.cancel and not args.invalid and not os.path.isdir(target):
        raise RuntimeError('目标测试目录不存在：' + target)
    hwnd = args.confirm or args.cancel or args.dialog
    if hwnd:
        if not win32gui.IsWindow(hwnd):
            print(json.dumps({'ok': True, 'dialogClosed': True, 'alreadyClosed': True}, ensure_ascii=False))
            return 0
        if win32process.GetWindowThreadProcessId(hwnd)[1] != args.pid or win32gui.GetClassName(hwnd) != '#32770':
            raise RuntimeError('登记的文件夹窗口归属不匹配，未操作窗口')
    else:
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            dialogs = folder_dialogs(args.pid)
            if len(dialogs) > 1:
                raise RuntimeError('当前MobileWork有多个文件夹选择器，无法唯一识别；未操作窗口')
            if dialogs:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('未找到当前MobileWork进程的Windows文件夹选择器')
        hwnd = dialogs[0]
    if args.cancel:
        for error in owned_alerts(hwnd, args.pid):
            if not error['button']:
                raise RuntimeError('本轮原生子弹框确认按钮不唯一，保留现场')
            win32gui.PostMessage(error['button'], win32con.BM_CLICK, 0, 0)
            deadline = time.monotonic() + args.timeout
            while win32gui.IsWindow(error['hwnd']) and win32gui.IsWindowVisible(error['hwnd']):
                if time.monotonic() >= deadline:
                    raise RuntimeError('本轮路径错误框尚未关闭，保留现场')
                time.sleep(0.1)
        if not win32gui.IsWindow(hwnd):
            print(json.dumps({'ok': True, 'dialogClosed': True, 'alreadyClosed': True}, ensure_ascii=False))
            return 0
    if not win32gui.IsWindowVisible(hwnd):
        raise RuntimeError('本轮文件夹窗口不可见，未确认完成')
    before = description(hwnd)
    if args.wait:
        print(json.dumps({'ok': True, 'dialogFound': True,
                          'dialogClosed': False, 'dialog': before}, ensure_ascii=False))
        return 0
    if args.cancel:
        field = None
        buttons = [child for child in child_windows(hwnd)
                   if win32gui.GetClassName(child) == 'Button' and win32gui.GetDlgCtrlID(child) == 2]
        if len(buttons) != 1:
            raise RuntimeError('未唯一识别本轮窗口的取消按钮')
        button = buttons[0]
    else:
        edit, button = folder_controls(hwnd)
        if not args.confirm:
            win32gui.SendMessage(edit, win32con.WM_SETTEXT, 0, target)
        field = control_text(edit)
        if os.path.normcase(field) != os.path.normcase(target):
            raise RuntimeError('原生文件夹输入框回读与目标路径不一致')
        if args.prepare:
            print(json.dumps({'ok': True, 'path': field, 'dialogFound': True, 'dialogClosed': False,
                              'dialog': before}, ensure_ascii=False))
            return 0
    win32gui.PostMessage(button, win32con.BM_CLICK, 0, 0)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if args.invalid:
            alerts = owned_alerts(hwnd, args.pid, read_text=True)
            if alerts:
                errors = [{'hwnd': item['hwnd'], 'text': item['text']} for item in alerts]
                rejected = any(re.search(r'不存在|找不到|无效|不正确|拒绝|权限|does not exist|not found|invalid|denied', item['text'], re.I) for item in errors)
                print(json.dumps({'ok': True, 'path': field, 'dialogFound': True, 'dialogClosed': False,
                                  'dialog': before, 'rejected': rejected, 'errors': errors}, ensure_ascii=False))
                return 0
        if not win32gui.IsWindow(hwnd):
            print(json.dumps({'ok': True, 'path': field, 'dialogFound': True, 'dialogClosed': True,
                              'dialog': before}, ensure_ascii=False))
            return 0
        if not args.invalid and not win32gui.IsWindowVisible(hwnd) and owned_alerts(hwnd, args.pid):
            raise RuntimeError('文件夹窗口已隐藏，但本轮原生子弹框仍未关闭')
        time.sleep(0.1)
    if args.invalid:
        print(json.dumps({'ok': True, 'path': field, 'dialogFound': True, 'dialogClosed': False,
                          'dialog': before, 'rejected': False, 'errors': []}, ensure_ascii=False))
        return 0
    print(json.dumps({'ok': False, 'path': field, 'dialogFound': True, 'dialogClosed': False,
                      'dialog': before, 'after': description(hwnd)}, ensure_ascii=False))
    return 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
