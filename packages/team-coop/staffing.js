import { authoredDependency, effectivePreset, ownsTask } from './identity.js'
const delegates = Object.freeze({
  worker: 'delegate_work',
  reviewer: 'delegate_review',
  validator: 'delegate_validate',
  observer: 'delegate_observe',
  assistant: 'delegate_assist',
})
const roles = Object.keys(delegates)
const modes = ['auto', 'add', 'stop', 'shrink']
const tiers = ['light', 'default', 'deep']
const priority = ['reviewer', 'validator', 'worker', 'assistant', 'observer']
const hardLimit = 32
const usage =
  '/team-staff status | /team-staff plan {"mode":"add","role":"worker","count":1}. Optional target names an existing member. Use stop or shrink to plan a drain.'

function readOptions(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !['action', 'mode', 'count', 'role', 'target', 'tier'].includes(k))
  )
    throw new Error(usage)
  const { action = 'plan', mode = 'auto', role, count, target, tier } = input
  if (
    !['status', 'plan'].includes(action) ||
    !modes.includes(mode) ||
    (role !== undefined && !roles.includes(role)) ||
    (tier !== undefined && !tiers.includes(tier))
  )
    throw new Error(usage)
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > hardLimit))
    throw new Error(`count must be an integer from 0 through ${hardLimit}.`)
  if (target !== undefined && (typeof target !== 'string' || !target.trim() || target.length > 256))
    throw new Error('Supply an existing member name from status.')
  return { action, mode, role, count, target, tier }
}

// Explicit [role] labels take precedence. Unlabelled work with file scopes requires a worker.
function taskRole(task) {
  const text = task.subject ?? ''
  const tagged = /^\[(worker|reviewer|validator|observer|assistant)\]/i.exec(text)?.[1]?.toLowerCase()
  if (tagged) return tagged
  if (task.writeScopes.length) return 'worker'
  if (/\breview(?:er)?\b|复核|评审/i.test(text)) return 'reviewer'
  if (/\b(validat\w*|test\w*|verify)\b|验证|测试/i.test(text)) return 'validator'
  if (/\b(monitor|observ\w*)\b|观察|监控/i.test(text)) return 'observer'
  if (/\b(assist\w*|advis\w*)\b|助理|助手/i.test(text)) return 'assistant'
  return 'worker'
}

function bounded(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, hardLimit) : fallback
}
export function routeFor(role, requestedTier, policy) {
  const tier =
    requestedTier ??
    (role === 'reviewer' ? 'deep' : ['observer', 'assistant'].includes(role) ? 'light' : 'default')
  const key = policy.tiers?.[tier] ? tier : 'default'
  const route = policy.tiers?.[key]
  if (
    !route ||
    typeof route.provider !== 'string' ||
    !route.provider.trim() ||
    typeof route.model !== 'string' ||
    !route.model.trim()
  )
    return { key: 'inherit', args: {} }
  return {
    key,
    args: {
      provider: route.provider,
      model: route.model,
      ...(route.reasoning_effort ? { reasoning_effort: route.reasoning_effort } : {}),
    },
  }
}
function scopesClash(a, b) {
  // Boards may be inspected from different desktops. Conservative case folding also covers Windows checkouts.
  const norm = (s) => s.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return a.some((raw) =>
    b.some((other) => {
      const x = norm(raw),
        y = norm(other)
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
    }),
  )
}
const memberName = (m) => m.path ?? m.id
const memberRole = (m) =>
  /^\[(worker|reviewer|validator|observer|assistant)\]/i.exec(m.label ?? '')?.[1].toLowerCase()

