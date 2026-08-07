/**
 * 云镜像根下已成型的「同步 Vault 文件夹」名。判据与 web/mobile 同源(CLOUD_VAULT_MARKER),
 * 但读的是**镜像磁盘**:标记是点开头文件,vaultManager 的遍历一律跳过 → 渲染端拿到的
 * pages/files 里根本没有它,照 web 那样从树上推是推不出来的。
 *
 * 存在意义 = **换一台设备**:分区名原先只取本机注册表(AmadeusConfig.entrySync),而注册表是
 * 每机本地配置(vaultRoot 记的是本机绝对路径),新设备上恒为空 —— 设备 A 开启同步的那些工作区
 * 内容明明已被 own 引擎拉进镜像,却全挤进「Cloud工作区」一坨。2026-08-05 实报。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CLOUD_VAULT_MARKER } from '@amadeus-shared/entrySync'

export async function mirrorVaultNames(cloudRoot: string): Promise<string[]> {
  const ents = await fs.readdir(cloudRoot, { withFileTypes: true }).catch(() => [])
  const names: string[] = []
  for (const e of ents) {
    // 只认根级一段(与 cloudVaultNamesFrom 的正则同语义);点开头目录与「与我共享/」无标记,自然落选。
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (await fs.access(path.join(cloudRoot, e.name, CLOUD_VAULT_MARKER)).then(() => true, () => false)) {
      names.push(e.name)
    }
  }
  return names.sort()
}
