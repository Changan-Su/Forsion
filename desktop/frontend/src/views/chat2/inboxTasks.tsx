/** 收件箱任务卡的 Tangu 实现(核心插件化 2e):原先写在宿主的 views/inbox/InboxBody.tsx 里,
 *  现由 features/tangu.tsx 在激活时注册进 tanguSeam,收件箱只读那个槽。 */
import { setActiveSpace } from '@lcl/engine'
import type { TanguInboxTasks } from '../../amadeus/plugins/tanguSeam'
import { splitSuggestions, type TaskCard } from './suggest'
import { TaskCards, useMuseTodoStatus } from './TaskCards'
import { runTaskCard } from './taskLanding'

function InboxTaskCards({ tasks, ownerId }: { tasks: readonly unknown[]; ownerId: string }) {
  const list = tasks as TaskCard[]
  const todo = useMuseTodoStatus(ownerId, list)
  return (
    <TaskCards
      tasks={list}
      ownerId={ownerId}
      noHere
      todoStatus={todo.status}
      onTodoRetry={todo.retry}
      onTask={async (card, landing) => {
        // 收件箱在自己的 Space 里:新会话必须先切到 Tangu Space,否则聊天开在收件箱布局里(同 InboxReaderView.chatWithSender)。
        if (landing === 'new') setActiveSpace('tangu')
        const ok = await runTaskCard(card, landing, null)
        if (card.todo) todo.retry() // 以引擎真状态为准:409 / 失败后卡片随之定格
        return ok
      }}
    />
  )
}

export const inboxTasks: TanguInboxTasks = {
  split: (body, { todo }) => splitSuggestions(body, { kinds: ['task', 'approval'], todo }),
  Cards: InboxTaskCards,
}
