/**
 * 动作兑现兜底(10-02):模型收尾时一个工具都没调,正文却在说「我这就写 / 建好了 / 设好了」——
 * 承诺了动作、什么都没发生。live 实测 luna 在最简单的「在我的工作文件夹里建个 anniversaries.md」上
 * 约 1/5 这样收尾(新旧提示词一样;提示词加一句「说做了=状态声明」压不下去),正是用户投诉的「答应了却没做」。
 * 与 plan_submit_check / visual_delivery_check 同形:收尾前回灌一条不落库的检查,整 run 只催一次。
 *
 * 三个条件缺一不可(由调用方保证前两条):本 run 一个工具都没执行;用户这句话在要一个动作;回复在承诺或声称动作。
 * 只看回复会在人设聊天里误触 ——「我记住你了」是情话不是动作。
 * 已知边界:调了工具、失败后仍说「记牢了」(usedTools=true)不归本闸管;先窄后宽。
 */

/** 用户这句话在要一个会落盘 / 生效的动作。 */
const USER_ACTION =
  /记下|记进|记到|记一下|记住|记得帮|写进|写到|写上|写一[个份篇]|建一|新建|创建|设一|设个|设置|设好|定个|存下|存到|存一|保存|提醒|安排|排进|放进|加到|加进|添加|改成|改一下|删掉|删除|发给|发送|\b(remember|save|write|create|add|set( up)?|remind|schedule|delete|remove|rename|send|note down|put (it|this) (in|on))\b/i;

/** 回复在承诺(马上要做)或声称(已经做了)一个动作。 */
const REPLY_PROMISE = /我(这就|现在就|现在|马上|立刻|先|来|去)|这就(给|帮|去|把)|\b(I'll|I will|let me|I'm going to|going to)\b/i;
const REPLY_CLAIM =
  /(记|写|建|存|设|定|排|加|放|改|删|保存|安排)(好|下|进|上|入|完)|记住了|已经?(帮你|给你|替你)?(记|写|建|存|设|定|排|加|放|改|删|保存|安排|提醒)|\b(I've|I have) (saved|written|created|set|added|scheduled|noted|recorded|updated|deleted)\b|\b(done|saved|created|scheduled)\b[.!]/i;

/** 只看短回复:live 里所有漏做的收尾都是一两句话;长回复是交付了正文(写诗、排计划),不该被催去调工具(Codex 10-02)。 */
const MAX_REPLY_CHARS = 200;

export function actionDeliveryNudgeNeeded(userMessage: string, reply: string): boolean {
  const r = reply.replace(/[’‘]/g, "'").trim(); // 弯撇号「I’ve」也要认
  if (!r || r.length > MAX_REPLY_CHARS) return false;
  if (!USER_ACTION.test(userMessage.replace(/[’‘]/g, "'"))) return false;
  return REPLY_PROMISE.test(r) || REPLY_CLAIM.test(r);
}

export const ACTION_DELIVERY_CHECK =
  '<action_delivery_check>\nYou are about to end this turn without having called any tool, but your reply says you did or are about to do something (save, write, create, set, schedule, remind, remember…). Nothing has happened yet. ' +
  'If the user asked for that action, do it now with the right tool and confirm only after it succeeds. If you cannot (no suitable tool, permission denied), say so plainly instead of implying it is done. ' +
  'If your words were only conversational and no action was requested, finish normally.\n</action_delivery_check>';
