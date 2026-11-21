// Run in Desktop's Electron Node runtime. A loopback GitLab fixture receives every mutation.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
async function installed(name) {
  const file = require.resolve(`${name}/package.json`)
  return import(pathToFileURL(join(dirname(file), require(file).main)).href)
}
const { Context } = await installed('@deepseek-ai/cordis')
const { ForgeService } = await installed('@deepseek-ai/dsh-experimental-forge')
const plugin = await import(pathToFileURL(resolve(process.env.FORGE_SMOKE_PACKAGE ?? 'packages/forge-gitlab', 'index.js')).href)
const head = '1'.repeat(40), id = '2'.repeat(40), hostConfig = await mkdtemp(join(tmpdir(), 'glab-discussions-'))
const refBase = '/api/v4/projects/group/sub/project/merge_requests/7'
const mr = { iid: 7, id: 70, sha: head, diff_refs: { head_sha: head, base_sha: 'a'.repeat(40), start_sha: 'b'.repeat(40) } }
const notes = [{ id: 41, body: 'fixture discussion', resolvable: true, resolved: false, created_at: '2026-01-01T00:00:00Z', position: {
  ...mr.diff_refs, position_type: 'text', new_path: 'example.js', old_path: 'example.js', new_line: 3,
} }]
const thread = { id, individual_note: false, notes }
const writes = []
let failNextReply = false
const server = createServer(async (req, res) => {
  try {
    let bytes = ''; for await (const chunk of req) bytes += chunk
    const path = decodeURIComponent(req.url.split('?')[0])
    res.setHeader('Content-Type', 'application/json')
    const json = value => res.end(JSON.stringify(value))
    const body = bytes ? JSON.parse(bytes) : null
    if (req.method === 'GET') {
      if (path === refBase) return json(mr)
      if (path === refBase + '/discussions') return json([thread])
      if (path === `${refBase}/discussions/${id}`) return json(thread)
    }
    if (req.method === 'POST' && path === '/api/graphql') {
      assert.equal(body.variables.project, 'group/sub/project')
      return json({ data: { project: { mergeRequest: { iid: '7', userPermissions: { createNote: true }, discussions: {
        nodes: [{ id: `gid://gitlab/Discussion/${id}`, notes: { nodes: [{ id: 'gid://gitlab/Note/41', userPermissions: { createNote: true, resolveNote: true } }] } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } })
    }
    if (req.method === 'POST' && path === `${refBase}/discussions/${id}/notes`) {
      writes.push('reply')
      if (failNextReply) { res.statusCode = 503; return json({ message: 'Fixture interruption' }) }
      const note = { id: 100 + notes.length, created_at: '2026-01-02T00:00:00Z', noteable_type: 'MergeRequest', noteable_id: mr.id, noteable_iid: mr.iid, body: body.body }
      notes.push(note); res.statusCode = 201; return json(note)
    }
    if (req.method === 'PUT' && path === `${refBase}/discussions/${id}`) {
      assert.equal(typeof body.resolved, 'boolean'); writes.push(body.resolved ? 'resolve' : 'reopen')
      notes[0].resolved = body.resolved; return json(thread)
    }
    res.statusCode = 404; json({ message: 'Unexpected fixture endpoint' })
  } catch { res.statusCode = 400; res.end('{}') }
})
const ctx = new Context()
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const host = 'forge.example.test'
  const apiHost = `127.0.0.1:${server.address().port}`
  process.env.GLAB_CONFIG_DIR = hostConfig
  process.env.NO_PROXY = '127.0.0.1,localhost'
  process.env.no_proxy = process.env.NO_PROXY
  await writeFile(join(hostConfig, 'config.yml'), `hosts:\n  ${JSON.stringify(host)}:\n    api_protocol: http\n    api_host: ${JSON.stringify(apiHost)}\n    token: loopback-fixture\n`)
  const repository = { forge: 'gitlab', host, owner: 'group/sub', name: 'project' }, ref = { repository, number: 7 }
  const reply = { kind: 'reply', pending: false, thread: id, headSha: head, body: 'Checked the example.\nThanks.' }
  const signal = AbortSignal.timeout(60000)
  await ctx.plugin(ForgeService)
  const reader = ctx.plugin(plugin, { hosts: [host] }); await reader
  assert.equal((await ctx.forge.writeReview(ref, reply, signal)).code, 'unsupported')
  assert.deepEqual(writes, []); await reader.dispose()
  const writer = ctx.plugin(plugin, { hosts: [host], discussionWriteHosts: [host] }); await writer
  const review = await ctx.forge.readReview(ref, head, signal)
  if (!review.threads) throw new Error(`Fixture review failed: ${review.code} (${review.message})`)
  assert.equal(review.threads[0]?.viewerCanReply, true, 'panel thread should allow replies')
  assert.equal(review.threads[0].viewerCanResolve, true)
  assert.equal(review.viewerCanReview, false)
  assert.equal((await ctx.forge.writeReview(ref, { ...reply, headSha: '9'.repeat(40) }, signal)).code, 'stale')
  assert.deepEqual(await ctx.forge.writeReview(ref, reply, signal), { ok: true })
  for (const resolved of [true, false]) {
    assert.deepEqual(await ctx.forge.writeReview(ref, { kind: 'resolve', headSha: head, thread: id, resolved }, signal), { ok: true })
  }
  assert.deepEqual(writes, ['reply', 'resolve', 'reopen'])
  assert.equal((await ctx.forge.readReview(ref, head, signal)).threads[0].comments.at(-1).body, reply.body)
  failNextReply = true
  assert.equal((await ctx.forge.writeReview(ref, reply, signal)).code, 'unknown')
  assert.deepEqual(writes, ['reply', 'resolve', 'reopen', 'reply'], 'each operation must issue exactly one HTTP mutation')
  await writer.dispose()
  console.log('Desktop + glab loopback: opt-in, permissions, reply, resolve, reopen, reread, stale and one HTTP attempt on 503 passed')
} finally {
  await ctx.fiber.dispose()
  server.closeAllConnections(); await new Promise(done => server.close(done))
  await rm(hostConfig, { recursive: true, force: true })
}
