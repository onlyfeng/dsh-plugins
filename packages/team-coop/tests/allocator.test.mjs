import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAllocator } from '../allocator.js'
import { createStaffing } from '../staffing.js'
import { normalizeBackends } from '../backends.js'

function fixture() {
  const agent = { id: 'lead-example', session: { header: { agentPreset: 'federated-team' } } }
  const tasks = [
    {
      id: 'task-1',
      revision: 1,
      subject: '[worker] first',
      status: 'pending',
      ready: true,
      writeScopes: ['lib'],
      blockedBy: [],
    },
  ]
  const roster = [],
    calls = []
  const control = {
    send: async (batch) => {
      const call = batch.calls[0],
        args = JSON.parse(call.arguments)
      const value =
        call.name === 'send_message' ? { messageId: 'message-1' } : { kind: 'activation', name: args.name }
      return {
        results: [{ callId: call.id, result: { isError: false, value, content: [] } }],
        additionalContexts: [],
        concluded: false,
      }
    },
  }
  const ctx = {
    agentTeams: {
      listTasks: (a) => {
        assert.equal(a, agent)
        return tasks
      },
      isEnabled: () => true,
    },
    subagents: { rootOf: () => agent, listDescendants: async () => roster },
    tools: {
      execute: (batch) => {
        calls.push(batch)
        return control.send(batch)
      },
    },
  }
  const definitions = new Map()
  const tools = [
    'delegate_work',
    'delegate_review',
    'delegate_validate',
    'delegate_assist',
    'delegate_observe',
    'subagent_codex',
    'subagent_claude_code',
    'subagent_example',
  ]
  for (const name of tools) {
    const fields = [
      'name',
      'description',
      'prompt',
      'cwd',
      ...(name.startsWith('delegate_') ? ['provider', 'model', 'reasoning_effort'] : []),
    ]
    definitions.set(name, {
      name,
      parameters: {
        type: 'object',
        required: ['description', 'prompt'],
        properties: Object.fromEntries(fields.map((key) => [key, { type: 'string' }])),
      },
    })
  }
  ctx.tools.get = (name, caller) => {
    assert.equal(caller, agent)
    return definitions.get(name)
  }
  ctx.subagents.getProvider = (name) => {
    const local = name === 'spawn'
    return {
      name,
      capabilities: { agentOptions: local, agentPreset: local },
      ...(local ? { prepareContinuable() {} } : { start() {} }),
    }
  }
  const policy = {
    maxActive: 4,
    maxAddPerTurn: 2,
    backends: normalizeBackends({
      codex: true,
      'claude-code': true,
      example: { provider: 'example', tool: 'subagent_example' },
    }),
  }
  const staffing = createStaffing(ctx, { getPolicy: () => policy })
  const open = (stateFile) => createAllocator(ctx, { staffing, getPolicy: () => policy, stateFile })
  const exec = {
    agent,
    signal: new AbortController().signal,
    toolSet: {
      view: (caller) => {
        assert.equal(caller, agent)
        return definitions
      },
    },
  }
  const run = async (allocator, mode = 'auto', fields = {}) =>
    JSON.parse(await allocator.tool.execute({ mode, ...fields }, exec))
  return { ctx, agent, tasks, roster, calls, control, open, exec, run, policy }
}

test('native tool batch inherits admitted set and signal; simultaneous imports dispatch each revision once', async () => {
  const f = fixture(),
    a = f.open()
  try {
    const [first, next] = await Promise.all([f.run(a), f.run(a)])
    assert.equal(first.results[0].status, 'queued')
    assert.equal(next.results[0].status, 'already-queued')
    assert.equal(f.calls.length, 1)
    const batch = f.calls[0],
      call = batch.calls[0],
      args = JSON.parse(call.arguments)
    assert.equal(batch.signal, f.exec.signal)
    assert.equal(batch.toolSet, f.exec.toolSet)
    assert.equal(batch.agent, f.agent)
    assert.equal(call.name, 'delegate_work')
    assert.match(args.name, /^worker-[0-9a-f]{16}$/)
    f.tasks[0].revision = 2
    assert.equal((await f.run(a)).results[0].status, 'already-queued')
    f.tasks[0].status = 'completed'
    await f.run(a)
    f.tasks.push({ ...f.tasks[0], id: 'task-2', status: 'pending', revision: 1 })
    assert.equal((await f.run(a)).results[0].status, 'queued')
    assert.notEqual(JSON.parse(f.calls[1].calls[0].arguments).name, args.name)
  } finally {
    a.close()
  }
})

