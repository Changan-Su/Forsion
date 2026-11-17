/**
 * 别人共享给当前账号的 Unit:名册解析(坏形状丢行、旧版没有 shared)与进入地址校验矩阵。
 */
import { describe, expect, it } from 'vitest'
import { parseSharedUnit, parseSharedUnits, sharedFramePrefix, sharedLabel, validateSharedWebUrl } from './sharedUnits'

const ID = '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c'
const OTHER = '8b1d0c2e-1111-4e8a-9c21-000000000002'
const CLOUD = 'https://api.example.test'
const row = (over: Record<string, unknown> = {}, sharedOver: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID, name: 'Studio', platform: 'linux', icon: null, online: true,
  shared: { group: { id: 'g1', title: { zh: '星河', en: 'Galaxy' } }, roleLabel: { zh: '管理员', en: 'Admin' }, enter: 'frame', ...sharedOver },
  webUrl: `https://${ID}.units.example.test/api/units/${ID}/proxy/web/`,
  ...over,
})

describe('parseSharedUnits', () => {
  it('旧版云端 / Extend:回包没有 shared 键 → undefined(没有这一组)', () => {
    expect(parseSharedUnits({ units: [] })).toBeUndefined()
    expect(parseSharedUnits(null)).toBeUndefined()
  })
  it('shared 不是数组 → undefined(不知道,调用方别当成空)', () => {
    for (const v of [{}, 'x', 3, null, true]) expect(parseSharedUnits({ units: [], shared: v })).toBeUndefined()
  })
  it('好行留下,形状统一;同 id 只留第一行', () => {
    const out = parseSharedUnits({ units: [], shared: [row(), row({ name: 'dup' })] })!
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      id: ID, name: 'Studio', platform: 'linux', icon: null, online: true,
      shared: { group: { id: 'g1', title: { zh: '星河', en: 'Galaxy' } }, roleLabel: { zh: '管理员', en: 'Admin' }, enter: 'frame' },
      webUrl: `https://${ID}.units.example.test/api/units/${ID}/proxy/web/`,
    })
  })
  it('坏行逐行丢,不连累别的行', () => {
    const bad = [
      null, 'x', [], row({ id: '../x' }), row({ id: 'short' }), row({ id: 5 }), row({ name: '' }), row({ name: 3 }),
      row({ shared: null }), row({ shared: 'x' }),
      row({}, { group: null }), row({}, { group: { id: '', title: { zh: 'a' } } }), row({}, { group: { id: 'g', title: {} } }),
      row({}, { group: { id: 'g', title: { zh: 1, en: '' } } }), row({}, { roleLabel: null }), row({}, { roleLabel: { fr: 'x' } }),
      row({}, { enter: 'window' }), row({}, { enter: undefined }), row({}, { enter: 'FRAME' }),
      row({ webUrl: undefined }), row({ webUrl: '' }), row({ webUrl: 7 }), // 能进的行没有地址
    ]
    const good = row({ id: OTHER })
    const out = parseSharedUnits({ shared: [...bad, good] })!
    expect(out.map((u) => u.id)).toEqual([OTHER])
  })
  it('enter = none:open 只认 { kind: space, plugin: <manifest id> };写坏了 = 没给,行照留', () => {
    const ok = parseSharedUnit(row({ webUrl: undefined }, { enter: 'none', open: { kind: 'space', plugin: 'biz-plugin' } }))!
    expect(ok.shared.open).toEqual({ kind: 'space', plugin: 'biz-plugin' })
    for (const open of [{ kind: 'url', plugin: 'x' }, { kind: 'space', plugin: 'Bad Id' }, { kind: 'space' }, 'space']) {
      const u = parseSharedUnit(row({ webUrl: undefined }, { enter: 'none', open }))!
      expect(u).not.toBeNull()
      expect(u.shared.open).toBeUndefined()
    }
    // 能进的行不带 open
    expect(parseSharedUnit(row({}, { open: { kind: 'space', plugin: 'biz-plugin' } }))!.shared.open).toBeUndefined()
  })
  it('enter = none 的行带了地址:原样留着(进不进只由 enter 决定,主进程绑定时再核)', () => {
    const u = parseSharedUnit(row({}, { enter: 'none' }))!
    expect(u.shared.enter).toBe('none')
    expect(typeof u.webUrl).toBe('string')
  })
  it('sleeping 只认 true;多余字段丢掉;文案截长', () => {
    expect(parseSharedUnit(row({ sleeping: true }))!.sleeping).toBe(true)
    expect(parseSharedUnit(row({ sleeping: 'yes' }))!.sleeping).toBeUndefined()
    const u = parseSharedUnit(row({ extra: 1 }, { group: { id: 'g', title: { zh: 'x'.repeat(500), de: 'y' } } }))! as unknown as Record<string, unknown>
    expect(u.extra).toBeUndefined()
    expect((u.shared as { group: { title: Record<string, string> } }).group.title).toEqual({ zh: 'x'.repeat(120) })
  })
})

