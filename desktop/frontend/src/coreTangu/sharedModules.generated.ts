// 生成文件,别手改:cd desktop && node scripts/build-tangu-ui.mjs --write-table(界面热更新 4a)。
// Tangu 界面包在打包版里向宿主要的全部模块(键 = 包里 require 的参数);宿主这里逐个 import,
// 不静态引 Tangu 时它们也还在宿主产物里。共享规则见 scripts/build-tangu-ui.mjs 文件头。
/* eslint-disable */
import * as m0 from 'framer-motion'
import * as m1 from '@/achievements/store'
import * as m2 from '@/agentName'
import * as m3 from '@amadeus/blocks/sketch/format'
import * as m4 from '@amadeus/chrome/pageChrome'
import * as m5 from '@amadeus/components/Dialogs'
import * as m6 from '@amadeus/components/askString'
import * as m7 from '@amadeus/components/icons'
import * as m8 from '@amadeus/freshNote'
import * as m9 from '@amadeus/lib/fuzzy'
import * as m10 from '@amadeus/lib/treeIndent'
import * as m11 from '@amadeus/plugins/deskCompanion'
import * as m12 from '@amadeus/plugins/display'
import * as m13 from '@amadeus/plugins/pluginStore'
import * as m14 from '@amadeus/plugins/summaryCards'
import * as m15 from '@amadeus/plugins/tanguSeam'
import * as m16 from '@amadeus/store/pageStore'
import * as m17 from '@amadeus/unified/canvasKit/index'
import * as m18 from '@amadeus/unified/lifecycle'
import * as m19 from '@/amadeusNav'
import * as m20 from '@/amadeusPlugins'
import * as m21 from '@/builtins/index'
import * as m22 from '@/builtins/runCommand'
import * as m23 from '@/chatWaitDetails'
import * as m24 from '@/components/AgentAvatar'
import * as m25 from '@/components/AgentHarnessPanel'
import * as m26 from '@/components/AgentLogPanel'
import * as m27 from '@/components/AgentMemoryModal'
import * as m28 from '@/components/AgentMemoryPanel'
import * as m29 from '@/components/AnimatedUI'
import * as m30 from '@/components/BrandLogo'
import * as m31 from '@/components/CapabilityMenu'
import * as m32 from '@/components/ChatWikiLink'
import * as m33 from '@/components/ComposerMenuSurface'
import * as m34 from '@/components/CtxMenuButtons'
import * as m35 from '@/components/DiffView'
import * as m36 from '@/components/EngineIcon'
import * as m37 from '@/components/ErrorBoundary'
import * as m38 from '@/components/FloatingPanelFrame'
import * as m39 from '@/components/GitAddRemoteDialog'
import * as m40 from '@/components/ImageViewer'
import * as m41 from '@/components/InlineFiles'
import * as m42 from '@/components/Markdown'
import * as m43 from '@/components/MarketPluginCards'
import * as m44 from '@/components/ModelGroupList'
import * as m45 from '@/components/ModelPill'
import * as m46 from '@/components/ModelSelect'
import * as m47 from '@/components/MuseView'
import * as m48 from '@/components/OnboardingWizard'
import * as m49 from '@/components/PluginLogo'
import * as m50 from '@/components/ResetCardCeremony'
import * as m51 from '@/components/RightPanel'
import * as m52 from '@/components/SelectField'
import * as m53 from '@/components/SidebarRow'
import * as m54 from '@/components/SketchCard'
import * as m55 from '@/components/TierBadge'
import * as m56 from '@/components/UninstallDialog'
import * as m57 from '@/components/WebCard'
import * as m58 from '@/components/WidgetHost'
import * as m59 from '@/components/WorkspaceFilePreview'
import * as m60 from '@/components/agentInitial'
import * as m61 from '@/components/appRefs'
import * as m62 from '@/components/approvalText'
import * as m63 from '@/components/builtinAgentDescriptions'
import * as m64 from '@/components/capsuleTabs'
import * as m65 from '@/components/chatDragRef'
import * as m66 from '@/components/chatbox/index'
import * as m67 from '@/components/phoneList'
import * as m68 from '@/components/selectionBar/ViewSelectionBar'
import * as m69 from '@/components/thinkingLabel'
import * as m70 from '@/components/wikiChat'
import * as m71 from '@/features/runtime'
import * as m72 from '@/format/repeat'
import * as m73 from '@/format/time'
import * as m74 from '@/hooks/useVoiceInput'
import * as m75 from '@/hoverTip'
import * as m76 from '@/i18n'
import * as m77 from '@/modelPickerPreferences'
import * as m78 from '@/recentViews'
import * as m79 from '@/services/accountQuota'
import * as m80 from '@/services/agentRunService'
import * as m81 from '@/services/backendService'
import * as m82 from '@/services/deviceMarks'
import * as m83 from '@/services/deviceStatus'
import * as m84 from '@/services/engine/health'
import * as m85 from '@/services/engine/messages'
import * as m86 from '@/services/engine/targetCaps'
import * as m87 from '@/services/engine/targets'
import * as m88 from '@/services/fileKinds'
import * as m89 from '@/services/harnessUpdates'
import * as m90 from '@/services/humanCollaboration'
import * as m91 from '@/services/intelligentCardCatalog'
import * as m92 from '@/services/localOnly'
import * as m93 from '@/services/mathNormalize'
import * as m94 from '@/services/platform'
import * as m95 from '@/services/realtimeCall'
import * as m96 from '@/services/realtimeModel'
import * as m97 from '@/services/recordJump'
import * as m98 from '@/services/runLocation'
import * as m99 from '@/services/runOnDevice'
import * as m100 from '@/services/selfUpdates'
import * as m101 from '@/services/ttsService'
import * as m102 from '@/services/uploads'
import * as m103 from '@/services/widgetClient'
import * as m104 from '@/services/widgetPlaces'
import * as m105 from '@/sessionNav'
import * as m106 from '@/sessionTitle'
import * as m107 from '@/stores/appStore'
import * as m108 from '@/stores/attentionStore'
import * as m109 from '@/stores/automationStore'
import * as m110 from '@/stores/channelsStore'
import * as m111 from '@/stores/childChatStore'
import * as m112 from '@/stores/codeStudioStore'
import * as m113 from '@/stores/deskPlan'
import * as m114 from '@/stores/deviceSessionsStore'
import * as m115 from '@/stores/inboxStore'
import * as m116 from '@/stores/notificationStore'
import * as m117 from '@/stores/notificationWiring'
import * as m118 from '@/stores/projectSettings'
import * as m119 from '@/stores/runLocationStore'
import * as m120 from '@/stores/runStats'
import '@/styles/sidebar2.css'
import * as m122 from '@/touch'
import * as m123 from '@/types'
import * as m124 from '@/views/ProjectGitRemotes'
import * as m125 from '@/views/WsFileView'
import '@/views/agentProfile.css'
import * as m127 from '@/views/agentProfileMessages'
import * as m128 from '@/views/agentProfileNav'
import * as m129 from '@/views/automation/lib'
import * as m130 from '@/views/coding/studioMessages'
import * as m131 from '@/views/coding/studioModel'
import * as m132 from '@/views/inbox/InboxBody'
import * as m133 from '@/views/itemSelect'
import * as m134 from '@/views/streamingWrite'
import * as m135 from '@/views/wsFileNav'
import * as m136 from '@/windowKind'
import * as m137 from '@amadeus-shared/excalidraw/format'
import * as m138 from '../../../shared/appRefs'
import * as m139 from '@lcl/components/index'
import * as m140 from '@lcl/engine/index'
import * as m141 from 'react'
import * as m142 from 'react-dom'
import * as m143 from 'react/jsx-runtime'
import * as m144 from 'zustand'
import * as m145 from 'zustand/react/shallow'