test('uncertain activation survives restart and reconciles only against the correct roster entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cooperation-allocation-'))
  let a
  try {
    const f = fixture()
    const file = join(dir, 'test.sqlite')
    a = f.open(file)
    f.control.send = async () => {
      throw new Error('executor lost delivery confirmation')
    }
    const attempt = (await f.run(a)).results[0]
    assert.equal(attempt.status, 'reconcile-required')
    a.close()
    a = f.open(file)
    assert.equal((await f.run(a)).results[0].status, 'reconcile-required')
    f.roster.push({
      kind: 'child',
      id: 'member-one',
      parentId: f.agent.id,
      path: attempt.target,
      activity: 'inactive',
      mode: 'continuable',
    })
    assert.equal((await f.run(a)).results[0].status, 'already-queued')
    assert.equal(f.calls.length, 1)
  } finally {
    a?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconciles a visible native activation immediately after the executor loses its reply', async () => {
  const f = fixture(),
    a = f.open()
  try {
    f.control.send = async (batch) => {
      const { name } = JSON.parse(batch.calls[0].arguments)
      f.roster.push({
        kind: 'child',
        parentId: f.agent.id,
        id: 'visible',
        path: name,
        activity: 'running',
        mode: 'continuable',
      })
      throw new Error('lost reply')
    }
    assert.equal((await f.run(a)).results[0].status, 'reconciled')
    assert.equal((await f.run(a)).results[0].status, 'already-queued')
    assert.equal(f.calls.length, 1)
  } finally {
    a.close()
  }
})

test('read-only reviewer gets a Lead-acceptance brief, and unadmitted native call can be retried later', async () => {
  const f = fixture(),
    a = f.open()
  try {
    f.tasks[0].subject = '[reviewer] Review'
    f.tasks[0].writeScopes = []
    const original = f.control.send
    f.control.send = async (batch) => ({
      results: [
        {
          callId: batch.calls[0].id,
          result: { isError: true, error: { info: { code: 'APPROVAL_REJECTED' } } },
        },
      ],
    })
    assert.equal((await f.run(a)).results[0].status, 'not-dispatched')
    f.control.send = original
    assert.equal((await f.run(a)).results[0].status, 'queued')
    const call = f.calls[1].calls[0],
      args = JSON.parse(call.arguments)
    assert.equal(call.name, 'delegate_review')
    assert.match(args.prompt, /Lead owns/)
    assert.doesNotMatch(args.prompt, /claim/i)
  } finally {
    a.close()
  }
})

test('revalidates task revision and write overlap after the planner finishes', async () => {
  const f = fixture(),
    a = f.open()
  try {
    let reads = 0
    f.ctx.subagents.listDescendants = async () => {
      if (++reads === 2) f.tasks[0].revision++
      return f.roster
    }
    assert.equal((await f.run(a)).results[0].status, 'task-changed')
    reads = 0
    f.ctx.subagents.listDescendants = async () => {
      if (++reads === 2)
        f.tasks.push({
          ...f.tasks[0],
          id: 'task-2',
          status: 'in_progress',
          ready: false,
          writeScopes: ['lib/nested'],
        })
      return f.roster
    }
    assert.equal((await f.run(a)).results[0].status, 'scope-busy')
    assert.equal(f.calls.length, 0)
  } finally {
    a.close()
  }
})

test('checkpoint drain uses send_message and does not resend an uncertain message', async () => {
  const f = fixture(),
    a = f.open()
  try {
    f.roster.push({
      id: 'child',
      path: 'alice',
      mode: 'continuable',
      kind: 'child',
      activity: 'running',
      label: '[worker] task',
    })
    Object.assign(f.tasks[0], { ready: false, status: 'in_progress', ownerId: 'child' })
    f.control.send = async () => {
      throw new Error('ambiguous')
    }
    const response = await a.command.handler({
      agent: f.agent,
      signal: f.exec.signal,
      rawInput: 'stop {"target":"alice"}',
    })
    assert.equal(response.kind, 'success')
    assert.equal(JSON.parse(response.text).paused, true)
    assert.equal((await f.run(a, 'shrink', { target: 'alice' })).results[0].status, 'reconcile-required')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].calls[0].name, 'send_message')
    assert.match(JSON.parse(f.calls[0].calls[0].arguments).message, /safe checkpoint/)
    assert.equal((await f.run(a)).paused, true)
    assert.equal((await f.run(a, 'add')).paused, false)
  } finally {
    a.close()
  }
})

