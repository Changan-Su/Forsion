/** 产品档案(主进程/preload 侧):同 frontend/src/product.ts 的注入约定。
 *  main 用它闸托管后端/CLI 自装;preload 用它收缩暴露面。 */
import { resolveProduct, type ProductProfile } from '../shared/product'
export type { ProductProfile } from '../shared/product'

declare const __FORSION_PRODUCT__: ProductProfile | undefined

export const PRODUCT = resolveProduct(typeof __FORSION_PRODUCT__ === 'undefined' ? undefined : __FORSION_PRODUCT__)
