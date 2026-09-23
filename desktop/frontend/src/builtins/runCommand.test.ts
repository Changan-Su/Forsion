import { describe, it, expect } from 'vitest'
import { isShellLang, registerPendingRun, runResultText, stripPrompt, takePendingRun } from './runCommand'

describe('runCommand', () => {
  it('登记是一次性的:取走即删(布局恢复带旧 token 不得再跑一遍)', () => {
    const token = registerPendingRun({ cmd: 'echo hi' })
    expect(takePendingRun(token)?.cmd).toBe('echo hi')
    expect(takePendingRun(token)).toBeUndefined()
    expect(takePendingRun(undefined)).toBeUndefined()
    expect(takePendingRun(42)).toBeUndefined()
  })

  it('只认 bash/sh/zsh/shell;console/python 不算', () => {
    for (const l of ['bash', 'sh', 'zsh', 'shell', 'Bash']) expect(isShellLang(l)).toBe(true)
    for (const l of ['console', 'python', '', undefined]) expect(isShellLang(l)).toBe(false)
  })

  it('stripPrompt 只剥行首 `$ `', () => {
    expect(stripPrompt('$ echo $HOME\n$ test $? -eq 0')).toBe('echo $HOME\ntest $? -eq 0')
  })

  it('runResultText:含命令与退出码;输出超长只留尾部;无输出不留空 fence', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n')
    const t = runResultText({ cmd: 'ls', code: 0, output: long }, 5)
    expect(t).toContain('```bash\nls\n```')
    expect(t).toContain('line99')
    expect(t).not.toContain('line94')
    expect(t).toContain('0')
    const empty = runResultText({ cmd: 'true', cwd: '/tmp', code: 3, output: '   \n' })
    expect(empty).toContain('3')
    expect(empty).toContain('/tmp')
    expect((empty.match(/```/g) ?? []).length).toBe(2)
  })
})
