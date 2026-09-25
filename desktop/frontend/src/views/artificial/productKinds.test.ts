/**
 * 造物 Space 的纯逻辑:种类表(扩展契约)、deep link 参数闸、快捷方式结果 → toast、排序分组、相对时间。
 *
 * 种类表这几条不是形式主义:`labelKey` 存的必须是**键**而不是求值后的文案 —— 模块作用域的标签表
 * 一旦存成字符串,模块加载那一刻就定格,切语言纹丝不动(仓规「模块作用域标签表」那条)。
 * 这里直接拿字典验:键查得出文案 = 它确实是键,且 zh/en 都补齐了(i18nCoverage 再从源码侧兜一遍)。
 */
import { describe, expect, it } from 'vitest'
import type { ProductSummary } from '../../../../shared/products'
import { translate } from '../../i18n'
import './artificialMessages' // 片段注册(副作用);testSetup 已把语言钉成 zh
import {
  KIND_ORDER, PRODUCT_KINDS, groupProducts, kindRow, productIdFromParams,
  resolveKind, serveOutcome, shortcutToast, sortProducts,
} from './productKinds'

const product = (p: Partial<ProductSummary> & { id: string }): ProductSummary => ({
  kind: 'web', name: p.id, root: `/Projects/${p.id}`, entry: 'index.html',
  createdAt: 0, updatedAt: 0, published: false, ...p,
})

describe('造物:种类表 = 扩展契约', () => {
  it('每个 ProductKind 都有一行,且标签存的是字典里查得到的**键**', () => {
    // 表里键的全集 = 契约本身:以后加一类产物,这里会先红。
    expect(Object.keys(PRODUCT_KINDS)).toEqual(['web', 'plugin', 'unknown'])
    for (const [kind, row] of Object.entries(PRODUCT_KINDS)) {
      expect(row.labelKey, kind).toMatch(/^artificial\.kind\./)
      expect(translate(row.labelKey), kind).not.toBe(row.labelKey) // 查不到会原样回键 = 词条没补
      expect(typeof row.icon, kind).not.toBe('undefined')
      expect(typeof row.canLaunch, kind).toBe('boolean')
      expect(typeof row.canShortcut, kind).toBe('boolean')
    }
  })

  it('只有 web 能启动 / 能加到桌面;unknown 恒排最后', () => {
    expect(PRODUCT_KINDS.web.canLaunch && PRODUCT_KINDS.web.canShortcut).toBe(true)
    expect(PRODUCT_KINDS.plugin.canLaunch || PRODUCT_KINDS.plugin.canShortcut).toBe(false)
    expect(PRODUCT_KINDS.unknown.canLaunch || PRODUCT_KINDS.unknown.canShortcut).toBe(false)
    expect(KIND_ORDER[KIND_ORDER.length - 1]).toBe('unknown')
  })

  it('⚠️运行时 kind 是开集:表里没有的字符串回落 unknown(卡片照常出现,只是少了启动动作)', () => {
    expect(resolveKind('mini-app')).toBe('unknown')
    expect(resolveKind('')).toBe('unknown')
    expect(resolveKind('toString')).toBe('unknown') // 原型链上的名字不算命中
    expect(kindRow('mini-app')).toBe(PRODUCT_KINDS.unknown)
    expect(kindRow('plugin')).toBe(PRODUCT_KINDS.plugin)
  })
})

describe('造物:deep link 的 id 闸', () => {
  it('只取 id,多带的参数一概丢掉', () => {
    expect(productIdFromParams({ id: 'p_0123456789ab', url: 'https://evil.test', path: '/etc/passwd' })).toBe('p_0123456789ab')
  })
  it('形态不合一律拒(长度 / 大写 / 前缀 / 路径 / 非字符串 / 缺失)', () => {
    for (const id of ['p_0123456789a', 'p_0123456789abc', 'P_0123456789AB', 'p_0123456789ag', 'x_0123456789ab',
      'p_0123456789ab/../secret', ' p_0123456789ab', 'p_0123456789ab\n', '']) {
      expect(productIdFromParams({ id }), id).toBeNull()
    }
    expect(productIdFromParams({})).toBeNull()
    expect(productIdFromParams({ id: 123 })).toBeNull()
    expect(productIdFromParams({ id: ['p_0123456789ab'] })).toBeNull()
  })
})

