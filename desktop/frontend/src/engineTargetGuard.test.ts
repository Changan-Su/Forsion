// 引擎目标源码棘轮(P1-K6 §3.9 第 2 道守卫)—— 钉的是「新代码绕过目标解析层自己拼引擎 URL」。
//
// 为什么品牌类型不够:EngineTarget 的品牌只挡得住「调服务函数时不经解析层」,挡不住
// `authFetch(\`${cfg.backendUrl}/agent/x\`)` 这种自拼 URL(btwStore / ttsService 今天就是这样)——那种请求
// 永远打 home,手机切到「我的电脑」后会静默打错引擎。反过来棘轮也挡不住「拿错目标调合法函数」,所以两道都要。
//
// 三条规则(扫 desktop/frontend/src、mobile/src、web/src 的非测试源码):
//   R1 `.backendUrl` 属性读,只许在白名单文件里(解析层、types、三个宿主垫片、设置页外部连接表单、
//      首次引导的连接测试、各 harness / ChatPreview)
//   R2 模板串 `${…}/agent/`,只许在 backendService / agentRunService / services/engine/
//   R3 `mintTarget(` 只许在 services/engine/
// 基线 engineTargetGuard.baseline.json = K6-S0 时的存量违规,**只许减少**:超出基线即红;低于基线只提示收紧。
// S3 codemod 清零后删掉基线文件。重生成:UPDATE_ENGINE_TARGET_BASELINE=1 npx vitest run frontend/src/engineTargetGuard.test.ts
//
// ⚠️ 天花板:判据是字面量。解构(`const { backendUrl } = cfg`)与字符串拼接(`base + '/agent/'`)扫不到。
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const GENESIS = join(__dirname, '../../..')
const ROOTS = ['desktop/frontend/src', 'mobile/src', 'web/src']
const BASELINE_FILE = join(__dirname, 'engineTargetGuard.baseline.json')

type RuleId = 'R1' | 'R2' | 'R3'
interface Rule { id: RuleId; what: string; re: RegExp; allowed: (rel: string) => boolean }

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
  for (const m of text.matchAll(rule.re)) lines.push(text.slice(0, m.index).split('\n').length)
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

function scan(): { files: number; counts: Record<RuleId, Record<string, number>>; where: Record<RuleId, Record<string, number[]>> } {
  const counts = { R1: {}, R2: {}, R3: {} } as Record<RuleId, Record<string, number>>
  const where = { R1: {}, R2: {}, R3: {} } as Record<RuleId, Record<string, number[]>>
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
        if (at.length) { counts[rule.id][rel] = at.length; where[rule.id][rel] = at }
      }
    }
  }
  return { files, counts, where }
}

describe('引擎目标棘轮', () => {
  it('自检:种一条自拼引擎 URL 必须同时命中 R1 与 R2;铸造点外的 mintTarget 命中 R3;整行注释与白名单不算', () => {
    const planted = 'const u = `${cfg.backendUrl}/agent/x`\n'
    expect(hits(RULES[0], 'desktop/frontend/src/views/Planted.tsx', planted)).toEqual([1])
    expect(hits(RULES[1], 'desktop/frontend/src/views/Planted.tsx', planted)).toEqual([1])
    expect(hits(RULES[2], 'desktop/frontend/src/views/Planted.ts', 'const t = mintTarget({})\n')).toEqual([1])
    expect(hits(RULES[0], 'desktop/frontend/src/views/Planted.tsx', '  // 以前读 cfg.backendUrl\n   * cfg.backendUrl\n')).toEqual([])
    expect(hits(RULES[0], 'desktop/frontend/src/services/engine/targets.ts', planted)).toEqual([])
    expect(hits(RULES[2], 'desktop/frontend/src/services/engine/targets.ts', 'mintTarget({})')).toEqual([])
    expect(hits(RULES[0], 'mobile/src/settingsHarness.tsx', planted)).toEqual([])
  })

  it('超出 K6-S0 基线即红(只许减少)', () => {
    const { files, counts, where } = scan()
    // 扫描根写错 → 空集 → 假绿:先确认真的扫到了东西
    expect(files, '扫到的源码文件太少,扫描根可能失效').toBeGreaterThan(500)

    if (process.env.UPDATE_ENGINE_TARGET_BASELINE === '1') {
      const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
      writeFileSync(BASELINE_FILE, JSON.stringify({
        _note: 'P1-K6 引擎目标棘轮基线(engineTargetGuard.test.ts):K6-S0 时的存量违规,只许减少;S3 codemod 清零后删除本文件。',
        R1: sorted(counts.R1), R2: sorted(counts.R2), R3: sorted(counts.R3),
      }, null, 2) + '\n')
    }

    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Record<RuleId, Record<string, number>>
    const over: string[] = []
    const shrunk: string[] = []
    for (const rule of RULES) {
      const base = baseline[rule.id] || {}
      for (const [rel, n] of Object.entries(counts[rule.id])) {
        if (n > (base[rel] ?? 0)) over.push(`${rule.id} ${rel}:${where[rule.id][rel].join(',')}  (${n} > 基线 ${base[rel] ?? 0}) —— ${rule.what}`)
      }
      for (const [rel, n] of Object.entries(base)) {
        if ((counts[rule.id][rel] ?? 0) < n) shrunk.push(`${rule.id} ${rel}: ${counts[rule.id][rel] ?? 0} < 基线 ${n}`)
      }
    }
    if (shrunk.length) console.warn(`[engineTargetGuard] 违规减少了,可以收紧基线(UPDATE_ENGINE_TARGET_BASELINE=1):\n  ${shrunk.join('\n  ')}`)
    expect(over, '新代码绕过了引擎目标解析层:改用 services/engine/targets 的目标 + backendService / agentRunService / engineFetch').toEqual([])
  })
})
