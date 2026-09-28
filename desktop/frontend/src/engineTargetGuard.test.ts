// 引擎目标源码棘轮(P1-K6 §3.9 第 2 道守卫)—— 钉的是「新代码绕过目标解析层自己拼引擎 URL / 自己读引擎基址」。
//
// 为什么品牌类型不够:EngineTarget 的品牌(S3 起服务函数只收它,`api.fn(get().cfg)` 编译失败,见 brand.typecheck.ts)
// 只挡得住「调服务函数时不经解析层」,挡不住 `authFetch(\`${cfg.backendUrl}/agent/x\`)` 这种自拼 URL —— 那种请求永远打 home,
// 手机上会话在「我的电脑」上时会静默打错引擎。反过来棘轮也挡不住「拿错目标调合法函数」,所以两道都要。
//
// 四条规则(扫 desktop/frontend/src、mobile/src、web/src 的非测试源码),K6-S3 起**零容忍**(S0 的存量基线已清零、删除):
//   R1 `.backendUrl` 属性读,只许在白名单文件里(解析层、types、三个宿主垫片、设置页外部连接表单、
//      首次引导的连接测试、各 harness / ChatPreview)。例外:**同名字段搬运** `backendUrl: x.backendUrl`(可带 `||` / `??`
//      回退)—— 那是宿主把主进程配置抄进 store.cfg,不是拿它当请求地址;拼成别的东西(模板串、`+ '/…'`)照样算违规。
//   R2 模板串 `${…}/agent/`,只许在 backendService / agentRunService / services/engine/
//   R3 `mintTarget(` 只许在 services/engine/
//   R4 `connectionTarget(`(显式连接 = 不是本端宿主当前那份配置)只许在:解析层、设置页外部连接表单、首次引导的连接测试、
//      经 tanguSeam waitBackend() 现取主进程配置的两处(pluginStore / tanguProbe)。本端当前那份一律 homeTarget()。
// 要加白名单先想清楚为什么不能走 homeTarget() / targetForSession(sid) / focusTarget();调用点的机械改写见
// desktop/scripts/engine-target-codemod.cjs(重基后重跑)。
//
// ⚠️ 天花板:判据是字面量。解构(`const { backendUrl } = cfg`)与字符串拼接(`base + '/agent/'`)扫不到。
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const GENESIS = join(__dirname, '../../..')
const ROOTS = ['desktop/frontend/src', 'mobile/src', 'web/src']
type RuleId = 'R1' | 'R2' | 'R3' | 'R4'
interface Rule { id: RuleId; what: string; re: RegExp; allowed: (rel: string) => boolean; exempt?: (before: string, after: string) => boolean }

const inEngineDir = (rel: string): boolean => rel.startsWith('desktop/frontend/src/services/engine/')

export const RULES: Rule[] = [
  {
    id: 'R1',
    what: '.backendUrl 属性读(引擎基址只许经 services/engine 的目标解析层取)',
    re: /\??\.backendUrl\b/g,
    allowed: (rel) => inEngineDir(rel)
      || rel === 'desktop/frontend/src/types.ts'
      || rel === 'web/src/webShim.ts' || rel === 'mobile/src/mobileShim.ts' || rel === 'web/src/unitShim.ts'
      || rel === 'desktop/frontend/src/components/SettingsModal.tsx' // 外部连接表单
      || rel === 'desktop/frontend/src/components/OnboardingWizard.tsx' // 连接测试
      || /(^|\/)(\w*[hH]arness|ChatPreview)\.tsx$/.test(rel),
    // 同名字段搬运:`backendUrl: c.backendUrl` / `backendUrl: stored?.backendUrl || prev.backendUrl`(同一表达式里)。
    // 前后都看:前面是 `backendUrl:` 开头的纯取值链,后面紧跟 `,` `}` `)` 换行或 `||` / `??` —— 拼成别的(`+ '/agent/x'`)照样红
    exempt: (before, after) => /\bbackendUrl\s*:\s*[\w$.?!()|\s]*$/.test(before.slice(before.lastIndexOf('\n') + 1))
      && /^\s*(?:,|\}|\)|\n|$|\|\||\?\?)/.test(after),
  },
  {
    id: 'R2',
    what: '模板串 `${…}/agent/`(引擎 URL 只许由服务层拼)',
    re: /\$\{[^}]*\}\/agent\//g,
    allowed: (rel) => inEngineDir(rel)
      || rel === 'desktop/frontend/src/services/backendService.ts'
      || rel === 'desktop/frontend/src/services/agentRunService.ts',
  },
  {
    id: 'R3',
    what: 'mintTarget((EngineTarget 只许由解析层铸造)',
    re: /\bmintTarget\(/g,
    allowed: inEngineDir,
  },
  {
    id: 'R4',
    what: 'connectionTarget((显式连接只给「不是本端当前配置」的少数来源;本端那份用 homeTarget())',
    re: /\bconnectionTarget\(/g,
    allowed: (rel) => inEngineDir(rel)
      || rel === 'desktop/frontend/src/components/SettingsModal.tsx' // 外部连接表单 / 重启后刚读到的主进程配置
      || rel === 'desktop/frontend/src/components/OnboardingWizard.tsx' // 引导里刚从主进程读到的配置(还没进 store)
      || rel === 'desktop/frontend/src/amadeus/plugins/pluginStore.ts' // waitBackend() 现取(与 appStore 有 import 环)
      || rel === 'desktop/frontend/src/tanguProbe.ts', // 同上
  },
]

/** 只剥**独占整行**的注释(同 platform-parity 的理由:正则不知道自己是否在字符串里,全局剥会切坏代码)。 */
function stripLineComments(src: string): string {
  return src.split('\n').map((line) => {
    const t = line.trim()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line
  }).join('\n')
}

export function hits(rule: Rule, rel: string, src: string): number[] {
  if (rule.allowed(rel)) return []
  const lines: number[] = []
  const text = stripLineComments(src)
  for (const m of text.matchAll(rule.re)) {
    const before = text.slice(0, m.index)
    if (rule.exempt?.(before, text.slice(m.index! + m[0].length))) continue
    lines.push(before.split('\n').length)
  }
  return lines
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|typecheck)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function scan(): { files: number; where: Record<RuleId, Record<string, number[]>> } {
  const where = { R1: {}, R2: {}, R3: {}, R4: {} } as Record<RuleId, Record<string, number[]>>
  let files = 0
  for (const root of ROOTS) {
    const abs = join(GENESIS, root)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) {
      files++
      const rel = relative(GENESIS, file).split('\\').join('/')
      const src = readFileSync(file, 'utf8')
      for (const rule of RULES) {
        const at = hits(rule, rel, src)
        if (at.length) where[rule.id][rel] = at
      }
    }
  }
  return { files, where }
}

