/** parseSpaceJson / slug 工具:用户自定义 Space 配方的解析校验。 */
import { describe, it, expect } from 'vitest'
import { parseSpaceJson, slugifyId, uniqueId, cmpVersion, recipeBucketOf, type ParseOpts } from './userSpaces.core'

const REGISTERED = new Set(['chat', 'workspace', 'outline'])
const opts = (over?: Partial<ParseOpts>): ParseOpts => ({
  isViewRegistered: (t) => REGISTERED.has(t),
  appVersion: '2.3.0',
  reservedIds: ['tangu', 'inbox', 'amadeus'],
  ...over,
})

const VALID = {
  id: 'focus',
  name: { zh: '专注', en: 'Focus' },
  icon: 'target',
  layout: { main: [{ type: 'chat' }], left: [{ type: 'workspace', params: { mode: 'files' } }], right: [{ type: 'outline' }] },
}

describe('parseSpaceJson', () => {
  it('合法配方解析成功,params 保留', () => {
    const r = parseSpaceJson(JSON.stringify(VALID), opts())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.spec.id).toBe('focus')
      expect(r.spec.layout.left[0].params).toEqual({ mode: 'files' })
      expect(r.spec.layout.right).toHaveLength(1)
    }
  })
  it('非法 JSON / 非 kebab id / 保留 id 均拒绝', () => {
    expect(parseSpaceJson('not json', opts()).ok).toBe(false)
    expect(parseSpaceJson(JSON.stringify({ ...VALID, id: 'Bad_ID' }), opts()).ok).toBe(false)
    expect(parseSpaceJson(JSON.stringify({ ...VALID, id: 'tangu' }), opts()).ok).toBe(false)
  })
  it('引用未注册视图 → 拒绝并点名(requires.views 同查)', () => {
    const r = parseSpaceJson(JSON.stringify({ ...VALID, layout: { main: [{ type: 'qbird-home' }] } }), opts())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('qbird-home')
    const r2 = parseSpaceJson(JSON.stringify({ ...VALID, requires: { views: ['qbird-home'] } }), opts())
    expect(r2.ok).toBe(false)
  })
  it('minAppVersion 高于当前 → 拒绝;appVersion 未知 → 放行;main 为空 → 拒绝', () => {
    expect(parseSpaceJson(JSON.stringify({ ...VALID, minAppVersion: '99.0.0' }), opts()).ok).toBe(false)
    expect(parseSpaceJson(JSON.stringify({ ...VALID, minAppVersion: '99.0.0' }), opts({ appVersion: null })).ok).toBe(true)
    expect(parseSpaceJson(JSON.stringify({ ...VALID, layout: { main: [] } }), opts()).ok).toBe(false)
  })
})

describe('slug 工具', () => {
  it('slugifyId 折叠非 ASCII,空回退 space', () => {
    expect(slugifyId('My Focus!!')).toBe('my-focus')
    expect(slugifyId('专注模式')).toBe('space')
  })
  it('uniqueId 撞名追加序号', () => {
    expect(uniqueId('focus', new Set(['focus', 'focus-2']))).toBe('focus-3')
    expect(uniqueId('focus', new Set())).toBe('focus')
  })
  it('cmpVersion 数值逐段', () => {
    expect(cmpVersion('2.10.0', '2.9.9')).toBe(1)
    expect(cmpVersion('v2.3.0', '2.3')).toBe(0)
    expect(cmpVersion('2.2.4', '2.3.0')).toBe(-1)
  })
})

describe('配方版本(version)', () => {
  it('解析并透传 version —— 宿主靠它判断「配方换过了」丢弃旧保存布局', () => {
    const r = parseSpaceJson(JSON.stringify({ ...VALID, version: '1.1.0' }), opts())
    expect(r.ok && r.spec.version).toBe('1.1.0')
  })
  it('未声明 version → undefined(老配方,宿主不介入布局)', () => {
    const r = parseSpaceJson(JSON.stringify(VALID), opts())
    expect(r.ok && r.spec.version).toBeUndefined()
  })
  it('非字符串 version 忽略,不让坏值触发误迁移', () => {
    const r = parseSpaceJson(JSON.stringify({ ...VALID, version: 3 }), opts())
    expect(r.ok && r.spec.version).toBeUndefined()
  })
})

describe('recipeBucketOf(「另存为 Space」的落桶判定)', () => {
  it('left/right 原样;main 与一切未知值都落 main', () => {
    expect(recipeBucketOf('left')).toBe('left')
    expect(recipeBucketOf('right')).toBe('right')
    expect(recipeBucketOf('main')).toBe('main')
    expect(recipeBucketOf(undefined)).toBe('main') // 老 panel 没有 __loc
    expect(recipeBucketOf('wat')).toBe('main')
  })

  // ⚠️回归:这里以前是 `as 'main'|'left'|'right'` 硬转,bottom 会穿过去 → layout['bottom'] 是 undefined
  //   → 调用方 `layout[loc].push()` 抛 TypeError = 开着底部面板点「另存为 Space」必崩。
  //   必须返回 null(= 跳过这个 panel),绝不能落进 main 桶(那会把终端之类的东西塞进主区配方)。
  it('⚠️bottom 返回 null(既不崩、也不错落进 main 桶)', () => {
    expect(recipeBucketOf('bottom')).toBeNull()
  })
})