test('external hosts receive complete standalone briefs through admitted tools', async () => {
  for (const [host, tool] of [
    ['codex', 'subagent_codex'],
    ['claude-code', 'subagent_claude_code'],
    ['example', 'subagent_example'],
  ]) {
    const f = fixture(),
      a = f.open()
    const task = f.tasks[0]
    Object.assign(task, {
      subject: '[reviewer] Review signed receipt',
      description: 'Read evidence E-43 and verify the release gate.',
      writeScopes: [],
    })
    f.policy.roleHosts = { reviewer: host }
    f.policy.tiers = { deep: { provider: 'inside', model: 'local', reasoning_effort: 'high' } }
    try {
      const r = await f.run(a, 'add', { role: 'reviewer', ...(host === 'example' ? { host } : {}) })
      assert.equal(r.results[0].status, 'queued')
      const call = f.calls[0].calls[0],
        args = JSON.parse(call.arguments)
      assert.equal(call.name, tool)
      assert.match(args.name, /^reviewer-/)
      assert.match(args.prompt, /task-1/)
      assert.match(args.prompt, /Review signed receipt/)
      assert.match(args.prompt, /evidence E-43/)
      assert.match(args.prompt, /workspaceRelativeWriteScopes/)
      assert.match(args.prompt, /independent verdict/)
      assert.equal(args.provider, undefined)
      assert.equal(args.model, undefined)
      assert.equal(args.reasoning_effort, undefined)
      assert.equal(args.agent_preset, undefined)
      assert.equal(
        (await f.run(a, 'add', { role: 'reviewer', host: 'dsh' })).results[0].status,
        'already-queued',
      )
      assert.equal(f.calls.length, 1)
    } finally {
      a.close()
    }
  }
})

test('request host takes priority over role default and external route does not resume an idle local worker', async () => {
  const f = fixture(),
    a = f.open()
  f.policy.roleHosts = { worker: 'claude-code' }
  f.roster.push({
    id: 'old',
    path: 'old',
    kind: 'child',
    mode: 'continuable',
    activity: 'inactive',
    label: '[worker] previous work',
  })
  try {
    assert.equal(
      (await f.run(a, 'add', { role: 'worker', target: 'old', host: 'codex' })).results[0].status,
      'target-backend-mismatch',
    )
    assert.equal(f.calls.length, 0)
    const r = await a.command.handler({
      agent: f.agent,
      signal: f.exec.signal,
      rawInput: 'add {"role":"worker","host":"codex"}',
    })
    assert.equal(r.kind, 'success', r.text)
    assert.equal(f.calls[0].calls[0].name, 'subagent_codex')
    assert.match(JSON.parse(f.calls[0].calls[0].arguments).prompt, /"lib"/)
  } finally {
    a.close()
  }
})

test('stop survives reopening, auto waits, and repeated drain requests do not resend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pause-allocation-'))
  let a
  try {
    const f = fixture(),
      file = join(dir, 'db.sqlite')
    a = f.open(file)
    f.roster.push({ id: 'running', kind: 'child', path: 'alice', mode: 'continuable', activity: 'running' })
    assert.equal((await f.run(a, 'stop', { target: 'alice' })).results[0].status, 'queued')
    a.close()
    a = f.open(file)
    assert.equal((await f.run(a)).paused, true)
    assert.equal((await f.run(a, 'stop', { target: 'alice' })).results[0].status, 'already-queued')
    assert.equal(f.calls.length, 1)
    assert.equal((await f.run(a, 'add')).paused, false)
    assert.equal(f.calls.length, 2)
  } finally {
    a?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an explicit turn ID enforces a shared start quota across repeated allocations', async () => {
  const f = fixture(),
    a = f.open()
  Object.assign(f.policy, { maxAddPerTurn: 1, turnId: 10 })
  try {
    assert.equal((await f.run(a, 'add')).results[0].status, 'queued')
    f.tasks.push({ ...f.tasks[0], id: 'task-2', writeScopes: ['docs'] })
    assert.equal((await f.run(a, 'add')).results[0].status, 'turn-budget')
    assert.equal(f.calls.length, 1)
    f.policy.turnId = 11
    assert.equal((await f.run(a, 'add')).results[0].status, 'queued')
    assert.equal(f.calls.length, 2)
  } finally {
    a.close()
  }
})

