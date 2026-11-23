import { describe, it, expect, vi } from 'vitest'

vi.mock('./http', () => ({ authFetch: vi.fn() }))

import { speakableText } from './ttsService'

describe('speakableText', () => {
  it('drops fenced code blocks entirely, keeps inline code text', () => {
    const md = '看这段:\n```ts\nconst x = 1\n```\n用 `npm run dev` 启动。'
    const out = speakableText(md)
    expect(out).not.toContain('const x')
    expect(out).toContain('npm run dev')
  })

  it('keeps link/image text without URLs and strips markdown marks', () => {
    const out = speakableText('# 标题\n> 引用 **加粗** [文档](https://a.b/c) ![图](x.png)\n- 列表项')
    expect(out).not.toContain('https://a.b/c')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).toContain('文档')
    expect(out).toContain('列表项')
  })

  it('caps at 4000 chars', () => {
    expect(speakableText('啊'.repeat(5000)).length).toBe(4000)
  })
})

describe('speakKey:任意 key、一个播放器、念完才兑现', () => {
  it('新的顶掉旧的(旧的兑现);stop(key) 只停那一段;放完回静止', async () => {
    vi.resetModules()
    const synth = vi.fn(async (_t: unknown, _b: unknown, signal?: AbortSignal) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Blob(['x'])
    })
    vi.doMock('./backendService', () => ({ synthesizeTts: synth }))
    const audios: Array<{ onended: (() => void) | null; play: () => Promise<void> }> = []
    class FakeAudio { src = ''; onended: (() => void) | null = null; onerror: (() => void) | null = null; play = async () => {}; pause() {}; removeAttribute() {} ; constructor() { audios.push(this) } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    const svc = await import('./ttsService')
    const stored = { ttsModelId: 'm' } as never
    const seen: Array<string | null> = []
    svc.subscribeTts((s) => seen.push(s ? `${s.key}:${s.phase}` : null))
    const a = svc.speakKey({} as never, stored, 'sel:a', 'hello')
    await vi.waitFor(() => expect(svc.ttsState()?.phase).toBe('playing'))
    expect(svc.ttsState()?.key).toBe('sel:a')
    expect(svc.ttsState()?.msgId).toBe('sel:a') // 旧名照旧能读
    const b = svc.speakKey({} as never, stored, 'plugin:p:1', 'world')
    await expect(a).resolves.toBeUndefined() // 被顶掉 = 兑现
    await vi.waitFor(() => expect(svc.ttsState()?.key).toBe('plugin:p:1'))
    svc.stopSpeaking('sel:a') // 不是它在念:不动
    expect(svc.ttsState()?.key).toBe('plugin:p:1')
    audios[0].onended?.() // 放完
    await expect(b).resolves.toBeUndefined()
    expect(svc.ttsState()).toBeNull()
    expect(seen).toContain('sel:a:loading')
    await expect(svc.speakKey({} as never, { ttsModelId: '' } as never, 'k', 'x')).rejects.toThrow('tts_no_model')
    vi.unstubAllGlobals()
  })
})

describe('speakKey:现读配置时先登记', () => {
  it('A 还在读配置时 B 开念:A 读完作废,不回头掐掉 B;读配置期间 stop(A) 看得见它', async () => {
    vi.resetModules()
    vi.doMock('./backendService', () => ({ synthesizeTts: vi.fn(async () => new Blob(['x'])) }))
    class FakeAudio { src = ''; onended: (() => void) | null = null; onerror: (() => void) | null = null; play = async () => {}; pause() {}; removeAttribute() {} }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    const svc = await import('./ttsService')
    let release!: (v: unknown) => void
    const slowCfg = () => new Promise((r) => { release = r }) as never
    const a = svc.speakKey({} as never, slowCfg, 'sel:a', 'hello')
    expect(svc.ttsState()).toMatchObject({ key: 'sel:a', phase: 'loading' }) // 按下即登记
    const b = svc.speakKey({} as never, { ttsModelId: 'm' } as never, 'msg-b', 'world')
    await vi.waitFor(() => expect(svc.ttsState()).toMatchObject({ key: 'msg-b', phase: 'playing' }))
    release({ ttsModelId: 'm' })
    await expect(a).resolves.toBeUndefined()
    expect(svc.ttsState()?.key).toBe('msg-b') // A 迟到的配置没把 B 掐掉
    svc.stopSpeaking()
    await b
    const c = svc.speakKey({} as never, slowCfg, 'plugin:p:g:1', 'x')
    svc.stopSpeaking('plugin:p:g:1') // 还在读配置:照样停得掉
    expect(svc.ttsState()).toBeNull()
    release({ ttsModelId: 'm' })
    await expect(c).resolves.toBeUndefined()
    const d = svc.speakKey({} as never, slowCfg, 'k', 'x')
    release({ ttsModelId: '' })
    await expect(d).rejects.toThrow('tts_no_model')
    expect(svc.ttsState()).toBeNull()
    vi.unstubAllGlobals()
  })
})
