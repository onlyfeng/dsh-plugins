import test from 'node:test'
import assert from 'node:assert/strict'
import { createStaffing, planStaffing } from '../staffing.js'

function task(id, role, scopes = [], extra = {}) {
  return {
    id,
    revision: 1,
    subject: `[${role}] Example task`,
    writeScopes: scopes,
    status: 'pending',
    ready: true,
    blockedBy: [],
    ...extra,
  }
}
function member(name, role, activity = 'inactive', extra = {}) {
  return {
    kind: 'child',
    id: `session-${name}`,
    path: name,
    mode: 'continuable',
    activity,
    label: `[${role}] Example assignment`,
    ...extra,
  }
}

test('allocates a bounded burst and leaves a quiet board idle', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => task(`task-${i + 1}`, 'worker', [`src/pkg${i}`]))
  const result = planStaffing(tasks, [], { maxActive: 3, maxAddPerTurn: 2 })
  assert.deepEqual(
    result.steps.map((s) => s.taskId),
    ['task-1', 'task-2'],
  )
  assert.ok(
    result.steps.every(
      (s) => s.tool === 'delegate_work' && s.routeKey === 'inherit' && !('provider' in s.args),
    ),
  )
  assert.equal(planStaffing(tasks, [], { maxActive: 4, maxAddPerTurn: 3, spentThisTurn: 2 }).steps.length, 1)
  assert.equal(planStaffing(tasks, [], { remainingStarts: 0 }).steps.length, 0)
  assert.equal(planStaffing([], [member('idle', 'worker')]).steps.length, 0)
})

test('reserves prefix scopes for claimed and planned work, ignores blocked and owned tasks', () => {
  const tasks = [
    task('busy', 'worker', ['src/core'], { status: 'in_progress', ready: false, ownerId: 'person' }),
    task('same', 'worker', ['SRC/Core/file']),
    task('a', 'worker', ['src/core2']),
    task('b', 'worker', ['src/core2/sub']),
    task('blocked', 'worker', ['free'], { ready: false }),
    task('owned', 'worker', ['other'], { ownerId: 'person' }),
    task('c', 'worker', ['src/narrow']),
  ]
  const result = planStaffing(tasks, [], { maxActive: 8, maxAddPerTurn: 8 })
  assert.deepEqual(
    result.steps.map((s) => s.taskId),
    ['a', 'c'],
  )
  assert.deepEqual(
    result.deferred.map((t) => t.taskId),
    ['same', 'b'],
  )
})

test('prioritizes independent reviewers and validators when the board accumulates ready gates', () => {
  const author = member('author', 'reviewer')
  const tasks = [
    task('worker', 'worker', ['lib']),
    task('verify', 'validator'),
    task('review', 'reviewer', [], { blockedBy: ['candidate'] }),
    task('candidate', 'worker', ['lib'], { status: 'completed', ready: false, ownerId: author.id }),
  ]
  const result = planStaffing(tasks, [author], {
    maxAddPerTurn: 2,
    tiers: { deep: { provider: 'test-provider', model: 'test-deep', reasoning_effort: 'high' } },
  })
  assert.deepEqual(
    result.steps.map((s) => s.tool),
    ['delegate_review', 'delegate_validate'],
  )
  assert.equal(result.steps[0].args.model, 'test-deep')
  assert.equal(result.steps[0].args.reasoning_effort, 'high')
  assert.equal(result.steps[1].routeKey, 'inherit')
  assert.ok(
    planStaffing(tasks, [author], {}, { role: 'reviewer', target: 'author' }).deferred[0].reason.includes(
      'independent',
    ),
  )
})

test('an author recorded by member path cannot review the dependent task', () => {
  const author = member('team/author', 'reviewer')
  const peer = member('team/peer', 'reviewer')
  const tasks = [
    task('candidate', 'worker', ['lib'], { status: 'completed', ready: false, ownerName: author.path }),
    task('review', 'reviewer', [], { blockedBy: ['candidate'] }),
  ]
  const explicit = planStaffing(tasks, [author, peer], {}, { role: 'reviewer', target: author.path })
  assert.deepEqual(explicit.steps, [])
  assert.match(explicit.deferred[0].reason, /independent/)
  const automatic = planStaffing(tasks, [author, peer])
  assert.equal(automatic.steps[0].target, peer.path)
})

