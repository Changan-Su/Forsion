/** P1 · K2 D13:解锁的系统认证决策表(Touch ID → 管理员密码框 → 挂父窗确认框)。关键:密码连错(-60005)绝不退到确认框。 */
import { describe, it, expect } from 'vitest'
import { appleScriptString, createSystemAuth, type SystemAuthDeps } from './remoteSafetyAuth'

function deps(o: Partial<SystemAuthDeps> & { osa?: Awaited<ReturnType<SystemAuthDeps['osascript']>>; dialog?: boolean | null } = {}) {
  const calls: string[] = []
  const d: SystemAuthDeps = {
    platform: 'darwin',
    touchId: undefined,
    isAdmin: async () => true,
    osascript: async (script) => { calls.push(`osa:${script}`); return o.osa ?? { ok: true } },
    confirm: async () => { calls.push('dialog'); return 'dialog' in o ? (o.dialog as boolean | null) : true },
    passwordPrompt: () => 'Unlock "remote" access\\?',
    log: () => {},
    ...o,
  }
  return { auth: createSystemAuth(d), calls }
}

describe('createSystemAuth', () => {
  it('非 darwin → 确认框(解锁 = ok,取消 / 弹不出 = cancelled)', async () => {
    expect(await deps({ platform: 'win32' }).auth('r')).toBe('ok')
    expect(await deps({ platform: 'linux', dialog: false }).auth('r')).toBe('cancelled')
    expect(await deps({ platform: 'win32', dialog: null }).auth('r')).toBe('cancelled')
  })

  it('Touch ID:成功 ok;取消 cancelled;其它失败退到密码框', async () => {
    expect(await deps({ touchId: { can: () => true, prompt: async () => {} } }).auth('r')).toBe('ok')
    expect(await deps({ touchId: { can: () => true, prompt: async () => { throw new Error('User cancelled') } } }).auth('r')).toBe('cancelled')
    const d = deps({ touchId: { can: () => true, prompt: async () => { throw new Error('Biometry is locked out') } } })
    expect(await d.auth('r')).toBe('ok')
    expect(d.calls[0]).toMatch(/^osa:do shell script "true" with prompt .* with administrator privileges$/)
  })

  it('管理员密码框:-128 = cancelled;-60005(密码连错)= failed 且不弹确认框;起不来 = 退到确认框;其它 = failed', async () => {
    expect(await deps({ osa: { ok: false, stderr: 'execution error: User canceled. (-128)' } }).auth('r')).toBe('cancelled')
    const wrong = deps({ osa: { ok: false, stderr: 'execution error: The administrator user name or password was incorrect. (-60005)' } })
    expect(await wrong.auth('r')).toBe('failed')
    expect(wrong.calls).not.toContain('dialog')
    const missing = deps({ osa: { ok: false, spawnError: true, stderr: 'ENOENT' } })
    expect(await missing.auth('r')).toBe('ok')
    expect(missing.calls).toContain('dialog')
    expect(await deps({ osa: { ok: false, stderr: 'something else (-1743)' } }).auth('r')).toBe('failed')
  })

  it('非管理员账号 → 确认框(密码框走不通);isAdmin 抛也按非管理员', async () => {
    const d = deps({ isAdmin: async () => false })
    expect(await d.auth('r')).toBe('ok')
    expect(d.calls).toEqual(['dialog'])
    expect(await deps({ isAdmin: async () => { throw new Error('id failed') }, dialog: false }).auth('r')).toBe('cancelled')
  })

  it('AppleScript 字符串转义 \\ 与 "(提示语不能改写脚本)', () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"')
    const d = deps()
    return d.auth('r').then(() => expect(d.calls[0]).toContain('with prompt "Unlock \\"remote\\" access\\\\?" with'))
  })
})
