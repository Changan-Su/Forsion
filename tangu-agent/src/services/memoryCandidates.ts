/** Agent-local candidate inbox. Missing is empty; unreadable is never empty. */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { currentAgentSlug } from '../seams/runContext.js';
import { readMemoryFile, atomicWriteMemoryFile, safeMemoryPath, withMemoryDirectoryLock } from './memoryRepository.js';

export interface MemoryCandidate { id: string; date: string; text: string; line: string; sessionId?: string; anchorMessageId?: string }

export function memoryPrivatePath(slug: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || !/^\.memory-[a-z.-]+$/.test(name)) throw new Error('Invalid memory path');
  return safeMemoryPath(join(agentsDir(), slug), name);
}
export function withPrivateMemoryLock<T>(slug: string, fn: () => T): T {
  memoryPrivatePath(slug, '.memory-raw.md');
  return withMemoryDirectoryLock(join(agentsDir(), slug), fn);
}
export function readPrivateText(slug: string, name: string): string {
  memoryPrivatePath(slug, name);
  return readMemoryFile(join(agentsDir(), slug), name) ?? '';
}
export function writePrivateText(slug: string, name: string, text: string): void {
  memoryPrivatePath(slug, name);
  withPrivateMemoryLock(slug, () => atomicWriteMemoryFile(join(agentsDir(), slug), name, text));
}

export function parseRawLines(content: string): MemoryCandidate[] {
  return String(content || '').split('\n').flatMap((l) => {
    const line = l.trim();
    const m = /^- \[(\d{4}-\d{2}-\d{2})([^\]]*)\] (.+)$/.exec(line);
    if (!m) return [];
    return [{ id: `candidate:${createHash('sha256').update(line).digest('hex').slice(0, 24)}`, date: m[1], text: m[3], line,
      sessionId: /(?:^|\s)s:([\w-]+)/.exec(m[2])?.[1], anchorMessageId: /(?:^|\s)m:([\w-]+)/.exec(m[2])?.[1] }];
  });
}

export function readCandidates(slug = currentAgentSlug() || DEFAULT_AGENT_SLUG): MemoryCandidate[] {
  return parseRawLines(readPrivateText(slug, '.memory-raw.md'));
}

export function appendCandidates(slug: string | undefined, sessionId: string, candidates: string[], source?: { anchorMessageId?: string }): number {
  if (!candidates.length) return 0;
  if (source?.anchorMessageId && !/^[\w-]+$/.test(source.anchorMessageId)) throw new Error('Invalid candidate source message ID');
  const key = slug || currentAgentSlug() || DEFAULT_AGENT_SLUG;
  return withPrivateMemoryLock(key, () => {
  const before = readPrivateText(key, '.memory-raw.md');
  const date = new Date().toISOString().slice(0, 10);
  const safeSession = /^[\w-]+$/.test(sessionId) ? sessionId : '';
  const lines = candidates.map((text) => `- [${date}${safeSession ? ` s:${safeSession}` : ''}${source?.anchorMessageId ? ` m:${source.anchorMessageId}` : ''}] ${text.replace(/[\r\n]+/g, ' ')}`).join('\n');
  writePrivateText(key, '.memory-raw.md', `${before.trimEnd()}${before.trim() ? '\n' : ''}${lines}\n`);
  return candidates.length;
  });
}

export function consumeCandidates(slug: string, ids: ReadonlySet<string>): void {
  withPrivateMemoryLock(slug, () => {
  const raw = readPrivateText(slug, '.memory-raw.md');
  const consumed = new Set(parseRawLines(raw).filter((c) => ids.has(c.id)).map((c) => c.line));
  const lines = raw.split('\n').filter((line) => !consumed.has(line.trim()));
  writePrivateText(slug, '.memory-raw.md', lines.join('\n'));
  });
}
