/**
 * 手机横幅的原生接缝:有原生外壳的手机(Android NativeChrome)由原生层把当前这一条画在状态栏下面、盖住胶囊 / 顶栏那一条
 * (网页里的卡盖不到原生层画的胶囊和第二层的实心顶栏)。外壳装好后在这里登记一个 presenter(mobile/src/nativeChrome.ts);
 * NotificationHost 在手机横幅模式下有 presenter 就把 store 的当前条交给它,自己不画 DOM;没有(网页版手机、桥坏了)就画 DOM 横幅。
 * 停留、排队、同 key、节流都在 notificationStore,原生层只画、只报手势(点正文 = 动作,上滑 / 点 × = 收起)。
 * 共用代码,不 import capacitor 也不 import mobile/src。
 */
import { useSyncExternalStore } from 'react'
import type { AppNotification, NotifyLevel } from './notificationStore'
import { useNotifications } from './notificationStore'

/** 交给原生层的一条(文案已按当前语言取好、长度已截好)。 */
export interface NativeBannerPayload {
  id: string
  /** 「来源 · 标题」,一行小字;可能为空。 */
  source: string
  text: string
  /** 按钮文字;空 = 没有按钮(点正文也什么都不做)。 */
  action: string
  level: NotifyLevel
  /** × 与读屏「收起」操作的文字。 */
  dismiss: string
  /** 读屏用的说明(上滑或点 × 收起)。 */
  hint: string
}

export type NativeBannerPresenter = (banner: NativeBannerPayload | null) => void

let presenter: NativeBannerPresenter | null = null
const subs = new Set<() => void>()
const emit = (): void => { for (const fn of [...subs]) fn() }

/** 原生外壳登记自己;返回撤销(桥坏了 / 回落网页顶栏时调,NotificationHost 随即改画 DOM 横幅)。 */
export function setNativeBannerPresenter(p: NativeBannerPresenter): () => void {
  presenter = p
  emit()
  return () => {
    if (presenter !== p) return
    presenter = null
    emit()
  }
}

export function nativeBannerPresenter(): NativeBannerPresenter | null { return presenter }

export function useNativeBannerPresenter(): NativeBannerPresenter | null {
  return useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn) } }, () => presenter, () => null)
}

/** 往上滑收起的门槛:滑过 24(dp / 网页 px)或往上一甩(px/ms)。原生那半同一组数(NativeBanner.kt BANNER_SWIPE / BANNER_FLING)。 */
export const BANNER_SWIPE = 24
export const BANNER_FLING = 0.6
/** 松手时收不收:[dy] 往上为负,[v] 松手前那一下的速度(往上为负)。 */
export function bannerFlungAway(dy: number, v: number): boolean {
  return dy <= -BANNER_SWIPE || (dy < 0 && v <= -BANNER_FLING)
}

const MAX_ID = 64, MAX_SOURCE = 200, MAX_TEXT = 500, MAX_ACTION = 60, MAX_LABEL = 80
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

/** store 的一条 → 交给原生层的一条。 */
export function bannerPayload(n: AppNotification, labels: { dismiss: string; hint: string }): NativeBannerPayload {
  return {
    id: clip(n.id, MAX_ID),
    source: clip([n.sourceLabel, n.title].filter(Boolean).join(' · '), MAX_SOURCE),
    text: clip(n.text, MAX_TEXT),
    action: clip(n.action?.label ?? '', MAX_ACTION),
    level: n.level,
    dismiss: clip(labels.dismiss, MAX_LABEL),
    hint: clip(labels.hint, MAX_LABEL),
  }
}

/** 原生层报回来的手势。只认屏上这一条的 id:晚到的(那条已经走了)不作数。 */
export function onNativeBannerEvent(id: unknown, kind: unknown): void {
  const st = useNotifications.getState()
  const shown = st.items[0]
  if (!shown || typeof id !== 'string' || shown.id !== id) return
  if (kind === 'action') st.activate(id)
  else if (kind === 'dismiss') st.dismiss(id, 'user')
}
