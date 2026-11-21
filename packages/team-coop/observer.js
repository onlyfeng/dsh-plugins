import { effectivePreset } from './identity.js'

// A review or advisory seat receives its task from its caller and reports via its final response.
// Apply the guard to the exact preset, including when the Host supplies additional global tools.
const readers = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'team_task_get',
  'team_task_list',
  'list_agents',
])
const views = new Set(['help', 'packs', 'status'])

export function observerGuard(execution, ctx = {}) {
  if (effectivePreset(ctx, execution.agent) !== 'federated-observer') return undefined
  if (readers.has(execution.name)) return undefined
  if (execution.name === 'team_cooperate' && views.has(execution.arguments?.action)) return undefined
  return 'The observer reads evidence and returns a recommendation to the Lead.'
}

export const name = 'federated-observer-policy'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.guard((exec) => observerGuard(exec, ctx))
}
