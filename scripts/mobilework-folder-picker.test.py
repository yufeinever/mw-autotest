import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('folder_picker', Path(__file__).with_name('mobilework-folder-picker.py'))
picker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(picker)


class FolderPickerTest(unittest.TestCase):
    def test_wait_identifies_window_without_path_controls(self):
        with patch.object(sys, 'argv', ['picker', '--pid', '123', '--path', 'C:\\test', '--wait']), \
             patch.object(picker.os.path, 'isdir', return_value=True), \
             patch.object(picker, 'folder_dialogs', return_value=[456]), \
             patch.object(picker, 'description', return_value={'hwnd': 456}), \
             patch.object(picker, 'folder_controls', side_effect=AssertionError('path controls are unavailable')), \
             patch.object(picker.win32gui, 'IsWindowVisible', return_value=True):
            self.assertEqual(picker.main(), 0)

    def test_cancel_does_not_require_path_controls(self):
        open_window = [True]

        def close_window(*_args):
            open_window[0] = False

        with patch.object(sys, 'argv', ['picker', '--pid', '123', '--path', 'C:\\test', '--cancel', '456']), \
             patch.object(picker, 'owned_alerts', return_value=[]), \
             patch.object(picker, 'description', return_value={}), \
             patch.object(picker, 'child_windows', return_value=[789]), \
             patch.object(picker, 'folder_controls', side_effect=AssertionError('path controls are unavailable')), \
             patch.object(picker.win32process, 'GetWindowThreadProcessId', return_value=(1, 123)), \
             patch.object(picker.win32gui, 'IsWindow', side_effect=lambda _hwnd: open_window[0]), \
             patch.object(picker.win32gui, 'IsWindowVisible', return_value=True), \
             patch.object(picker.win32gui, 'GetClassName', side_effect=lambda hwnd: '#32770' if hwnd == 456 else 'Button'), \
             patch.object(picker.win32gui, 'GetDlgCtrlID', return_value=2), \
             patch.object(picker.win32gui, 'PostMessage', side_effect=close_window) as click:
            self.assertEqual(picker.main(), 0)
            click.assert_called_once_with(789, picker.win32con.BM_CLICK, 0, 0)


if __name__ == '__main__':
    unittest.main()
