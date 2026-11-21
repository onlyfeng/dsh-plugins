import { effectivePreset } from './identity.js'
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import { generalPack } from './site.js'

const PRESET = 'federated-team'
const actions = [
  'help',
  'status',
  'packs',
  'use',
  'offer',
  'accept',
  'release',
  'returned',
  'cancel',
  'leave',
]
const help = `Use /team-coop status or packs. Select a pack with use <id>, or leave for general. Offer JSON {id,mode,peer,scopes,goal,inputs,done,ledger,until}. A collaborate offer with [] scopes opens a read-only consultation. Use cancel {id,rev} to finish it. Nonempty scopes require a controller. Accept/returned take {id,rev,receipt} with that controller's receipt reference. Release takes {id,rev,checkpoint}.`
const fields = {
  offer: ['id', 'mode', 'peer', 'scopes', 'goal', 'inputs', 'done', 'ledger', 'until'],
  accept: ['id', 'rev', 'receipt'],
  returned: ['id', 'rev', 'receipt'],
  release: ['id', 'rev', 'checkpoint'],
  cancel: ['id', 'rev'],
  use: ['pack'],
}
class InputError extends Error {}
function reject(message) {
  throw new InputError(message)
}
function validate(action, data) {
  if (!actions.includes(action)) reject(help)
  const keys = fields[action] ?? []
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(data, k))
  ) {
    reject(`${action} accepts ${keys.join(', ') || 'no arguments'}.`)
  }
  if (Object.hasOwn(data, 'rev') && (!Number.isSafeInteger(data.rev) || data.rev < 1))
    reject('Use the current positive revision from status.')
  if (Object.hasOwn(data, 'receipt') && (typeof data.receipt !== 'string' || !data.receipt.trim()))
    reject('Supply the reference of a controller-issued receipt.')
}
function slash(raw) {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw.trim())
  if (!match) return ['help', {}]
  const [, action, rest] = match
  if (!rest) return [action, {}]
  if (action === 'use' && !rest.startsWith('{')) return [action, { pack: rest }]
  try {
    return [action, JSON.parse(rest)]
  } catch {
    reject('Supply a JSON object. Run /team-coop help for the fields.')
  }
}

