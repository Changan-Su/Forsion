// 智库同步第 2 步 U 包的纯函数:两层回复的拆法、v2 feed 与旧条目 feed 的去重、范围计算、模式判定、入口状态、错误码文案。
import { afterEach, describe, expect, it } from 'vitest'
import { CHANNEL_MISSING, EXTEND_UNAVAILABLE, normalizeReply } from './client'
import { isPlaceholderReview, v2Feed, v2Roots } from './feed'
import { modeFrom, setSyncMode, useSyncMode } from './mode'
import { parseSyncFocus } from './openSyncSettings'
import { addedItems, closureItems, isExcluded, mergeScope, rebaseScope, removeItem, scopeCovers, topLevelEntries } from './scope'
import { entrySyncState } from './entries'
import { syncErrorText } from './errors'
import { feedsOf } from '../vaultSyncStore'
import { CREATE_CANDIDATE, VAULT_SYNC_CHANNELS as CH, type BindingScope, type VaultSyncStatus } from './types'
import { translate } from '../../i18n'

const t = (k: string, v?: Record<string, unknown>): string => translate(k, v)
type SB = VaultSyncStatus['bindings'][number]
const binding = (over: Partial<SB> = {}): SB => ({
  id: 'b1', root: '/v/A', name: 'A', state: 'active', enabled: true, role: 'primary',
  target: { kind: 'penzor', vaultId: 'v1', vaultName: 'A', placement: 'own', prefix: '' },
  scope: { mode: 'all' },
  status: { phase: 'idle', lastSyncAt: 1, pendingChanges: 0, held: 0, deletesPending: 0, failures: 0 },
  ...over,
})

describe('normalizeReply(两层信封)', () => {
  it('外层 ok:false → 失败,带错误码', () => {
    expect(normalizeReply(CH.get, { ok: false, error: 'compat_mode' })).toEqual({ ok: false, error: 'compat_mode' })
    expect(normalizeReply(CH.get, null)).toEqual({ ok: false, error: 'invalid_reply' })
  })
  it('软失败通道:内层 {error} 或 {ok:false,error} 都算失败', () => {
    expect(normalizeReply(CH.apply, { ok: true, value: { error: 'stale' } })).toEqual({ ok: false, error: 'stale' })
    expect(normalizeReply(CH.resolve, { ok: true, value: { ok: false, error: 'stale' } })).toEqual({ ok: false, error: 'stale' })
    expect(normalizeReply(CH.setScope, { ok: true, value: { error: 'preview_required' } })).toEqual({ ok: false, error: 'preview_required' })
  })
  it('软失败通道成功:BindingView 原样(有 error 字段也不误判,#884)', () => {
    const view = { id: 'b1', status: { error: 'x' } }
    expect(normalizeReply(CH.apply, { ok: true, value: view })).toEqual({ ok: true, value: view })
  })
  it('只读通道:value 里的 error 不当失败', () => {
    expect(normalizeReply(CH.get, { ok: true, value: { error: 'x', mode: 'full' } })).toEqual({ ok: true, value: { error: 'x', mode: 'full' } })
  })
})

describe('modeFrom / setSyncMode', () => {
  afterEach(() => useSyncMode.setState({ mode: 'unknown', compatReason: undefined, error: undefined }))
  it('Extend 不在 = off;通道缺位 = 老 Extend 走旧界面', () => {
    expect(modeFrom({ ok: false, error: EXTEND_UNAVAILABLE }).mode).toBe('off')
    expect(modeFrom({ ok: false, error: CHANNEL_MISSING }).mode).toBe('legacy')
  })
  it('full / compat / 读不出', () => {
    expect(modeFrom({ ok: true, value: { mode: 'full' } }).mode).toBe('full')
    expect(modeFrom({ ok: true, value: { mode: 'compat', compatReason: 'content-sync-active' } })).toEqual({ mode: 'legacy', compatReason: 'content-sync-active' })
    expect(modeFrom({ ok: true, value: { mode: 'compat', compatReason: 'state-unreadable' } }).mode).toBe('unreadable')
  })
  it('偶发出错不盖掉已问出来的模式(入口别在 full / legacy 间来回跳)', () => {
    setSyncMode({ mode: 'full' })
    setSyncMode({ mode: 'unknown', error: 'timeout' })
    expect(useSyncMode.getState().mode).toBe('full')
  })
})

