import React from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceHost } from '../../../lcl/engine/WorkspaceHost'
import { registerView } from '../../../lcl/engine/viewRegistry'
import { useWorkspace, bootLayoutFellThrough, LAYOUT_KEY } from '../../../lcl/engine/dockviewStore'
import { layoutCoordinator } from '../../../lcl/engine/layoutCoordinator'
import { computeDropTarget } from '../../../lcl/engine/dropModel'
import '../../../lcl/engine/engine.css'
import '../../frontend/src/styles/base.css'
import '../../frontend/src/theme/themes/soft/theme.css'
import '../../frontend/src/theme/themes/genesis-glass/theme.css'
const content = (id: string) => <div className="probe-content"><h2>{id === 'document' ? 'Layout coordination' : id === 'canvas' ? 'Reading surface' : 'Workspace'}</h2><textarea aria-label="Draft" defaultValue="An unfinished draft stays here."/><div className="probe-scroll">{Array.from({length: 70}, (_,i) => <p key={i}>Paragraph {i + 1} · Views share the available space while retaining their reading position.</p>)}</div>{id === 'document' && <iframe title="Embedded state" srcDoc="<body>Embedded preview<script>window.bootId=Math.random()</script></body>"/>}</div>
for (const id of ['document', 'canvas', 'nav', 'launcher', 'sidebar-empty']) registerView({ type: id, displayName: id, factory: () => content(id) })
// A sidebar View that needs more height than Main + bottom: its column must not cap the bottom panel's room.
registerView({ type: 'tall', displayName: 'tall', factory: () => content('tall'), layout: { minHeight: 560 } })
// Same order as bootstrapEngine: the Space's sidebar profile is set before Dockview is ready, so a restored
// layout (the ordinary restart path, which skips buildDefault) still reads the remembered widths.
useWorkspace.getState().setSidebarDefaults({left:[{type:'nav',params:{}}],right:[{type:'nav',params:{}}],bottom:[]})
useWorkspace.getState().setSideProfile('layout-probe', {}, {})
const build = () => {
 const ws = useWorkspace.getState()
 ws.openView('document', {}, 'main', {newTab:true}); ws.splitActive('right', {}); const p=ws.api!.activePanel!; ws.navigateLeaf(p.id, 'canvas')
 ws.openView('nav', {}, 'left'); ws.openView('nav', {}, 'right')
}
;(window as any).probe = { ws: useWorkspace, coordinator: () => layoutCoordinator(useWorkspace.getState().api), computeDropTarget, bootFellThrough: bootLayoutFellThrough, layoutKey: LAYOUT_KEY }
createRoot(document.getElementById('root')!).render(<div className="probe-shell"><aside className="probe-ribbon">F</aside><main><header>Forsion · Layout coordination</header><section><WorkspaceHost dark={false} soft={false} buildDefault={build}/></section><footer>Status</footer></main></div>)
