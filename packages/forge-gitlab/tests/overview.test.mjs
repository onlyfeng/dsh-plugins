import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitLabProvider } from '../provider.js'
import { createGitLabReads } from '../glab.js'

const host = 'gitlab.example.test'
const ref = { repository: { forge: 'gitlab', host, owner: 'examples/sub', name: 'demo' }, number: 7 }
const mrPath = 'projects/examples%2Fsub%2Fdemo/merge_requests/7'
const head = 'a'.repeat(40), base = 'b'.repeat(40), start = 'c'.repeat(40)
const mr = { iid: 7, sha: head, state: 'opened', title: 'Example change', source_branch: 'topic', target_branch: 'main', updated_at: '2026-01-01T00:00:00Z',
  diff_refs: { head_sha: head, base_sha: base, start_sha: start }, source_project_id: 8, target_project_id: 7, head_pipeline: null }
const stats = { diffRefs: { headSha: head, baseSha: base, startSha: start }, diffStatsSummary: { additions: 17, deletions: 2 } }
const pipe = { id: 31, project_id: 8, sha: head, status: 'success', web_url: `https://${host}/examples/fork/-/pipelines/31` }
const withPipe = { ...mr, head_pipeline: pipe }
const job = id => ({ id, name: `job-${id}`, stage: 'test', status: 'success', pipeline: { id: 31, sha: head } })
const signal = new AbortController().signal
const provider = (get, getDiffStats) => createGitLabProvider({ hosts: [host], get, getDiffStats, changeRequestKey: () => 'ref' })
const snap = async p => (await p.fetch([ref], signal)).get('ref')

test('missing REST counts use the exact diff revision, cache true zeroes, and refresh after a base change', async () => {
  let current = mr, row = stats, calls = 0
  const p = provider(async () => current, async (r, s) => { assert.deepEqual(r, ref); assert.equal(s, signal); calls++; return row })
  assert.equal((await snap(p)).additions, 17)
  assert.equal((await snap(p)).deletions, 2)
  assert.equal(calls, 1)
  current = { ...mr, diff_refs: { ...mr.diff_refs, base_sha: start } }
  assert.equal((await snap(p)).code, 'stale')
  row = { diffRefs: { ...stats.diffRefs, baseSha: start }, diffStatsSummary: { additions: 0, deletions: 0 } }
  assert.equal((await snap(p)).additions, 0)
  assert.equal((await snap(p)).deletions, 0)
  assert.equal(calls, 3)
  current = { ...mr, diff_stats_summary: { additions: 4, deletions: 0 } }
  assert.equal((await snap(p)).additions, 4)
  assert.equal(calls, 3)
})

