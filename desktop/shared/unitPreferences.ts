/** One whitelist for desktop device projection, standalone Unit and account preferences. */
export const UNIT_PREFERENCE_KEYS = [
  'modelId', 'asrModelId', 'visionModelId', 'visionMode', 'backgroundModelId',
  'agentDeskEnabled', 'summaryOpenIn', 'ttsModelId', 'ttsVoice', 'ttsSpeed', 'ttsAutoSpeak', 'asrBackend',
  'lastApprovalMode', 'lastThinkingLevel', 'lastChatThinkingLevel',
  'notesAttachmentMode', 'notesAttachmentFolder', 'notesImportPreview', 'notesDailyFolder',
  'notesWikiIncludeFiles', 'notesUpgradeV4',
] as const
export function pickUnitPreferences(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(UNIT_PREFERENCE_KEYS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]))
}