export function planStaffing(tasks, members, policy = {}, options = {}) {
  const request = readOptions(options)
  const active = members.filter((m) => m.kind === 'child' && m.activity === 'running')
  const inactive = members.filter((m) => m.kind === 'child' && m.activity === 'inactive')
  const unknown = members.length - active.length - inactive.length
  const working = tasks.filter((t) => t.status === 'in_progress')
  const holds = policy.holds ?? []
  const reservedTasks = new Set(holds.map((row) => row.task))
  const reservedMembers = new Set(holds.map((row) => row.target))
  const ready = tasks.filter(
    (t) =>
      t.status === 'pending' &&
      t.ready === true &&
      t.ownerId == null &&
      t.ownerName == null &&
      !reservedTasks.has(t.id),
  )
  const maxActive = bounded(policy.maxActive, 4)
  const round = bounded(policy.maxAddPerTurn, 2)
  const remaining = Math.min(
    round,
    bounded(policy.remainingStarts, round),
    Math.max(0, round - bounded(policy.spentThisTurn, 0)),
  )
  const occupied = new Set([...active.map(memberName), ...reservedMembers]).size
  const slots = Math.min(remaining, Math.max(0, maxActive - occupied - unknown))
  const result = {
    mode: request.mode,
    capacity: {
      occupied,
      active: active.length,
      inactive: inactive.length,
      unknown,
      maxActive,
      remainingStarts: remaining,
      slots,
    },
    board: {
      ready: ready.length,
      inProgress: working.length,
      blocked: tasks.filter((t) => t.status === 'pending' && !t.ready).length,
    },
    roster: members
      .slice(0, 100)
      .map((m) => ({
        target: memberName(m),
        activity: m.activity ?? 'unknown',
        role: memberRole(m) ?? null,
      })),
    rosterTruncated: members.length > 100,
    steps: [],
    deferred: [],
  }
  const target =
    request.target === undefined
      ? undefined
      : members.find((m) => m.id === request.target || memberName(m) === request.target)
  if (request.target && !target) throw new Error('Target not found in this team. Check team_staffing status.')
  if (request.action === 'status') return result
  const ownedBy = (m) => working.filter((task) => ownsTask(m, task))
  if (request.mode === 'stop' || request.mode === 'shrink') {
    const candidates = target
      ? [target]
      : active.filter((m) => !request.role || request.role === memberRole(m))
    for (const m of candidates.slice(0, request.count ?? (request.mode === 'shrink' ? 1 : hardLimit))) {
      const owned = ownedBy(m)
      const busy = m.activity !== 'inactive' || owned.length > 0
      result.steps.push({
        action: busy ? 'drain-at-checkpoint' : 'leave-idle',
        target: memberName(m),
        taskId: owned[0]?.id ?? null,
        role: memberRole(m) ?? null,
        tool: busy && m.mode === 'continuable' ? 'send_message' : null,
        ...(busy && m.mode === 'continuable'
          ? {
              args: {
                agent: memberName(m),
                message:
                  'At your next safe checkpoint, report owned tasks, evidence and remaining work. Finish or hand back your current assignment before taking on another.',
              },
            }
          : {}),
        rationale: busy
          ? 'Preserve the current assignment through its handoff.'
          : 'Leave this member idle until new work is ready.',
      })
    }
    result.reason = 'Pause new allocations for this planning round.'
    return result
  }
  const attached = target && ['observer', 'assistant'].includes(request.role)
  const limit = Math.min(request.count ?? slots, slots, target && !attached ? 1 : hardLimit)
  if (target && !attached && (target.kind !== 'child' || target.mode !== 'continuable'))
    throw new Error('The requested target cannot receive a continuation.')
  if (target && !attached && (target.activity !== 'inactive' || ownedBy(target).length)) {
    result.steps.push({
      action: 'wait-for-checkpoint',
      role: request.role ?? memberRole(target) ?? null,
      target: memberName(target),
      taskId: ownedBy(target)[0]?.id ?? null,
      tool: null,
      rationale: 'Reassess at the member’s delivery checkpoint before assigning new work.',
    })
    return result
  }
  if (!limit || unknown) {
    result.reason = unknown
      ? 'Resolve incomplete roster entries before allocating capacity.'
      : 'The requested count, active capacity or per-turn budget has reached zero.'
    return result
  }
  const roleOf = (task) => taskRole(task)
  const candidates = ready
    .filter((t) => !request.role || request.role === roleOf(t))
    .sort((a, b) => priority.indexOf(roleOf(a)) - priority.indexOf(roleOf(b)))
  // A user-requested read-only observation can attach directly to the named member's existing work.
  if (attached && request.role === 'observer' && !candidates.length)
    candidates.push({ id: null, subject: 'Observe the requested member', writeScopes: [], blockedBy: [] })
  const reservations = [...working.flatMap((t) => t.writeScopes), ...holds.flatMap((h) => h.scopes)]
  const used = new Set(inactive.filter((m) => reservedMembers.has(memberName(m))).map((m) => m.id))
  for (const task of candidates) {
    if (result.steps.length >= limit) break
    const role = request.role ?? roleOf(task)
    const readOnly = role === 'reviewer' || role === 'observer'
    let reason
    if (readOnly && task.writeScopes.length) reason = 'Move writable work to a separate implementation task.'
    if ((role === 'worker' || role === 'assistant') && !task.writeScopes.length)
      reason = 'Define a separate, bounded write scope for this implementation task.'
    if (scopesClash(task.writeScopes, reservations))
      reason = 'The requested write scope overlaps another in-progress or proposed assignment.'
    if (target && !attached && role === 'reviewer' && authoredDependency(target, task, tasks))
      reason = 'Use an independent reviewer for the author’s candidate.'
    if (reason) {
      if (result.deferred.length < 32) result.deferred.push({ taskId: task.id, reason })
      continue
    }
    const member =
      target && !attached
        ? target
        : inactive.find(
            (m) =>
              m.mode === 'continuable' &&
              memberRole(m) === role &&
              !ownedBy(m).length &&
              m !== target &&
              !used.has(m.id) &&
              !(role === 'reviewer' && authoredDependency(m, task, tasks)),
          )
    if (member && memberRole(member) !== role) {
      result.deferred.push({
        taskId: task.id,
        reason:
          'The target has no matching recorded role label. Confirm its role and tools before assignment.',
      })
      break
    }
    const contact = attached ? memberName(target) : null
    const prompt = [
      task.id
        ? `Read and claim ${task.id} only if it is still ready and unowned. Follow the board’s acceptance criteria.`
        : 'Observe the requested member at its next checkpoint.',
      contact && `Coordinate with ${contact}.`,
      readOnly && 'Return a read-only report on pinned evidence.',
      `Report the result and limits to the Lead.`,
    ]
      .filter(Boolean)
      .join(' ')
    const route = routeFor(role, request.tier, policy)
    const rationale =
      role === 'reviewer'
        ? 'Prioritize independent review of a ready candidate.'
        : contact
          ? 'Attach the requested support role to a named member.'
          : 'Staff this ready slice within its write scope and the current capacity.'
    result.steps.push({
      action: member ? 'resume' : 'delegate',
      role,
      taskId: task.id,
      target: member ? memberName(member) : null,
      attachedTo: contact,
      tool: member ? 'send_message' : delegates[role],
      routeKey: member ? 'existing-session' : route.key,
      args: member
        ? { agent: memberName(member), message: prompt }
        : { description: `[${role}] ${task.subject}`.slice(0, 180), prompt, ...route.args },
      rationale,
    })
    if (member) used.add(member.id)
    reservations.push(...task.writeScopes)
  }
  if (!result.steps.length)
    result.reason =
      'No eligible assignment. Review deferred scopes, task dependencies or define a ready task for the requested role.'
  return result
}

