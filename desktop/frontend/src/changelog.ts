/// <reference types="vite/client" />
/**
 * 应用内「最新更新」(关于页展示)。
 * 数据源 = desktop 根目录的 CHANGELOG.md(纯 markdown,方便直接编辑 / 在 GitHub 阅读),
 * 构建期经 Vite `?raw` 内联进来后解析。维护:在 CHANGELOG.md 顶部加一节
 *   ## v1.2.3 (2026-06-20)
 *   - 要点
 * 关于页自动按节渲染(最新在最上)。标题原样展示(不再自动加 v),想要 v 就写在 CHANGELOG 里。
 * `Unreleased` 可以放在最上面参与展示，但它不是应用版本；APP_VERSION 取第一个正式版本节。
 * 与 docs/Log 的开发日志分工:这里面向用户精炼。
 *
 * 英文版 = 同目录的 CHANGELOG.en.md,节标题与中文逐字相同(`## 2.11.4 (2026-09-23)`),界面按语言取(W-11)。
 * 中文是发版真源:版本顺序与 APP_VERSION 都只看中文;英文缺哪一节就回落中文那一节,并标 fallback 让界面注明。
 */
import raw from '../../CHANGELOG.md?raw'
import rawEn from '../../CHANGELOG.en.md?raw'

import { latestReleasedVersion, parseChangelog, type ChangelogEntry } from './changelogParse'

export { latestReleasedVersion, parseChangelog, type ChangelogEntry }

export const CHANGELOG: ChangelogEntry[] = parseChangelog(raw)
export const CHANGELOG_EN: ChangelogEntry[] = parseChangelog(rawEn)

/** 按界面语言取更新日志。 */
export function changelogFor(locale: string, zh: ChangelogEntry[] = CHANGELOG, en: ChangelogEntry[] = CHANGELOG_EN): ChangelogEntry[] {
  if (locale !== 'en') return zh
  const byVersion = new Map(en.map((e) => [e.version, e]))
  return zh.map((e) => byVersion.get(e.version) ?? { ...e, fallback: true })
}

export const APP_VERSION: string = latestReleasedVersion(CHANGELOG)
