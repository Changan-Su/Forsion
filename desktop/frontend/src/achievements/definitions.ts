/**
 * 成就系统 · 官方定义与纯函数。
 * 依赖铁律:本文件与 store.ts 只 import zustand/lucide-react,绝不 import appStore/i18n/amadeus——
 * 保证任何模块(含 amadeus 懒加载 chunk)都能单向引用 track() 而无 import 环。
 * 官方成就的标题/描述走 i18n 键 achievements.a.<id>.title/.desc(系列名 achievements.s.<id>);
 * 插件注册的系列用 def 里的字面量 title/desc(见 store.registerPluginSeries)。
 */
import type { LucideIcon } from 'lucide-react'
import {
  Bookmark, Bot, Compass, Crown, Database, FileText, Files, Image, Layers, Library,
  LogIn, MessageCircle, MessagesSquare, Palette, Send, Sparkles, Store, Users,
} from 'lucide-react'

export interface AchievementDef {
  id: string
  /** 计数事件名;官方用 `chat.send` 族,插件事件经 ctx 强制加 `plugin:<id>:` 前缀。 */
  event: string
  goal: number
  points: number
  icon?: LucideIcon
  /** 仅插件成就:字面量标题/描述(官方走 i18n)。 */
  title?: string
  desc?: string
}

export interface SeriesDef {
  id: string
  icon?: LucideIcon
  /** 仅插件系列:字面量名称。 */
  title?: string
  /** 铜/银/金勋章的「已领取点数」阈值;约定金 = 系列总点数。 */
  medals: { bronze: number; silver: number; gold: number }
  achievements: AchievementDef[]
}

export const OFFICIAL_SERIES: SeriesDef[] = [
  {
    id: 'starter', icon: Compass, medals: { bronze: 10, silver: 25, gold: 50 },
    achievements: [
      { id: 'first-login', event: 'account.login', goal: 1, points: 10, icon: LogIn },
      { id: 'theme-change', event: 'theme.change', goal: 1, points: 10, icon: Palette },
      { id: 'market-install', event: 'market.install', goal: 1, points: 15, icon: Store },
      { id: 'space-save', event: 'space.save', goal: 1, points: 15, icon: Bookmark },
    ],
  },
  {
    id: 'chat', icon: MessageCircle, medals: { bronze: 10, silver: 35, gold: 70 },
    achievements: [
      { id: 'first-message', event: 'chat.send', goal: 1, points: 10, icon: Send },
      { id: 'chat-10', event: 'chat.send', goal: 10, points: 15, icon: MessagesSquare },
      { id: 'chat-100', event: 'chat.send', goal: 100, points: 30, icon: Crown },
      { id: 'group-chat', event: 'chat.group', goal: 1, points: 15, icon: Users },
    ],
  },
  {
    id: 'notes', icon: FileText, medals: { bronze: 10, silver: 35, gold: 70 },
    achievements: [
      { id: 'first-note', event: 'note.create', goal: 1, points: 10, icon: FileText },
      { id: 'notes-10', event: 'note.create', goal: 10, points: 15, icon: Files },
      { id: 'notes-100', event: 'note.create', goal: 100, points: 30, icon: Library },
      { id: 'first-base', event: 'base.create', goal: 1, points: 15, icon: Database },
    ],
  },
  {
    id: 'agents', icon: Bot, medals: { bronze: 15, silver: 30, gold: 60 },
    achievements: [
      { id: 'first-agent', event: 'agent.create', goal: 1, points: 15, icon: Bot },
      { id: 'agents-3', event: 'agent.create', goal: 3, points: 20, icon: Layers },
      { id: 'special-agent', event: 'special.enable', goal: 1, points: 15, icon: Sparkles },
      { id: 'first-image', event: 'image.generate', goal: 1, points: 10, icon: Image },
    ],
  },
]

export type MedalTier = 'bronze' | 'silver' | 'gold'

/** 系列内「已领取」成就的点数合计(勋章只认领取,不认达成)。 */
export function seriesPoints(s: SeriesDef, claimed: Record<string, true>): number {
  return s.achievements.reduce((sum, a) => sum + (claimed[a.id] ? a.points : 0), 0)
}

export function medalTier(s: SeriesDef, pts: number): MedalTier | null {
  if (pts >= s.medals.gold) return 'gold'
  if (pts >= s.medals.silver) return 'silver'
  if (pts >= s.medals.bronze) return 'bronze'
  return null
}
