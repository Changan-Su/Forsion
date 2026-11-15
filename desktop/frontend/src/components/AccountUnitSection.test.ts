// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ uiMode: 'desktop' as string, presenter: undefined as unknown }))
vi.mock('@lcl/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@lcl/engine')>()
  return {
    ...real,
    get UI_MODE() { return engine.uiMode },
    nativeSheetPresenter: () => engine.presenter,
  }
})
const { unitPanelAvailable } = await import('./AccountUnitSection')
const { useUnitRoster } = await import('./unitRoster')

const desktop = () => ({ unitsList: vi.fn(), unitHostStatus: vi.fn() })

beforeEach(() => {
  engine.uiMode = 'desktop'
  engine.presenter = undefined
  history.replaceState(null, '', '/')
})
afterEach(() => { delete (window as any).tangu })

describe('unitPanelAvailable', () => {
  it('real desktop main window → yes', () => {
    window.tangu = desktop() as any
    expect(unitPanelAvailable()).toBe(true)
  })
  it('web entry (no device bridges, public entry) → no', () => {
    window.tangu = { authStatus: vi.fn(), unitPublicEntry: true } as any
    expect(unitPanelAvailable()).toBe(false)
    window.tangu = { authStatus: vi.fn() } as any
    expect(unitPanelAvailable()).toBe(false)
  })
  it('device page, phone shell, single-column UI, Android native sheet → no', () => {
    window.tangu = { ...desktop(), unitPage: true } as any
    expect(unitPanelAvailable()).toBe(false)
    window.tangu = { ...desktop(), mobile: true } as any
    expect(unitPanelAvailable()).toBe(false)
    window.tangu = desktop() as any
    engine.uiMode = 'mobile'
    expect(unitPanelAvailable()).toBe(false)
    engine.uiMode = 'desktop'
    engine.presenter = () => true
    expect(unitPanelAvailable()).toBe(false)
  })
  it('the Unit window (detached + ?unit=) → no Unit section, and it is recognised as a Unit window', async () => {
    const { unitWindowId } = await import('../windowKind')
    window.tangu = { ...desktop(), unitsShowMain: vi.fn() } as any
    history.replaceState(null, '', '/?window=detached&id=un_3f2a9c1e-7b4d&unit=3f2a9c1e-7b4d')
    expect(unitWindowId()).toBe('3f2a9c1e-7b4d')
    expect(unitPanelAvailable()).toBe(false)
    history.replaceState(null, '', '/?window=detached&unit=../../x')
    expect(unitWindowId()).toBeNull()
    history.replaceState(null, '', '/?unit=3f2a9c1e-7b4d') // 主窗带了 unit 参数也不算
    expect(unitWindowId()).toBeNull()
  })
  it('web (same entry, no desktop Unit-window bridge): a hand-made ?window=detached&unit=… is ignored', async () => {
    const { unitWindowId } = await import('../windowKind')
    history.replaceState(null, '', '/?window=detached&unit=3f2a9c1e-7b4d')
    window.tangu = { authStatus: vi.fn(), unitPublicEntry: true } as any
    expect(unitWindowId()).toBeNull()
    delete (window as any).tangu
    expect(unitWindowId()).toBeNull()
  })
  it('detached / floating / mini windows → no', () => {
    window.tangu = desktop() as any
    for (const kind of ['detached', 'floating', 'mini']) {
      history.replaceState(null, '', `/?window=${kind}&id=x`)
      expect(unitPanelAvailable()).toBe(false)
    }
  })
})