test('statistics are a fixed GraphQL GET with validated ref and separately encoded variables', async () => {
  let calls = 0
  const read = createGitLabReads({ hosts: [host], glabCommand: 'glab', timeoutMs: 2000, maxOutputBytes: 1024 }, (_cli, args, opts, cb) => {
    calls++; assert.deepEqual(args.slice(0, 6), ['api', '--hostname', host, '--method', 'GET', 'graphql'])
    assert.equal(args[6], '-f'); assert.match(args[7], /^query=query ForgeDiffStats\(/)
    assert.deepEqual(JSON.parse(args[9].slice('variables='.length)), { project: 'examples/sub/demo', iid: '7' })
    assert.equal(opts.shell, false); cb(null, Buffer.from(JSON.stringify({ data: { project: { mergeRequest: stats } } }))); return {}
  })
  assert.deepEqual(await read.getDiffStats(ref, signal), stats)
  await assert.rejects(read.getDiffStats({ ...ref, number: 0 }, signal))
  assert.equal(calls, 1)
})

test('no head pipeline produces a complete empty snapshot in polling and the detail view', async () => {
  const onlyMR = async (_host, path) => { assert.equal(path, mrPath); return mr }
  const p = provider(onlyMR)
  for (const result of [await snap(p), await p.fetchChecks(ref, signal)]) {
    assert.deepEqual(result.checks, []); assert.equal(result.checksTruncated, false); assert.equal(result.checksRollup, 'none'); assert.equal(result.headSha, head)
  }
})

test('polling stays cheap; detail paginates fork pipeline jobs and trigger jobs, preserving the pipeline rollup', async () => {
  const paths = [], endpoint = 'projects/8/pipelines/31'
  const p = provider(async (h, path, s) => {
    assert.equal(h, host); assert.equal(s, signal); paths.push(path)
    if (path === mrPath) return withPipe
    if (path === `${endpoint}/jobs?per_page=100&page=1`) return Array.from({ length: 100 }, (_, i) => job(151 - i))
    if (path === `${endpoint}/jobs?per_page=100&page=2`) return [{ ...job(3), status: 'failed', allow_failure: true, web_url: 'https://elsewhere.example.test/job/3' }]
    if (path === `${endpoint}/bridges?per_page=100&page=1`) return [{ ...job(1), status: 'manual' }]
    throw new Error('Unexpected request')
  })
  assert.equal((await snap(p)).checksTruncated, true); assert.deepEqual(paths, [mrPath])
  const result = await p.fetchChecks(ref, signal)
  assert.equal(result.checksTruncated, false); assert.equal(result.checksRollup, 'success'); assert.equal(result.checks.length, 102)
  assert.equal(result.checks[100].state, 'failure'); assert.equal(result.checks[100].url, null); assert.equal(result.checks[100].rerun, null)
  assert.equal(result.checks[101].state, 'neutral'); assert.equal(result.canRerunChecks, false); assert.equal(paths.at(-1), mrPath)
})

test('head or pipeline replacement, denied jobs and malformed pages never become a complete successful list', async () => {
  for (const mode of ['head', 'pipeline', 'denied', 'malformed', 'repeated']) {
    let mrReads = 0
    const p = provider(async (_host, path) => {
      if (path === mrPath) {
        if (++mrReads === 1) return withPipe
        return mode === 'head' ? { ...withPipe, sha: base } : { ...withPipe, head_pipeline: { ...pipe, id: 32 } }
      }
      if (mode === 'denied') throw Object.assign(Error('Read permission required'), { code: 'unauthenticated' })
      if (mode === 'malformed') return { message: 'unreadable' }
      if (mode === 'repeated') return [job(1), job(1)]
      return []
    })
    assert.equal((await p.fetchChecks(ref, signal)).code, mode === 'denied' ? 'unauthenticated' : mode === 'malformed' ? 'unavailable' : 'stale')
  }
})

test('merged-results details require the current source head in the pipeline commit', async () => {
  const virtual = { ...pipe, sha: base, ref: 'refs/merge-requests/7/merge' }
  for (const parents of [[start, head], [start]]) {
    let enumerated = false
    const p = provider(async (_host, path) => {
      if (path === mrPath) return { ...mr, head_pipeline: virtual }
      if (path === `projects/8/repository/commits/${base}`) return { id: base, parent_ids: parents }
      enumerated = true
      return []
    })
    assert.equal((await snap(p)).checksTruncated, true)
    const report = await p.fetchChecks(ref, signal)
    assert.equal(enumerated, parents.includes(head))
    if (enumerated) { assert.equal(report.checksRollup, 'success'); assert.equal(report.checksTruncated, false) }
    else assert.equal(report.code, 'stale')
  }
})

test('a pipeline from an unrelated project is refused before any job lookup', async () => {
  let requests = 0
  const p = provider(async () => { requests++; return { ...mr, head_pipeline: { ...pipe, project_id: 999 } } })
  assert.equal((await p.fetchChecks(ref, signal)).code, 'unavailable'); assert.equal(requests, 1)
  const reason = Error('cancelled')
  await assert.rejects(p.fetchChecks(ref, AbortSignal.abort(reason)), error => error === reason)
})
