/**
 * Forsion Sandbox「在 Forsion 中加载」的**宿主侧授权名单**。无 Electron 依赖(纯 node,单测直跑)。
 *
 * 为什么不把开关放进项目目录的 sidecar(第一版就是那么干的,评审打回):项目目录是**不可信**的 ——
 * 用户会把别处克隆 / 解压来的文件夹放进 ~/Forsion/Project;若文件夹自带 `devLoad:true` 的 sidecar,
 * 下次启动它的 main.js 就以插件权限(读写真笔记库、以登录账号发请求)直接执行,全程零点击。
 * 授权必须住在项目够不着的地方:本文件写在 forsionHomeDir() 下,**只由 products:update 这个 IPC 写**。
 *
 * 一条授权 = 产物 id + 授权当时那个目录的**身份(dev+ino)**,两者都对上才算数(见 dirIdentity.ts):
 *  · 复制出来的项目会被注册表重铸 id → 名单里没有它;
 *  · 同 id 的 sidecar 被人搬进另一个目录 → 另一个 inode,同样不算;
 *  · 用户给项目文件夹改名 / 同卷挪位置 → inode 不变,授权照旧(绑路径字符串的话一改名授权就静默失效,
 *    被影子住的安装版悄悄回来 —— 收尾检查抓到的,第一版就是绑的路径)。
 * 坏文件 / 读不了 → 当空名单(fail closed:什么都不加载),绝不因此放行。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { dirIdentity, isDirIdentity, matchesDirIdentity, type DirIdentity } from './dirIdentity'

const FILE = 'dev-plugins.json'
const ID_RE = /^p_[0-9a-f]{12}$/
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** root = 授权当时的真实项目根;pluginId = 授权当时的**生效插件 id**。后者是为了清单写坏的那一刻:
 *  manifest.json 少个逗号,装载器读不出 id 就会退回目录名 —— 插件的身份凭空变了,被它影子住的安装版悄悄回来,
 *  开发副本的报错也没人接得住。记住授权时的 id,清单坏掉期间沿用它(以 blocked:'invalid' 留在原位)。 */
/** root 只作记录 / 排障用(授权当时的路径),判定一律看 dir。 */
export interface DevLoad { root: string; dir: DirIdentity; pluginId: string | null }
export type DevLoads = Record<string, DevLoad>

export function readDevLoads(homeDir: string): DevLoads {
  const out: DevLoads = Object.create(null) as DevLoads
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(join(homeDir, FILE), 'utf8')) } catch { return out }
  const products = (parsed as { products?: unknown } | null)?.products
  if (!products || typeof products !== 'object' || Array.isArray(products)) return out
  for (const [id, value] of Object.entries(products as Record<string, unknown>)) {
    const entry = value as { root?: unknown; pluginId?: unknown } | null
    if (!ID_RE.test(id) || !entry || typeof entry !== 'object' || typeof entry.root !== 'string' || !isAbsolute(entry.root) || !isDirIdentity((entry as { dir?: unknown }).dir)) continue
    out[id] = { root: entry.root, dir: (entry as { dir: DirIdentity }).dir, pluginId: typeof entry.pluginId === 'string' && PLUGIN_ID_RE.test(entry.pluginId) ? entry.pluginId : null }
  }
  return out
}

/** 这份产物此刻是否被授权开发态加载(id 与目录身份都要对上;目录 stat 不到 = 不认)。 */
export function isDevLoaded(loads: DevLoads, product: { id: string; root: string }): boolean {
  const grant = loads[product.id]
  return !!grant && matchesDirIdentity(product.root, grant.dir)
}

export function setDevLoad(homeDir: string, product: { id: string; root: string; pluginId?: string | null }, on: boolean): void {
  if (!ID_RE.test(product.id) || !isAbsolute(product.root)) throw new Error('invalid product')
  const loads = readDevLoads(homeDir)
  const dir = on ? dirIdentity(product.root) : null
  if (on && !dir) throw new Error('project directory is unavailable')
  if (on && dir) loads[product.id] = { root: product.root, dir, pluginId: product.pluginId && PLUGIN_ID_RE.test(product.pluginId) ? product.pluginId : null }
  else delete loads[product.id]
  const target = join(homeDir, FILE)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, products: loads }), { mode: 0o600 })
  renameSync(tmp, target)
}
