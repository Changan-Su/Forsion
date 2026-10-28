/**
 * Git 卡读工具结果的那一半(tangu-agent tools/builtin/git.ts 的结果形状)与工具行的说法:
 *   - 成功 = 整段 JSON;失败 = `Error: …` 一行 + 带机器码的 JSON(卡按 projectProfile.git.err.<code> 本地化);老格式的纯文字失败也认得出是失败
 *   - 工具行:提交那行带信息首行,不再是 `git_commit {"message":…}`
 */
import { describe, expect, it } from 'vitest'
import { parseGitResult, isGitTool } from './GitToolCard'
import { describeTool } from '../../components/ToolGroup'

describe('Git 卡', () => {
  it('成功的结果是 JSON', () => {
    expect(parseGitResult({ result: '{"action":"commit","short":"a1b2c3d","files":4}' })).toEqual({ ok: true, data: { action: 'commit', short: 'a1b2c3d', files: 4 } })
  })

  it('失败的结果取第二行的机器码', () => {
    const r = parseGitResult({ isError: true, result: 'Error: The account Forsion signs in with cannot access this repository. Tell the user…\n{"action":"push","error":"credential_denied","message":"x","detail":"remote: denied"}' })
    expect(r).toEqual({ ok: false, data: { action: 'push', error: 'credential_denied', message: 'x', detail: 'remote: denied' } })
  })

  it('没有 JSON 的失败照样是失败,原因取第一行', () => {
    expect(parseGitResult({ result: 'Error: tool timed out' })).toEqual({ ok: false, data: { message: 'tool timed out' } })
    expect(parseGitResult({ result: 'not json' })).toBeNull()
  })

  it('认得四个 git 工具,工具行带信息首行', () => {
    expect(['git_status', 'git_commit', 'git_push', 'git_pull'].every((name) => isGitTool({ name }))).toBe(true)
    expect(isGitTool({ name: 'run_bash' })).toBe(false)
    expect(describeTool({ id: 'c', name: 'git_commit', done: true, arguments: JSON.stringify({ message: 'feat: cards\n\nbody' }) })).toMatchObject({ verbKey: 'tool.verb.gitCommit', target: 'feat: cards' })
    expect(describeTool({ id: 'p', name: 'git_push', done: true, arguments: '{}' })).toMatchObject({ verbKey: 'tool.verb.gitPush', target: '' })
  })
})
