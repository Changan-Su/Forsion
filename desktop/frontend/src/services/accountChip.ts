/**
 * 账号头像的宿主接缝:挂着的账号卡(AccountCard)把「显示什么 + 点了做什么」发布到这里;把账号入口画在别处的宿主
 * (Android 原生顶栏右侧的头像,mobile/src/nativeChrome.ts)据此渲染并把点击转回来。菜单、登录、切号仍是账号卡那一份。
 * 桌面 / Web 没有消费者:发布了也无人读。
 */
export interface AccountChip {
  /** 读屏文案(已按当前语言):昵称,或「登录」「登录已过期」「引擎未运行」这类状态。 */
  label: string
  loggedIn: boolean
  initial: string
  /** 头像图(data: 或 https:);没有、或宿主加载不了时画首字母。 */
  avatar?: string
  activate(): void
}

let chip: AccountChip | null = null
const listeners = new Set<() => void>()

export const accountChip = (): AccountChip | null => chip
export function publishAccountChip(next: AccountChip | null): void {
  chip = next
  listeners.forEach((fn) => fn())
}
export function subscribeAccountChip(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
