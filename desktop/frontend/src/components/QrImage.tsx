/**
 * QrImage：把一段「可扫描的字符串」(iLink 返回的 liteapp 登录 URL,或 hex token)
 * 用 qrcode 库编码成二维码图片再渲染。
 *
 * 关键修复：iLink 的 qrcode_img_content 是「可扫描的 URL」而非图片本身;
 * 旧实现直接 <img src={url}> 永远加载不出来。这里改为前端编码成 dataURL(对齐 Echo 已验证实现)。
 */
import React, { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Loader2 } from 'lucide-react'
import { useI18n } from '../i18n'

export const QrImage: React.FC<{
  /** iLink 返回的可扫描内容(qrcodeImg 优先,回退 qrcode)。 */
  value: string
  /** 渲染像素尺寸(正方形)。 */
  size?: number
  className?: string
  alt?: string
}> = ({ value, size = 132, className, alt }) => {
  const { t } = useI18n()
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setSrc('')
    setFailed(false)
    if (!value) return
    // width 取 2 倍物理尺寸,保证高分屏清晰;margin 1 留最小静默区。
    QRCode.toDataURL(value, { width: Math.max(size * 2, 256), margin: 1 })
      .then((url) => { if (alive) setSrc(url) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [value, size])

  if (failed) {
    return (
      <div className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, fontSize: 11, color: 'var(--danger)', textAlign: 'center', padding: 6 }}>
        {t('qr.failed')}
      </div>
    )
  }
  if (!src) {
    return (
      <div className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, color: 'var(--text-faint)' }}>
        <Loader2 size={18} className="spin" />
      </div>
    )
  }
  return <img className={className} src={src} alt={alt || t('qr.alt')} width={size} height={size} />
}
