/**
 * 主页「主题背景」的三张图:星轨 / 日行 / 素笺(方案页 docs/ToBeImproved/主页插件化与美化方案_2026-10-17/wallpaper.html、motion.html)。
 *
 * 颜色全取 Genesis token,亮暗与主题色自动跟。⚠️面只用 --bg / --bg-card 台阶,--accent-ink 只画细线和点:
 * 大面积 accent 雾在黑白配色(cream,accent = #1c1c1c)下就是一团灰斑(方案里删掉的晨光 / 流光就死在这)。
 *
 * 画布按 1600×1000 铺满再裁(同 SVG 的 slice,见 homepage.css 的 .hpw-canvas)。静态的线、点、颗粒在一张 SVG 里只画一次;
 * 会动的(星轨的行星、日行的光晕)是单独的 HTML 层,只动 transform / opacity —— SVG 内部的 <g> 动起来不走合成器,
 * 会把整张图连同全屏颗粒滤镜每帧重画一遍。
 */
import { useId, useState } from 'react'
import type { HomepageThemePreset } from './homepageWallpaper'

const W = 1600
const H = 1000
/** 星轨公转一圈的秒数,须与 homepage.css 的 .hpw-orbit 一致。 */
const ORBIT_SECONDS = 120

const ink = (a: number): string => `color-mix(in srgb, var(--accent-ink) ${a}%, transparent)`
const pct = (v: number, of: number): string => `${(v / of * 100).toFixed(3)}%`

/** 纸面细颗粒:亮色 multiply、暗色 screen(--hpw-grain-blend)。缩略图里按比例减淡,不然小图上全是噪点。 */
function Grain({ opacity }: { opacity: number }) {
  const id = `hpg${useId().replace(/[^\w-]/g, '')}`
  return (
    <>
      <filter id={id} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={3} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer><feFuncA type="table" tableValues="0 0.9" /></feComponentTransfer>
      </filter>
      <rect className="hpw-grain" width={W} height={H} filter={`url(#${id})`} style={{ opacity }} />
    </>
  )
}

// 星轨:Hack2Gate 海报里的轨道 + 十字线 + 套准角标,去掉字、改成矢量。圆环把时钟和输入区框在中间,十字线在内容区断开。
const CX = 800
const CY = 452
const R = 392
const PLANET = -58 * Math.PI / 180
const DX = R * Math.cos(PLANET)
const DY = R * Math.sin(PLANET)

function Orbit({ grain }: { grain: number }) {
  // 位置由墙钟推出来(挂载时算一次,之后不改 —— 中途改 animation-delay 会让行星跳):切走再回来是「接着走」,不是从头来。
  const [delay] = useState(() => `${-((Date.now() / 1000) % ORBIT_SECONDS).toFixed(2)}s`)
  const mark = (x: number, y: number, sx: number, sy: number) => (
    <g key={`${x}-${y}`}>
      <path d={`M${x - 16} ${y}H${x + 16}M${x} ${y - 16}V${y + 16}`} />
      <path d={`M${x + sx * 36} ${y}h${sx * 46}M${x} ${y + sy * 36}v${sy * 46}`} opacity={0.6} />
    </g>
  )
  return (
    <>
      <svg className="hpw-static" viewBox={`0 0 ${W} ${H}`} aria-hidden>
        <g fill="none" strokeWidth={1}>
          <circle cx={CX} cy={CY} r={R} strokeDasharray="168 9 3 9 96 9 3 9" style={{ stroke: ink(22) }} />
          <circle cx={CX} cy={CY} r={R + 18} strokeDasharray="2 14" style={{ stroke: ink(16) }} />
          <path d={`M${CX} 30V${CY - R - 40}M${CX} ${CY + R + 40}V980`} style={{ stroke: ink(20) }} />
          <path d={`M150 ${CY}H${CX - R - 60}M${CX + R + 60} ${CY}H1450`} style={{ stroke: ink(16) }} />
        </g>
        <g style={{ fill: ink(55) }}>
          <circle cx={CX} cy={CY - R - 40} r={2.6} /><circle cx={CX} cy={CY + R + 40} r={2.6} />
          <circle cx={CX - R - 60} cy={CY} r={2.2} /><circle cx={CX + R + 60} cy={CY} r={2.2} />
        </g>
        <g fill="none" strokeWidth={1} style={{ stroke: ink(30) }}>
          {mark(70, 64, 1, 1)}{mark(1530, 64, -1, 1)}{mark(70, 936, 1, -1)}{mark(1530, 936, -1, -1)}
        </g>
        <Grain opacity={0.06 * grain} />
      </svg>
      {/* 外层绕轨道圆心转,里层绕行星反着转:十字准星跟着行星走,但始终横平竖直。 */}
      <div className="hpw-orbit" style={{ left: pct(CX - R, W), top: pct(CY - R, H), width: pct(2 * R, W), animationDelay: delay }}>
        <div
          className="hpw-planet"
          style={{ left: pct(R + DX, 2 * R), top: pct(R + DY, 2 * R), width: pct(140, 2 * R), marginLeft: pct(-70, 2 * R), marginTop: pct(-60, 2 * R), animationDelay: delay }}
        >
          <svg viewBox="-70 -60 140 120" aria-hidden>
            <path d="M-70 0H70M0 -60V60" fill="none" strokeWidth={1} style={{ stroke: ink(18) }} />
            <circle r={11} style={{ fill: ink(62) }} />
            <circle r={26} fill="none" style={{ stroke: ink(14) }} />
          </svg>
        </div>
      </div>
    </>
  )
}

