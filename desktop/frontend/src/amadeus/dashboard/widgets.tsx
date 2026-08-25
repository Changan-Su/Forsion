// Dashboard 的三张功能卡片。块内容是一段带语言标签的围栏(见 shared/amadeus/dashboard.ts 的
// parseWidget),这里只负责把它活化成会动的东西 —— **只在 Dashboard 视图里活化**,普通笔记里
// 它就是一段普通代码块(Obsidian 打开也一样),这是有意的降级面。
import { useEffect, useRef, useState } from 'react'
import { webviewUrlAllowed, type Widget } from '@amadeus-shared/dashboard'
import { BROWSER_PARTITION } from '../../../../shared/browser'
import { Webview } from '../../builtins/browserView'

export function WidgetCard({ widget }: { widget: Widget }) {
  if (widget.kind === 'clock') return <ClockWidget opts={widget.opts} />
  if (widget.kind === 'weather') return <WeatherWidget opts={widget.opts} />
  if (widget.kind === 'webview') return <WebviewWidget opts={widget.opts} />
  return null // 'view' 卡片在 views/dashboardViewCard.tsx 里活化(要宿主的视图注册表)
}

// ───────────────────────────────── 时钟 ─────────────────────────────────

/** 本机时区(新建时钟卡片时写进 fence,之后就是声明式的)。 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function ClockWidget({ opts }: { opts: Record<string, string> }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // 对齐到整秒再起跳,秒数不会因为挂载时刻不同而抖。
    let iv: number | undefined
    const t = window.setTimeout(() => {
      setNow(new Date())
      iv = window.setInterval(() => setNow(new Date()), 1000)
    }, 1000 - (Date.now() % 1000))
    return () => {
      clearTimeout(t)
      if (iv) clearInterval(iv)
    }
  }, [])
  const tz = opts.tz || localTimeZone()
  // 时区写错(用户手打)→ Intl 会抛;退回本机时区并在卡片上说明,别让一张卡片崩掉整个仪表盘。
  let time: string
  let date: string
  let bad = false
  try {
    time = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)
    date = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'long', day: 'numeric', weekday: 'short' }).format(now)
  } catch {
    bad = true
    time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)
    date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(now)
  }
  return (
    <div className="dash-widget dash-clock">
      <div className="dash-clock-time">{time}</div>
      <div className="dash-clock-sub">
        {date}
        {(opts.label || tz) && <span className="dash-clock-tz">{opts.label || tz.split('/').pop()}</span>}
      </div>
      {bad && <div className="dash-widget-note">时区「{tz}」无效,已按本机时间显示</div>}
    </div>
  )
}

// ───────────────────────────────── 天气 ─────────────────────────────────

/** WMO weather code → 图标 + 说明(粗分档;完整表 100+ 条,仪表盘上没人分得清雨夹雪的三个亚型)。 */
function wmo(code: number): { icon: string; text: string } {
  if (code === 0) return { icon: '☀️', text: '晴' }
  if (code <= 2) return { icon: '🌤️', text: '多云' }
  if (code === 3) return { icon: '☁️', text: '阴' }
  if (code <= 49) return { icon: '🌫️', text: '雾' }
  if (code <= 59) return { icon: '🌦️', text: '毛毛雨' }
  if (code <= 69) return { icon: '🌧️', text: '雨' }
  if (code <= 79) return { icon: '🌨️', text: '雪' }
  if (code <= 84) return { icon: '🌧️', text: '阵雨' }
  if (code <= 94) return { icon: '🌨️', text: '阵雪' }
  return { icon: '⛈️', text: '雷暴' }
}

interface WeatherData {
  temp: number
  code: number
  wind: number
  place: string
}

