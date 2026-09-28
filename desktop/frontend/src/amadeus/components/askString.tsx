/** 命令式文本输入:`await askString('新建文件夹', '新文件夹')` → 弹 PromptDialog,
 *  确定回 trim 后的值、取消/Esc 回 null。Electron 不支持 window.prompt(调用即失败),
 *  所有原 prompt 调用点一律换用本入口;Host 挂在 AmadeusOverlays(三端共用)。 */
import { create } from 'zustand'
import { PromptDialog } from './Dialogs'
import { useMobileBackClose } from '../lib/mobileBack'

/** askStringOrAlt 的次要出口(如「移除链接」)被点时的返回值。 */
export const ASK_ALT: unique symbol = Symbol('askString.alt')

interface Req {
  title: string
  label?: string
  initial: string
  confirmLabel?: string
  /** 次要出口按钮的文案;缺省 = 没有这个按钮(askString 的全部调用点)。 */
  altLabel?: string
  resolve: (v: string | null | typeof ASK_ALT) => void
}

const usePromptStore = create<{ req: Req | null; open(r: Req): void; clear(): void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  clear: () => set({ req: null }),
}))

export function askString(title: string, initial = '', opts?: { label?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    // 已有弹窗未决:先取消旧的(单例;嵌套询问不是我们的形态)
    usePromptStore.getState().req?.resolve(null)
    usePromptStore.getState().open({ title, initial, label: opts?.label, confirmLabel: opts?.confirmLabel, resolve: (v) => resolve(v === ASK_ALT ? null : v) })
  })
}

/** 同 askString,多一个次要出口按钮(`altLabel`,如编辑链接时的「移除链接」):点它 resolve ASK_ALT。
 *  为什么要单独一个出口:PromptDialog 的空输入等同「取消」,拿不到「确认了但留空」这个信号(I-10)。 */
export function askStringOrAlt(title: string, initial: string, opts: { label?: string; confirmLabel?: string; altLabel: string }): Promise<string | null | typeof ASK_ALT> {
  return new Promise((resolve) => {
    usePromptStore.getState().req?.resolve(null)
    usePromptStore.getState().open({ title, initial, label: opts.label, confirmLabel: opts.confirmLabel, altLabel: opts.altLabel, resolve })
  })
}

/** 挂载一次(AmadeusOverlays);.am-app 载体让 .dialog-* 样式命中。
 *  必须带 .tangu-lovable:.dialog 的取色 token(--surface-2/--primary…)被 amadeus 主题包的裸
 *  [data-mode] 选择器钉在 <html> 上(Origin 硬编码色),只有经 bridge 重映射到 LCL 皮肤词表
 *  才跟当前主题/明暗走 —— 所有弹窗载体(WikiCreateConfirm/CloudSyncDialogHost)同款。 */
export function AskStringHost() {
  const req = usePromptStore((s) => s.req)
  // Android 返回 = 取消(G2-12:此前返回键关掉了底下的笔记,对话框却还留在屏幕上)。
  useMobileBackClose(!!req, () => {
    const cur = usePromptStore.getState().req
    if (!cur) return
    usePromptStore.getState().clear()
    cur.resolve(null)
  })
  if (!req) return null
  const settle = (v: string | null | typeof ASK_ALT): void => {
    if (usePromptStore.getState().req !== req) return // 已决(confirm 先到,close 随后)不再二次 resolve
    usePromptStore.getState().clear()
    req.resolve(v)
  }
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <PromptDialog
        title={req.title}
        label={req.label}
        initial={req.initial}
        confirmLabel={req.confirmLabel}
        altLabel={req.altLabel}
        onAlt={req.altLabel ? () => settle(ASK_ALT) : undefined}
        onConfirm={(v) => settle(v)}
        onClose={() => settle(null)}
      />
    </div>
  )
}
