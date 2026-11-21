import assert from 'node:assert/strict'
import test from 'node:test'
import { createThreadPermissions } from '../permissions.js'

const host = 'git.example.test'
const ref = { repository: { host, owner: 'team/sub', name: 'service' }, number: 7 }
const thread = (id, noteId) => ({ id, comments: [{ id: String(noteId) }] })
function node(id, noteId, createNote = true, resolveNote = true) {
  return { id: `gid://gitlab/Discussion/${id}`, notes: { nodes: [{ id: `gid://gitlab/Note/${noteId}`, userPermissions: { createNote, resolveNote } }] } }
}
function response(nodes, { createNote = true, cursor = null, iid = '7' } = {}) {
  return { data: { project: { mergeRequest: { iid, userPermissions: { createNote },
    discussions: { nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } } } } } }
}
async function run(threads, pages) {
  const controller = new AbortController()
  const calls = []
  const query = async (...args) => {
    calls.push(args)
    const reply = pages[calls.length - 1]
    if (reply instanceof Error) throw reply
    return reply
  }
  const grants = await createThreadPermissions({ query })(ref, threads, controller.signal)
  for (const [at, document, variables, signal] of calls) {
    assert.equal(at, host)
    assert.equal(signal, controller.signal)
    assert.equal(document, calls[0][1])
    assert.match(document, /^query\s+ForgeDiscussionPermissions\(/)
    assert.doesNotMatch(document, /\b(?:body|author|mutation)\b/)
    assert.equal(variables.project, 'team/sub/service')
    assert.equal(variables.iid, '7')
  }
  return { grants, calls }
}

test('joins target MR discussion + opening note IDs and keeps reply and resolve independent', async () => {
  const wanted = [thread('partial', 12), thread('missing', 15), thread('another-note', 13), thread('resolve', 14)]
  const { grants, calls } = await run(wanted, [
    response([node('unrequested', 12), node('partial', 12, true, false), node('another-note', 333)], { cursor: 'cursor"\nA' }),
    response([node('resolve', 14, false, true)]),
  ])
  assert.deepEqual([...grants], [['partial', { reply: true, resolve: false }], ['resolve', { reply: false, resolve: true }]])
  assert.equal(calls.length, 2)
  assert.equal(calls[0][2].after, undefined)
  assert.equal(calls[1][2].after, 'cursor"\nA')
  assert.ok(!calls[1][1].includes(calls[1][2].after))
})

test('matches the GitLab DiffNote type against the exact REST opening-note ID', async () => {
  const row = node('inline', 11)
  row.notes.nodes[0].id = 'gid://gitlab/DiffNote/11'
  const { grants } = await run([thread('inline', 11)], [response([row])])
  assert.deepEqual(grants.get('inline'), { reply: true, resolve: true })
  const other = await run([thread('inline', 12)], [response([row])])
  assert.equal(other.grants.size, 0)
})

test('requires literal true for each permission and MR createNote for replies', async () => {
  const wanted = [thread('t', 12)]
  for (const [rows, mrCreate, expected] of [
    [[node('t', 12)], false, { reply: false, resolve: true }],
    [[node('t', 12, 'true', 1)], true, { reply: false, resolve: false }],
    [[node('t', 12, true, false)], true, { reply: true, resolve: false }],
  ]) {
    const { grants } = await run(wanted, [response(rows, { createNote: mrCreate })])
    assert.deepEqual(grants.get('t'), expected)
  }
})

test('rejects ambiguous or inaccessible data and ignores partial GraphQL error responses', async () => {
  const wanted = [thread('t', 12)]
  const valid = response([node('t', 12)])
  for (const value of [null, {}, { data: { project: null } }, { ...valid, errors: [{ message: 'denied' }] },
    { ...valid, errors: 'malformed' }, response([node('t', 12)], { iid: '8' }),
    response([node('t', 12)], { createNote: 1 }), new Error('transport failure'),
    response([{ id: 'gid://gitlab/Discussion/t', notes: { nodes: [{ id: 'gid://gitlab/Other/12' }] } }]),
  ]) {
    assert.equal((await run(wanted, [value])).grants.size, 0)
  }
})

test('retains previously confirmed threads when a later page fails', async () => {
  for (const last of [new Error('transport failure'), { ...response([node('later', 13)]), errors: [{ message: 'no' }] }]) {
    const { grants } = await run([thread('first', 12), thread('later', 13)], [response([node('first', 12)], { cursor: 'next' }), last])
    assert.deepEqual([...grants], [['first', { reply: true, resolve: true }]])
  }
})

test('stops on completion, an empty selection, a repeated cursor or the page budget', async () => {
  const wanted = [thread('t', 12)]
  assert.equal((await run([], [])).calls.length, 0)
  assert.equal((await run(wanted, [response([node('t', 12)], { cursor: 'irrelevant' })])).calls.length, 1)
  assert.equal((await run(wanted, [response([], { cursor: 'same' }), response([], { cursor: 'same' })])).calls.length, 2)
  assert.equal((await run(wanted, Array.from({ length: 11 }, (_, i) => response([], { cursor: String(i) })))).calls.length, 10)
})

test('propagates cancellation before reading and from a settled transport', async () => {
  for (const [preaborted, reject] of [[true, false], [false, false], [false, true]]) {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    let calls = 0
    if (preaborted) controller.abort(reason)
    const query = async () => {
      calls++
      controller.abort(reason)
      if (reject) throw new Error('transport aborted')
      return response([node('t', 12)])
    }
    await assert.rejects(createThreadPermissions({ query })(ref, [thread('t', 12)], controller.signal), e => e === reason)
    assert.equal(calls, preaborted ? 0 : 1)
  }
})
