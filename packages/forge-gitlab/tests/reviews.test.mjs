import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadReview } from '../reviews.js'

const host = 'git.example.test'
const ref = { repository: { forge: 'gitlab', host, owner: 'team/sub', name: 'service' }, number: 7 }
const mr = 'projects/team%2Fsub%2Fservice/merge_requests/7'
const page = n => `${mr}/discussions?per_page=100&page=${n}`
const web = `https://${host}/team/sub/service/-/merge_requests/7`
const head = '1'.repeat(40), base = '2'.repeat(40), old = '3'.repeat(40)
const refs = { head_sha: head, start_sha: base, base_sha: base }
const meta = { sha: head, diff_refs: refs }
const now = '2026-01-01T00:00:00Z'
const pos = (fields = {}) => ({ ...refs, position_type: 'text', old_path: 'a.js', new_path: 'b.js', new_line: 9, ...fields })
const note = (fields = {}) => ({ id: 11, system: false, body: 'Markdown & <b>raw</b>', created_at: now, ...fields })
const discussion = (id, position = pos(), fields = {}) => ({ id, individual_note: false, notes: [note({ position })], ...fields })
const anchor = (commit, startLine, endLine = startLine) => ({ commit, startLine, endLine })
const empty = { headSha: head, threads: [], truncated: false, pendingReview: null, viewer: null, viewerCanReview: false }

// Strict scripted GETs assert host, encoded path, page order, format and signal identity.
async function script(steps, options = {}) {
  const signal = new AbortController().signal
  const calls = []
  const get = async (target, path, actualSignal, format = 'json') => {
    calls.push([target, path, actualSignal, format])
    const value = steps[calls.length - 1]?.[1]
    if (value instanceof Error) throw value
    return value
  }
  const result = await createReadReview({ get, ...options })(ref, head, signal)
  assert.deepEqual(calls, steps.map(([path]) => [host, path, signal, 'json']))
  return result
}
const review = (rows, options) => script([[mr, meta], [page(1), rows], [mr, meta]], options)

test('empty and nonrepresentable discussions give an empty read-only review', async () => {
  assert.deepEqual(await review([]), empty)
  assert.deepEqual(await review([
    discussion('single', pos(), { individual_note: true }),
    discussion('general', null),
    discussion('general-with-reply', null, { notes: [note(), note({ id: 12, position: pos() })] }),
    discussion('system', pos(), { notes: [note({ system: true, position: pos() })] }),
    discussion('empty', null, { notes: [] }),
    discussion('image', pos({ position_type: 'image', x: 1, y: 3 })),
    discussion('unknown', pos({ position_type: 'unrecognized' })),
  ]), empty)
})

test('maps the complete rc.3 shape, discussion resolution, reply bodies and author data', async () => {
  const author = { username: 'builder', avatar_url: `https://${host}/avatar.png`, bot: true }
  const root = note({ author, position: pos({ old_line: 4 }), commit_id: head, resolved: false })
  const result = await review([discussion('thread', null, { resolved: true, notes: [
    root, note({ id: 12, system: true }), note({ id: 13, body: 'reply', created_at: '2026-02-01T00:00:00Z' }),
  ] })])
  const common = { pending: false, viewerCanEdit: false, viewerCanDelete: false }
  assert.deepEqual(result, { ...empty, threads: [{
    id: 'thread', path: 'b.js', side: 'R', subject: 'line', current: anchor(head, 9), original: anchor(head, 9),
    diffHunk: null, resolved: true, viewerCanReply: false, viewerCanResolve: false, comments: [
      { ...common, id: '11', author: { login: 'builder', avatarUrl: author.avatar_url, bot: true }, body: root.body, createdAt: now, url: `${web}#note_11` },
      { ...common, id: '13', author: null, body: 'reply', createdAt: '2026-02-01T00:00:00Z', url: `${web}#note_13` },
    ],
  }] })
})

test('older payloads resolve a thread only when every resolvable user note is resolved', async () => {
  const result = await review([discussion('partial', null, { notes: [
    note({ position: pos(), resolved: true }), note({ id: 12, resolved: false,
      author: { username: 'member', avatar_url: 'https://outside.example.test/tracker' } }),
  ] })])
  assert.equal(result.threads[0].resolved, false)
  assert.deepEqual(result.threads[0].comments[1].author, { login: 'member', avatarUrl: null, bot: false })
})

test('uses range side and actual coordinates including GitLab line_codes', async () => {
  const result = await review([
    discussion('deleted', pos({ new_line: null, old_line: 21 })),
    discussion('old-range', pos({ new_line: 9, old_line: 12, line_range: {
      start: { type: 'old', old_line: 10, new_line: 7 }, end: { type: 'old', old_line: 12, new_line: 9 },
    } })),
    discussion('new-range', pos({ line_range: {
      start: { type: 'new', line_code: `${'a'.repeat(40)}_0_6` }, end: { type: 'new', line_code: `${'a'.repeat(40)}_0_9` },
    } })),
    discussion('whole-file', pos({ position_type: 'file', new_line: undefined })),
    discussion('old-file', pos({ position_type: 'file', new_path: null, new_line: undefined })),
  ])
  assert.deepEqual(result.threads.map(({ id, side, path, current, subject }) => [id, side, path, current, subject]), [
    ['deleted', 'L', 'a.js', anchor(head, 21), 'line'], ['old-range', 'L', 'a.js', anchor(head, 10, 12), 'line'],
    ['new-range', 'R', 'b.js', anchor(head, 6, 9), 'line'], ['whole-file', 'R', 'b.js', null, 'file'],
    ['old-file', 'L', 'a.js', null, 'file'],
  ])
})

