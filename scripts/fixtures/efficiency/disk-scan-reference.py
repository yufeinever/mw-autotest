import os
import shutil
import sys

MAX_DISKS = 10

# 伪文件系统（非真实磁盘，跳过）
PSEUDO_FS = {
    "proc", "sysfs", "devtmpfs", "tmpfs", "devpts", "cgroup", "cgroup2",
    "overlay", "squashfs", "mqueue", "hugetlbfs", "debugfs", "tracefs",
    "securityfs", "pstore", "bpf", "autofs", "fusectl", "configfs",
    "ramfs", "binfmt_misc", "efivarfs", "nsfs", "rootfs", "rpc_pipefs",
}
# 网络/共享文件系统（访问可能无响应，跳过）
NETWORK_FS = {
    "nfs", "nfs4", "cifs", "smb3", "9p", "ceph", "glusterfs",
    "fuse.sshfs", "fuse.gvfsd-fuse", "fuse.rclone", "fuse.smbnetfs",
}


def _unescape(value):
    # /proc/mounts 用八进制转义：\040 空格、\011 tab、\012 换行、\134 反斜杠
    if "\\" not in value:
        return value
    out = []
    i = 0
    n = len(value)
    while i < n:
        if value[i] == "\\" and i + 3 < n and value[i + 1:i + 4].isdigit():
            out.append(chr(int(value[i + 1:i + 4], 8)))
            i += 4
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


def _usage(path, drive):
    try:
        usage = shutil.disk_usage(path)
    except Exception:
        return None
    total = usage.total
    if not total:
        return None
    free = usage.free
    used = total - free
    return {
        "drive": drive,
        "total": total,
        "free": free,
        "used": used,
        "used_pct": round(used / total * 100, 1),
    }


def _windows_disks():
    import ctypes

    kernel32 = ctypes.windll.kernel32
    kernel32.GetLogicalDrives.restype = ctypes.c_uint
    kernel32.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
    kernel32.GetDriveTypeW.restype = ctypes.c_uint
    mask = kernel32.GetLogicalDrives()
    disks = []
    for i in range(26):
        if not (mask >> i) & 1:
            continue
        root = chr(ord("A") + i) + ":\\"
        # 只取固定盘(3)与可移动盘(2)；排除网络盘/光驱/未知，避免访问无响应挂载点
        if kernel32.GetDriveTypeW(root) not in (2, 3):
            continue
        disk = _usage(root, root[:2])
        if disk:
            disks.append(disk)
    return disks


def _linux_disks():
    disks = []
    seen = set()
    try:
        with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except Exception:
        return disks
    for line in lines:
        parts = line.split()
        if len(parts) < 3:
            continue
        device = parts[0]
        mount_point = _unescape(parts[1])
        fs_type = parts[2]
        if fs_type in PSEUDO_FS or fs_type in NETWORK_FS or fs_type.startswith("fuse."):
            continue
        if device in seen:
            continue
        disk = _usage(mount_point, mount_point)
        if disk:
            seen.add(device)
            disks.append(disk)
    return disks


def list_disks():
    if os.name == "nt":
        system = "Windows"
    elif sys.platform.startswith("linux"):
        system = "Linux"
    else:
        system = sys.platform
    try:
        if os.name == "nt":
            disks = _windows_disks()
        elif sys.platform.startswith("linux"):
            disks = _linux_disks()
        else:
            disks = []
    except Exception:
        disks = []
    if not disks:
        # 降级：枚举失败时退回系统盘 / 根目录
        fallback = (os.environ.get("SystemDrive", "C:") + "\\") if os.name == "nt" else "/"
        disk = _usage(fallback, fallback[:2] if os.name == "nt" else fallback)
        disks = [disk] if disk else []
    return {"system": system, "drives": disks[:MAX_DISKS]}


def run(ctx):
    return {"artifact": list_disks()}
