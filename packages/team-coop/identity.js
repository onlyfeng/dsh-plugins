export function ownsTask(member, task) {
  return (task.ownerId != null && task.ownerId === member.id) ||
    (task.ownerName != null && task.ownerName === (member.path ?? member.id))
}

export function authoredDependency(member, task, board) {
  return board.some((dependency) => task?.blockedBy?.includes(dependency.id) && ownsTask(member, dependency))
}

// Desktop can select a preset after a blank Session was created. Its current composed revision is authoritative.
export function effectivePreset(ctx, agent) {
  if (!agent?.session) return null
  const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : ctx.agentPresets
  return (
    (agent.ctx && presets?.composedPreset?.(agent.ctx)) ??
    presets?.presetForSession?.(agent.session) ??
    agent.session.header?.agentPreset ??
    null
  )
}
