/**
 * 会话历史的进程内版本号:凡删改 chat_messages 的入口(删消息 / 编辑重发 / 删会话)都 bump 一次。
 * 后台摘要(run 收尾后的惰性检查点、手动 /compact)开始时记下版本,落库前复核 —— 版本变了就丢弃结果,
 * 否则一份基于已删消息的摘要会在删除之后被写回,下次 hydrate 又把删掉的内容念出来、还按旧边界吞掉现存行
 * (Codex 09-15 评审 #6)。只在同一进程内有效:删改与摘要本就都在引擎进程里发生。
 */
const revisions = new Map<string, number>();

/** 本进程的标记。版本号只在同一个进程里可比(重启后从 0 重数):把版本号记到盘上的调用方连它一起记,
 *  读回来时先比它 —— 不是同一个进程记的就当「不知道改没改过」,不能拿两个数字硬比。 */
export const historyEpoch = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function historyRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? 0;
}

export function bumpHistoryRevision(sessionId: string): number {
  const next = historyRevision(sessionId) + 1;
  revisions.set(sessionId, next);
  return next;
}
