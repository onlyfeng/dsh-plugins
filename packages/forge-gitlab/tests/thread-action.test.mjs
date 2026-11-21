import assert from 'node:assert/strict'
import test from 'node:test'
import { createWriteReview, validateThreadWrite } from '../thread-action.js'

const host = 'forge.example.test'
const repository = { forge: 'gitlab', host, owner: 'group/sub', name: 'widget' }
const ref = { repository, number: 7 }
const head = '1'.repeat(40), threadID = '2'.repeat(40)
const path = 'projects/group%2Fsub%2Fwidget/merge_requests/7'
const mr = { iid: 7, id: 21, sha: head, diff_refs: { head_sha: head, base_sha: 'a'.repeat(40), start_sha: 'b'.repeat(40) } }
const root = { id: 41, body: 'Example', created_at: '2026-05-10T00:00:00Z', system: false, resolved: false, resolvable: true,
  position: { ...mr.diff_refs, position_type: 'text', new_path: 'README.md', old_path: 'README.md', new_line: 6 } }
const discussion = { id: threadID, individual_note: false, notes: [root] }
const reply = { kind: 'reply', pending: false, thread: threadID, headSha: head, body: '  Public fixture.\nThanks.  ' }
const resolve = resolved => ({ kind: 'resolve', headSha: head, thread: threadID, resolved })
const ack = { id: 55, noteable_type: 'MergeRequest', noteable_id: 21, noteable_iid: 7, body: reply.body }
const signal = new AbortController().signal
function setup({ before = mr, after = mr, row = discussion, grants = { reply: true, resolve: true },
  consult = async () => new Map([[threadID, grants]]), send = async () => ack } = {}) {
  const calls = []
  const write = createWriteReview({ hosts: [host], get: async (h, url) => {
    assert.equal(h, host)
    const initial = !calls.length
    calls.push(url)
    if (url === path) return initial ? before : after
    assert.equal(url, `${path}/discussions/${threadID}`)
    return row
  }, permissions: async (target, threads, s) => {
    assert.deepEqual(target, ref); assert.equal(threads[0].id, threadID); calls.push('permissions'); return consult(s)
  }, mutate: async (target, action, s) => { assert.deepEqual(target, ref); calls.push('mutation'); return send(action, s) } })
  return { write, calls }
}

