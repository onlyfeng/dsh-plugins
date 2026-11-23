import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const exec = promisify(execFile)
const boundedLine = (s, max) =>
  typeof s === 'string' && s.trim() && s.length <= max && !/[\x00-\x1f\x7f]/u.test(s)

/** Pin the peer session and workspace as well as the visible tab. Handles are live for one Orca instance. */
export function resolveRoute(route, terminals, workspaces) {
  if (
    !route ||
    !['tabId', 'leafId', 'session', 'workspace', 'agent'].every((k) => boundedLine(route[k], 512))
  )
    throw Error('Incomplete peer identity')
  if (
    terminals.truncated !== false ||
    workspaces.truncated === true ||
    !Array.isArray(terminals.terminals) ||
    !Array.isArray(workspaces.worktrees)
  )
    throw Error('Incomplete Orca inventory')
  const panes = terminals.terminals.filter((t) => t.tabId === route.tabId && t.leafId === route.leafId)
  if (panes.length !== 1) throw Error('Peer pane missing or ambiguous')
  const pane = panes[0]
  if (
    !pane.connected ||
    pane.orphaned ||
    pane.agentIdentity !== route.agent ||
    !/^term_[\w-]+$/.test(pane.handle)
  )
    throw Error('Peer pane identity or connection changed')
  const work = workspaces.worktrees.filter(
    (w) =>
      w.worktreeId === pane.worktreeId &&
      w.address?.worktree === route.workspace &&
      w.address?.environment === 'local',
  )
  if (work.length !== 1) throw Error('Expected one local peer workspace')
  const agents = work[0].agents.filter(
    (a) =>
      a.paneKey === `${route.tabId}:${route.leafId}` &&
      a.orcaSessionId === route.session &&
      a.agentType === route.agent &&
      a.hasLivePty === true,
  )
  if (agents.length !== 1)
    throw Error('Peer session changed. Verify the new identity before updating its route.')
  return {
    handle: pane.handle,
    session: route.session,
    agent: route.agent,
    state: agents[0].state,
    workspace: route.workspace,
  }
}

const baseEnvironment = ['PATH', 'HOME', 'ORCA_USER_DATA_PATH', 'ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY']

/** Orca resolves its local profile and sender identity from these process settings. */
export function orcaEnvironment(parent = process.env, platform = process.platform) {
  const windows = platform === 'win32'
  const osKeys = windows
    ? ['SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT']
    : ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR']
  const allowed = new Set([...baseEnvironment, ...osKeys])
  const env = Object.create(null)
  for (const [key, value] of Object.entries(parent)) {
    if (allowed.has(windows ? key.toUpperCase() : key)) env[key] = value
  }
  env.ORCA_ENVIRONMENT = 'local'
  return env
}

async function orca(args) {
  // The static command uses the same local host for both lookup and delivery.
  const tool =
    process.env.ORCA_CLI_COMMAND ||
    (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' ? 'orca-ide' : 'orca')
  const { stdout } = await exec(tool, args, {
    env: orcaEnvironment(),
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 12 * 1024 * 1024,
  })
  const response = JSON.parse(stdout)
  if (response.ok === false || !response.result) throw Error('Orca did not confirm the operation')
  return response.result
}

export async function lookup(route, invoke = orca) {
  const [terminals, workspaces] = await Promise.all([
    invoke(['terminal', 'list', '--environment', 'local', '--include-visual-layouts', '--json']),
    invoke(['worktree', 'ps', '--environment', 'local', '--json']),
  ])
  return resolveRoute(route, terminals, workspaces)
}

/** The receipt packet and the controller's own stand-alone acknowledgement bind the same bytes. */
export async function verifyAcknowledgement(route, kind, sha, invoke = orca) {
  if (!['grant', 'returned'].includes(kind) || !/^[a-f0-9]{64}$/u.test(sha))
    throw Error('Invalid acknowledgement request')
  const peer = await lookup(route, invoke)
  const transcript = await invoke([
    'agent',
    'read',
    `orca_session_id:${peer.session}`,
    '--environment',
    'local',
    '--limit',
    '20',
    '--json',
  ])
  const statement = `TEAM-COOP ${kind.toUpperCase()} ${sha}`
  if (
    transcript.orcaSessionId !== peer.session ||
    transcript.kind !== 'terminal' ||
    transcript.agent !== peer.agent ||
    !Array.isArray(transcript.entries) ||
    !transcript.entries.some(
      (e) =>
        e.kind === 'message' &&
        e.role === 'assistant' &&
        typeof e.text === 'string' &&
        e.text.trim() === statement,
    )
  ) {
    throw Error('Controller acknowledgement is not confirmed in the pinned session')
  }
  // Refuse a pane/session switch during the history read.
  const fresh = await lookup(route, invoke)
  if (peer.handle !== fresh.handle) throw Error('Controller pane changed while verifying')
}

/** A command-line operator can explicitly send a prepared message through the peer's mailbox. */
async function main(args) {
  const [action, config, peer, packet, ...rest] = args
  if (
    !['check', 'draft', 'send'].includes(action) ||
    rest.length ||
    !config ||
    !peer ||
    (action === 'check' ? !!packet : !packet)
  )
    throw Error('Usage: node orca-peer.js check ROUTES PEER | draft|send ROUTES PEER MESSAGE_JSON')
  const routes = JSON.parse(await readFile(config, 'utf8'))
  if (routes.schema !== 1 || !Array.isArray(routes.peers)) throw Error('Invalid route registry')
  const matches = routes.peers.filter((r) => r.id === peer)
  if (matches.length !== 1) throw Error('Unknown or ambiguous peer')
  const current = await lookup(matches[0])
  if (action === 'check') {
    console.log(JSON.stringify({ peer, ...current }))
    return
  }
  const { subject, body } = JSON.parse(await readFile(packet, 'utf8'))
  if (
    !boundedLine(subject, 120) ||
    typeof body !== 'string' ||
    !body.trim() ||
    body.length > 4000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(body)
  )
    throw Error('Invalid message packet')
  if (action === 'draft') {
    console.log(JSON.stringify({ peer, ...current, subject, body, delivery: 'draft' }))
    return
  }
  if (
    (process.env.ORCA_ENVIRONMENT && process.env.ORCA_ENVIRONMENT !== 'local') ||
    process.env.ORCA_PAIRING_CODE
  )
    throw Error('Use the verified local Orca host to dispatch')
  if (process.env.ORCA_TERMINAL_HANDLE === current.handle)
    throw Error('Choose the other participant as the destination')
  const result = await orca([
    'orchestration',
    'send',
    '--to',
    current.handle,
    '--type',
    'question',
    '--subject',
    subject,
    '--body',
    body,
    '--json',
  ])
  console.log(JSON.stringify({ peer, session: current.session, delivery: 'mail-receipt', result }))
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Peer operation was not confirmed. Check the route, local Orca availability and any existing receipt before retrying.',
    )
    process.exitCode = 1
  })
}
