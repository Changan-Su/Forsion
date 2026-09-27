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
// 大小写不敏感:APFS / NTFS 默认如此,Windows 盘符大小写也常不一致(多认只会去问一次宿主的 writable,不会误写)
const key = (p: string): string => normPath(p).toLowerCase()

export function isCreationDir(cwd: string, root: string): boolean {
  return !!cwd && !!root && key(cwd).replace(/\/[^/]*$/, '') === key(root)
}

const cwdOf = (s: ReturnType<typeof useApp.getState>, sid: string): string =>
  s.configBySession[sid]?.cwd || s.sessions.find((x) => x.id === sid)?.project_path || ''
/** 这个作品里还有 run 在跑(它还在写,这时存会把半截改动一起提交)。 */
const busyIn = (s: ReturnType<typeof useApp.getState>, cwd: string): boolean =>
  Object.keys(s.runningBySession).some((sid) => key(cwdOf(s, sid)) === key(cwd))

/** 返回退订(测试用;应用里装一次不退)。 */
export function installCreationAutoVersion(): (() => void) | undefined {
  const tangu = window.tangu
  if (!tangu?.codeStudioGitCommit || !tangu.codeStudioGitStatus || !tangu.codeProjectsRoot) return
  let root = ''
  void tangu.codeProjectsRoot().then((r) => { root = r || '' }).catch(() => {})
  return useApp.subscribe((s, prev) => {
    if (!root || s.runningBySession === prev.runningBySession) return
    for (const sid of Object.keys(prev.runningBySession)) {
      if (s.runningBySession[sid]) continue // 还在跑 / 刚换了 run:只认「跑着 → 停了」这一沿
      const cwd = cwdOf(s, sid)
      if (!isCreationDir(cwd, root)) continue
      // 同一作品里还有别的 run 在跑:它还在写,这时存会把半截改动一起提交 —— 等最后一个停下再存
      if (busyIn(s, cwd)) continue
      void saveVersion(cwd, sid)
    }
  })
}

async function saveVersion(cwd: string, sid: string): Promise<void> {
  try {
    const status = await window.tangu!.codeStudioGitStatus!(cwd)
    // 查状态那一下里又有 run 在这个作品里跑起来了:这次不存,等它停下再存(窗口缩到一次 IPC;提交本身在宿主里跑,没法和 run 原子)
    if (!status?.writable || busyIn(useApp.getState(), cwd)) return
    const label = autoVersionName(useApp.getState().messagesBySession[sid] || [])
    await window.tangu!.codeStudioGitCommit!(cwd, { name: label, auto: true, untitled: translate('studio.history.untitled') })
  } catch (e) { console.warn('[creations] 自动存版本失败', e) }
}
