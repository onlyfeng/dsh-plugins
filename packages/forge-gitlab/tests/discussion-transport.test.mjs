import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { createDiscussionTransport } from '../glab.js'
import { DISCUSSION_PERMISSIONS_QUERY } from '../permissions.js'

const host = 'forge.example.test'
const settings = { hosts: [host], glabCommand: 'glab', timeoutMs: 4000, maxOutputBytes: 8192 }
const id = 'a'.repeat(40)
const ref = { repository: { forge: 'gitlab', host, owner: 'group/sub', name: 'project' }, number: 7 }
const path = `projects/group%2Fsub%2Fproject/merge_requests/7/discussions/${id}`
const reply = { kind: 'reply', thread: id, headSha: 'b'.repeat(40), pending: false, body: 'Synthetic Markdown\nwith "quotes", 中文 and shell characters ` $() &' }
const resolve = { kind: 'resolve', thread: id, headSha: reply.headSha, resolved: true }
const variables = { project: 'group/sub/project', iid: '7', after: 'synthetic-cursor' }
const echo = `let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c=>data+=c); process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),payload:JSON.parse(data)})))`
function cli(script, config = {}) {
  let attempts = 0
  const transport = createDiscussionTransport({ ...settings, ...config }, (command, args, options, callback) => {
    assert.equal(command, 'glab'); assert.equal(options.shell, false); attempts++
    return execFile(process.execPath, ['-e', script, '--', ...args], options, callback)
  })
  return { transport, attempts: () => attempts }
}

test('discussion transport sends fixed routes with JSON on stdin', async () => {
  const { transport, attempts } = cli(echo)
  for (const [action, method, endpoint, payload] of [[reply, 'POST', `${path}/notes`, { body: reply.body }], [resolve, 'PUT', path, { resolved: true }], [{ ...resolve, resolved: false }, 'PUT', path, { resolved: false }]]) {
    const result = await transport.mutate(ref, action)
    assert.deepEqual(result.payload, payload)
    assert.deepEqual(result.args, ['api', '--hostname', host, '--method', method, '--header', 'Content-Type: application/json', '--input', '-', endpoint])
  }
  const result = await transport.query(host, DISCUSSION_PERMISSIONS_QUERY, variables)
  assert.deepEqual(result.payload, { query: DISCUSSION_PERMISSIONS_QUERY, variables })
  assert.equal(result.args.at(-1), 'graphql'); assert.ok(!result.args.includes(DISCUSSION_PERMISSIONS_QUERY)); assert.equal(attempts(), 4)
})

test('discussion transport refuses invalid arguments before starting a process', async () => {
  let attempts = 0
  const t = createDiscussionTransport(settings, () => { attempts++; throw Error('unexpected dispatch') })
  const failed = error => error.code === 'failed'
  for (const action of [{ ...reply, kind: 'edit-comment' }, { ...reply, pending: true }, { ...reply, thread: '../notes' }, { ...reply, headSha: 'x' }, { ...resolve, resolved: 1 }, { ...reply, body: 'text\r\t /close' }]) await assert.rejects(t.mutate(ref, action), failed)
  for (const repository of [{ ...ref.repository, host: 'other.example.test' }, { ...ref.repository, owner: '../group' }]) await assert.rejects(t.mutate({ ...ref, repository }, reply), failed)
  await assert.rejects(t.mutate(ref, reply, AbortSignal.abort()), failed)
  for (const doc of ['mutation { unsafe }', DISCUSSION_PERMISSIONS_QUERY + '\nmutation Other { unsafe }', 'query Other { currentUser { id } }']) await assert.rejects(t.query(host, doc, variables), failed)
  for (const args of [{ ...variables, iid: 'invalid' }, { ...variables, project: '../sample' }, { ...variables, after: 123 }]) await assert.rejects(t.query(host, DISCUSSION_PERMISSIONS_QUERY, args), failed)
  assert.equal(attempts, 0)
})

test('write failures distinguish explicit refusals and uncertain outcomes and redact diagnostics', async () => {
  const secret = 'private-fixture-diagnostic'
  const byStatus = n => `process.stderr.write('glab: ${secret} (HTTP ${n})'); process.exitCode=1`
  for (const [script, code, config] of [[byStatus(403), 'failed'], [byStatus(422), 'failed'], [byStatus(500), 'unknown'], [byStatus(408), 'unknown'],
    ['process.exitCode=1', 'unknown'], [`process.stdout.write('${secret}')`, 'unknown'], ['process.stdout.write(Buffer.from([255]))', 'unknown'],
    ['process.stdout.write("a".repeat(10000))', 'unknown', { maxOutputBytes: 512 }], ['setTimeout(()=>{},10000)', 'unknown', { timeoutMs: 150 }]]) {
    const { transport, attempts } = cli(script, config)
    await assert.rejects(transport.mutate(ref, reply), error => error.code === code && !error.message.includes(secret) && !error.message.includes(reply.body))
    assert.equal(attempts(), 1)
  }
  const missing = createDiscussionTransport({ ...settings, glabCommand: 'uninstalled-cli-for-fixture-4ea1d9a7' })
  await assert.rejects(missing.mutate(ref, reply), e => e.code === 'failed')
})

test('discussion cancellation after dispatch reports an unknown outcome', async () => {
  const { transport, attempts } = cli('setTimeout(()=>{},10000)')
  const controller = new AbortController()
  const result = transport.mutate(ref, reply, controller.signal)
  controller.abort(Error('private-fixture-reason'))
  await assert.rejects(result, e => e.code === 'unknown' && !e.message.includes('private-fixture-reason'))
  assert.equal(attempts(), 1)
})
