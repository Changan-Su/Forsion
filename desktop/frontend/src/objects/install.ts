/**
 * LCL 对象层的宿主装配:能力、确认框、失败上报 + 各类对象(第一期:Space)。
 * 在 bootstrapEngine.installEngine() 里调 —— desktop / web / 手机三个入口都经它,不用各补一份。
 */
import {
  getDetachApi, inSingleColumnShell, canPinSpaceToHome, nativeSheetPresenter, presentNativeConfirm, setObjectHost,
  OBJECT_REASON, type ActionResult,
} from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { registerMessages, translate } from '../i18n'
import { installSpaceObject } from './space'

registerMessages({
  'objects.failed': { zh: '没能完成：{reason}', en: 'Couldn’t finish: {reason}' },
  'objects.failedMany': { zh: '{n} 项没能完成：{reason}', en: '{n} items didn’t finish: {reason}' },
  'objects.reason.unavailable': { zh: '这个操作现在用不了', en: 'This action isn’t available right now' },
  'objects.reason.error': { zh: '出了点问题', en: 'Something went wrong' },
  'objects.cancel': { zh: '取消', en: 'Cancel' },
})

const reasonText = (r: string): string =>
  r === OBJECT_REASON.unavailable ? translate('objects.reason.unavailable') : r === OBJECT_REASON.error ? translate('objects.reason.error') : r

let installed = false
export function installObjectLayer(): void {
  if (installed) return
  installed = true
  setObjectHost({
    caps: () => ({
      openWindow: !!getDetachApi()?.openSpace,
      desktopShortcut: !!getDetachApi()?.addSpaceToDesktop,
      pinHome: canPinSpaceToHome(),
      revealFile: false, // 第一期没有文件类对象;库内文件那个 PR 接
      singleColumn: inSingleColumnShell(),
    }),
    confirm: async (req) => {
      if (nativeSheetPresenter()) {
        const out = await presentNativeConfirm({ title: req.title, ...(req.body ? { message: req.body } : {}), confirm: req.confirm, cancel: translate('objects.cancel'), ...(req.danger ? { danger: true } : {}) })
        if (out.handled) return !!out.value
      }
      return window.confirm(req.body ? `${req.title}\n\n${req.body}` : req.title)
    },
    report: (failures: ActionResult[]) => {
      const first = failures.find((f): f is Extract<ActionResult, { ok: false }> => !f.ok)
      if (!first) return
      const reason = reasonText(first.reason)
      useApp.getState().toast(failures.length > 1 ? translate('objects.failedMany', { n: failures.length, reason }) : translate('objects.failed', { reason }), true)
    },
  })
  installSpaceObject()
}
