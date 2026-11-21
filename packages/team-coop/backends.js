const roles = Object.freeze({
  worker: 'delegate_work',
  reviewer: 'delegate_review',
  validator: 'delegate_validate',
  observer: 'delegate_observe',
  assistant: 'delegate_assist',
})
const builtins = Object.freeze({
  codex: { provider: 'codex', tool: 'subagent_codex' },
  'claude-code': { provider: 'claude-code', tool: 'subagent_claude_code' },
})
const tiers = new Set(['default', 'light', 'deep'])
const validId = /^[a-z][a-z0-9-]{0,47}$/u
const validProvider = /^[a-z][a-z0-9_-]{0,63}$/u
const validTool = /^subagent_[a-z0-9_]{1,63}$/u
function fail(message) {
  throw new Error(message)
}
function fields(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    fail('Use registered provider, tool and tier fields in backend configuration.')
}
function pair(value) {
  fields(value, ['provider', 'tool'])
  if (
    typeof value.provider !== 'string' ||
    !validProvider.test(value.provider) ||
    typeof value.tool !== 'string' ||
    !validTool.test(value.tool)
  )
    fail('Configure a registered subagent provider and a subagent_* delegation tool.')
  return Object.freeze({ provider: value.provider, tool: value.tool })
}

/** Load the operator-owned host mapping. Role and LLM route selection remain independent of the host ID. */
export function normalizeBackends(raw = {}) {
  fields(raw, Object.keys(raw ?? {}))
  if (Object.keys(raw).length > 32) fail('Configure at most 32 subagent hosts.')
  const registry = Object.create(null)
  registry.dsh = Object.freeze({ id: 'dsh', provider: 'spawn', tiers: Object.freeze({}) })
  const assigned = new Map()
  function bind(route) {
    const prior = assigned.get(route.tool)
    if (prior !== undefined && prior !== route.provider)
      fail('Each delegation tool must identify one registered provider.')
    for (const official of Object.values(builtins)) {
      if ((route.tool === official.tool) !== (route.provider === official.provider))
        fail('Keep official provider and tool names paired. Give named tier instances distinct names.')
    }
    if (route.provider === 'spawn') fail('Choose the dsh host for the in-process provider.')
    assigned.set(route.tool, route.provider)
    return route
  }
  for (const [id, value] of Object.entries(raw)) {
    if (!validId.test(id) || ['constructor', 'prototype'].includes(id))
      fail('Use a lowercase subagent host ID.')
    if (id === 'dsh') {
      if (value !== true) fail('The dsh host is built in. Set its model routes in staffing tiers.')
      continue
    }
    const official = Object.hasOwn(builtins, id) ? builtins[id] : undefined
    if (value === false) continue
    if (value !== true) fields(value, ['provider', 'tool', 'tiers'])
    if (value === true && !official) fail('Give the custom host its registered provider and tool.')
    const options = value === true ? {} : value
    const base = bind(
      pair({ provider: options.provider ?? official?.provider, tool: options.tool ?? official?.tool }),
    )
    if (official && (base.provider !== official.provider || base.tool !== official.tool))
      fail('The official host ID uses its native provider and delegation tool.')
    const profiles = Object.create(null)
    if (options.tiers !== undefined) {
      fields(options.tiers, [...tiers])
      for (const [tier, route] of Object.entries(options.tiers)) profiles[tier] = bind(pair(route))
    }
    registry[id] = Object.freeze({ id, ...base, tiers: Object.freeze(profiles) })
  }
  return Object.freeze(registry)
}
const local = normalizeBackends()

/** Resolve the live provider and the caller's admitted delegation tool before a start. */
export function resolveBackend(
  ctx,
  root,
  registry = local,
  choice = 'dsh',
  role,
  tier,
  toolSet,
  requestedModel,
) {
  if (!root || typeof choice !== 'string' || !registry || !Object.hasOwn(registry, choice))
    fail('Choose a host enabled in this site.')
  if (!Object.hasOwn(roles, role)) fail('Select a registered staffing role.')
  if (tier !== undefined && !tiers.has(tier)) fail('Select the default, light or deep tier.')
  const config = registry[choice],
    native = choice === 'dsh'
  let route = native ? { provider: 'spawn', tool: roles[role] } : config
  if (!native && tier !== undefined) {
    if (config.tiers?.[tier]) route = config.tiers[tier]
    else if (tier !== 'default') fail(`Configure the ${tier} tier for ${choice} or omit the tier.`)
  }
  const { provider, tool } = route
  if (!native && (!validProvider.test(provider) || !validTool.test(tool)))
    fail('Invalid external route in the local site configuration.')
  const backend = ctx.subagents.getProvider(provider)
  if (!backend || backend.name !== provider)
    fail(`Enable the subagent provider ${provider} before allocating this task.`)
  const definition = ctx.tools.get(tool, root)
  if (!definition || definition.name !== tool)
    fail(`Enable ${tool} for the selected Lead before allocating this task.`)
  if (
    toolSet !== undefined &&
    (!toolSet || typeof toolSet.view !== 'function' || toolSet.view(root).get(tool) !== definition)
  )
    fail(`The current step does not admit ${tool}. Refresh the available tools.`)
  const params = definition.parameters?.properties ?? definition.parameters
  const hasString = (k) => Object.hasOwn(params ?? {}, k) && params[k]?.type === 'string'
  if (!['prompt', 'description', 'name'].every(hasString))
    fail(`The registered ${tool} tool must implement the native delegation arguments.`)
  const oneShot = typeof backend.prepareContinuable !== 'function'
  const official =
    Object.hasOwn(builtins, choice) || Object.values(builtins).some((x) => x.provider === provider)
  const callTime =
    !official && backend.capabilities?.agentOptions === true && hasString('provider') && hasString('model')
  const supportsEffort = callTime && hasString('reasoning_effort')
  if (requestedModel !== undefined) {
    fields(requestedModel, ['provider', 'model', 'reasoning_effort'])
    if (
      Object.keys(requestedModel).length &&
      (!callTime ||
        !requestedModel.provider ||
        !requestedModel.model ||
        (requestedModel.reasoning_effort !== undefined && !supportsEffort))
    )
      fail(`Use a configured native host profile or a model-selectable tool for ${choice}.`)
  }
  if (native && oneShot) fail('The dsh role tool requires a continuable spawn provider.')
  return {
    id: choice,
    provider,
    tool,
    tier: tier ?? 'default',
    oneShot,
    modelControl: callTime ? 'call-time' : 'host',
    supportsEffort,
  }
}
