import { describe, expect, it } from 'vitest'
import { useApp } from '../../stores/appStore'

// 核心插件化第 2a 步把 appStore 拆成宿主半边 + Tangu 半边(tangu/store/tanguSlice.ts),仍拼成同一个 useApp。
// 这张表是拆之前 main 上的完整键集合:拆分 / 往返搬家时悄悄丢了一个成员(或两边各写了一个同名的),这里第一个报红。
// 新增成员时把名字加进来;删成员要能说清是谁不再用它。
const EXPECTED = [
  'achievementsOpen', 'activeId', 'activeSpecial', 'activeWorkspaceKey', 'addCloudProject', 'addLocalWorkspace',
  'adoptSession', 'agentAvatars', 'agentDefs', 'answerInquiry', 'appendRefs', 'archiveSession', 'archivedSessions',
  'authInfo', 'boot', 'branchFromMessage', 'cfg', 'cfgLoaded', 'channelWorkspaces', 'clearDraftRefs',
  'clearJumpTarget', 'clearPendingChatQuote', 'clearSteerRestore', 'cloneGitProject', 'closeAchievements',
  'closeFeedback', 'closeMarket', 'closeSettings', 'cloudProjects', 'compact', 'compactingBySession',
  'configBySession', 'connMessage', 'connState', 'connect', 'connectOnce', 'createInWorkspace', 'ctxInfoBySession',
  'decideApproval', 'defaultAgentSlug', 'defaultWorkspace', 'defaultWsDir', 'deleteSession', 'deskAutoShow',
  'deskBySession', 'deskLiveClear', 'deskLiveSync', 'deskPresent', 'deskShowFile', 'desktopConfig', 'desktopMode',
  'detailWsKey', 'discardFailed', 'dismissUpdate', 'draftRefs', 'editUserMessage', 'engineCaps', 'engines', 'ensureEngineCaps',
  'ensureProjectSettings', 'ensureSoloSession', 'ensureTeamSession', 'failedBySession', 'feedbackDraft', 'feedbackOpen', 'filePreview',
  'focusDirs', 'focusModelId', 'groupVoting', 'handleAuthExpired', 'historyLoading', 'homeDir', 'hydrateTeamWork',
  'jumpTarget', 'llmRetryBySession', 'loadProjectIcon', 'loadSessionHistory', 'marketOpen', 'marketTarget',
  'mergeBackgroundSubChats', 'messagesBySession', 'modelsResp', 'moveSessionToProject', 'newChatCfg', 'newChatModel',
  'newChatWs', 'newSession', 'onPluginInstalled', 'onboarding', 'onboardingUpdate', 'openAchievements',
  'openFeedback', 'openMarket', 'openSettings', 'openWorkspaceKeys', 'patchConfig', 'patchDesk', 'patchMessage',
  'patchSessionConfig', 'pendingChatQuote', 'pendingDraft', 'pendingShare', 'pollSession', 'projectIconUrls',
  'projectSettingsByPath', 'pushNotice', 'reduceEvent', 'refreshAgents', 'refreshCloudProjects', 'refreshSessions',
  'refreshSpecialEnabled', 'refreshTeams', 'refreshVoiceMode', 'regenerate', 'rememberProjectSettings',
  'removeAgent', 'removeWorkspace', 'renameSession', 'renameWorkspace', 'retry', 'retryFailed', 'rewindTo', 'rotateSoloSession',
  'runStatsBySession', 'runningBySession', 'seedOnceBySession', 'selectNewChatAgent', 'selectSessionAgent', 'send',
  'sendNow', 'sessionMode', 'sessions', 'setActiveId', 'setActiveSpecial', 'setActiveWorkspaceKey',
  'setDefaultModel', 'setDetailWsKey', 'setExecConfig', 'setFilePreview', 'setJumpTarget', 'setModelContextWindow',
  'setNewChatCfg', 'setNewChatModel', 'setNewChatWs', 'setOnboarding', 'setPendingChatQuote', 'setPendingDraft',
  'setPendingShare', 'setSeedOnce', 'setSessionEmoji', 'setSessionEngine', 'setSessionEngineModel',
  'setSessionGroup', 'setSessionMaxIterations', 'setSessionMode', 'setSessionModel', 'setSessionPlanMode',
  'setSessionThinking', 'setTr', 'setUpdateAvailable', 'setVoiceMode', 'settingsNonce', 'settingsOpen',
  'settingsSkillKey', 'settingsTab', 'skillsList', 'specialEnabled', 'steerNow', 'steerPendingBySession',
  'steerRestoreBySession', 'steerSentBySession', 'stop', 'stoppingBySession', 'subChatsBySession', 'subscribeRun',
  'takePendingShare', 'teamAvatars', 'teamWorkBySession', 'teams', 'toast', 'toggleOpenWorkspace', 'tr',
  'truncateAndResend', 'unread', 'updateAvailable', 'updateDismissed', 'usageBySession', 'voiceOnByAgent',
  'voiceRunParams', 'withdrawSteer', 'workspaces',
]

describe('useApp 的键集合', () => {
  it('宿主半边 + Tangu 半边拼起来与拆分前逐个相同', () => {
    expect(Object.keys(useApp.getState()).sort()).toEqual(EXPECTED)
  })
})
