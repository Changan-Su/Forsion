import { setTimeout as delay } from 'node:timers/promises';
import { v4 as uuidv4 } from 'uuid';
import { agentCapOf, agentEngineOf, getAgent, type NormalAgentDef } from '../agents/agentRegistry.js';
import { AUTOMATION_DM_ORIGIN, AUTOMATION_MESSAGE_LIMIT, automationDmContent, type SendMessageAction } from '../contracts/automationMessage.js';
import { backgroundClientTag } from '../core/version.js';
import { deps } from '../seams/runtime.js';
import { expandTemplate } from './automationTemplate.js';
import { type MuseTrigger, type TriggerContext } from './museTriggers.js';
import { appendProactiveMessage, asksUser } from './proactiveMessage.js';
import { createRun, getRun } from './runStore.js';
import { resolveBackgroundModelId } from './specialAgentsConfig.js';
import { sendInboxMessage, MUSE_SENDER_ID, stripTodoHeaders } from '../tools/builtin/inboxSend.js';
import { AUTOMATION_DRAFT_BACKGROUND } from './automationDraft.js';

export async function automationSenderError(action: SendMessageAction): Promise<string | null> {
  const def = await getAgent(action.agentSlug);
  if (!def) return `Unknown sending Agent "${action.agentSlug}".`;
  if (action.source === 'agent' && agentEngineOf(def)) return `"${action.agentSlug}" uses an external engine that cannot draft unattended. Choose fixed text or a Tangu Agent.`;
  return null;
}

async function compose(
  action: Extract<SendMessageAction, { source: 'agent' }>,
  def: NormalAgentDef, rule: MuseTrigger, userId: string, sessionId: string, deadline: number,
): Promise<string> {
  if (agentEngineOf(def)) throw new Error(`Agent "${action.agentSlug}" is unavailable for unattended drafting.`);
  const modelId = def.model || await resolveBackgroundModelId('');
  if (!modelId) throw new Error(`No model available for Agent "${action.agentSlug}".`);
  if (Date.now() >= deadline) throw new Error('Timed out preparing the automation message.');
  const { abortRun, enqueueRun } = await import('./agentLoop.js');
  const runId = uuidv4();
  await createRun({
    id: runId, sessionId, userId, appId: deps().profile.appId, modelId, assistantMessageId: uuidv4(),
    input: {
      message: `[Automation message] Write one message to the user in their language. Your final answer is sent as the message. Return only its body, up to ${AUTOMATION_MESSAGE_LIMIT[action.delivery]} characters. A question in the final message is fine; do not wait for an answer here. Do not claim to have performed actions you did not take.\n\n${action.prompt}`,
      userMessageId: uuidv4(), attachments: [], background: AUTOMATION_DRAFT_BACKGROUND,
      client: backgroundClientTag('automation'),
      agentConfig: {
        agentSlug: action.agentSlug, execMode: 'host', approvalMode: 'readonly',
        maxIterations: Math.min(agentCapOf(def) ?? 20, 20), maxIterationsSource: 'automation',
        automationOrigin: rule.id,
      },
    },
  });
  enqueueRun(sessionId, runId);
  // Read the persisted terminal state: some entry paths publish an error before they write that state.
  while (Date.now() < deadline) {
    const run = await getRun(runId);
    if (!run || !['queued', 'running'].includes(run.status)) {
      if (run?.status !== 'done') throw new Error(run?.error || 'The Agent could not draft the automation message.');
      const result = typeof run.result === 'string' ? JSON.parse(run.result) : run.result;
      if (result?.refused || result?.truncated) throw new Error('The Agent did not produce a complete message.');
      return typeof result?.content === 'string' ? result.content.trim() : '';
    }
    await delay(Math.min(400, Math.max(0, deadline - Date.now())));
  }
  abortRun(runId, { reason: 'automation_message_timeout' });
  throw new Error('Timed out waiting for the Agent to draft the message.');
}

export async function deliverAutomationMessage(
  action: SendMessageAction, rule: MuseTrigger, userId: string, sessionId: string, deadline: number, ctx?: TriggerContext,
): Promise<string> {
  const def = await getAgent(action.agentSlug);
  if (!def) throw new Error(`Unknown sending Agent "${action.agentSlug}".`);
  const content = action.source === 'fixed'
    ? expandTemplate(action.body, ctx).trim()
    : await compose(action, def, rule, userId, sessionId, deadline);
  if (!content || content.length > AUTOMATION_MESSAGE_LIMIT[action.delivery]) {
    throw new Error(`Message must contain 1–${AUTOMATION_MESSAGE_LIMIT[action.delivery]} characters after preparation.`);
  }

  if (action.delivery === 'inbox') {
    const r = await sendInboxMessage(userId, {
      title: rule.desc, body: action.agentSlug === MUSE_SENDER_ID ? stripTodoHeaders(content) : content,
      senderId: action.agentSlug, forward: false,
    });
    if (!r.ok) throw new Error(r.error || 'Inbox delivery failed.');
  } else {
    const { withAgentSoloSession } = await import('../routes/solo.js');
    const sent = await withAgentSoloSession(userId, action.agentSlug, (s) => appendProactiveMessage({
      sessionId: s.id, agentSlug: action.agentSlug, content: automationDmContent(rule.desc, content),
      origin: AUTOMATION_DM_ORIGIN, ask: asksUser(content),
    }));
    if (!sent) throw new Error(`Solo chat for Agent "${action.agentSlug}" is unavailable.`);
  }
  return `${action.agentSlug} → ${action.delivery === 'solo' ? 'Solo' : 'Inbox'}`;
}
