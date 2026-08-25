/**
 * 文件类 view 的后缀声明表(View 基座统一化 P0)——**纯数据,零依赖**(node 可测)。
 * 单一真源:bootstrapEngine 注入 ViewDefinition.fileMatch、amadeusNav.openFile 的单后缀分派、
 * P1 deep link 的 note 路由校验都消费这一张表。
 * ⚠️ 复合后缀判定(.excalidraw.md / .dashboard.md)运行时仍走 @amadeus-shared 的
 * isDrawingPath / isDashboardPath(毁档防线,别处也在用);与本表的一致性由 viewFileMatch.test.ts 锁住。
 */
export const VIEW_FILE_MATCH: Record<string, { extensions: string[]; priority: number }> = {
  // priority 大者先判:复合后缀(20)> 单后缀(10)> 裸 .md 兜底(0)。
  'amadeus-drawing': { extensions: ['.excalidraw.md'], priority: 20 },
  // P3a:.dashboard.md 归新画布版('dashboard');旧 'amadeus-dashboard' 保留注册但不再认领文件
  // (布局恢复不崩;保留一个发布周期后删,见方案 §6.2)。
  dashboard: { extensions: ['.dashboard.md'], priority: 20 },
  'amadeus-db': { extensions: ['.db'], priority: 10 },
  'amadeus-pdf': { extensions: ['.pdf'], priority: 10 },
  'amadeus-image': { extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico'], priority: 10 },
  'amadeus-editor': { extensions: ['.md'], priority: 0 },
}

/** path 后缀命中某 type 的声明?(大小写不敏感) */
export function extHit(path: string, type: string): boolean {
  const m = VIEW_FILE_MATCH[type]
  if (!m) return false
  const p = path.toLowerCase()
  return m.extensions.some((e) => p.endsWith(e))
}

/** 按声明表(priority 降序)判 path 该归哪个文件类 view;无命中 null。
 *  仅静态声明:插件文件类型(运行期注册)不在此表,调用方先问 matchFileType。 */
export function fileMatchViewType(path: string): string | null {
  const p = path.toLowerCase()
  let best: { type: string; priority: number } | null = null
  for (const [type, m] of Object.entries(VIEW_FILE_MATCH)) {
    if (!m.extensions.some((e) => p.endsWith(e))) continue
    if (!best || m.priority > best.priority) best = { type, priority: m.priority }
  }
  return best?.type ?? null
}
