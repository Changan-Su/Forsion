/** 主区空态占位:关掉最后一个主区 tab 后,closeLeaf 就地把该 leaf 变成它(不 close→addPanel,
 *  免主区组销毁导致侧栏回流+卡顿)。Forsion 品牌图 + 「新建」按钮(复用 ＋ 新建逻辑:有 newPage 走
 *  newPage,否则就地开 launcher 启动器)。tab 用 wb-tab--empty → 整组只剩它时 tab 条隐藏(见 engine.css,
 *  与 sidebar-empty 同机关),呈现为纯背景空态。 */
import { Plus } from 'lucide-react'
import { BrandLogo } from '../components/BrandLogo'
import { getActiveSpace, useWorkspace } from '@lcl/engine'
import { useI18n } from '../i18n'

export function HomeEmptyView() {
  const { t } = useI18n()
  const newPage = (): void => {
    const sp = getActiveSpace()
    if (sp?.newPage) sp.newPage()
    else useWorkspace.getState().openView('launcher', {}, 'main') // 就地把本占位变成启动器(不新开 tab)
  }
  return (
    <div className="wb-home">
      <div className="wb-home-mark"><BrandLogo size={72} /></div>
      <button className="wb-home-new" onClick={newPage}>
        <Plus size={16} /> {t('newtab.title')}
      </button>
    </div>
  )
}
