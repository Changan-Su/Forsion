/**
 * 会话历史的进程内版本号:凡删改 chat_messages 的入口(删消息 / 编辑重发 / 删会话)都 bump 一次。
 * 后台摘要(run 收尾后的惰性检查点、手动 /compact)开始时记下版本,落库前复核 —— 版本变了就丢弃结果,
 * 否则一份基于已删消息的摘要会在删除之后被写回,下次 hydrate 又把删掉的内容念出来、还按旧边界吞掉现存行
 * (Codex 09-15 评审 #6)。只在同一进程内有效:删改与摘要本就都在引擎进程里发生。
 */
const revisions = new Map<string, number>();

export function historyRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? 0;
}

export function bumpHistoryRevision(sessionId: string): number {
  const next = historyRevision(sessionId) + 1;
  revisions.set(sessionId, next);
  return next;
}