export const SHARED_MODULES: Record<string, object> = {
  'framer-motion': m0,
  'host:desktop/frontend/src/achievements/store.ts': m1,
  'host:desktop/frontend/src/agentName.ts': m2,
  'host:desktop/frontend/src/amadeus/blocks/sketch/format.ts': m3,
  'host:desktop/frontend/src/amadeus/chrome/pageChrome.tsx': m4,
  'host:desktop/frontend/src/amadeus/components/Dialogs.tsx': m5,
  'host:desktop/frontend/src/amadeus/components/askString.tsx': m6,
  'host:desktop/frontend/src/amadeus/components/icons.tsx': m7,
  'host:desktop/frontend/src/amadeus/freshNote.ts': m8,
  'host:desktop/frontend/src/amadeus/lib/fuzzy.ts': m9,
  'host:desktop/frontend/src/amadeus/lib/treeIndent.ts': m10,
  'host:desktop/frontend/src/amadeus/plugins/deskCompanion.ts': m11,
  'host:desktop/frontend/src/amadeus/plugins/display.ts': m12,
  'host:desktop/frontend/src/amadeus/plugins/pluginStore.ts': m13,
  'host:desktop/frontend/src/amadeus/plugins/summaryCards.ts': m14,
  'host:desktop/frontend/src/amadeus/plugins/tanguSeam.ts': m15,
  'host:desktop/frontend/src/amadeus/store/pageStore.ts': m16,
  'host:desktop/frontend/src/amadeus/unified/canvasKit/index.ts': m17,
  'host:desktop/frontend/src/amadeus/unified/lifecycle.ts': m18,
  'host:desktop/frontend/src/amadeusNav.ts': m19,
  'host:desktop/frontend/src/amadeusPlugins.ts': m20,
  'host:desktop/frontend/src/builtins/index.tsx': m21,
  'host:desktop/frontend/src/builtins/runCommand.ts': m22,
  'host:desktop/frontend/src/chatWaitDetails.ts': m23,
  'host:desktop/frontend/src/components/AgentAvatar.tsx': m24,
  'host:desktop/frontend/src/components/AgentHarnessPanel.tsx': m25,
  'host:desktop/frontend/src/components/AgentLogPanel.tsx': m26,
  'host:desktop/frontend/src/components/AgentMemoryModal.tsx': m27,
  'host:desktop/frontend/src/components/AgentMemoryPanel.tsx': m28,
  'host:desktop/frontend/src/components/AnimatedUI.tsx': m29,
  'host:desktop/frontend/src/components/BrandLogo.tsx': m30,
  'host:desktop/frontend/src/components/CapabilityMenu.tsx': m31,
  'host:desktop/frontend/src/components/ChatWikiLink.tsx': m32,
  'host:desktop/frontend/src/components/ComposerMenuSurface.tsx': m33,
  'host:desktop/frontend/src/components/CtxMenuButtons.tsx': m34,
  'host:desktop/frontend/src/components/DiffView.tsx': m35,
  'host:desktop/frontend/src/components/EngineIcon.tsx': m36,
  'host:desktop/frontend/src/components/ErrorBoundary.tsx': m37,
  'host:desktop/frontend/src/components/FloatingPanelFrame.tsx': m38,
  'host:desktop/frontend/src/components/GitAddRemoteDialog.tsx': m39,
  'host:desktop/frontend/src/components/ImageViewer.tsx': m40,
  'host:desktop/frontend/src/components/InlineFiles.tsx': m41,
  'host:desktop/frontend/src/components/Markdown.tsx': m42,
  'host:desktop/frontend/src/components/MarketPluginCards.tsx': m43,
  'host:desktop/frontend/src/components/ModelGroupList.tsx': m44,
  'host:desktop/frontend/src/components/ModelPill.tsx': m45,
  'host:desktop/frontend/src/components/ModelSelect.tsx': m46,
  'host:desktop/frontend/src/components/MuseView.tsx': m47,
  'host:desktop/frontend/src/components/OnboardingWizard.tsx': m48,
  'host:desktop/frontend/src/components/PluginLogo.tsx': m49,
  'host:desktop/frontend/src/components/ResetCardCeremony.tsx': m50,
  'host:desktop/frontend/src/components/RightPanel.tsx': m51,
  'host:desktop/frontend/src/components/SelectField.tsx': m52,
  'host:desktop/frontend/src/components/SidebarRow.tsx': m53,
  'host:desktop/frontend/src/components/SketchCard.tsx': m54,
  'host:desktop/frontend/src/components/TierBadge.tsx': m55,
  'host:desktop/frontend/src/components/UninstallDialog.tsx': m56,
  'host:desktop/frontend/src/components/WebCard.tsx': m57,
  'host:desktop/frontend/src/components/WidgetHost.tsx': m58,
  'host:desktop/frontend/src/components/WorkspaceFilePreview.tsx': m59,
  'host:desktop/frontend/src/components/agentInitial.ts': m60,
  'host:desktop/frontend/src/components/appRefs.tsx': m61,
  'host:desktop/frontend/src/components/approvalText.ts': m62,
  'host:desktop/frontend/src/components/builtinAgentDescriptions.ts': m63,
  'host:desktop/frontend/src/components/capsuleTabs.ts': m64,
  'host:desktop/frontend/src/components/chatDragRef.ts': m65,
  'host:desktop/frontend/src/components/chatbox/index.tsx': m66,
  'host:desktop/frontend/src/components/phoneList.tsx': m67,
  'host:desktop/frontend/src/components/selectionBar/ViewSelectionBar.tsx': m68,
  'host:desktop/frontend/src/components/thinkingLabel.ts': m69,
  'host:desktop/frontend/src/components/wikiChat.ts': m70,
  'host:desktop/frontend/src/features/runtime.ts': m71,
  'host:desktop/frontend/src/format/repeat.ts': m72,
  'host:desktop/frontend/src/format/time.ts': m73,
  'host:desktop/frontend/src/hooks/useVoiceInput.ts': m74,
  'host:desktop/frontend/src/hoverTip.tsx': m75,
  'host:desktop/frontend/src/i18n.tsx': m76,
  'host:desktop/frontend/src/modelPickerPreferences.ts': m77,
  'host:desktop/frontend/src/recentViews.ts': m78,
  'host:desktop/frontend/src/services/accountQuota.ts': m79,
  'host:desktop/frontend/src/services/agentRunService.ts': m80,
  'host:desktop/frontend/src/services/backendService.ts': m81,
  'host:desktop/frontend/src/services/deviceMarks.ts': m82,
  'host:desktop/frontend/src/services/deviceStatus.ts': m83,
  'host:desktop/frontend/src/services/engine/health.ts': m84,
  'host:desktop/frontend/src/services/engine/messages.ts': m85,
  'host:desktop/frontend/src/services/engine/targetCaps.ts': m86,
  'host:desktop/frontend/src/services/engine/targets.ts': m87,
  'host:desktop/frontend/src/services/fileKinds.ts': m88,
  'host:desktop/frontend/src/services/harnessUpdates.ts': m89,
  'host:desktop/frontend/src/services/humanCollaboration.ts': m90,
  'host:desktop/frontend/src/services/intelligentCardCatalog.ts': m91,
  'host:desktop/frontend/src/services/localOnly.ts': m92,
  'host:desktop/frontend/src/services/mathNormalize.ts': m93,
  'host:desktop/frontend/src/services/platform.ts': m94,
  'host:desktop/frontend/src/services/realtimeCall.ts': m95,
  'host:desktop/frontend/src/services/realtimeModel.ts': m96,
  'host:desktop/frontend/src/services/recordJump.ts': m97,
  'host:desktop/frontend/src/services/runLocation.ts': m98,
  'host:desktop/frontend/src/services/runOnDevice.ts': m99,
  'host:desktop/frontend/src/services/selfUpdates.ts': m100,
  'host:desktop/frontend/src/services/ttsService.ts': m101,
  'host:desktop/frontend/src/services/uploads.ts': m102,
  'host:desktop/frontend/src/services/widgetClient.ts': m103,
  'host:desktop/frontend/src/services/widgetPlaces.ts': m104,
  'host:desktop/frontend/src/sessionNav.ts': m105,
  'host:desktop/frontend/src/sessionTitle.ts': m106,
  'host:desktop/frontend/src/stores/appStore.ts': m107,
  'host:desktop/frontend/src/stores/attentionStore.ts': m108,
  'host:desktop/frontend/src/stores/automationStore.ts': m109,
  'host:desktop/frontend/src/stores/channelsStore.ts': m110,
  'host:desktop/frontend/src/stores/childChatStore.ts': m111,
  'host:desktop/frontend/src/stores/codeStudioStore.ts': m112,
  'host:desktop/frontend/src/stores/deskPlan.ts': m113,
  'host:desktop/frontend/src/stores/deviceSessionsStore.ts': m114,
  'host:desktop/frontend/src/stores/inboxStore.ts': m115,
  'host:desktop/frontend/src/stores/notificationStore.ts': m116,
  'host:desktop/frontend/src/stores/notificationWiring.ts': m117,
  'host:desktop/frontend/src/stores/projectSettings.ts': m118,
  'host:desktop/frontend/src/stores/runLocationStore.ts': m119,
  'host:desktop/frontend/src/stores/runStats.ts': m120,
  'host:desktop/frontend/src/styles/sidebar2.css': {},
  'host:desktop/frontend/src/touch.ts': m122,
  'host:desktop/frontend/src/types.ts': m123,
  'host:desktop/frontend/src/views/ProjectGitRemotes.tsx': m124,
  'host:desktop/frontend/src/views/WsFileView.tsx': m125,
  'host:desktop/frontend/src/views/agentProfile.css': {},
  'host:desktop/frontend/src/views/agentProfileMessages.ts': m127,
  'host:desktop/frontend/src/views/agentProfileNav.ts': m128,
  'host:desktop/frontend/src/views/automation/lib.ts': m129,
  'host:desktop/frontend/src/views/coding/studioMessages.ts': m130,
  'host:desktop/frontend/src/views/coding/studioModel.ts': m131,
  'host:desktop/frontend/src/views/inbox/InboxBody.tsx': m132,
  'host:desktop/frontend/src/views/itemSelect.ts': m133,
  'host:desktop/frontend/src/views/streamingWrite.ts': m134,
  'host:desktop/frontend/src/views/wsFileNav.ts': m135,
  'host:desktop/frontend/src/windowKind.ts': m136,
  'host:desktop/shared/amadeus/excalidraw/format.ts': m137,
  'host:desktop/shared/appRefs.ts': m138,
  'host:lcl/components/index.ts': m139,
  'host:lcl/engine/index.ts': m140,
  'react': m141,
  'react-dom': m142,
  'react/jsx-runtime': m143,
  'zustand': m144,
  'zustand/react/shallow': m145,
}
