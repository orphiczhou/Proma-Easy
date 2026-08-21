#!/usr/bin/env python3
"""v0.17.58 E2E 复验 v4（最终）
修复方法学：持久 CDP ws 连接（单轮拖拽 ~3s < 30s idle 窗口）
- iframe 内交互 → iframe target；宿主 UI → 主窗口 target
- 每轮拖拽前 warmup 微拖(2px) 解除 CDP 合成事件的 mouse 抑制（pointerdown preventDefault quirk）
"""
import json, subprocess, time, uuid, websocket

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

def ifr_reconnect():
    """iframe reload 后重连"""
    global IFR
    IFR.close()
    w = get_ws("iframe")
    assert w, "iframe target lost"
    IFR = Conn(w)

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

def panel_state():
    return MAIN.eval("""(function(){return Array.from(document.querySelectorAll('div')).some(d=>d.className&&String(d.className).includes('fixed')&&/对此.+的操作/.test(d.textContent||''))})()""")

def panel_btn(substr):
    return MAIN.eval("""(function(){const p=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&/对此.+的操作/.test(d.textContent||'')); if(!p.length) return null; const host=p[p.length-1]; const b=Array.from(host.querySelectorAll('button')).find(x=>(x.textContent||'').includes('%s')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,label:(b.textContent||'').trim()}})()""" % substr)

def esc_main():
    a = MAIN.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    MAIN.collect(a); time.sleep(0.5)

def discard_all():
    r = MAIN.eval("""(function(){const bs=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&(d.textContent||'').includes('本轮已调整')); if(!bs.length) return 'no bar'; const b=Array.from(bs[bs.length-1].querySelectorAll('button')).find(x=>/^放弃$/.test((x.textContent||'').trim())); if(!b) return 'no discard btn'; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()""")
    if isinstance(r, str) and r.startswith("{"):
        p = json.loads(r)
        cdp_click_seq(MAIN, p["x"], p["y"])
        time.sleep(1.2)
        return read_list()
    return r

def key_ifr(key_str, code="", text_=""):
    params = {"type": "keyDown", "key": key_str, "code": code or key_str,
              "windowsVirtualKeyCode": ord(key_str[0].upper()) if key_str else 0}
    if text_: params["text"] = text_
    a = IFR.send("Input.dispatchKeyEvent", params)
    IFR.collect(a)

def insert_ifr(t):
    a = IFR.send("Input.insertText", {"text": t})
    IFR.collect(a)

R = {}
t_start = time.time()
agent_sid = MAIN.eval("document.querySelector('iframe[data-proma-preview]').getAttribute('data-proma-preview')")
print("[%.1fs] agent_sid:" % (time.time()-t_start), agent_sid)

# ===== 干净起点：关面板 + 放弃清单 + reload iframe =====
esc_main()
discard_all()
IFR.eval("location.reload(); 'r'")
time.sleep(2.5)
ifr_reconnect()
BASE_TXT = IFR.eval("(document.querySelector('[data-ai-id=\"tab-us2\"]')||{}).innerText || ''")
print("[%.1fs] reload 完成, tab-us2 原文:" % (time.time()-t_start), json.dumps(BASE_TXT, ensure_ascii=False))

# ============ P3 ============
print("\n===== P3 语音链路 =====")
asr_sid = str(uuid.uuid4())
r3 = MAIN.eval("""
(function(){
  const ev = new CustomEvent('proma:insert-voice-dictation-text', {
    cancelable: true,
    detail: { sessionId: '%s', text: '把这行加粗放大', targetInputId: 'ctf-voice-%s-row-in' }
  });
  return { prevented: !window.dispatchEvent(ev) };
})()""" % (asr_sid, agent_sid))
time.sleep(1.2)
badge = IFR.eval("(function(){const b=document.getElementById('proma-ctf-badge-row-in'); return b?{count:b.textContent,onDoc:b.parentElement===document.documentElement}:null})()")
bar3 = read_list()
print("prevented=%s badge=%s 清单=%s" % (json.dumps(r3), json.dumps(badge), json.dumps(bar3, ensure_ascii=False)))
p3_ok = isinstance(r3, dict) and r3.get("prevented") is True and badge and badge.get("onDoc") and bar3 and any("💬" in x for x in bar3)
R["P3"] = {"pass": bool(p3_ok), "prevented": r3, "badge": badge, "list": bar3}
print("P3:", "PASS" if p3_ok else "FAIL")
discard_all(); time.sleep(0.8)

