/** 「这一下往主区开的,一律开在当前标签旁边」(2026-10-14 用户定:悬停预览里操作别的 Space 的左栏,不切 Space,
 *  要开的东西进当前 Space 的新标签,见 Ribbon 的悬停预览;列表条目拖进主区也借它,见 WorkspaceHost 的 openAtMain)。
 *  只管这一次点击 / 松手同步跑完的那段,下一个宏任务就撤。
 *  认它的:dockviewStore 的 openView / navigateLeaf(主区就地导航改成在当前标签旁边新开,已经开着同一个就切过去)、
 *  spaceRegistry.setActiveSpace(期间不切 Space)、宿主里自己排开法的(sessionNav、amadeusNav.openNote、文件面板喂代码工作台那条)。
 *  单独一个文件:mobile 构建把 workspaceStore 整个换成单列 store,放进 store 里 mobile 就没有这个导出了。
 *  ponytail: 点击之后先 await 再开的赶不上这一档 → 照常就地开(仍在当前 Space)。 */
let opensBeside = false
let target: string | null = null

export function openMainBesideThisTask(): void {
  target = null
  if (opensBeside) return
  opensBeside = true
  setTimeout(() => { opensBeside = false; target = null }, 0)
}

export const mainOpensBeside = (): boolean => opensBeside

/** 这一档里开出来 / 切过去的主区标签(dockviewStore 记;拖放要把它挪到落点 —— 正看着的那个也算,
 *  所以不能靠「活动标签变没变」来判)。 */
export function noteBesideTarget(id: string): void { if (opensBeside) target = id }
export const besideTarget = (): string | null => target
