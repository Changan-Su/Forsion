/**
 * 在线库(云端库)的根身份:`cloud://<vaultId>/<libraryId>`(智库同步第 3 步,契约 step34 P-8 二-4)。
 * pageStore.vaultRoot、插件的 vaultRoot()、PathGoneEvent.root、严格写的 expectedRoot 都用这一个串。
 * libraryId:默认库 / 独立库 = vaultId;原位置库 = `<默认库 id>:Amadeus/<X>/`(带 `:` 和 `/`,照原样拼、不转义:
 * 与 shared 的 `onlineVaultRoot` 一致,宿主的插件数据闸按同一个串认库那一层)。
 *
 * ⚠️ 合并时换成 desktop/shared/amadeus 里的 `onlineVaultRoot(ref)`(另一包在写,分支 feat/sync-step3-u3a-shell),两边拼法必须一字不差。
 * ⚠️ 这个串也是渲染层本机存储的键的一部分(未保存草稿 `amadeus.unsavedDraft:<root>:<path>`、noteMemoryId、手机插件数据的库那一层):
 *    从老的 `cloud://<vaultId>` 换过来,老键不会自己跟过来,由父会话定怎么接(见 PR 说明)。
 */
export function cloudLibraryRoot(vaultId: string, libraryId: string): string {
  return `cloud://${vaultId}/${libraryId}`
}

/** 这个根是不是这个库(vaultId)的某一个视图:与我共享 / 只读判断只认库,不认视图。老形状 `cloud://<vaultId>` 也认。 */
export function isCloudRootOfVault(root: string | null | undefined, vaultId: string): boolean {
  if (!root || !vaultId) return false
  const head = `cloud://${vaultId}`
  return root === head || root.startsWith(`${head}/`)
}
