#!/usr/bin/env python3
"""set-window-props.py — 用 libX11 直写窗口属性（幂等，可反复调用）

用法: set-window-props.py <pid> <res_name> <res_class> <icon.argb>

  1. 遍历 X 窗口树，收集 _NET_WM_PID == pid 的所有窗口
  2. 对每个窗口：WM_CLASS 不符则改写；_NET_WM_ICON 不是我们的 64x64 则改写
  3. 无需改写时静默退出（供看门狗轮询）；有改写时输出一行日志

说明: Electron 会在运行中销毁/重建主窗口（如从托盘重新打开），
     新窗口会带默认 WM_CLASS 和图标，因此必须幂等 + 定期补写，
     而不是只在启动时改写一次。
"""
import ctypes, ctypes.util, struct, sys

def die(msg):
    print(f"[set-window-props] {msg}", file=sys.stderr)
    sys.exit(1)

if len(sys.argv) < 4:
    die("用法: set-window-props.py <pid> <res_name> <res_class> [icon.argb]")

pid_want = int(sys.argv[1])
res_name = sys.argv[2].encode()
res_class = sys.argv[3].encode()
icon_path = sys.argv[4] if len(sys.argv) > 4 else None

xlib = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
xlib.XOpenDisplay.restype = ctypes.c_void_p
xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
xlib.XInternAtom.restype = ctypes.c_ulong
xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
xlib.XQueryTree.restype = ctypes.c_int
xlib.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
                            ctypes.POINTER(ctypes.c_uint)]
xlib.XGetWindowProperty.restype = ctypes.c_int
xlib.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long,
                                    ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
                                    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
                                    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                    ctypes.c_void_p]  # data: format 32 -> c_ulong*, format 8 -> c_ubyte*
xlib.XChangeProperty.restype = ctypes.c_int
xlib.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
                                 ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
xlib.XFree.argtypes = [ctypes.c_void_p]

disp = xlib.XOpenDisplay(None)
if not disp:
    die("无法打开 X display")
root = xlib.XDefaultRootWindow(disp)

def atom(name):
    return xlib.XInternAtom(disp, name.encode(), False)

XA_CARDINAL = 6  # XA_CARDINAL == 6
XA_STRING = 31   # XA_STRING == 31
A_PID = atom("_NET_WM_PID")
A_ICON = atom("_NET_WM_ICON")
A_CLASS = atom("WM_CLASS")

def get_prop32(win, prop, max_words=4096):
    """读 32 位属性，返回 list[int]（低 32 位有效）或 None

    注意: format 32 属性以 long 数组返回（LP64 每项 8 字节，仅低 32 位有效，
    高 32 位是垃圾），必须按 c_ulong 取值后掩码，不能按字节流 4 字节切分。
    """
    rt = ctypes.c_ulong(); rf = ctypes.c_int(); nr = ctypes.c_ulong(); br = ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ulong)()
    ok = xlib.XGetWindowProperty(disp, win, prop, 0, max_words, False, XA_CARDINAL,
                                 ctypes.byref(rt), ctypes.byref(rf), ctypes.byref(nr),
                                 ctypes.byref(br), ctypes.byref(data))
    if ok != 0 or rt.value != XA_CARDINAL or not data:
        return None
    vals = [data[i] & 0xFFFFFFFF for i in range(nr.value)]
    xlib.XFree(data)
    return vals

def get_wm_class(win):
    """读 WM_CLASS（format 8），返回 b'name\\0class\\0' 或 None"""
    rt = ctypes.c_ulong(); rf = ctypes.c_int(); nr = ctypes.c_ulong(); br = ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    ok = xlib.XGetWindowProperty(disp, win, A_CLASS, 0, 256, False, XA_STRING,
                                 ctypes.byref(rt), ctypes.byref(rf), ctypes.byref(nr),
                                 ctypes.byref(br), ctypes.byref(data))
    if ok != 0 or not data:
        return None
    raw = bytes(bytearray(data[i] for i in range(nr.value)))
    xlib.XFree(data)
    return raw

def all_windows():
    """递归遍历窗口树"""
    out, stack = [], [root]
    while stack:
        w = stack.pop()
        out.append(w)
        rt, pc = ctypes.c_ulong(), ctypes.c_ulong()
        children = ctypes.POINTER(ctypes.c_ulong)()
        nc = ctypes.c_uint()
        if xlib.XQueryTree(disp, w, ctypes.byref(rt), ctypes.byref(pc),
                           ctypes.byref(children), ctypes.byref(nc)) != 0 and children:
            for i in range(nc.value):
                stack.append(children[i])
            xlib.XFree(children)
    return out

# 收集该 pid 的所有窗口（不要求已有图标——主窗重建后可能没有）
wins = []
for w in all_windows():
    p = get_prop32(w, A_PID)
    if p and p[0] == pid_want:
        wins.append(w)
if not wins:
    die(f"未找到 PID={pid_want} 的窗口")

want_class = res_name + b'\0' + res_class + b'\0'
icon_vals = None
icon_wh = None
if icon_path:
    raw = open(icon_path, 'rb').read()
    n = len(raw) // 4
    # Xlib format=32 约定: data 是 long 数组（LP64 下每元素 8 字节，仅低 32 位上 wire）。
    # 不能给原始字节缓冲——相邻像素会被拼进同一 long 再截断，属性变成 [w, 0, 0...]。
    vals = struct.unpack_from(f'<{n}I', raw, 0)
    icon_vals = (ctypes.c_ulong * n)(*vals)
    icon_wh = (vals[0], vals[1])
    icon_words = n

for w in wins:
    fixed = []
    # 1) WM_CLASS: "res_name\0res_class\0" (format 8, XA_STRING)
    # 数据内含 NUL，必须用 create_string_buffer（c_char_p 会在首个 NUL 截断）
    if get_wm_class(w) != want_class:
        cls_buf = ctypes.create_string_buffer(want_class, len(want_class))
        xlib.XChangeProperty(disp, w, A_CLASS, XA_STRING, 8, 0,
                             cls_buf, len(want_class))
        fixed.append("class")

    # 2) _NET_WM_ICON（属性格式: w, h, 然后每像素一个 ARGB cardinal）
    # 幂等判据: 已有 64x64 单尺寸图标视为已写过，跳过
    if icon_vals is not None:
        cur = get_prop32(w, A_ICON, max_words=icon_words + 8)
        if not (cur and len(cur) == icon_words and cur[0] == icon_wh[0] and cur[1] == icon_wh[1]):
            xlib.XChangeProperty(disp, w, A_ICON, XA_CARDINAL, 32, 0,
                                 icon_vals, icon_words)
            fixed.append(f"icon={icon_wh[0]}x{icon_wh[1]}")

    if fixed:
        print(f"[set-window-props] win={w:#x} 修复: {','.join(fixed)}")

# 无操作时静默（看门狗每 2s 轮询，刷日志会日增数万行）；仅在真修复时输出
xlib.XFlush(disp)
