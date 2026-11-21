import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRange } from '../../../scripts/ocr-fixture-range.mjs'
import { createImportCommand } from '../host.js'
import { buildPlan } from '../receipts.js'

const folder = new URL('./fixtures/producer-rename-delete/', import.meta.url)
const runId = 'ec508a9a86e29b4b42e11fa0500fa70501979e33e73490bac7b18b8e690e8e85'
const fingerprint = '5103141fcc7a6cf61879ea34aa03a5f16febcb370dc01e8bfcad060c35361ec9'
const renamedItem = 'a6a6c78bfaf96eb6a9c1941b7406cc171be1c8a7e9f52eb578cd4ae8e94771f4'
const removedItem = '8f0c85bd250b634d32a4e196f395958f16d9ea885b8f9977c583687002114d0b'
const discussion = 'ff98a04cff349b5b8ef04595f429af02c0af42d1'
const oldPath = 'src/extent.js'
const newPath = 'src/span.js'
const removedPath = 'src/retired-unit.js'

async function capture() {
  async function load(name, expected) {
    const bytes = await readFile(new URL(name, folder))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name)
    return JSON.parse(bytes)
  }
  return {
    runId,
    manifest: await load('manifest.json', 'f2185929ec229515a596607a7d217cb246102a616b7316b422874acdd26980a2'),
    result: await load('result.json', 'd4f4347e139e8e884e21357a4874a5f47577f9d634284bbe1078d326603e766c'),
    receipt: await load('publication-receipt.json', '9e775f59dec4dfb3e0ee1649f302e882dd1bded7eabc7765d779ce4006db6242'),
  }
}

test('joins the reviewed rename to its confirmed thread and accounts for the deleted path', async () => {
  const docs = await capture()
  const plan = buildPlan(docs)
  assert.equal(plan.runId, runId)
  assert.deepEqual(docs.result.coverage.reviewed.map(item => [item.item_id, item.old_path, item.path]),
    [[renamedItem, oldPath, newPath]])
  assert.deepEqual(docs.result.coverage.excluded, [{ item_id: removedItem, path: removedPath, exclude_reason: 'deleted' }])
  assert.deepEqual(plan.excluded, [{ path: removedPath, reason: 'deleted' }])
  assert.equal(plan.findings.length, 1)
  const finding = plan.findings[0]
  assert.deepEqual([finding.fingerprint, finding.oldPath, finding.path, finding.startLine, finding.endLine, finding.discussionId, finding.noteId],
    [fingerprint, oldPath, newPath, 10, 10, discussion, 21])
  assert.equal(plan.summaryNoteId, 22)
})

test('rebuilds the source range and reuses the original task only for the current MR', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'span-history-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const live = await createRange(join(scratch, 'repo'))
  const docs = await capture()
  const plan = buildPlan(docs)
  assert.equal(live.headSha, plan.snapshot.headSha)
  assert.equal(live.baseSha, plan.snapshot.baseSha)
  assert.deepEqual(live.files.map(({ diff, ...file }) => file), docs.manifest.snapshot.files.map(({ diff, ...file }) => file))
  assert.match(live.files[0].diff, /\+  return low - high/)

  const agent = { id: 'public-capture', session: { id: 'public-capture' } }
  const events = []
  let current = live
  const project = { loadPlan: async () => plan, belongs: value => value === plan, readCurrent: async () => current }
  const ctx = {
    subagents: { rootOf: () => agent },
    sessions: { flush: async () => true },
    sessionQuery: { readSession: async () => ({ session: agent.session, inheritedEventCount: 0, events }) },
    agentTeams: { isEnabled: () => true, createTask: async (_, request) => {
      const task = { ...request, id: `task-${events.length + 1}`, revision: 1, status: 'pending' }
      events.push({ type: 'team/task', data: { version: 2, teamId: agent.id, task } })
      return task
    } },
  }
  const run = () => createImportCommand(ctx, async () => project).handler({ agent, rawInput: `import ${runId}`, signal: new AbortController().signal })
  for (const [created, reused] of [[1, 0], [0, 1]]) {
    const response = await run()
    assert.equal(response.kind, 'success', response.text)
    const report = JSON.parse(response.text)
    assert.deepEqual([report.created, report.reused, report.tasks[0].taskId], [created, reused, 'task-1'])
  }
  const task = events[0].data.task
  assert.deepEqual(task.writeScopes, [newPath])
  assert.equal(task.description.split('\n')[0], `[ocr-team:v1:${runId}:${fingerprint}]`)
  for (const delta of [{ headSha: live.baseSha }, { targetTip: live.headSha }, { diffVersionId: live.diffVersionId + 1 }, { state: 'merged' }, { draft: true }]) {
    current = { ...live, ...delta }
    assert.equal((await run()).kind, 'error', JSON.stringify(delta))
  }
  assert.equal(events.length, 1)
})

test('rejects inconsistent coverage, finding fingerprints and unconfirmed discussions', async () => {
  for (const [code, mutate] of [
    ['invalid-coverage-item', d => { d.result.coverage.reviewed[0].old_path = newPath }],
    ['invalid-coverage-item', d => { d.result.coverage.excluded[0].item_id = renamedItem }],
    ['incomplete-coverage', d => { d.result.coverage.excluded = [] }],
    ['finding-fingerprint', d => { d.result.findings[0].body += ' changed' }],
    ['unconfirmed-discussion', d => { delete d.receipt.items[0].discussionId }],
  ]) {
    const docs = await capture()
    mutate(docs)
    assert.throws(() => buildPlan(docs), { code })
  }
})