export function createCooperation(ctx, { site, store }) {
  function rootOf(agent) {
    if (!agent) return undefined
    try {
      const root = ctx.subagents.rootOf(agent)
      return effectivePreset(ctx, root) === PRESET ? root : undefined
    } catch {
      return undefined
    }
  }
  function lead(agent) {
    const root = rootOf(agent)
    return !!root && root === agent
  }
  function state(root) {
    return store?.status(root.id) ?? { pack: 'general', lanes: [] }
  }
  function inventory() {
    return {
      packs: Array.from(site?.packs?.values() ?? [{ id: 'general', label: 'General' }], ({ id, label }) => ({
        id,
        label,
      })),
      peers: Array.from(site?.peers?.values() ?? [], ({ id, label, role }) => ({ id, label, role })),
    }
  }
  function packFor(id) {
    if (id === 'general') return generalPack
    const pack = site?.packs.get(id)
    if (!pack) reject('Unknown project pack. Use packs to see available IDs.')
    return pack
  }
  function controller(id) {
    const peer = site?.peers.get(id)
    if (!peer) reject('Unknown peer. Check the configured peer IDs in packs.')
    if (peer.role !== 'controller') reject('This peer is an observer. A takeover requires a controller.')
    return peer
  }
  async function workspace(root, pack) {
    const current = ctx.workingDirectory.get(root.session)
    const cwd = await realpath(current)
    if (pack?.root && relative(cwd, await realpath(pack.root)) !== '')
      reject('Open the exact checkout configured for this pack.')
    if (ctx.workingDirectory.get(root.session) !== current)
      reject('The checkout changed. Check status and retry.')
    return { cwd, current }
  }
  async function dispatch(agent, action, data, signal) {
    signal?.throwIfAborted()
    const root = rootOf(agent)
    if (!root) reject('Start a federation preset session to use this command.')
    validate(action, data)
    const before = state(root)
    if (action === 'help') return help
    if (action === 'packs') return inventory()
    if (action === 'status') return { ...before, configured: !!store }
    if (agent !== root) reject('Only the federation Lead may change a pack or contract.')
    if (!store || !site) {
      if (action === 'leave' || (action === 'use' && data.pack === 'general')) return { pack: 'general' }
      reject('Configure the private siteFile registry to select a project or persist contracts.')
    }
    function recheck() {
      signal?.throwIfAborted()
      if (!lead(agent) || store.getPack(root.id) !== before.pack)
        reject('The session or selected pack changed. Check status and retry.')
    }
    if (action === 'leave' || (action === 'use' && data.pack === 'general'))
      return { pack: store.leave(root.id) }
    if (action === 'use') {
      const pack = packFor(data.pack)
      return { pack: store.use(root.id, pack.id) }
    }
    if (action === 'offer') {
      if (!site.peers.has(data.peer)) reject('Unknown peer. Check packs for configured peer IDs.')
      if (!['collaborate', 'takeover'].includes(data.mode) || !Array.isArray(data.scopes))
        reject('Choose collaborate or takeover and supply a scopes array.')
      const writing = data.scopes.length > 0
      if (data.mode === 'takeover' && !writing) reject('A takeover needs explicit write scopes.')
      if (writing) controller(data.peer)
      const { cwd, current } = await workspace(root, writing ? packFor(before.pack) : undefined)
      recheck()
      if (ctx.workingDirectory.get(root.session) !== current)
        reject('The checkout changed. Check status and retry.')
      return store.offer(root.id, { ...data, workspace: cwd, pack: before.pack })
    }
    const lane = before.lanes.find((item) => item.id === data.id)
    if (!lane || lane.rev !== data.rev)
      reject('Contract missing or revision changed. Check status before retrying.')
    if (action === 'accept' || action === 'returned') {
      if (lane.mode === 'collaborate' && lane.scopes.length === 0)
        reject('This is a read-only consultation. Use cancel to finish it.')
      controller(lane.peer)
      const receipt = await site.receipt(lane.peer, data.receipt)
      if (action === 'accept') {
        const { cwd, current } = await workspace(root, packFor(lane.pack))
        if (relative(cwd, lane.workspace) !== '' || ctx.workingDirectory.get(root.session) !== current) {
          reject('Return to the offered workspace before accepting the grant.')
        }
      }
      recheck()
      return store.advance(root.id, lane.id, data.rev, action, { receipt })
    }
    return store.advance(
      root.id,
      lane.id,
      data.rev,
      action,
      action === 'release' ? { checkpoint: data.checkpoint } : {},
    )
  }
  function promptText(agent) {
    const root = rootOf(agent)
    if (!root) return ''
    try {
      const { pack, lanes } = state(root)
      const chosen = site?.packs.get(pack) ?? packFor(pack)
      const info = [
        `Federation pack: ${pack}.`,
        chosen?.brief?.slice(0, 1200),
        chosen?.roles?.length ? `Roles: ${chosen.roles.join(', ').slice(0, 640)}.` : '',
        chosen?.gates?.length ? `Gates: ${chosen.gates.join('; ').slice(0, 640)}.` : '',
      ]
      if (!lanes.length) {
        info.push('Mode: independent. Use team_cooperate to inspect packs and coordinate handoffs.')
        return info.filter(Boolean).join('\n')
      }
      const cwd = ctx.workingDirectory.get(agent.session)
      for (const lane of lanes.slice(0, 8)) {
        const consult = lane.mode === 'collaborate' && lane.scopes.length === 0
        const writable = lane.canWrite === true && !consult && relative(cwd, lane.workspace) === ''
        const authority = consult
          ? 'Read-only consultation. Lead may cancel to finish.'
          : writable
            ? `Controller grant active in this checkout until ${lane.until}. Read status for authorized scopes.`
            : 'External write authority: none in this checkout.'
        info.push(`${lane.id}: ${lane.mode}, ${lane.phase}, rev ${lane.rev}, peer ${lane.peer}. ${authority}`)
      }
      if (lanes.length > 8) info.push(`${lanes.length - 8} more contracts. Read status.`)
      return info.filter(Boolean).join('\n')
    } catch {
      return 'Federation state unavailable. Check /team-coop status before external work.'
    }
  }
  async function invoke(agent, action, data, signal) {
    try {
      return await dispatch(agent, action, data, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof InputError) throw error
      if (error?.code && typeof error.code === 'string' && /^[A-Z][A-Z_0-9-]{1,63}$/.test(error.code)) {
        throw new InputError(
          `${action} failed (${error.code}). Check status, revision, checkout and receipt.`,
        )
      }
      throw new InputError(`${action} failed. Check status, revision, scopes and the controller's receipt.`)
    }
  }
  return {
    command: {
      name: 'team-coop',
      description: 'Inspect federation packs and manage collaboration contracts.',
      recordInput: false,
      async handler({ agent, rawInput, signal }) {
        try {
          const [action, data] = slash(rawInput)
          const value = await invoke(agent, action, data, signal)
          return { kind: 'success', text: typeof value === 'string' ? value : JSON.stringify(value) }
        } catch (error) {
          signal?.throwIfAborted()
          return { kind: 'error', text: error.message }
        }
      },
    },
    tool: {
      name: 'team_cooperate',
      description: 'Inspect project packs and manage the Lead’s external collaboration contracts.',
      parameters: {
        type: 'object',
        required: ['action'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: actions },
          payload: {
            type: 'object',
            additionalProperties: false,
            description: 'Fields for the selected action. Call help for the required fields.',
            properties: {
              pack: { type: 'string' },
              id: { type: 'string' },
              rev: { type: 'integer' },
              mode: { type: 'string', enum: ['collaborate', 'takeover'] },
              peer: { type: 'string' },
              scopes: { type: 'array', items: { type: 'string' } },
              goal: { type: 'string' },
              inputs: { type: 'string' },
              done: { type: 'string' },
              ledger: { type: 'string' },
              until: { type: 'string' },
              receipt: { type: 'string' },
              checkpoint: { type: 'string' },
            },
          },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute({ action, payload }, exec) {
        const value = await invoke(exec.agent, action, payload ?? {}, exec.signal)
        return typeof value === 'string' ? value : JSON.stringify(value)
      },
    },
    when: ({ agent }) => !!rootOf(agent),
    prompt: {
      name: 'team-coop:state',
      order: 610,
      required: true,
      interpolate: false,
      text: ({ agent }) => promptText(agent),
    },
  }
}
