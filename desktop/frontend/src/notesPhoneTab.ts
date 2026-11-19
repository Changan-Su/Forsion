/** 手机笔记列表顶上那排分类胶囊(最近 / 文件夹 / 白板 / 标签)选的是哪一档,记在本机。 */
export const NOTES_PHONE_TABS = ['recent', 'tree', 'boards', 'tags'] as const
export type NotesPhoneTab = (typeof NOTES_PHONE_TABS)[number]

const KEY = 'forsion_notes_phone_tab'

/** 存的那一档。没选过、存的不是这几档之一(别的版本写的)、存储读不了 → null:调用方按有没有「最近」自己挑。 */
export function loadNotesPhoneTab(): NotesPhoneTab | null {
  try {
    const v = localStorage.getItem(KEY)
    return (NOTES_PHONE_TABS as readonly string[]).includes(v ?? '') ? (v as NotesPhoneTab) : null
  } catch { return null }
}

export function saveNotesPhoneTab(tab: NotesPhoneTab): void {
  try { localStorage.setItem(KEY, tab) } catch { /* 存不了:只管这一次 */ }
}