describe('useUnitRoster', () => {
  const units = [{ id: 'a', name: 'A', platform: 'darwin', icon: null, online: true, lanUrl: 'http://10.0.0.2:8791' }]
  beforeEach(() => useUnitRoster.getState().clear())

  it('keeps the cached roster when a refresh fails (read failure is not empty)', async () => {
    window.tangu = { unitsList: vi.fn().mockResolvedValue({ status: 200, json: { units } }), unitHostStatus: vi.fn().mockResolvedValue({ unitId: 'me' }), unitsProbeLan: vi.fn().mockResolvedValue({ instanceId: 'i', name: 'A' }) } as any
    await useUnitRoster.getState().refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(useUnitRoster.getState()).toMatchObject({ units, hostUnitId: 'me', lanOk: { a: true } })
    ;(window.tangu as any).unitsList = vi.fn().mockRejectedValue(new Error('offline'))
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toEqual(units)
    ;(window.tangu as any).unitsList = vi.fn().mockResolvedValue({ status: 502, json: null })
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toEqual(units)
  })

  it('401 → signed out (null); no roster bridge → only this computer ([])', async () => {
    window.tangu = { unitsList: vi.fn().mockResolvedValue({ status: 401, json: null }) } as any
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toBeNull()
    window.tangu = { unitHostStatus: vi.fn().mockResolvedValue({ unitId: null }) } as any
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().units).toEqual([])
  })

  it('this computer: unitId while hosting, else selfUnitId; neither = unknown (no filter)', async () => {
    window.tangu = { unitsList: vi.fn().mockResolvedValue({ status: 200, json: { units } }), unitHostStatus: vi.fn().mockResolvedValue({ unitId: null, selfUnitId: 'me' }) } as any
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().hostUnitId).toBe('me')
    ;(window.tangu as any).unitHostStatus = vi.fn().mockResolvedValue({ unitId: 'live', selfUnitId: 'me' })
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().hostUnitId).toBe('live')
    ;(window.tangu as any).unitHostStatus = vi.fn().mockResolvedValue({ unitId: null })
    await useUnitRoster.getState().refresh()
    expect(useUnitRoster.getState().hostUnitId).toBeNull()
  })
})

