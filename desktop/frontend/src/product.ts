/** 产品档案(构建期注入):electron.vite 读 FORSION_PRODUCT 把 products/<id>.json define 进
 *  __FORSION_PRODUCT__;web/mobile 等未注入宿主回退全家桶档案。产品差异优先靠 preload 暴露面收缩
 *  (渲染端 window.tangu?.X 门控自动适配),本模块只供少数必须显式分叉的点:
 *  Space 注册过滤 / 默认 Space / 启动器项 / 引导步骤 / 欢迎文案。 */
export interface ProductProfile {
  id: string
  displayName: string
  defaultSpace: string
  spaces: string[]
  agentBackend: boolean
  market: boolean
}

declare const __FORSION_PRODUCT__: ProductProfile | undefined

/** 全家桶档案(= products/forsion.json 的运行时子集;web/mobile 无注入时的回退)。 */
const FULL: ProductProfile = {
  id: 'forsion',
  displayName: 'Forsion',
  defaultSpace: 'tangu',
  spaces: ['tangu', 'inbox', 'amadeus', 'calendar', 'coding'],
  agentBackend: true,
  market: true,
}

export const PRODUCT: ProductProfile = typeof __FORSION_PRODUCT__ === 'undefined' ? FULL : __FORSION_PRODUCT__
export const PRODUCT_DISPLAY_NAME = PRODUCT.displayName