test('unusable positions are never turned into a line, file, or a shortened range', async () => {
  const positions = [
    { new_line: 0 }, { new_line: -1 }, { new_line: 1.5 }, { new_line: '12' }, { new_line: null },
    { head_sha: null }, { head_sha: 'deadbeef' }, { new_path: null }, { new_path: '../escape' },
    { line_range: { start: { type: 'old', old_line: 4 }, end: { type: 'new', new_line: 9 } } },
    { line_range: { start: { type: 'new', new_line: 12 }, end: { type: 'new', new_line: 9 } } },
    { line_range: { start: { type: 'new', new_line: 8 } } },
    { line_range: { start: { type: 'new', line_code: `${'a'.repeat(40)}_0_4`, new_line: 5 }, end: { new_line: 9 } } },
    { line_range: { start: { new_line: 2 }, end: { new_line: 8 } } },
  ]
  assert.deepEqual(await review(positions.map((p, i) => discussion(String(i), pos(p)))), empty)
})

test('distinguishes current, original and historical positions; never pins historical files to the current head', async () => {
  const withNote = (id, data) => discussion(id, null, { notes: [note(data)] })
  const result = await review([
    withNote('moved', { position: pos(), commit_id: old, original_position: pos({ head_sha: old, new_line: 15 }) }),
    withNote('moved-unknown-original', { position: pos(), commit_id: old }),
    withNote('historical', { position: pos({ head_sha: old }), commit_id: old, resolved: true }),
    withNote('historical-unknown-original', { position: pos({ head_sha: old }) }),
    withNote('changed-base', { position: pos({ base_sha: old, new_line: null, old_line: 4 }) }),
    withNote('old-file', { position: pos({ head_sha: old, position_type: 'file' }) }),
  ])
  assert.deepEqual(result.threads.map(t => [t.id, t.current, t.original, t.resolved]), [
    ['moved', anchor(head, 9), anchor(old, 15), false], ['moved-unknown-original', anchor(head, 9), null, false],
    ['historical', null, anchor(old, 9), true], ['historical-unknown-original', null, null, false],
    ['changed-base', null, null, false],
  ])
})

test('checks the MR before fetching discussions and verifies it again before returning', async () => {
  const moved = { sha: old, diff_refs: { head_sha: old } }
  assert.equal((await script([[mr, moved]])).code, 'stale')
  assert.equal((await script([[mr, { ...meta, sha: old }]])).code, 'stale')
  assert.equal((await script([[mr, meta], [page(1), [discussion('complete')]], [mr, moved]])).code, 'stale')
  assert.equal((await script([[mr, meta], [page(1), []], [mr, { ...meta, diff_refs: { ...refs, base_sha: old } }]])).code, 'stale')
})

test('thread limit counts unique mapped threads and distinguishes exact fits from overflow', async () => {
  const full = Array.from({ length: 100 }, (_, i) => discussion(`general-${i}`, null))
  full[99] = discussion('t1')
  const pages = [[mr, meta], [page(1), full], [page(2), [full[99], discussion('t2')]], [mr, meta]]
  const exact = await script(pages, { maxThreads: 2 })
  assert.deepEqual(exact.threads.map(t => t.id), ['t1', 't2'])
  assert.equal(exact.truncated, false)
  const capped = await script(pages, { maxThreads: 1 })
  assert.deepEqual(capped.threads.map(t => t.id), ['t1'])
  assert.equal(capped.truncated, true)
})

test('bounds even an endless sequence of full, unanchored discussion pages', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => [page(i + 1),
    Array.from({ length: 100 }, (_, j) => discussion(`general-${i}-${j}`, null))])
  assert.deepEqual(await script([[mr, meta], ...pages, [mr, meta]]), { ...empty, truncated: true })
})

test('maps transport and malformed response failures without publishing partial results', async () => {
  for (const code of ['not-found', 'unauthenticated', 'too-large', 'unavailable']) {
    const failure = Object.assign(new Error('Sanitized transport failure.'), { code })
    assert.deepEqual(await script([[mr, meta], [page(1), failure]]), { code, message: failure.message })
  }
  const malformed = [[[mr, null]], [[mr, {}]], [[mr, { sha: 'not-a-sha' }]], [[mr, meta], [page(1), null]],
    [[mr, meta], [page(1), [null]]], [[mr, meta], [page(1), [discussion('bad', null, { notes: {} })]]],
    [[mr, meta], [page(1), [discussion('bad-note', null, { notes: [note({ id: null, position: pos() })] })]]],
    [[mr, meta], [page(1), []], [mr, new Error('raw details')]]]
  for (const steps of malformed) {
    const result = await script(steps)
    assert.equal(result.code, 'unavailable')
    assert.doesNotMatch(result.message, /raw details/)
  }
})

test('preserves caller cancellation before I/O and at each await, even when transport swallows it', async () => {
  for (const abortAt of [0, 1, 2, 3]) {
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    let calls = 0
    if (abortAt === 0) controller.abort(reason)
    const get = async (_host, path, signal) => {
      assert.equal(signal, controller.signal)
      if (++calls === abortAt) controller.abort(reason)
      return path === mr ? meta : []
    }
    await assert.rejects(createReadReview({ get })(ref, head, controller.signal), e => e === reason)
    assert.equal(calls, abortAt)
  }
})
