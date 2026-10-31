/**
 * Git 卡读工具结果的那一半(tangu-agent tools/builtin/git.ts 的结果形状)与工具行的说法:
 *   - 成功 = 整段 JSON;失败 = `Error: …` 一行 + 带机器码的 JSON(卡按 projectProfile.git.err.<code> 本地化);老格式的纯文字失败也认得出是失败
 *   - 工具行:提交那行带信息首行,不再是 `git_commit {"message":…}`
 *   - 远端那行「用谁的账号」:Forsion Git 上组织的仓库写「<组织>组织」,个人仓库照旧写「你的 Forsion 账号」
 */
import { describe, expect, it } from 'vitest'
import { gitStatusSuperseded, onForsionSite, parseGitResult, isGitTool } from './GitToolCard'
import { describeTool } from '../../components/ToolGroup'
import { remoteAuthText } from '../ProjectGitRemotes'
import { translateFor } from '../../i18n'

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

  it('只看过状态的卡,同一条回答后面又有 git 写动作时不画', () => {
    const ev = (id: string, name: string) => ({ id, name, done: true })
    const all = [ev('s', 'git_status'), ev('r', 'read_file'), ev('p', 'git_push')]
    expect(gitStatusSuperseded([all[0]], all)).toBe(true)
    expect(gitStatusSuperseded([all[0]], all.slice(0, 2))).toBe(false)
    expect(gitStatusSuperseded([all[2]], all)).toBe(false) // 结果卡照画
  })

  it('Forsion Git 上组织的仓库写组织,不写个人账号', () => {
    const r = { name: 'origin', url: '', host: 'forsion' as const, hostname: 'git.forsion.test', path: 'xinghe/app', web: null, auth: 'forsion' as const }
    const zh = (k: string, v?: Record<string, unknown>) => translateFor('zh', k, v)
    const en = (k: string, v?: Record<string, unknown>) => translateFor('en', k, v)
    expect(remoteAuthText({ ...r, org: '星河工作室' }, undefined, zh)).toBe('星河工作室组织')
    expect(remoteAuthText({ ...r, org: 'Xinghe Studio' }, undefined, en)).toBe('Xinghe Studio organization')
    expect(remoteAuthText(r, undefined, zh)).toBe('你的 Forsion 账号')
  })

  it('等你审的合并请求只往项目的 Forsion Git 站上开(存下的工具结果在别的设备上照着画)', () => {
    const site = 'https://git.forsion.test'
    expect(onForsionSite('https://git.forsion.test/xinghe/app/pulls/12', site)).toBe(true)
    expect(onForsionSite('https://evil.example/phish', site)).toBe(false)
    expect(onForsionSite('http://git.forsion.test/xinghe/app/pulls/12', site)).toBe(false)
    expect(onForsionSite('https://git.forsion.test.evil.example/x', site)).toBe(false)
    expect(onForsionSite('https://git.forsion.test/x', null)).toBe(false)
    expect(onForsionSite(42, site)).toBe(false)
  })

  it('认得四个 git 工具,工具行带信息首行', () => {
    expect(['git_status', 'git_commit', 'git_push', 'git_pull'].every((name) => isGitTool({ name }))).toBe(true)
    expect(isGitTool({ name: 'run_bash' })).toBe(false)
    expect(describeTool({ id: 'c', name: 'git_commit', done: true, arguments: JSON.stringify({ message: 'feat: cards\n\nbody' }) })).toMatchObject({ verbKey: 'tool.verb.gitCommit', target: 'feat: cards' })
    expect(describeTool({ id: 'p', name: 'git_push', done: true, arguments: '{}' })).toMatchObject({ verbKey: 'tool.verb.gitPush', target: '' })
  })
})
