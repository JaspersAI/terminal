import type { SourceConfirmSpec } from '@jaspers-ai/sdk/define'
import {
  approveDestinationsForTask,
  ensureAgentDestinationApproved,
  recordPanelThreadApprovalWith,
  recordSourceApprovalWith,
  withoutSourceApproval,
  type ApprovalDeps,
  type SourceApprovalVia,
} from '../../shared/plugins/approvals'
import { getState, update } from '../state'

export { approveDestinationsForTask, ensureAgentDestinationApproved, type ApprovalDeps }

const storeDeps = {
  read: () => getState().sourceApprovals,
  write: (next: ReturnType<ApprovalDeps['read']>) =>
    update((state) => {
      if (next.length === state.sourceApprovals.length && next.every((v, i) => v === state.sourceApprovals[i])) {
        return state
      }
      return { ...state, sourceApprovals: [...next] }
    }),
  now: Date.now,
}

export function recordSourceApproval(entry: {
  plugin: string
  destination: string
  thread?: string
  label?: string
  via: SourceApprovalVia
}): void {
  recordSourceApprovalWith(entry, storeDeps)
}

export function removeSourceApproval(id: string): void {
  update((state) => {
    const next = withoutSourceApproval(state.sourceApprovals, id)
    return next.length === state.sourceApprovals.length ? state : { ...state, sourceApprovals: next }
  })
}

export function recordPanelThreadApproval(
  plugin: string | null,
  confirm: SourceConfirmSpec | undefined,
  args: unknown,
  resultText: string,
): void {
  recordPanelThreadApprovalWith(plugin, confirm, args, resultText, storeDeps)
}

export function defaultApprovalDeps(ask: ApprovalDeps['ask']): ApprovalDeps {
  return {
    ...storeDeps,
    ask,
  }
}