describe('v2 feed', () => {
  it('关着 = off;needs-* = paused;没登录 / 断网分开', () => {
    expect(v2Feed({ ...binding(), enabled: false }).phase).toBe('off')
    expect(v2Feed(binding({ state: 'needs-choice' })).phase).toBe('paused')
    expect(v2Feed(binding({ status: { ...binding().status, phase: 'error', error: 'not_signed_in' } })).phase).toBe('signed-out')
    expect(v2Feed(binding({ status: { ...binding().status, phase: 'error', error: 'fetch failed' } })).phase).toBe('offline')
  })
  it('等你定:没有清单(U-2 之前)给占位条目,只算数', () => {
    const f = v2Feed(binding({ status: { ...binding().status, held: 2 } }))
    const differs = f.review.filter((r) => r.kind === 'differs')
    expect(differs).toHaveLength(2)
    expect(differs.every(isPlaceholderReview)).toBe(true)
  })
  it('v2Roots 只收启用的主绑定', () => {
    const st: VaultSyncStatus = { mode: 'full', bindings: [binding(), binding({ id: 'b2', root: '/v/B', enabled: false }), binding({ id: 'b3', root: '/v/C', role: 'backup' })] }
    expect([...v2Roots(st)]).toEqual(['/v/A'])
  })
  it('feedsOf:v2 接手了的根,旧条目同步那条不再算(不出两个状态)', () => {
    const feeds = feedsOf({
      legacy: {}, content: null, remote: null, pinnedRoot: null,
      entryVaults: [{ vaultRoot: '/v/A', entries: [{ rootRel: 'x', cloudPath: 'Amadeus/A/x' }] } as never],
      v2: { mode: 'full', bindings: [binding()] },
    })
    expect(feeds.map((f) => f.id)).toEqual(['vault:b1'])
  })
})

