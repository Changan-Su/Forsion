/**
 * 设置 › 关于 › 备案与协议 里的「开源许可」一行:只在包里带了本机引擎启动器(PRoot)的安卓 App 出现。
 * PRoot 是 GPL-2.0-or-later 的独立程序,随包放在 jniLibs、以子进程运行,不与 Forsion 代码链接;
 * 这里写明它与 talloc 的许可,并指向对应源码与构建脚本(发版时另附源码包,见 mobile/android/native/proot/README.md)。
 */
import React, { useState } from 'react'
import { ChevronRight, Scale } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { usePhoneEngine } from '../services/engine/phoneEngine'

export const PROOT_SOURCE_URL = 'https://github.com/Changan-Su/Forsion/tree/main/mobile/android/native/proot'

registerMessages({
  'about.licenses': { zh: '开源许可', en: 'Open-source licenses' },
  'about.licensesSub': { zh: 'PRoot 与 talloc 的许可证', en: 'PRoot and talloc licenses' },
  'about.licensesBody': {
    zh: '这个版本带有 PRoot 5.4.0（GPL-2.0-or-later）和 talloc 2.4.3（LGPL-3.0-or-later），作为独立程序用来在这台手机上运行本机环境，没有与 Forsion 的代码链接。它们的源码、补丁和构建脚本公开在下面的地址，带它们的每个版本在发布页另附源码包。下载的运行环境里的 Ubuntu 软件包和 Node.js 各有自己的许可证，放在环境的 /usr/share/doc 和 /opt/node 里。',
    en: 'This version includes PRoot 5.4.0 (GPL-2.0-or-later) and talloc 2.4.3 (LGPL-3.0-or-later) as a separate program that runs the local environment on this phone; it is not linked with Forsion code. Their source, patches and build script are published at the address below, and every release that includes them also attaches a source package. The Ubuntu packages and Node.js in the downloaded environment carry their own licenses, found under /usr/share/doc and /opt/node in the environment.',
  },
  'about.licensesSource': { zh: '查看源码', en: 'View source' },
})

export function PhoneEngineLicenses(): React.ReactElement | null {
  const { t } = useI18n()
  const bundled = usePhoneEngine((s) => !!s.state?.available)
  const [open, setOpen] = useState(false)
  if (!bundled) return null
  return (
    <>
      <button
        type="button"
        className="settings-control-row about-compliance-row"
        data-testid="mobile-licenses"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="settings-control-copy">
          <Scale size={14} />
          <span><strong>{t('about.licenses')}</strong><small>{t('about.licensesSub')}</small></span>
        </div>
        <ChevronRight size={16} aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
      </button>
      {open && (
        <div className="hint" data-testid="mobile-licenses-body" style={{ padding: '6px 12px 10px' }}>
          <div>{t('about.licensesBody')}</div>
          <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => void window.tangu?.openExternal?.(PROOT_SOURCE_URL)}>{t('about.licensesSource')}</button>
        </div>
      )}
    </>
  )
}