test('uses a configured fallback route and preserves an existing member route', () => {
  const tasks = [task('t', 'validator')]
  const policy = { tiers: { default: { provider: 'demo', model: 'base' } } }
  assert.equal(planStaffing(tasks, [], policy, { tier: 'light' }).steps[0].args.model, 'base')
  const step = planStaffing(tasks, [member('tester', 'validator')], policy, { target: 'tester' }).steps[0]
  assert.equal(step.tool, 'send_message')
  assert.equal(step.routeKey, 'existing-session')
  assert.equal(step.args.agent, 'tester')
})

test('targets an existing member for observation or a separately scoped assistant', () => {
  const developer = member('developer', 'worker', 'running')
  const observer = planStaffing([], [developer], {}, { mode: 'add', role: 'observer', target: 'developer' })
    .steps[0]
  assert.equal(observer.tool, 'delegate_observe')
  assert.equal(observer.attachedTo, 'developer')
  assert.equal(observer.taskId, null)
  const tasks = [task('support', 'assistant', ['docs'])]
  const support = planStaffing(tasks, [developer], {}, { role: 'assistant', target: 'developer' }).steps[0]
  assert.equal(support.tool, 'delegate_assist')
  assert.equal(support.taskId, 'support')
  assert.throws(() => planStaffing(tasks, [], {}, { target: 'missing' }), /not found/)
  assert.equal(
    planStaffing(tasks, [developer], {}, { mode: 'add', role: 'worker', target: 'developer' }).steps[0]
      .action,
    'wait-for-checkpoint',
  )
})

test('counts running and uncertain slots, and requests a checkpoint before draining a busy owner', () => {
  const m = member('owner', 'worker', 'running')
  const tasks = [
    task('t', 'worker', ['src'], { ownerId: m.id, status: 'in_progress', ready: false }),
    task('next', 'worker', ['docs']),
  ]
  const roster = [
    m,
    member('idle', 'assistant'),
    { kind: 'diagnostic', id: 'unreadable', reason: 'unavailable' },
  ]
  const auto = planStaffing(tasks, roster)
  assert.deepEqual([auto.capacity.active, auto.capacity.unknown, auto.capacity.inactive], [1, 1, 1])
  assert.equal(auto.steps.length, 0)
  const drain = planStaffing(tasks, roster, {}, { mode: 'shrink', target: 'owner' }).steps[0]
  assert.deepEqual([drain.action, drain.tool, drain.taskId], ['drain-at-checkpoint', 'send_message', 't'])
  const quiet = planStaffing(tasks, roster, {}, { mode: 'stop', target: 'idle' }).steps[0]
  assert.equal(quiet.action, 'leave-idle')
  assert.equal(quiet.tool, null)
})

test('command and tool read the same exact root and signal, with no mutation', async () => {
  const root = { id: 'r', session: { header: { agentPreset: 'federated-team' } } }
  const child = { id: 'c', session: { header: { agentPreset: 'federated-team' } } }
  const signal = new AbortController().signal
  const ctx = {
    agentTeams: {
      isEnabled: (a) => a === root,
      listTasks(a) {
        assert.equal(a, root)
        return [task('t', 'worker', ['src'])]
      },
    },
    subagents: {
      rootOf: () => root,
      async listDescendants(id, s) {
        assert.equal(id, 'r')
        assert.equal(s, signal)
        return []
      },
    },
  }
  const staffing = createStaffing(ctx, {
    getPolicy: (a) => {
      assert.equal(a, root)
      return { maxActive: 1 }
    },
  })
  const args = { action: 'plan', mode: 'add', count: 1, role: 'worker' }
  const tool = JSON.parse(await staffing.tool.execute(args, { agent: root, signal }))
  const cmd = await staffing.command.handler({
    agent: root,
    signal,
    rawInput: 'plan {"mode":"add","count":1,"role":"worker"}',
  })
  assert.equal(cmd.kind, 'success')
  assert.deepEqual(JSON.parse(cmd.text), tool)
  assert.equal(staffing.when({ agent: child }), false)
  assert.equal(staffing.prompt.text({ agent: child }), '')
  assert.match(staffing.prompt.text({ agent: root }), /team_staffing/)
  await assert.rejects(staffing.tool.execute(args, { agent: child, signal }), /Lead session/)
  assert.equal(
    (await staffing.command.handler({ agent: root, signal, rawInput: 'plan {"mode":"shrink","count":-1}' }))
      .kind,
    'error',
  )
})
