import { describe, it, expect } from 'vitest'
import { clampLiveViewOptions, helperSocketPath, normalizeLiveView } from './computerUse'

describe('clampLiveViewOptions', () => {
  it('⚠️activeWithinMs 有硬上界:放开=把一次结束的操控变成对那个窗口的长期取景权', () => {
    expect(clampLiveViewOptions({ activeWithinMs: Number.MAX_SAFE_INTEGER }).activeWithinMs).toBe(120_000)
    expect(clampLiveViewOptions({ activeWithinMs: 1e18 }).activeWithinMs).toBe(120_000)
    expect(clampLiveViewOptions({ activeWithinMs: 0 }).activeWithinMs).toBe(1_000)
    expect(clampLiveViewOptions({ activeWithinMs: 30_000 }).activeWithinMs).toBe(30_000)
  })

  it('非数字/缺省一律落回默认,不把 NaN 送进 helper', () => {
    const o = clampLiveViewOptions({ maxDimension: NaN, quality: 'high' as unknown as number })
    expect(o.maxDimension).toBe(1280)
    expect(o.quality).toBe(0.6)
    expect(o.activeWithinMs).toBe(120_000)
    expect(o.image).toBe(true)
  })

  it('尺寸与画质夹在可用区间内', () => {
    expect(clampLiveViewOptions({ maxDimension: 10 }).maxDimension).toBe(160)
    expect(clampLiveViewOptions({ maxDimension: 99_999 }).maxDimension).toBe(2560)
    expect(clampLiveViewOptions({ quality: 5 }).quality).toBe(0.95)
    expect(clampLiveViewOptions({ quality: -1 }).quality).toBe(0.2)
  })

  it('image 只有显式 false 才关(未传=要图)', () => {
    expect(clampLiveViewOptions({}).image).toBe(true)
    expect(clampLiveViewOptions({ image: false }).image).toBe(false)
  })
})

describe('helperSocketPath', () => {
  it('与 vendor 同源:env 覆盖优先', () => {
    expect(helperSocketPath({ PI_CU_SOCKET_PATH: '/tmp/x.sock' }, '/Users/a')).toBe('/tmp/x.sock')
  })

  it('默认落在 helper 自己建的 Caches 目录(品牌名必须是 tangu-,否则连错 socket)', () => {
    expect(helperSocketPath({}, '/Users/a')).toBe('/Users/a/Library/Caches/tangu-computer-use/bridge.sock')
  })
})

describe('normalizeLiveView', () => {
  it('active 非 true 一律当成没在操控', () => {
    expect(normalizeLiveView({ active: false, jpegBase64: 'xx' })).toEqual({ active: false })
    expect(normalizeLiveView(undefined)).toEqual({ active: false })
    expect(normalizeLiveView({ active: 'yes', jpegBase64: 'xx' })).toEqual({ active: false })
  })

  it('只挑白名单字段,类型不对就丢掉(不把 helper 的结构透传进 UI)', () => {
    const frame = normalizeLiveView({
      active: true,
      windowId: 42,
      pid: 7,
      app: 'TextEdit',
      title: '',
      width: '800',
      height: 600,
      jpegBase64: 'abc',
      ageMs: 120,
      evil: 'drop me',
    })
    expect(frame).toEqual({
      active: true,
      windowId: 42,
      pid: 7,
      app: 'TextEdit',
      bundleId: undefined,
      title: undefined, // 空串按缺失处理
      width: undefined, // 字符串不是数字,丢掉
      height: 600,
      jpegBase64: 'abc',
      ageMs: 120,
      error: undefined,
    })
    expect('evil' in frame).toBe(false)
  })

  it('有 error 无画面时仍是 active —— "在操控但拿不到图"和"没在操控"是两回事', () => {
    const frame = normalizeLiveView({ active: true, windowId: 1, error: 'screen_recording_denied' })
    expect(frame.active).toBe(true)
    expect(frame.jpegBase64).toBeUndefined()
    expect(frame.error).toBe('screen_recording_denied')
  })
})
