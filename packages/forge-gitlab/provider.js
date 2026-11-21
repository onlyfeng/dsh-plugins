import { createHash } from 'node:crypto'
import { positive, sha, filePath, validRepo, validRef, projectPath, mrPath, mrUrl, repositoryFromRemote, changeRequestFromUrl } from './urls.js'
import { snapshotOf, patchOf, fail, requireValue } from './api.js'

const failureCodes = new Set(['not-found', 'unauthenticated', 'unavailable', 'stale', 'unsupported', 'too-large'])
function sameVersion(mr, head, base) {
  if (mr.sha !== head) fail('stale', 'The merge request head changed.')
  const refs = mr.diff_refs
  requireValue(sha(refs?.head_sha) && sha(refs.base_sha) && sha(refs.start_sha))
  if (refs.head_sha !== head || (base && refs.base_sha !== base)) fail('stale', 'The merge request diff changed.')
}

async function read(signal, operation) {
  try {
    signal?.throwIfAborted()
    const result = await operation()
    signal?.throwIfAborted()
    return result
  } catch (error) {
    signal?.throwIfAborted()
    return failureCodes.has(error?.code) ? { code: error.code, message: error.message }
      : { code: 'unavailable', message: 'GitLab returned an unreadable response.' }
  }
}

const readOnly = async () => ({ code: 'failed', message: 'This provider supports read operations only.' })
export function createGitLabProvider({ hosts, get, readReview, changeRequestKey }) {
  const allowed = new Set(hosts.map(host => host.toLowerCase()))
  const refGuard = ref => requireValue(validRef(ref, allowed))
  async function readMr(ref, signal) {
    refGuard(ref)
    const mr = await get(ref.repository.host, mrPath(ref), signal)
    requireValue(mr?.iid === ref.number && sha(mr.sha))
    return mr
  }
  return {
    forge: 'gitlab',
    repositoryFromRemote: url => repositoryFromRemote(url, allowed),
    changeRequestFromUrl: url => changeRequestFromUrl(url, allowed),
    changeRequestUrl(ref) { refGuard(ref); return mrUrl(ref) },
    async readiness(host, signal) {
      const result = await read(signal, async () => {
        requireValue(allowed.has(host))
        const user = await get(host, 'user', signal)
        requireValue(positive(user?.id))
        return { state: 'ready', message: null }
      })
      return result.state ? result : { state: result.code === 'unauthenticated' ? result.code : 'unavailable', message: result.message }
    },
    async fetch(refs, signal) {
      const results = new Map()
      for (const ref of refs) results.set(changeRequestKey(ref), await read(signal, async () => snapshotOf(ref, await readMr(ref, signal))))
      return results
    },
    async findByHead(repository, branch, signal) {
      signal?.throwIfAborted()
      requireValue(validRepo(repository, allowed) && typeof branch === 'string' && branch.length && !/[\x00-\x1f\x7f]/.test(branch))
      const path = projectPath(repository)
      const project = await get(repository.host, path, signal)
      requireValue(positive(project?.id) && typeof project.default_branch === 'string')
      if (project.default_branch === branch) return []
      const found = new Map()
      for (let page = 1; page <= 10; page++) {
        const query = new URLSearchParams({ scope: 'all', state: 'opened', source_branch: branch, per_page: '100', page: String(page) })
        const rows = await get(repository.host, `${path}/merge_requests?${query}`, signal)
        requireValue(Array.isArray(rows) && rows.length <= 100)
        for (const mr of rows) {
          if (mr?.source_branch === branch && mr.state === 'opened' && mr.source_project_id === project.id
            && mr.target_project_id === project.id && positive(mr.iid)) found.set(mr.iid, { repository, number: mr.iid })
        }
        if (rows.length < 100) return [...found.values()]
      }
      fail('too-large', 'Too many merge requests to complete discovery.')
    },
    markReady: readOnly,
    merge: readOnly,
    diff(ref, head, signal, base) {
      return read(signal, async () => {
        refGuard(ref)
        requireValue(sha(head) && (base === undefined || sha(base)))
        const mr = await readMr(ref, signal)
        sameVersion(mr, head, base)
        const path = mrPath(ref), host = ref.repository.host
        const list = await get(host, `${path}/versions?per_page=1`, signal)
        requireValue(Array.isArray(list) && positive(list[0]?.id))
        const version = await get(host, `${path}/versions/${list[0].id}`, signal)
        requireValue(version?.id === list[0].id && sha(version.head_commit_sha) && sha(version.base_commit_sha) && sha(version.start_commit_sha))
        if (version.head_commit_sha !== head || version.base_commit_sha !== mr.diff_refs.base_sha || version.start_commit_sha !== mr.diff_refs.start_sha) {
          fail('stale', 'The merge request diff changed.')
        }
        const patch = patchOf(version)
        const current = await readMr(ref, signal)
        sameVersion(current, head, version.base_commit_sha)
        if (current.diff_refs.start_sha !== version.start_commit_sha) fail('stale', 'The merge request diff changed.')
        return patch
      })
    },
    fileText(ref, commit, path, signal) {
      return read(signal, async () => {
        refGuard(ref)
        requireValue(sha(commit) && filePath(path))
        const doc = await get(ref.repository.host, `${projectPath(ref.repository)}/repository/files/${encodeURIComponent(path)}?ref=${commit}`, signal)
        requireValue(doc?.encoding === 'base64' && doc.file_path === path && doc.commit_id === commit && typeof doc.content === 'string')
        const encoded = doc.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(encoded, 'base64')
        requireValue(bytes.toString('base64') === encoded && bytes.length === doc.size && createHash('sha256').update(bytes).digest('hex') === doc.content_sha256)
        if (bytes.includes(0)) fail('unsupported', 'This file contains binary data.')
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      })
    },
    fileUrl(ref, commit, path) {
      refGuard(ref)
      requireValue(sha(commit) && filePath(path))
      const { host, owner, name } = ref.repository
      return `https://${host}/${owner}/${name}/-/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`
    },
    ...(readReview && { readReview(ref, head, signal) {
      return read(signal, () => { refGuard(ref); requireValue(sha(head)); return readReview(ref, head, signal) })
    } }),
  }
}
