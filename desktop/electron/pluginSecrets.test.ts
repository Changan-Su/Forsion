import { describe, expect, it } from 'vitest'
import { createPluginSecrets, SECRET_MAX_KEYS, type PluginSecretsDeps } from './pluginSecrets'

/** 内存文件 + 可控加密后端。encrypt 用可逆的「加前缀」,判得出是不是密文。 */
function env(opts: { available?: boolean; platform?: NodeJS.Platform; backend?: string; initial?: string | null; readThrows?: boolean; decryptThrows?: boolean } = {}) {
  const files = new Map<string, string>()
  if (opts.initial != null) files.set('/u/plugin-secrets.json', opts.initial)
  const writes: unknown[] = []
  const deps: PluginSecretsDeps = {
    file: '/u/plugin-secrets.json',
    platform: opts.platform ?? 'darwin',
    crypto: {
      available: () => opts.available ?? true,
      backend: () => opts.backend ?? 'keychain',
      encrypt: (s) => Buffer.from(`ENC:${s}`),
      decrypt: (b) => { if (opts.decryptThrows) throw new Error('nope'); const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return t.slice(4) },
    },
    read: async (f) => { if (opts.readThrows) throw new Error('EACCES'); return files.get(f) ?? null },
    write: async (f, data) => { writes.push(data); files.set(f, JSON.stringify(data)) },
    now: () => 1000,
  }
  return { s: createPluginSecrets(deps), files, writes }
}

describe('pluginSecrets', () => {
  it('round-trips a value, stored only as ciphertext', async () => {
    const { s, files } = env()
    expect(await s.set('translation', 'svc.deepl', '{"key":"abc:fx"}')).toEqual({ ok: true, value: null })
    const raw = files.get('/u/plugin-secrets.json')!
    expect(raw).not.toContain('abc:fx')
    expect(await s.get('translation', 'svc.deepl')).toEqual({ ok: true, value: '{"key":"abc:fx"}' })
    expect(await s.has('translation', 'svc.deepl')).toEqual({ ok: true, value: true })
    expect(await s.keys('translation')).toEqual({ ok: true, value: ['svc.deepl'] })
  })

  it('keeps plugins apart', async () => {
    const { s } = env()
    await s.set('a', 'k', 'one')
    await s.set('b', 'k', 'two')
    expect(await s.get('a', 'k')).toEqual({ ok: true, value: 'one' })
    expect(await s.get('b', 'k')).toEqual({ ok: true, value: 'two' })
    expect(await s.get('c', 'k')).toEqual({ ok: true, value: null })
  })

  it('never stores plaintext when the OS has no encryption', async () => {
    for (const env1 of [env({ available: false }), env({ platform: 'linux', backend: 'basic_text' }), env({ platform: 'win32', available: false })]) {
      const r = await env1.s.set('translation', 'k', 'secret')
      expect(r).toMatchObject({ ok: false, code: 'secrets_unavailable' })
      expect(env1.writes).toHaveLength(0)
    }
  })

  it('a stored entry that cannot be decrypted is locked, not absent', async () => {
    const e = env()
    await e.s.set('translation', 'k', 'v')
    const locked = createPluginSecrets({ file: '/u/plugin-secrets.json', platform: 'darwin', crypto: { available: () => true, backend: () => 'keychain', encrypt: (x) => Buffer.from(x), decrypt: () => { throw new Error('locked') } }, read: async () => e.files.get('/u/plugin-secrets.json') ?? null, write: async () => { throw new Error('should not write') } })
    expect(await locked.get('translation', 'k')).toMatchObject({ ok: false, code: 'secrets_locked' })
    expect(await locked.has('translation', 'k')).toEqual({ ok: true, value: true })
  })

  it('an unreadable file refuses reads and writes instead of overwriting', async () => {
    for (const e of [env({ initial: '{not json' }), env({ initial: '{"v":2,"plugins":{}}' }), env({ readThrows: true }),
      env({ initial: '{"v":1,"plugins":{"translation":{"k":null}}}' }), env({ initial: '{"v":1,"plugins":{"translation":[]}}' }), env({ initial: '{"v":1,"plugins":{"x":{"k":{"data":7}}}}' })]) {
      expect(await e.s.get('translation', 'k')).toMatchObject({ ok: false, code: 'secrets_failed' })
      expect(await e.s.set('translation', 'k', 'v')).toMatchObject({ ok: false, code: 'secrets_failed' })
      expect(await e.s.delete('translation', 'k')).toMatchObject({ ok: false, code: 'secrets_failed' })
      expect(await e.s.removePlugin('translation')).toBe(false)
      expect(e.writes).toHaveLength(0)
    }
  })

  it('validates keys, ids and sizes', async () => {
    const { s } = env()
    for (const k of ['', 'Upper', '_x', '__proto__', 'a/b', 'x'.repeat(65)]) expect(await s.set('translation', k, 'v')).toMatchObject({ ok: false, code: 'secrets_bad_key' })
    for (const id of ['', '../x', 'a b', 7]) expect(await s.set(id, 'k', 'v')).toMatchObject({ ok: false, code: 'secrets_bad_key' })
    expect(await s.set('translation', 'k', 'x'.repeat(8193))).toMatchObject({ ok: false, code: 'secrets_too_large' })
    expect(await s.set('translation', 'k', 7)).toMatchObject({ ok: false, code: 'secrets_bad_key' })
    for (let i = 0; i < SECRET_MAX_KEYS; i++) expect((await s.set('translation', `k${i}`, 'v')).ok).toBe(true)
    expect(await s.set('translation', 'one-more', 'v')).toMatchObject({ ok: false, code: 'secrets_too_many' })
    expect((await s.set('translation', 'k0', 'replace')).ok).toBe(true) // 覆盖已有的不算超额
  })

  it('delete and removePlugin drop only what they should', async () => {
    const { s } = env()
    await s.set('a', 'k1', '1'); await s.set('a', 'k2', '2'); await s.set('b', 'k1', '3')
    await s.delete('a', 'k1')
    expect(await s.keys('a')).toEqual({ ok: true, value: ['k2'] })
    expect(await s.removePlugin('a')).toBe(true)
    expect(await s.keys('a')).toEqual({ ok: true, value: [] })
    expect(await s.get('b', 'k1')).toEqual({ ok: true, value: '3' })
  })

  it('serialises concurrent writes', async () => {
    const { s } = env()
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.set('a', `k${i}`, String(i))))
    expect((await s.keys('a') as { value: string[] }).value).toHaveLength(10)
  })
})
