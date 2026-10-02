import { Clock3, FolderOpen, LayoutGrid, Plus, Shapes } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useLaunchNavigation } from './launchpadNavigation'
import './launchpadMessages'
import './codingNavigation.css'

/** Initial Coding Space navigation, housed in the native left View slot. */
export function CodingNavigationView() {
  const { t } = useI18n()
  const page = useLaunchNavigation(s => s.page)
  const filter = useLaunchNavigation(s => s.filter)
  const showProjects = useLaunchNavigation(s => s.showProjects)
  const showCreate = useLaunchNavigation(s => s.showCreate)
  const showGallery = useLaunchNavigation(s => s.showGallery)
  return <nav className="csn" aria-label={t('csl.navigation')}>
    {/* 侧栏顶不再写「编码工作室」:标签已经是这个名字(10-02 用户拍板 v6)。 */}
    <div className="csn-section"><span className="csn-heading">{t('csl.navBuild')}</span>
      <button type="button" className="csn-item" aria-current={page === 'create' ? 'page' : undefined} onClick={showCreate}><Plus size={16} />{t('csl.newProject')}</button>
      <button type="button" className="csn-item" aria-current={page === 'projects' && filter === 'all' ? 'page' : undefined} onClick={() => showProjects()}><LayoutGrid size={16} />{t('csl.projects')}</button>
      <button type="button" className="csn-item" aria-current={page === 'gallery' ? 'page' : undefined} onClick={showGallery}><Shapes size={16} />{t('csl.gallery')}</button>
    </div>
    <div className="csn-section"><span className="csn-heading">{t('csl.navBrowse')}</span>
      <button type="button" className="csn-item" aria-current={page === 'projects' && filter === 'recent' ? 'page' : undefined} onClick={() => showProjects('recent')}><Clock3 size={16} />{t('csl.filter.recent')}</button>
      <button type="button" className="csn-item" aria-current={page === 'projects' && filter === 'imported' ? 'page' : undefined} onClick={() => showProjects('imported')}><FolderOpen size={16} />{t('csl.filter.imported')}</button>
    </div>
  </nav>
}