// 日行:下方空着的那一截画一道太阳一天走过的弧,日(夜里换成月)按此刻的钟点停在弧上 —— 和时钟说同一件事。弧上十个小点 =「十日」。
const P0 = [90, 968]
const P1 = [800, 640]
const P2 = [1510, 968]
const onArc = (t: number): [number, number] => [
  (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * P1[0] + t ** 2 * P2[0],
  (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * P1[1] + t ** 2 * P2[1],
]

/** 白天 6–18 点走一趟,夜里月亮再走一趟;两端各留一点,不贴着地平线。 */
export function sunOnArc(hour: number, minute: number): { day: boolean; t: number } {
  const h = hour + minute / 60
  const day = h >= 6 && h < 18
  const t = day ? (h - 6) / 12 : ((h - 18 + 24) % 24) / 12
  return { day, t: Math.min(0.97, Math.max(0.03, t)) }
}

function Path({ grain, hour, minute }: { grain: number; hour: number; minute: number }) {
  const hz = `hphz${useId().replace(/[^\w-]/g, '')}`
  const { day, t } = sunOnArc(hour, minute)
  const [x, y] = onArc(t)
  const halo = day ? 80 : 60
  return (
    <>
      <svg className="hpw-static" viewBox={`0 0 ${W} ${H}`} aria-hidden>
        <defs>
          <linearGradient id={hz} x1="0" x2="1">
            <stop offset="0" style={{ stopColor: 'var(--accent-ink)', stopOpacity: 0 }} />
            <stop offset="0.5" style={{ stopColor: 'var(--accent-ink)', stopOpacity: 0.26 }} />
            <stop offset="1" style={{ stopColor: 'var(--accent-ink)', stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <path d={`M${P0} Q${P1} ${P2}`} fill="none" strokeWidth={1} style={{ stroke: ink(20) }} />
        <path d="M40 968H1560" strokeWidth={1} stroke={`url(#${hz})`} />
        <g style={{ fill: ink(34) }}>
          {Array.from({ length: 10 }, (_, i) => { const [tx, ty] = onArc(0.05 + i * 0.1); return <circle key={i} cx={tx} cy={ty} r={2.2} /> })}
        </g>
        {day
          ? <circle cx={x} cy={y} r={10} style={{ fill: ink(70) }} />
          : <>
              <circle cx={x} cy={y} r={9.5} strokeWidth={1.2} style={{ fill: 'var(--bg)', stroke: ink(60) }} />
              <circle cx={x + 4} cy={y - 3} r={7.5} style={{ fill: ink(60) }} />
            </>}
        <Grain opacity={0.05 * grain} />
      </svg>
      {/* 光晕一呼一吸(8 秒一个来回)只说「它在」;位置按钟点每分钟挪一点,所以不再让位置动。 */}
      <div
        className={`hpw-halo${day ? ' hpw-sun' : ' hpw-moon'}`}
        style={{ left: pct(x, W), top: pct(y, H), width: pct(2 * halo, W), marginLeft: pct(-halo, W), marginTop: pct(-halo, W) }}
      />
    </>
  )
}

/** `thumb`:壁纸面板里的缩略图 —— 不动,颗粒减淡(线宽由 CSS 的 non-scaling-stroke 保住)。 */
export function HomeWallpaperArt({ preset, hour, minute, thumb = false }: { preset: HomepageThemePreset; hour: number; minute: number; thumb?: boolean }) {
  const grain = thumb ? 0.4 : 1
  return (
    <div className="hpw-canvas" aria-hidden>
      {preset === 'orbit' && <Orbit grain={grain} />}
      {preset === 'path' && <Path grain={grain} hour={hour} minute={minute} />}
      {preset === 'paper' && <svg className="hpw-static" viewBox={`0 0 ${W} ${H}`}><Grain opacity={0.09 * grain} /></svg>}
    </div>
  )
}