test('subsequent rounds skip outstanding one-shot assignments and preserve original scopes until adoption', async () => {
  const f = fixture(),
    a = f.open()
  try {
    const first = f.tasks[0]
    f.policy.maxActive = 2
    f.policy.maxAddPerTurn = 1
    await f.run(a, 'add', { host: 'codex' })
    const running = JSON.parse(f.calls[0].calls[0].arguments).name
    f.roster.push({
      kind: 'child',
      mode: 'external',
      activity: 'inactive',
      id: 'external-id',
      path: running,
      parentId: f.agent.id,
    })
    first.writeScopes = ['renamed']
    first.revision++
    f.tasks.push(
      { ...first, id: 'overlap', revision: 1, writeScopes: ['lib/core'] },
      { ...first, id: 'other', revision: 1, writeScopes: ['docs'] },
    )
    const next = await f.run(a, 'auto')
    assert.equal(next.results[0].taskId, 'other')
    assert.equal(f.calls.length, 2)
    f.tasks.push({ ...first, id: 'spare', revision: 1, writeScopes: ['ui'] })
    await f.run(a, 'auto')
    assert.equal(f.calls.length, 2)
    first.status = 'completed'
    first.ready = false
    const third = await f.run(a, 'auto')
    assert.equal(third.results[0].taskId, 'overlap')
    assert.equal(f.calls.length, 3)
  } finally {
    a.close()
  }
})

test('a per-assignment model request reaches only a model-selectable host', async () => {
  const f = fixture()
  const a = f.open()
  const llm = { provider: 'demo', model: 'allowed-model', reasoning_effort: 'high' }
  try {
    await assert.rejects(f.run(a, 'add', { host: 'codex', llm }))
    assert.equal(f.calls.length, 0)
    assert.equal((await f.run(a, 'add', { host: 'dsh', llm })).results[0].status, 'queued')
    const args = JSON.parse(f.calls[0].calls[0].arguments)
    assert.deepEqual([args.provider, args.model, args.reasoning_effort], ['demo', 'allowed-model', 'high'])
  } finally {
    a.close()
  }
})

test('a continuation rechecks the dependency owner before sending a review', async () => {
  const f = fixture()
  const a = f.open()
  try {
    Object.assign(f.tasks[0], { subject: '[reviewer] First review', writeScopes: [] })
    const prior = (await f.run(a)).results[0]
    const reviewer = { id: 'review-session', path: prior.target, parentId: f.agent.id,
      kind: 'child', mode: 'continuable', activity: 'inactive', label: '[reviewer] previous work' }
    f.roster.push(reviewer)
    const candidate = { id: 'candidate', revision: 1, subject: '[worker] Candidate', status: 'completed',
      ready: false, writeScopes: ['src'], ownerName: 'original-author' }
    const nextReview = { ...f.tasks[0], id: 'new-review', blockedBy: [candidate.id] }
    Object.assign(f.tasks[0], { status: 'completed', ready: false })
    f.tasks.push(candidate, nextReview)
    let reads = 0
    f.ctx.subagents.listDescendants = async () => {
      if (++reads === 2) candidate.ownerName = reviewer.path
      return f.roster
    }
    const result = await f.run(a, 'add', { role: 'reviewer', target: reviewer.path })
    assert.equal(result.results[0].status, 'target-changed')
    assert.equal(f.calls.length, 1)
  } finally {
    a.close()
  }
})

test('a replacement for an idle worker receives the selected DSH model tier', async () => {
  const f = fixture()
  const a = f.open()
  const deep = { provider: 'sample-provider', model: 'sample-deep', reasoning_effort: 'high' }
  f.policy.tiers = { deep }
  f.roster.push({ id: 'idle', path: 'idle', kind: 'child', mode: 'continuable', activity: 'inactive', label: '[worker] prior' })
  try {
    assert.equal((await f.run(a, 'add', { tier: 'deep' })).results[0].status, 'queued')
    const call = f.calls[0].calls[0]
    assert.equal(call.name, 'delegate_work')
    const args = JSON.parse(call.arguments)
    for (const [field, value] of Object.entries(deep)) assert.equal(args[field], value)
  } finally {
    a.close()
  }
})

