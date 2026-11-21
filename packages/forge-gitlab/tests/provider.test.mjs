import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createGitLabProvider } from '../provider.js'
const host = 'forge.example.test'
const repository = { forge: 'gitlab', host, owner: 'lab/sub', name: 'sample' }
const ref = { repository, number: 8 }
const signal = new AbortController().signal
const head = '1'.repeat(40), base = '2'.repeat(40), start = '3'.repeat(40)
const projectPath = 'projects/lab%2Fsub%2Fsample'
const mrPath = `${projectPath}/merge_requests/8`
const current = {
  id: 83, iid: 8, state: 'opened', title: 'Draft: synthetic change', draft: true,
  sha: head, source_branch: 'topic/a', target_branch: 'main', source_project_id: 7, target_project_id: 7,
  updated_at: '2026-01-01T00:00:00Z', author: { username: 'author' }, reviewers: [{ username: 'reader' }],
  diff_refs: { head_sha: head, base_sha: base, start_sha: start }, changes_count: '1',
  detailed_merge_status: 'mergeable', head_pipeline: null,
}
const entry = { old_path: 'src/a.js', new_path: 'src/a.js', a_mode: '100644', b_mode: '100644', diff: '@@ -1 +1 @@\n-old\n+new\n' }
const version = { id: 4, head_commit_sha: head, base_commit_sha: base, start_commit_sha: start, merge_request_id: 83, state: 'collected', real_size: '1', diffs: [entry] }
const url = `https://${host}/lab/sub/sample/-/merge_requests/8`
function adapter(get, rest = {}) { return createGitLabProvider({ hosts: [host], get, changeRequestKey: () => 'synthetic-key', ...rest }) }
function exampleDiff({ mr = current, detail = version, after = mr } = {}) {
  let count = 0
  return adapter(async (h, path, s) => {
    assert.equal(h, host); assert.equal(s, signal)
    if (path === mrPath) return count++ ? after : mr
    if (path.startsWith(`${mrPath}/versions?`)) return [detail]
    if (path === `${mrPath}/versions/4`) return detail
    throw Error('unexpected synthetic endpoint')
  })
}