const rule = (id: RuleId): Rule => RULES.find((r) => r.id === id)!

describe('引擎目标棘轮', () => {
  it('自检:自拼引擎 URL 同时命中 R1 与 R2;铸造点外的 mintTarget 命中 R3;白名单外的 connectionTarget 命中 R4;整行注释与白名单不算', () => {
    const view = 'desktop/frontend/src/views/Planted.tsx'
    const planted = 'const u = `${cfg.backendUrl}/agent/x`\n'
    expect(hits(rule('R1'), view, planted)).toEqual([1])
    expect(hits(rule('R2'), view, planted)).toEqual([1])
    expect(hits(rule('R3'), 'desktop/frontend/src/views/Planted.ts', 'const t = mintTarget({})\n')).toEqual([1])
    expect(hits(rule('R4'), view, 'await api.listSessions(connectionTarget(useApp.getState().cfg))\n')).toEqual([1])
    expect(hits(rule('R1'), view, '  // 以前读 cfg.backendUrl\n   * cfg.backendUrl\n')).toEqual([])
    expect(hits(rule('R1'), 'desktop/frontend/src/services/engine/targets.ts', planted)).toEqual([])
    expect(hits(rule('R3'), 'desktop/frontend/src/services/engine/targets.ts', 'mintTarget({})')).toEqual([])
    expect(hits(rule('R4'), 'desktop/frontend/src/components/SettingsModal.tsx', 'testConnection(connectionTarget(form))')).toEqual([])
    expect(hits(rule('R1'), 'mobile/src/settingsHarness.tsx', planted)).toEqual([])
  })

  it('自检:R1 的同名字段搬运例外只放过「抄进同名字段」,拼成别的照样红', () => {
    const f = 'desktop/frontend/src/stores/Planted.ts'
    expect(hits(rule('R1'), f, 'const eff = { backendUrl: c.backendUrl, token: c.token }\n')).toEqual([])
    expect(hits(rule('R1'), f, 'const m = {\n  backendUrl: stored?.backendUrl || prev.backendUrl,\n}\n')).toEqual([])
    expect(hits(rule('R1'), f, 'const x = { backendUrl: `${c.backendUrl}/agent` }\n')).toEqual([1])
    expect(hits(rule('R1'), f, 'const x = { url: c.backendUrl }\n')).toEqual([1])
    expect(hits(rule('R1'), f, "fetch(c.backendUrl + '/health')\n")).toEqual([1])
    expect(hits(rule('R1'), f, "const x = { backendUrl: c.backendUrl + '/agent/x' }\n")).toEqual([1]) // 前面像搬运、后面在拼 URL
    expect(hits(rule('R1'), f, 'const x = { backendUrl: c.backendUrl }\n')).toEqual([])
  })

  it('零违规(K6-S3 起没有基线:存量已由 codemod + 人工清零)', () => {
    const { files, where } = scan()
    // 扫描根写错 → 空集 → 假绿:先确认真的扫到了东西
    expect(files, '扫到的源码文件太少,扫描根可能失效').toBeGreaterThan(500)
    const over: string[] = []
    for (const r of RULES) for (const [rel, at] of Object.entries(where[r.id])) over.push(`${r.id} ${rel}:${at.join(',')} —— ${r.what}`)
    expect(over, '新代码绕过了引擎目标解析层:改用 services/engine/targets 的目标 + backendService / agentRunService / engineFetch').toEqual([])
  })
})
