/**
 * updater 的纯逻辑(无 electron / electron-updater 依赖,可在 node 下单测)。
 * updater.ts 引用这里;别在本文件 import electron,否则单测无法在非 Electron 环境加载。
 */

/** GitHub releaseNotes 可能是 string / Array<{ note }> / null → 归一为纯字符串(供 UI 展示)。 */
export function notesToString(notes: unknown): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes || undefined
  if (Array.isArray(notes)) {
    const s = notes.map((n: any) => (n?.note ?? '')).filter(Boolean).join('\n\n')
    return s || undefined
  }
  return undefined
}

/**
 * 从 CHANGELOG.md 里抠出某个版本那一节的正文(不含 `## x.y.z (日期)` 标题行本身)。
 * 找不到该节 → undefined。
 *
 * 为什么要这个:发版流程用的是 `gh release create --generate-notes`,Release 正文是 GitHub
 * 按提交/PR 自动拼的清单,**不是**我们写给用户的更新日志;而 Win/Linux 的 latest.yml 干脆
 * 不带 releaseNotes。两条路都拿不到「2.7.4 到底更新了什么」——只能回源 CHANGELOG.md。
 */
export function changelogSection(md: string, version: string): string | undefined {
  const want = version.trim().replace(/^v/i, '')
  const lines = md.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+v?([0-9][^\s(]*)/.exec(lines[i])
    if (!m) continue
    if (start === -1) {
      if (m[1] === want) start = i + 1
    } else {
      return lines.slice(start, i).join('\n').trim() || undefined
    }
  }
  return start === -1 ? undefined : lines.slice(start).join('\n').trim() || undefined
}

// 版本比较搬去了 `desktop/shared/updateVersion.ts`(移动端也要用,而 web 镜像构建上下文里没有
// desktop/electron —— 详见那个文件的抬头)。这里原样再导出,updater.ts / 单测的入口不变。
export { isNewer, isPrerelease } from '../shared/updateVersion'