test('a resumed observer can drain each checkpoint once', async () => {
  const f = fixture()
  const a = f.open()
  f.roster.push({ id: 'member', path: 'developer', kind: 'child', mode: 'continuable', activity: 'running' })
  const observe = (checkpoint) => f.run(a, 'add', { role: 'observer', target: 'developer', checkpoint })
  try {
    const started = (await observe('first')).results[0]
    const observer = { id: 'observer-session', path: started.target, parentId: f.agent.id, kind: 'child', mode: 'continuable', activity: 'running', label: '[observer] observation' }
    f.roster.push(observer)
    const drain = () => f.run(a, 'shrink', { target: started.target })
    assert.equal((await drain()).results[0].status, 'queued')
    assert.equal((await drain()).results[0].status, 'already-queued')
    observer.activity = 'inactive'
    const resumed = (await observe('second')).results[0]
    assert.deepEqual([resumed.tool, resumed.target, resumed.status], ['send_message', started.target, 'queued'])
    observer.activity = 'running'
    assert.equal((await drain()).results[0].status, 'queued')
    assert.equal((await drain()).results[0].status, 'already-queued')
    assert.equal(f.calls.length, 4)
  } finally {
    a.close()
  }
})

test('direct observations repeat at a later turn and deduplicate within one turn', async () => {
  const f = fixture()
  const allocator = f.open()
  const options = { role: 'observer', target: 'developer' }
  f.roster.push({ kind: 'child', id: 'member-1', path: 'developer', activity: 'running', mode: 'continuable' })
  try {
    f.policy.turnId = 17
    assert.equal((await f.run(allocator, 'add', options)).results[0].status, 'queued')
    assert.equal((await f.run(allocator, 'add', options)).results[0].status, 'already-queued')
    f.policy.turnId = 18
    assert.equal((await f.run(allocator, 'add', options)).results[0].status, 'queued')
    assert.equal(f.calls.length, 2)
  } finally {
    allocator.close()
  }
})

test('manual observations can keep the same checkpoint through recovery and request a fresh one', async () => {
  const f = fixture()
  const dir = await mkdtemp(join(tmpdir(), 'observer-checkpoint-'))
  const db = join(dir, 'test.sqlite')
  let allocator = f.open(db)
  const observe = (checkpoint) => allocator.command.handler({
    agent: f.agent,
    signal: f.exec.signal,
    rawInput: 'add ' + JSON.stringify({ role: 'observer', target: 'developer', checkpoint }),
  })
  f.roster.push({ kind: 'child', id: 'member-1', path: 'developer', activity: 'running', mode: 'continuable' })
  try {
    const first = await observe('candidate-a')
    assert.equal(first.kind, 'success')
    assert.equal(JSON.parse(first.text).results[0].status, 'queued')
    assert.match(JSON.parse(f.calls[0].calls[0].arguments).prompt, /candidate-a/)
    allocator.close()
    allocator = f.open(db)
    f.policy.turnId = 20
    f.policy.roleHosts = { observer: 'codex' }
    assert.equal(JSON.parse((await observe('candidate-a')).text).results[0].status, 'already-queued')
    assert.equal(JSON.parse((await observe('candidate-b')).text).results[0].status, 'queued')
    assert.equal(f.calls.length, 2)
    assert.match(JSON.parse(f.calls[1].calls[0].arguments).prompt, /"checkpoint":"candidate-b"/)
  } finally {
    allocator.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('denies descendants and honors a zero start budget', async () => {
  const f = fixture(),
    a = f.open()
  try {
    const child = { ...f.agent, id: 'child' }
    assert.equal(a.when({ agent: child }), false)
    await assert.rejects(a.tool.execute({ mode: 'add' }, { ...f.exec, agent: child }), /Lead/)
    f.policy.remainingStarts = 0
    assert.equal((await f.run(a)).results.length, 0)
    assert.equal(f.calls.length, 0)
  } finally {
    a.close()
  }
})
