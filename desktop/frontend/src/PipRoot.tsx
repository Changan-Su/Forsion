/** Computer Use 悬浮小画面(?window=pip)的根:只挂插件的实时画面视图(视图上下文 surface: 'pip'),不画 Mini 的卡头。
 *  主进程把窗先藏着载入,这里等视图注册、挂上后报 ready(带内容高)才上屏;插件被停用 / 不在 → 报不可用,主进程销毁窗口。
 *  顶上一条可拖区,右端「放回去」= 关掉这扇窗(视图坏了也关得掉)。主题 / 明暗 / 语言照其余卫星窗:跟全局外观与 ui:sync 走。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { getView, subscribeViews } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { useI18n, registerMessages } from './i18n'
import { ensureAmadeusReady } from './amadeusPlugins'
import { FloatingViewSurface } from './components/FloatingViewSurface'
import { pluginWanted, usePluginStore } from './amadeus/plugins/pluginStore'
import './pipRoot.css'

registerMessages({
  'pip.putBack': { zh: '放回去', en: 'Put back' },
  'pip.title': { zh: '电脑操作', en: 'Computer Use' },
  'pip.dragHint': { zh: '拖动以移动', en: 'Drag to move' },
})

const PIP_PLUGIN = 'tangu-computer-use'
const PIP_VIEW = `plugin:${PIP_PLUGIN}:live`

/** 插件装着但被停用 / 被门禁挡下 = 明确不可用(没装的情况由主进程的超时兜底:外置插件是异步扫出来的,没扫完不能下结论)。 */
function pluginRefused(): boolean {
  const st = usePluginStore.getState()
  const p = st.plugins.find((x) => x.id === PIP_PLUGIN)
  return !!p && (!!p.blocked || !pluginWanted(p, st.disabledIds))
}

export function PipRoot() {
  const { t } = useI18n()
  const [available, setAvailable] = useState(() => !!getView(PIP_VIEW))
  const rootRef = useRef<HTMLDivElement>(null)
  const reported = useRef(false)

  useEffect(() => { useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined)) }, [t])
  useEffect(() => { document.title = t('pip.title') }, [t])
  useEffect(() => { void useApp.getState().boot() }, [])
  useEffect(() => { if (window.amadeus) ensureAmadeusReady() }, [])
  // 视图出现过又没了(插件被停用 / 卸载 / 重载失败):这扇窗没东西可画,关掉
  useEffect(() => {
    let seen = !!getView(PIP_VIEW)
    return subscribeViews(() => {
      const has = !!getView(PIP_VIEW)
      if (has) seen = true
      else if (seen) { window.tangu?.closeSelf?.(); return }
      setAvailable(has)
    })
  }, [])
  useEffect(() => {
    const check = (): void => { if (!reported.current && pluginRefused()) { reported.current = true; window.tangu?.pipReady?.(false) } }
    check()
    return usePluginStore.subscribe(check)
  }, [])

  // 视图挂上后报一次 ready(主进程这时才 showInactive),之后内容高变了就报 resize:高度随内容
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!available || !el) return
    const height = (): number => Math.ceil(el.getBoundingClientRect().height)
    const report = (): void => {
      if (reported.current) return
      reported.current = true
      window.tangu?.pipReady?.(true, height())
    }
    // 这扇窗此刻还藏着:页面不可见时浏览器可以不出帧,rAF 不保证会跑 —— 定时器兜底,谁先到算谁
    // (只靠 rAF 的话,open() 会一直等到主进程的超时才回 false)
    const first = requestAnimationFrame(report)
    const fallback = window.setTimeout(report, 150)
    const ro = new ResizeObserver(() => { if (reported.current) window.tangu?.pipResize?.(height()) })
    ro.observe(el)
    return () => { cancelAnimationFrame(first); window.clearTimeout(fallback); ro.disconnect() }
  }, [available])

  const close = (): void => window.tangu?.closeSelf?.()
  return <div className="pip-root" ref={rootRef}>
    <div className="pip-card">
      <div className="pip-drag" title={t('pip.dragHint')}>
        <span className="pip-grip" aria-hidden="true" />
        <button type="button" className="pip-close" onClick={close} title={t('pip.putBack')} aria-label={t('pip.putBack')}>
          <X size={13} strokeWidth={2} />
        </button>
      </div>
      {available && <FloatingViewSurface target={{ type: PIP_VIEW }} onUnavailable={close} />}
    </div>
  </div>
}
