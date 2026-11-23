/**
 * Reason codes from the main process (language-neutral, `source: …` / `resolve: …` / `install: …`) → text, and the few
 * source strings the chat's store cards share with the store page (confirm block, "Source removed"). Kept apart from
 * MarketSources.tsx so the cards can use them without pulling in the store page (overlays, menus).
 */
import { registerMessages } from '../i18n'

registerMessages({
  // 来源条目的确认块与标签(商店页和对话里的商店卡片共用)
  'market.sources.cancel': { zh: '取消', en: 'Cancel' },
  'market.sources.confirmFirst': {
    zh: '第一次从「{name}」安装。它不经过 Forsion 审核，内容由来源作者维护。',
    en: 'This is your first install from "{name}". It isn\'t reviewed by Forsion. The source\'s author maintains it.',
  },
  'market.sources.confirmText': { zh: '这是{kind}，装上后不会自己运行代码。', en: 'This is a {kind}. It doesn\'t run code on its own.' },
  'market.sources.confirmCode': {
    zh: '这是{kind}，可能在 Forsion 里运行代码或命令。只装你信得过的作者做的。',
    en: 'This is a {kind}. It may run code or commands inside Forsion. Only install it if you trust the author.',
  },
  'market.sources.confirmInstall': { zh: '确认安装', en: 'Install' },
  'market.sources.removedBadge': { zh: '来源已移除', en: 'Source removed' },
  'market.sources.removedHint': { zh: '来源已移除，不再更新', en: 'Source removed. No longer updated.' },
  'market.kind.skill': { zh: '技能', en: 'Skill' },
  'market.kind.agent': { zh: 'Agent', en: 'Agent' },
  'market.kind.plugin': { zh: '插件', en: 'Plugin' },
  'market.kind.space': { zh: 'Space', en: 'Space' },
  'market.kind.theme': { zh: '主题', en: 'Theme' },
  // 主进程的原因码(语言中立)→ 文案
  'market.sources.err.fetch-failed': { zh: '读不到这个来源的目录：网络不通，或者地址不对。', en: 'Couldn\'t read this source\'s catalog. Check the network or the address.' },
  'market.sources.err.index-invalid': { zh: '这个地址上不是 Forsion 商店目录（forsion-store.json）。', en: 'This address isn\'t a Forsion store catalog (forsion-store.json).' },
  'market.sources.err.index-schema': { zh: '这份目录的格式版本这里还不认识，请先更新 Forsion。', en: 'This catalog uses a newer format. Update Forsion first.' },
  'market.sources.err.index-missing': {
    zh: '找不到 forsion-store.json：npm 包里没有它，或者仓库的这个分支、文件夹里没有。',
    en: 'No forsion-store.json here. The npm package doesn\'t include one, or this branch or folder of the repository doesn\'t have it.',
  },
  'market.sources.err.too-large': { zh: '目录文件太大（超过 1 MB）。', en: 'The catalog file is too large (over 1 MB).' },
  'market.sources.err.unrecognized': { zh: '认不出这个地址。可以贴 GitHub 或 Forsion Git 仓库、npm 包或 forsion-store.json 的链接。', en: 'This address isn\'t recognized. Paste a GitHub or Forsion Git repository, an npm package or a link to forsion-store.json.' },
  'market.sources.err.forsion-git-unsupported': { zh: '这台 Forsion 服务器还没开通 Forsion Git 来源。', en: 'Forsion Git sources aren\'t available on this Forsion server yet.' },
  'market.sources.err.forsion-git-signin': { zh: '登录 Forsion 账号后才能读 Forsion Git 上的私有仓库。', en: 'Sign in to your Forsion account to read private repositories on Forsion Git.' },
  'market.sources.err.forsion-git-no-access': { zh: '读不到这个仓库：它不存在，或者你的 Forsion 账号没有读权限。', en: 'Can\'t read this repository. It doesn\'t exist, or your Forsion account has no read access.' },
  'market.sources.err.forsion-git-needs-setup': { zh: '你还没有 Forsion Git 账号。先在浏览器里打开 Forsion Git 登录一次。', en: 'You don\'t have a Forsion Git account yet. Open Forsion Git in your browser and sign in once.' },
  'market.sources.err.forsion-git-ref-missing': { zh: '仓库里没有目录写的那个分支、标签或提交。', en: 'The repository doesn\'t have the branch, tag or commit named in the catalog.' },
  'market.sources.err.duplicate': { zh: '这个来源已经在左栏里了。', en: 'This source is already in the list.' },
  'market.sources.err.state-unreadable': { zh: '来源列表文件读不出来。为了不覆盖它，这次没有保存。', en: 'The source list file can\'t be read. Nothing was saved, so it isn\'t overwritten.' },
  'market.sources.err.not-found': { zh: '找不到这个来源。', en: 'This source wasn\'t found.' },
  'market.sources.err.source-removed': { zh: '这个来源已经移除或停用。', en: 'This source was removed or turned off.' },
  'market.sources.err.source-item-removed': { zh: '来源里已经没有这一项了。', en: 'The source no longer lists this item.' },
  'market.sources.err.version-unavailable': { zh: '来源只提供最新版本。', en: 'The source only offers the latest version.' },
  'market.sources.err.source-package-moved': { zh: '新版本换了下载地址，没有自动更新。请在来源页里手动更新。', en: 'The new version downloads from a different place, so it wasn\'t updated on its own. Update it from the source page.' },
  'market.sources.err.plugin-id-taken': { zh: '已经装了一个同 id 的插件，这一项没有装。', en: 'A plugin with the same ID is already installed, so this one wasn\'t installed.' },
  'market.sources.err.checksum': { zh: '下载的文件和目录里写的校验值对不上，没有安装。', en: 'The downloaded file doesn\'t match the checksum in the catalog, so it wasn\'t installed.' },
  'market.sources.err.commit': { zh: '下载到的不是目录写的那个提交，没有安装。', en: 'The download isn\'t the commit named in the catalog, so it wasn\'t installed.' },
  'market.sources.err.folder-missing': { zh: '仓库里找不到目录写的那个文件夹。', en: 'The folder named in the catalog isn\'t in the repository.' },
  'market.sources.err.source-item-changed': { zh: '这一项在来源里刚改过，没有安装。请重新打开再看一遍。', en: 'This item just changed in its source, so it wasn\'t installed. Open it again to review it.' },
  'market.sources.err.address-not-allowed': { zh: '目录里的下载地址指向本机或内网，没有下载。', en: 'The catalog\'s download address points at this computer or a private network, so nothing was downloaded.' },
  'market.sources.err.duplicate-path': { zh: '安装包里有两个文件落在同一个位置，没有安装。', en: 'Two files in the package land in the same place, so it wasn\'t installed.' },
  // 官方商店(2026-11-16+,electron/marketInternals.ts):包声明了 internals-raw,但这一版没过第二级审核
  'market.sources.err.internals-raw-unapproved': {
    zh: '这一版插件要直接操作 Forsion 的内部对象，还没通过商店的这项审核，所以没有安装。',
    en: 'This version of the plugin works on Forsion internals directly and hasn\'t passed the store\'s review for that yet, so it wasn\'t installed.',
  },
  // 演示舞台(2026-11-20+):包声明了 stage,但这一版没过商店审核(先只给首方插件)
  'market.sources.err.stage-unapproved': {
    zh: '这一版插件要另起一份 Forsion 来演示和录屏，还没通过商店的这项审核，所以没有安装。',
    en: 'This version of the plugin starts a separate copy of Forsion for demos and recordings and hasn\'t passed the store\'s review for that yet, so it wasn\'t installed.',
  },
  'market.sources.err.npm-version': { zh: 'npm 上找不到目录写的那个版本。', en: 'The version named in the catalog isn\'t on npm.' },
  // 内置来源 skills.sh(2026-11-23):适配说明 / 详情读不到,技能包不合格
  'market.sources.err.collected-adapt-unavailable': { zh: '没读到这个技能的适配说明，这次没有安装，稍后再试。', en: 'Couldn\'t read this skill\'s adaptation notes, so it wasn\'t installed. Try again later.' },
  'market.sources.err.collected-adapt-mismatch': { zh: '适配说明和要装的提交对不上，这次没有安装，稍后再试。', en: 'The adaptation notes don\'t match the commit being installed, so it wasn\'t installed. Try again later.' },
  'market.sources.err.collected-detail-unavailable': { zh: '暂时读不到 Forsion 服务器上的收录详情，稍后再试。', en: 'Couldn\'t read the collected details from the Forsion server. Try again later.' },
  'market.sources.err.skill-invalid': { zh: '这个技能的 SKILL.md 缺少名称或说明，没有安装。', en: 'This skill\'s SKILL.md has no name or description, so it wasn\'t installed.' },
  'market.sources.err.destination-link': { zh: '这个技能的安装文件夹是指向别处的链接，为免改到别的文件夹，没有安装。', en: 'This skill\'s install folder is a link to somewhere else, so it wasn\'t installed to avoid changing that folder.' },
})

