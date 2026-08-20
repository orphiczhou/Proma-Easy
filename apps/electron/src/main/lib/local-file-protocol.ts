/**
 * Token-gated local file protocol support for inline previews.
 *
 * The renderer never receives raw proma-file:// absolute paths. Main process
 * code registers an already-authorized file or directory and gets back an
 * opaque URL that the protocol handler can resolve.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net } from 'electron'

type RegisteredEntry = {
  root: string
  isDirectory: boolean
  createdAt: number
}

const registeredEntries = new Map<string, RegisteredEntry>()
const ENTRY_TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 500

function pruneEntries(): void {
  const now = Date.now()
  for (const [token, entry] of registeredEntries) {
    if (now - entry.createdAt > ENTRY_TTL_MS) {
      registeredEntries.delete(token)
    }
  }

  while (registeredEntries.size > MAX_ENTRIES) {
    const oldest = registeredEntries.keys().next().value
    if (!oldest) break
    registeredEntries.delete(oldest)
  }
}

function realpathExisting(path: string): string {
  const resolved = realpathSync(resolve(path))
  if (!existsSync(resolved)) {
    throw new Error(`文件不存在: ${path}`)
  }
  return resolved
}

function isInsideDirectory(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function registerEntry(path: string, isDirectory: boolean): string {
  pruneEntries()
  const root = realpathExisting(path)
  const st = statSync(root)
  if (isDirectory && !st.isDirectory()) {
    throw new Error(`不是目录: ${path}`)
  }
  if (!isDirectory && !st.isFile()) {
    throw new Error(`不是文件: ${path}`)
  }

  const token = randomUUID()
  registeredEntries.set(token, { root, isDirectory, createdAt: Date.now() })
  return `proma-file://${token}`
}

export function registerPromaFilePath(path: string): string {
  return registerEntry(path, false)
}

export function registerPromaDirectoryPath(path: string): string {
  return registerEntry(path, true)
}

/** 点选纠错注入脚本（见 renderer/lib/click-to-fix.ts 的同源注释；主进程协议层注入到 HTML 响应） */
const CLICK_TO_FIX_SCRIPT_TAG = `<script>(function(){if(window.__promaClickToFix)return;window.__promaClickToFix=true;var hT=null;function L(){var l=document.getElementById('proma-ctf-highlight');if(!l){l=document.createElement('div');l.id='proma-ctf-highlight';l.style.cssText='position:absolute;border:2px solid #4F46E5;border-radius:6px;pointer-events:none;z-index:2147483647;background:rgba(79,70,229,.08);display:none';document.documentElement.appendChild(l)}return l}function R(p){try{parent.postMessage(Object.assign({__promaClickToFix:true,filePath:location.href},p),'*')}catch(e){}}var sc=0,st=null;document.addEventListener('click',function(e){if(Date.now()<sc&&e.target===st){sc=0;st=null;return}var t=e.target&&e.target.closest?e.target.closest('[data-ai-id]'):null;var l=L();if(!t){l.style.display='none';R({kind:'blank-click'});return}var id=t.getAttribute('data-ai-id'),ty=t.getAttribute('data-ai-type')||'元素',tx=(t.innerText||t.value||'').trim().slice(0,40);var r=t.getBoundingClientRect();l.style.top=r.top+window.scrollY+'px';l.style.left=r.left+window.scrollX+'px';l.style.width=r.width+'px';l.style.height=r.height+'px';l.style.display='';if(hT)clearTimeout(hT);hT=setTimeout(function(){l.style.display='none'},3000);R({kind:'element-click',id:id,type:ty,text:tx,rect:{x:r.x,y:r.y,w:r.width,h:r.height}})},true);var O={};function U(id){var el=document.querySelector('[data-ai-id="'+id+'"]'),o=O[id];if(!el||!o)return{ok:false};el.style.backgroundColor=o.bg;el.style.color=o.color;el.style.opacity=o.opacity;el.style.transform=o.transform;el.style.textDecoration='';return{ok:true}}window.addEventListener('message',function(e){var d=e.data;if(!d||d.__promaCtfApply!==true)return;if(e.source!==parent)return;if(d.action==='annotate'){var el=document.querySelector('[data-ai-id="'+d.id+'"]');if(!el)return;if(getComputedStyle(el).position==='static')el.style.position='relative';var bag=document.getElementById('proma-ctf-badge-'+d.id);if(!bag){bag=document.createElement('div');bag.id='proma-ctf-badge-'+d.id;bag.style.cssText='position:absolute;top:2px;right:2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#DC2626;color:#fff;font-size:10px;line-height:16px;text-align:center;cursor:pointer;z-index:9999;box-shadow:0 1px 3px rgba(0,0,0,.4)';el.appendChild(bag)}var n=parseInt(bag.textContent,10)||0;bag.textContent=String(n+1);if(!el.__ctfNotes)el.__ctfNotes=[];el.__ctfNotes.push(d.text||'');var strip=document.getElementById('proma-ctf-strip-'+d.id);if(!strip){strip=document.createElement('div');strip.id='proma-ctf-strip-'+d.id;strip.style.cssText='position:absolute;left:0;bottom:-20px;max-width:100%;padding:2px 6px;border-radius:4px;background:rgba(79,70,229,.9);color:#fff;font-size:10px;line-height:1.3;z-index:9998;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 6px rgba(0,0,0,.35)';el.appendChild(strip)}strip.textContent=d.text||'';var showTip=function(ev){ev.stopPropagation();var tip=document.getElementById('proma-ctf-tip-'+d.id);if(!tip){tip=document.createElement('div');tip.id='proma-ctf-tip-'+d.id;tip.style.cssText='position:absolute;top:-10px;right:12px;z-index:9997;max-width:220px;padding:6px 8px;border-radius:6px;background:#1f2937;color:#f9fafb;font-size:11px;line-height:1.5;box-shadow:0 4px 12px rgba(0,0,0,.5);white-space:pre-wrap';el.appendChild(tip)}var notes=el.__ctfNotes||[d.text||''];tip.textContent=notes.map(function(t2,i2){return(i2+1)+'. '+t2}).join('\\n');tip.style.display=tip.style.display==='none'?'':'none'};bag.onclick=showTip;strip.onclick=showTip;return}if(d.action==='remove-annotation'){var b2=document.getElementById('proma-ctf-badge-'+d.id),t2=document.getElementById('proma-ctf-tip-'+d.id),s2=document.getElementById('proma-ctf-strip-'+d.id);if(b2){var c=(parseInt(b2.textContent,10)||1)-1;if(c<=0){b2.remove();if(s2)s2.remove()}else{b2.textContent=String(c)}}if(t2)t2.remove()}if(d.action==='undo'){U(d.id);return}if(d.action==='undo-all'){Object.keys(O).forEach(function(i){U(i)});var bs=document.querySelectorAll('[id^="proma-ctf-badge-"], [id^="proma-ctf-tip-"], [id^="proma-ctf-strip-"]');for(var i2=0;i2<bs.length;i2++)bs[i2].remove();return}var el=document.querySelector('[data-ai-id="'+d.id+'"]');if(!el){R({kind:'change-result',id:d.id,action:d.action,ok:false,error:'not found'});return}if(!O[d.id]){O[d.id]={bg:el.style.backgroundColor||'',color:el.style.color||'',opacity:el.style.opacity||'',transform:el.style.transform||''}}var ty=el.getAttribute('data-ai-type')||'元素',tx=(el.innerText||el.value||'').trim().slice(0,40);if(d.action==='drag-start'){el.style.cursor='move';var base=el.style.transform||'',sx=0,sy=0,active=false,ldx=0,ldy=0;var mv=function(ev){if(!active)return;var dx=ev.clientX-sx,dy=ev.clientY-sy;ldx=dx;ldy=dy;el.style.transform=base+' translate('+dx+'px, '+dy+'px)'};var fin=function(dx,dy){active=false;document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);el.style.cursor='';var rdx=Math.round(dx),rdy=Math.round(dy);var th=4*(window.devicePixelRatio||1);if(Math.abs(rdx)<th&&Math.abs(rdy)<th){el.style.transform=base;return}el.style.transform=base+' translate('+rdx+'px, '+rdy+'px)';sc=Date.now()+400;st=el;R({kind:'change-result',id:d.id,action:'move',ok:true,type:ty,text:tx,value:{dx:rdx,dy:rdy}})};var up=function(ev){fin(ev.clientX-sx,ev.clientY-sy)};var down=function(ev){sx=ev.clientX;sy=ev.clientY;active=true;try{el.setPointerCapture(ev.pointerId)}catch(err){}document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);ev.preventDefault()};el.addEventListener('pointerdown',down,{once:true});el.addEventListener('mouseleave',function(){if(active)fin(ldx,ldy)},{once:true});return}if(d.action==='color'){el.style.backgroundColor=d.value}else if(d.action==='delete'){el.style.opacity='0.3';el.style.textDecoration='line-through'}else if(d.action==='move'){var m=(O[d.id].transform||'').match(/translate\(([\d.-]+)px, ([\d.-]+)px\)/);var bx=m?parseFloat(m[1]):0,by=m?parseFloat(m[2]):0;el.style.transform='translate('+(bx+(d.value.dx||0))+'px, '+(by+(d.value.dy||0))+'px)'}R({kind:'change-result',id:d.id,action:d.action,ok:true,error:'',type:ty,text:tx,value:d.value})});})();</script>`

