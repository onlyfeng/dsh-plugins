import assert from 'node:assert/strict'
import test from 'node:test'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createCooperation } from '../host.js'

const checkout = await realpath(process.cwd())
const contract = {
  id: 'sample',
  mode: 'takeover',
  peer: 'controller',
  scopes: ['src'],
  goal: 'Check the sample',
  inputs: 'Input reference',
  done: 'Reviewed',
  ledger: 'sample-log',
  until: '2099-01-01T00:00:00Z',
}
function fixture(configured = true) {
  const root = { id: 'main', session: { header: { agentPreset: 'federated-team' } } }
  const child = { id: 'worker', session: { header: { agentPreset: 'federated-worker' } } }
  const other = { id: 'another', session: { header: { agentPreset: 'other-preset' } } }
  const status = { pack: 'general', lanes: [] }
  const calls = []
  const controls = { cwd: checkout, receipt: async (peer, ref) => ({ actor: peer, ref }) }
  const ctx = {
    subagents: { rootOf: (agent) => (agent === child ? root : agent) },
    workingDirectory: { get: () => controls.cwd },
  }
  const site = {
    packs: new Map([
      ['general', { id: 'general', label: 'General', root: null }],
      [
        'example',
        {
          id: 'example',
          label: 'Example',
          root: checkout,
          brief: 'Example brief',
          roles: ['reviewer'],
          gates: ['Proof of review'],
        },
      ],
    ]),
    peers: new Map([
      ['controller', { id: 'controller', role: 'controller' }],
      ['observer', { id: 'observer', role: 'observer' }],
    ]),
    receipt: async (peer, ref) => {
      calls.push(['receipt', peer, ref])
      return controls.receipt(peer, ref)
    },
  }
  const store = {
    status: () => status,
    getPack: () => status.pack,
    use: (_, id) => (status.pack = id),
    leave: () => (status.pack = 'general'),
    offer: (_, data) => {
      const lane = { ...data, rev: 1, phase: 'offered', canWrite: false }
      status.lanes.push(lane)
      calls.push(['offer', data])
      return lane
    },
    advance: (_, id, rev, action, data) => {
      const lane = status.lanes.find((l) => l.id === id)
      assert.equal(lane.rev, rev)
      calls.push(['advance', action, data])
      lane.rev++
      lane.phase = { accept: 'active', release: 'returning', returned: 'closed', cancel: 'cancelled' }[action]
      lane.canWrite = action === 'accept'
      return lane
    },
  }
  const ui = createCooperation(ctx, configured ? { site, store } : {})
  const slash = (args, agent = root) =>
    ui.command.handler({ agent, rawInput: ' ' + args, signal: new AbortController().signal })
  const tool = (action, payload, agent = root) =>
    ui.tool.execute({ action, payload }, { agent, signal: new AbortController().signal })
  return { root, child, other, ctx, site, store, status, controls, calls, ui, slash, tool }
}

test('generic preset and descendant context are usable before configuration', async () => {
  const a = fixture(false)
  for (const agent of [a.root, a.child]) {
    assert.equal(a.ui.when({ agent }), true)
    assert.match(a.ui.prompt.text({ agent }), /Mode: independent/)
    assert.deepEqual(JSON.parse(await a.tool('status', {}, agent)), {
      pack: 'general',
      lanes: [],
      configured: false,
    })
  }
  assert.equal(a.ui.when({ agent: a.other }), false)
  assert.equal(a.ui.prompt.text({ agent: a.other }), '')
  assert.equal((await a.slash('status', a.other)).kind, 'error')
  assert.equal((await a.slash('use general')).kind, 'success')
  assert.equal((await a.slash('packs')).kind, 'success')
  assert.match((await a.slash('use example')).text, /siteFile/)
})

test('every mutation requires the root agent through both surfaces', async () => {
  const a = fixture()
  for (const [action, payload] of [
    ['use', { pack: 'example' }],
    ['leave', {}],
    ['offer', contract],
    ['accept', { id: 'x', rev: 1, receipt: 'grant' }],
    ['release', { id: 'x', rev: 1, checkpoint: 'reviewed' }],
    ['returned', { id: 'x', rev: 1, receipt: 'returned' }],
    ['cancel', { id: 'x', rev: 1 }],
  ]) {
    await assert.rejects(a.tool(action, payload, a.child), /Lead/)
    assert.equal((await a.slash(`${action} ${JSON.stringify(payload)}`, a.child)).kind, 'error')
  }
  assert.equal(a.calls.length, 0)
})

