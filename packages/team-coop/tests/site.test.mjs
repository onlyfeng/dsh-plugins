import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyAcknowledgement } from '../orca-peer.js'
import { loadSite } from '../site.js'
import { stageReceipt } from '../receipt.js'
import { openStore } from '../store.js'
import { createCooperation } from '../host.js'
import { observerGuard } from '../observer.js'

const route = { tabId: 'tab', leafId: 'leaf', agent: 'sample', session: 'session-a', workspace: 'worktree-a' }
function broker(messages, session = route.session) {
  return async ([group, action]) => {
    if (group === 'terminal')
      return {
        truncated: false,
        terminals: [
          {
            tabId: 'tab',
            leafId: 'leaf',
            worktreeId: 'tree',
            agentIdentity: 'sample',
            handle: 'term_abc',
            connected: true,
            orphaned: false,
          },
        ],
      }
    if (group === 'worktree')
      return {
        worktrees: [
          {
            worktreeId: 'tree',
            address: { environment: 'local', worktree: route.workspace },
            agents: [
              { paneKey: 'tab:leaf', orcaSessionId: route.session, agentType: 'sample', hasLivePty: true },
            ],
          },
        ],
      }
    assert.equal(action, 'read')
    return { orcaSessionId: session, agent: 'sample', kind: 'terminal', entries: messages }
  }
}
test('a routed owner acknowledges the exact packet in its own session', async () => {
  const ref = 'e'.repeat(64),
    text = `TEAM-COOP GRANT ${ref}`
  const verify = (entry, session) => verifyAcknowledgement(route, 'grant', ref, broker([entry], session))
  for (const entry of [
    { kind: 'queued', role: 'assistant', text },
    { kind: 'message', role: 'user', text },
    { kind: 'message', role: 'assistant', text: `Quoted: ${text}` },
    { kind: 'message', role: 'assistant', text: `TEAM-COOP RETURNED ${ref}` },
  ]) {
    await assert.rejects(verify(entry))
  }
  await assert.rejects(verify({ kind: 'message', role: 'assistant', text }, 'old-session'))
  await verify({ kind: 'message', role: 'assistant', text })
})
test('composed observer guard admits evidence tools only, even after a blank-session preset switch', () => {
  const observer = { ctx: {}, session: { header: { agentPreset: 'standard' } } }
  const ctx = { agentPresets: { composedPreset: () => 'federated-observer' } }
  for (const tool of ['read', 'grep', 'team_task_get'])
    assert.equal(observerGuard({ agent: observer, name: tool }, ctx), undefined)
  for (const tool of [
    'pwsh',
    'write',
    'edit',
    'subagent_codex',
    'subagent_claude_code',
    'team_allocate',
    'team_task_update',
    'send_message',
    'run_code',
  ])
    assert.equal(typeof observerGuard({ agent: observer, name: tool }, ctx), 'string')
  assert.equal(
    observerGuard({ agent: observer, name: 'team_cooperate', arguments: { action: 'status' } }, ctx),
    undefined,
  )
  assert.equal(
    typeof observerGuard({ agent: observer, name: 'team_cooperate', arguments: { action: 'accept' } }, ctx),
    'string',
  )
})
test('two independent controllers hand disjoint scopes back to the same root via slash commands', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coop-exercise-'))
  let store
  t.after(async () => {
    store?.close()
    await rm(dir, { recursive: true, force: true })
  })
  const ids = ['controller-a', 'controller-b']
  for (const peer of ids) await mkdir(join(dir, peer))
  const config = {
    schema: 1,
    stateFile: join(dir, 'registry.sqlite'),
    packs: [
      {
        id: 'sample',
        label: 'Sample',
        brief: 'A bounded project',
        roles: ['worker'],
        gates: ['tests pass'],
        root: dir,
      },
    ],
    peers: ids.map((id) => ({ id, role: 'controller', label: id, receiptDir: join(dir, id), route })),
  }
  config.peers.push({ id: 'watcher', label: 'Watcher', role: 'observer' })
  const siteFile = join(dir, 'site.json')
  await writeFile(siteFile, JSON.stringify(config))
  const messages = []
  const site = await loadSite(siteFile, {
    verify: (r, k, h) => verifyAcknowledgement(r, k, h, broker(messages)),
  })
  store = openStore(site.stateFile)
  const root = { id: 'fixture-root', session: { header: { agentPreset: 'federated-team' } } }
  const host = createCooperation(
    { subagents: { rootOf: (a) => a }, workingDirectory: { get: () => dir } },
    { site, store },
  )
  async function call(raw) {
    return await host.command.handler({ rawInput: raw, agent: root, signal: new AbortController().signal })
  }
  async function cmd(name, data) {
    const v = await call(name + (data ? ' ' + JSON.stringify(data) : ''))
    assert.equal(v.kind, 'success', v.text)
    return JSON.parse(v.text)
  }
  assert.equal((await call('use sample')).kind, 'success')
  const offer = (id, peer, scopes) => ({
    id,
    peer,
    mode: 'collaborate',
    scopes,
    goal: 'fixture',
    inputs: 'v1',
    done: 'check passes',
    ledger: 'operator-log',
    until: new Date(Date.now() + 60000).toISOString(),
  })
  const first = await cmd('offer', offer('first', ids[0], ['src/sample'])),
    second = await cmd('offer', offer('second', ids[1], ['docs/sample']))
  assert.equal(first.canWrite, false)
  assert.equal(second.canWrite, false)
  assert.equal((await call('leave')).kind, 'error')
  const consultation = await cmd('offer', offer('read', 'watcher', []))
  assert.equal(consultation.canWrite, false)
  await cmd('cancel', { id: consultation.id, rev: consultation.rev })
  async function acknowledge(lane, kind, checkpoint) {
    const packetFile = join(dir, 'proposed.json')
    const bytes = {
      actor: lane.peer,
      lane: lane.id,
      contract: lane.digest,
      rev: lane.rev,
      kind,
      checkpoint,
      evidence: 'fixture-evidence-v1',
    }
    await writeFile(packetFile, JSON.stringify(bytes))
    const staged = await stageReceipt(siteFile, lane.peer, packetFile)
    const payload = { id: lane.id, rev: lane.rev, receipt: staged.ref }
    const action = kind === 'grant' ? 'accept' : 'returned'
    assert.equal((await call(`${action} ${JSON.stringify(payload)}`)).kind, 'error')
    messages.push({ kind: 'message', role: 'assistant', text: staged.acknowledgement })
    return await cmd(action, payload)
  }
  const grants = []
  for (const lane of [first, second]) grants.push(await acknowledge(lane, 'grant', 'input-v1'))
  assert.ok(grants.every((x) => x.canWrite))
  for (const [index, lane] of grants.entries()) {
    const checkpoint = index === 0 ? 'candidate-v2' : 'candidate-v2\r\n\tverification passed\n'
    const pending = await cmd('release', { id: lane.id, rev: lane.rev, checkpoint })
    assert.equal(pending.canWrite, false)
    assert.equal(pending.checkpoint, checkpoint)
    assert.equal((await acknowledge(pending, 'returned', checkpoint)).phase, 'closed')
  }
  assert.equal((await cmd('leave')).pack, 'general')
})