export function createStaffing(ctx, { getPolicy = () => ({}), policyHolds = () => [] } = {}) {
  function allowed(agent) {
    if (!agent || effectivePreset(ctx, agent) !== 'federated-team') return false
    try {
      return ctx.subagents.rootOf(agent) === agent
    } catch {
      return false
    }
  }
  async function execute(args, { agent, signal }, getHolds = policyHolds) {
    if (!allowed(agent)) throw new Error('Run staffing from the federation Lead session.')
    const options = readOptions(args)
    if (!ctx.agentTeams.isEnabled(agent))
      throw new Error('Enable Agent Teams in the root session to inspect staffing.')
    const members = await ctx.subagents.listDescendants(agent.id, signal)
    const policy = await getPolicy(agent)
    signal?.throwIfAborted()
    if (!allowed(agent)) throw new Error('The federation root changed. Read status again.')
    const tasks = ctx.agentTeams.listTasks(agent)
    const holds = getHolds(agent.id, tasks)
    const plan = planStaffing(tasks, members, { ...policy, holds }, options)
    plan.outstanding = holds.map(({ task, revision, target, tool, state }) => ({
      task,
      revision,
      target,
      tool,
      state,
    }))
    return JSON.stringify(plan)
  }
  const tool = {
    name: 'team_staffing',
    description: 'Inspect the live Team board and roster and plan one bounded allocation or drain round.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'plan'] },
        mode: { type: 'string', enum: modes },
        role: { type: 'string', enum: roles },
        count: { type: 'integer' },
        target: { type: 'string' },
        tier: { type: 'string', enum: tiers },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute,
  }
  const command = {
    name: 'team-staff',
    description: 'Inspect or plan federation staffing.',
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      try {
        const parts = /^(status|plan)(?:\s+(\{[\s\S]*\}))?$/.exec(rawInput.trim() || 'status')
        if (!parts) throw new Error(usage)
        let options
        try {
          options = parts[2] ? JSON.parse(parts[2]) : {}
        } catch {
          throw new Error(usage)
        }
        if (
          !options ||
          typeof options !== 'object' ||
          Array.isArray(options) ||
          Object.hasOwn(options, 'action')
        )
          throw new Error(usage)
        return { kind: 'success', text: await execute({ ...options, action: parts[1] }, { agent, signal }) }
      } catch (error) {
        signal?.throwIfAborted()
        return { kind: 'error', text: error.message }
      }
    },
  }
  return {
    tool,
    command,
    execute,
    when: ({ agent }) => allowed(agent),
    prompt: {
      name: 'team-coop:staffing',
      order: 611,
      required: true,
      interpolate: false,
      text: ({ agent }) =>
        allowed(agent)
          ? 'When ready tasks, reviewer backlog or delivery checkpoints change, call team_staffing for one staffing round. Use the named native tool for each accepted assignment. Recheck board ownership, independent review, route, available capacity and delegation depth before starting.'
          : '',
    },
  }
}
