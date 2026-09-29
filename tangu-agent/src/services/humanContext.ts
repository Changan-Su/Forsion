import { query } from '../core/db.js';
import { canonicalProjectPath } from './projectContext.js';
import { HumanError, type HumanScope } from '../agents/humanStore.js';

/** Resolve only the authenticated session's project, never a model/client-supplied path. */
export async function humanProjectScope(userId: string, sessionId: string): Promise<HumanScope | null> {
  const rows = await query<any[]>('SELECT user_id, project_path, projectless FROM chat_sessions WHERE id = ? LIMIT 1', [sessionId]);
  const session = rows[0];
  if (!session || session.user_id !== userId) throw new HumanError('HUMAN_NOT_FOUND', 'Session not found.');
  if (!session.project_path || session.projectless) return null;
  return { kind: 'project', cwd: await canonicalProjectPath(session.project_path) };
}
