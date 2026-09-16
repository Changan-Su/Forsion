import { FileText, Database, PenTool, LayoutDashboard, FileImage, FileVideo, Link2, Search, Hash, Waypoints } from 'lucide-react'
import { registerView } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { translate } from '../i18n'
import { AmadeusEditorView, AmadeusBacklinksView, NoteTabIcon } from '../amadeusViews'
import { AmadeusDbView } from '../views/AmadeusDbView'
import { AmadeusDrawingView } from '../views/AmadeusDrawingView'
import { DashboardView } from '../views/DashboardView'
import { AmadeusPluginFileView } from '../views/AmadeusPluginFileView'
import { AmadeusPdfView } from '../views/AmadeusPdfView'
import { AmadeusImageView } from '../views/AmadeusImageView'
import { AmadeusMediaView } from '../views/AmadeusMediaView'
import { AmadeusSearchView, AmadeusTagsView, AmadeusLocalGraphView } from '../amadeusPanels'
import { VIEW_FILE_MATCH } from '../viewFileMatch'
import { amadeusAvailable } from './runtime'
const app = () => useApp.getState()

/** Editor helpers share compiled implementations; their package grants activation. */
export function registerAmadeusViews(): void {
  // Amadeus Space:原生可停靠视图(左 笔记列表 / 主 编辑器 / 右 大纲+反链),共享 pageStore。
  // Amadeus 依赖 electron 预载的 window.amadeus 文件系统桥;Tangu Web(无 host)下缺省 → 整个 Space 不注册,
  // 与 market/feedback 的 window.tangu?.X 门控同纪律。否则视图挂载即 deref undefined amadeus 崩溃。
  if (amadeusAvailable()) {
    // 笔记库/大纲已并入统一的 workspace/outline 视图(见上);Amadeus 专属侧视图保留。
    // 编辑器 = 非 singleton 多实例(类 Obsidian 每笔记一个 tab,params.notePath 认领笔记并随布局持久化);
    // 可关闭:关到主区最后一个 → 落 launcher 启动器(见 workspaceStore.closeLeaf)。
    registerView({
      type: 'amadeus-editor', kind: 'entity', embeddable: true, idParam: 'notePath', fileMatch: VIEW_FILE_MATCH['amadeus-editor'],
      displayName: () => app().tr('amadeus.editor'), icon: FileText, TabIcon: NoteTabIcon, factory: (props) => <AmadeusEditorView {...props} />,
      dashboard: { sizes: ['lg', 'full', 'workspace'], defaultSize: 'workspace', surface: 'workspace' },
    })
    // 独立 .db 数据库视图(多实例,params.dbPath 认领文件并随布局持久化;树上点 .db 打开,见 amadeusNav.openDb)。
    registerView({
      type: 'amadeus-db', kind: 'entity', embeddable: true, idParam: 'dbPath', fileMatch: VIEW_FILE_MATCH['amadeus-db'],
      displayName: () => app().tr('view.db'), icon: Database, factory: (props) => <AmadeusDbView {...props} />,
      dashboard: { sizes: ['lg', 'full', 'workspace'], defaultSize: 'workspace', surface: 'workspace' },
    })
    // 独立白板视图(多实例,params.drawingPath 认领文件;树上点 .excalidraw.md / 笔记里点 [[X.excalidraw]] 打开,见 amadeusNav.openDrawing)。
    registerView({
      type: 'amadeus-drawing', kind: 'entity', embeddable: true, idParam: 'drawingPath', fileMatch: VIEW_FILE_MATCH['amadeus-drawing'],
      displayName: () => app().tr('view.drawing'), icon: PenTool, factory: (props) => <AmadeusDrawingView {...props} />,
      dashboard: { sizes: ['full', 'workspace'], defaultSize: 'workspace', surface: 'workspace' },
    })
    // 仪表盘:.dashboard.md 一律开进 DashboardView,由它按文件里的 `dashLayout:` 分派 ——
    // 缺省 = 结构化网格(dashboard3:,2026-08-27 拍板的默认),`canvas` = 自由摆位(dashboard2:)。
    // 文件仍是一份合法笔记(布局都在外来 frontmatter 键里),掉进笔记编辑器也不会坏。
    registerView({ type: 'dashboard', kind: 'entity', idParam: 'dashPath', fileMatch: VIEW_FILE_MATCH['dashboard'], displayName: () => translate('bootengine.view.dashboard'), icon: LayoutDashboard, factory: (props) => <DashboardView {...props} /> })
    // 旧网格版 view **已移除**(用户拍板:旧 UI 不能留着让人看到)。已存布局里的 amadeus-dashboard
    // panel 由 layoutViewsAllRegistered 整份回退 → 该 Space 按新配方重建,文件本身不受影响
    // (.dashboard.md 照旧被新画布版认领,旧布局键 dashboard: 也原样留在文件里当回滚保险)。
    // 独立 PDF 视图(多实例,params.pdfPath 认领文件;树上点 .pdf / 笔记里点 [[x.pdf#page=N]] 打开,见 amadeusNav.openPdf)。
    registerView({
      type: 'amadeus-pdf', kind: 'entity', embeddable: true, idParam: 'pdfPath', fileMatch: VIEW_FILE_MATCH['amadeus-pdf'],
      displayName: () => 'PDF', icon: FileText, factory: (props) => <AmadeusPdfView {...props} />,
      dashboard: { sizes: ['lg', 'full', 'workspace'], defaultSize: 'workspace', surface: 'workspace' },
    })
    // 独立图片视图(多实例,params.imagePath 认领文件;树上点 .png/.jpg 等打开,见 amadeusNav.openImage)。
    registerView({ type: 'amadeus-image', kind: 'entity', embeddable: true, idParam: 'imagePath', fileMatch: VIEW_FILE_MATCH['amadeus-image'], displayName: () => translate('bootengine.view.image'), icon: FileImage, factory: (props) => <AmadeusImageView {...props} /> })
    // 独立音视频视图(多实例,params.path 认领文件;聊天里的时刻引用条 `[[a.mp4#t=95]]`、
    // 笔记里点了但本页没播放器的媒体锚,见 amadeusNav.openMedia)。
    // ⚠️ 刻意**不给 fileMatch**:openFile 里的 extHit 排在插件 matchFileType **之前**,认领了
    //    `.mp4` 就抢掉插件对音视频的认领(方案「媒体锚点」§6 不变式 5)。树上双击照旧交系统播放器。
    registerView({ type: 'amadeus-media', kind: 'entity', embeddable: true, idParam: 'path', displayName: () => translate('bootengine.view.media'), icon: FileVideo, factory: (props) => <AmadeusMediaView {...props} /> })
    // 通用「插件文件类型」视图(多实例,params.filePath 认领文件;树上点插件声明的文件类型 / 笔记里点
    // ![[x.ext]] 打开,见 amadeusNav.openFile + 插件的 ctx.registerFileType)。一个视图服务所有插件文件类型。
    registerView({ type: 'amadeus-plugin-file', kind: 'entity', idParam: 'filePath', displayName: () => translate('bootengine.view.pluginFile'), icon: FileText, factory: (props) => <AmadeusPluginFileView {...props} /> })
    registerView({ type: 'amadeus-backlinks', kind: 'aux', displayName: () => app().tr('amadeus.backlinks'), icon: Link2, factory: () => <AmadeusBacklinksView />, singleton: true })
    registerView({ type: 'amadeus-search', kind: 'collection', embeddable: true, displayName: () => app().tr('amadeus.search'), icon: Search, factory: () => <AmadeusSearchView />, singleton: true })
    registerView({ type: 'amadeus-tags', kind: 'collection', embeddable: true, displayName: () => app().tr('amadeus.tags'), icon: Hash, factory: () => <AmadeusTagsView />, singleton: true })
    registerView({ type: 'amadeus-graph', kind: 'aux', displayName: () => app().tr('amadeus.graph'), icon: Waypoints, factory: () => <AmadeusLocalGraphView />, singleton: true })
    // Calendar Space 的三个视图已随「日历」内置插件走(builtins/calendar):随插件启停注册/反注册。
    // 仪表盘紧凑卡面(dashboard 契约)也在那里声明 —— 契约跟注册点走,别在这儿补。
  }

}
