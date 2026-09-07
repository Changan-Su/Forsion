import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, MousePointer2 } from 'lucide-react'
import { StudioGuestSurface } from './StudioGuestSurface'
import { Webview } from '../../builtins/browserView'
import { BROWSER_PARTITION } from '../../../../shared/browser'
import { useI18n } from '../../i18n'
import type { PreviewDevice, SelectedElement, StudioIssue } from './studioModel'
import './studioMessages'

interface Guest extends HTMLElement { reload(): void; getURL(): string; executeJavaScript(code: string): Promise<unknown> }
interface Props {
  url: string
  nonce: number
  device: PreviewDevice
  inspecting: boolean
  visible?: boolean
  onActivate?(): void
  onInspectEnd(): void
  onSelect(element: SelectedElement): void
  onIssue(issue: StudioIssue): void
  onStatus(status: 'loading' | 'ready' | 'error'): void
}
/** Isolated guest DOM inspection. No Electron/host APIs are exposed to the generated app. */
export function inspectorScript(marker: string, enabled: boolean): string {
  return `(() => {
    if (window.__forsionStudioInspect) window.__forsionStudioInspect();
    if (!${JSON.stringify(enabled)}) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2563eb;background:rgba(37,99,235,.08);box-sizing:border-box;display:none';
    document.documentElement.appendChild(overlay);
    const selector = el => {
      const parts=[]; let node=el;
      for(let i=0;node && node.nodeType===1 && i<5;i++,node=node.parentElement){
        if(node.id){parts.unshift('#'+CSS.escape(node.id));break;}
        let part=node.tagName.toLowerCase();
        const siblings=node.parentElement ? [...node.parentElement.children].filter(n=>n.tagName===node.tagName) : [];
        if(siblings.length>1) part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';
        parts.unshift(part);
      }
      return parts.join(' > ');
    };
    const move = e => { const el=e.target; if(!(el instanceof Element)||el===overlay)return; const r=el.getBoundingClientRect();Object.assign(overlay.style,{display:'block',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'}); };
    const cleanup = () => { overlay.remove();document.removeEventListener('pointermove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);delete window.__forsionStudioInspect; };
    const click = e => {const el=e.target;if(!(el instanceof Element))return;e.preventDefault();e.stopImmediatePropagation();
      const clone=el.cloneNode(true); if(el.matches('input,textarea,[contenteditable]')) clone.textContent=''; clone.querySelectorAll('input,textarea,[contenteditable],script,style').forEach(n=>n.remove());
      for(const n of [clone,...clone.querySelectorAll('*')]) for(const a of [...n.attributes]) if(!['class','id','role','type','aria-label'].includes(a.name)) n.removeAttribute(a.name);
      const text=el.matches('input,textarea,[contenteditable]')?'':(clone.textContent||'').trim();
      console.info(${JSON.stringify(marker)}+JSON.stringify({tag:el.tagName.toLowerCase(),selector:selector(el),text:text.slice(0,600),html:clone.outerHTML.slice(0,1600),url:location.origin+location.pathname}));cleanup();};
    const key=e=>{if(e.key==='Escape'){cleanup();console.info(${JSON.stringify(marker)}+'null');}};
    document.addEventListener('pointermove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);window.__forsionStudioInspect=cleanup;
  })()`
}
export function StudioPreview(props: Props) {
  const { t } = useI18n()
  const frame = useRef<Guest | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const [guest, setGuest] = useState<Guest | null>(null)
  const attachGuest = useCallback((element: HTMLElement | null) => { frame.current = element as Guest | null; setGuest(element as Guest | null) }, [])
  const callbacks = useRef(props); callbacks.current = props
  const marker = useRef(`__forsion_studio_${Math.random().toString(36).slice(2)}:`)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const loaded = useRef(false)
  const priorNonce = useRef(props.nonce)
  useEffect(() => {
    const el = guest
    if (!el) return
    function report(next: 'loading' | 'ready' | 'error') { setStatus(next); callbacks.current.onStatus(next) }
    const start = () => { loaded.current = false; setError(''); report('loading') }
    const ready = () => {
      loaded.current = true; report('ready')
      if (callbacks.current.inspecting) {
        try {
          if (new URL(el.getURL()).origin === new URL(callbacks.current.url).origin) void el.executeJavaScript(inspectorScript(marker.current, true)).catch(() => callbacks.current.onInspectEnd())
          else callbacks.current.onInspectEnd()
        } catch { callbacks.current.onInspectEnd() }
      }
    }
    const fail = (e: Event) => {
      const d = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (d.errorCode === -3 || d.isMainFrame === false) return
      const message = d.errorDescription || String(d.errorCode)
      setError(message); report('error')
      callbacks.current.onIssue({ id: `load-${Date.now()}`, level: 'error', message, source: props.url, at: Date.now() })
    }
    const consoleMessage = (e: Event) => {
      const d = e as Event & { level: number | string; message: string; sourceId?: string; line?: number }
      if (d.message?.startsWith(marker.current)) {
        try {
          const value = JSON.parse(d.message.slice(marker.current.length)) as SelectedElement | null
          if (value && typeof value.selector === 'string' && typeof value.text === 'string' && typeof value.html === 'string' && typeof value.url === 'string' && typeof value.tag === 'string') {
            callbacks.current.onSelect({ tag: value.tag.slice(0, 80), selector: value.selector.slice(0, 500), text: value.text.slice(0, 600), html: value.html.slice(0, 1600), url: value.url.slice(0, 1000) })
          }
        } catch { /* malformed guest output */ }
        callbacks.current.onInspectEnd(); return
      }
      if (![2, 3, 'warning', 'error'].includes(d.level)) return
      callbacks.current.onIssue({ id: `console-${Date.now()}-${Math.random()}`, level: d.level === 3 || d.level === 'error' ? 'error' : 'warning', message: String(d.message || '').slice(0, 4000), source: `${d.sourceId || ''}${d.line ? `:${d.line}` : ''}`.slice(0, 1000), at: Date.now() })
    }
    el.addEventListener('did-start-loading', start)
    el.addEventListener('dom-ready', ready)
    el.addEventListener('did-fail-load', fail)
    el.addEventListener('console-message', consoleMessage)
    return () => {
      el.removeEventListener('did-start-loading', start); el.removeEventListener('dom-ready', ready)
      el.removeEventListener('did-fail-load', fail); el.removeEventListener('console-message', consoleMessage)
    }
  }, [props.url, guest])
  useEffect(() => {
    if (priorNonce.current === props.nonce) return
    priorNonce.current = props.nonce
    try { frame.current?.reload() } catch { /* guest attaching; initial navigation will load latest files */ }
  }, [props.nonce])
  useEffect(() => {
    if (!loaded.current || !frame.current) return
    const el = frame.current
    try {
      if (new URL(el.getURL()).origin !== new URL(props.url).origin) { props.onInspectEnd(); return }
      void el.executeJavaScript(inspectorScript(marker.current, props.inspecting)).catch(() => props.onInspectEnd())
    } catch { props.onInspectEnd() }
  }, [props.inspecting, props.url]) // callbacks read only when the inspect toggle changes
  return <><div ref={anchor} className="csp-anchor" /><StudioGuestSurface anchorRef={anchor} enabled={props.visible !== false} onActivate={props.onActivate}><div className="csu csu-guest-content"><div className="csp-stage" data-device={props.device}>
    {props.inspecting && <div className="csp-inspect-hint" role="status"><MousePointer2 size={14} />{t('studio.inspectHint')}</div>}
    {status === 'loading' && <div className="csp-loading" role="status"><Loader2 size={14} className="csx-spin" />{t('studio.loading')}</div>}
    {status === 'error' && <div className="csp-failure" role="alert"><strong>{t('studio.previewFailed')}</strong><code>{error}</code><button onClick={() => frame.current?.reload()}>{t('studio.retry')}</button></div>}
    <div className="csp-viewport"><Webview ref={attachGuest} className="csx-frame" src={props.url} partition={BROWSER_PARTITION} allowpopups="true" style={{ display: 'flex' }} /></div>
  </div></div></StudioGuestSurface></>
}