describe('sharedLabel', () => {
  it('按语言取,缺了回落到有的那个', () => {
    expect(sharedLabel({ zh: '星河', en: 'Galaxy' }, 'en')).toBe('Galaxy')
    expect(sharedLabel({ zh: '星河', en: 'Galaxy' }, 'zh')).toBe('星河')
    expect(sharedLabel({ zh: '星河' }, 'en')).toBe('星河')
    expect(sharedLabel({ en: 'Galaxy' }, 'zh')).toBe('Galaxy')
    expect(sharedLabel(undefined, 'zh')).toBe('')
  })
})

describe('validateSharedWebUrl', () => {
  const sub = `https://${ID}.units.example.test`
  const ok = `${sub}/api/units/${ID}/proxy/web/`
  it('https、这台自己的路径、源不是云端 → 通过(片段去掉)', () => {
    expect(validateSharedWebUrl(ok, ID, CLOUD)).toBe(ok)
    expect(validateSharedWebUrl(`${ok}#x`, ID, CLOUD)).toBe(ok)
    expect(validateSharedWebUrl(`${sub}/api/units/${ID}/proxy/`, ID, CLOUD)).toBe(`${sub}/api/units/${ID}/proxy/`)
  })
  it('协议:http 不行;javascript / data / file / ws 不行', () => {
    for (const u of [ok.replace('https:', 'http:'), `javascript:alert(1)//${ok}`, 'data:text/html,x', `file:///api/units/${ID}/proxy/`, ok.replace('https:', 'wss:')]) {
      expect(validateSharedWebUrl(u, ID, CLOUD), u).toBeNull()
    }
  })
  it('路径:不是 /api/units/<这台>/proxy/ 开头、别台的 id、上跳 / 编码上跳 / 反斜杠 → 不通过', () => {
    for (const u of [
      `${sub}/web/`, `${sub}/api/units/${ID}/proxy`, `${sub}/api/units/${ID}/open`, `${sub}/api/units/${OTHER}/proxy/`,
      `${sub}/api/units/${ID}x/proxy/`, `${sub}/api/units/${ID}/proxy/%2e%2e/%2e%2e/units`, `${sub}/api/units/${ID}/proxy/a%5c..%5cb`,
      `${sub}/api/units/${ID}/proxy/%E0%A4%A`,
    ]) expect(validateSharedWebUrl(u, ID, CLOUD), u).toBeNull()
  })
  it('源等于云端的源 → 不通过(共享行不许把登录头补到云端自己)', () => {
    expect(validateSharedWebUrl(`${CLOUD}/api/units/${ID}/proxy/web/`, ID, CLOUD)).toBeNull()
    expect(validateSharedWebUrl(`${CLOUD}/api/units/${ID}/proxy/web/`, ID, `${CLOUD}/`)).toBeNull()
  })
  it('带用户名密码 → 不通过', () => {
    expect(validateSharedWebUrl(`https://u:p@${ID}.units.example.test/api/units/${ID}/proxy/`, ID, CLOUD)).toBeNull()
    expect(validateSharedWebUrl(`https://u@${ID}.units.example.test/api/units/${ID}/proxy/`, ID, CLOUD)).toBeNull()
  })
  it('id 不合法 / 云端不知道 / 地址不是字符串 → 不通过', () => {
    expect(validateSharedWebUrl(ok, '../x', CLOUD)).toBeNull()
    expect(validateSharedWebUrl(ok, ID, null)).toBeNull()
    expect(validateSharedWebUrl(undefined, ID, CLOUD)).toBeNull()
    expect(validateSharedWebUrl('not a url', ID, CLOUD)).toBeNull()
  })
  it('.localhost 例外:只在 http 下、且云端自己是 http 回环(本机开发 / 台架)', () => {
    const dev = 'http://127.0.0.1:4100'
    const local = `http://${ID}.localhost:4100/api/units/${ID}/proxy/web/`
    expect(validateSharedWebUrl(local, ID, dev)).toBe(local)
    expect(validateSharedWebUrl(local, ID, 'http://localhost:4100')).toBe(local)
    expect(validateSharedWebUrl(local, ID, CLOUD)).toBeNull() // 生产云端是 https:不认 http 子域
    expect(validateSharedWebUrl(`http://${ID}.example.test:4100/api/units/${ID}/proxy/`, ID, dev)).toBeNull() // http 只认 .localhost
    expect(validateSharedWebUrl(`http://localhost:4100/api/units/${ID}/proxy/`, ID, 'http://127.0.0.1:9')).toBeNull() // 裸 localhost 不算子域
    expect(validateSharedWebUrl(`http://127.0.0.1:4100/api/units/${ID}/proxy/`, ID, dev)).toBeNull() // 回环 IP 本身不算
    expect(validateSharedWebUrl(`http://${ID}.localhost:4100/api/units/${ID}/proxy/`, ID, 'http://cloud.example.test')).toBeNull() // 云端不是回环
    // https 的 .localhost 不受这条限制
    expect(validateSharedWebUrl(`https://${ID}.localhost/api/units/${ID}/proxy/`, ID, CLOUD)).toBe(`https://${ID}.localhost/api/units/${ID}/proxy/`)
  })
})

describe('sharedFramePrefix', () => {
  it('= webUrl 的源 + /api/units/<id>/proxy/', () => {
    expect(sharedFramePrefix(`https://${ID}.units.example.test/api/units/${ID}/proxy/web/`, ID)).toBe(`https://${ID}.units.example.test/api/units/${ID}/proxy/`)
  })
})
