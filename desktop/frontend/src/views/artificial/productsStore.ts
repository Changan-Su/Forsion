/**
 * 造物栅格的数据缓存(U-39,stale-while-revalidate)。
 *
 * 病理:切 Space 走 applyNamed → api.fromJSON 重建 panel,栅格组件的局部 state 归零,
 * 每次进入都先闪一次「转圈 + 正在读取…」再重新扫盘。数据挪到模块级:再次进入先画上次的栅格,
 * 后台照常重扫(产物是磁盘上的目录,可能刚在工作室新建或在访达里删掉)。
 *
 * ⚠️这里不许有定时器 —— 时钟(「几分钟前」的基准)归组件管,卸载即停(ArtificialView.test 钉着)。
 */
import { create } from 'zustand'
import type { ProductSummary } from '../../../../shared/products'

export type ProductsStatus = 'loading' | 'ready' | 'error'

interface ProductsState {
  items: ProductSummary[]
  status: ProductsStatus
  /** 重扫一次。已有栅格时保持 ready(不打回骨架);晚到的旧请求结果一律丢弃。 */
  load(): Promise<void>
}

let seq = 0

export const useProducts = create<ProductsState>((set, get) => ({
  items: [],
  status: 'loading',
  async load() {
    const list = window.tangu?.productsList
    if (!list) { set({ status: 'error' }); return }
    const mine = ++seq
    if (get().status !== 'ready') set({ status: 'loading' })
    try {
      const rows = await list()
      if (mine === seq) set({ items: rows, status: 'ready' })
    } catch {
      if (mine === seq) set({ status: 'error' })
    }
  },
}))

/** 测试用:回到「从没加载过」。 */
export function resetProductsStore(): void {
  seq++
  useProducts.setState({ items: [], status: 'loading' })
}
