import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { cliEnvironment, createGitLabGet, normalizeHosts } from '../glab.js'

const host = 'gitlab.example.test:8443'
const settings = { hosts: [host], glabCommand: 'glab', timeoutMs: 4000, maxOutputBytes: 8192 }
const endpoint = 'projects/team%2Fproject/merge_requests/7/discussions?per_page=100&page=1'

function withCli(code, overrides) {
  return createGitLabGet({ ...settings, ...overrides }, (name, args, options, callback) => {
    assert.equal(name, 'glab')
    assert.equal(options.shell, false)
    return execFile(process.execPath, ['-e', code, '--', ...args], options, callback)
  })
}

test('uses one literal GET for the configured hostname and preserves query parameters', async () => {
  const get = withCli('console.log(JSON.stringify(process.argv.slice(1)))')
  assert.deepEqual(await get(host, endpoint), ['api', '--hostname', host, '--method', 'GET', endpoint])
})

test('host and endpoint rejection occurs before starting the CLI', async () => {
  assert.deepEqual(normalizeHosts(['GitLab.Example.Test:8443', host]), [host])
  for (const value of ['https://gitlab.example.test', 'host:99999', '-hostname', 'host/path']) {
    assert.throws(() => normalizeHosts([value]), /hostname/)
  }
  let started = false
  const get = createGitLabGet(settings, () => { started = true })
  await assert.rejects(get('unlisted.test', 'user'), /not configured/)
  for (const invalid of ['--input', '//other.test/a', 'https://other.test', 'graphql', 'user\n']) {
    await assert.rejects(get(host, invalid), /Invalid GitLab API resource/)
  }
  assert.equal(started, false)
})

test('child receives keyring and path settings, excluding API tokens and debug options', () => {
  const parent = { Path: 'bin', HOME: 'home', GLAB_CONFIG_DIR: 'cfg', GITLAB_TOKEN: 'private', GLAB_DEBUG_HTTP: '1', NODE_OPTIONS: '--test', DSH_PROFILE: 'test' }
  assert.deepEqual(cliEnvironment(parent), { Path: 'bin', HOME: 'home', GLAB_CONFIG_DIR: 'cfg', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GLAB_PROMPT_DISABLED: '1' })
})

test('raw reads retain file whitespace, JSON reads reject unreadable payloads', async () => {
  const get = withCli("process.stdout.write('line 1\\nline 2\\n')")
  assert.equal(await get(host, endpoint, undefined, 'text'), 'line 1\nline 2\n')
  await assert.rejects(get(host, endpoint), /unreadable response/)
})

test('bounds output, redacts CLI diagnostics, and preserves aborts', async () => {
  await assert.rejects(withCli("process.stdout.write('a'.repeat(8192))", { maxOutputBytes: 256 })(host, endpoint), /output limit/)
  const bad = withCli("console.error('glab: confidential text (HTTP 404)'); process.exitCode = 1")
  await assert.rejects(bad(host, endpoint), e => e.code === 'not-found' && !e.message.includes('confidential'))
  const controller = new AbortController()
  const pending = withCli('setTimeout(() => {}, 30000)')(host, endpoint, controller.signal)
  const reason = new Error('operation cancelled')
  controller.abort(reason)
  await assert.rejects(pending, e => e === reason)
  await assert.rejects(withCli('setTimeout(() => {}, 30000)', { timeoutMs: 50 })(host, endpoint), /deadline/)
})
