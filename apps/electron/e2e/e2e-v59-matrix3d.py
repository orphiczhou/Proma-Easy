#!/usr/bin/env python3
"""v0.17.59 E2E：matrix3d（translateZ）拖拽终态验证（WO7）

验证目标（WO1①②③④）：
- 注入脚本 parseMatrixFull 完整解析 matrix3d（16 值严格校验）
- applyTranslate 只叠加 [12]/[13]，[14]（tz）与旋转/缩放分量原样保留
- 真实 Chromium 拖拽后 inline transform = 含 [12]/[13]/[14] 的 matrix3d 精确串
- agent:report-click-to-fix（接受本轮改动）载荷含 finalTransform 终值文本

前置（README.md 有完整说明）：
- 真实 Chromium（Proma Electron dev 实例，CDP 127.0.0.1:9224）
- DISPLAY 可用（Linux 需 X11 或 xvfb-run 包装）
- 打开一个南大项目会话且预览 iframe 可见（iframe target 存在）
- python3 + websocket-client（pip install websocket-client）

方法学：同 e2e-v58-final-rerun.py——持久 CDP ws 连接；每轮拖拽前 warmup 微拖(2px)
解除 CDP 合成事件的 mouse 抑制（pointerdown preventDefault quirk）。
"""
import json, subprocess, time, websocket

def _targets():
    out = subprocess.run(["curl", "-s", "http://127.0.0.1:9224/json/list"], capture_output=True, text=True).stdout
    return json.loads(out)

def get_ws(ttype, url_part=""):
    for t in _targets():
        if t["type"] == ttype and url_part in t["url"]:
            return t["webSocketDebuggerUrl"]
    return None

class Conn:
    """持久 CDP 连接：send(cmd) 异步发，collect(n) 等收 n 个回复"""
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self.id = 0
    def send(self, method, params):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params}))
        return self.id
    def collect(self, until_id, timeout=30):
        self.ws.settimeout(timeout)
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == until_id:
                r = m.get("result", {})
                if "exceptionDetails" in r:
                    return {"__exc__": json.dumps(r["exceptionDetails"], ensure_ascii=False)[:250]}
                return r.get("result", {}).get("value")
    def eval(self, expr):
        return self.collect(self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True}))
    def close(self):
        try: self.ws.close()
        except Exception: pass

MAIN = Conn(get_ws("page", "dist/rendere"))
IFR = Conn(get_ws("iframe"))

def cdp_click_seq(conn, x, y, pre_move=True):
    if pre_move:
        conn.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        time.sleep(0.15)
    a = conn.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
    b = conn.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
    conn.collect(a); conn.collect(b)

def cdp_drag_seq(conn, cx, cy, dx, dy):
    """单连接内完整拖拽序列（~3s）"""
    conn.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx, "y": cy, "button": "none"})
    time.sleep(0.3)
    a = conn.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1})
    conn.collect(a); time.sleep(0.3)
    ids = []
    for i in range(1, 5):
        time.sleep(0.12)
        ids.append(conn.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx + dx*i/4, "y": cy + dy*i/4, "button": "left"}))
    for i in ids: conn.collect(i)
    time.sleep(0.2)
    r = conn.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx + dx, "y": cy + dy, "button": "left", "clickCount": 1})
    conn.collect(r)

def center_of(sel):
    return IFR.eval("""
    (function(){const el=document.querySelector('[data-ai-id="%s"]'); if(!el) return null;
      const r=el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2};})()""" % sel)

def read_list():
    return MAIN.eval("""(function(){const bs=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&(d.textContent||'').includes('本轮已调整')); if(!bs.length) return null; return Array.from(bs[bs.length-1].querySelectorAll('button[title*=撤销]')).map(b=>b.title.replace('（点击撤销）',''))})()""")

def discard_all():
    r = MAIN.eval("""(function(){const bs=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&(d.textContent||'').includes('本轮已调整')); if(!bs.length) return 'no bar'; const b=Array.from(bs[bs.length-1].querySelectorAll('button')).find(x=>/^放弃$/.test((x.textContent||'').trim())); if(!b) return 'no discard btn'; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()""")
    if isinstance(r, str) and r.startswith("{"):
        p = json.loads(r)
        cdp_click_seq(MAIN, p["x"], p["y"])
        time.sleep(1.2)
        return read_list()
    return r

def esc_main():
    a = MAIN.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    MAIN.collect(a); time.sleep(0.5)

# Chrome computed：translate(31px,-9px) translateZ(40px) → matrix3d(..., 31, -9, 40, 1)
# 拖 +20,+4 → 终态 [12]=51, [13]=-5, [14]=40 原样保留
EXPECTED = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 51, -5, 40, 1)"
R = {}

print("===== M3D 前置：干净起点 =====")
esc_main()
print("前置清空:", discard_all())

print("\n===== 注入 matrix3d（translateZ）夹具 =====")
mk = IFR.eval("""
(function(){
  const old=document.querySelector('style[data-m3d]'); if(old) old.remove();
  const olde=document.querySelector('[data-ai-id="m3d-el"]'); if(olde) olde.remove();
  const st=document.createElement('style'); st.setAttribute('data-m3d','1');
  st.textContent='[data-ai-id="m3d-el"]{transform:translate(31px,-9px) translateZ(40px)}';
  document.head.appendChild(st);
  const el=document.createElement('div');
  el.setAttribute('data-ai-id','m3d-el'); el.setAttribute('data-ai-type','元素');
  el.textContent='M3D基线元素(translateZ)'; el.style.cssText='padding:8px;background:#eef;display:inline-block;position:fixed;top:320px;left:420px;z-index:9999';
  document.body.appendChild(el);
  return {computedBase:getComputedStyle(el).transform};
})()""")
print("注入基线:", json.dumps(mk))
time.sleep(0.5)

