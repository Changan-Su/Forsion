/**
 * 「进造物」的宿主半边(2026-09-27):在托管根(~/Forsion/Project)里建一个新作品文件夹;或把别处已有的文件夹**原地**加入造物
 * (不复制、不移动 —— 用户就是喜欢项目待在原来的位置;复制出来的两份会各改各的)。
 * 原地加入 = 宿主侧登记(productTrust.addExternalCreation,绑目录身份)+ 在它里面写身份 sidecar。sidecar 只说明「它是谁」,
 * 「它是造物」只认宿主侧登记:克隆 / 解压来的文件夹自带一份 sidecar 也拿不到造物的权限。
 *
 * 无 Electron 依赖(纯 node fs),IPC 接线在 productsIpc。**源目录可能来自模型写的作品卡**:渲染层先按字符串限定在会话工作目录内,
 * 这里按真实路径再判一次(`within`:源的 realpath 必须在它的 realpath 里 —— 工作目录里一个指向 ~/.ssh 的软链过不去),
 * 再过目录闸:根 / 家目录 / 家目录的上级 / 托管根本身 / 托管根的上级一律拒;托管根里更深的目录、
 * 与已有外部造物互相嵌套的(两个预览根盖同一棵树、一个仓套在另一个里)也拒。托管根的直接子目录本来就是造物,放行(managed)。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirIdentity, sameDirIdentity, type DirIdentity } from './dirIdentity'

const NAME_MAX = 100

/** 带稳定 code 的失败:渲染层按 code 出本地化文案。 */
export class AdoptError extends Error {
  constructor(readonly code: 'invalid_source' | 'forbidden_source' | 'outside' | 'nested', message: string, readonly detail?: string) { super(message) }
}

/** 作品文件夹名:与 Launchpad 的 validateProjectName 同一套禁区(路径分隔符 / 保留名 / 首尾的点),不合格的字符换成 `-`,
 *  清完是空的就退回 fallback。 */
export function safeCreationName(raw: string, fallback = 'creation'): string {
  // \p{Cf}:双向控制符之类的不可见格式字符(能让文件名显示成另一个样子)
  let name = String(raw || '').normalize('NFC').replace(/\p{Cf}/gu, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim()
  // 截断之后再剥一次尾部的点 / 空格(截在点上 = Windows 不认的名字)
  name = name.replace(/^[.\s-]+/, '').slice(0, NAME_MAX).replace(/[.\s]+$/, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `${name}-app`
  return name || (fallback === 'creation' ? fallback : safeCreationName(fallback))
}

/** 托管根里还没被占的名字:撞名(大小写不敏感,APFS / NTFS 默认如此)就接 ` 2`、` 3`…… */
async function uniqueName(root: string, base: string): Promise<string> {
  const taken = new Set((await fs.readdir(root).catch(() => [] as string[])).map((n) => n.normalize('NFC').toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; i < 1000; i++) {
    const next = `${base.slice(0, NAME_MAX - String(i).length - 1)} ${i}`
    if (!taken.has(next.toLowerCase())) return next
  }
  throw new Error('too many creations with the same name')
}

/** 新建一个空的作品文件夹(独占创建:并发的第二个请求拿到下一个名字,不会共用同一个目录)。 */
export async function createCreationDir(projectsRoot: string, name: string): Promise<{ dir: string; name: string }> {
  await fs.mkdir(projectsRoot, { recursive: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    const final = await uniqueName(projectsRoot, safeCreationName(name))
    const dir = path.join(projectsRoot, final)
    try { await fs.mkdir(dir); return { dir, name: final } } catch (e: any) { if (e?.code !== 'EEXIST') throw e }
  }
  throw new Error('could not reserve a folder name')
}

const same = (a: DirIdentity | null, b: DirIdentity | null): boolean => sameDirIdentity(a, b)

/** child 是 parent 本身或在它里面:沿 child(真实路径)逐级往上比**目录身份**,不比字符串 ——
 *  大小写敏感 / 不敏感的卷都对(按平台猜大小写规则,在大小写敏感的 APFS 上会把 `App` 当成 `app`)。 */
function within(child: string, parent: string): boolean {
  const target = dirIdentity(parent)
  if (!target) return false
  for (let cur = child; ; cur = path.dirname(cur)) {
    if (same(dirIdentity(cur), target)) return true
    if (path.dirname(cur) === cur) return false
  }
}

/** 原地加入造物之前的目录闸(realpath 之后判,包含关系一律按目录身份)。返回源的真实路径;managed = 它本来就是托管根的直接子目录(不用登记)。
 *  within:源必须在它里面(strict = 不能就是它本身);externals:已登记的外部造物(真实路径 + 目录身份)。 */
export async function checkAdoptable(projectsRoot: string, source: string, opts: { within: string; strict?: boolean; externals?: readonly { root: string; dir: DirIdentity }[]; home?: string }): Promise<{ real: string; managed: boolean }> {
  const { within: inDir, strict = false, externals = [], home = os.homedir() } = opts
  if (typeof source !== 'string' || !path.isAbsolute(source) || typeof inDir !== 'string' || !path.isAbsolute(inDir)) throw new AdoptError('invalid_source', 'The folder must be an absolute path')
  const real = await fs.realpath(source).catch(() => null)
  const st = real ? await fs.stat(real).catch(() => null) : null
  if (!real || !st?.isDirectory()) throw new AdoptError('invalid_source', 'The folder does not exist', source)
  const withinReal = await fs.realpath(inDir).catch(() => null)
  const me = dirIdentity(real)
  if (!withinReal || !within(real, withinReal) || (strict && same(me, dirIdentity(withinReal)))) throw new AdoptError('outside', 'The folder is outside the working folder', real)
  const homeReal = await fs.realpath(home).catch(() => path.resolve(home))
  const rootReal = await fs.realpath(projectsRoot).catch(() => path.resolve(projectsRoot))
  // 根 / 家目录 / 家目录的上级 / 托管根本身及其上级(托管根还没建时,沿它的路径往上找得到的上级照样算)
  if (real === path.parse(real).root || within(homeReal, real) || within(rootReal, real)) throw new AdoptError('forbidden_source', 'This folder cannot be added to Creations', real)
  if (within(real, rootReal)) {
    if (same(dirIdentity(path.dirname(real)), dirIdentity(rootReal))) return { real, managed: true }
    throw new AdoptError('nested', 'This folder is inside another creation', real)
  }
  for (const e of externals) {
    if (same(me, e.dir)) return { real, managed: false } // 已经加过:再加一次是幂等的
    if (within(real, e.root) || within(e.root, real)) throw new AdoptError('nested', 'This folder is inside another creation, or contains one', e.root)
  }
  return { real, managed: false }
}
