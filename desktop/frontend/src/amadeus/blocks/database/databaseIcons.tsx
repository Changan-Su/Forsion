/** One optical family for database properties, views and menu actions. Plugin icons remain theirs. */
import {
  AlignLeft, Hash, SquareCheck, CalendarDays, CircleDot, ListChecks, Link, FileText,
  Paperclip, Sigma, ArrowRightLeft, UserRound, Clock3, Table2, List, Columns3, Images,
  ChartColumn, ClipboardList, ChartGantt, ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  Check, Square, ChevronRight, Copy, Trash2, Filter, Eraser, Plus, Eye, EyeOff, GripVertical, FolderOpen,
  FoldVertical, type LucideIcon,
} from 'lucide-react'

const icons: Record<string, LucideIcon> = {
  text: AlignLeft, number: Hash, checkbox: SquareCheck, todo: SquareCheck,
  date: CalendarDays, calendarDate: CalendarDays, select: CircleDot, multiselect: ListChecks,
  url: Link, page: FileText, relation: FileText, rowlink: Link, file: Paperclip,
  formula: Sigma, lookup: ArrowRightLeft, autonumber: Hash, created: Clock3, updated: Clock3, person: UserRound,
  table: Table2, list: List, kanban: Columns3, calendar: CalendarDays, gallery: Images,
  chart: ChartColumn, form: ClipboardList, gantt: ChartGantt,
  sortAsc: ArrowUp, sortDesc: ArrowDown, moveLeft: ArrowLeft, moveRight: ArrowRight,
  check: Check, unchecked: Square, checked: SquareCheck, submenu: ChevronRight,
  duplicate: Copy, delete: Trash2, filter: Filter, clear: Eraser, add: Plus, columns: Columns3,
  fold: FoldVertical, visible: Eye, hidden: EyeOff, grip: GripVertical, moveUp: ArrowUp, moveDown: ArrowDown, folder: FolderOpen,
}

export function dbIcon(name: string) {
  const Icon = icons[name] ?? FileText
  return <Icon className="amx-db-glyph" size={14} strokeWidth={1.7} aria-hidden="true" />
}
