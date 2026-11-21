import test from 'node:test'
import assert from 'node:assert/strict'
import { createImportCommand } from '../host.js'

const runId = 'a'.repeat(64)
const snap = { instanceId: 'demo', projectId: 5, iid: 8, sourceProjectId: 5, targetProjectId: 5, sourceBranch: 'feature', targetBranch: 'main',
  headSha: '1'.repeat(40), baseSha: '2'.repeat(40), startSha: '3'.repeat(40), targetTip: '4'.repeat(40), diffVersionId: 7 }
function fixture() {
  const root = { id: 'test-board', session: { id: 'test-board' } }
  const log = { session: root.session, events: [], inheritedEventCount: 0 }
  const findings = [1, 2].map(i => ({ fingerprint: String(i).repeat(64), body: 'Review evidence\nMore details', path: `lib/file${i}.js`,
    endLine: i, noteId: i, discussionId: String(i).repeat(40) }))
  const plan = { runId, snapshot: snap, findings }
  const ctx = { subagents: { rootOf: () => root }, sessions: { flush: async () => true }, sessionQuery: { readSession: async () => structuredClone(log) },
    agentTeams: { isEnabled: () => true, createTask: async (agent, request, signal) => {
      assert.equal(agent, root)
      signal.throwIfAborted()
      const task = { ...request, id: `task-${log.events.length + 1}`, revision: 1, status: 'pending' }
      log.events.push({ type: 'team/task', data: { version: 2, teamId: root.id, task } })
      return task
    } } }
  const adapter = { loadPlan: async () => plan, belongs: p => p === plan, readCurrent: async () => ({ ...snap, state: 'opened', draft: false }) }
  const selection = { value: adapter }
  const run = (action = 'import', agent = root, signal = new AbortController().signal) =>
    createImportCommand(ctx, async () => selection.value).handler({ agent, rawInput: ` ${action} ${runId}`, signal })
  return { root, ctx, log, plan, adapter, selection, run }
}
function report(result) { assert.equal(result.kind, 'success', result.text); return JSON.parse(result.text) }

test('stable v1 identity survives edits, deletion and concurrent re-import', async () => {
  const { root, log, run, plan } = fixture()
  const original = { type: 'team/task', data: { version: 2, teamId: root.id, task: {
    revision: 1, id: 'task-1', description: `[ocr-team:v1:${runId}:${plan.findings[0].fingerprint}]\nEarlier import` } } }
  log.events.push(original, { ...original, data: { ...original.data, task: { ...original.data.task, revision: 2, description: 'edited', status: 'deleted' } } })
  const preview = report(await run('preview'))
  assert.deepEqual(preview.tasks.map(t => t.taskId), ['task-1', null])
  const reports = (await Promise.all([run(), run(), run()])).map(report)
  assert.deepEqual(reports.map(r => [r.created, r.reused]), [[1, 1], [0, 2], [0, 2]])
  const added = log.events.at(-1).data.task
  assert.deepEqual(added.writeScopes, ['lib/file2.js'])
  assert.match(added.description, /> Review evidence\n> More details/)
})

test('checks scope after receipt reads, current reads, history, creation and final flush', async () => {
  for (const stage of ['receipt', 'current', 'history', 'create', 'flush']) {
    const { selection, adapter, ctx, run, log } = fixture()
    if (stage === 'flush') report(await run())
    const [obj, key] = { receipt: [adapter, 'loadPlan'], current: [adapter, 'readCurrent'], history: [ctx.sessionQuery, 'readSession'],
      create: [ctx.agentTeams, 'createTask'], flush: [ctx.sessions, 'flush'] }[stage]
    const original = obj[key]
    obj[key] = async (...args) => { const result = await original(...args); selection.value = { ...adapter }; return result }
    assert.equal((await run()).kind, 'error', stage)
    assert.equal(log.events.length, stage === 'create' ? 1 : stage === 'flush' ? 2 : 0, stage)
  }
})

test('rejects non-root, disabled Team, unknown checkout, invalid paths and mismatched receipt', async () => {
  for (const mode of ['child', 'disabled', 'missing', 'foreign', '../escape', 'C:/absolute', '/root', 'bad\\path', 'aux.txt']) {
    const { root, adapter, selection, ctx, run, log, plan } = fixture()
    let loaded = 0, queried = 0
    adapter.loadPlan = async () => { loaded++; return plan }
    const checkCurrent = adapter.readCurrent
    adapter.readCurrent = async () => { queried++; return checkCurrent() }
    if (mode === 'disabled') ctx.agentTeams.isEnabled = () => false
    else if (mode === 'missing') selection.value = undefined
    else if (mode === 'foreign') adapter.belongs = () => false
    else if (mode !== 'child') plan.findings[1].path = mode
    assert.equal((await run('import', mode === 'child' ? { id: 'child' } : root)).kind, 'error')
    assert.equal(loaded, ['child', 'disabled', 'missing'].includes(mode) ? 0 : 1)
    assert.equal(queried, 0)
    assert.equal(log.events.length, 0)
  }
})

test('rechecks MR pins per creation and resumes an interrupted import', async () => {
  const { adapter, run, log } = fixture()
  const original = adapter.readCurrent
  adapter.readCurrent = async () => log.events.length === 1 ? { ...await original(), targetTip: '9'.repeat(40) } : original()
  assert.equal((await run()).kind, 'error')
  assert.equal(log.events.length, 1)
  adapter.readCurrent = original
  const retried = report(await run())
  assert.deepEqual([retried.reused, retried.created, log.events.length], [1, 1, 2])
})

test('reconciles uncertain append and requires an acknowledged save', async () => {
  for (const append of [true, false]) {
    const { ctx, run, log } = fixture()
    const create = ctx.agentTeams.createTask
    ctx.agentTeams.createTask = async (...args) => {
      if (append) await create(...args)
      throw Object.assign(new Error('synthetic secret'), { code: 'TEAM_TASK_PERSISTENCE_UNCONFIRMED' })
    }
    ctx.sessions.flush = async () => false
    const failure = await run()
    assert.equal(failure.kind, 'error')
    assert.doesNotMatch(failure.text, /synthetic secret/)
    assert.equal(log.events.length, append ? 1 : 0)
    ctx.agentTeams.createTask = create
    ctx.sessions.flush = async () => true
    assert.equal(report(await run()).reused, append ? 1 : 0)
    assert.equal(log.events.length, 2)
  }
})

test('ignores inherited and foreign journal entries and preserves cancellation', async () => {
  const { ctx, log, run, root, plan } = fixture()
  const task = { revision: 1, id: 'task-1', description: `[ocr-team:v1:${runId}:${plan.findings[0].fingerprint}]` }
  for (const teamId of [root.id, 'different-board']) log.events.push({ type: 'team/task', data: { version: 2, teamId, task } })
  log.inheritedEventCount = 1
  assert.equal(report(await run()).created, 2)
  const controller = new AbortController()
  const reason = new Error('cancelled')
  ctx.sessionQuery.readSession = async () => { controller.abort(reason); return log }
  await assert.rejects(run('import', root, controller.signal), e => e === reason)
})
