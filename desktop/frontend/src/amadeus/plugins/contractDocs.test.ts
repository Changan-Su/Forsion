/**
 * 插件契约 ↔ 对外文档 漂移防线(2026-09-02 立,起因:ctx.dashboard / registerFont 接缝已发布、
 * 插件已在用,而作者手册 SKILL.md 零覆盖;另有「无活动库时 writeFile 会 reject」这条行为没人写,
 * 服务器总览就是照着不完整的文档踩进去的)。
 *
 * 规则(机械、可执行):
 *  ① types.ts 里 PluginContext 的每个顶层成员名,都必须在插件作者手册
 *     tangu-agent/skills/forsion-plugin/SKILL.md 里出现过 —— 加接缝不补手册,这里就红;
 *  ② PluginAppApi 里凡走库内路径的方法,手册必须有「无活动库」行为表(关键字锁定);
 *  ③ 手册与正典(docs/Function/生态内容制作指南.md)都得提到 ctx.dashboard。
 *     ⚠️ 正典住**外层 Forsion 目录**,不在本仓 —— CI 只 checkout 本仓,该文件必然缺席。
 *     涉及它的两条断言按存在性门控(HAS_GUIDE):本机照跑,CI 显式 skip,不静默混过去。
 * 只查「提到没提到」,不查措辞 —— 这是漂移探针,不是文风警察。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const TYPES = path.resolve(HERE, 'types.ts')
const SKILL = path.resolve(HERE, '../../../../../tangu-agent/skills/forsion-plugin/SKILL.md')
const GUIDE = path.resolve(HERE, '../../../../../../docs/Function/生态内容制作指南.md')

function membersOf(src: string, iface: string): string[] {
  const start = src.indexOf(`export interface ${iface} `)
  if (start < 0) throw new Error(`找不到 interface ${iface}`)
  // 顶层成员 = 恰好两空格缩进、以标识符开头的行(注释/嵌套体不算)
  const body = src.slice(start)
  const end = body.search(/\n\}\n/)
  const out = new Set<string>()
  for (const line of body.slice(0, end).split('\n')) {
    const m = /^  ([A-Za-z_]\w*)\??\s*[:(<]/.exec(line)
    if (m) out.add(m[1])
  }
  return [...out]
}

describe('插件契约 ↔ 作者手册漂移', () => {
  const types = readFileSync(TYPES, 'utf8')
  const skill = existsSync(SKILL) ? readFileSync(SKILL, 'utf8') : ''
  const guide = existsSync(GUIDE) ? readFileSync(GUIDE, 'utf8') : ''
  /** 正典在仓外(见文件头 ③):CI 上恒 false。门控只作用于正典那两条,手册侧照常硬断言。 */
  const HAS_GUIDE = existsSync(GUIDE)

  it('手册文件在(路径变了先来改这里)', () => {
    expect(existsSync(SKILL), SKILL).toBe(true)
  })

  it.skipIf(!HAS_GUIDE)('正典文件在(仓外 —— CI 上恒 skip)', () => {
    expect(existsSync(GUIDE), GUIDE).toBe(true)
  })

  it('① PluginContext 每个顶层成员都在 SKILL.md 露过面', () => {
    const members = membersOf(types, 'PluginContext')
    expect(members.length).toBeGreaterThan(10)
    const missing = members.filter((m) => !skill.includes(m))
    expect(missing, `手册没提这些接缝:${missing.join(', ')}`).toEqual([])
  })

  it('①b CommandContribution 每个字段都在 SKILL.md 露过面', () => {
    // 规则 ① 只枚举 PluginContext 顶层成员,给 **贡献点类型** 加字段是静默绿 —— 2026-09-04 加
    // `invoke` 时踩到:插件作者按手册写,永远不知道有这个字段。贡献点类型也得有一条。
    const members = membersOf(types, 'CommandContribution')
    expect(members.length, '抽取失效自检:CommandContribution 至少 4 个字段').toBeGreaterThanOrEqual(4)
    const missing = members.filter((m) => !skill.includes(m))
    expect(missing, `手册没提这些字段:${missing.join(', ')}`).toEqual([])
  })

  it('①c registerCommand 的「只做导航」旧规不许与 invoke 并存', () => {
    // 两句话直接打架:声明了 invoke 的命令就是动作面。留着旧规 = 手册自相矛盾,
    // 插件作者按哪句写都可能被打回。
    if (skill.includes('invoke')) {
      expect(skill, 'SKILL.md 同时写着「只做导航」和 invoke —— 二者必须收敛').not.toMatch(/\*\*只做导航\*\*/)
    }
  })

  it('② 库依赖行为表:手册必须写明 writeFile 无库会 reject、vaultRoot 是探测口', () => {
    expect(skill).toMatch(/No vault is open/)
    expect(skill).toMatch(/vaultRoot/)
    expect(types).toMatch(/No vault is open/) // 真源注释同步
  })

  it('③ ctx.dashboard 两条路线(mount 不依赖库 / source 需要库)手册都有', () => {
    expect(skill).toMatch(/dashboard\.mount/)
    expect(skill).toMatch(/dashboard\.source/)
  })

  it.skipIf(!HAS_GUIDE)('③ 正典也提到 ctx.dashboard(仓外 —— CI 上恒 skip)', () => {
    expect(guide).toMatch(/ctx\.dashboard/)
  })
})
