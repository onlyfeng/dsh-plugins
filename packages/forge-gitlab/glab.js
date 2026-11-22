import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { DISCUSSION_PERMISSIONS_QUERY } from './permissions.js'
import { validateThreadWrite } from './thread-action.js'
import { mrPath, validRef } from './urls.js'

const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9]\d{0,4})?$/i

export function normalizeHosts(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Configure at least one GitLab hostname')
  const hosts = new Set()
  for (const entry of entries) {
    if (typeof entry !== 'string' || !hostPattern.test(entry) || Number(entry.split(':')[1]) > 65535) {
      throw new Error('GitLab hosts must be hostnames with an optional port')
    }
    hosts.add(entry.toLowerCase())
  }
  return [...hosts]
}

// Keep the CLI's own config, proxy, certificate and keyring environment. The
// provider authenticates as the local glab user. No token argument or interactive input.
const envKeys = /^(?:PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GLAB_CONFIG_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|LANG|LC_ALL)$/i
export function cliEnvironment(parent) {
  const env = Object.fromEntries(Object.entries(parent).filter(([name, value]) => envKeys.test(name) && typeof value === 'string'))
  return { ...env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GLAB_PROMPT_DISABLED: '1' }
}

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

function classify(error, stderr) {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return failure('too-large', 'GitLab CLI response exceeded the output limit')
  if (error.code === 'ENOENT') return failure('unavailable', 'GitLab CLI was not found')
  if (error.killed) return failure('unavailable', 'GitLab CLI exceeded its deadline')
  // glab writes the response body to stdout and its HTTP status to stderr.
  // Avoid propagating either stream, repository paths, command arguments or headers.
  const status = /\bHTTP\s+(401|403|404)\b/i.exec(String(stderr))?.[1]
  if (status === '404') return failure('not-found', 'GitLab resource was not found or is inaccessible')
  if (status === '401' || status === '403') return failure('unauthenticated', 'Check GitLab CLI sign-in and read permissions')
  return failure('unavailable', 'GitLab CLI could not complete the read')
}

const diffStatsQuery = `query ForgeDiffStats($project: ID!, $iid: String!) {
  project(fullPath: $project) { mergeRequest(iid: $iid) {
    diffRefs { baseSha startSha headSha }
    diffStatsSummary { additions deletions }
  } }
}`

/** REST and one fixed GraphQL query, both sent as bounded GETs through the configured CLI. */
export function createGitLabReads({ hosts, glabCommand, timeoutMs, maxOutputBytes }, run = execFile) {
  const allowed = new Set(normalizeHosts(hosts))
  async function request(host, resourceArgs, signal, format = 'json') {
    signal?.throwIfAborted()
    if (!allowed.has(host)) throw failure('unavailable', 'GitLab host is not configured')
    const args = ['api', '--hostname', host, '--method', 'GET', ...resourceArgs]
    const options = {
      cwd: tmpdir(), windowsHide: true, shell: false, env: cliEnvironment(process.env),
      signal, timeout: timeoutMs, maxBuffer: maxOutputBytes, killSignal: 'SIGKILL', encoding: 'buffer',
    }
    const bytes = await new Promise((resolve, reject) => {
      const child = run(glabCommand, args, options, (err, stdout, stderr) => {
        if (signal?.aborted) reject(signal.reason)
        else if (err) reject(classify(err, stderr))
        else resolve(stdout)
      })
      child.stdin?.end()
    })
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (format === 'text') return text
      return JSON.parse(text)
    } catch {
      throw failure('unavailable', 'GitLab returned an unreadable response')
    }
  }
  return {
    async get(host, endpoint, signal, format) {
      if (typeof endpoint !== 'string' || !/^(?:user$|version$|projects\/)/u.test(endpoint) || /[\x00-\x20\x7f\\#]/u.test(endpoint)) {
        throw failure('unavailable', 'Invalid GitLab API resource')
      }
      return request(host, [endpoint], signal, format)
    },
    async getDiffStats(ref, signal) {
      if (!validRef(ref, allowed)) throw failure('unavailable', 'Invalid GitLab merge request')
      const { host, owner, name } = ref.repository
      const variables = JSON.stringify({ project: `${owner}/${name}`, iid: String(ref.number) })
      const result = await request(host, ['graphql', '-f', `query=${diffStatsQuery}`, '-f', `variables=${variables}`], signal)
      return result?.errors?.length ? null : result?.data?.project?.mergeRequest
    },
  }
}

