// GitLab REST v4 discussions → Desktop Forge review data. The caller validates the ref
// and supplies a GET-only transport that bounds response bytes and handles credentials.
const PAGE_SIZE = 100
const PAGE_LIMIT = 10
const failureCodes = new Set(['not-found', 'unauthenticated', 'too-large', 'stale', 'unsupported', 'unavailable'])
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0
const positive = value => Number.isSafeInteger(value) && value > 0
const fullSha = value => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)
const stale = () => ({ code: 'stale', message: 'The merge request diff changed during the requested review.' })

function invalidResponse() {
  throw Object.assign(new Error('Invalid GitLab review response.'), { code: 'unavailable' })
}

export function checkHead(mr, headSha) {
  const values = [mr?.sha, mr?.diff_refs?.head_sha].filter(v => v != null)
  if (!values.length || !values.every(fullSha)) invalidResponse()
  return values.every(v => v.toLowerCase() === headSha)
}

function relativePath(value) {
  return text(value) && !/[\x00-\x1f\x7f\\]/.test(value) && !/^[a-z]:/i.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

// A context line can have both coordinates. Use its new-side number unless the
// range explicitly selects the old side. A line_code encodes <path SHA1>_<old>_<new>.
function endpoint(point) {
  if (!isRecord(point)) return null
  const side = point.type ?? (positive(point.new_line) ? 'new' : positive(point.old_line) ? 'old' : null)
  if (side !== 'new' && side !== 'old') return null
  let number = point[`${side}_line`]
  if (point.line_code != null) {
    const match = typeof point.line_code === 'string' && /^[a-f\d]{40}_(\d+)_(\d+)$/i.exec(point.line_code)
    if (!match) return null
    const encoded = Number(match[side === 'old' ? 1 : 2])
    if (number != null && encoded !== number) return null
    number = encoded
  }
  return positive(number) ? { side, number } : null
}

function location(position) {
  if (!isRecord(position) || !fullSha(position.head_sha)) return null
  const commit = position.head_sha.toLowerCase()
  if (position.position_type === 'file') {
    const side = position.new_path ? 'R' : 'L'
    const path = side === 'R' ? position.new_path : position.old_path
    return relativePath(path) ? { subject: 'file', side, path, commit, anchor: null } : null
  }
  if (position.position_type !== 'text') return null
  const range = position.line_range
  const start = endpoint(range == null ? position : range.start)
  const end = range == null ? start : endpoint(range.end)
  if (!start || !end || start.side !== end.side || start.number > end.number) return null
  const lastLine = position[`${end.side}_line`]
  if (lastLine != null && lastLine !== end.number) return null
  const path = position[`${end.side}_path`]
  if (!relativePath(path)) return null
  return { subject: 'line', side: end.side === 'old' ? 'L' : 'R', path, commit,
    anchor: { commit, startLine: start.number, endLine: end.number } }
}

export function sameDiff(a, b) {
  return ['base_sha', 'start_sha'].every(key => a?.[key] == null || b?.[key] == null || a[key] === b[key])
}

function avatar(value, host) {
  if (!text(value)) return null
  try {
    const url = new URL(value, `https://${host}`)
    return url.origin === `https://${host}` && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function comment(note, host, webMr) {
  if (!positive(note.id) || typeof note.body !== 'string' || !text(note.created_at)
      || !Number.isFinite(Date.parse(note.created_at))) invalidResponse()
  const author = note.author
  return { id: String(note.id), body: note.body, createdAt: note.created_at,
    author: text(author?.username) ? { login: author.username, avatarUrl: avatar(author.avatar_url, host), bot: author.bot === true } : null,
    url: `${webMr}#note_${note.id}`, pending: false, viewerCanEdit: false, viewerCanDelete: false }
}

export function isResolvableDiscussion(row) {
  return row?.resolvable === true || row?.notes?.[0]?.resolvable === true
}

export function mapReviewThread(row, headSha, refs, host, webMr) {
  if (!isRecord(row) || !Array.isArray(row.notes) || !text(row.id)) invalidResponse()
  const root = row.notes[0] // The first note starts the discussion; replies do not set its location.
  if (row.individual_note === true || !root || root.system === true) return null
  const pos = location(root.position)
  if (!pos) return null
  const currentDiff = pos.commit === headSha && sameDiff(root.position, refs)
  // Forge has no outdated marker for a file thread; displaying an outdated one
  // against a same-named file at the current head would misplace it.
  if (pos.subject === 'file' && !currentDiff) return null

  // GitLab can retrace `position` on subsequent pushes. The REST note may lack
  // both the original coordinates and the commit the comment was authored on.
  const explicit = location(root.original_position)
  let original = null
  if (explicit?.subject === 'line' && explicit.path === pos.path && explicit.side === pos.side && pos.subject === 'line') {
    original = explicit.anchor
  } else if (root.original_position == null && fullSha(root.commit_id) && root.commit_id.toLowerCase() === pos.commit) {
    original = pos.anchor
  }
  const userNotes = row.notes.filter(note => {
    if (!isRecord(note)) invalidResponse()
    return note.system !== true
  })
  const comments = userNotes.map(note => comment(note, host, webMr))
  // Older GitLab versions expose resolution only on resolvable notes.
  const resolvable = userNotes.filter(note => note.resolvable === true || typeof note.resolved === 'boolean')
  const resolved = row.resolved ?? (resolvable.length > 0 && resolvable.every(note => note.resolved === true))
  if (typeof resolved !== 'boolean') invalidResponse()
  return { id: row.id, path: pos.path, side: pos.side, subject: pos.subject,
    current: currentDiff ? pos.anchor : null, original, resolved, diffHunk: null,
    viewerCanReply: false, viewerCanResolve: false, comments }
}

export function createReadReview({ get, maxThreads = 100, permissions }) {
  if (!Number.isSafeInteger(maxThreads) || maxThreads < 0) throw new RangeError('Invalid GitLab review thread limit.')
  return async function readReview(ref, headSha, signal) {
    const { host, owner, name } = ref.repository
    const project = `${owner}/${name}`
    const mr = `projects/${encodeURIComponent(project)}/merge_requests/${ref.number}`
    const webMr = `https://${host}/${project.split('/').map(encodeURIComponent).join('/')}/-/merge_requests/${ref.number}`
    const read = async path => {
      signal.throwIfAborted()
      const json = await get(host, path, signal)
      signal.throwIfAborted()
      return json
    }
    try {
      const head = headSha.toLowerCase()
      const before = await read(mr)
      if (!checkHead(before, head)) return stale()
      const threads = []
      const seen = new Set()
      const resolvableIds = new Set()
      let truncated = false
      for (let page = 1; page <= PAGE_LIMIT; page++) {
        const rows = await read(`${mr}/discussions?per_page=${PAGE_SIZE}&page=${page}`)
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) invalidResponse()
        for (const row of rows) {
          if (seen.has(row?.id)) continue
          const item = mapReviewThread(row, head, before.diff_refs, host, webMr)
          seen.add(row.id)
          if (!item) continue
          if (threads.length === maxThreads) { truncated = true; break }
          if (isResolvableDiscussion(row)) resolvableIds.add(item.id)
          threads.push(item)
        }
        if (truncated || rows.length < PAGE_SIZE) break
        // Transport returns JSON only. With a full final page there may be more.
        if (page === PAGE_LIMIT) truncated = true
      }
      if (permissions && threads.length) {
        let grants
        try { grants = await permissions(ref, threads, signal) } catch { signal.throwIfAborted() }
        signal.throwIfAborted()
        if (grants instanceof Map) {
          for (const item of threads) {
            const grant = grants.get(item.id)
            item.viewerCanReply = grant?.reply === true
            item.viewerCanResolve = resolvableIds.has(item.id) && grant?.resolve === true
          }
        }
      }
      const after = await read(mr)
      if (!checkHead(after, head) || !sameDiff(before.diff_refs, after.diff_refs)) return stale()
      return { headSha, threads, truncated, pendingReview: null, viewer: null, viewerCanReview: false }
    } catch (error) {
      signal.throwIfAborted()
      if (failureCodes.has(error?.code)) return { code: error.code, message: error.message }
      return { code: 'unavailable', message: 'GitLab review discussions could not be read.' }
    }
  }
}
