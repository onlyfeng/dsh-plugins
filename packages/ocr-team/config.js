import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u
const segment = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u
const host = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/iu
const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path

function requiredString(value, field) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`Configure a valid ${field}`)
  }
  return value
}

async function directory(value, field) {
  requiredString(value, field)
  if (!isAbsolute(value)) throw new Error(`${field} must be an absolute directory`)
  try {
    const path = await realpath(resolve(value))
    if ((await stat(path)).isDirectory()) return path
  } catch { /* Avoid exposing deployment paths in activation diagnostics. */ }
  throw new Error(`${field} must name an existing directory`)
}

async function normalizeProject(value) {
  const projectKey = requiredString(value?.projectKey, 'projectKey')
  const instanceId = requiredString(value?.instanceId, 'instanceId')
  if (!id.test(projectKey) || !id.test(instanceId)) throw new Error('Invalid projectKey or instanceId')
  const hostname = requiredString(value?.gitlab?.host, 'gitlab.host').toLowerCase()
  if (!host.test(hostname) || Number(hostname.split(':')[1]) > 65535) throw new Error('Invalid GitLab hostname or port')
  const projectId = value.gitlab.projectId
  const projectPath = requiredString(value.gitlab.projectPath, 'gitlab.projectPath')
  const parts = projectPath.split('/')
  if (!Number.isSafeInteger(projectId) || projectId < 1 || parts.length < 2 || !parts.every(part => segment.test(part))) {
    throw new Error('Configure a positive GitLab project ID and a namespace/project path')
  }
  const [checkoutRoot, reportsRoot] = await Promise.all([
    directory(value.checkoutRoot, 'checkoutRoot'), directory(value.reportsRoot, 'reportsRoot'),
  ])
  return Object.freeze({ projectKey, instanceId, checkoutRoot, reportsRoot,
    gitlab: Object.freeze({ host: new URL(`https://${hostname}`).host, projectId, projectPath }),
  })
}

/** Pin configured roots at activation. Every invocation selects the same adapter for a given root. */
export async function makeSelector(projects, getDirectory, makeRuntime) {
  if (!Array.isArray(projects)) throw new Error('projects must be a list')
  const roots = new Map(), keys = new Set()
  for (const raw of projects) {
    const project = await normalizeProject(raw)
    const root = pathKey(project.checkoutRoot)
    if (roots.has(root) || keys.has(project.projectKey)) throw new Error('Project keys and checkout roots must be unique')
    keys.add(project.projectKey)
    roots.set(root, makeRuntime(project))
  }
  return async (agent, signal) => {
    signal?.throwIfAborted()
    const cwd = getDirectory(agent)
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
    let root
    try { root = await realpath(cwd) } catch { return undefined }
    signal?.throwIfAborted()
    return roots.get(pathKey(root))
  }
}
