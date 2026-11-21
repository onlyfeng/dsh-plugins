import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectCommand } from '../host.js'

const repo = { forge: 'gitlab', host: 'forge.example.test', owner: 'synthetic/group', name: 'demo' }
const prefix = 'projects/synthetic%2Fgroup%2Fdemo'
const fork = { iid: 14, title: 'From contributor checkout', state: 'opened', target_project_id: 7, source_project_id: 900, source_branch: 'contribution', target_branch: 'stable', author: { username: 'contributor' }, draft: true, updated_at: '2026-01-03T10:00:00Z', web_url: 'https://elsewhere.example.test/ignore' }
function setup() {
  const sessions = [{ id: 's1' }, { id: 's2' }], tracks = [], calls = []
  const state = { directory: '/fixtures/demo', checkout: { state: 'ready', checkout: { root: '/fixtures/demo' } }, repository: { ...repo }, changeRequests: [], worktree: { missing: null } }
  const f = { rows: [fork], detail: fork, path: 'synthetic/group/demo', registered: true, dir: state.directory, afterGet: null, state, tracks, calls }
  const ctx = { agents: { get: id => ({ session: sessions.find(s => s.id === id) }) }, workingDirectory: { get: () => f.dir },
    forgePanel: { async *follow() { yield structuredClone(state) }, async refresh() {}, async track(session, url) { tracks.push({ id: session.id, url }); state.changeRequests.push({ url }) } },
    forge: { repositoryFromRemote: () => f.registered ? { ...repo } : undefined, changeRequestFromUrl: url => ({ repository: { ...repo }, number: Number(url.split('/').at(-1)) }) } }
  const definition = createProjectCommand(ctx, host => async (h, path, signal) => {
    assert.equal(h, host); assert.equal(host, repo.host); signal.throwIfAborted(); calls.push(path)
    if (path === prefix) return { id: 7, path_with_namespace: f.path }
    if (path.startsWith(`${prefix}/merge_requests?`)) { f.afterGet?.(); return f.rows }
    assert.equal(path, `${prefix}/merge_requests/14`); f.afterGet?.(); return f.detail
  })
  f.run = (rawInput, n = 0, signal = new AbortController().signal) => definition.handler({ agent: { session: sessions[n] }, signal, rawInput })
  return f
}
async function success(promise) { const result = await promise; assert.equal(result.kind, 'success', result.text); return JSON.parse(result.text) }

test('lists open target-project MRs from any source and binds canonical URLs', async () => {
  const f = setup(); f.rows.push({ ...fork, iid: 15, state: 'closed' }, { ...fork, iid: 16, target_project_id: 100 }, fork)
  const result = await success(f.run(' list 1'))
  assert.equal(result.items.length, 1); assert.equal(result.items[0].iid, 14); assert.equal(result.items[0].tracked, false); assert.equal(result.items[0].draft, true)
  assert.equal(result.items[0].webUrl, 'https://forge.example.test/synthetic/group/demo/-/merge_requests/14')
  const params = new URLSearchParams(f.calls[1].split('?')[1]); assert.equal(params.get('state'), 'opened'); assert.equal(params.get('scope'), 'all'); assert.equal(params.get('per_page'), '25'); assert.equal(params.has('source_branch'), false)
  const action = `track ${result.scope} 14`
  assert.equal((await success(f.run(action))).alreadyBound, false); assert.equal((await success(f.run(action))).alreadyBound, true)
  assert.equal(f.tracks.length, 1); assert.equal(f.tracks[0].id, 's1')
})
test('bounds pagination, rejects invalid selectors and validates project metadata', async () => {
  const f = setup(); for (const bad of ['list 0', 'list 21', 'list 2 https://example.test', 'track 14', 'track fake 14']) assert.equal((await f.run(bad)).kind, 'error')
  assert.deepEqual(f.calls, []); f.rows = Array.from({ length: 25 }, (_, i) => ({ ...fork, iid: i + 1 })); const r = await success(f.run('list 20')); assert.equal(r.hasMore, false); assert.equal(r.truncated, true)
  f.path = 'unrelated/project'; assert.equal((await f.run('list 1')).kind, 'error')
})
test('requires a listed selection in the same session and a still-open MR', async () => {
  const f = setup(); const { scope } = await success(f.run('list')); const action = `track ${scope} 14`
  assert.equal((await f.run(action, 1)).kind, 'error'); assert.equal((await f.run(`track ${scope} 99`)).kind, 'error')
  for (const row of [{ ...fork, state: 'merged' }, { ...fork, target_project_id: 42 }, { ...fork, iid: 13 }]) { f.detail = row; assert.equal((await f.run(action)).kind, 'error') }
  assert.deepEqual(f.tracks, [])
})
test('checks provider registration and rechecks the checkout after reading', async () => {
  const f = setup(); f.registered = false; assert.equal((await f.run('list')).kind, 'error'); assert.equal(f.calls.length, 0)
  f.registered = true; const { scope } = await success(f.run('list')); f.afterGet = () => { f.dir = '/fixtures/another' }
  assert.equal((await f.run(`track ${scope} 14`)).kind, 'error'); assert.deepEqual(f.tracks, [])
  f.state.checkout = { state: 'pending' }; assert.equal((await f.run('list')).kind, 'error')
})
test('cancellation starts no GitLab read', async () => {
  const f = setup(); const reason = Error('fixture cancelled'); await assert.rejects(f.run('list', 0, AbortSignal.abort(reason)), e => e === reason); assert.deepEqual(f.calls, [])
})
