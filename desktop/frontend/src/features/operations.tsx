import { Rocket, Workflow, ListTree } from 'lucide-react'
import { registerView } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { PublicView } from '../views/PublicView'
import { AutomationListView } from '../views/automation/AutomationListView'
import { AutomationDetailView } from '../views/automation/AutomationDetailView'
import { AutomationRunsView } from '../views/automation/AutomationRunsView'
import { AUTOMATION_WORKSPACE_MODE, registerAutomationListSource } from '../views/automation/automationListSource'
import { hasNativeFeature } from './runtime'
const app = () => useApp.getState()

export function registerOperationsViews(): void {
  // Public Space:管理已发布网站(Forsion Connect)+ 已公开发布/协作共享的笔记。档案点名 public 时注册。
  if (hasNativeFeature('public')) registerView({ type: 'public-view', kind: 'page', displayName: () => app().tr('view.publicHub'), icon: Rocket, factory: (props) => <PublicView {...props} />, singleton: true })
  // Automation 主区接原生工作区数据源；旧列表/运行 View ID 保留给用户已有布局;仅档案点名 automation 时注册。
  if (hasNativeFeature('automation')) {
    registerAutomationListSource()
    registerView({ type: 'automation-list', kind: 'collection', embeddable: true, displayName: () => app().tr('view.automationList'), icon: Workflow, factory: (props) => <AutomationListView {...props} />, singleton: true })
    registerView({ type: 'automation-detail', kind: 'page', workspaceSource: AUTOMATION_WORKSPACE_MODE, displayName: () => app().tr('view.automationDetail'), icon: Workflow, factory: (props) => <AutomationDetailView {...props} />, singleton: true })
    registerView({ type: 'automation-runs', kind: 'aux', displayName: () => app().tr('view.automationRuns'), icon: ListTree, factory: () => <AutomationRunsView />, singleton: true })
  }
}
