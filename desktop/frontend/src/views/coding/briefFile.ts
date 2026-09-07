import type { StudioBrief } from './projectBrief'
import { buildStudioPrompt } from './projectBrief'
import { isProjectRoot, joinProjectPath, projectName } from './studioModel'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'studio.briefFileUnavailable': { zh: '当前连接不支持保存项目需求。', en: 'This connection cannot save project briefs.' },
  'studio.briefFileUnsafe': { zh: '无法安全更新项目需求文件，请检查文件后重试。', en: 'The project brief cannot be updated safely. Check the file and try again.' },
  'studio.briefFileConflict': { zh: '项目需求文件已被其他操作修改，本次保存已停止。请检查磁盘版本后重试。', en: 'Another operation changed the project brief. Saving stopped. Review the disk version before trying again.' },
  'studio.briefFileFailed': { zh: '未收到项目需求文件保存成功的确认，请检查文件后重试。', en: 'The project brief save was not confirmed. Check the file and try again.' },
})
/** Portable project context, written with the same conflict-aware host file contract as the editor. */
export async function saveStudioBriefFile(root: string, brief: StudioBrief): Promise<void> {
  const host = window.tangu
  if (!host?.listDir || !host.readHostFile || !host.writeHostFile) throw new Error(translate('studio.briefFileUnavailable'))
  if (!isProjectRoot(root)) throw new Error(translate('studio.briefFileUnsafe'))
  const path = joinProjectPath(root, 'FORSION_BRIEF.md')
  const content = `# ${projectName(root)}\n\n${buildStudioPrompt(brief)}\n`
  const existing = (await host.listDir(root)).find(item => item.name === 'FORSION_BRIEF.md')
  if (existing?.isDir) throw new Error(translate('studio.briefFileUnsafe'))
  const current = existing ? await host.readHostFile(path) : null
  // A disappearing file / unavailable read must never degrade to a force write.
  if (existing && (!current || current.tooLarge || !Number.isFinite(current.mtimeMs))) throw new Error(translate('studio.briefFileUnsafe'))
  const result = await host.writeHostFile(path, content, current?.mtimeMs, !existing)
  if (result?.conflict) throw new Error(translate('studio.briefFileConflict'))
  if (result?.ok !== true || !Number.isFinite(result.mtimeMs)) throw new Error(translate('studio.briefFileFailed'))
}
