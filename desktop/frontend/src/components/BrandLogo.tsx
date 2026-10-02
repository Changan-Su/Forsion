/** Forsion 品牌标:整图(奶油瓦片 + 神树,与启动加载页一致)。
 *  浅/深色各一版,用 CSS 按 html.dark 切换(跟随实时换主题,无需重渲)。 */
import React, { useState } from 'react'
import lightUrl from '../assets/forsion-logo-light.svg'
import darkUrl from '../assets/forsion-logo-dark.svg'
import { useAppearance } from '../appearance/store'

export const BrandLogo: React.FC<{ size?: number }> = ({ size = 20 }) => {
  const icon = useAppearance((s) => s.value.icon)
  const [failed, setFailed] = useState<string | null>(null)
  if (icon && icon.image !== failed) return <img className="brand-logo" src={icon.image} width={size} height={size} style={{ objectFit: 'contain' }} alt="Forsion" draggable={false} onError={() => setFailed(icon.image)} />
  return (
  <>
    <img className="brand-logo brand-logo--light" src={lightUrl} width={size} height={size} alt="Forsion" draggable={false} />
    <img className="brand-logo brand-logo--dark" src={darkUrl} width={size} height={size} alt="Forsion" draggable={false} />
  </>
  )
}