# ============ P1 ============
print("\n===== P1 改文字原地编辑 =====")
IFR.eval("(function(){document.querySelector('[data-ai-id=\"tab-us2\"]').scrollIntoView({block:'center',behavior:'instant'}); return 1})()")
c = center_of("tab-us2")
cdp_click_seq(IFR, c["x"], c["y"])
time.sleep(1.3)
po = panel_state()
b = panel_btn("改文字")
if not (isinstance(b, dict) and "x" in b):
    R["P1"] = {"pass": False, "err": "面板未开", "panelOpen": po}
    print("P1: FAIL 面板未开", po, b)
else:
    cdp_click_seq(MAIN, b["x"], b["y"])
    time.sleep(1.1)
    st = IFR.eval("(function(){const el=document.querySelector('[data-ai-id=\"tab-us2\"]'); return {editable: el.isContentEditable, focused: document.activeElement===el, tag: el.tagName, sel: String(getSelection()).slice(0,25)}})()")
    print("编辑态:", json.dumps(st, ensure_ascii=False))
    insert_ifr("US-2 全单位对照E2E")
    time.sleep(0.4)
    key_ifr("Enter", "Enter", "\r")
    time.sleep(1.3)
    after = IFR.eval("(function(){const el=document.querySelector('[data-ai-id=\"tab-us2\"]'); return {text:(el.innerText||'').slice(0,40), editable: el.isContentEditable}})()")
    bar1 = read_list()
    print("结果: %s 清单=%s" % (json.dumps(after, ensure_ascii=False), json.dumps(bar1, ensure_ascii=False)))
    p1_ok = (st.get("editable") and st.get("focused")
             and after and after.get("text","").startswith("US-2 全单位")
             and not after.get("editable")
             and bar1 and any(("改文字" in x and "US-2 全单位" in x) for x in bar1))
    R["P1"] = {"pass": bool(p1_ok), "editState": st, "after": after, "list": bar1}
    print("P1:", "PASS" if p1_ok else "FAIL")
discard_all(); time.sleep(0.8)
# P1 文本还原（防影响后续视觉）
IFR.eval("(function(){const el=document.querySelector('[data-ai-id=\"tab-us2\"]'); el.innerText=%s; return 1})()" % json.dumps(BASE_TXT))

# ============ P2a ============
print("\n===== P2a 拖拽持续模式 =====")
# 真实链路：点元素开面板 → 点「换个位置」
IFR.eval("(function(){document.querySelector('[data-ai-id=\"tab-us1b\"]').scrollIntoView({block:'center',behavior:'instant'}); return 1})()")
c = center_of("tab-us1b")
cdp_click_seq(IFR, c["x"], c["y"])
time.sleep(1.3)
b = panel_btn("换个位置")
arm = "panel"
if isinstance(b, dict) and "x" in b:
    cdp_click_seq(MAIN, b["x"], b["y"])
    time.sleep(1.0)
else:
    print("面板无换位按钮 → message 兜底:", b)
    IFR.eval("window.dispatchEvent(new MessageEvent('message',{data:{__promaCtfApply:true,action:'drag-start',id:'tab-us1b'},source:parent})); 'armed'")
    arm = "message"
    time.sleep(0.5)
cur = IFR.eval("document.querySelector('[data-ai-id=\"tab-us1b\"]').style.cursor")
print("arm(%s) cursor=%r" % (arm, cur))

def do_drag(dx, dy, sel="tab-us1b"):
    cc = center_of(sel)
    cdp_drag_seq(IFR, cc["x"], cc["y"], dx, dy)

t0 = time.time()
do_drag(2, 2)      # warmup 微拖（<4px 阈值：还原且不上报；解除 CDP mouse 抑制）
w_tr = IFR.eval("document.querySelector('[data-ai-id=\"tab-us1b\"]').style.transform")
print("[%.1fs] warmup transform=%r" % (time.time()-t0, w_tr))
do_drag(40, 10)
t1 = IFR.eval("(function(){const el=document.querySelector('[data-ai-id=\"tab-us1b\"]'); return {tr:el.style.transform, cur:el.style.cursor}})()")
print("[%.1fs] drag1: %s" % (time.time()-t0, json.dumps(t1)))
do_drag(2, 2)      # 第二轮前 warmup（drag1 的 pointerdown 又设了抑制）
do_drag(30, 5)
t2 = IFR.eval("(function(){const el=document.querySelector('[data-ai-id=\"tab-us1b\"]'); return {tr:el.style.transform, cur:el.style.cursor}})()")
print("[%.1fs] drag2: %s" % (time.time()-t0, json.dumps(t2)))
bar_a = read_list()
print("清单:", json.dumps(bar_a, ensure_ascii=False))
# 点自身（dragMode 活着应不弹面板；1s 内完成避免 idle）
c = center_of("tab-us1b")
cdp_click_seq(IFR, c["x"], c["y"])
time.sleep(1.2)
panel = panel_state()
cur2 = IFR.eval("document.querySelector('[data-ai-id=\"tab-us1b\"]').style.cursor")
print("点自身后 panel=%s cursor=%r" % (panel, cur2))
p2a_drag_ok = t1.get("tr") and t2.get("tr") and t1["tr"] != t2["tr"]
p2a_ok = p2a_drag_ok and panel == False
R["P2a"] = {"pass": bool(p2a_ok), "arm": arm, "drag1": t1, "drag2": t2, "list": bar_a, "selfClickPanel": panel, "cursorAfter": cur2}
print("P2a:", "PASS" if p2a_ok else "FAIL")
discard_all()
IFR.eval("document.querySelector('[data-ai-id=\"tab-us1b\"]').style.transform=''; 1")
time.sleep(0.8)

