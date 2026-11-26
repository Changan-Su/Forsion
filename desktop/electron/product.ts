/** 产品档案(主进程/preload 侧):同 frontend/src/product.ts 的注入约定。
 *  main 用它闸托管后端/CLI 自装;preload 用它收缩暴露面。 */
import { resolveProduct, type ProductProfile } from '../shared/product'
import defaultProduct from '../products/forsion.json'
export type { ProductProfile } from '../shared/product'

declare const __FORSION_PRODUCT__: (ProductProfile & { appId: string }) | undefined

const profile = typeof __FORSION_PRODUCT__ === 'undefined' ? defaultProduct : __FORSION_PRODUCT__ ?? defaultProduct
export const PRODUCT = { ...resolveProduct(profile), appId: profile.appId }
