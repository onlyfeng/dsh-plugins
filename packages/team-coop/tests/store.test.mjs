import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { openStore } from '../store.js'

const workspace = join(tmpdir(), 'coop-fixture-workspace')
const offer = (id = 'lane-a', fields = {}) => ({
  id,
  workspace,
  pack: 'general',
  peer: 'controller',
  mode: 'takeover',
  scopes: ['src/engine'],
  goal: 'Fix behavior',
  inputs: 'Fixture snapshot',
  done: 'Tests pass',
  ledger: 'fixture-ledger',
  until: new Date(Date.now() + 60000).toISOString(),
  ...fields,
})
const packet = (lane, kind, checkpoint) => ({
  receipt: {
    actor: lane.peer,
    lane: lane.id,
    contract: lane.digest,
    rev: lane.rev,
    kind,
    checkpoint,
    evidence: 'fixture receipt',
  },
})
const code = (expected) => (error) => error.code === expected

test('one owner through handback, restart, stale revision and conflicts across nested workspaces', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coop-reopen-')),
    file = join(dir, 'coop.db')
  let s = openStore(file)
  t.after(async () => {
    s.close()
    await rm(dir, { recursive: true, force: true })
  })
  assert.equal(s.use('alpha', 'example'), 'example')
  const a = s.offer('alpha', offer('ticket', { pack: 'example' }))
  assert.equal(a.canWrite, false)
  const grant = packet(a, 'grant', 'initial checkpoint')
  for (const change of [
    { actor: 'wrong' },
    { kind: 'returned' },
    { contract: '0'.repeat(64) },
    { rev: 2 },
    { lane: 'other' },
    { checkpoint: '' },
  ]) {
    assert.throws(() => s.advance('alpha', a.id, 1, 'accept', { receipt: { ...grant.receipt, ...change } }))
  }
  assert.equal(s.advance('alpha', a.id, 1, 'accept', grant).canWrite, true)
  assert.throws(() => s.advance('alpha', a.id, 1, 'accept', grant), code('STALE_REVISION'))
  const back = s.advance('alpha', a.id, 2, 'release', { checkpoint: 'returned checkpoint' })
  assert.equal(back.canWrite, false)
  s.close()
  s = openStore(file)
  assert.deepEqual(s.status('alpha').lanes, [back])
  assert.throws(() => s.leave('alpha'), code('OPEN_LANES'))
  assert.throws(() => s.use('alpha', 'other'), code('OPEN_LANES'))
  assert.throws(
    () => s.offer('beta', offer('b', { workspace: join(workspace, 'src'), scopes: ['engine/api'] })),
    code('SCOPE_CONFLICT'),
  )
  assert.throws(
    () => s.advance('alpha', a.id, 3, 'returned', packet(back, 'returned', 'wrong')),
    code('CHECKPOINT_MISMATCH'),
  )
  assert.equal(
    s.advance('alpha', a.id, 3, 'returned', packet(back, 'returned', back.checkpoint)).phase,
    'closed',
  )
  assert.equal(s.leave('alpha'), 'general')
  assert.deepEqual(s.status('alpha').lanes, [])
  assert.throws(() => s.offer('alpha', offer('ticket')), code('LANE_EXISTS'))
})
test('expiry suspends writes, retains reservation and allows handback', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2031-06-01T12:00:00Z') })
  const s = openStore(':memory:')
  t.after(() => s.close())
  const a = s.offer('one', offer())
  s.advance('one', a.id, 1, 'accept', packet(a, 'grant', 'start'))
  t.mock.timers.tick(61000)
  assert.equal(s.status('one').lanes[0].canWrite, false)
  assert.throws(() => s.offer('two', offer()), code('SCOPE_CONFLICT'))
  const end = s.advance('one', a.id, 2, 'release', { checkpoint: 'done' })
  assert.equal(s.advance('one', a.id, 3, 'returned', packet(end, 'returned', 'done')).phase, 'closed')
})
test('validates scopes and consultation events', (t) => {
  const s = openStore(':memory:')
  t.after(() => s.close())
  for (const scopes of [
    ['../src'],
    ['a/./b'],
    ['a//b'],
    ['CON.txt'],
    ['C:tmp'],
    ['a/x~1'],
    ['src', 'SRC/sub'],
    [],
  ])
    assert.throws(() => s.offer('x', offer('bad', { scopes })))
  const a = s.offer('x', offer('ask', { mode: 'collaborate', scopes: [] }))
  assert.equal(a.canWrite, false)
  assert.throws(
    () => s.advance('x', a.id, 1, 'accept', packet(a, 'grant', 'start')),
    code('INVALID_TRANSITION'),
  )
  assert.equal(s.advance('x', a.id, 1, 'cancel').phase, 'cancelled')
})
test('two processes compete for one nested write scope', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coop-race-')),
    file = join(dir, 'state.db')
  openStore(file).close()
  const children = []
  t.after(async () => {
    for (const p of children) if (p.exitCode === null) p.kill()
    await rm(dir, { recursive: true, force: true })
  })
  const script = `import {openStore} from ${JSON.stringify(new URL('../store.js', import.meta.url).href)};const s=openStore(process.argv[1]);process.stdin.once('data',()=>{try{s.offer(process.argv[2],JSON.parse(process.argv[3]));console.log('won')}catch(e){console.log(e.code)}finally{s.close()}});console.log('ready')`
  function launch(root, item) {
    const p = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, file, root, JSON.stringify(item)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    children.push(p)
    const ready = once(p.stdout, 'data'),
      done = once(p, 'close')
    let out = ''
    p.stdout.on('data', (b) => {
      out += b
    })
    p.stderr.resume()
    return { p, ready, done, last: () => out.trim().split(/\r?\n/).at(-1) }
  }
  const a = launch('a', offer('a', { scopes: ['src'] })),
    b = launch('b', offer('b', { workspace: join(workspace, 'src'), scopes: ['api'] }))
  await Promise.all([a.ready, b.ready])
  a.p.stdin.end('go')
  b.p.stdin.end('go')
  await Promise.all([a.done, b.done])
  assert.deepEqual([a.last(), b.last()].sort(), ['SCOPE_CONFLICT', 'won'])
})