# ============ P2b ============
print("\n===== P2b 绝对偏移 =====")
mk = IFR.eval("""
(function(){
  const old=document.querySelector('style[data-p2b]'); if(old) old.remove();
  const olde=document.querySelector('[data-ai-id=\"p2b-el\"]'); if(olde) olde.remove();
  const st=document.createElement('style'); st.setAttribute('data-p2b','1');
  st.textContent='[data-ai-id="p2b-el"]{transform:translate(31px,-9px)}';
  document.head.appendChild(st);
  const el=document.createElement('div');
  el.setAttribute('data-ai-id','p2b-el'); el.setAttribute('data-ai-type','元素');
  el.textContent='P2B基线元素'; el.style.cssText='padding:8px;background:#eee;display:inline-block;position:fixed;top:300px;left:400px;z-index:9999';
  document.body.appendChild(el);
  return {computedBase:getComputedStyle(el).transform, inlineBefore:el.style.transform};
})()""")
print("注入:", json.dumps(mk))
time.sleep(0.5)
IFR.eval("window.dispatchEvent(new MessageEvent('message',{data:{__promaCtfApply:true,action:'drag-start',id:'p2b-el'},source:parent})); 'armed'")
time.sleep(0.5)
cur = IFR.eval("document.querySelector('[data-ai-id=\"p2b-el\"]').style.cursor")
print("p2b arm cursor=%r" % cur)
do_drag(2, 2, "p2b-el")   # warmup
do_drag(20, 4, "p2b-el")
time.sleep(1.2)
p2b = IFR.eval("(function(){const el=document.querySelector('[data-ai-id=\"p2b-el\"]'); return {inline: el.style.transform, computed: getComputedStyle(el).transform}})()")
bar_b = read_list()
print("inline=%r computed=%r" % (p2b.get("inline"), p2b.get("computed")))
print("清单:", json.dumps(bar_b, ensure_ascii=False))
expected = "translate(51px,-5px)"
p2b_ok = p2b.get("inline") and expected.replace(" ","") in str(p2b.get("inline")).replace(" ","")
R["P2b"] = {"pass": bool(p2b_ok), "expect": expected, "inline": p2b.get("inline"), "computed": p2b.get("computed"), "list": bar_b}
print("P2b:", "PASS" if p2b_ok else "FAIL")

# ============ 清理 ============
print("\n===== 清理 =====")
discard_all()
IFR.eval("""
(function(){
  const st=document.querySelector('style[data-p2b]'); if(st) st.remove();
  const el=document.querySelector('[data-ai-id=\"p2b-el\"]'); if(el) el.remove();
  const t1=document.querySelector('[data-ai-id=\"tab-us1b\"]'); if(t1) t1.style.transform='';
  document.querySelectorAll('[id^=proma-ctf-badge-]').forEach(b=>b.remove());
  return 'cleaned'})()""")
time.sleep(0.5)
final = IFR.eval("""
(function(){const t2=document.querySelector('[data-ai-id=\"tab-us2\"]'); const t1=document.querySelector('[data-ai-id=\"tab-us1b\"]');
  return {tabUs2:(t2.innerText||'').slice(0,20), tabUs1bTransform:t1.style.transform||'(empty)',
          p2bGone:!document.querySelector('[data-ai-id=\"p2b-el\"]'), badgeGone:document.querySelectorAll('[id^=proma-ctf-badge-]').length===0}})()""")
fl = read_list()
print("清理后清单:", json.dumps(fl, ensure_ascii=False))
print("清理后 iframe:", json.dumps(final, ensure_ascii=False))

print("\n===== 判定矩阵 =====")
for k in ["P3","P1","P2a","P2b"]:
    v = R.get(k, {})
    print(f"{k}: {'PASS' if v.get('pass') else 'FAIL'}")
print("\nEVIDENCE:", json.dumps(R, ensure_ascii=False))
