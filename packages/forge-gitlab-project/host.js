import { randomBytes } from 'node:crypto'

const PAGE_SIZE = 25
const PAGE_LIMIT = 20
const LEASE_MS = 600_000
const positive = n => Number.isSafeInteger(n) && n > 0
const component = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
class PickerError extends Error {}
function check(value, message) { if (!value) throw new PickerError(message) }
const reason = (key, message) => `[gitlab-project:${key}] ${message}`
const invalidProject = reason('projectUrl', 'Enter the HTTPS address of a project on a configured GitLab host.')
const responseError = 'GitLab returned an invalid project or merge request.'
const changed = reason('changed', 'The checkout or selected merge request changed. Refresh the list.')
function sameRepository(a, b) {
  return a?.forge === 'gitlab' && b?.forge === 'gitlab' && a.host === b.host && a.owner === b.owner && a.name === b.name
}
function parseInput(input) {
  const line = typeof input === 'string' ? input.trim() : ''
  let hit = /^list(?: ([1-9]\d?))?(?: project (\S{1,2048}))?$/.exec(line)
  if (hit && Number(hit[1] ?? 1) <= PAGE_LIMIT) return { kind: 'list', page: Number(hit[1] ?? 1), projectUrl: hit[2] }
  hit = /^track ([0-9a-f]{32}) ([1-9]\d{0,15})$/.exec(line)
  if (hit && positive(Number(hit[2]))) return { kind: 'track', scope: hit[1], iid: Number(hit[2]) }
  throw new PickerError('Choose a page or select a merge request from this session’s project list.')
}
function text(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '' }
function canonical(ctx, repo, iid) {
  const webUrl = `https://${repo.host}/${repo.owner}/${repo.name}/-/merge_requests/${iid}`
  const ref = ctx.forge.changeRequestFromUrl(webUrl)
  check(sameRepository(repo, ref?.repository) && ref.number === iid, changed)
  return webUrl
}
async function firstState(panel, session, signal, waitForInspection = false) {
  const wait = waitForInspection ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : signal
  let pending
  for await (const state of panel.follow(session, wait)) {
    if (!waitForInspection || state.checkout?.state !== 'pending' || state.worktree?.missing) return state
    pending = state
  }
  signal.throwIfAborted()
  if (pending) return pending
  throw new PickerError(reason('inspection', 'Git inspection is unavailable. Refresh the list.'))
}
function projectFromUrl(ctx, input) {
  // Accept a project URL, not an API endpoint. Derive the target from the registered provider.
  const match = /^https:\/\/([a-z0-9.-]+(?::[0-9]+)?)\/([^?#%\\\s]+?)\/?$/i.exec(input)
  check(match, invalidProject)
  const path = match[2].replace(/\.git$/, '')
  const parts = path.split('/')
  check(parts.length >= 2 && parts.every(part => component.test(part)), invalidProject)
  const repo = ctx.forge.repositoryFromRemote(`https://${match[1]}/${path}.git`)
  check(repo?.forge === 'gitlab' && repo.host === match[1].toLowerCase() && `${repo.owner}/${repo.name}` === path, invalidProject)
  return repo
}
function checkoutRepository(state) {
  switch (state.checkout?.state) {
    case 'ready': return state.repository
    case 'none': throw new PickerError(reason('noCheckout', 'This session directory is outside a Git checkout.'))
    case 'pending': throw new PickerError(reason('pending', 'Git inspection is in progress. Refresh after it finishes.'))
    default: {
      const limited = /sandbox|access denied|access is denied|permission|EPERM|EACCES|拒绝|权限/i.test(state.checkout?.message ?? '')
      throw new PickerError(limited
        ? reason('denied', 'The session could not read Git under its current permissions.')
        : reason('inspection', 'Git inspection failed. See the reason in Code review and changes.'))
    }
  }
}
function select(ctx, state, session, projectUrl) {
  // state.directory is the session directory (possibly a subdirectory), not the checkout root.
  check(typeof state?.directory === 'string' && state.directory === ctx.workingDirectory.get(session), reason('moved', 'The session directory changed. Refresh the list.'))
  check(!state.worktree?.missing, reason('missing', 'The session worktree is missing. Restore it or choose an existing directory.'))
  const repo = projectUrl ? projectFromUrl(ctx, projectUrl) : checkoutRepository(state)
  if (projectUrl && state.checkout?.state === 'ready' && state.repository) check(sameRepository(state.repository, repo), reason('mismatch', 'This project differs from the current checkout.'))
  check(repo?.forge === 'gitlab' && typeof repo.owner === 'string' && repo.owner.split('/').every(part => component.test(part)) && typeof repo.name === 'string' && component.test(repo.name) && typeof repo.host === 'string', reason('unknownProject', 'This checkout has no GitLab remote recognized by the provider.'))
  const projectPath = `${repo.owner}/${repo.name}`
  check(sameRepository(repo, ctx.forge.repositoryFromRemote(`https://${repo.host}/${projectPath}.git`)), invalidProject)
  const source = projectUrl ? ['project-url'] : ['checkout', state.checkout.checkout.root]
  return { repo, projectPath, key: JSON.stringify([state.directory, ...source, repo.host, projectPath]), urls: new Set(state.changeRequests.map(entry => entry.url)) }
}
function assertSession(ctx, session) {
  check(session && typeof session.id === 'string' && session.id.length && ctx.agents.get(session.id)?.session === session, 'The selected session is unavailable.')
}

export function createProjectCommand(ctx, getForHost, lifetime = new AbortController().signal) {
  const leases = new WeakMap()
  return {
    name: 'gitlab-project', description: 'List open GitLab merge requests for the current checkout or track a selected request.', recordInput: false,
    async handler({ agent, rawInput, signal: caller }) {
      const signal = AbortSignal.any([caller, lifetime, AbortSignal.timeout(90_000)])
      let follower
      try {
        const action = parseInput(rawInput)
        signal.throwIfAborted()
        const session = agent?.session
        assertSession(ctx, session)
        follower = ctx.forgePanel.follow(session, signal)[Symbol.asyncIterator]()
        const initial = await follower.next()
        check(!initial.done, 'The checkout is unavailable.')
        let lease = leases.get(session)
        const projectUrl = action.kind === 'track' ? lease?.projectUrl : action.projectUrl
        if (!projectUrl) await ctx.forgePanel.refresh(session, signal)
        signal.throwIfAborted()
        const selected = select(ctx, await firstState(ctx.forgePanel, session, signal, !projectUrl), session, projectUrl)
        const { repo, projectPath, key } = selected
        const path = `projects/${encodeURIComponent(projectPath)}`
        const get = getForHost(repo.host)
        const current = async () => {
          const fresh = select(ctx, await firstState(ctx.forgePanel, session, signal), session, projectUrl)
          signal.throwIfAborted()
          assertSession(ctx, session)
          check(fresh.key === key, changed)
          return fresh
        }
        if (action.kind === 'track') check(lease && lease.key === key && lease.scope === action.scope && lease.expires > Date.now() && lease.pages.some(ids => ids?.has(action.iid)), changed)
        const project = await get(repo.host, path, signal)
        check(positive(project?.id) && typeof project.path_with_namespace === 'string' && project.path_with_namespace.toLowerCase() === projectPath.toLowerCase(), responseError)
        if (action.kind === 'track') {
          check(lease.projectId === project.id, changed)
          const row = await get(repo.host, `${path}/merge_requests/${action.iid}`, signal)
          check(row?.state === 'opened' && row.iid === action.iid && row.target_project_id === project.id, changed)
          const fresh = await current()
          const webUrl = canonical(ctx, repo, action.iid)
          const alreadyBound = fresh.urls.has(webUrl)
          if (!alreadyBound) await ctx.forgePanel.track(session, webUrl, signal)
          return { kind: 'success', text: JSON.stringify({ bound: true, alreadyBound, webUrl }) }
        }
        const query = new URLSearchParams({ state: 'opened', scope: 'all', order_by: 'updated_at', sort: 'desc', page: String(action.page), per_page: String(PAGE_SIZE) })
        const rows = await get(repo.host, `${path}/merge_requests?${query}`, signal)
        check(Array.isArray(rows) && rows.length <= PAGE_SIZE, responseError)
        const fresh = await current(), items = [], ids = new Set()
        for (const row of rows) {
          if (row?.state !== 'opened' || row.target_project_id !== project.id) continue
          check(positive(row.iid) && typeof row.title === 'string', responseError)
          if (ids.has(row.iid)) continue
          ids.add(row.iid)
          const webUrl = canonical(ctx, repo, row.iid)
          items.push({ iid: row.iid, title: text(row.title, 255), author: text(row.author?.username, 128) || null, sourceBranch: text(row.source_branch, 255), targetBranch: text(row.target_branch, 255), updatedAt: text(row.updated_at, 48), draft: row.draft === true || row.work_in_progress === true, webUrl, tracked: fresh.urls.has(webUrl) })
        }
        lease = leases.get(session)
        if (!lease || lease.key !== key || lease.projectId !== project.id || lease.expires <= Date.now()) {
          lease = { projectUrl, scope: randomBytes(16).toString('hex'), key, projectId: project.id, pages: [] }
          leases.set(session, lease)
        }
        lease.expires = Date.now() + LEASE_MS
        lease.pages[action.page - 1] = ids
        return { kind: 'success', text: JSON.stringify({ projectPath, page: action.page, perPage: PAGE_SIZE, scope: lease.scope, items, hasMore: rows.length === PAGE_SIZE && action.page < PAGE_LIMIT, truncated: rows.length === PAGE_SIZE && action.page === PAGE_LIMIT }) }
      } catch (error) {
        if (caller.aborted) throw caller.reason
        const message = error instanceof PickerError ? error.message : error?.code === 'unauthenticated' ? reason('access', 'GitLab sign-in or project read permission is required.') : reason('read', 'Could not read this GitLab project. Check connectivity and refresh the list.')
        return { kind: 'error', text: message }
      } finally { await follower?.return?.() }
    },
  }
}
