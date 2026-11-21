import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'

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

/** Execute one size- and time-limited GET against an explicitly configured host. */
export function createGitLabGet({ hosts, glabCommand, timeoutMs, maxOutputBytes }, run = execFile) {
  const allowed = new Set(normalizeHosts(hosts))
  return async (host, endpoint, signal, format = 'json') => {
    signal?.throwIfAborted()
    if (!allowed.has(host)) throw failure('unavailable', 'GitLab host is not configured')
    if (typeof endpoint !== 'string' || !/^(?:user$|version$|projects\/)/u.test(endpoint) || /[\x00-\x20\x7f\\#]/u.test(endpoint)) {
      throw failure('unavailable', 'Invalid GitLab API resource')
    }
    const args = ['api', '--hostname', host, '--method', 'GET', endpoint]
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
}