export const createGitLabGet = (config, run) => createGitLabReads(config, run).get

const uncertain = () => failure('unknown', 'GitLab did not confirm the discussion action. Check the discussion before trying again.')

function writeError(err, stderr) {
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(err.code) && err.syscall?.startsWith('spawn')) {
    return failure('failed', 'The GitLab CLI could not start.')
  }
  if (err.killed || err.signal || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return uncertain()
  const statuses = [...String(stderr).matchAll(/\bHTTP\s+(\d{3})\b/gi)].map(match => match[1])
  const definite = /^(?:400|401|403|404|405|409|410|413|415|422|429)$/
  return statuses.length && statuses.every(status => definite.test(status)) ? failure('failed', 'GitLab refused the discussion action.') : uncertain()
}

/** CLI transport for a permission lookup and two existing-thread endpoints. */
export function createDiscussionTransport({ hosts, glabCommand, timeoutMs, maxOutputBytes }, run = execFile) {
  const allowed = new Set(normalizeHosts(hosts))

  async function request(host, method, endpoint, payload, signal, writing) {
    if (signal?.aborted && writing) throw failure('failed', 'The discussion action was cancelled before sending.')
    signal?.throwIfAborted()
    const args = ['api', '--hostname', host, '--method', method, '--header', 'Content-Type: application/json', '--input', '-', endpoint]
    const options = { cwd: tmpdir(), windowsHide: true, shell: false, env: cliEnvironment(process.env), signal,
      timeout: timeoutMs, maxBuffer: maxOutputBytes, killSignal: 'SIGKILL', encoding: 'buffer' }
    const body = JSON.stringify(payload)
    const bytes = await new Promise((resolve, reject) => {
      let child, inputError = false
      try {
        child = run(glabCommand, args, options, (err, stdout, stderr) => {
          if (signal?.aborted) reject(writing ? uncertain() : signal.reason)
          else if (err) reject(writing ? writeError(err, stderr) : classify(err, stderr))
          else if (inputError) reject(writing ? uncertain() : failure('unavailable', 'Could not send the permission query.'))
          else resolve(stdout)
        })
      } catch {
        reject(failure(writing ? 'failed' : 'unavailable', 'The GitLab CLI could not start.'))
        return
      }
      try {
        child.stdin.once('error', () => { inputError = true })
        child.stdin.end(body, 'utf8')
      } catch {
        reject(writing ? uncertain() : failure('unavailable', 'Could not send the permission query.'))
      }
    })
    if (signal?.aborted && writing) throw uncertain()
    signal?.throwIfAborted()
    try {
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error()
      return result
    } catch {
      throw writing ? uncertain() : failure('unavailable', 'GitLab returned an unreadable permission response.')
    }
  }

  return {
    async query(host, document, variables, signal) {
      if (!allowed.has(host) || document !== DISCUSSION_PERMISSIONS_QUERY || typeof variables?.project !== 'string'
          || typeof variables.iid !== 'string' || !/^[1-9]\d*$/.test(variables.iid)
          || (variables.after !== undefined && (typeof variables.after !== 'string' || !variables.after.length || variables.after.length > 16_384))) {
        throw failure('failed', 'Invalid GitLab permission query.')
      }
      const parts = variables.project.split('/')
      const name = parts.pop()
      if (!validRef({ repository: { forge: 'gitlab', host, owner: parts.join('/'), name }, number: Number(variables.iid) }, allowed)) {
        throw failure('failed', 'Invalid GitLab permission query.')
      }
      const args = { project: variables.project, iid: variables.iid, ...(variables.after !== undefined && { after: variables.after }) }
      return request(host, 'POST', 'graphql', { query: document, variables: args }, signal, false)
    },
    async mutate(ref, write, signal) {
      if (!validRef(ref, allowed)) throw failure('failed', 'Invalid GitLab discussion target.')
      const invalid = validateThreadWrite(write)
      if (invalid) throw failure('failed', invalid.message)
      const path = `${mrPath(ref)}/discussions/${write.thread}`
      return write.kind === 'reply'
        ? request(ref.repository.host, 'POST', `${path}/notes`, { body: write.body }, signal, true)
        : request(ref.repository.host, 'PUT', path, { resolved: write.resolved }, signal, true)
    },
  }
}
