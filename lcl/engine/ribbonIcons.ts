/** Ribbon 图标选择表:收纳夹 / 钉进命令区的命令 可从这里挑自定义图标(存图标名字符串)。
 *  刻意精选(≈ userSpaces 的 SPACE_ICONS 先例),**不做 lucide 全量动态查找**(bundle 爆炸)。 */
import {
  Folder, FolderOpen, Star, Heart, Home, Zap, Bookmark, Bell, Tag, Flag, Pin, Box, Package,
  Settings, Wrench, Terminal, Code, FileText, Image, Music, Video, Camera, Globe, Compass,
  Map, Calendar, Clock, Mail, MessageCircle, Users, User, Search, Filter, Sparkles, Rocket,
  Target, Trophy, Lightbulb, Coffee, Palette, Layers, Database, PenTool, Inbox, Bot, Command, Moon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const RIBBON_ICONS: Record<string, LucideIcon> = {
  folder: Folder, 'folder-open': FolderOpen, star: Star, heart: Heart, home: Home, zap: Zap,
  bookmark: Bookmark, bell: Bell, tag: Tag, flag: Flag, pin: Pin, box: Box, package: Package,
  settings: Settings, wrench: Wrench, terminal: Terminal, code: Code, 'file-text': FileText,
  image: Image, music: Music, video: Video, camera: Camera, globe: Globe, compass: Compass,
  map: Map, calendar: Calendar, clock: Clock, mail: Mail, 'message-circle': MessageCircle,
  users: Users, user: User, search: Search, filter: Filter, sparkles: Sparkles, rocket: Rocket,
  target: Target, trophy: Trophy, lightbulb: Lightbulb, coffee: Coffee, palette: Palette,
  layers: Layers, database: Database, 'pen-tool': PenTool, inbox: Inbox, bot: Bot, command: Command, moon: Moon,
}

export const RIBBON_ICON_NAMES: string[] = Object.keys(RIBBON_ICONS)

/** 图标名 → 组件;认不出(或空)回 undefined,调用方各自回落默认图标。 */
export const iconByName = (name?: string): LucideIcon | undefined => (name ? RIBBON_ICONS[name] : undefined)