test('maps nested project remotes and MR links to the same canonical ref', () => {
  const p = adapter(assert.fail)
  for (const remote of [`https://${host}/lab/sub/sample.git`, `git@${host}:lab/sub/sample.git`, `ssh://git@${host}:2222/lab/sub/sample.git`]) assert.deepEqual(p.repositoryFromRemote(remote), repository)
  assert.deepEqual(p.changeRequestFromUrl(`${url}/diffs#note_1`), ref)
  assert.equal(p.changeRequestUrl(ref), url)
  for (const input of [url.replace(host, 'other.example.test'), url.replace('sample', '..'), url.replace('8', '0'), url.replace(host, `user@${host}`)]) assert.equal(p.changeRequestFromUrl(input), undefined)
})
test('polling provides a keyed read-only snapshot', async () => {
  const p = adapter(async (_h, path) => { assert.equal(path, mrPath); return current })
  const result = (await p.fetch([ref], signal)).get('synthetic-key')
  assert.equal(result.headSha, head); assert.equal(result.state, 'open'); assert.equal(result.draft, true)
  assert.deepEqual(result.ref, ref); assert.equal(result.url, url); assert.equal(result.baseBranch, 'main')
  assert.equal(result.mergeReady, false); assert.deepEqual(result.mergeMethods, []); assert.deepEqual(result.branchUpdates, [])
  assert.equal(result.canRerunChecks, false); assert.equal(result.canRequestReviews, false)
  for (const k of ['reviewersTruncated', 'closingIssuesTruncated', 'checksTruncated', 'threadsTruncated']) assert.equal(typeof result[k], 'boolean')
})
test('pipeline summaries treat a canceled head check as unsuccessful', async () => {
  for (const [status, state, rollup] of [
    ['canceled', 'cancelled', 'failure'], ['failed', 'failure', 'failure'],
    ['running', 'pending', 'pending'], ['success', 'success', 'success'],
  ]) {
    const provider = adapter(async () => ({ ...current, head_pipeline: { id: 11, sha: head, status } }))
    const snapshot = (await provider.fetch([ref], signal)).get('synthetic-key')
    assert.equal(snapshot.checks[0].state, state)
    assert.equal(snapshot.checksRollup, rollup)
  }
})
test('discovery filters forks, closed requests and the default branch', async () => {
  const p = adapter(async (h, path) => {
    assert.equal(h, host)
    if (path === projectPath) return { id: 7, default_branch: 'main' }
    const [resource, search] = path.split('?'); assert.equal(resource, `${projectPath}/merge_requests`)
    const params = new URLSearchParams(search); assert.equal(params.get('source_branch'), 'topic/a'); assert.equal(params.get('state'), 'opened')
    return [current, { ...current, iid: 9, source_project_id: 4 }, { ...current, iid: 10, state: 'closed' }, { ...current, iid: 11, source_branch: 'other' }]
  })
  assert.deepEqual(await p.findByHead(repository, 'main', signal), [])
  assert.deepEqual(await p.findByHead(repository, 'topic/a', signal), [ref])
})
test('diff returns the complete named version with patch headers', async () => {
  const patch = await exampleDiff().diff(ref, head, signal, base)
  assert.equal(typeof patch, 'string'); assert.match(patch, /--- a\/src\/a\.js\n\+\+\+ b\/src\/a\.js\n@@/)
  assert.ok(patch.includes('-old\n+new'))
})
test('text patches preserve permission changes, including on renamed files', async () => {
  for (const renamed of [false, true]) {
    const file = { ...entry, a_mode: '100644', b_mode: '100755', renamed_file: renamed, new_path: renamed ? 'src/b.js' : entry.new_path }
    const patch = await exampleDiff({ detail: { ...version, diffs: [file] } }).diff(ref, head, signal)
    assert.match(patch, /\nold mode 100644\nnew mode 100755\n/)
    if (renamed) assert.match(patch, /\nrename from src\/a\.js\nrename to src\/b\.js\n/)
    assert.ok(patch.includes('-old\n+new'))
  }
  const malformed = { ...entry, b_mode: 'invalid' }
  const result = await exampleDiff({ detail: { ...version, diffs: [malformed] } }).diff(ref, head, signal)
  assert.equal(result.code, 'unavailable')
})
test('diff detects a moved head before, during or after reading the version', async () => {
  for (const changes of [{ mr: { ...current, sha: base } }, { detail: { ...version, head_commit_sha: base } }, { after: { ...current, sha: base } }]) assert.equal((await exampleDiff(changes).diff(ref, head, signal)).code, 'stale')
})
test('clipped files, missing changes and incomplete hunks return failures', async () => {
  for (const detail of [{ ...version, state: 'overflow' }, { ...version, real_size: '2' }, { ...version, diffs: [{ ...entry, collapsed: true }] }, { ...version, diffs: [{ ...entry, too_large: true }] }, { ...version, diffs: [{ ...entry, diff: '' }] }, { ...version, diffs: [{ ...entry, diff: '@@ -2,3 +2,3 @@\n-a\n+b\n' }] }]) {
    const result = await exampleDiff({ detail }).diff(ref, head, signal)
    assert.ok(['unavailable', 'too-large', 'unsupported'].includes(result.code))
  }
})
test('fileText verifies bytes and escapes paths in requests and web links', async () => {
  const path = 'src/file #1.js', bytes = Buffer.from('const π = 1\n')
  const row = { encoding: 'base64', size: bytes.length, content: bytes.toString('base64'), content_sha256: createHash('sha256').update(bytes).digest('hex'), file_path: path, commit_id: head }
  let doc = row
  const p = adapter(async (h, endpoint) => { assert.equal(h, host); assert.equal(endpoint, `${projectPath}/repository/files/${encodeURIComponent(path)}?ref=${head}`); return doc })
  assert.equal(await p.fileText(ref, head, path, signal), bytes.toString())
  assert.equal(p.fileUrl(ref, head, path), `https://${host}/lab/sub/sample/-/blob/${head}/src/file%20%231.js`)
  for (doc of [{ ...row, content: '?' }, { ...row, size: row.size + 1 }, { ...row, commit_id: base }]) assert.ok((await p.fileText(ref, head, path, signal)).code)
})
test('readiness categorizes authentication and transport failures', async () => {
  const p = adapter(async (h, path) => { assert.equal(h, host); assert.equal(path, 'user'); return { id: 7, username: 'reader' } })
  assert.deepEqual(await p.readiness(host, signal), { state: 'ready', message: null })
  for (const code of ['unauthenticated', 'unavailable', 'not-found']) {
    const other = adapter(async () => { throw Object.assign(Error('Synthetic transport error.'), { code }) })
    assert.equal((await other.readiness(host, signal)).state, code === 'unauthenticated' ? code : 'unavailable')
  }
})
test('out-of-scope reads and write actions issue zero transport calls', async () => {
  let calls = 0
  const p = adapter(async () => { calls++; return {} }, { readReview: async () => { calls++; return { headSha: head } } })
  for (const r of [{ ...ref, repository: { ...repository, host: 'other.example.test' } }, { ...ref, repository: { ...repository, owner: '../x' } }, { ...ref, number: 0 }]) {
    assert.ok((await p.readReview(r, head, signal)).code); assert.ok((await p.diff(r, head, signal)).code)
    assert.ok((await p.fileText(r, head, 'a', signal)).code)
  }
  assert.equal((await p.merge(ref, { method: 'merge', headSha: head }, signal)).code, 'failed')
  assert.equal((await p.markReady(ref, signal)).code, 'failed'); assert.equal(calls, 0)
  for (const key of ['submitReview', 'writeReview', 'setViewed', 'updateBranch', 'requestReviews', 'rerunChecks']) assert.equal(p[key], undefined)
})
test('pre-aborted reads propagate the original reason', async () => {
  const reason = Error('synthetic cancellation'), aborted = AbortSignal.abort(reason)
  const p = adapter(assert.fail)
  await assert.rejects(p.diff(ref, head, aborted), e => e === reason)
  await assert.rejects(p.fetch([ref], aborted), e => e === reason)
})
