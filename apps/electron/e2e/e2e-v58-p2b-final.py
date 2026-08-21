import json, subprocess, time, websocket
def get_ws(ttype, url_part=''):
    out = subprocess.run(['curl','-s','http://127.0.0.1:9224/json/list'],capture_output=True,text=True).stdout
    for t in json.loads(out):
        if t['type']==ttype and url_part in t['url']: return t['webSocketDebuggerUrl']
def evaluate(ws_url, expr):
    ws=websocket.create_connection(ws_url,timeout=20)
    ws.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':expr,'returnByValue':True,'awaitPromise':True}}))
    while True:
        m=json.loads(ws.recv())
        if m.get('id')==1:
            ws.close(); r=m.get('result',{})
            if 'exceptionDetails' in r: return {'__exc__':json.dumps(r['exceptionDetails'],ensure_ascii=False)[:150]}
            return r.get('result',{}).get('value')
mw=get_ws('page','dist/rendere'); iw=get_ws('iframe')
def read_list():
    return evaluate(mw, """(function(){const bs=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&(d.textContent||'').includes('本轮已调整')); if(!bs.length) return null; return Array.from(bs[bs.length-1].querySelectorAll('button[title*=撤销]')).map(b=>b.title.replace('（点击撤销）',''))})()""")
def discard():
    r=evaluate(mw, """(function(){const bs=Array.from(document.querySelectorAll('div')).filter(d=>d.className&&String(d.className).includes('fixed')&&(d.textContent||'').includes('本轮已调整')); if(!bs.length) return 'no bar'; const b=Array.from(bs[bs.length-1].querySelectorAll('button')).find(x=>/^放弃$/.test((x.textContent||'').trim())); if(!b) return 'no btn'; const rr=b.getBoundingClientRect(); return JSON.stringify({x:rr.x+rr.width/2,y:rr.y+rr.height/2})})()""")
    if isinstance(r,str) and r.startswith('{'):
        p=json.loads(r)
        ws=websocket.create_connection(mw,timeout=15)
        def mouse(ev):
            ws.send(json.dumps({'id':9,'method':'Input.dispatchMouseEvent','params':ev}))
            while True:
                m=json.loads(ws.recv())
                if m.get('id')==9: break
        mouse({'type':'mouseMoved','x':p['x'],'y':p['y'],'button':'none'}); time.sleep(0.1)
        mouse({'type':'mousePressed','x':p['x'],'y':p['y'],'button':'left','clickCount':1})
        mouse({'type':'mouseReleased','x':p['x'],'y':p['y'],'button':'left','clickCount':1})
        ws.close(); time.sleep(1.2)
        return read_list()
    return r
print('== P2b 正式（整数坐标）==')
print('前置清空:', discard())
evaluate(iw, """(function(){const t=document.querySelector('[data-ai-id="tab-us1b"]'); if(t) t.style.transform=''; return 1})()""")
# 干净注入
mk=evaluate(iw, """(function(){
  const old=document.querySelector('style[data-p2b]'); if(old) old.remove();
  const olde=document.querySelector('[data-ai-id="p2b-el"]'); if(olde) olde.remove();
  const st=document.createElement('style'); st.setAttribute('data-p2b','1');
  st.textContent='[data-ai-id="p2b-el"]{transform:translate(31px,-9px)}';
  document.head.appendChild(st);
  const el=document.createElement('div');
  el.setAttribute('data-ai-id','p2b-el'); el.setAttribute('data-ai-type','元素');
  el.textContent='P2B基线元素'; el.style.cssText='padding:8px;background:#eee;display:inline-block;position:fixed;top:300px;left:400px;z-index:9999';
  document.body.appendChild(el);
  return {computedBase:getComputedStyle(el).transform};
})()""")
print('注入基线:', json.dumps(mk))
time.sleep(0.5)
evaluate(iw, "window.dispatchEvent(new MessageEvent('message',{data:{__promaCtfApply:true,action:'drag-start',id:'p2b-el'},source:parent})); 'armed'")
time.sleep(0.5)
res=evaluate(iw, """(function(){
  const el=document.querySelector('[data-ai-id="p2b-el"]');
  const r=el.getBoundingClientRect();
  const cx=Math.round(r.x+r.width/2), cy=Math.round(r.y+r.height/2);
  const fire=(t,ty,Ctor,init)=>t.dispatchEvent(new Ctor(ty,Object.assign({bubbles:true,cancelable:true,view:window},init)));
  fire(el,'pointerdown',PointerEvent,{pointerId:1,pointerType:'mouse',isPrimary:true,clientX:cx,clientY:cy,button:0,buttons:1});
  fire(document,'mousedown',MouseEvent,{clientX:cx,clientY:cy,button:0,buttons:1});
  for(let i=1;i<=6;i++){const x=Math.round(cx+20*i/6),y=Math.round(cy+4*i/6);
    fire(document,'pointermove',PointerEvent,{pointerId:1,pointerType:'mouse',isPrimary:true,clientX:x,clientY:y,buttons:1});
    fire(document,'mousemove',MouseEvent,{clientX:x,clientY:y,button:0,buttons:1});}
  fire(document,'pointerup',PointerEvent,{pointerId:1,pointerType:'mouse',isPrimary:true,clientX:cx+20,clientY:cy+4,buttons:0});
  fire(document,'mouseup',MouseEvent,{clientX:cx+20,clientY:cy+4,button:0,buttons:0});
  return 'dragged';
})()""")
time.sleep(1.3)
p2b=evaluate(iw, """(function(){const el=document.querySelector('[data-ai-id="p2b-el"]'); return {inline: el.style.transform, computed: getComputedStyle(el).transform}})()""")
bar=read_list()
print('inline=%r computed=%r' % (p2b.get('inline'), p2b.get('computed')))
print('清单:', json.dumps(bar, ensure_ascii=False))
ok = p2b.get('inline')=='translate(51px, -5px)' and any('移动(→51,-5)' in x for x in (bar or []))
print('P2b:', 'PASS' if ok else 'FAIL')
print()
print('== 全量清理 ==')
print('放弃清单:', discard())
evaluate(iw, """(function(){
  const st=document.querySelector('style[data-p2b]'); if(st) st.remove();
  const el=document.querySelector('[data-ai-id="p2b-el"]'); if(el) el.remove();
  const t1=document.querySelector('[data-ai-id="tab-us1b"]'); if(t1) t1.style.transform='';
  document.querySelectorAll('[id^=proma-ctf-badge-]').forEach(b=>b.remove());
  return 'cleaned'})()""")
time.sleep(0.5)
final=evaluate(iw, """(function(){const t2=document.querySelector('[data-ai-id="tab-us2"]'); const t1=document.querySelector('[data-ai-id="tab-us1b"]');
  return {tabUs2:(t2.innerText||'').slice(0,20), tabUs1bTransform:t1.style.transform||'(empty)',
          p2bGone:!document.querySelector('[data-ai-id="p2b-el"]'), badgeGone:document.querySelectorAll('[id^=proma-ctf-badge-]').length===0}})()""")
print('清理后:', json.dumps(final, ensure_ascii=False))
print('清单终态:', read_list())
