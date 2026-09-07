import { addCommand, removeCommand, useCommandStore } from '@lcl/engine'
import type { Command, ExtendViewSide } from '@lcl/engine'
import { translate } from '../../i18n'
import { normPath } from './studioModel'
import type { StudioTool } from './useStudioTools'

const TITLES = { brief: 'studio.project', history: 'studio.history', checks: 'studio.checks', issues: 'studio.issues', setup: 'studio.setup' } as const
export const STUDIO_TOOL_COMMAND = 'coding-studio.open-tool'

/** Presentation only. All entry points open explicit values; none save, restore or publish. */
export function registerStudioCommands(root: string, open: (tool: StudioTool, side?: ExtendViewSide) => boolean, isCurrent: () => boolean): () => void {
  let alive = true
  const current = () => alive && isCurrent()
  const commands: Command[] = []
  const register = (command: Command) => { commands.push(command); addCommand(command) }
  for (const kind of Object.keys(TITLES) as StudioTool[]) {
    const id = `coding-studio.${kind}`
    register({ id, title: () => `Coding Studio · ${translate(TITLES[kind])}`, keywords: 'coding studio temp panel', run: () => { if (current()) open(kind) } })
  }
  register({
    id: STUDIO_TOOL_COMMAND,
    title: () => translate('studio.openTool'),
    run: () => { if (current()) open('brief') },
    invoke: {
      description: 'Show a Coding Studio project tool in a native temporary panel. Explicitly choose a tool and optional left, right or bottom position. This only presents the interface; it never saves, restores, sends a prompt or publishes. Repeated requests focus the existing tool and preserve drafts. Use the currently open project root.',
      params: { type: 'object', properties: {
        projectRoot: { type: 'string' }, tool: { type: 'string', enum: Object.keys(TITLES) }, side: { type: 'string', enum: ['left', 'right', 'bottom'] },
      }, required: ['projectRoot', 'tool'], additionalProperties: false },
      state: () => JSON.stringify({ projectRoot: root, available: current() }),
      run: args => {
        if (!current() || typeof args.projectRoot !== 'string' || normPath(args.projectRoot) !== normPath(root)) throw new Error('Coding Studio project is not active')
        if (Object.keys(args).some(key => !['projectRoot', 'tool', 'side'].includes(key))) throw new Error('Unknown Coding Studio command argument')
        if (typeof args.tool !== 'string' || !Object.hasOwn(TITLES, args.tool)) throw new Error('Unknown Coding Studio tool')
        if (args.side !== undefined && (typeof args.side !== 'string' || !['left', 'right', 'bottom'].includes(args.side))) throw new Error('Invalid Coding Studio panel position')
        if (!open(args.tool as StudioTool, args.side as ExtendViewSide | undefined)) throw new Error('Coding Studio tool owner is not visible')
      },
    },
  })
  return () => {
    alive = false
    // React may register the next project before a delayed old cleanup runs. Revoke only entries
    // from this owner, leaving a replacement's commands intact; captured old callbacks also stop.
    for (const command of commands) {
      if (useCommandStore.getState().commands.find(item => item.id === command.id) === command) removeCommand(command.id)
    }
  }
}
