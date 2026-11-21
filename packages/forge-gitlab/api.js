// Snapshot and patch mapping adapted from futuretea/dsh-forge-gitlab v0.1.1 (MIT).
import { filePath, mrUrl, positive, sha } from './urls.js'

export function fail(code, message) { throw Object.assign(new Error(message), { code }) }
export function requireValue(value) { if (!value) fail('unavailable', 'GitLab returned an invalid or incomplete response.') }
const nonempty = value => typeof value === 'string' && value.length > 0

function safeUrl(value, host) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.origin === `https://${host}` && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function pipelineChecks(mr, host) {
  const pipe = mr.head_pipeline
  if (!positive(pipe?.id) || pipe.sha !== mr.sha) return []
  const states = new Map([['success', 'success'], ['failed', 'failure'], ['canceled', 'cancelled'], ['skipped', 'skipped'], ['manual', 'neutral']])
  return [{ name: `pipeline #${pipe.id}`, state: states.get(pipe.status) ?? 'pending', url: safeUrl(pipe.web_url, host),
    workflow: null, startedAt: pipe.started_at ?? null, completedAt: pipe.finished_at ?? null, rerun: null }]
}

function requestedReviewers(mr, host) {
  const reviewers = [], seen = new Set([mr.author?.username])
  for (const account of mr.reviewers ?? []) {
    if (!nonempty(account?.username) || seen.has(account.username) || account.state === 'blocked') continue
    seen.add(account.username)
    reviewers.push({ kind: account.bot === true ? 'bot' : 'user', login: account.username,
      avatarUrl: safeUrl(account.avatar_url, host), requested: true, codeOwner: false, verdict: null, reviewedSha: null })
  }
  return reviewers
}

export function snapshotOf(ref, mr) {
  requireValue(nonempty(mr.title) && nonempty(mr.source_branch) && nonempty(mr.target_branch) && nonempty(mr.updated_at)
    && ['opened', 'merged', 'closed', 'locked'].includes(mr.state))
  const host = ref.repository.host
  const checks = pipelineChecks(mr, host)
  const rollupByState = { pending: 'pending', failure: 'failure', cancelled: 'failure', success: 'success', neutral: 'success', skipped: 'success' }
  const checksRollup = checks.length ? rollupByState[checks[0].state] : 'none'
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0
  const conflict = mr.has_conflicts === true || ['conflict', 'conflicts'].includes(mr.detailed_merge_status)
  return {
    ref, url: mrUrl(ref), title: mr.title, state: mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed',
    draft: mr.draft === true || mr.work_in_progress === true || /^(draft|wip)[:-]/i.test(mr.title),
    author: mr.author?.username ?? null, headBranch: mr.source_branch, headSha: mr.sha, baseBranch: mr.target_branch,
    ...(mr.diff_refs?.head_sha === mr.sha && sha(mr.diff_refs.base_sha) ? { baseSha: mr.diff_refs.base_sha } : {}),
    additions: count(mr.diff_stats_summary?.additions), deletions: count(mr.diff_stats_summary?.deletions),
    mergeability: conflict ? 'conflicting' : mr.detailed_merge_status === 'mergeable' ? 'mergeable' : 'unknown',
    mergeReady: false, mergeMethods: [], branchUpdates: [], reviewDecision: 'none',
    reviewers: requestedReviewers(mr, host), reviewersTruncated: true, canRequestReviews: false,
    checks, checksRollup,
    checksTruncated: true, canRerunChecks: false, unresolvedThreads: 0, threadsTruncated: true,
    closingIssues: [], closingIssuesTruncated: true, updatedAt: mr.updated_at, closedAt: mr.merged_at ?? mr.closed_at ?? null,
  }
}

// Reject a clipped hunk even if GitLab omitted its overflow marker.
function verifyHunks(diff) {
  requireValue(typeof diff === 'string' && diff.startsWith('@@ ') && !diff.includes('\0'))
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let oldRemaining = 0, newRemaining = 0
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line)
    if (hunk) {
      requireValue(oldRemaining === 0 && newRemaining === 0)
      oldRemaining = Number(hunk[2] ?? 1)
      newRemaining = Number(hunk[4] ?? 1)
      requireValue(Number.isSafeInteger(oldRemaining) && Number.isSafeInteger(newRemaining))
      continue
    }
    if (line === '\\ No newline at end of file') continue
    requireValue(line[0] === ' ' || line[0] === '+' || line[0] === '-')
    if (line[0] !== '+') oldRemaining--
    if (line[0] !== '-') newRemaining--
    requireValue(oldRemaining >= 0 && newRemaining >= 0)
  }
  requireValue(oldRemaining === 0 && newRemaining === 0)
}

export function patchOf(version) {
  if (version.state === 'overflow' || version.overflow === true || /\+$/.test(version.real_size)) fail('too-large', 'The GitLab diff exceeds its limit.')
  requireValue(version.state === 'collected' && /^\d+$/.test(String(version.real_size))
    && Array.isArray(version.diffs) && version.diffs.length === Number(version.real_size))
  const patches = []
  for (const entry of version.diffs) {
    if (entry?.too_large || entry?.collapsed) fail('too-large', 'GitLab omitted part of the diff.')
    requireValue(filePath(entry?.old_path) && filePath(entry.new_path) && !/["\t]/.test(entry.old_path + entry.new_path))
    if (!entry.diff) fail('unsupported', 'This diff contains binary, metadata-only or unavailable file changes.')
    verifyHunks(entry.diff)
    const old = `a/${entry.old_path}`, updated = `b/${entry.new_path}`
    const header = [`diff --git ${old} ${updated}`]
    if (entry.new_file || entry.deleted_file) {
      const mode = entry.new_file ? entry.b_mode : entry.a_mode
      requireValue(typeof mode === 'string' && /^[0-7]{6}$/.test(mode))
      header.push(entry.new_file ? `new file mode ${mode}` : `deleted file mode ${mode}`)
    } else {
      if (entry.a_mode !== entry.b_mode) {
        requireValue([entry.a_mode, entry.b_mode].every(mode => typeof mode === 'string' && /^[0-7]{6}$/.test(mode)))
        header.push(`old mode ${entry.a_mode}`, `new mode ${entry.b_mode}`)
      }
      if (entry.renamed_file) header.push(`rename from ${entry.old_path}`, `rename to ${entry.new_path}`)
    }
    header.push(`--- ${entry.new_file ? '/dev/null' : old}`, `+++ ${entry.deleted_file ? '/dev/null' : updated}`)
    patches.push(header.join('\n') + '\n' + entry.diff + (entry.diff.endsWith('\n') ? '' : '\n'))
  }
  return patches.join('')
}