describe('范围计算', () => {
  const some = { mode: 'some' as const, items: [{ path: 'Work', kind: 'folder' as const }, { path: 'Note.md', kind: 'page' as const }], exclude: ['Work/Old'] }
  it('scopeCovers:显式项 / 被盖住 / 被排除 / 页面的子页目录', () => {
    expect(scopeCovers(some, 'Work')).toBe('explicit')
    expect(scopeCovers(some, 'Work/a.md')).toBe('covered')
    expect(scopeCovers(some, 'Work/Old/b.md')).toBe(false)
    expect(scopeCovers(some, 'Note.fd/sub.md')).toBe('covered')
    expect(scopeCovers({ mode: 'all' }, 'anything')).toBe('covered')
    expect(scopeCovers(null, 'x')).toBe(false)
  })
  it('removeItem:只去正好那一项;不是显式项 / 去掉后一项不剩 → null', () => {
    expect(removeItem(some, 'Work')).toEqual({ mode: 'some', items: [{ path: 'Note.md', kind: 'page' }], exclude: ['Work/Old'] })
    expect(removeItem(some, 'Work/a.md')).toBeNull()
    expect(removeItem({ mode: 'some', items: [{ path: 'Work', kind: 'folder' }] }, 'Work')).toBeNull()
  })
  it('closureItems:关联笔记 + 附件进范围,上次剔除的子页面保持剔除', () => {
    const r = closureItems('Note.md', 'page', { pages: ['Ref.md'], files: ['img/a.png'], subPages: ['Note.fd/A.md', 'Note.fd/B.md'] }, (p) => p === 'Note.fd/B.md')
    expect(r.items).toEqual([{ path: 'Note.md', kind: 'page' }, { path: 'Ref.md', kind: 'page' }, { path: 'img/a.png', kind: 'file' }])
    expect(r.exclude).toEqual(['Note.fd/B.md'])
    expect(closureItems('a.png', 'file', null, () => false).items).toEqual([{ path: 'a.png', kind: 'file' }])
  })
  it('mergeScope:去重;新点名的路径从排除里拿掉;整个库原样', () => {
    const m = mergeScope(some, [{ path: 'Work/Old', kind: 'folder' }, { path: 'Note.md', kind: 'page' }])
    expect(m).toEqual({ mode: 'some', items: [...some.items, { path: 'Work/Old', kind: 'folder' }] })
    expect(mergeScope({ mode: 'all' }, [{ path: 'x', kind: 'file' }])).toEqual({ mode: 'all' })
    // 原来被排除的 Work/Old 重新点名 = 新加的(要出汇总卡)
    expect(addedItems(some, m)).toEqual([{ path: 'Work/Old', kind: 'folder' }])
    expect(addedItems(some, mergeScope(some, [{ path: 'New', kind: 'folder' }]))).toEqual([{ path: 'New', kind: 'folder' }])
  })
  it('topLevelEntries:文件夹在前;X.fd 跟着 X.md;点开头的不列', () => {
    expect(topLevelEntries(['b.md', 'Work/x.md', 'b.fd/c.md', '.trash/z.md'], ['img/a.png', 'top.pdf'])).toEqual([
      { path: 'img', kind: 'folder' }, { path: 'Work', kind: 'folder' }, { path: 'b.md', kind: 'page' }, { path: 'top.pdf', kind: 'file' },
    ])
  })
})

describe('入口与落点', () => {
  it('entrySyncState 只看启用的主绑定', () => {
    const st: VaultSyncStatus = { mode: 'full', bindings: [binding({ scope: { mode: 'some', items: [{ path: 'Work', kind: 'folder' }] } })] }
    expect(entrySyncState('/v/A', 'Work', st)).toBe('explicit')
    expect(entrySyncState('/v/A', 'Work/a.md', st)).toBe('covered')
    expect(entrySyncState('/v/A', 'Other', st)).toBe(false)
    expect(entrySyncState('/v/B', 'Work', st)).toBe(false)
    expect(entrySyncState('/v/A', 'Work', { mode: 'full', bindings: [binding({ enabled: false })] })).toBe(false)
  })
  it('parseSyncFocus 逐个字段核类型(别的窗口传来的)', () => {
    expect(parseSyncFocus({ root: '/v/A', path: 'x.md', kind: 'page', intent: 'start' })).toEqual({ root: '/v/A', path: 'x.md', kind: 'page', intent: 'start' })
    expect(parseSyncFocus({ root: 3, kind: 'bad', intent: 'x' })).toEqual({})
    expect(parseSyncFocus(null)).toBeUndefined()
  })
  it('syncErrorText:带前缀的错误码也认得;认不得的给原文', () => {
    expect(syncErrorText('Error invoking remote method: Error: entry_sync_active', t)).toBe(t('ssync.err.entryActive'))
    expect(syncErrorText('root_nested', t)).toBe(t('ssync.err.overlap'))
    expect(syncErrorText('reserved', t, 'X')).toBe(t('ssync.err.reserved', { name: 'X' }))
    expect(syncErrorText('target-location-changed', t)).toBe(t('ssync.targetChanged'))
    expect(syncErrorText('weird thing', t)).toContain('weird thing')
  })
})

