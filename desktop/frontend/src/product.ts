/** 产品档案(构建期注入):electron.vite 读 FORSION_PRODUCT 把 products/<id>.json define 进
 *  __FORSION_PRODUCT__;web/mobile 等未注入宿主回退全家桶档案。产品差异优先靠 preload 暴露面收缩
 *  (渲染端 window.tangu?.X 门控自动适配),本模块只供少数必须显式分叉的点:
 *  Space 注册过滤 / 默认 Space / 启动器项 / 引导步骤 / 欢迎文案。 */
import { resolveProduct, type ProductProfile } from '../../shared/product'
export { resolveProduct, type ProductProfile } from '../../shared/product'

declare const __FORSION_PRODUCT__: ProductProfile | undefined

const runtime = typeof window === 'undefined' ? undefined
  : (window as unknown as { __FORSION_PRODUCT_RUNTIME__?: ProductProfile }).__FORSION_PRODUCT_RUNTIME__
export const PRODUCT = resolveProduct(typeof __FORSION_PRODUCT__ === 'undefined' ? undefined : __FORSION_PRODUCT__, runtime)
export const PRODUCT_DISPLAY_NAME = PRODUCT.displayName
