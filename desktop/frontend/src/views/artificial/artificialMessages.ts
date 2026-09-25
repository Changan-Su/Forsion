/**
 * 造物(Creations)Space 的文案片段。Space / 视图名本身是**基础字典**里的
 * `space.artificial` / `view.artificial` / `view.product`(i18n.tsx),这里只放本 Space 自己的文案。
 *
 * ⚠️下面的参数必须是**内联对象字面量**:i18nCoverage 的片段解析器是「找到这个函数的调用处,
 * 从它之后的第一个 `{` 起括号配平再 eval」,传变量或拼接会让它 eval 失败 → 整片键被静默跳过
 * → 英文界面照样渲染中文,而 A/B 断言看不见(C 断言会把它们全报成缺键)。
 * ⚠️同理:**本文件的注释里不要再出现那个函数名加左括号的写法** —— 解析器按首次出现定位,
 * 会从注释里那一处开始配平(实测:整片词条就这样被跳过一次)。
 */
import { registerMessages } from '../../i18n'

registerMessages({
  'artificial.builtinDesc': {
    zh: '造物 Space:集中管理这台电脑上做出来的网页应用与插件 —— 启动、加到桌面,或回编码工作室继续改。',
    en: 'Creations Space: everything you have built on this machine in one place — launch it, add it to the desktop, or reopen it in the studio.',
  },
  'artificial.subtitle': { zh: '你在编码工作室里做出来的东西都在这里', en: 'Everything you built in the Coding Studio lives here' },
  'artificial.refresh': { zh: '刷新', en: 'Refresh' },
  'artificial.loading': { zh: '正在读取本机作品…', en: 'Looking for your creations…' },
  'artificial.loadFailed': { zh: '读取作品列表失败', en: 'Could not read your creations' },
  'artificial.empty.title': { zh: '还没有作品', en: 'Nothing here yet' },
  'artificial.empty.body': {
    zh: '在编码工作室里做出来的网页应用和插件会出现在这里,可以随时启动、加到桌面或继续修改。',
    en: 'Web apps and plugins you build in the Coding Studio show up here, ready to launch, add to the desktop, or keep editing.',
  },
  'artificial.empty.cta': { zh: '去编码工作室', en: 'Open the Coding Studio' },
  // 种类表(productKinds)的标签:分组标题与卡片图标共用同一条词条。
  'artificial.kind.web': { zh: '网页应用', en: 'Web apps' },
  'artificial.kind.plugin': { zh: '插件', en: 'Plugins' },
  'artificial.kind.unknown': { zh: '其他作品', en: 'Other creations' },
  'artificial.badge.published': { zh: '已发布', en: 'Published' },
  'artificial.badge.devLoad': { zh: '已加载(开发)', en: 'Loaded (dev)' },
  'artificial.action.open': { zh: '打开 {name}', en: 'Open {name}' },
  'artificial.action.openWindow': { zh: '在独立窗口中打开', en: 'Open in a new window' },
  'artificial.action.edit': { zh: '继续编辑', en: 'Continue editing' },
  'artificial.action.shortcut': { zh: '添加到桌面', en: 'Add to desktop' },
  'artificial.action.reveal': { zh: '在文件管理器中显示', en: 'Show in folder' },
  'artificial.action.rename': { zh: '重命名', en: 'Rename' },
  'artificial.action.trash': { zh: '移到废纸篓', en: 'Move to trash' },
  'artificial.action.more': { zh: '更多操作 · {name}', en: 'More actions for {name}' },
  'artificial.rename.title': { zh: '重命名作品', en: 'Rename creation' },
  'artificial.rename.label': { zh: '只改显示名称,不动项目文件夹', en: 'Changes the display name only; the project folder keeps its name' },
  'artificial.trash.confirm': {
    zh: '把「{name}」移到系统废纸篓?整个项目文件夹都会被移走,之后可以从废纸篓里找回。',
    en: 'Move “{name}” to the system trash? The whole project folder goes with it, and you can restore it from the trash.',
  },
  // 落盘产物命名:作品名清洗完为空时,桌面快捷方式用的文件名(跟随当前界面语言)。
  'artificial.shortcut.fallbackName': { zh: 'Forsion 应用', en: 'Forsion app' },
  'artificial.toast.shortcutOk': { zh: '已添加到桌面', en: 'Added to desktop' },
  'artificial.toast.shortcutUnpackaged': { zh: '桌面快捷方式只在安装版里可用(开发模式下不生成)', en: 'Desktop shortcuts only work in the installed app, not in development mode' },
  'artificial.toast.shortcutFailed': { zh: '添加到桌面失败:{detail}', en: 'Could not add to desktop: {detail}' },
  'artificial.toast.renameFailed': { zh: '重命名失败:{detail}', en: 'Could not rename: {detail}' },
  'artificial.toast.trashFailed': { zh: '移到废纸篓失败:{detail}', en: 'Could not move to trash: {detail}' },
  // 产物视图(product)
  'artificial.product.loading': { zh: '正在启动作品…', en: 'Starting your creation…' },
  'artificial.product.gone': { zh: '这个作品已不存在,或者被移走了', en: 'This creation no longer exists or was moved' },
  'artificial.product.failed': { zh: '作品没能启动', en: 'This creation could not start' },
  // 永久性拒绝(主进程:product has no web entry):重试没有意义,文案要说清「这一类作品」就是这样。
  'artificial.product.unservable': { zh: '这类作品不能当成网页打开', en: 'This kind of creation cannot open as a page' },
  'artificial.product.unservableBody': {
    zh: '插件这类作品没有网页入口,不会在这里跑起来。可以回编码工作室继续修改它,或者在「设置 → Forsion 插件」里装上使用。',
    en: 'Creations like plugins have no web entry, so they never run here. Reopen it in the Coding Studio to keep editing, or install it from Settings → Forsion plugins to use it.',
  },
  'artificial.product.reload': { zh: '重新加载', en: 'Reload' },
  'artificial.product.openExternal': { zh: '用系统浏览器打开', en: 'Open in system browser' },
})
