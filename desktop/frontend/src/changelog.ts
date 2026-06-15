/**
 * 应用内「最新更新」(关于页展示)。维护方式:每次有用户可感知的版本变化,在顶部加一条。
 * 与 docs/Log 的开发日志分工:这里是面向用户的精炼 What's New,中英双语。
 */
export interface ChangelogEntry {
  version: string
  date: string // YYYY-MM-DD
  zh: string[]
  en: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.0.1',
    date: '2026-06-15',
    zh: [
      '本地图片识别:AI 可查看工作区里或拖入的图片(view_image 工具),聊天内显示图片缩略图',
      '新增开发者模式:在「关于」连点版本号 10 次解锁,可编辑 Forsion 云端地址、重新进入引导',
      '首启引导新增「选择主题」与「默认本地文件夹」两步;引导不再要求填写云端地址',
      '默认主题改为 Qbird 浅色;语言与深浅模式切换移至右上角',
      '账号卡片改用统一用户卡片样式,正确显示头像与会员等级',
    ],
    en: [
      'Local image recognition: the AI can view images in the workspace or dropped in (view_image tool); thumbnails shown in chat',
      'New developer mode: tap the version 10× in About to unlock — edit the Forsion cloud URL and re-run onboarding',
      'Onboarding adds theme and default-folder steps; it no longer asks for the cloud URL',
      'Default theme is now Qbird Light; language & light/dark toggles moved to the top-right',
      'Account card now uses the unified profile card with avatar and membership tier',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-06-15',
    zh: [
      '新增中英文界面切换(默认中文),侧栏左下角与设置内均可切换',
      '设置新增「关于」页:版本号与更新日志',
      'Forsion 账号登录移至侧栏左下角(头像/昵称,点击进入个人中心);不登录也能正常使用',
      '模型 / Provider 在设置与模型选择器中按 Provider 分组,默认折叠',
      '工作区支持重命名 / 新建文件夹 / 在文件管理器中显示 / 删除到回收站 / 拖出',
      '修复:工具调用偶发结束循环(文本工具调用解析加固);流式输出时上滑不再被强制拽回底部',
    ],
    en: [
      'Bilingual UI (Chinese default); switch from the sidebar footer or Settings',
      'New "About" page in Settings: version and changelog',
      'Forsion sign-in moved to the sidebar footer (avatar/nickname → account center); works fine without signing in',
      'Models / providers are grouped by provider (collapsed by default) in Settings and the model picker',
      'Workspace: rename / new folder / reveal in file manager / move to trash / drag out',
      'Fixes: tool calls no longer occasionally end the loop; scrolling up during streaming is no longer yanked back to the bottom',
    ],
  },
]
