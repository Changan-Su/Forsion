import { useEffect, useState, type CSSProperties } from 'react'
import { Puzzle } from 'lucide-react'

/**
 * 设置页插件身份图标。图源缺失/解码失败时回落统一拼图字形，卡片永远保留稳定的前导槽。
 * 图标名由相邻标题表达，因此图片本身对读屏隐藏，避免重复朗读。
 */
export function PluginLogo({ url, size = 40 }: { url?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  const style = { '--plugin-logo-size': `${size}px` } as CSSProperties
  return (
    <span className="plugin-logo" style={style} aria-hidden="true">
      {url && !failed
        ? <img className="plugin-logo__img" src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
        : <Puzzle size={Math.max(16, Math.round(size * 0.48))} strokeWidth={1.7} />}
    </span>
  )
}
