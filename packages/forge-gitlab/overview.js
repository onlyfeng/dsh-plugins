import { checkState, fail, mrPipeline, pipelineCheck, requireValue, rollupByState, safeUrl, snapshotOf } from './api.js'
import { positive, projectPath, sha } from './urls.js'

const validCount = n => Number.isSafeInteger(n) && n >= 0
const validStats = value => validCount(value?.additions) && validCount(value?.deletions)

/** Cache successful counts by the complete diff revision, independently of CI and title changes. */
export function createOverview(getDiffStats) {
  const cache = new Map()
  return async (ref, mr, signal) => {
    const snapshot = snapshotOf(ref, mr)
    const refs = mr.diff_refs
    if (validStats(mr.diff_stats_summary) || !getDiffStats || refs?.head_sha !== mr.sha || !sha(refs.base_sha) || !sha(refs.start_sha)) return snapshot
    const key = JSON.stringify([snapshot.url, refs.head_sha, refs.base_sha, refs.start_sha])
    let counts = cache.get(key)
    if (!counts) {
      // Some GitLab versions expose counts only in GraphQL. An optional statistics
      // read may fail on an older instance; the remaining MR status is still usable.
      let row
      try { row = await getDiffStats(ref, signal) } catch { signal?.throwIfAborted(); return snapshot }
      signal?.throwIfAborted()
      if (!validStats(row?.diffStatsSummary) || !row.diffRefs) return snapshot
      const { headSha, baseSha, startSha } = row.diffRefs
      if (headSha !== refs.head_sha || baseSha !== refs.base_sha || startSha !== refs.start_sha) {
        fail('stale', 'The merge request diff changed while reading its statistics. Refresh the review.')
      }
      const { additions, deletions } = row.diffStatsSummary
      counts = { additions, deletions }
      if (cache.size >= 128) cache.delete(cache.keys().next().value)
      cache.set(key, counts)
    }
    return { ...snapshot, ...counts }
  }
}

function pipelineProject(repo, mr, pipe) {
  // A fork MR's pipeline can belong to its source project. Never follow a job URL as an API endpoint.
  if (pipe.project_id == null) return projectPath(repo)
  requireValue(positive(pipe.project_id) && (pipe.project_id === mr.source_project_id || pipe.project_id === mr.target_project_id))
  return `projects/${pipe.project_id}`
}

async function readJobs(get, host, path, kind, pipe, signal) {
  const checks = [], seen = new Set(), pageSize = 100
  for (let page = 1; page <= 11; page++) {
    const rows = await get(host, `${path}/${kind}?per_page=${pageSize}&page=${page}`, signal)
    requireValue(Array.isArray(rows) && rows.length <= pageSize)
    if (page > 10 && rows.length) fail('too-large', 'Too many pipeline jobs to show a complete list. Open the pipeline in GitLab.')
    for (const row of rows) {
      requireValue(positive(row?.id) && typeof row.name === 'string' && row.name.length && typeof row.status === 'string' && row.status.length)
      if (seen.has(row.id) || (row.pipeline && (row.pipeline.id !== pipe.id || (row.pipeline.sha != null && row.pipeline.sha !== pipe.sha)))) {
        fail('stale', 'The pipeline changed while reading its jobs. Refresh the checks.')
      }
      seen.add(row.id)
      checks.push({ name: row.name, state: checkState(row.status), url: safeUrl(row.web_url, host),
        workflow: typeof row.stage === 'string' ? row.stage : null, startedAt: row.started_at ?? null, completedAt: row.finished_at ?? null, rerun: null })
    }
    if (rows.length < pageSize) return checks
  }
}

/** The overview polls the head pipeline only. The detail view reads jobs and trigger jobs on demand. */
export async function completeChecks(ref, signal, { get, readMr, overview }) {
  const mr = await readMr(ref, signal)
  const pipe = mrPipeline(mr)
  if (!pipe) return overview(ref, mr, signal)
  const { host } = ref.repository
  const project = pipelineProject(ref.repository, mr, pipe)
  if (pipe.sha !== mr.sha) {
    const commit = await get(host, `${project}/repository/commits/${pipe.sha}`, signal)
    requireValue(commit?.id === pipe.sha && Array.isArray(commit.parent_ids))
    if (!commit.parent_ids.includes(mr.sha)) fail('stale', 'The merged-results pipeline does not include the current source head.')
  }
  const path = `${project}/pipelines/${pipe.id}`
  const jobs = await readJobs(get, host, path, 'jobs', pipe, signal)
  const bridges = await readJobs(get, host, path, 'bridges', pipe, signal)
  const now = await readMr(ref, signal), current = mrPipeline(now)
  if (!current || now.sha !== mr.sha || current.sha !== pipe.sha || current.id !== pipe.id || current.project_id !== pipe.project_id) {
    fail('stale', 'The merge request head or pipeline changed. Refresh the checks.')
  }
  const snapshot = await overview(ref, now, signal)
  const summary = pipelineCheck(current, host)
  // A newly created or empty pipeline can report its own state before it publishes jobs.
  const checks = jobs.concat(bridges)
  return { ...snapshot, checks: checks.length ? checks : [summary], checksRollup: rollupByState[summary.state], checksTruncated: false }
}
