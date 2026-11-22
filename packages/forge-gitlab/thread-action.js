import { mrPath, mrUrl, positive, sha, validRef } from './urls.js'
import { checkHead, isResolvableDiscussion, mapReviewThread, sameDiff } from './reviews.js'

const refuse = (code, message) => ({ ok: false, code, message })
const stale = () => refuse('stale', 'The merge request head changed. Refresh the review before sending.')
const unknown = () => refuse('unknown', 'GitLab did not confirm the outcome. Check the discussion before sending again.')

/** Validate the parts of a panel action used to construct a mutation. */
export function validateThreadWrite(write) {
  if (!write || !['reply', 'resolve'].includes(write.kind) || (write.kind === 'reply' && write.pending === true)) {
    return refuse('unsupported', 'Choose an immediate reply or change the resolution of an existing discussion.')
  }
  if (!sha(write.headSha) || typeof write.thread !== 'string' || !/^[a-f0-9]{40}$/.test(write.thread)) {
    return refuse('failed', 'Refresh the review to select a valid head and GitLab discussion.')
  }
  if (write.kind === 'resolve') return typeof write.resolved === 'boolean' ? null : refuse('failed', 'Choose a resolution state.')
  if (write.pending !== false || typeof write.body !== 'string' || !write.body.trim() || write.body.includes('\0') || Buffer.byteLength(write.body) > 1_000_000) {
    return refuse('failed', 'An immediate reply requires nonblank text within the GitLab note size limit.')
  }
  if (/^\s*\//mu.test(write.body)) return refuse('failed', 'Remove slash-prefixed lines before sending a discussion reply.')
  return null
}

function resolutionState(row) {
  if (typeof row?.resolved === 'boolean') return row.resolved
  const notes = Array.isArray(row?.notes) ? row.notes.filter(note => note?.system !== true && note?.resolvable === true) : []
  if (notes.length && notes.every(note => typeof note.resolved === 'boolean')) return notes.every(note => note.resolved)
  return undefined
}

function confirmedReply(note, mr, write, thread) {
  return positive(note?.id) && !thread.comments.some(comment => comment.id === String(note.id)) && note.body === write.body && note.system !== true
    && (note.noteable_type == null || note.noteable_type === 'MergeRequest')
    && (note.noteable_id == null || note.noteable_id === mr.id)
    && (note.noteable_iid == null || note.noteable_iid === mr.iid)
}

/** Only opt-in providers mount this writer. The process-local lock covers overlapping button clicks. */
export function createWriteReview({ hosts, get, permissions, mutate }) {
  const allowed = new Set(hosts)
  const active = new Set()
  return async (target, action, signal) => {
    signal.throwIfAborted()
    if (!validRef(target, allowed)) return refuse('failed', 'This GitLab merge request is outside the configured hosts.')
    const invalid = validateThreadWrite(action)
    if (invalid) return invalid
    // Bind the approved target and payload before crossing the first await.
    const ref = { repository: { ...target.repository }, number: target.number }
    const write = { ...action }
    const host = ref.repository.host
    const path = mrPath(ref)
    const key = `${host}/${path}/${write.thread}`
    if (active.has(key)) return refuse('failed', 'A discussion action is already in progress. Refresh after it completes.')
    active.add(key)
    let dispatched = false
    try {
      const before = await get(host, path, signal)
      if (before?.iid !== ref.number) return refuse('failed', 'GitLab did not return the selected merge request.')
      if (!checkHead(before, write.headSha)) return stale()
      const discussion = await get(host, `${path}/discussions/${write.thread}`, signal)
      if (discussion?.id !== write.thread) return refuse('failed', 'GitLab did not return the selected discussion.')
      const thread = mapReviewThread(discussion, write.headSha, before.diff_refs, host, mrUrl(ref))
      if (!thread) return refuse('unsupported', 'Choose a file or line discussion visible in the review panel.')
      const access = (await permissions(ref, [thread], signal)).get(thread.id)
      const permitted = write.kind === 'reply' ? access?.reply : access?.resolve && isResolvableDiscussion(discussion)
      if (permitted !== true) return refuse('failed', 'GitLab did not grant this discussion action to the signed-in user.')
      // The discussion write endpoints have no expected-head parameter. Check immediately before dispatch.
      const current = await get(host, path, signal)
      if (current?.iid !== ref.number || !checkHead(current, write.headSha) || !sameDiff(before.diff_refs, current.diff_refs)) return stale()
      signal.throwIfAborted()
      if (write.kind === 'resolve' && resolutionState(discussion) === write.resolved) return { ok: true }
      dispatched = true
      const response = await mutate(ref, write, signal)
      if (write.kind === 'reply') return confirmedReply(response, current, write, thread) ? { ok: true } : unknown()
      return response?.id === thread.id && resolutionState(response) === write.resolved ? { ok: true } : unknown()
    } catch (error) {
      if (dispatched) return error?.code === 'failed' ? refuse('failed', 'GitLab refused the discussion action.') : unknown()
      signal.throwIfAborted()
      return refuse('failed', 'Could not verify the merge request, discussion and permissions before writing.')
    } finally {
      active.delete(key)
    }
  }
}
