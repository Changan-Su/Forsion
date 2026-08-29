/**
 * 前台窗口接缝的可跑检查(负对照:改坏解析器/闸门,下面必红)。
 * fixture 全是真实命令的真实输出(lsappinfo 本机实测;xprop / PowerShell 取自各自文档格式)。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  parseLsappinfo, parseXpropActiveId, parseXpropWindow, parseWindowsJson,
  createSampler, MIN_SAMPLE_INTERVAL_MS, type RawWindow,
} from './activeWindow'

describe('parseLsappinfo', () => {
  it('取出 app / bundleId / pid', () => {
    expect(parseLsappinfo('"LSDisplayName"="Claude"\n"CFBundleIdentifier"="com.anthropic.claudefordesktop"\n"pid"=16810\n'))
      .toEqual({ app: 'Claude', bundleId: 'com.anthropic.claudefordesktop', pid: 16810, title: '' })
  })
  it('带空格的 app 名不被截断', () => {
    expect(parseLsappinfo('"LSDisplayName"="Google Chrome"\n"pid"=1\n')?.app).toBe('Google Chrome')
  })
  it('没有 LSDisplayName → null(不返回半条记录)', () => {
    expect(parseLsappinfo('"pid"=123\n')).toBeNull()
  })
})

describe('parseXpropActiveId', () => {
  it('取窗口 id', () => {
    expect(parseXpropActiveId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3800007\n')).toBe('0x3800007')
  })
  it('0x0 = 无活动窗口 → null', () => {
    expect(parseXpropActiveId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n')).toBeNull()
  })
  it('Wayland 下 xprop 无此属性 → null', () => {
    expect(parseXpropActiveId('_NET_ACTIVE_WINDOW:  not found.\n')).toBeNull()
  })
})

describe('parseXpropWindow', () => {
  it('WM_CLASS 取第二个(类名),_NET_WM_NAME 作标题', () => {
    expect(parseXpropWindow('WM_CLASS = "google-chrome", "Google-chrome"\n_NET_WM_NAME = "某网页 - Google Chrome"\n'))
      .toEqual({ app: 'Google-chrome', title: '某网页 - Google Chrome' })
  })
  it('只有一个 WM_CLASS 值时回落到它', () => {
    expect(parseXpropWindow('WM_CLASS = "Alacritty"\n')?.app).toBe('Alacritty')
  })
  it('没有 WM_CLASS → null', () => {
    expect(parseXpropWindow('_NET_WM_NAME = "孤零零的标题"\n')).toBeNull()
  })
})

describe('parseWindowsJson', () => {
  it('解析 PowerShell 探针输出', () => {
    expect(parseWindowsJson('{"app":"chrome","title":"某网页","pid":4242}'))
      .toEqual({ app: 'chrome', title: '某网页', pid: 4242 })
  })
  it('空 app(拿不到前台进程)→ null', () => {
    expect(parseWindowsJson('{"app":"","title":"","pid":0}')).toBeNull()
  })
  it('不是 JSON(PowerShell 报错文本)→ null,不抛', () => {
    expect(parseWindowsJson('Add-Type : 无法加载类型')).toBeNull()
  })
})

describe('createSampler', () => {
  const raw: RawWindow = { app: 'Claude', title: '', pid: 1 }
  const mk = (o: Partial<{ enabled: boolean; probe: () => Promise<RawWindow | null>; idle: number }> = {}) => {
    let clock = 100_000
    const probe = vi.fn(o.probe ?? (async () => raw))
    let idle = o.idle ?? 0
    const sample = createSampler({
      isEnabled: () => o.enabled !== false,
      probe,
      idleSeconds: () => idle,
      now: () => clock,
      platform: 'darwin',
    })
    return { sample, probe, tick: (ms: number) => { clock += ms }, setIdle: (n: number) => { idle = n } }
  }

  it('关着(默认拒)→ 恒 null,且**根本不探**', async () => {
    const { sample, probe } = mk({ enabled: false })
    expect(await sample()).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('开着 → 回样本,带 idle 与 platform', async () => {
    const { sample } = mk({ idle: 7 })
    expect(await sample()).toEqual({ app: 'Claude', title: '', pid: 1, idleSeconds: 7, platform: 'darwin' })
  })

  it('缓存下限内不重复起子进程', async () => {
    const { sample, probe, tick } = mk()
    await sample()
    tick(MIN_SAMPLE_INTERVAL_MS - 1)
    await sample()
    expect(probe).toHaveBeenCalledTimes(1)
    tick(2)
    await sample()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('缓存命中仍刷 idle —— 否则挂机时长会全记到最后那个 app 头上', async () => {
    const { sample, tick, setIdle } = mk({ idle: 0 })
    expect((await sample())?.idleSeconds).toBe(0)
    setIdle(600)
    tick(10)
    expect((await sample())?.idleSeconds).toBe(600)
  })

  it('并发调用只探一次', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { sample, probe } = mk({ probe: async () => { await gate; return raw } })
    const both = Promise.all([sample(), sample()])
    release()
    expect(await both).toEqual([expect.objectContaining({ app: 'Claude' }), expect.objectContaining({ app: 'Claude' })])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('探针抛错 → null 且不外抛(缺 xprop / Wayland / 命令被删)', async () => {
    const { sample } = mk({ probe: async () => { throw new Error('ENOENT xprop') } })
    await expect(sample()).resolves.toBeNull()
  })
})
