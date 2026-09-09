import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_FEATURE_IDS, isNativeFeatureId, nativeFeatureEnabled, nativeFeatureSpaceIds, type NativeFeatureId } from '../../../shared/nativeFeatures'

const state = vi.hoisted(() => ({
  profile: { spaces: ['tangu', 'amadeus', 'calendar', 'automation', 'public'], nativeFeatures: [] as NativeFeatureId[] | undefined },
  views: new Map<string, unknown>(),
}))
vi.mock('../product', () => ({ PRODUCT: state.profile }))
vi.mock('@lcl/engine', () => ({
  registerView: (view: { type: string }) => state.views.set(view.type, view),
  registerSpace: vi.fn(), unregisterSpace: vi.fn(), addRibbonIcon: vi.fn(), removeRibbonIcon: vi.fn(),
  setActiveSpace: vi.fn(), useSpaceStore: { getState: () => ({ spaces: [] }) }, useWorkspace: { getState: () => ({}) },
  Skeleton: () => null,
}))
vi.mock('../stores/appStore', () => ({ useApp: { getState: () => ({ tr: (key: string) => key }) } }))
vi.mock('../components/SpaceButton', () => ({ SpaceButton: () => null }))
vi.mock('../views/DashboardCompactViews', () => ({ CalendarDashboardCard: () => null, TodoDashboardCard: () => null }))
vi.mock('../views/ChatView', () => ({ ChatView: () => null }))
vi.mock('../views/RightViews', () => ({ MemoryPanelView: () => null, SubchatsView: () => null, SessionFilesView: () => null }))
vi.mock('../views/SpecialViews', () => ({ AgentsDetailSpecialView: () => null, WorkspaceDetailSpecialView: () => null }))
vi.mock('../amadeusViews', () => ({ AmadeusEditorView: () => null, AmadeusBacklinksView: () => null, NoteTabIcon: () => null }))
vi.mock('../views/AmadeusDbView', () => ({ AmadeusDbView: () => null }))
vi.mock('../views/AmadeusDrawingView', () => ({ AmadeusDrawingView: () => null }))
vi.mock('../views/DashboardView', () => ({ DashboardView: () => null }))
vi.mock('../views/AmadeusPluginFileView', () => ({ AmadeusPluginFileView: () => null }))
vi.mock('../views/AmadeusPdfView', () => ({ AmadeusPdfView: () => null }))
vi.mock('../views/AmadeusImageView', () => ({ AmadeusImageView: () => null }))
vi.mock('../views/AmadeusMediaView', () => ({ AmadeusMediaView: () => null }))
vi.mock('../amadeusPanels', () => ({ AmadeusSearchView: () => null, AmadeusTagsView: () => null, AmadeusLocalGraphView: () => null }))
vi.mock('../views/PublicView', () => ({ PublicView: () => null }))
vi.mock('../views/automation/AutomationListView', () => ({ AutomationListView: () => null }))
vi.mock('../views/automation/AutomationDetailView', () => ({ AutomationDetailView: () => null }))
vi.mock('../views/automation/AutomationRunsView', () => ({ AutomationRunsView: () => null }))

import { registerAmadeusViews } from './amadeus'
import { registerTanguViews } from './tangu'
import { registerOperationsViews } from './operations'
import { installCalendarViews } from '../builtins/calendar'
import { amadeusAvailable, miniFeatureAvailable, sessionsAvailable } from './runtime'
const register = () => { registerAmadeusViews(); registerTanguViews(); registerOperationsViews(); installCalendarViews() }

beforeEach(() => {
  state.views.clear()
  state.profile.nativeFeatures = []
  vi.stubGlobal('window', { amadeus: {} })
})

describe('native package contribution boundary', () => {
  it('does not activate any business view from a full product profile or a plugin-data bridge alone', () => {
    register()
    expect([...state.views.keys()]).toEqual([])
    expect(amadeusAvailable()).toBe(false)
    expect(sessionsAvailable()).toBe(false)
    expect(NATIVE_FEATURE_IDS.every((id) => !miniFeatureAvailable(id))).toBe(true)
  })

  it('installs only Tangu views when only its package is present', () => {
    state.profile.nativeFeatures = ['tangu']
    register()
    expect(state.views.has('chat')).toBe(true)
    expect(state.views.has('chat-panel')).toBe(true)
    expect(state.views.has('amadeus-editor')).toBe(false)
    expect(state.views.has('calendar')).toBe(false)
    expect(state.views.has('automation-detail')).toBe(false)
    expect(state.views.has('public-view')).toBe(false)
    expect(sessionsAvailable()).toBe(true)
  })

  it('adds and removes Calendar independently of Amadeus between page boots', () => {
    state.profile.nativeFeatures = ['amadeus', 'calendar']
    register()
    expect(state.views.has('amadeus-editor')).toBe(true)
    expect(state.views.has('dashboard')).toBe(true)
    expect(state.views.has('calendar')).toBe(true)
    expect(state.views.has('todo-list')).toBe(true)
    expect(state.views.has('chat')).toBe(false)
    state.views.clear()
    state.profile.nativeFeatures = ['amadeus']
    register()
    expect(state.views.has('amadeus-editor')).toBe(true)
    expect(state.views.has('calendar')).toBe(false)
    expect(state.views.has('calendar-config')).toBe(false)
  })

  it('requires the Amadeus bridge and contribution before Calendar can activate', () => {
    state.profile.nativeFeatures = ['calendar']
    register()
    expect(state.views.size).toBe(0)
    state.profile.nativeFeatures = ['amadeus', 'calendar']
    vi.stubGlobal('window', {})
    register()
    expect(state.views.size).toBe(0)
  })

  it('separates automation and publishing from Tangu view activation', () => {
    state.profile.nativeFeatures = ['automation', 'public']
    register()
    expect([...state.views.keys()].sort()).toEqual(['automation-detail', 'automation-list', 'automation-runs', 'public-view'])
    expect(sessionsAvailable()).toBe(false)
  })

  it('preserves existing desktop product behavior when there is no explicit installation list', () => {
    state.profile.nativeFeatures = undefined
    register()
    expect(state.views.has('chat')).toBe(true)
    expect(state.views.has('amadeus-editor')).toBe(true)
    expect(state.views.has('calendar')).toBe(true)
    expect(state.views.has('public-view')).toBe(true)
    expect(sessionsAvailable()).toBe(true)
    expect(miniFeatureAvailable('amadeus')).toBe(true)
  })

  it('provides stable Space identities and never lets legacy flags bypass an explicit empty list', () => {
    expect(nativeFeatureSpaceIds(['amadeus', 'calendar', 'amadeus'])).toEqual(['amadeus', 'calendar'])
    expect(isNativeFeatureId('server-admin')).toBe(false)
    expect(isNativeFeatureId('amadeus')).toBe(true)
    expect(nativeFeatureEnabled({ spaces: ['tangu'], nativeFeatures: [] }, 'tangu', true)).toBe(false)
    expect(nativeFeatureEnabled({ spaces: ['tangu'] }, 'tangu')).toBe(true)
  })
})
