import type { ViewProps } from '@lcl/engine'
import { WorkspaceView } from '../WorkspaceView'
import { AUTOMATION_WORKSPACE_MODE } from './automationListSource'

/** Compatibility for saved layouts that still refer to automation-list. */
export function AutomationListView(props: ViewProps) {
  return <WorkspaceView {...props} defaultMode={AUTOMATION_WORKSPACE_MODE} />
}