test('submits the exact immediate reply once, following a final head check', async () => {
  const { write, calls } = setup({ send: async (action, s) => { assert.deepEqual(action, reply); assert.equal(s, signal); return ack } })
  assert.deepEqual(await write(ref, reply, signal), { ok: true })
  assert.deepEqual(calls, [path, `${path}/discussions/${threadID}`, 'permissions', path, 'mutation'])
})
test('rejects unsupported operations, invalid targets, quick actions and oversized replies before I/O', async () => {
  const { write, calls } = setup()
  for (const action of [{ ...reply, pending: true }, { ...reply, kind: 'submit-pending' }, { ...reply, thread: '../x' }, { ...reply, headSha: 'main' },
    { ...reply, pending: undefined }, { ...reply, body: '' }, { ...reply, body: 'hello\r\n  /close' }, { ...reply, body: 'hello\r/merge' },
    { ...reply, body: '汉'.repeat(333334) }, { ...resolve(true), resolved: 'true' }]) {
    assert.ok(validateThreadWrite(action)); assert.equal((await write(ref, action, signal)).ok, false)
  }
  assert.equal((await write({ ...ref, repository: { ...repository, host: 'other.test' } }, reply, signal)).ok, false)
  assert.deepEqual(calls, [])
})
test('stale head is refused before and after checking thread permissions', async () => {
  for (const opts of [{ before: { ...mr, sha: '3'.repeat(40) } }, { after: { ...mr, sha: '3'.repeat(40) } },
    { after: { ...mr, diff_refs: { ...mr.diff_refs, base_sha: '4'.repeat(40) } } }]) {
    const { write, calls } = setup(opts)
    assert.equal((await write(ref, reply, signal)).code, 'stale'); assert.ok(!calls.includes('mutation'))
  }
})
test('reply or resolve privileges must be granted for the exact selected discussion', async () => {
  for (const [opts, action] of [[{ grants: { reply: false, resolve: true } }, reply], [{ grants: { reply: true, resolve: false } }, resolve(true)],
    [{ row: { ...discussion, id: 'f'.repeat(40) } }, reply], [{ row: { ...discussion, individual_note: true } }, reply],
    [{ row: { ...discussion, notes: [{ ...root, resolvable: false }] } }, resolve(true)],
    [{ consult: async () => { throw new Error('private GraphQL diagnostics') } }, reply]]) {
    const { write, calls } = setup(opts)
    const result = await write(ref, action, signal)
    assert.equal(result.ok, false); assert.ok(!calls.includes('mutation')); assert.doesNotMatch(result.message, /private/)
  }
})
test('resolution actions verify the requested state, and a known target state is a no-op', async () => {
  for (const desired of [true, false]) {
    const row = { ...discussion, notes: [{ ...root, resolved: !desired }] }
    const { write, calls } = setup({ row, send: async () => ({ ...row, notes: [{ ...root, resolved: desired }] }) })
    assert.deepEqual(await write(ref, resolve(desired), signal), { ok: true }); assert.equal(calls.at(-1), 'mutation')
    const noop = setup({ row }); assert.deepEqual(await noop.write(ref, resolve(!desired), signal), { ok: true }); assert.ok(!noop.calls.includes('mutation'))
    for (const bad of [{ id: threadID }, { id: threadID, resolved: !desired }, { id: 'other', resolved: desired }]) {
      const fail = setup({ row, send: async () => bad })
      assert.equal((await fail.write(ref, resolve(desired), signal)).code, 'unknown')
    }
  }
})
test('ambiguous outcomes are not retried, including malformed success and cancellation after dispatch', async () => {
  const cases = [async () => ({}), async () => ({ ...ack, id: root.id }), async () => ({ ...ack, body: 'different' }),
    async () => ({ ...ack, noteable_id: 12 }), async () => { throw new Error('private diagnostic') }]
  for (const send of cases) {
    const { write, calls } = setup({ send }); const result = await write(ref, reply, signal)
    assert.equal(result.code, 'unknown'); assert.equal(calls.filter(x => x === 'mutation').length, 1); assert.doesNotMatch(result.message, /private diagnostic/)
  }
  const controller = new AbortController()
  const { write } = setup({ send: async () => { controller.abort(); throw controller.signal.reason } })
  assert.equal((await write(ref, reply, controller.signal)).code, 'unknown')
  const refused = setup({ send: async () => { throw Object.assign(new Error(), { code: 'failed' }) } })
  assert.equal((await refused.write(ref, reply, signal)).code, 'failed')
})
test('a second action on the same discussion is rejected while the first one is in flight', async () => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers()
  const { write, calls } = setup({ send: async () => { started.resolve(); await gate.promise; return ack } })
  const first = write(ref, reply, signal); await started.promise
  try { assert.equal((await write(ref, resolve(true), signal)).code, 'failed') } finally { gate.resolve() }
  assert.deepEqual(await first, { ok: true }); assert.equal(calls.filter(x => x === 'mutation').length, 1)
})
test('uses the selected target and exact reply even if the caller changes its objects during preflight', async () => {
  const target = { repository: { ...repository }, number: ref.number }
  const action = { ...reply }
  const { write } = setup({ consult: async () => {
    target.repository.name = 'another'; target.number++
    action.body = 'another reply'; action.thread = 'f'.repeat(40)
    return new Map([[threadID, { reply: true }]])
  }, send: async saved => { assert.deepEqual(saved, reply); return ack } })
  assert.deepEqual(await write(target, action, signal), { ok: true })
})
test('cancellation during preflight sends no mutation', async () => {
  const controller = new AbortController(), reason = new Error('cancelled')
  const { write, calls } = setup({ consult: async () => { controller.abort(reason); return new Map([[threadID, { reply: true }]]) } })
  await assert.rejects(write(ref, reply, controller.signal), err => err === reason)
  assert.ok(!calls.includes('mutation'))
})