// ── 本机多 Unit(window.tangu.localUnits 桩;主进程那半在 electron/) ──
describe('local Units in the panel', () => {
  type Row = { id: string; name: string; icon: string; path: string; displayPath: string; state: 'running' | 'stopped' | 'missing' | 'mismatch'; current: boolean }
  const mk = (id: string, state: Row['state'], current = false): Row =>
    ({ id, name: id, icon: '', path: `/Users/x/Forsion Units/${id}`, displayPath: `~/Forsion Units/${id}`, state, current })
  let rows: Row[]
  let self: { kind: 'default' } | { kind: 'folder'; id: string; name: string; icon: string; path: string; displayPath: string }
  let registry: 'ok' | 'unreadable'
  let listFails = false
  let api: Record<string, ReturnType<typeof vi.fn>>
  let changed: (() => void) | null = null

  const React = () => import('react')
  let host: HTMLDivElement
  let root: import('react-dom/client').Root
  const onClose = vi.fn()
  const onToast = vi.fn()

  const localApi = () => {
    api = {
      list: vi.fn(async () => {
        if (listFails) throw new Error("No handler registered for 'localUnits:list'")
        return { self, units: registry === 'ok' ? rows.map((r) => ({ ...r })) : [], registry, defaultParent: '/Users/x/Forsion Units', defaultParentDisplay: '~/Forsion Units' }
      }),
      create: vi.fn(async (input: { name: string; icon: string }) => ({ ok: true, unit: { ...mk('new-1', 'stopped'), name: input.name } })),
      chooseParent: vi.fn(async () => ({ path: '/Users/x/Desktop', display: '~/Desktop' })),
      addExisting: vi.fn(async () => ({ ok: false, code: 'duplicate_id' })),
      open: vi.fn(async () => ({ ok: true })),
      rename: vi.fn(async () => ({ ok: true, unit: rows[0] })),
      reveal: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
      addToDesktop: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn((cb: () => void) => { changed = cb; return () => { changed = null } }),
    }
    return api
  }
  const tick = async () => { const { act } = await React(); await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
  async function mount() {
    const R = await React()
    const { createRoot } = await import('react-dom/client')
    const { AccountUnitSection } = await import('./AccountUnitSection')
    const { LocalUnitDialogHost } = await import('./LocalUnitDialogs')
    const { LocaleProvider } = await import('../i18n')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await R.act(async () => root.render(R.createElement(LocaleProvider, null,
      R.createElement('div', { className: 'account-pop' }, R.createElement(AccountUnitSection, { onClose, onToast })),
      R.createElement(LocalUnitDialogHost, { onToast }))))
    await tick()
    await tick()
  }
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null
  const local = (id: string) => q(`[data-local-unit="${id}"]`)!
  const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  async function click(el: Element | null) { const { act } = await React(); expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await tick() }
  async function rightClick(el: Element) {
    const { act } = await React()
    await act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })) })
    await tick()
  }
  const menuItems = () => Array.from(document.querySelectorAll('.ap-unit-ctx [role="menuitem"]')).map((b) => text(b))
  async function typeInto(el: HTMLInputElement, value: string) {
    const { act } = await React()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    rows = [mk('lab', 'running'), mk('demo', 'stopped'), mk('old', 'missing'), mk('copy', 'mismatch')]
    self = { kind: 'default' }
    registry = 'ok'
    listFails = false
    onClose.mockReset(); onToast.mockReset()
    const { resetLocalUnitsForTest } = await import('./localUnits')
    resetLocalUnitsForTest()
    const { useLocalUnitDialog } = await import('./LocalUnitDialogs')
    useLocalUnitDialog.getState().close()
    useUnitRoster.getState().clear()
    // 没有 Extend:没有名册桥 / 账号桥,只有本机多 Unit
    window.tangu = { platform: 'darwin', localUnits: localApi() } as any
  })
  afterEach(async () => {
    const { act } = await React()
    if (root) await act(async () => root.unmount())
    host?.remove()
    document.body.innerHTML = ''
  })

  it('localUnits alone (no Extend, no device bridge) shows the panel, and the avatar opens it even signed out', async () => {
    const { unitPanelForcesMenu } = await import('./AccountUnitSection')
    expect(unitPanelAvailable()).toBe(true)
    expect(unitPanelForcesMenu()).toBe(true)
    window.tangu = { unitHostStatus: vi.fn() } as any // 有设备桥、没有本机多 Unit:面板照旧,但不强行开菜单
    expect(unitPanelAvailable()).toBe(true)
    expect(unitPanelForcesMenu()).toBe(false)
  })

  it('"This computer" lists each folder Unit: path as grey text, ↗ on openable rows, missing / mismatch greyed and inert', async () => {
    await mount()
    const secs = Array.from(document.querySelectorAll('.ap-sec')).map(text)
    expect(secs).toEqual(['这台电脑']) // 没有 Extend:没有「我的设备」
    const order = Array.from(document.querySelectorAll('[data-unit-local], [data-local-unit]')).map((el) => el.getAttribute('data-local-unit') ?? 'default')
    expect(order).toEqual(['default', 'lab', 'demo', 'old', 'copy'])
    expect(q('[data-unit-local]')!.getAttribute('aria-current')).toBe('true')
    expect(text(local('lab').querySelector('.ap-unit-path'))).toBe('~/Forsion Units/lab')
    expect(local('lab').querySelector('.ap-unit-go')).toBeTruthy()
    expect(local('lab').tagName).toBe('BUTTON')
    expect(text(local('old').querySelector('.ap-unit-path'))).toBe('找不到这个文件夹')
    expect(text(local('copy').querySelector('.ap-unit-path'))).toBe('文件夹对不上')
    for (const id of ['old', 'copy']) {
      expect(local(id).tagName).toBe('DIV')
      expect(local(id).classList.contains('ap-unit--inert')).toBe(true)
      expect(local(id).getAttribute('aria-haspopup')).toBe('menu') // 点不开,但是一枚菜单钮(只有「从列表移除…」)
      expect(local(id).querySelector('.ap-unit-go')).toBeNull()
    }
    expect(q('[data-local-add]')).toBeTruthy()
    expect(q('[data-local-unreadable]')).toBeNull()
  })

  it('click a folder row = open(id) in its own window; a failed open says why in plain words', async () => {
    await mount()
    await click(local('demo'))
    expect(api.open).toHaveBeenCalledWith('demo')
    expect(onClose).toHaveBeenCalled()
    api.open.mockResolvedValueOnce({ ok: false, code: 'channel_mismatch' })
    await click(local('lab'))
    expect(onToast).toHaveBeenLastCalledWith(expect.stringContaining('另一个版本的 Forsion'), true)
    // 找不到的行点不动
    api.open.mockClear()
    await click(local('old'))
    expect(api.open).not.toHaveBeenCalled()
  })

  it('right-click: open / add to desktop / rename and icon / reveal (per platform) / remove; missing rows only remove', async () => {
    await mount()
    await rightClick(local('demo'))
    expect(menuItems()).toEqual(['在自己的窗口打开', '添加到桌面', '改名字和图标…', '在访达中显示', '从列表移除…'])
    await click(q('[data-unit-act="reveal"]'))
    expect(api.reveal).toHaveBeenCalledWith('demo')
    await rightClick(local('old'))
    expect(menuItems()).toEqual(['从列表移除…'])
    ;(window.tangu as any).platform = 'win32'
    await rightClick(local('lab'))
    expect(menuItems()).toContain('在资源管理器中显示')
    ;(window.tangu as any).platform = 'linux'
    await rightClick(local('lab'))
    expect(menuItems()).toContain('在文件管理器中显示')
  })

  it('add to desktop hands over the icon and a fallback name; a development build says shortcuts need the installed app', async () => {
    await mount()
    await rightClick(local('demo'))
    await click(q('[data-unit-act="desktop"]'))
    await tick()
    // happy-dom 画不了 canvas → 没有 iconPng,兜底名照给(真 Chromium 里有 PNG:check:unitpanel U16)
    expect(api.addToDesktop).toHaveBeenCalledWith('demo', { fallbackName: 'Forsion 本机 Unit' })
    expect(onToast.mock.lastCall?.[0]).toContain('已添加到桌面')
    expect(onToast.mock.lastCall?.[1]).toBeFalsy()
    api.addToDesktop.mockResolvedValueOnce({ ok: false, code: 'io', message: 'unpackaged' })
    await rightClick(local('demo'))
    await click(q('[data-unit-act="desktop"]'))
    await tick()
    expect(onToast).toHaveBeenLastCalledWith('桌面快捷方式只在安装版里可用（开发模式下不生成）', true)
  })

  it('remove asks first and says the folder stays; confirming calls remove(id)', async () => {
    await mount()
    await rightClick(local('demo'))
    await click(q('[data-unit-act="remove"]'))
    const dlg = q('.dialog')!
    expect(text(dlg)).toContain('从列表移除「demo」？')
    expect(text(dlg)).toContain('只是从列表里拿掉，文件夹和里面的数据都还在。')
    expect(api.remove).not.toHaveBeenCalled()
    await click(Array.from(dlg.querySelectorAll('button')).find((b) => text(b) === '移除')!)
    expect(api.remove).toHaveBeenCalledWith('demo')
    expect(onToast).toHaveBeenLastCalledWith('已从列表移除「demo」')
  })

  it('remove refused because the Unit is open: the main process sentence is shown as is, not a generic failure', async () => {
    const said = '这个 Unit 正开着（或者看不出它关没关）。先关掉它，再从列表移除。'
    api.remove.mockResolvedValueOnce({ ok: false, code: 'io', message: said })
    await mount()
    await rightClick(local('lab'))
    await click(q('[data-unit-act="remove"]'))
    await click(Array.from(q('.dialog')!.querySelectorAll('button')).find((b) => text(b) === '移除')!)
    expect(api.remove).toHaveBeenCalledWith('lab')
    expect(onToast).toHaveBeenLastCalledWith(`没能从列表移除「lab」：${said}`, true)
    // 没带说明的 io 照旧按码说
    api.remove.mockResolvedValueOnce({ ok: false, code: 'io' })
    await rightClick(local('demo'))
    await click(q('[data-unit-act="remove"]'))
    await click(Array.from(q('.dialog')!.querySelectorAll('button')).find((b) => text(b) === '移除')!)
    expect(onToast).toHaveBeenLastCalledWith('没能从列表移除「demo」：读写文件时出了问题，稍后再试。', true)
  })

  it('raw main-process errors (EACCES and paths) never reach the user: rename / open / create say the plain line for the code', async () => {
    const raw = "EACCES: permission denied, open '/Users/x/Forsion Units/demo/.forsion-unit.json'"
    await mount()
    api.rename.mockResolvedValueOnce({ ok: false, code: 'io', message: raw })
    await rightClick(local('demo'))
    await click(q('[data-unit-act="edit"]'))
    await typeInto(q<HTMLInputElement>('[data-lu="name"]')!, 'Demo 2')
    await click(q('[data-lu="save"]'))
    expect(onToast).toHaveBeenLastCalledWith('没做成：读写文件时出了问题，稍后再试。', true)
    api.open.mockResolvedValueOnce({ ok: false, code: 'not_a_unit', message: 'marker id does not match' })
    await click(local('lab'))
    expect(onToast.mock.lastCall?.[0]).not.toContain('marker')
    api.create.mockResolvedValueOnce({ ok: false, code: 'io', message: raw })
    await click(q('[data-local-add]'))
    await typeInto(q<HTMLInputElement>('[data-lu="name"]')!, 'Lab 2')
    await click(q('[data-lu="create"]'))
    expect(text(q('[data-lu-dialog="add"]'))).not.toContain('EACCES')
    expect(text(q('[data-lu-dialog="add"]'))).toContain('读写文件时出了问题')
  })

  it('an open menu follows the latest list: renamed rows act on the new name; a row that goes missing, disappears or a list that turns unreadable closes it', async () => {
    const { act } = await React()
    const emit = async () => { await act(async () => { changed?.() }); await tick() }
    await mount()
    // 改了名:菜单还开着,移除时用的是新名字
    await rightClick(local('demo'))
    rows[1].name = 'Demo 2'
    await emit()
    expect(menuItems()).toHaveLength(5)
    await click(q('[data-unit-act="remove"]'))
    expect(text(q('.dialog'))).toContain('从列表移除「Demo 2」？')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await tick()
    // 变得找不到了 → 收起(不再给「在自己的窗口打开 / 改名字」)
    await rightClick(local('demo'))
    expect(q('.ap-unit-ctx')).toBeTruthy()
    rows[1].state = 'missing'
    await emit()
    expect(q('.ap-unit-ctx')).toBeNull()
    // 那一行没了 → 收起
    await rightClick(local('lab'))
    rows = rows.filter((r) => r.id !== 'lab')
    await emit()
    expect(q('.ap-unit-ctx')).toBeNull()
    // 名册读不出 → 收起
    await rightClick(local('old'))
    expect(menuItems()).toEqual(['从列表移除…'])
    registry = 'unreadable'
    await emit()
    expect(q('.ap-unit-ctx')).toBeNull()
  })

  it('missing / mismatch rows are reachable by keyboard: Enter, Shift+F10 or the menu key opens a menu with only remove', async () => {
    const { act } = await React()
    const key = async (el: Element | null, init: KeyboardEventInit) => {
      expect(el).toBeTruthy()
      await act(async () => { el!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
      await tick()
    }
    await mount()
    for (const id of ['old', 'copy']) {
      expect(local(id).tabIndex).toBe(0)
      expect(local(id).getAttribute('aria-haspopup')).toBe('menu')
    }
    local('old').focus()
    await key(local('old'), { key: 'Enter' })
    expect(menuItems()).toEqual(['从列表移除…'])
    expect(document.activeElement).toBe(q('[data-unit-act="remove"]')) // 焦点进菜单
    await key(document.activeElement, { key: 'Escape' })
    expect(q('.ap-unit-ctx')).toBeNull()
    expect(document.activeElement).toBe(local('old')) // Esc 回到那一行
    await key(local('copy'), { key: 'F10', shiftKey: true })
    expect(menuItems()).toEqual(['从列表移除…'])
    await key(document.activeElement, { key: 'Escape' })
    await key(local('copy'), { key: 'ContextMenu' })
    expect(menuItems()).toEqual(['从列表移除…'])
    await key(document.activeElement, { key: 'Escape' })
    // 能用的行:Enter 是打开(按钮本身的事),Shift+F10 开整份菜单,上下键在几项之间走
    await key(local('demo'), { key: 'F10', shiftKey: true })
    expect(menuItems()).toHaveLength(5)
    expect(document.activeElement).toBe(q('[data-unit-act="open"]'))
    await key(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(q('[data-unit-act="remove"]'))
    await key(document.activeElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(q('[data-unit-act="open"]'))
  })

  it('inside a folder Unit whose own row reads missing: still checked, but inert, and no menu (nothing it could do)', async () => {
    self = { kind: 'folder', id: 'lab', name: 'lab', icon: '', path: '/Users/x/Forsion Units/lab', displayPath: '~/Forsion Units/lab' }
    rows[0] = { ...mk('lab', 'missing'), current: true }
    await mount()
    const me = local('lab')
    expect(me.tagName).toBe('DIV')
    expect(me.getAttribute('aria-disabled')).toBe('true')
    expect(me.querySelector('.ap-unit-check')).toBeTruthy()
    expect(me.hasAttribute('tabindex')).toBe(false)
    await rightClick(me)
    expect(q('.ap-unit-ctx')).toBeNull()
  })

  it('registry unreadable: one grey line, no rows, no write menus — "Add Unit…" stays', async () => {
    registry = 'unreadable'
    await mount()
    expect(text(q('[data-local-unreadable]'))).toBe('读不出本机 Unit 列表')
    expect(document.querySelectorAll('[data-local-unit]').length).toBe(0)
    expect(q('[data-local-add]')).toBeTruthy()
  })

  it('a list() that throws is "unreadable", never an empty list', async () => {
    listFails = true
    await mount()
    expect(q('[data-local-unreadable]')).toBeTruthy()
    const { useLocalUnits } = await import('./localUnits')
    expect(useLocalUnits.getState()).toMatchObject({ failed: true, snapshot: null })
    // 主进程那边好了、广播一次变化 → 重新读
    listFails = false
    const { act } = await React()
    await act(async () => { changed?.() })
    await tick()
    expect(document.querySelectorAll('[data-local-unit]').length).toBe(4)
  })

  it('inside a folder Unit: its row is checked and cannot be removed; "This computer" opens the default Unit', async () => {
    self = { kind: 'folder', id: 'lab', name: 'lab', icon: '', path: '/Users/x/Forsion Units/lab', displayPath: '~/Forsion Units/lab' }
    rows[0].current = true
    await mount()
    const def = q('[data-unit-local]')!
    expect(def.getAttribute('aria-current')).toBeNull()
    expect(def.querySelector('.ap-unit-go')).toBeTruthy()
    expect(local('lab').getAttribute('aria-current')).toBe('true')
    await rightClick(local('lab'))
    expect(menuItems()).toEqual(['添加到桌面', '改名字和图标…', '在访达中显示'])
    await click(def)
    expect(api.open).toHaveBeenCalledWith('default')
  })

  it('Add Unit: name → location under the default parent; Change… picks another; Create and open = create, then open', async () => {
    await mount()
    await click(q('[data-local-add]'))
    const name = q<HTMLInputElement>('[data-lu="name"]')!
    expect(q<HTMLButtonElement>('[data-lu="create"]')!.disabled).toBe(true) // 没名字不能建
    await typeInto(name, '实验/用')
    expect(q<HTMLInputElement>('[data-lu="location"]')!.value).toBe('~/Forsion Units/实验 用')
    expect(text(q('.lu-hint'))).toBe('这个文件夹会装下这台 Unit 的登录、设置、Agent、插件、对话和笔记。')
    await click(q('[data-lu="change"]'))
    expect(q<HTMLInputElement>('[data-lu="location"]')!.value).toBe('~/Desktop/实验 用')
    await click(q('[data-lu="create"]'))
    expect(api.create).toHaveBeenCalledWith({ name: '实验/用', icon: '', parentDir: '/Users/x/Desktop' })
    expect(api.open).toHaveBeenCalledWith('new-1')
    expect(q('[data-lu-dialog]')).toBeNull()
  })

  it('Add Unit: a typed name that cannot be a folder says so right away and keeps the button off', async () => {
    await mount()
    await click(q('[data-local-add]'))
    await typeInto(q<HTMLInputElement>('[data-lu="name"]')!, '///')
    expect(q<HTMLButtonElement>('[data-lu="create"]')!.disabled).toBe(true)
    expect(text(q('.lu-err'))).toBe('这个名字用不了：不能留空、不能太长，也不能只有符号。')
    expect(api.create).not.toHaveBeenCalled()
  })

  it('Esc inside the icon picker closes only the picker and puts focus back on the icon button; a second Esc closes the dialog', async () => {
    const { act } = await React()
    const esc = async (el: Element | null) => {
      expect(el).toBeTruthy()
      await act(async () => { el!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      await tick()
    }
    await mount()
    await click(q('[data-local-add]'))
    await click(q('[data-lu="icon"]'))
    const emoji = q('.amx-iconpick-item')!
    emoji.focus()
    await esc(emoji) // 焦点在某个 emoji 上(不在选择器的搜索框里)
    expect(q('[data-lu-iconpick]')).toBeNull()
    expect(q('[data-lu-dialog="add"]')).toBeTruthy()
    expect(document.activeElement).toBe(q('[data-lu="icon"]'))
    await esc(document.activeElement)
    expect(q('[data-lu-dialog]')).toBeNull()
    // 选择器的搜索框里按 Esc 也一样只收选择器
    await click(q('[data-local-add]'))
    await click(q('[data-lu="icon"]'))
    await esc(q('[data-lu-iconpick] input'))
    expect(q('[data-lu-iconpick]')).toBeNull()
    expect(q('[data-lu-dialog="add"]')).toBeTruthy()
  })

  it('Name and icon…: only the changed field goes to rename(); an unchanged save makes no call', async () => {
    await mount()
    const openEdit = async () => {
      await rightClick(local('demo'))
      await click(q('[data-unit-act="edit"]'))
      expect(q('[data-lu-dialog="edit"]')).toBeTruthy()
    }
    await openEdit()
    expect(q<HTMLInputElement>('[data-lu="name"]')!.value).toBe('demo')
    await click(q('[data-lu="save"]')) // 没改:不调,关掉
    expect(api.rename).not.toHaveBeenCalled()
    expect(q('[data-lu-dialog]')).toBeNull()
    await openEdit()
    await typeInto(q<HTMLInputElement>('[data-lu="name"]')!, 'Demo 2')
    await click(q('[data-lu="save"]'))
    expect(api.rename).toHaveBeenLastCalledWith('demo', { name: 'Demo 2' })
    expect(q('[data-lu-dialog]')).toBeNull()
    await openEdit()
    await click(q('[data-lu="icon"]'))
    const em = q('.amx-iconpick-item')!
    const picked = text(em)
    await click(em)
    expect(text(q('[data-lu="icon"]'))).toBe(picked)
    await click(q('[data-lu="save"]'))
    expect(api.rename).toHaveBeenLastCalledWith('demo', { icon: picked })
  })

  it('Add Unit: path_exists lands under the location, and the dialog stays', async () => {
    await mount()
    await click(q('[data-local-add]'))
    api.create.mockResolvedValueOnce({ ok: false, code: 'path_exists' })
    await typeInto(q<HTMLInputElement>('[data-lu="name"]')!, 'lab')
    await click(q('[data-lu="create"]'))
    expect(text(q('.lu-err'))).toBe('那里已经有同名的文件夹了，换个名字或位置。')
    expect(api.open).not.toHaveBeenCalled()
    expect(q('[data-lu-dialog="add"]')).toBeTruthy()
  })

  it('Open an existing folder: duplicate_id is explained in plain words; cancelled says nothing', async () => {
    await mount()
    await click(q('[data-local-add]'))
    await click(q('[data-lu-mode="existing"]'))
    await click(q('[data-lu="choose"]'))
    expect(api.addExisting).toHaveBeenCalled()
    expect(text(q('[data-lu="error"]'))).toBe('这个文件夹像是从另一个 Unit 拷贝出来的，两份会互相顶掉登录，暂时不能加入。')
    api.addExisting.mockResolvedValueOnce({ ok: false, code: 'cancelled' })
    await click(q('[data-lu="choose"]'))
    expect(q('[data-lu="error"]')).toBeNull()
    expect(q('[data-lu-dialog="add"]')).toBeTruthy()
  })

  it('every error code has its own plain-words line; cancelled is silent; unknown codes read as io', async () => {
    const { localUnitErrorText } = await import('./localUnits')
    const codes = ['name_invalid', 'path_exists', 'parent_invalid', 'not_a_unit', 'channel_mismatch', 'duplicate_id', 'registry_unreadable', 'not_found', 'is_self', 'io'] as const
    const lines = codes.map((c) => localUnitErrorText(c))
    expect(lines.every((l) => typeof l === 'string' && l.length > 6)).toBe(true)
    expect(new Set(lines).size).toBe(codes.length)
    expect(localUnitErrorText('cancelled')).toBeNull()
    expect(localUnitErrorText('something_new')).toBe(localUnitErrorText('io'))
  })

  it('an IPC that throws (main process not wired) folds into io instead of crashing', async () => {
    const { localUnitCall } = await import('./localUnits')
    api.open.mockRejectedValueOnce(new Error("No handler registered for 'localUnits:open'"))
    expect(await localUnitCall((a) => a.open('lab'))).toEqual({ ok: false, code: 'io' })
    api.open.mockResolvedValueOnce(undefined as any)
    expect(await localUnitCall((a) => a.open('lab'))).toEqual({ ok: false, code: 'io' })
  })
})