describe('Codex 评审返修(第 2 步 U)', () => {
  const W = (p: string) => ({ path: p, kind: 'folder' as const })
  const P = (p: string) => ({ path: p, kind: 'page' as const })
  it('rebaseScope:过期重来按差量套到引擎此刻的范围,别处去掉的不加回、别处加的不抹掉(P1-1)', () => {
    const base: BindingScope = { mode: 'some', items: [P('A.md'), P('B.md')] }
    const next = mergeScope(base, [P('C.md')])
    // 期间右键停了 B、别处又加了 D
    const fresh: BindingScope = { mode: 'some', items: [P('A.md'), P('D.md')] }
    expect(rebaseScope(base, next, fresh)).toEqual({ mode: 'some', items: [P('A.md'), P('D.md'), P('C.md')] })
    // 这次本身去掉了 A、加了 C:套上去照样去掉 A
    expect(rebaseScope(base, { mode: 'some', items: [P('B.md'), P('C.md')] }, fresh)).toEqual({ mode: 'some', items: [P('D.md'), P('C.md')] })
    // 期间变成整个库:不往回收
    expect(rebaseScope(base, next, { mode: 'all' })).toEqual({ mode: 'all' })
    // 排除的增减也按差量
    const b2: BindingScope = { mode: 'some', items: [W('Work')], exclude: ['Work/Old'] }
    const n2: BindingScope = { mode: 'some', items: [W('Work'), P('X.md')], exclude: ['Work/Old', 'Work/Tmp'] }
    expect(rebaseScope(b2, n2, { mode: 'some', items: [W('Work')], exclude: ['Work/Old', 'Work/Draft'] })).toEqual({ mode: 'some', items: [W('Work'), P('X.md')], exclude: ['Work/Old', 'Work/Draft', 'Work/Tmp'] })
  })
  it('isExcluded:排除的笔记不因被链接就跟着进来;mergeScope 只解开点名的那一项(P1-2)', () => {
    const scope: BindingScope = { mode: 'some', items: [W('Work')], exclude: ['Private.md'] }
    const { items } = closureItems('Plan.md', 'page', { pages: ['Private.md', 'Work/M.md'], files: [] }, () => false)
    const kept = items.filter((it) => it.path === 'Plan.md' || (!scopeCovers(scope, it.path) && !isExcluded(scope, it.path)))
    expect(kept.map((x) => x.path)).toEqual(['Plan.md'])
    expect((mergeScope(scope, kept) as { exclude?: string[] }).exclude).toEqual(['Private.md'])
    // 右键点的就是被排除的那篇:用户明说要同步,解开
    expect((mergeScope(scope, [P('Private.md')]) as { exclude?: string[] }).exclude).toBeUndefined()
  })
  it('停止同步这一项:去掉后还被别的项盖着 = 不算停掉(P1-2)', () => {
    const scope: BindingScope = { mode: 'some', items: [W('Work'), P('Work/A.md'), P('Other.md')] }
    const next = removeItem(scope, 'Work/A.md')!
    expect(scopeCovers(next, 'Work/A.md')).toBe('covered')
  })
  it('preview / 找回 / 删除确认的内层 {error} 当失败;get 成功但没 value 不崩(P2-1)', () => {
    expect(normalizeReply(CH.preview, { ok: true, value: { error: 'scope_unreadable' } })).toEqual({ ok: false, error: 'scope_unreadable' })
    expect(normalizeReply(CH.recoveryRestore, { ok: true, value: { error: 'not_found' } })).toEqual({ ok: false, error: 'not_found' })
    expect(normalizeReply(CH.deletesConfirm, { ok: true, value: undefined })).toEqual({ ok: true, value: undefined })
    expect(modeFrom({ ok: true, value: undefined as never }).mode).toBe('unknown')
  })
  it('按名字新建的候选是 E 认的 {kind:new}(3164e7c);新错误码有人话', () => {
    expect(CREATE_CANDIDATE).toEqual({ kind: 'new' })
    expect(syncErrorText('takeover_in_progress', t)).toBe(t('ssync.err.takeoverBusy'))
    expect(syncErrorText('Error: binding_not_found', t)).toBe(t('ssync.err.bindingGone'))
  })
})