const ERROR_CODES: Array<[RegExp, string]> = [
  [/source: (fetch-failed|index-invalid|index-schema|index-missing|too-large|unrecognized|forsion-git-(?:unsupported|signin|no-access|needs-setup)|duplicate|state-unreadable|not-found)\b/, '$1'],
  [/resolve: (source-removed|source-item-removed|source-item-changed|address-not-allowed|version-unavailable|source-package-moved|collected-(?:adapt-unavailable|adapt-mismatch|detail-unavailable)|forsion-git-(?:unsupported|signin|no-access|needs-setup|ref-missing))\b/, '$1'],
  [/install: duplicate path in archive/, 'duplicate-path'],
  [/install: skill-invalid/, 'skill-invalid'],
  [/install: destination is a link/, 'destination-link'],
  [/install: plugin id taken/, 'plugin-id-taken'],
  [/install: internals-raw-unapproved/, 'internals-raw-unapproved'],
  [/install: stage-unapproved/, 'stage-unapproved'],
  [/install: package checksum mismatch/, 'checksum'],
  [/install: package commit mismatch/, 'commit'],
  [/install: package folder not found/, 'folder-missing'],
  [/resolve: npm version not found/, 'npm-version'],
]
/** 主进程原因码 → 文案;认不出返回 null(调用方用原文)。 */
export function sourceErrorText(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  // marketService 把 `resolve: …` 换成了本地化的句子,原因码原文留在 raw 上
  const msg = typeof e === 'string' ? e : (e as { raw?: string })?.raw || (e as Error)?.message || String(e)
  for (const [re, code] of ERROR_CODES) {
    const m = re.exec(msg)
    if (m) return t(`market.sources.err.${code.startsWith('$') ? m[1] : code}`)
  }
  return null
}