describe('造物:products:serve 的失败分类', () => {
  it('⚠️「没有网页入口」是**永久**拒绝,不能混进可重试的 error', () => {
    // 逐字取自 electron/productsIpc:`throw new Error('product has no web entry')`。
    // 它既不含 not found 也不含 ENOENT —— 少了这一类就会掉进 error 分支,
    // 界面给出一颗按多少次都是同一结果的重试(deep link / 布局恢复能直接开到这条路径上)。
    expect(serveOutcome(new Error('product has no web entry'))).toBe('unservable')
    expect(serveOutcome(new Error("Error invoking remote method 'products:serve': Error: product has no web entry")))
      .toBe('unservable')
  })
  it('查无此物 → gone;其余 → 可重试的 error', () => {
    for (const message of ['product not found', 'invalid product id', "ENOENT: no such file or directory, stat '/x'"]) {
      expect(serveOutcome(new Error(message)), message).toBe('gone')
    }
    for (const message of ['listen EADDRINUSE: address already in use', 'EBUSY', '']) {
      expect(serveOutcome(new Error(message)), message).toBe('error')
    }
  })
  it('不是 Error 的东西也要有结论(IPC 可能扔字符串)', () => {
    expect(serveOutcome('product has no web entry')).toBe('unservable')
    expect(serveOutcome('product not found')).toBe('gone')
    expect(serveOutcome(undefined)).toBe('error')
  })
})

describe('造物:快捷方式结果 → toast', () => {
  it('成功 / 开发模式 / 其余失败各走各的词条', () => {
    expect(shortcutToast({ ok: true, path: '/Desktop/x.app' })).toEqual({ key: 'artificial.toast.shortcutOk', error: false })
    expect(shortcutToast({ ok: false, code: 'unpackaged' })).toEqual({ key: 'artificial.toast.shortcutUnpackaged', error: true })
    expect(shortcutToast({ ok: false, code: 'error', detail: 'EACCES' }))
      .toEqual({ key: 'artificial.toast.shortcutFailed', error: true, vars: { detail: 'EACCES' } })
    // 没有 detail 时退回 code,别给用户一条「失败:undefined」
    expect(shortcutToast({ ok: false, code: 'unsupported' }))
      .toEqual({ key: 'artificial.toast.shortcutFailed', error: true, vars: { detail: 'unsupported' } })
  })
  it('三条词条都在字典里', () => {
    for (const key of ['artificial.toast.shortcutOk', 'artificial.toast.shortcutUnpackaged', 'artificial.toast.shortcutFailed']) {
      expect(translate(key, { detail: 'x' }), key).not.toBe(key)
    }
  })
})

describe('造物:排序与分组', () => {
  const rows = [
    product({ id: 'p_00000000000a', name: 'Old web', updatedAt: 100 }),
    product({ id: 'p_00000000000b', name: 'Plugin', kind: 'plugin', updatedAt: 300 }),
    product({ id: 'p_00000000000c', name: 'New web', updatedAt: 500 }),
    product({ id: 'p_00000000000d', name: 'Mystery', kind: 'mini-app' as never, updatedAt: 400 }),
    product({ id: 'p_00000000000e', name: 'Same time B', updatedAt: 500 }),
  ]

  it('最近改动在前;同一时刻按名字定序(否则每次刷新都在抖)', () => {
    expect(sortProducts(rows).map((p) => p.name)).toEqual(['New web', 'Same time B', 'Mystery', 'Plugin', 'Old web'])
    expect(sortProducts(rows)).not.toBe(rows) // 不就地改调用方的数组
  })

  it('按表序分组,组内仍按时间;空组不出现;未知种类进 unknown 组', () => {
    expect(groupProducts(rows)).toEqual([
      { kind: 'web', items: [rows[2], rows[4], rows[0]] },
      { kind: 'plugin', items: [rows[1]] },
      { kind: 'unknown', items: [rows[3]] },
    ])
    expect(groupProducts([rows[1]]).map((g) => g.kind)).toEqual(['plugin'])
    expect(groupProducts([])).toEqual([])
  })
})

