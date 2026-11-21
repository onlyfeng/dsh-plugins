import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBackends, resolveBackend } from '../backends.js'

const root = { id: 'fixture-lead' }
function setup() {
  const providers = new Map(),
    tools = new Map()
  function install(provider, tool, options = {}) {
    providers.set(provider, {
      name: provider,
      capabilities: { agentOptions: !!options.models },
      ...(options.continuable ? { prepareContinuable() {} } : {}),
    })
    const fields = [
      'name',
      'description',
      'prompt',
      ...(options.models ? ['provider', 'model', 'reasoning_effort'] : []),
    ]
    tools.set(tool, {
      name: tool,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(fields.map((k) => [k, { type: 'string' }])),
      },
    })
  }
  install('spawn', 'delegate_review', { models: true, continuable: true })
  install('codex', 'subagent_codex')
  install('claude-code', 'subagent_claude_code')
  install('codex-deep', 'subagent_codex_deep')
  install('sample', 'subagent_sample', { models: true })
  const ctx = {
    subagents: { getProvider: (k) => providers.get(k) },
    tools: {
      get: (k, agent) => {
        assert.equal(agent, root)
        return tools.get(k)
      },
    },
  }
  return { ctx, tools, providers }
}
const registry = () =>
  normalizeBackends({
    codex: { tiers: { deep: { provider: 'codex-deep', tool: 'subagent_codex_deep' } } },
    'claude-code': true,
    sample: { provider: 'sample', tool: 'subagent_sample' },
  })

test('built-in and configured route capabilities follow the admitted tool', () => {
  const { ctx, tools, providers } = setup()
  const native = resolveBackend(
    ctx,
    root,
    normalizeBackends(),
    'dsh',
    'reviewer',
    'deep',
    { view: () => tools },
    { provider: 'demo', model: 'example', reasoning_effort: 'high' },
  )
  assert.equal(native.oneShot, false)
  assert.equal(native.modelControl, 'call-time')
  const r = registry()
  for (const [host, tool, tier] of [
    ['codex', 'subagent_codex'],
    ['claude-code', 'subagent_claude_code'],
    ['codex', 'subagent_codex_deep', 'deep'],
  ]) {
    const v = resolveBackend(ctx, root, r, host, 'worker', tier)
    assert.equal(v.tool, tool)
    assert.equal(v.oneShot, true)
    assert.equal(v.modelControl, 'host')
    assert.throws(() =>
      resolveBackend(ctx, root, r, host, 'worker', tier, undefined, { provider: 'example', model: 'demo' }),
    )
  }
  const wanted = { provider: 'demo', model: 'example' }
  assert.equal(
    resolveBackend(ctx, root, r, 'sample', 'worker', undefined, undefined, wanted).modelControl,
    'call-time',
  )
  delete tools.get('subagent_sample').parameters.properties.reasoning_effort
  assert.throws(() =>
    resolveBackend(ctx, root, r, 'sample', 'worker', undefined, undefined, {
      ...wanted,
      reasoning_effort: 'high',
    }),
  )
  providers.get('sample').capabilities.agentOptions = false
  assert.throws(() => resolveBackend(ctx, root, r, 'sample', 'worker', undefined, undefined, wanted))
})
test('missing, disabled, shadowed and unsupported routes refuse the task', () => {
  const { ctx, tools, providers } = setup(),
    r = registry()
  assert.throws(() => resolveBackend(ctx, root, normalizeBackends(), 'codex', 'worker'))
  assert.throws(() => resolveBackend(ctx, root, r, 'codex', 'worker', undefined, { view: () => new Map() }))
  assert.throws(() =>
    resolveBackend(ctx, root, r, 'codex', 'worker', undefined, {
      view: () => new Map([['subagent_codex', { ...tools.get('subagent_codex') }]]),
    }),
  )
  assert.throws(() => resolveBackend(ctx, root, r, 'claude-code', 'worker', 'light'))
  tools.get('subagent_codex').parameters.properties.prompt = { type: 'number' }
  assert.throws(() => resolveBackend(ctx, root, r, 'codex', 'worker'))
  providers.delete('codex')
  assert.throws(() => resolveBackend(ctx, root, r, 'codex', 'worker'))
})
test('site routes accept only bounded native identifiers and profiles', () => {
  for (const value of [
    { x: { provider: 'custom', tool: 'pwsh' } },
    { x: { provider: 'run;other', tool: 'subagent_sample' } },
    { x: { provider: 'custom', tool: 'subagent_sample', env: {} } },
    { x: { provider: 'custom', tool: 'subagent_sample', command: 'echo' } },
    { codex: { provider: 'other', tool: 'subagent_other' } },
    { x: { provider: 'custom', tool: 'subagent_codex' } },
    { x: { provider: 'x', tool: 'subagent_x', tiers: { fast: { provider: 'x', tool: 'subagent_x' } } } },
    { dsh: false },
    JSON.parse('{"__proto__":true}'),
  ])
    assert.throws(() => normalizeBackends(value))
})
