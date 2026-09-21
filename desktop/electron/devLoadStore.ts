/**
 * Forsion Sandbox「在 Forsion 中加载」的**宿主侧授权名单**。无 Electron 依赖(纯 node,单测直跑)。
 *
 * 为什么不把开关放进项目目录的 sidecar(第一版就是那么干的,评审打回):项目目录是**不可信**的 ——
 * 用户会把别处克隆 / 解压来的文件夹放进 ~/Forsion/Project;若文件夹自带 `devLoad:true` 的 sidecar,
 * 下次启动它的 main.js 就以插件权限(读写真笔记库、以登录账号发请求)直接执行,全程零点击。
 * 授权必须住在项目够不着的地方:本文件写在 forsionHomeDir() 下,**只由 products:update 这个 IPC 写**。
 *
 * 一条授权 = 产物 id + 授权当时的真实项目根,两者都对上才算数:
 *  · 复制出来的项目会被注册表重铸 id → 名单里没有它;
 *  · 同 id 的 sidecar 被人搬进另一个目录 → 根对不上,同样不算。
 * 坏文件 / 读不了 → 当空名单(fail closed:什么都不加载),绝不因此放行。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const FILE = 'dev-plugins.json'
const ID_RE = /^p_[0-9a-f]{12}$/

export type DevLoads = Record<string, string>

export function readDevLoads(homeDir: string): DevLoads {
  const out: DevLoads = Object.create(null) as DevLoads
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(join(homeDir, FILE), 'utf8')) } catch { return out }
  const products = (parsed as { products?: unknown } | null)?.products
  if (!products || typeof products !== 'object' || Array.isArray(products)) return out
  for (const [id, root] of Object.entries(products as Record<string, unknown>)) {
    if (ID_RE.test(id) && typeof root === 'string' && isAbsolute(root)) out[id] = root
  }
  return out
}

/** 这份产物此刻是否被授权开发态加载(id 与真实根都要对上)。 */
export function isDevLoaded(loads: DevLoads, product: { id: string; root: string }): boolean {
  return loads[product.id] === product.root
}

export function setDevLoad(homeDir: string, product: { id: string; root: string }, on: boolean): void {
  if (!ID_RE.test(product.id) || !isAbsolute(product.root)) throw new Error('invalid product')
  const loads = readDevLoads(homeDir)
  if (on) loads[product.id] = product.root
  else delete loads[product.id]
  const target = join(homeDir, FILE)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, products: loads }), { mode: 0o600 })
  renameSync(tmp, target)
}
