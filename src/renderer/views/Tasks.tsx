import type { ReactElement } from 'react'
import { isPending, type Task } from '../../shared/tasks/tasks'
import { useData, usePublish, type PanelRef } from '@jaspers-ai/sdk'
import { TaskList } from '../components/settings/TasksPane'

/** The workspace's scheduled tasks, as Settings lists them, in a view the assistant can place beside what they act on. */
export function Tasks({ panel }: { panel: PanelRef }): ReactElement {
  const tasks = (useData(`workspaces/${panel.workspaceId}/tasks`) as Task[] | undefined) ?? []
  usePublish(panel, { pending: tasks.filter(isPending).length, total: tasks.length })
  return (
    <div className="h-full w-full">
      <TaskList tasks={tasks} />
    </div>
  )
}