/** 把注入脚本追加进 HTML 文本（只处理 .html/.htm，插在 </body> 前或尾部） */
async function injectClickToFix(response: Response, target: string): Promise<Response> {
  const lower = target.toLowerCase()
  if (!lower.endsWith('.html') && !lower.endsWith('.htm')) return response
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html')) return response
  let html: string
  try {
    html = await response.text()
  } catch {
    return response
  }
  if (html.includes('__promaClickToFix')) return new Response(html, { headers: response.headers })
  const injected = html.includes('</body>')
    ? html.replace('</body>', `${CLICK_TO_FIX_SCRIPT_TAG}</body>`)
    : html + CLICK_TO_FIX_SCRIPT_TAG
  const headers = new Headers(response.headers)
  // 文本已读入内存，移除可能的长度不匹配头
  headers.delete('content-length')
  return new Response(injected, { headers })
}

export async function handlePromaFileRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const token = url.hostname
  const entry = registeredEntries.get(token)
  if (!entry) {
    return new Response('Not Found', { status: 404 })
  }

  let target = entry.root
  if (entry.isDirectory) {
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    try {
      target = realpathSync(resolve(entry.root, relativePath))
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!isInsideDirectory(target, entry.root)) {
      return new Response('Forbidden', { status: 403 })
    }
  } else if (url.pathname && url.pathname !== '/') {
    return new Response('Not Found', { status: 404 })
  }

  return injectClickToFix(await net.fetch(pathToFileURL(target).toString()), target)
}
// 注：handlePromaFileRequest 返回类型为 Promise<Response> | Response，
