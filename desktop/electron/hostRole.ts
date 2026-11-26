/**
 * 这份进程是谁:唯一的角色判定(无 Electron 依赖,main.ts 启动最早期注入一次,之后只读)。
 *
 *   · 插件沙箱:用户那份 Forsion 按需另起的(pluginSandbox.ts / sandboxChild.ts),身份来自父进程给的环境变量;
 *   · 文件夹 Unit:同一份安装在这台电脑上另跑的一份自成一体的 Forsion(localUnits.ts),身份来自启动参数 --forsion-unit=<id>;
 *   · 都不是 = 「这台电脑的主人」(默认那台):只有它碰整机共享的东西 —— forsion:// 协议注册、托盘、全局快捷键、CLI、
 *     MCP 固定端口、设备互联与 Clip 的固定口、自动更新、电脑历史、写安装包图标。
 *
 * 判「是不是整机的主人」一律用 isMachineOwner();只对插件沙箱成立的事(连回父进程、不起引擎、不播种内置包)仍看沙箱身份本身。
 * 不再新增别的散判。
 */
export interface HostRole {
  pluginSandbox: boolean
  /** 文件夹 Unit 的 id;默认那台 / 插件沙箱 = null。 */
  folderUnitId: string | null
}

let role: HostRole = { pluginSandbox: false, folderUnitId: null }

/** main.ts 在决定 userData / home 的同一段里调一次。 */
export function setHostRole(next: HostRole): void {
  role = { pluginSandbox: next.pluginSandbox, folderUnitId: next.folderUnitId }
}

export const hostRole = (): Readonly<HostRole> => role
export const isFolderUnit = (): boolean => role.folderUnitId !== null
/** 这台电脑的主人 = 既不是插件沙箱、也不是文件夹 Unit。 */
export const isMachineOwner = (): boolean => !role.pluginSandbox && role.folderUnitId === null
