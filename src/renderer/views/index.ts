import type { ComponentType } from 'react'
import type { PanelRef } from '@jaspers-ai/sdk'
import { CHAT_VIEW } from '../../shared/grid/grid'
import { APP_VIEW } from '../../shared/plugins/apps'
import { App } from './App'
import { Chart } from './Chart'
import { Chat } from './Chat'
import { Inbox } from './Inbox'
import { Metric } from './Metric'
import { Note } from './Note'
import { Plugins } from './Plugins'
import { Table } from './Table'
import { Tasks } from './Tasks'

// The views the app ships with, by the id main's registry knows them under. A plugin's views will
// not be here: they arrive as a bundle and mount in an iframe instead.

export interface ViewProps {
  panel: PanelRef
}

export const BUILT_IN_VIEWS: Record<string, ComponentType<ViewProps>> = {
  'core/note': Note,
  'core/table': Table,
  'core/metric': Metric,
  'core/chart': Chart,
  [CHAT_VIEW]: Chat,
  'core/plugins': Plugins,
  'core/tasks': Tasks,
  'core/inbox': Inbox,
  [APP_VIEW]: App,
}