/** open-meteo:免 key、免注册、CORS 全开;CSP 的 connect-src 已含 https: → 无需改配置。 */
async function fetchWeather(opts: Record<string, string>, signal: AbortSignal): Promise<WeatherData> {
  let lat = Number(opts.lat)
  let lon = Number(opts.lon)
  let place = opts.label || opts.city || ''
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const city = opts.city || opts.label
    if (!city) throw new Error('未指定城市')
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
      { signal },
    )
    const gj = (await geo.json()) as { results?: Array<{ latitude: number; longitude: number; name: string }> }
    const hit = gj.results?.[0]
    if (!hit) throw new Error(`找不到「${city}」`)
    lat = hit.latitude
    lon = hit.longitude
    place = place || hit.name
  }
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m`,
    { signal },
  )
  const j = (await r.json()) as { current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number } }
  if (!j.current) throw new Error('返回数据异常')
  return { temp: j.current.temperature_2m, code: j.current.weather_code, wind: j.current.wind_speed_10m, place }
}

const WEATHER_REFRESH_MS = 15 * 60 * 1000

function WeatherWidget({ opts }: { opts: Record<string, string> }) {
  const [data, setData] = useState<WeatherData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const key = JSON.stringify(opts)
  useEffect(() => {
    const ac = new AbortController()
    const load = (): void => {
      fetchWeather(opts, ac.signal)
        .then((d) => {
          setData(d)
          setErr(null)
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return
          setErr(e instanceof Error ? e.message : String(e)) // 断网/查不到 → 卡片显示原因,不空白
        })
    }
    load()
    const iv = window.setInterval(load, WEATHER_REFRESH_MS)
    return () => {
      ac.abort()
      clearInterval(iv)
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="dash-widget dash-weather"><div className="dash-widget-note">天气不可用:{err}</div></div>
  if (!data) return <div className="dash-widget dash-weather"><div className="dash-widget-note">加载中…</div></div>
  const w = wmo(data.code)
  return (
    <div className="dash-widget dash-weather">
      <div className="dash-weather-main">
        <span className="dash-weather-icon">{w.icon}</span>
        <span className="dash-weather-temp">{Math.round(data.temp)}°</span>
      </div>
      <div className="dash-clock-sub">
        {w.text} · 风 {Math.round(data.wind)} km/h
        {data.place && <span className="dash-clock-tz">{data.place}</span>}
      </div>
    </div>
  )
}

// ─────────────────────────────── 网页嵌入 ───────────────────────────────

function WebviewWidget({ opts }: { opts: Record<string, string> }) {
  const url = opts.url || ''
  const ref = useRef<HTMLElement | null>(null)
  if (!url) return <div className="dash-widget"><div className="dash-widget-note">未指定 url</div></div>
  // ⚠️ 这个 url 来自 .md 文件正文 —— 仪表盘可能是同步/导入/别人分享来的,是**不可信输入**,
  // 而 <webview src> 一挂就自动导航(无需用户任何操作)。默认拒:非 http(s)、localhost、私网。
  // 见 webviewUrlAllowed 的注释(DNS 重绑定不在这层拦)。
  if (!webviewUrlAllowed(url)) {
    return (
      <div className="dash-widget">
        <div className="dash-widget-note">
          已拦截:网页卡片只允许公网 http(s) 地址（拒绝 file/data/javascript、localhost 与内网）。
          <br />
          <code>{url.slice(0, 120)}</code>
        </div>
      </div>
    )
  }
  // web/移动端没有 <webview>(要主进程开 webviewTag)→ 给一条可点的链接兜底,别渲染个空洞。
  if (!window.tangu) {
    return (
      <div className="dash-widget">
        <div className="dash-widget-note">
          此端不支持内嵌网页 · <a href={url} target="_blank" rel="noreferrer">{url}</a>
        </div>
      </div>
    )
  }
  // guest 的安全边界在主进程(will-attach-webview 剥 preload/nodeIntegration + 独立分区默认拒权限),
  // partition 必须钉死:空 partition 会落回权限全放行的 defaultSession。
  return <Webview ref={ref} src={url} partition={BROWSER_PARTITION} className="dash-webview" />
}