test('the project brief changes for all members; staged receipt lookup mediates handoff and return', async () => {
  const a = fixture()
  assert.equal((await a.slash('use example')).kind, 'success')
  assert.match(a.ui.prompt.text({ agent: a.child }), /Example brief/)
  const lane = JSON.parse(await a.tool('offer', contract))
  assert.equal(lane.workspace, checkout)
  assert.equal(lane.pack, 'example')
  assert.match(a.ui.prompt.text({ agent: a.root }), /takeover, offered/)
  await assert.rejects(
    a.tool('accept', { id: lane.id, rev: 1, receipt: { actor: 'controller' } }),
    /reference/,
  )
  await a.tool('accept', { id: lane.id, rev: 1, receipt: 'grants/first' })
  assert.deepEqual(a.calls.slice(-2), [
    ['receipt', 'controller', 'grants/first'],
    ['advance', 'accept', { receipt: { actor: 'controller', ref: 'grants/first' } }],
  ])
  assert.match(a.ui.prompt.text({ agent: a.child }), /Controller grant active/)
  a.controls.cwd = dirname(checkout)
  assert.match(a.ui.prompt.text({ agent: a.child }), /none in this checkout/)
  await a.tool('release', { id: lane.id, rev: 2, checkpoint: 'private return material' })
  assert.doesNotMatch(a.ui.prompt.text({ agent: a.child }), /private return material|grants\/first/)
  await a.tool('returned', { id: lane.id, rev: 3, receipt: 'confirmations/first' })
  assert.deepEqual(a.calls.at(-1), [
    'advance',
    'returned',
    { receipt: { actor: 'controller', ref: 'confirmations/first' } },
  ])
})

test('denies observer grants and consultative write scopes; rechecks workspace after lookup', async () => {
  const a = fixture()
  await a.tool('use', { pack: 'example' })
  await assert.rejects(a.tool('offer', { ...contract, peer: 'observer' }), /controller/)
  await assert.rejects(a.tool('offer', { ...contract, mode: 'collaborate', peer: 'observer' }), /controller/)
  await assert.rejects(a.tool('offer', { ...contract, workspace: checkout }), /accepts/)
  a.controls.cwd = dirname(checkout)
  await assert.rejects(a.tool('offer', contract), /checkout/)
  a.controls.cwd = checkout
  await a.tool('offer', contract)
  a.controls.receipt = async () => {
    a.controls.cwd = dirname(checkout)
    return { kind: 'grant' }
  }
  await assert.rejects(a.tool('accept', { id: contract.id, rev: 1, receipt: 'grant' }), /checkout/)
  assert.equal(a.calls.filter((x) => x[0] === 'advance').length, 0)
})

test('a consultative observer offer has no write scope or grant authority', async () => {
  const a = fixture()
  const lane = JSON.parse(
    await a.tool('offer', { ...contract, mode: 'collaborate', scopes: [], peer: 'observer' }),
  )
  assert.equal(lane.canWrite, false)
  await assert.rejects(a.tool('accept', { id: lane.id, rev: 1, receipt: 'grant' }), /read-only consultation/)
  assert.equal(a.calls.filter((x) => x[0] === 'receipt').length, 0)
  await a.tool('cancel', { id: lane.id, rev: 1 })
})

test('cancellation while reading a controller receipt keeps the offer pending', async () => {
  const a = fixture()
  await a.tool('offer', contract)
  const controller = new AbortController()
  const reason = new Error('Request cancelled')
  a.controls.receipt = async () => {
    controller.abort(reason)
    return { kind: 'grant' }
  }
  await assert.rejects(
    a.ui.tool.execute(
      { action: 'accept', payload: { id: contract.id, rev: 1, receipt: 'grant' } },
      { agent: a.root, signal: controller.signal },
    ),
    (error) => error === reason,
  )
  assert.equal(a.calls.filter((call) => call[0] === 'advance').length, 0)
})

test('delegated collaborative writes require a controller grant before activation', async () => {
  const a = fixture()
  const lane = JSON.parse(await a.tool('offer', { ...contract, mode: 'collaborate' }))
  assert.equal(lane.canWrite, false)
  await a.tool('accept', { id: lane.id, rev: 1, receipt: 'grants/delegated' })
  assert.deepEqual(a.calls.at(-1), [
    'advance',
    'accept',
    { receipt: { actor: 'controller', ref: 'grants/delegated' } },
  ])
  assert.match(a.ui.prompt.text({ agent: a.child }), /Controller grant active/)
})
