// 项目选择器:Web 下拉按「名称 + 路径 + Project 名」搜;原生半屏(Android)的搜索只匹配行的「名称 + 副文案」。
// 副文案必须带上另外两个字段,两边才搜得出同一批项目(评审 2026-10-02:原生行只有名称,按路径搜不到)。
import { describe, expect, it } from 'vitest'
import { projectSearchDetail, projectSearchText } from './ProjectSelector'

const workspaces = [
  { name: 'forsion', path: '/Users/me/Documents/Project/Forsion', project: undefined },
  { name: 'notes', path: 'D:\\work\\client-acme\\notes', project: undefined },
  { name: 'Tangu', path: null, project: 'Tangu' },
  { name: 'Research', path: null, project: 'research-2026' },
]
/** 原生半屏的匹配规则(NativeSheetUi.kt):label 或 detail 含查询串,不分大小写。 */
const nativeMatch = (w: (typeof workspaces)[number], q: string): boolean => [w.name, projectSearchDetail(w) ?? ''].some((s) => s.toLowerCase().includes(q))
const webMatch = (w: (typeof workspaces)[number], q: string): boolean => projectSearchText(w).toLowerCase().includes(q)

describe('project search fields', () => {
  it('detail carries path / project name, skipping what the label already shows', () => {
    expect(workspaces.map(projectSearchDetail)).toEqual([
      '/Users/me/Documents/Project/Forsion', 'D:\\work\\client-acme\\notes', undefined, 'research-2026',
    ])
  })
  it('native (label + detail) finds the same projects as the web dropdown for name, path and project queries', () => {
    for (const q of ['forsion', 'documents/project', 'client-acme', 'tangu', 'research', '2026', 'notes', 'nope']) {
      expect(workspaces.filter((w) => nativeMatch(w, q)).map((w) => w.name), q).toEqual(workspaces.filter((w) => webMatch(w, q)).map((w) => w.name))
    }
    expect(workspaces.filter((w) => nativeMatch(w, 'client-acme')).map((w) => w.name)).toEqual(['notes']) // a path-only hit
  })
})