# arm：优先走真实面板链路（点元素→面板→换个位置），失败退化 message 直发
c = center_of("m3d-el")
cdp_click_seq(IFR, c["x"], c["y"])
time.sleep(1.3)
btn = MAIN.eval("""(function(){const p=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&/对此.+的操作/.test(d.textContent||'')); if(!p.length) return null; const b=Array.from(p[p.length-1].querySelectorAll('button')).find(x=>(x.textContent||'').includes('换个位置')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()""")
arm = "panel"
if isinstance(btn, dict) and "x" in btn:
    cdp_click_seq(MAIN, btn["x"], btn["y"])
    time.sleep(1.0)
else:
    print("面板无换位按钮 → message 兜底 arm:", btn)
    IFR.eval("window.dispatchEvent(new MessageEvent('message',{data:{__promaCtfApply:true,action:'drag-start',id:'m3d-el'},source:parent})); 'armed'")
    arm = "message"
    time.sleep(0.5)
cur = IFR.eval("document.querySelector('[data-ai-id=\"m3d-el\"]').style.cursor")
print("arm(%s) cursor=%r" % (arm, cur))

print("\n===== 真实 Chromium 拖拽（warmup + 拖 +20,+4）=====")
c = center_of("m3d-el")
cdp_drag_seq(IFR, c["x"], c["y"], 2, 2)     # warmup 微拖（<4px 阈值：还原且不上报）
time.sleep(0.6)
cdp_drag_seq(IFR, c["x"], c["y"], 20, 4)
time.sleep(1.3)

res = IFR.eval("""(function(){const el=document.querySelector('[data-ai-id="m3d-el"]');
  return {inline: el.style.transform, computed: getComputedStyle(el).transform}})()""")
bar = read_list()
print("inline=%r" % res.get("inline"))
print("computed=%r" % res.get("computed"))
print("清单:", json.dumps(bar, ensure_ascii=False))

a_ok = res.get("inline") == EXPECTED
b_ok = "matrix3d(" in str(res.get("computed")) and ", 40, 1)" in str(res.get("computed"))
c_ok = isinstance(bar, list) and any("移动(→51,-5)" in x for x in bar)
R["inline"] = res.get("inline"); R["computed"] = res.get("computed"); R["list"] = bar
print("断言 inline=精确 matrix3d 串:", "PASS" if a_ok else "FAIL")
print("断言 computed 含保留的 [14]=40:", "PASS" if b_ok else "FAIL")
print("断言 清单含 移动(→51,-5):", "PASS" if c_ok else "FAIL")

print("\n===== agent:report-click-to-fix 载荷（hook 收集，阻断真实注入）=====")
MAIN.eval("""(function(){
  window.__ctfReports = [];
  const api = window.electronAPI; if (!api || !api.reportClickToFix) return 'no api';
  if (!api.__hooked) {
    api.__hooked = true;
    api.reportClickToFix = function(p){ window.__ctfReports.push(p); return Promise.resolve({ ok: false }); };
  }
  return 'hooked';
})()""")
acc = MAIN.eval("""(function(){const bs=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&(d.textContent||'').includes('本轮已调整')); if(!bs.length) return 'no bar'; const b=Array.from(bs[bs.length-1].querySelectorAll('button')).find(x=>/接受本轮改动/.test((x.textContent||'').trim())); if(!b) return 'no accept btn'; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()""")
if isinstance(acc, str) and acc.startswith("{"):
    p = json.loads(acc)
    cdp_click_seq(MAIN, p["x"], p["y"])
    time.sleep(1.5)
    reports = MAIN.eval("window.__ctfReports || []")
    print("收集到 reportClickToFix 载荷数:", len(reports))
    payload_ok = False
    payload_final = None
    for rep in reports:
        try:
            items = json.loads(rep.get("action") or "[]")
        except Exception:
            continue
        for it in items:
            if it.get("action") == "move" and it.get("id") == "m3d-el":
                payload_final = it.get("finalTransform")
                if payload_final == EXPECTED:
                    payload_ok = True
    print("载荷 move.finalTransform=%r" % payload_final)
    print("断言 载荷含终值文本（finalTransform=精确 matrix3d 串）:", "PASS" if payload_ok else "FAIL")
    R["payload_finalTransform"] = payload_final
else:
    print("接受按钮不可用:", acc)
    R["payload_finalTransform"] = None

print("\n===== 清理 =====")
print("放弃清单:", discard_all())
IFR.eval("""
(function(){
  const st=document.querySelector('style[data-m3d]'); if(st) st.remove();
  const el=document.querySelector('[data-ai-id="m3d-el"]'); if(el) el.remove();
  document.querySelectorAll('[id^=proma-ctf-badge-]').forEach(b=>b.remove());
  return 'cleaned'})()""")
time.sleep(0.5)
final = IFR.eval("""(function(){return {m3dGone:!document.querySelector('[data-ai-id="m3d-el"]'), badgeGone:document.querySelectorAll('[id^=proma-ctf-badge-]').length===0}})()""")
print("清理后:", json.dumps(final, ensure_ascii=False))
print("清单终态:", read_list())

print("\n===== 判定矩阵 =====")
verdict = a_ok and b_ok and c_ok and R.get("payload_finalTransform") == EXPECTED
for k, v in [("inline 精确串", a_ok), ("computed tz 保留", b_ok), ("清单条目", c_ok), ("载荷 finalTransform", R.get("payload_finalTransform") == EXPECTED)]:
    print("%s: %s" % (k, "PASS" if v else "FAIL"))
print("\nM3D E2E:", "PASS" if verdict else "FAIL")
print("EVIDENCE:", json.dumps(R, ensure_ascii=False))
IFR.close(); MAIN.close()
