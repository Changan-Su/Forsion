import { useApp } from './stores/appStore'
import { translate } from './i18n'
import { autoVersionName } from './views/coding/gitHistory'
import { normPath } from './views/coding/studioModel'

/**
 * 造物里的项目,不管是在编码工作室还是 Tangu Space 里跑的 agent,一轮跑完都由宿主存一版(2026-09-27「进造物」)。
 * 以前只有 CodeStudioView 挂着这个 effect:同一个作品在 Tangu Space 里跑就一版都不存。
 * 与 CodeStudioView 那份并存(没挪它):两份同时触发时第二次是空操作 —— gitHistory 按根串行,干净树 commitGitVersion 回 null。
 * 只认托管根(~/Forsion/Project)的直接子目录;写不写得了由 codeStudio:gitStatus 的 writable 判(没 git / 用户自己的仓 → 不写)。
 * web / 移动端没有这组 IPC → no-op。
 */
export function isCreationDir(cwd: string, root: string): boolean {
  return !!cwd && !!root && normPath(cwd).replace(/\/[^/]*$/, '') === normPath(root)
}

export function installCreationAutoVersion(): void {
  const tangu = window.tangu
  if (!tangu?.codeStudioGitCommit || !tangu.codeStudioGitStatus || !tangu.codeProjectsRoot) return
  let root = ''
  void tangu.codeProjectsRoot().then((r) => { root = r || '' }).catch(() => {})
  useApp.subscribe((s, prev) => {
    if (!root || s.runningBySession === prev.runningBySession) return
    for (const sid of Object.keys(prev.runningBySession)) {
      if (s.runningBySession[sid]) continue // 还在跑 / 刚换了 run:只认「跑着 → 停了」这一沿
      const cwd = s.configBySession[sid]?.cwd || s.sessions.find((x) => x.id === sid)?.project_path || ''
      if (isCreationDir(cwd, root)) void saveVersion(cwd, sid)
    }
  })
}

async function saveVersion(cwd: string, sid: string): Promise<void> {
  try {
    const status = await window.tangu!.codeStudioGitStatus!(cwd)
    if (!status?.writable) return
    const label = autoVersionName(useApp.getState().messagesBySession[sid] || [])
    await window.tangu!.codeStudioGitCommit!(cwd, { name: label, auto: true, untitled: translate('studio.history.untitled') })
  } catch (e) { console.warn('[creations] 自动存版本失败', e) }
}
